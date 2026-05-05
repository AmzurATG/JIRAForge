# AI Issue Matching Accuracy — Root Cause Analysis

**Author:** Senior Architecture Review  
**Date:** 2026-05  
**Scope:** End-to-end AI analysis pipeline, from desktop activity capture to Jira worklog assignment  
**Problem:** High rate of unassigned work records requiring manual user intervention

---

## Executive Summary

The AI issue matching pipeline has at least **eight identifiable root causes** that compound each other, each independently capable of producing null matches. The most critical are structural: the issue list seen by the LLM is often **wrong, incomplete, or stale before the LLM ever runs**. Fixing the LLM prompt while the input data is broken will yield limited improvement. The highest-leverage fixes are in data pipeline plumbing, not model tuning.

The pipeline breakdown, in order of severity:

| # | Root Cause | Impact | Fix Complexity |
|---|-----------|--------|----------------|
| 1 | Desktop app doesn't include `updated` field in issue records — recency sort is silently broken | High | Low |
| 2 | Forge cache uses hardcoded `['In Progress']` status — narrower than org-configured statuses | High | Low |
| 3 | `user_assigned_issues` frozen at record upload time, not at AI analysis time | High | Medium |
| 4 | 30-issue hard cap in LLM prompt silently drops active issues | High | Low |
| 5 | Session continuity resets every 3-minute batch boundary | Medium | Medium |
| 6 | Small per-user batches in multi-user polling (4-6 records/user) | Medium | Low |
| 7 | ADF description extraction only handles paragraphs — bullets/tables/code dropped | Medium | Low |
| 8 | `temperature` parameter silently dropped in AI client — model runs at provider default | Medium | Low |

---

## Data Flow Overview

Understanding where each failure occurs requires a clear picture of the full pipeline:

```
Desktop App (Python)
  │
  ├─ 1. Every 5 min: fetch_jira_issues() → self.user_issues (max 50, desktop JQL)
  │
  ├─ 2. Every ~60s: capture activity record
  │      └─ window title, app name, OCR text, timestamps
  │
  ├─ 3. Every ~60s: upload activity record to Supabase
  │      └─ user_assigned_issues = json.dumps(self.user_issues)   ← FROZEN HERE
  │
AI Server (Node.js)
  │
  ├─ 4. Every 3 min (180s): getPendingActivityBatches(20) 
  │      └─ 20 records across ALL users
  │
  ├─ 5. extractUserAssignedIssues(records)
  │      ├─ Primary: read user_assigned_issues from record JSON     ← STALE/INCOMPLETE
  │      └─ Fallback: getUserCachedIssues() from user_jira_issues_cache ← STALE/NARROW
  │
  ├─ 6. formatAssignedIssues() 
  │      ├─ Sort by `updated` (always 0 for desktop records)       ← BROKEN SORT
  │      └─ Slice to 30 issues                                     ← SILENT TRUNCATION
  │
  └─ 7. LLM analysis (Gemini Flash) 
         └─ MIN_CONFIDENCE_THRESHOLD = 0.4 → null if below

Forge App (Atlassian Forge)
  │
  └─ user_jira_issues_cache
       ├─ Updated on: avi:jira:updated:issue event            ← EVENT-DRIVEN, NOT PERIODIC
       ├─ Updated on: manual user interaction (approval/assignment)
       └─ JQL: status = 'In Progress' only                   ← HARDCODED, NARROW
```

---

## Root Cause 1 — Missing `updated` Field Breaks Recency Sorting (High Impact)

### Evidence

`ai-server/src/services/ai/prompts.js` — `formatAssignedIssues()`:
```javascript
const sorted = [...userAssignedIssues].sort((a, b) => {
  const aDate = a.updated ? new Date(a.updated).getTime() : 0;
  const bDate = b.updated ? new Date(b.updated).getTime() : 0;
  return bDate - aDate;
});
return sorted.slice(0, 30)...
```

`python-desktop-app/desktop_app.py` — `fetch_jira_issues()` at line ~6935:
```python
formatted_issues.append({
    'key': issue['key'],
    'summary': fields['summary'],
    'status': fields['status']['name'],
    'project': fields['project']['key'],
    'description': description,
    'labels': labels
    # ← NO 'updated' field here
})
```

### What Actually Happens

The desktop app does not include an `updated` field in the formatted issues dict it embeds into `user_assigned_issues`. In `formatAssignedIssues()`, `a.updated` is always `undefined` / falsy, so `aDate = 0` for every issue. The sort is a stable no-op — issues are presented to the LLM in whatever order the desktop app received them from Jira.

The consequence is that the **30-issue truncation slice cuts off the wrong issues**. Issues that the user recently updated or transitioned (their most likely active tickets) are not prioritised. A user with 40 issues will have 10 silently dropped, and those 10 are as likely to be their current work as the 30 that remain.

The "> 14 days — likely inactive" recency label also never fires for desktop-path issues because `daysAgo` is computed from `issue.updated`, which is undefined.

### Fix

Add `updated: issue['fields'].get('updated', '')` to `formatted_issues.append()` in `fetch_jira_issues()`. This is a one-line change.

---

## Root Cause 2 — Forge Cache Uses Hardcoded `['In Progress']` (High Impact)

### Evidence

`forge-app/src/config/constants.js` line 6:
```javascript
export const JQL_ACTIVE_STATUSES = ['In Progress'];
```

`forge-app/src/services/issue/issueCacheService.js` line 31:
```javascript
const jiraData = await getUserAssignedIssues(JQL_ACTIVE_STATUSES);
```

The Forge cache (the fallback path when `user_assigned_issues` is null in a record) is built from a JQL query restricted to `status = 'In Progress'` only.

### What Actually Happens

Jira projects in the wild use dozens of custom workflow statuses. Common examples:
- `In Review`, `In Development`, `Under Development`, `Code Review`, `Testing`, `QA`
- Classic Scrum: `In Progress` is correct
- Many orgs (especially scaled Agile) have tickets in `In Review` or `Testing` for days or weeks while the developer works on them

If a user's actual current issue is in `In Review`, it is **absent from the Forge cache**. When the AI server falls back to the Forge cache path, that issue is invisible to the LLM, which returns null.

The desktop app is smarter here — `build_jql_for_tracked_statuses()` uses admin-configured statuses with a `statusCategory = "In Progress"` catch-all that correctly matches workflow variants. But this broader list only reaches the AI server when embedded in the record's `user_assigned_issues`. If that field is null or the embedding was stale, the narrower Forge fallback takes over.

### Fix

Change `JQL_ACTIVE_STATUSES` to use `statusCategory != Done AND statusCategory != "To Do"` or at minimum add the most common active status variants. The fix is low-risk and can be deployed independently.

---

## Root Cause 3 — `user_assigned_issues` Is a Point-in-Time Snapshot (High Impact)

### Evidence

`python-desktop-app/desktop_app.py` — batch upload at line 8248:
```python
'user_assigned_issues': json.dumps(self.user_issues) if self.user_issues else None,
```

`ai-server/src/services/activity-polling-service.js` — `extractUserAssignedIssues()`:
```javascript
// Primary: read embedded JSON in the record
const raw = record.user_assigned_issues;
// Fallback: read from user_jira_issues_cache in DB
```

### What Actually Happens

The issue list is embedded in the activity record **at the moment the record is uploaded** (roughly every 60 seconds). The AI server processes the record **3 minutes later** on average (180-second poll interval), potentially longer if the queue has grown.

More critically, `self.user_issues` is only refreshed:
1. Every 5 minutes if `should_refresh_issues_cache()` returns true (lines 7476, 7962)
2. Conditionally at batch upload time — `if self.should_refresh_issues_cache()` at line 9095-9097

Edge case failures:
- **Early session startup**: `self.user_issues` is empty until the first successful Jira API call. Activity records captured in the first 5 minutes of a working day embed `null`, and the AI server falls back to the Forge cache (which may also be stale).
- **Network interruption during refresh**: Jira API call fails; `fetch_issues_from_cache()` (local Supabase fallback) is called, but this is the local cache that could also be stale.
- **Issue assignment mid-session**: A PM assigns the user a new Jira ticket at 10:00. The user opens VS Code and starts working. The activity records for the next 5 minutes still have the old issue list. The new ticket is invisible to the LLM.

### Fix

Remove the issue list from activity records entirely. At AI analysis time, always resolve the current issue list from `user_jira_issues_cache` in Supabase. The `user_assigned_issues` embedded JSON is a premature denormalization that causes staleness. This requires ensuring `user_jira_issues_cache` is kept fresh (see Root Cause 2 and the scheduled refresh recommendation below).

---

## Root Cause 4 — 30-Issue Hard Cap Silently Excludes Active Issues (High Impact)

### Evidence

`ai-server/src/services/ai/prompts.js` line 25:
```javascript
return sorted.slice(0, 30)
```

`python-desktop-app/desktop_app.py` — `fetch_jira_issues()`:
```python
'maxResults': 50,
```

`forge-app/src/config/constants.js` line 4:
```javascript
export const MAX_JIRA_SEARCH_RESULTS = 50;
```

### What Actually Happens

The Jira API returns up to 50 issues. The AI server prompt truncates to 30. With Root Cause 1 (broken sort), the 20 dropped issues are effectively random. Any user with >30 active issues — common in sprint-heavy teams — has at least 20 issues the LLM never sees.

Even for users with exactly 30 issues, the LLM context includes descriptions (600 chars each), labels, and status — each issue takes ~150-200 tokens in the prompt. Thirty issues ≈ 4,500-6,000 tokens just for the issue list. Increasing this limit without fixing the sort first would make the problem worse (more irrelevant issues consuming tokens).

### Fix

First fix Root Cause 1 (add `updated` field). Then the sort correctly prioritises recently-updated issues. The 30-issue limit can then be increased to 50 to match the Jira fetch limit. Also consider trimming descriptions to 200-300 chars to save prompt budget. A user actively working rarely has >15 issues that are genuinely "In Progress" at any moment — a better signal is `updated >= -7d` combined with status filter.

---

## Root Cause 5 — Session Continuity Resets at Every Batch Boundary (Medium Impact)

### Evidence

`ai-server/src/services/activity-service.js` — system prompt:
```
SESSION CONTINUITY: Records are shown in chronological order. If consecutive records show 
the same user in the same or related application... subsequent records in the same work 
session should inherit that match at slightly lower confidence (0.5-0.6)...
```

`ai-server/src/services/activity-polling-service.js`:
```javascript
const ACTIVITY_POLLING_INTERVAL_MS = parseInt(process.env.ACTIVITY_POLLING_INTERVAL_MS) || 180000;
```

### What Actually Happens

The session continuity instruction only applies within a single LLM call (one batch). Each 3-minute poll is a stateless call with no memory of previous batches. 

Scenario: A developer spends 2 hours in VS Code working on `PROJ-45`. Records arrive every ~60 seconds:
- Batch 1 (3 records): LLM correctly identifies `PROJ-45` from window title
- Batch 2 (3 records, 3 min later): New LLM call with no context from Batch 1. The same VS Code window is still open, but if OCR text is poor or the window title is generic ("VS Code"), the LLM starts from zero. Confidence may drop below 0.4 → null.

This causes the same continuous work session to have intermittent null records, which the user then has to bulk-reassign manually.

### Fix

Persist the last confirmed match per user. Before building the analysis prompt, query `activity_records` for the most recently assigned record for the same user (within the last 30 minutes). Include this as a "previous context" hint in the prompt: `"Previous record (5 min ago) was matched to PROJ-45 (confidence 0.75). Consider this when evaluating ambiguous records."` This is a read-only DB query adding minimal latency.

---

## Root Cause 6 — Per-User Batch Size Is Too Small in Multi-User Environments (Medium Impact)

### Evidence

`ai-server/src/services/activity-polling-service.js`:
```javascript
const batchSize = parseInt(process.env.ACTIVITY_POLLING_BATCH_SIZE) || 20;
// ...
const records = await activityDbService.getPendingActivityBatches(batchSize);
// records are then grouped by user:
const byUser = groupBy(records, r => r.user_id);
```

### What Actually Happens

20 records are fetched across **all users**. For an organization with 5 active users, each user gets ~4 records per analysis cycle. For 10 users, each gets ~2 records.

With only 2-4 records, the LLM has almost no session context. The SESSION CONTINUITY rule requires multiple consecutive records in the same application to establish confidence — that only works with 5+ records per user. With 2 records, both might be from different applications, and the LLM has insufficient signal.

The global batch size of 20 was likely set for token budget reasons, but it should be per-user or at minimum increased in proportion to active user count.

### Fix

Increase `ACTIVITY_POLLING_BATCH_SIZE` to 50 or 100. Alternatively, change the polling logic to fetch the top N records **per user** (capped at 10 per user, across all users) rather than a flat global limit. The LLM call can handle larger prompts — Gemini Flash with 30,000 max output tokens has sufficient input context.

---

## Root Cause 7 — ADF Description Extraction Misses Structured Content (Medium Impact)

### Evidence

`python-desktop-app/desktop_app.py` — `fetch_jira_issues()` ADF parsing:
```python
for content_item in desc_content.get('content', []):
    if content_item.get('type') == 'paragraph':
        for text_node in content_item.get('content', []):
            if text_node.get('type') == 'text':
                text_parts.append(text_node.get('text', ''))
```

### What Actually Happens

Atlassian Document Format (ADF) supports paragraphs, bullet lists (`bulletList`), numbered lists (`orderedList`), headings (`heading`), code blocks (`codeBlock`), tables, and more. This parser only handles `paragraph` nodes.

Jira issues with descriptions formatted as:
```
## Acceptance Criteria
- User can log in with SSO
- Session persists for 30 minutes

## Technical Notes
Fix the OAuth redirect URI in auth.py
```

...yield an empty description because the content uses `heading`, `bulletList`, and `codeBlock` nodes — none of which are extracted. The LLM gets `Description: (empty)` and must rely solely on the issue summary to match.

Practically, this means issues with short summaries but detailed acceptance criteria give the LLM no useful signal.

### Fix

Recurse through all ADF node types and extract text from any `text` node regardless of parent type. This is a complete traversal, not type-specific parsing. The Forge app's `extractDescriptionText()` utility in `src/utils/adfToText.js` may already handle this — port that logic to the desktop app.

---

## Root Cause 8 — `temperature` Parameter Silently Dropped in AI Client (Medium Impact)

### Evidence

`ai-server/src/services/ai/ai-client.js` — `chatCompletionWithFallback()`:
```javascript
async function chatCompletionWithFallback({ messages, max_tokens, isVision }) {
  // temperature, userId, organizationId, apiCallName are not destructured
  // and are therefore silently ignored
  ...
  const response = await portkey.chat.completions.create({
    messages,
    model: 'gemini-2.0-flash',
    max_completion_tokens: 30000,
    // temperature is not included here
  });
}
```

### What Actually Happens

The callers of `chatCompletionWithFallback()` pass `temperature: 0.1` (or similar) for deterministic classification. The AI client silently discards it. The model runs at the provider's default temperature (typically 1.0 for Gemini).

For a classification task (match this activity to one of these issues), high temperature introduces unnecessary variability. The same activity record might match to `PROJ-45` at 0.7 confidence in one run but `PROJ-12` at 0.5 in another. This makes the overall match rate inconsistent and may cause borderline records to fall below the 0.4 threshold when they otherwise wouldn't.

### Fix

Destructure `temperature` in `chatCompletionWithFallback({ messages, max_tokens, isVision, temperature })` and pass it to the API call. Default to `0.1` if not provided.

---

## Compounding Effects

The above root causes do not operate independently. Their interaction makes the problem significantly worse than any individual cause would suggest:

**Scenario: New Issue Assigned Mid-Day**
1. PM assigns user to `PROJ-89` at 10:00 AM via Jira admin panel
2. `avi:jira:updated:issue` Forge trigger fires, but for issue `PROJ-89` — the `issueCacheSync` handler updates the cache for the issue's reporter/assignee context. If the Forge app is not open in the user's browser, the cache update may not propagate.
3. Desktop app refreshes issues at 10:05 AM (5-min TTL) — `PROJ-89` is fetched (if status is "In Progress" or matches configured statuses)
4. User starts working on `PROJ-89` at 10:02 AM — 3 minutes before the desktop refresh. Those 3 minutes of records have the old issue list.
5. At 10:04 AM, AI server polls. Records from 10:02-10:03 have no `PROJ-89` in `user_assigned_issues`. Fallback to Forge cache which also doesn't have `PROJ-89`. LLM gets null.
6. By 10:08 AM everything is fresh — but the 6 minutes of work are permanently unassigned.

**Scenario: Sprint with Many Tickets**
1. User has 45 active issues across 3 projects in a busy sprint
2. Desktop app fetches 50 issues, embeds them (no `updated` field → random order)
3. `formatAssignedIssues()` takes first 30, drops 15 at random
4. 3 of the dropped issues happen to be the ones the user is actively working on
5. Every activity record for those tickets → null → user reviews 40+ unassigned records at end of sprint

---

## Recommendations (Ranked by Effort vs. Impact)

### Quick Wins (< 1 day each)

**Q1. Add `updated` field to desktop issue format**  
File: `python-desktop-app/desktop_app.py`, `fetch_jira_issues()`  
Change: Add `'updated': issue['fields'].get('updated', '')` to `formatted_issues.append()`  
Impact: Fixes broken recency sort, ensures correct 30-issue truncation immediately

**Q2. Fix `temperature` bug in AI client**  
File: `ai-server/src/services/ai/ai-client.js`  
Change: Destructure `temperature` parameter, pass to API call, default `0.1`  
Impact: Reduces match variability, keeps borderline records above the 0.4 threshold

**Q3. Expand Forge cache JQL beyond `['In Progress']`**  
File: `forge-app/src/config/constants.js`  
Change: Update `JQL_ACTIVE_STATUSES` to `statusCategory in ("In Progress")` (which Jira expands to all statuses in that category) or explicitly add common variants  
Impact: Fallback path now has broader, more accurate issue set

**Q4. Fix ADF description extraction in desktop app**  
File: `python-desktop-app/desktop_app.py`, `fetch_jira_issues()`  
Change: Replace type-specific ADF parser with a recursive text extraction (traverse all nodes, collect `type == 'text'` values)  
Impact: LLM gets richer issue descriptions, better matching signal for issues with minimal summaries

### Medium Effort (1-3 days each)

**M1. Increase issue cap from 30 to 50 in `formatAssignedIssues()`**  
File: `ai-server/src/services/ai/prompts.js`  
Change: `.slice(0, 50)` and add `updated >= -30d` filter to drop inactive issues  
Prerequisites: Q1 must be done first (otherwise sorting is still broken)

**M2. Increase polling batch size**  
File: `ai-server/src/services/activity-polling-service.js`  
Change: Increase `ACTIVITY_POLLING_BATCH_SIZE` default to 60, or better: change `getPendingActivityBatches()` to fetch the top N records per user (e.g., top 10 per user, up to 10 users in a single call)  
Impact: More records per user per LLM call → better session continuity within a batch

**M3. Add previous-match context hint to analysis prompt**  
File: `ai-server/src/services/activity-polling-service.js`  
Change: Query `activity_records` for the most recently assigned record per user (within 30 min). Prepend a "Previous session context" note to `buildBatchAnalysisPrompt()`.  
Impact: Cross-batch session continuity, reduces re-classification cost for ongoing work sessions

**M4. Add periodic Forge cache refresh trigger**  
File: `forge-app/manifest.yml`, `forge-app/src/`  
Change: Add a scheduled trigger (every 15-30 min) that runs `updateAssignedIssuesCache()` for all active users (those with recent activity records).  
Impact: Forge cache fallback becomes reliable even for users who don't interact with the Forge UI

### Architectural (3-7 days)

**A1. Resolve issue list at AI analysis time, not record upload time**  
Current flow embeds issues in the record at upload time. Better: store only `user_id` in the record, resolve issues from `user_jira_issues_cache` at analysis time.  
This eliminates all staleness issues and decouples the issue list from the activity record schema. Requires removing `user_assigned_issues` from the record payload or treating it as a fallback hint only.

**A2. Implement closed-loop accuracy feedback using `ai_accuracy_events`**  
The `ai_accuracy_events` table exists and captures `ai_suggested_issue_key`, `final_issue_key`, `ai_confidence_score`, `application_name`, `window_title`.  
Build a query that surfaces the most-corrected (application, window title pattern, issue) triplets. Use these to generate few-shot examples in the analysis prompt. This creates a self-improving system: every manual correction becomes training signal.

**A3. Add confidence band telemetry alert**  
Track the distribution of `confidence_score` across all records over time. If the median confidence drops below 0.5 for any user/project, fire an alert to re-examine their issue cache or JQL configuration. This turns root cause detection from reactive (user complaint) to proactive (automated monitoring).

---

## Testing Recommendations

To validate any fix, compare the unassigned rate before and after deployment using the `activity_records` table:

```sql
SELECT 
  date_trunc('day', created_at) AS day,
  COUNT(*) AS total_records,
  COUNT(*) FILTER (WHERE task_key IS NULL) AS unassigned,
  ROUND(COUNT(*) FILTER (WHERE task_key IS NULL)::numeric / COUNT(*) * 100, 1) AS unassigned_pct
FROM activity_records
WHERE created_at >= NOW() - INTERVAL '14 days'
GROUP BY 1
ORDER BY 1;
```

Target: unassigned_pct below 15% (current estimate: 30-50% based on user reports). Track per-user to identify outliers — a single power user with many tickets can skew the aggregate.

---

## Appendix: Key File Locations

| Component | File | Relevant Area |
|-----------|------|---------------|
| AI analysis prompt | `ai-server/src/services/activity-service.js` | `BATCH_ANALYSIS_SYSTEM_PROMPT`, `buildBatchAnalysisPrompt()` |
| Issue formatting | `ai-server/src/services/ai/prompts.js` | `formatAssignedIssues()` |
| AI client bug | `ai-server/src/services/ai/ai-client.js` | `chatCompletionWithFallback()` |
| Polling & batch | `ai-server/src/services/activity-polling-service.js` | `extractUserAssignedIssues()`, `batchSize` |
| Forge cache update | `forge-app/src/services/issue/issueCacheService.js` | `updateAssignedIssuesCache()` |
| Forge JQL config | `forge-app/src/config/constants.js` | `JQL_ACTIVE_STATUSES` |
| Forge trigger | `forge-app/manifest.yml` | `issue-cache-trigger` |
| Desktop issue fetch | `python-desktop-app/desktop_app.py` | `fetch_jira_issues()` (~line 6811) |
| Desktop ADF parsing | `python-desktop-app/desktop_app.py` | description extraction in `fetch_jira_issues()` |
| Accuracy events | `supabase/migrations/20260422_ai_accuracy_tracking.sql` | `ai_accuracy_events` table |

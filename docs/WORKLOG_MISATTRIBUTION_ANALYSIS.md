# Worklog Misattribution Analysis — Worklogs Logged to Wrong Issues

**Date:** April 1, 2026  
**Reported By:** End Users  
**Affected Components:** AI Server (activity-service.js, activity-db-service.js), Desktop App (desktop_app.py), Forge App (scheduledWorklogSync.js)  
**Severity:** High — worklogs silently attached to incorrect Jira issues  
**Related:** [MULTI_PROJECT_KEY_FIX.md](MULTI_PROJECT_KEY_FIX.md) (March 30, 2026)

---

## Table of Contents

1. [User-Reported Symptom](#1-user-reported-symptom)
2. [Relationship to Previous Project Key Fix](#2-relationship-to-previous-project-key-fix)
3. [Worklog Flow Overview](#3-worklog-flow-overview)
4. [Root Cause Analysis — New Issue-Level Problems](#4-root-cause-analysis--new-issue-level-problems)
5. [Detailed Findings](#5-detailed-findings)
6. [Impact Assessment](#6-impact-assessment)
7. [Fix Implementation](#7-fix-implementation)
8. [Testing Recommendations](#8-testing-recommendations)

---

## 1. User-Reported Symptom

Users report that **worklogs are being logged to the wrong Jira issues**. For example:

- A user working on `PROJ-45 (Fix payment gateway)` finds their time logged under `PROJ-32 (Update user settings page)`
- Time spent on `APP-12 (Login redesign)` appears as a worklog on `APP-8 (Dashboard API)`
- Users discover unexpected worklogs on issues they haven't worked on recently

This is distinct from the previously fixed project key issue (where time went to the wrong **project**). This is about time going to the wrong **issue within the correct project** or across projects.

---

## 2. Relationship to Previous Project Key Fix

### What the March 30 fix addressed (RESOLVED ✅)

The [Multi-Project Key Fix](MULTI_PROJECT_KEY_FIX.md) corrected three problems:

| # | Problem | Fix | Status |
|---|---------|-----|--------|
| 1 | `_resolve_record_project_key()` fell back to first issue's project | Returns `None` — lets AI decide | ✅ Fixed |
| 2 | `sync_classifications()` only loaded overrides for one project | Now loads all known projects | ✅ Fixed |
| 3 | Batch upload pre-stamped wrong `project_key` | Per-record resolution with `None` fallback | ✅ Fixed |

### What the previous fix did NOT address (THIS DOCUMENT)

The project key fix operated at the **project level** — ensuring the right project was identified. But the **issue-level matching** (which specific issue within a project gets the worklog) has separate problems that were not part of that fix. These are the root causes documented below.

---

## 3. Worklog Flow Overview

Understanding the full pipeline helps identify where misattribution occurs:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ DESKTOP APP (python-desktop-app/desktop_app.py)                         │
│                                                                         │
│ 1. Captures window titles, app names, OCR text every few seconds        │
│ 2. Aggregates into sessions (5-min batches)                             │
│ 3. Resolves project_key per record from window title                    │
│ 4. Attaches user_assigned_issues (cached, all projects)                 │
│ 5. Uploads batch to Supabase activity_records table                     │
│    └─ status = 'pending'                                                │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ AI SERVER (ai-server/src/services/activity-polling-service.js)          │
│                                                                         │
│ 6. Polls activity_records for status='pending' records                  │
│ 7. Groups records by user_id                                            │
│ 8. Extracts user_assigned_issues from first record with issues          │
│ 9. Calls activity-service.analyzeBatch()                                │
│    └─ Sends BATCH_ANALYSIS_SYSTEM_PROMPT + all records to LLM          │
│    └─ LLM returns: { taskKey, projectKey, confidenceScore, reasoning }  │
│ 10. validateAnalysisKeys() — clears hallucinated task keys              │
│ 11. persistAnalysisResults() — writes to activity_records:              │
│     └─ user_assigned_issue_key = analysisResult.taskKey  ◄── CRITICAL   │
│     └─ status = 'analyzed'                                              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ FORGE APP (forge-app/src/services/scheduledWorklogSync.js)              │
│                                                                         │
│ 12. Scheduled trigger aggregates time per user+issue from               │
│     activity_records WHERE user_assigned_issue_key IS NOT NULL          │
│ 13. Creates/updates Jira worklogs via REST API                          │
│     └─ POST /rest/api/3/issue/{issueKey}/worklog                       │
│                                                                         │
│ OR: Manual assignment via assignmentResolvers.js                        │
│ 14. User manually assigns unassigned work → createWorklogIfNeeded()     │
└─────────────────────────────────────────────────────────────────────────┘
```

**The misattribution happens at Step 11** — the AI's `taskKey` decision is written directly as `user_assigned_issue_key` without any quality gate. Everything downstream (worklog sync, dashboard aggregation) trusts this value blindly.

---

## 4. Root Cause Analysis — New Issue-Level Problems

### Root Cause #1: No Confidence Threshold on AI Issue Matching (PRIMARY)

**Severity:** High  
**Files:**
- `ai-server/src/services/activity-service.js` — `persistAnalysisResults()` (line ~380)
- `ai-server/src/services/db/activity-db-service.js` — `updateActivityRecordAnalysis()` (line ~64)

**Problem:**

The AI returns a `confidenceScore` with each match (0.0–1.0), but this score is **stored in metadata only** — it is never used to gate whether the match should be applied. A match with confidence 0.2 (weak — "only project matches, specific task unclear") is treated identically to a match with confidence 0.9 (strong — "Jira key visible in window title").

```javascript
// activity-db-service.js, line 64 — NO confidence check
const updateData = {
  status: 'analyzed',
  user_assigned_issue_key: analysisResult.taskKey || null,  // ← Written regardless of confidence
  metadata: analysisResult.metadata || {},                   // ← Confidence stored here, but never checked
  analyzed_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};
```

**Example scenario:**

1. User has two issues: `PROJ-45 (Fix payment gateway)` and `PROJ-32 (Update user settings)`
2. User opens Chrome to read a generic JavaScript tutorial
3. AI receives: `[chrome.exe] JavaScript Array Methods - MDN Web Docs`
4. AI reasons: "Both issues involve JavaScript... PROJ-45 is In Progress... maybe related?"
5. AI returns: `{ taskKey: "PROJ-45", confidenceScore: 0.25, reasoning: "Possible JS research" }`
6. System writes `user_assigned_issue_key = "PROJ-45"` — a weak guess becomes a firm assignment
7. 300 seconds of "JavaScript tutorial" time gets logged as a worklog on the payment gateway issue

**The system prompt explicitly defines** confidence levels:
- 0.8–1.0: Direct match (Jira key visible)
- 0.6–0.7: Strong contextual match
- 0.4–0.5: Reasonable match
- 0.2–0.3: Weak match (only project matches)
- 0.0–0.1: No match possible

But these are **advisory only** — the code doesn't enforce any threshold.

**Fix:** Add a minimum confidence threshold (0.5) in `updateActivityRecordAnalysis()`. Matches below this threshold should be treated as `null` (unassigned), letting users manually assign from the UI.

---

### Root Cause #2: Issue List Truncated to 20 (CONTRIBUTING)

**Severity:** Medium  
**File:** `ai-server/src/services/ai/prompts.js` — `formatAssignedIssues()` (line ~170)

**Problem:**

```javascript
return userAssignedIssues
  .slice(0, 20) // ← Hard limit: only first 20 issues sent to AI
  .map(issue => { ... })
  .join('\n');
```

If a user has more than 20 in-progress issues across projects, issues beyond position 20 are **invisible to the AI**. The AI can only match against the 20 it sees, so it may force-match to a similar-looking visible issue instead of the correct but truncated one.

Combined with Root Cause #1 (no confidence threshold), this means:
- The correct issue (position 25) is not in the AI's context
- The AI picks the "closest" visible issue with low confidence
- That low-confidence match gets written as a firm assignment
- Worklog goes to the wrong issue

**Mitigation:** While increasing the limit helps, it also increases token usage/cost. The confidence threshold fix (Root Cause #1) is the more effective solution because it causes these uncertain matches to become "unassigned" rather than misassigned.

---

### Root Cause #3: Stale Issue Cache in Uploaded Records (CONTRIBUTING)

**Severity:** Low–Medium  
**File:** `python-desktop-app/desktop_app.py` — `upload_activity_batch()` (line ~7236)

**Problem:**

The desktop app caches `user_issues` with a 5-minute TTL (`issues_cache_ttl = 300`). When a batch is uploaded, the **current cache state** is embedded as `user_assigned_issues` in every record:

```python
record = {
    ...
    'user_assigned_issues': json.dumps(self.user_issues) if self.user_issues else None,
    ...
}
```

If a user transitions issues between cache refreshes (e.g., moves `PROJ-99` to "Done" and starts `PROJ-101`), the AI receives a stale list:
- `PROJ-99` (now Done) is still in the list → AI might match to it
- `PROJ-101` (now In Progress) is missing → AI can't match to it

This creates a window where the AI matches against an outdated set of candidate issues.

**Mitigation:** The 5-minute cache is a reasonable trade-off for API rate limiting. The confidence threshold fix helps here too — stale matches tend to be lower confidence.

---

### Root Cause #4: Generic IDE Title Regex False Positives (EDGE CASE)

**Severity:** Low  
**File:** `python-desktop-app/desktop_app.py` — `_resolve_record_project_key()` (line ~6500)

**Problem:**

The IntelliJ/generic IDE regex is overly broad:

```python
# IntelliJ/PyCharm: "file – project"
ide_match = re.search(r'\s[-–—]\s(.+?)(?:\s[-–—]\s|$)', window_title)
```

This regex matches **any** window title containing a dash-separated segment, not just IDEs. For example:
- `"Meeting Notes - John - Zoom"` → extracts `"John"` as workspace name
- `"Quick Fix - Bug Report - Firefox"` → extracts `"Bug Report"` as workspace name

If "Bug Report" happens to fuzzy-match a project key (e.g., project "BR"), the record gets tagged with the wrong project, which biases the AI's issue matching.

**Impact:** Low, because this only affects `project_key` assignment (not `taskKey` directly), and the AI can override it. But combined with AI tendency to trust the pre-set project_key, it can contribute to mismatches.

---

## 5. Detailed Findings

### 5.1 validateAnalysisKeys — Partial Protection Only

The existing `validateAnalysisKeys()` function (activity-service.js, line ~370) provides protection against **hallucinated** task keys:

```javascript
function validateAnalysisKeys(analyses, userAssignedIssues) {
  const validKeys = new Set(userAssignedIssues.map(i => i.key));
  for (const analysis of analyses) {
    if (analysis.taskKey && !validKeys.has(analysis.taskKey)) {
      logger.warn(`AI returned invalid task key: ${analysis.taskKey}`);
      analysis.taskKey = null;
      analysis.confidenceScore = Math.min(analysis.confidenceScore || 0, 0.3);
    }
  }
}
```

This catches the case where the AI **invents** a key (e.g., `PROJ-999` when no such issue exists). But it does NOT catch the case where the AI picks a **valid but incorrect** key from the assigned issues list — which is the scenario users are reporting.

### 5.2 Scheduled Sync Trusts user_assigned_issue_key Completely

The scheduled worklog sync (scheduledWorklogSync.js) queries:

```javascript
`activity_records?...&user_assigned_issue_key=not.is.null...`
```

It aggregates all time where `user_assigned_issue_key` is set, groups by user+issue, and creates Jira worklogs. There is **no secondary validation** — if the AI wrote the wrong key, the sync faithfully creates a worklog on the wrong issue.

### 5.3 AI Prompt Instructs Null for Uncertain Matches — But Code Doesn't Enforce

The system prompt says:

> "Return null for taskKey when there is no clear semantic connection between the activity and a specific issue"

> "A match requires a meaningful content relationship, not just both being work-related"

The AI is instructed to return null for weak matches, but LLMs don't always follow instructions perfectly. The confidence score is the AI's "second opinion" on its own certainty — by checking it programmatically, we add a reliable safety net.

---

## 6. Impact Assessment

### Users Affected

All users with:
- Multiple in-progress issues (especially >2 issues in the same project)
- Generic window titles that don't contain Jira keys
- Work patterns involving research, documentation, or general browsing

### Scale of Impact

Based on the system prompt's confidence guidelines:
- **0.4–0.5 matches** ("reasonable match") — these are borderline. Some correct, some wrong.
- **0.2–0.3 matches** ("weak match") — most of these are likely misattributions. Should be unassigned.
- Any match where the AI's only reasoning is "same project" or "both are technical" is suspect.

### Downstream Effects

1. **Incorrect Jira worklogs** — time appears on wrong issues, affecting project tracking and billing
2. **Inflated time on some issues** — makes it look like an issue took more time than it did
3. **Missing time on other issues** — the correct issue shows less time, or user has to manually fix
4. **Trust erosion** — users lose confidence in the time tracker and stop relying on it

---

## 7. Fix Implementation

### Fix 1: Confidence Threshold in Activity DB Service (PRIMARY)

**File:** `ai-server/src/services/db/activity-db-service.js`  
**Function:** `updateActivityRecordAnalysis()`

Add a minimum confidence threshold. Matches below this threshold are treated as unassigned:

```javascript
// BEFORE:
user_assigned_issue_key: analysisResult.taskKey || null,

// AFTER:
const confidenceScore = analysisResult.metadata?.confidenceScore ?? 0;
const MIN_CONFIDENCE_THRESHOLD = 0.5;
const taskKeyMeetsThreshold = analysisResult.taskKey && confidenceScore >= MIN_CONFIDENCE_THRESHOLD;

user_assigned_issue_key: taskKeyMeetsThreshold ? analysisResult.taskKey : null,
```

**Why 0.5?**
- 0.5 is the boundary between "reasonable match" (0.4–0.5) and "strong match" (0.6+)
- Using `>=` 0.5 includes reasonable matches while filtering weak ones
- This means only matches where the AI has at least moderate confidence create worklogs
- Low-confidence records become "unassigned work" visible in the Forge UI for manual assignment
- Configurable via environment variable for per-deployment tuning

### Fix 2: Log Low-Confidence Demotions (OBSERVABILITY)

**File:** `ai-server/src/services/activity-service.js`  
**Function:** `persistAnalysisResults()`

Add logging when a match is demoted due to low confidence, so we can monitor the impact:

```javascript
if (analysis.taskKey && (analysis.confidenceScore || 0) < 0.5) {
  logger.info(`[ActivityService] Low-confidence match demoted to unassigned: ` +
    `taskKey=${analysis.taskKey}, confidence=${analysis.confidenceScore}, ` +
    `reasoning=${analysis.reasoning}`);
}
```

---

## 8. Testing Recommendations

### Manual Testing Scenarios

1. **Low-confidence match demoted:** Open a generic browser tab (e.g., MDN docs) while having 2+ issues. Verify the activity becomes "unassigned" rather than matched to a random issue.

2. **High-confidence match preserved:** Open VS Code with a workspace name matching a project. Verify the activity is correctly matched to the relevant issue.

3. **Jira key in window title:** Open a browser tab with a Jira issue URL visible. Verify confidence is 0.8+ and match is correct.

4. **Edge case — exactly at threshold:** Monitor logs for matches at 0.5 confidence and verify they are reasonable matches that should be assigned.

### Automated Monitoring

After deployment, monitor:
- Count of "demoted" log entries vs. total analyzed records (expect 10–30% demotion rate initially)
- Count of "unassigned work" entries (should increase slightly)
- User manual assignment rate (may increase, which is expected and correct)
- User complaints about wrong worklogs (should decrease)

### Rollback Plan

If the threshold is too aggressive (too many records going to unassigned):
1. Lower `MIN_CONFIDENCE_THRESHOLD` to 0.4 or 0.3 via environment variable
2. Or revert the code change — records will go back to current behavior

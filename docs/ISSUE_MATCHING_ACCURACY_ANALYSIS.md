# Issue Matching Accuracy — Deep Analysis

**Date:** 28 April 2026  
**Reviewer note:** This analysis was produced by examining every stage of the matching pipeline end-to-end. All findings reference specific file locations.

---

## Objective

Users are reporting an increase in unassigned worklogs and poor accuracy when the AI matches activity records to Jira issues. This document analyses the root causes across the full data pipeline and provides prioritised, actionable recommendations.

---

## The Matching Pipeline (Ideal Flow)

```
Jira Issue (full data)
  → Forge fetches fields
    → stored in user_jira_issues_cache (Supabase)
      → read by Supabase edge function on INSERT trigger
        → sent to AI server /api/analyze-batch
          → passed to formatAssignedIssues() → LLM prompt
            → LLM returns taskKey + confidence
              → stored back to activity_records
```

Every stage in this chain has defects.

---

## Defect 1 — Webhook SELECT Drops Description (Critical Bug)

**Files:**
- `supabase/functions/screenshot-webhook/index.ts` line 72
- `supabase/functions/activity-webhook/index.ts`

Both webhooks read the issue cache with this SELECT:

```ts
.select('issue_key, summary, status, project_key, issue_type')
```

This is a 5-column SELECT. The `description` column exists in the `user_jira_issues_cache` table (added in `supabase/migrations/20260306_extend_user_jira_issues_cache.sql`) and is populated by the event-driven trigger path — but it is **never read here**. The description never reaches the LLM through either the screenshot or activity pipelines.

**Impact:** Every activity record analyzed goes to the LLM with only a 1-line summary and no semantic context. This is the single largest cause of poor matching.

---

## Defect 2 — Old Cache Write Path Discards Description (Data Quality Bug)

**Files:**
- `forge-app/src/services/issue/issueCacheService.js` line 55 — old resolver path
- `forge-app/src/services/issueCacheService.js` line 85 — event-triggered path

There are **two** issue cache write code paths that produce different data:

| Path | Trigger | Stores description? |
|---|---|---|
| `forge-app/src/services/issueCacheService.js` → AI server `cacheUserIssues` | `avi:jira:updated:issue` event | ✅ Yes, via `extractDescriptionText()` |
| `forge-app/src/services/issue/issueCacheService.js` → `updateAssignedIssuesCache` resolver | User-triggered / resolver call | ❌ No |

The resolver path stores only:

```js
{
  user_id, organization_id, issue_key,
  summary, status, project_key,
  issue_type, updated_at   // NO description, NO labels, NO priority
}
```

Even though the Jira API call already requests `description` (see `forge-app/src/services/issueCacheService.js` line 85), the field is thrown away before writing. When this path runs, users get a cache without descriptions until the next issue-update event fires and the trigger path overwrites the rows.

---

## Defect 3 — Description Truncated to 200 Characters (Semantic Loss)

**File:** `ai-server/src/services/ai/prompts.js` line 38

```js
const desc = issue.description.length > 200
  ? issue.description.substring(0, 200) + '...'
  : issue.description;
```

200 characters is barely one sentence. A properly written Jira story description with acceptance criteria, technical approach, and affected components is typically 500–2,000 characters. Truncating at 200 means the LLM sees only the introductory sentence — usually the most generic, least discriminating part — and misses all the technical specifics that would distinguish one issue from another.

**Example of what the LLM sees vs what it should see:**
- **Actual (≤200 chars):** `"Implement the user profile settings page. Allow users to update their display name, avatar, and notification preferences..."`
- **Needed:** the above *plus* technical details like framework, affected service names, file paths, API endpoints — exactly what appears in window titles and OCR text

---

## Defect 4 — Dual Confidence Thresholds with Different Defaults (Logic Bug)

**Files:**
- `ai-server/src/services/activity-service.js` — default `0.5`
- `ai-server/src/services/db/activity-db-service.js` line 95 — default `0.3`

Both files read the same env var `AI_MATCH_MIN_CONFIDENCE` but use different hardcoded defaults:

```js
// activity-service.js (logging path — logs as "demoted")
const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.5');
if (analysis.taskKey && confidenceScore < MIN_CONFIDENCE_THRESHOLD) {
  logger.info('Low-confidence match demoted to unassigned');
}

// activity-db-service.js (actual write path — ASSIGNS the record)
const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.3');
const taskKeyMeetsThreshold = analysisResult.taskKey && confidenceScore >= MIN_CONFIDENCE_THRESHOLD;
```

**Result:** A match with confidence `0.35` is logged as "demoted to unassigned" by `activity-service.js` and **simultaneously assigned** by `activity-db-service.js`. The log is misleading and the wrong matches get written.

This also means records at confidence 0.3–0.5 — the AI's own "weak / uncertain" band per the prompt's scoring guide — are assigned by default, creating the flood of wrongly-assigned records users see.

---

## Defect 5 — Clustering Prompt Has No Issue Descriptions

**File:** `ai-server/src/services/clustering-service.js` line 130

When building the clustering context, the issues list is formatted as:

```js
`- ${issue.issue_key}: ${issue.summary}`
```

No description, no labels. This is the **second chance** the system has to match unassigned work to issues and it suffers the same information deficit. When the LLM clusters sessions and suggests a `suggested_issue_key`, it is working with only single-line summaries, making confident suggestions on ambiguous activity nearly impossible.

---

## Defect 6 — Missing High-Value Jira Fields Throughout

Neither the cache write nor the LLM prompt includes:

| Field | Why it matters for matching |
|---|---|
| `components` | Maps directly to project areas visible in IDE paths and window titles |
| `parent` / epic name | Ties individual tasks to a larger initiative visible in branch names or project folders |
| `labels` | Often mirror technology names (`react`, `api`, `auth`) that appear verbatim in OCR text |
| `acceptanceCriteria` | Custom field — often the most precise technical description of the work |
| Sprint name | Matches the sprint board name visible in browser tabs |

Labels *are* fetched by the trigger path (`issueCacheService.js` line 85) and stored by `cacheUserIssues` — but as shown in Defect 1, they are never selected from the cache by the webhooks.

---

## Defect 7 — Issue Cache Has No Scheduled Refresh (Staleness)

**Files:**
- `forge-app/manifest.yml`
- `forge-app/src/services/issueCacheService.js`

The cache is refreshed only when `avi:jira:updated:issue` fires for the specific user. This misses:

- A Jira admin bulk-assigning a sprint to a team (no per-user event fires)
- A user newly added to a project with issues already assigned
- Issue description or acceptance criteria updates (trigger fires but for a different user)

The scheduled worklog sync runs hourly but does **not** refresh the issue cache. The `supabase/functions/update-issues-cache/index.ts` edge function is scaffolded but left as a TODO.

---

## Defect 8 — Activity Records Sent to Clustering Drop AI Reasoning

**File:** `ai-server/src/services/db/clustering-db-service.js` line 163

For `activity_records` (the new pipeline), the session's `reasoning` field sent to the clustering LLM is set to:

```js
reasoning: record.window_title || 'Activity record',
```

The window title is used as reasoning. There is no AI-generated reasoning for new-pipeline records at clustering time (unlike the legacy path which joins `analysis_results`). The clustering LLM sees the same window title as both the context and reasoning field, with no independent interpretive signal.

---

## Root Cause Summary

The core problem is a **data pipeline gap**: Jira descriptions exist in the database but are systematically excluded from the LLM context at both the read (webhook) and format (prompts.js) layers. All other defects compound the baseline matching difficulty.

```
Jira has:      summary + description + labels + components + epic + AC
Cache has:     summary + description + labels + priority   (trigger path only)
Webhooks read: summary + status only                       ← PRIMARY GAP
LLM receives:  summary + status
```

---

## Prioritised Recommendations

### P1 — Fix webhook SELECT to include description and labels (1-line change, highest ROI)

**Files:** `supabase/functions/screenshot-webhook/index.ts`, `supabase/functions/activity-webhook/index.ts`

```ts
// BEFORE
.select('issue_key, summary, status, project_key, issue_type')

// AFTER
.select('issue_key, issue_summary, summary, status, project_key, issue_type, description, labels')
```

> Both `issue_summary` (event-triggered path) and `summary` (resolver path) should be read until the schema columns are unified.

---

### P2 — Fix old cache write path to persist description and labels

**File:** `forge-app/src/services/issue/issueCacheService.js`

The Jira API call already requests `description`. It just needs to be mapped before writing:

```js
const cacheEntries = issues.map(issue => ({
  // existing fields...
  description: extractAdfText(issue.fields.description) || null,
  labels:      issue.fields.labels || [],
  priority:    issue.fields.priority?.name || null,
}));
```

The `extractDescriptionText` ADF-to-text helper already exists in `ai-server/src/controllers/forge-proxy-controller.js`. A copy should be extracted to a shared Forge utility.

---

### P3 — Increase description truncation limit from 200 to 600 characters

**File:** `ai-server/src/services/ai/prompts.js`

```js
// BEFORE
const desc = issue.description.length > 200
  ? issue.description.substring(0, 200) + '...'
  : issue.description;

// AFTER
const desc = issue.description.length > 600
  ? issue.description.substring(0, 600) + '...'
  : issue.description;
```

600 characters adds ~35 tokens per issue. With 30 issues in the prompt that is ~1,050 extra tokens — well within modern LLM context windows and worth the cost for the accuracy gain.

---

### P4 — Fix the dual confidence threshold

**Files:** `ai-server/src/services/activity-service.js`, `ai-server/src/services/db/activity-db-service.js`

Remove the duplicate constant. Keep it only in `activity-db-service.js` (the actual enforcement point) and raise the default to `0.4`:

```js
// activity-db-service.js — single source of truth
const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.4');

// activity-service.js — remove the duplicate constant entirely
```

The prompt already defines 0.2–0.3 as "Weak match". Defaulting to 0.3 means weak matches are auto-assigned, which is wrong given there is a human approval gate above the threshold anyway.

---

### P5 — Add labels to the LLM issue context

**File:** `ai-server/src/services/ai/prompts.js`

Labels are already stored in the cache. Ensure the webhook SELECT (P1) and `formatAssignedIssues` both treat `labels` as a first-class field so technology-name signals appear in the prompt.

---

### P6 — Add description to the clustering issues context

**File:** `ai-server/src/services/clustering-service.js`

```js
// BEFORE
`- ${issue.issue_key}: ${issue.summary}`

// AFTER
const descSuffix = issue.description
  ? ` — ${issue.description.substring(0, 200)}`
  : '';
`- ${issue.issue_key}: ${issue.summary}${descSuffix}`
```

---

### P7 — Add a scheduled issue-cache refresh trigger

**File:** `forge-app/manifest.yml`

Add a daily scheduled trigger to call `refreshCacheForUser` for all active users. The `supabase/functions/update-issues-cache/index.ts` edge function is already scaffolded but not wired up. The Forge scheduled trigger is the correct driver because it has access to Jira OAuth context that the Supabase function lacks.

---

### P8 — Enrich activity records with structured location data

Beyond OCR free text, the desktop app already has the full window title which often contains a file path (VS Code), URL (browser), or branch name (Git clients). Consider promoting these to explicit fields in `activity_records` (e.g., `active_url`, `active_file_path`) so the LLM prompt can present them as labelled signals rather than burying them in 1,000 characters of OCR noise.

---

### P9 — Fetch Jira `components` and epic link for cache

For issues where description is sparse (common for task-type tickets), `components` and the parent epic's summary provide the next best matching signal. This requires one additional Jira API call per cache refresh but would cover the "short description" case directly.

---

## On the Jira Description Quality Suggestion

The user's suggestion is correct and directly validated by the code. In `formatAssignedIssues` (`ai-server/src/services/ai/prompts.js`), description is the only enrichment field below the `key: summary (Status)` line. When descriptions are:

- **Empty** → LLM has only the issue title — often a 5-word phrase
- **Generic** (e.g., "Fix bug in auth module") → LLM cannot distinguish between multiple auth-related issues
- **Specific** (e.g., "Implement PKCE token refresh in `auth/token_manager.py`, failing on 401 from `/api/refresh-token`…") → LLM can match with high confidence because the file path, module name, and endpoint string will appear verbatim in OCR text

**Team process recommendation:** Require description + acceptance criteria on all Jira issues, particularly stories and tasks. Even 2–3 sentences containing component names, technology names, and API/file references will materially improve matching rates. This is the cheapest improvement available — no code change required. Combined with P1–P4 above (ensuring descriptions actually reach the LLM), this should recover a significant share of unassigned worklogs.

---

## Implementation Priority Order

| # | Change | Effort | Impact |
|---|---|---|---|
| P1 | Fix webhook SELECT (add description, labels) | Minutes | Very High |
| P2 | Fix old cache write path (persist description) | 1–2 hours | High |
| P4 | Fix dual confidence threshold (unify at 0.4) | 30 min | High |
| P3 | Increase description truncation 200 → 600 chars | Minutes | Medium-High |
| P6 | Add description to clustering prompt | 30 min | Medium |
| P5 | Ensure labels flow end-to-end | 1 hour | Medium |
| P7 | Scheduled cache refresh trigger | 2–3 hours | Medium |
| P8 | Structured location data in activity records | 1 day | Medium |
| P9 | Fetch components/epic for cache | 2–3 hours | Low-Medium |

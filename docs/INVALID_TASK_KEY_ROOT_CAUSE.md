# Root Cause: `[ActivityService] AI returned invalid task key: ESW-6948`

**Date:** 2026-05-12
**Component:** ai-server / activity analysis pipeline
**Log signature:** `warn: [ActivityService] AI returned invalid task key: <KEY>` (repeated N× where N = batch size)

---

## TL;DR

The warning means the LLM returned a Jira issue key that was **not present in the `userAssignedIssues` allow-list supplied for that batch**. The validator unconditionally nulls the `taskKey` and caps `confidenceScore` at 0.3 ([activity-service.js:378-395](../ai-server/src/services/activity-service.js#L378-L395)).

The user's hypothesis — *"the ticket was assigned to user A at capture time, reassigned to user B before analysis, so it disappeared from user A's allow-list"* — is **plausible but narrow**. It only fires under one specific code path. In the most common path the allow-list is a frozen capture-time snapshot stored on the activity record, so post-capture reassignment is irrelevant.

The full set of causes is enumerated below in order of likelihood.

---

## What the validator actually checks

[activity-service.js:378-395](../ai-server/src/services/activity-service.js#L378-L395):

```js
function validateAnalysisKeys(analyses, userAssignedIssues) {
  const validKeys = new Set(userAssignedIssues.map(i => i.key));
  for (const analysis of analyses) {
    if (analysis.taskKey && !validKeys.has(analysis.taskKey)) {
      logger.warn(`[ActivityService] AI returned invalid task key: ${analysis.taskKey}`);
      analysis.taskKey = null;
      analysis.confidenceScore = Math.min(analysis.confidenceScore || 0, 0.3);
    }
    // ...
  }
}
```

It is a pure set-membership check against the `userAssignedIssues` parameter. It does **not** call Jira, does **not** check project prefix, does **not** check user permissions. "Invalid" only means "not in the list you passed me."

The repetition (5× same key in one second) is normal: `analyses` is one entry per activity record in a batch. Five records in the same batch whose OCR text caused the AI to land on the same key produce five identical warnings. It is not a retry loop.

---

## Two pipeline entry points feed the validator differently

### Path A — Activity webhook (primary, fast)

[supabase/functions/activity-webhook/index.ts](../supabase/functions/activity-webhook/index.ts) fires on each batch insert into `activity_records`. It builds `issuesForAnalysis` by **merging** two sources and POSTs to `/api/analyze-batch`:

1. **`user_jira_issues_cache`** — read fresh at webhook trigger time, filtered by `user_id`, ordered by `updated_at desc`, limited to 50 rows ([activity-webhook/index.ts:122-128](../supabase/functions/activity-webhook/index.ts#L122-L128)).
2. **Record-embedded `user_assigned_issues`** — the first non-empty embedded list across the batch's records ([activity-webhook/index.ts:154-170](../supabase/functions/activity-webhook/index.ts#L154-L170)).

The merge ([activity-webhook/index.ts:184-211](../supabase/functions/activity-webhook/index.ts#L184-L211)) takes the **union of keys from both sources**, uses cache as the base (richer fields: `priority`, `updated`, `issueType`), and overlays non-empty fields from the embedded snapshot.

**Implication for the reassignment theory:** if the embedded snapshot has the key, the merge keeps it — *even if the cache no longer does*. The webhook path therefore exhibits the warning under reassignment only when the embedded snapshot is also missing the key (null/empty/parse-fails).

### Path B — Polling service (safety net for missed webhooks)

[activity-polling-service.js:182-234](../ai-server/src/services/activity-polling-service.js#L182-L234) periodically scans for stuck `pending` records and processes them directly (no merge, no webhook). It selects `issuesForAnalysis` with simple OR logic:

```js
const userAssignedIssues = extractUserAssignedIssues(records);   // embedded
let issuesForAnalysis = userAssignedIssues;
if (!issuesForAnalysis || issuesForAnalysis.length === 0) {
  const cachedIssues = await userDbService.getUserCachedIssues(userId, organizationId);
  // ... map to issuesForAnalysis
}
```

Embedded wins outright when present. Cache fallback only fires when **every** record in the batch has empty embedded ([activity-polling-service.js:40-52](../ai-server/src/services/activity-polling-service.js#L40-L52)).

**Implication for the reassignment theory:** if any record carries an embedded snapshot containing the key, the cache state is never consulted and reassignment is irrelevant.

### What the AI is told

The full unsliced `userAssignedIssues` reaches the validator, but the prompt sees a sorted top-50 ([prompts.js:22-29](../ai-server/src/services/ai/prompts.js#L22-L29)). The system prompt at [activity-service.js:190](../ai-server/src/services/activity-service.js#L190) contains the explicit rule:

> "CRITICAL TASK KEY RULE: You must ONLY use task keys from the assigned issues list below. NEVER invent, fabricate, or extract issue keys from OCR text, window titles, or any other source."

The validator exists because LLMs ignore that rule sometimes — especially when OCR text contains a strong literal match like a Jira key visible on screen.

---

## All possible causes for the warning, ranked

### 1. OCR-driven hallucination (most common)

The user's screen showed `ESW-6948` (open in a browser tab, mentioned in a Slack thread, named in a commit), the AI extracted the literal string from OCR text, and returned it even though it was never in the supplied allow-list.

**Why it dominates:** this is the exact failure mode the prompt rule and validator were built for. LLMs often violate "do not extract from text" instructions when the text contains an obvious surface match. The warning was added specifically to detect and neutralize these.

**Signature:** ESW-6948 has never been assigned to the user, or was assigned long ago and is now Done. The user can confirm via Jira issue history.

### 2. Status / recency / sprint filter excluded a legitimately-assigned issue

The desktop app's JQL ([desktop_app.py:6801-6845](../python-desktop-app/desktop_app.py#L6801-L6845)) is:

```
assignee = currentUser()
  AND (
    (project = "<configured>" AND status IN <tracked_statuses>) OR ...
    OR (project NOT IN (<configured>) AND statusCategory = "In Progress" AND updated >= -30d)
  )
maxResults: 50
```

It excludes:
- Issues whose status is not in the project's tracked-statuses list (when the project is configured).
- Issues whose `statusCategory` is not `"In Progress"` (for unconfigured projects).
- Issues not updated in the last 30 days (catch-all clause only).
- Backlog issues (Sprint is EMPTY) — deliberately excluded per [desktop_app.py:6994-6996](../python-desktop-app/desktop_app.py#L6994-L6996) ("polluting `user_assigned_issues` with items the user isn't actively working on").
- Issues beyond the 50-row cap.

The Forge-side cache writer ([issueCacheService.js:38](../forge-app/src/services/issue/issueCacheService.js#L38)) uses a *different*, broader JQL — `JQL_ACTIVE_STATUSES = 'statusCategory = "In Progress"'` ([forge-app/src/config/constants.js:6](../forge-app/src/config/constants.js#L6)) — with no `-30d` cutoff and no tracked-statuses filter. So the desktop-embedded list and the cache list **disagree by design**.

### 3. Reassignment between capture and analysis (the user's hypothesis)

For this to actually produce the warning, all of the following must hold:

1. The record's `user_assigned_issues` column is null, empty, or parse-fails. (Either the desktop never wrote it, or the desktop wrote `null` because Jira was unreachable at capture and the local issue cache was empty.)
2. The activity webhook also receives an empty embedded list (same records, same column).
3. Between the moment user A captured the screenshot and the moment the webhook reads `user_jira_issues_cache`, the Forge `update-issues-cache` scheduled trigger has run and removed the key from user A's cache rows.
4. ESW-6948 actually was assigned to user A at capture time (not just visible on their screen).

When all four conditions hold, the merged `issuesForAnalysis` won't contain ESW-6948, the AI may still hallucinate it from OCR, and the warning fires. Outside this narrow window the embedded snapshot acts as a record-time freeze that survives reassignment.

**How to confirm:** check Jira's issue history for ESW-6948 around the time of the warning. If the assignee changed off user A in the minutes before `12:18:43`, and the activity record's `user_assigned_issues` column is null, this hypothesis fits.

### 4. Desktop cache staleness at capture time

`fetch_jira_issues()` is cached in memory for 5 minutes ([desktop_app.py:4944](../python-desktop-app/desktop_app.py#L4944)) and is refreshed inline before each upload ([desktop_app.py:9183-9185](../python-desktop-app/desktop_app.py#L9183-L9185)). However:

- If the network is down at upload time, the inline refresh fails and the stale list is sent.
- If a fresh assignment happened between the last successful refresh and the screenshot, the embedded list won't contain the new key.

This is functionally the same as cause #3 but on the desktop side rather than the cache side.

### 5. Schema drift: `summary` vs `issue_summary`

`user_jira_issues_cache` has both columns. The Forge writer writes to **`summary`** only ([issueCacheService.js:56](../forge-app/src/services/issue/issueCacheService.js#L56)). The desktop reader reads **`issue_summary`** first, falling back to `summary` ([desktop_app.py:6878](../python-desktop-app/desktop_app.py#L6878)). The webhook reader selects both and prefers `issue_summary` ([activity-webhook/index.ts:125, 135](../supabase/functions/activity-webhook/index.ts#L125)).

**Not a cause of this specific warning** — the validator keys off `issue.key`, not summary fields. Listed here only so it doesn't get mistaken for one during diagnosis.

### 6. AI response parse / mapping bug

Theoretically the AI's analysis output could be misaligned with records, causing a key valid for one record to be applied to another whose user's allow-list lacks it. The code paths reviewed don't show this, so it's listed as a remote possibility, not a likely cause.

---

## Diagnostic procedure for the `ESW-6948` warnings at 2026-05-12 12:18:43 UTC

Run these in order; results map to the causes above.

### Step 1 — Is ESW-6948 assigned to this user at all, and what is its history?

In Jira, open ESW-6948 → History. Look at assignee changes around `2026-05-12 12:18 UTC`. Three outcomes:

| Observation                                          | Maps to cause                  |
| ---------------------------------------------------- | ------------------------------ |
| Never assigned to this user                          | #1 (OCR hallucination)         |
| Assigned to user A, no changes in last hour          | #2 (filter exclusion) or #5    |
| Assignee changed off user A in the minutes prior     | #3 (reassignment) — proceed    |

### Step 2 — What did the activity records actually carry?

For the five records that produced the warnings (look up by `created_at` / `user_id`):

```sql
select
  id,
  user_id,
  created_at,
  status,
  user_assigned_issues is null                                  as col_is_null,
  case
    when user_assigned_issues is null then 0
    when jsonb_typeof(user_assigned_issues::jsonb) = 'array'
      then jsonb_array_length(user_assigned_issues::jsonb)
    else 0
  end                                                           as embedded_count,
  (user_assigned_issues::jsonb @> '[{"key":"ESW-6948"}]'::jsonb) as has_esw_6948_embedded
from activity_records
where user_id = '<user A id>'
  and created_at between '2026-05-12 12:18:00' and '2026-05-12 12:19:00'
order by created_at;
```

Interpretation:

| Observation                                                       | Conclusion                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `has_esw_6948_embedded = true` on any record                      | Embedded snapshot contains the key. Validator should have accepted it. If warning still fired, there is a **bug** in the merge or parse — open a separate investigation (`parseUserAssignedIssues` failure, mid-batch merge bug). Reassignment theory does NOT fit.        |
| `embedded_count > 0` but `has_esw_6948_embedded = false`          | Desktop's allow-list at capture time did not contain ESW-6948. Cause is #1, #2, or #4 — never #3.                                                                                                                                                                            |
| `col_is_null = true` or `embedded_count = 0` on **all** records   | Allow-list came purely from cache (webhook merge) or cache fallback (polling). The reassignment theory (#3) is fully in play — proceed to Step 3.                                                                                                                            |

### Step 3 — What did the cache look like at analysis time?

```sql
select issue_key, project_key, status, issue_summary, summary, updated_at
from user_jira_issues_cache
where user_id = '<user A id>'
  and organization_id = 'a537792d-...'    -- evoke
  and issue_key = 'ESW-6948';
```

| Observation                                       | Conclusion                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Zero rows now                                     | Consistent with #3 (key was either reassigned away, or never made it into the cache because the Forge JQL excluded it).             |
| Row exists                                        | Cache contained the key. Then the webhook merge should have included it. If it did but the warning still fired, suspect cause #6.   |

If zero rows, also check:

```sql
-- When did the Forge trigger last refresh this user's cache?
select user_id, max(updated_at) as last_cache_write, count(*) as cached_count
from user_jira_issues_cache
where user_id = '<user A id>' and organization_id = 'a537792d-...'
group by user_id;
```

A `last_cache_write` between the screenshot capture and `12:18:43` confirms cause #3.

### Step 4 — Check the webhook fallback log

If the polling path (not the webhook) handled the batch, the AI server log will contain:

```
[Polling] Fetched <N> cached issues as fallback for user <user A id>
```

Search the ai-server logs around `2026-05-12 12:18:43`. Presence of this line forces cause #3 or #2; absence means the webhook merge was used.

---

## Confirming the user's hypothesis specifically

> "The user had this issue under their name when this was added to the queue, but the ticket got reassigned to another user before AI analysis, and after AI analysis it couldn't find it under the user's name."

**Verdict:** plausible but conditional. The hypothesis is confirmed if and only if Step 2 shows the activity records had `user_assigned_issues` null/empty AND Step 3 shows the cache no longer contained ESW-6948 with a `last_cache_write` after the reassignment in Jira's history.

If Step 2 shows the embedded snapshot contained ESW-6948, the hypothesis is **falsified** — the validator would have accepted the key regardless of reassignment. In that case the warning indicates a different bug, most likely a parse/merge failure in the webhook or polling code.

The most likely actual cause across all observed instances of this warning is still **#1 (OCR hallucination)**, because:
- It produces this exact symptom in the most common pipeline state (embedded snapshot present, cache fresh, ESW-6948 visible on screen but not assigned to the user).
- The validator was introduced explicitly to neutralize it ([activity-service.js:381-385](../ai-server/src/services/activity-service.js#L381-L385) sets `taskKey = null` and caps `confidenceScore` — the salvage logic that follows treats this as "no match," exactly as intended).
- The repeated 5× pattern (same key, same second) is the LLM giving consistent answers on similar OCR text, not a bug.

---

## Suggested remediation, only if Steps 1–4 implicate #3

If the diagnostic establishes reassignment-during-flight as the actual cause, the most targeted fix is to relax the membership check so the activity is still associated with ESW-6948 (with a recorded note) rather than nulled:

- Treat keys present in the **historical** assignee list as valid, not just the current snapshot. The Forge side already writes `updated_at`; the Forge cache trigger could retain recently-removed keys for a short grace period (e.g., 24h with a `removed_at` column).
- Or, on validation failure, do a one-shot Jira lookup for the key and accept it if it is in any "active" status; record the assignee delta in `analysis.metadata`.

If diagnostics implicate #1 (the common case), no remediation is needed — the warning is the system doing its job.

---

## Files involved

| Layer                | File                                                             | Function / Symbol                            |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| Validator            | `ai-server/src/services/activity-service.js`                     | `validateAnalysisKeys` (L378-395)            |
| Prompt rule          | `ai-server/src/services/activity-service.js`                     | `BATCH_ANALYSIS_SYSTEM_PROMPT` (L80, L190)   |
| Prompt formatter     | `ai-server/src/services/ai/prompts.js`                           | `formatAssignedIssues` (L16-58)              |
| Webhook merge        | `supabase/functions/activity-webhook/index.ts`                   | `serve` handler (L122-213)                   |
| Polling fallback     | `ai-server/src/services/activity-polling-service.js`             | `processSingleBatch` (L182-234)              |
| Polling extractor    | `ai-server/src/services/activity-polling-service.js`             | `extractUserAssignedIssues` (L40-52)         |
| Polling parser       | `ai-server/src/services/activity-polling-service.js`             | `parseUserAssignedIssues` (L19-33)           |
| Desktop JQL          | `python-desktop-app/desktop_app.py`                              | `build_jql_for_tracked_statuses` (L6801)     |
| Desktop fetch        | `python-desktop-app/desktop_app.py`                              | `fetch_jira_issues` (L6891)                  |
| Desktop cache TTL    | `python-desktop-app/desktop_app.py`                              | `issues_cache_ttl = 300` (L4944)             |
| Forge cache writer   | `forge-app/src/services/issue/issueCacheService.js`              | `updateAssignedIssuesCache` (L18)            |
| Forge JQL constant   | `forge-app/src/config/constants.js`                              | `JQL_ACTIVE_STATUSES` (L6)                   |

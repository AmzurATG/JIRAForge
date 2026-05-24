# AI Returned Invalid Task Key — Root Cause Analysis

**Date:** 2026-05-14
**Component:** `ai-server` — Activity batch analysis pipeline
**Severity:** Low (safety net works; records persisted as unassigned, no data corruption)
**Scope:** **Systemic** — 1,926 rejected records across 34 of 37 active users, 331 distinct "wrong" keys, in the last 14 days.
**Triggering log line:**

```
warn: [ActivityService] AI returned invalid task key: ESW-6940
```

This document explains why the warning fires, why it sometimes repeats many times in a single batch, the specific real-world conditions that produced it on 2026-05-14, and the scale of the same pattern across the rest of the user base.

> **TL;DR.** The prompt and the validator use **the same in-memory `userAssignedIssues` array** (no re-fetch, no second DB read), so every rejection is a confirmed case of the LLM returning a key that was not in the list it was given. ~61 % of the time the rejected key is visible on the user's screen in OCR or window title (model is reading a Jira tab the user no longer owns); ~39 % of the time it isn't on screen at all (pure hallucination). The validator nulls the key and demotes the record to unassigned, so worklog sync is never poisoned — but the warning will keep firing as long as users view tickets they're not the current assignee of.

---

## 1. Where the warning originates

[ai-server/src/services/activity-service.js:378-396](../ai-server/src/services/activity-service.js#L378-L396) — `validateAnalysisKeys()`:

```js
function validateAnalysisKeys(analyses, userAssignedIssues) {
  const validKeys = new Set(userAssignedIssues.map(i => i.key));
  for (const analysis of analyses) {
    if (analysis.taskKey && !validKeys.has(analysis.taskKey)) {
      logger.warn(`[ActivityService] AI returned invalid task key: ${analysis.taskKey}`);
      analysis.taskKey = null;
      analysis.confidenceScore = Math.min(analysis.confidenceScore || 0, 0.3);
    }
    ...
  }
}
```

The validator runs once per LLM-returned record, so if the LLM hallucinates the same key across N records in one batch, the warning is emitted N times in the same second.

---

## 2. How `userAssignedIssues` is assembled

The `validKeys` set comes from this pipeline:

1. **Edge function** [`supabase/functions/activity-webhook/index.ts:123-128`](../supabase/functions/activity-webhook/index.ts#L123-L128) fetches the user's issues from `user_jira_issues_cache` (`.eq('user_id', userId)`, ordered by `updated_at`, **limit 50**).
2. **Merged field-level** with any `user_assigned_issues` JSON embedded on the record by the desktop app ([activity-webhook/index.ts:154-211](../supabase/functions/activity-webhook/index.ts#L154-L211)).
3. The merged list is POSTed to `/api/analyze-batch` and reaches `validateAnalysisKeys`.

For records that reach the polling fallback path ([`ai-server/src/services/activity-polling-service.js:193-218`](../ai-server/src/services/activity-polling-service.js#L193-L218)), the embedded `user_assigned_issues` from the record itself is preferred; cache is only used when no record in the batch carries an embedded list.

### Cache population

`user_jira_issues_cache` is populated by [`forge-app/src/services/issueCacheService.js`](../forge-app/src/services/issueCacheService.js) on `avi:jira:updated:issue` events:

```js
const CACHE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
const MAX_ISSUES = 50;
```

So an issue appears in the cache only when:

1. The user is the current assignee in Jira, AND
2. Its `statusCategory` is `To Do` or `In Progress` (not `Done`), AND
3. It falls within the first 50 issues for the user, ordered by recency, AND
4. The cache has been refreshed since the assignment took effect (the trigger only fires on Jira update events).

---

## 3. System prompt rule the LLM disobeyed

[`activity-service.js:80-99`](../ai-server/src/services/activity-service.js#L80-L99) (batch analysis system prompt):

> **CRITICAL RULES:**
> - ONLY use task keys from the user's assigned issues list. NEVER invent or fabricate issue keys from OCR text, window titles, or any other source.

The validator exists because LLMs do not always obey this rule — particularly when the window title or OCR text repeatedly shows a plausible-looking key.

---

## 4. Evidence from the 2026-05-14 incident

The warning fired 6 times for key `ESW-6940` in a single batch at `2026-05-14 13:26:17 UTC`. The following SQL queries (run against the production project `bzdoztgfozxkhkvctvdk` / `jira_forge_prod`) established the facts.

### 4.1 ESW-6940 is a real Jira issue

From an older record's embedded `user_assigned_issues` JSON for user `242dd64b-e322-4712-bd97-98c9998a53f9`:

```json
{
  "key": "ESW-6940",
  "status": "Ready for QA Validation",
  "project": "ESW",
  "summary": "Dashboard - Subscriptions - The Invoice Details is not considering Subscription Fee and Activation Fee",
  "labels": ["FoundQA"]
}
```

### 4.2 Three users in org `a537792d-a5fd-4393-bcd4-f749f8890703` had records referencing ESW-6940 in the prior 7 days

| user_id            | records | ESW-6940 in embedded list | ESW-6940 as `user_assigned_issue_key` | last_seen           |
| ------------------ | ------- | ------------------------- | ------------------------------------- | ------------------- |
| `242dd64b…53f9`    | 333     | 306                       | 4                                     | 2026-05-14 13:31 UTC |
| `5b1c10e4…3715`    | 322     | 289                       | 93 (heaviest)                         | 2026-05-13 12:39 UTC |
| `434f7e9d…dde05`   | 1       | 0 (OCR only)              | 0                                     | 2026-05-11 11:54 UTC |

The fact that ESW-6940 appears in the desktop-embedded `user_assigned_issues` JSON for hundreds of older records proves these users **were assigned** to ESW-6940 at some point.

### 4.3 ESW-6940 is NOT in any of those users' current `user_jira_issues_cache`

```sql
SELECT user_id, COUNT(*) AS cached, MAX(updated_at) AS last_refreshed
FROM user_jira_issues_cache
WHERE user_id IN (
  '242dd64b-e322-4712-bd97-98c9998a53f9',
  '5b1c10e4-3c64-48fa-9585-332b6e603715'
)
GROUP BY user_id;
```

Result: caches were refreshed 3 minutes and 23 minutes before the warning respectively, both contain `Ready for QA Validation` status issues (so the JQL `statusCategory != Done` filter is **not** what's excluding ESW-6940), and neither contains ESW-6940. Jira itself is no longer returning ESW-6940 as an assigned issue for these users.

### 4.4 The exact 8-record batch that triggered the warnings

```sql
SELECT user_id, COUNT(*) AS recs,
       COUNT(*) FILTER (WHERE user_assigned_issues ILIKE '%ESW-6940%') AS embedded_has,
       COUNT(*) FILTER (WHERE window_title ILIKE '%ESW-6940%')          AS title_has,
       COUNT(*) FILTER (WHERE ocr_text ILIKE '%ESW-6940%')              AS ocr_has
FROM activity_records
WHERE analyzed_at BETWEEN '2026-05-14 13:25:00+00' AND '2026-05-14 13:27:00+00'
GROUP BY user_id ORDER BY recs DESC;
```

The batch (user `242dd64b…53f9`, 8 records, first analyzed at `13:26:17.053 UTC`):

| metric | value |
| --- | --- |
| Records with non-empty embedded list | 8 / 8 |
| Records with `ESW-6940` in embedded list | **0 / 8** |
| Records with `ESW-6940` in `window_title` | 1 / 8 |
| Records with `ESW-6940` in `ocr_text` | **4 / 8** |

The user's embedded list contained **23 other ESW issues** (ESW-3528, ESW-6034, ESW-6043, ESW-6054, ESW-6056, ESW-6067, ESW-6304, ESW-6531, ESW-6815, ESW-6840, ESW-6877, ESW-6899, ESW-6920, ESW-6922, ESW-6923, ESW-6924, ESW-6925, ESW-6926, ESW-6945, ESW-6952, ESW-6955, ESW-6956, ESW-5723) — close numerically to ESW-6940 (their other QA tickets), but **ESW-6940 itself was absent**.

---

## 5. Root cause chain

1. User `242dd64b…53f9` **was historically assigned** to ESW-6940 (306 prior records carry it in their embedded list).
2. Some time before `2026-05-14 13:26 UTC`, **Jira removed them as the assignee** of ESW-6940 (or transitioned it into a state the JQL filter excludes — but evidence in §4.3 indicates the simpler "no longer assignee" case, because other "Ready for QA Validation" issues are still in their cache).
3. The desktop app's local issue cache and the Supabase `user_jira_issues_cache` both correctly reflect this — neither lists ESW-6940 for the user any longer.
4. The user, however, **was still actively viewing ESW-6940** (Jira browser tab / Slack link / cross-reference). Its key appeared in 1 window title and 4 OCR captures of the 8-record batch.
5. Gemini-2.0-Flash, seeing `ESW-6940` repeated on screen, **disobeyed the system prompt's CRITICAL RULE** and returned `ESW-6940` as the match for 6 of the 8 records.
6. `validateAnalysisKeys` correctly rejected the key for each of the 6 records → 6 warnings in the same second.
7. The 6 affected records were persisted with `taskKey = null` and `confidenceScore` clamped to `0.3`. The DB layer further demotes anything below `AI_MATCH_MIN_CONFIDENCE` (default `0.4`, see [`activity-service.js:405`](../ai-server/src/services/activity-service.js#L405)). Net effect: those records show as **unassigned** rather than mis-attributed to a ticket the user no longer owns.

---

## 5a. Prompt ↔ validator consistency proof (no re-fetch)

A frequent question: *"if the LLM hallucinates, can't we just trust the model and skip the validator? Or alternatively, isn't the validator using a different / stale list?"*

Neither — the consistency is by construction. From [`ai-server/src/services/activity-service.js:449-484`](../ai-server/src/services/activity-service.js#L449-L484):

```js
async function analyzeBatch(records, userAssignedIssues, userId, organizationId) {
  ...
  const assignedIssuesText = formatAssignedIssues(userAssignedIssues);  // ← prompt uses this
  const userPrompt        = buildBatchAnalysisPrompt(records, assignedIssuesText);
  ...
  // (LLM call here — sees `userPrompt` containing `assignedIssuesText`)
  ...
  validateAnalysisKeys(analyses, userAssignedIssues);                   // ← validator uses SAME var
```

And the validator at [`activity-service.js:378-396`](../ai-server/src/services/activity-service.js#L378-L396):

```js
function validateAnalysisKeys(analyses, userAssignedIssues) {
  const validKeys = new Set(userAssignedIssues.map(i => i.key));        // ← built from same array
  ...
}
```

The `userAssignedIssues` parameter is a single in-memory JavaScript array. It is built **once** by the caller (the activity-webhook for fresh records, the polling service otherwise), passed into `analyzeBatch`, formatted into the prompt, and then handed unchanged to `validateAnalysisKeys`. There is no second Supabase query, no second parse of `activity_records.user_assigned_issues`, no merge step in between. The byte-for-byte identity is what makes the rejection signal meaningful: **the only way the validator can fire is if the LLM returned a key that was not on the menu it was shown.**

What the LLM sees per record (from [`buildBatchAnalysisPrompt`](../ai-server/src/services/activity-service.js#L151-L220)):

| field | source on the record |
| --- | --- |
| `application_name` | `activity_records.application_name` |
| `window_title` | `activity_records.window_title` |
| `total_time_seconds`, `start_time`, `end_time` | record timing fields |
| OCR snippet (1000 chars, sanitized) | `activity_records.ocr_text` after `sanitizeOcrText()` |
| Tracking mode (if present) | `record.metadata.tracking_mode` |

**No screenshots / images are sent** — the pipeline is text-only ([`activity-service.js:8`](../ai-server/src/services/activity-service.js#L8)). The image was OCR'd on the desktop; only the text reaches the AI server.

---

## 5b. Scale across the user base (last 14 days, production)

Even though this document opened with a single incident, the same pattern recurs across the entire user base. Measurement signature: `status = 'analyzed' AND user_assigned_issue_key IS NULL AND metadata.confidenceScore = 0.3 AND metadata.reasoning ~ '[A-Z]+-\d+'` — i.e., a record where the LLM returned a key, the validator rejected it, and the rejection clamp value `0.3` is preserved in metadata.

| metric | value |
| --- | --- |
| Total analyzed records (14 d) | **63,230** |
| Total users with analyzed records | 37 |
| **Records where validator rejected the LLM's key** | **1,926** |
| Distinct "wrong" keys returned | **331** |
| Distinct users affected | **34 of 37** (≈ 92 %) |
| Share of all analyzed records hitting this | **≈ 3.05 %** |

### Two failure modes (split of 1,926 rejections)

Splitting each rejection by whether the exact rejected key appears in the same record's `window_title` or `ocr_text`:

| failure mode | records | share | meaning |
| --- | --- | --- | --- |
| **Mode A — OCR / window-title leakage** | **1,176** | **61.1 %** | Exact rejected key IS on screen. LLM picked it up from on-screen content despite the prompt rule. This is the ESW-6940 pattern. |
| **Mode B — pure hallucination** | **750** | **38.9 %** | Exact rejected key is NOT on screen anywhere. LLM produced it from somewhere else (likely training data, prior-batch context, or by mangling a real key into a wrong number). |

Sub-breakdown of Mode A: 745 in window title, 1,133 in OCR text (overlap).

### Per-user breakdown — top 15 affected

| user_id | rejected | Mode A (on screen) | Mode B (pure halluc.) | distinct keys |
| --- | --- | --- | --- | --- |
| `cdaaa174…fb6` | 204 | 147 (72 %) | 57 | 48 |
| `2ddeb68e…be9` | 191 | 139 (73 %) | 52 | 41 |
| `14b601e8…cfb` | 174 | 128 (74 %) | 46 | 52 |
| `8c59503f…2c2` | 156 | 115 (74 %) | 41 | 38 |
| `4e94135b…b4` | 154 | 128 (83 %) | 26 | 32 |
| `434f7e9d…05` | 111 | 88 (79 %) | 23 | 29 |
| **`8e3483c7…ce5`** | **105** | **12 (11 %)** | **93** | **10** |
| **`3210dc2f…441`** | **92** | **2 (2 %)** | **90** | **2** |
| **`4a42b9cf…694`** | **78** | **7 (9 %)** | **71** | **5** |
| `f029ae9c…fbb` | 68 | 52 (76 %) | 16 | 21 |
| `6b708cef…6d4` | 65 | 62 (95 %) | 3 | 14 |
| `22e6f063…fb` | 60 | 31 (52 %) | 29 | 16 |
| `20d7bde6…26` | 50 | 34 (68 %) | 16 | 17 |
| `b25e7d9b…4d` | 41 | 32 (78 %) | 9 | 17 |
| `7a427737…6d` | 39 | 28 (72 %) | 11 | 15 |

The data clusters into two distinct user populations:

- **Most users** sit at 70–95 % Mode A — heavy QA/review users who routinely look at tickets they're not currently assigned to (the ESW-6940 pattern, exactly).
- **A small group (bolded rows)** sits at 90–98 % Mode B with very few distinct keys (2, 5, 10 across many records) — for these users the LLM keeps producing the **same wrong key** for activity where that key isn't on screen at all. That's a different misbehaviour worth a separate look (likely model latching onto a memorised key for ambiguous generic activity).

### What this means

The "AI returned invalid task key" warning is **noisy, frequent, expected, and the safety net is doing exactly its job**. It's not a single broken ticket or stale cache — it's an inherent disagreement between the prompt's `CRITICAL TASK KEY RULE` and Gemini-2.0-Flash's actual behaviour, repeated thousands of times across the user base. The warning volume scales with:

1. How much QA / review-style work users do (more reading of others' tickets → more Mode A).
2. Baseline LLM noisiness on ambiguous activity (Mode B baseline).

Worklog correctness is preserved (`taskKey` is nulled, confidence clamped to 0.3, falls below `AI_MATCH_MIN_CONFIDENCE = 0.4` so the DB layer records it as unassigned). The cost is purely log noise, not data quality.

---

## 6. Why the safety net works

| Layer | Effect |
| --- | --- |
| Prompt rule (`activity-service.js:97`) | Tells LLM to never fabricate keys. Best-effort, not enforceable. |
| `validateAnalysisKeys` | Rejects fabricated keys against the authoritative assigned-issues list. |
| Confidence demotion to `0.3` | Pushes the record below `AI_MATCH_MIN_CONFIDENCE = 0.4`. |
| DB-layer demotion in `updateActivityRecordAnalysis` | Stores the record as unassigned, preventing downstream worklog sync from acting on it. |

Result: **no record was misattributed to ESW-6940**; the warning is the system reporting that it caught and corrected an LLM hallucination.

---

## 7. Conditions that produce repeats of this warning

Any one of these will cause `validateAnalysisKeys` to reject an LLM-returned key, with the warning multiplied across however many records in the batch share that key:

| Condition | Why the key isn't in `validKeys` |
| --- | --- |
| Issue is not assigned to the user in Jira | JQL `assignee = currentUser()` filter |
| Issue is assigned but `statusCategory = Done` | JQL `statusCategory != Done` filter |
| User has >50 active issues and the key is past position 50 | `MAX_ISSUES = 50` cap |
| Cache is stale (assignment changed but no `avi:jira:updated:issue` event has fired since, or `refreshCacheForUser` failed) | Trigger-driven refresh only |
| User-recently-unassigned key appears in window title / OCR | What happened in this incident |
| Pure LLM hallucination of a plausible-looking key | Prompt disobedience |

---

## 8. Optional mitigations

### 8.1 Deduplicate the warning per batch (low risk, easy)

Modify [`validateAnalysisKeys`](../ai-server/src/services/activity-service.js#L378-L396) so that identical invalid keys within one batch log a single line with a count:

```js
function validateAnalysisKeys(analyses, userAssignedIssues) {
  const validKeys = new Set(userAssignedIssues.map(i => i.key));
  const invalidCounts = new Map();
  for (const analysis of analyses) {
    if (analysis.taskKey && !validKeys.has(analysis.taskKey)) {
      invalidCounts.set(analysis.taskKey, (invalidCounts.get(analysis.taskKey) || 0) + 1);
      analysis.taskKey = null;
      analysis.confidenceScore = Math.min(analysis.confidenceScore || 0, 0.3);
    }
    // ... project key derivation
  }
  for (const [key, count] of invalidCounts) {
    logger.warn(`[ActivityService] AI returned invalid task key: ${key} (×${count})`);
  }
}
```

### 8.2 Investigate cache refresh latency

The `avi:jira:updated:issue` trigger is event-driven. If a Jira admin reassigns or status-transitions an issue without a write that fires the trigger, the cache stays stale. Consider a periodic full-refresh fallback (every N hours per active user) to bound staleness.

### 8.3 Raise the MAX_ISSUES cap for heavy users

[`issueCacheService.js:16`](../forge-app/src/services/issueCacheService.js#L16) caps the per-user list at 50. For QA users with large assignment backlogs, consider raising this — but weigh against LLM prompt size cost.

### 8.4 Surface "user viewing unassigned ticket" as a signal

The combination *(LLM picked a valid-format key + key not in assigned list + key present in OCR/window_title)* is a reliable indicator that the user is actively looking at a ticket they don't own. This could be surfaced in the dashboard ("Activity on tickets you're not assigned to") rather than dropped silently as unassigned.

---

## 9. Related documents

- [`docs/AI_ISSUE_MATCHING_ROOT_CAUSE_ANALYSIS.md`](AI_ISSUE_MATCHING_ROOT_CAUSE_ANALYSIS.md)
- [`docs/WORKLOG_MISATTRIBUTION_ANALYSIS.md`](WORKLOG_MISATTRIBUTION_ANALYSIS.md)
- [`docs/AI_ANALYSIS_FLOW.md`](AI_ANALYSIS_FLOW.md)

## AI Issue Matching — Current State Analysis

### What Has Already Been Fixed

Several root causes documented in the architecture docs are now resolved in the live code:

| Issue | Status | Evidence |
|---|---|---|
| RC1 — Missing `updated` field | ✅ Fixed | desktop_app.py: `'updated': fields.get('updated', '')` present |
| RC4 — 30-issue cap | ✅ Fixed | prompts.js: `.slice(0, 50)` |
| RC7 — ADF paragraph-only parser | ✅ Fixed | desktop_app.py: `extract_text_recursive()` traverses all node types |
| RC8 — `temperature` silently dropped | ✅ Fixed | ai-client.js: `temperature` destructured, defaults to `0.1` |
| RC2 — Forge cache `['In Progress']` hardcode | ✅ Fixed | constants.js: now `statusCategory = "In Progress"` |
| RC6 — Batch size too small | ✅ Fixed | activity-polling-service.js: default is now `60` |

---

### Remaining Bugs (Still Open)

#### Bug 1 — Cross-Batch Session Continuity Never Fires (HIGH impact)

**File:** activity-service.js

`buildBatchAnalysisPrompt` accepts `previousMatchContext` as its third argument and injects a meaningful hint into the prompt. However, `analyzeBatch()` calls it **without that argument**:

```js
// Line 455 — third arg is missing
const userPrompt = buildBatchAnalysisPrompt(records, assignedIssuesText);
```

There is also **no `getRecentMatchForUser()` function** anywhere in activity-db-service.js, and `processSingleBatch()` in the polling service never queries for it. The entire cross-batch continuity feature is wired at the prompt level but dead at the call chain level.

**Impact:** Every 3-minute batch is analysed from zero context. Developers in VS Code for 2 hours get intermittent null records whenever OCR is poor or window titles are generic (e.g. "Untitled - VS Code").

**Fix needed:**
1. Add to activity-db-service.js:
```js
async function getRecentMatchForUser(userId, withinMinutes = 30) {
  const since = new Date(Date.now() - withinMinutes * 60000).toISOString();
  const { data } = await supabase
    .from('activity_records')
    .select('user_assigned_issue_key, metadata, analyzed_at')
    .eq('user_id', userId)
    .not('user_assigned_issue_key', 'is', null)
    .gte('analyzed_at', since)
    .order('analyzed_at', { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  const minutesAgo = Math.round((Date.now() - new Date(row.analyzed_at).getTime()) / 60000);
  return {
    taskKey: row.user_assigned_issue_key,
    confidenceScore: row.metadata?.confidenceScore ?? null,
    minutesAgo
  };
}
```
2. In `processSingleBatch()`, call it and pass result to `analyzeBatch()`.
3. In `analyzeBatch()`, accept and forward it to `buildBatchAnalysisPrompt()`.

---

#### Bug 2 — Stale Embedded Issues Win Over Fresher Cache (HIGH impact)

**File:** activity-polling-service.js

`extractUserAssignedIssues()` returns the **first non-empty `user_assigned_issues`** from the batch records. The cache fallback only fires when that field is null/empty. A record embedded 40 minutes ago (before a PM assigned a new ticket) blocks the cache path permanently, even if the cache is fresher.

```js
function extractUserAssignedIssues(records) {
  for (const record of records) {
    if (!record.user_assigned_issues) continue;
    const parsed = parseUserAssignedIssues(record.user_assigned_issues);
    if (parsed.length > 0) return parsed;  // ← stale embedded list wins
  }
  return [];
}
```

The `user_jira_issues_cache` already stores `updated_at` per issue. The embedded records now include `updated` (RC1 fix). A freshness comparison is possible but not implemented.

**Fix:** After extracting the embedded list, compare the max `updated` timestamp across embedded issues against the cache row's `updated_at`. Prefer whichever is newer.

---

#### Bug 3 — Forge Cache Has No Periodic Refresh (MEDIUM impact)

**File:** manifest.yml

`issueCacheSync` fires only on `avi:jira:updated:issue` — i.e., only when a Jira issue is edited. Users who haven't touched the Forge UI and whose issues haven't changed get a cache that is potentially many hours stale. The `scheduledTrigger` section only contains `worklog-sync-trigger`.

**Fix:** Add a second `scheduledTrigger` entry calling `issueCacheSyncHandler` on a 15–30 minute interval for users with recent activity.

---

### Prompt-Level Gaps (Not Yet Addressed)

#### P1 — Issue Priority Is Fetched but Invisible to the LLM

issueCacheService.js stores `priority`. The `processSingleBatch()` fallback path in activity-polling-service.js maps `priority: issue.priority || null`. But prompts.js `formatAssignedIssues()` never includes it in the formatted text. A "Highest" priority ticket is a strong tiebreaker signal for the LLM.

**Fix:** Add `if (issue.priority) issueText += ` [Priority: ${issue.priority}]`;` in `formatAssignedIssues()`.

#### P2 — No Few-Shot Examples from `ai_accuracy_events`

Every manual user correction is stored in `ai_accuracy_events` (`ai_suggested_issue_key`, `final_issue_key`, `window_title`, `application_name`). Feeding the top 3–5 recurring correction patterns as few-shot examples in the system prompt would create a self-improving loop — but this is not implemented anywhere.

#### P3 — No OCR-Low-Confidence Fallback Instruction

The prompt correctly labels low-quality OCR: `"OCR Text (low confidence - may be inaccurate): ..."`. But there is no corresponding instruction to the LLM to **shift reliance to `window_title` and `application_name`** when OCR confidence is below 0.4. Without explicit guidance, the LLM may still weight garbled OCR text, producing false or low-confidence matches.

**Fix (single prompt line):** Append to the OCR guidance in `buildBatchAnalysisPrompt`: *"When OCR text is marked low confidence, ignore its content entirely and rely on window_title and application_name only."*

#### P4 — `0.4` Confidence Threshold Is Uncalibrated

The threshold at activity-db-service.js controls what gets silently dropped as "unassigned work". The `ai_accuracy_events` table has `ai_confidence_score` alongside the final correct key — querying false-positive rates by bucket (e.g. 0.4–0.5, 0.5–0.6) would reveal whether `0.4` is too aggressive. There's no evidence this has ever been tuned against real data.

---

### Summary — Recommended Fix Order

| Priority | Fix | Files | Impact |
|---|---|---|---|
| 🔴 **High** | Wire cross-batch session continuity: add `getRecentMatchForUser()`, thread through polling → `analyzeBatch()` → prompt | activity-db-service.js, activity-polling-service.js, activity-service.js | Eliminates null records during continuous work sessions |
| 🔴 **High** | Prefer fresher cache over stale embedded issues in `extractUserAssignedIssues()` | activity-polling-service.js | Closes the mid-day assignment gap |
| 🟠 **Medium** | Add scheduled Forge cache refresh (every 15–30 min) | manifest.yml, index.js | Makes the fallback path reliable |
| 🟠 **Medium** | Expose `priority` field in `formatAssignedIssues()` | prompts.js | Stronger tiebreaker signal |
| 🟡 **Low** | Add explicit OCR-low-confidence instruction to prompt | activity-service.js | Reduces false matches on poor OCR |
| 🟡 **Low** | Calibrate `0.4` threshold against `ai_accuracy_events` data | env config / activity-db-service.js | Right-sizes unassigned-work rate |
| 🔵 **Strategic** | Use `ai_accuracy_events` corrections as few-shot examples | activity-service.js prompt | Self-improving accuracy loop |

The two highest-leverage unimplemented features are both in the **same call chain** (session continuity wiring) — fixing them together is a half-day of backend work with measurable reduction in unassigned records. 
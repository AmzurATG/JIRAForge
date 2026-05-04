# Fix: LLM Response Truncation + Silent Data Loss in Activity Analysis

## Problem

Production logs show batches of 20 activity records being sent to the LLM, but only 3 records' analyses being persisted to the database. The other 17 records get marked as "analyzed" without any actual analysis being stored.

Sample log signature:
```
[ActivityService] Batch analysis done | portkey (gemini-2.0-flash) | 20 records
[ActivityService] No closing bracket found, response truncated — attempting salvage
[ActivityService] Salvaged 3 records from truncated JSON response
Activity polling completed: 20 record(s) — all succeeded
```

There are two bugs here. The truncation is the visible one. The silent data loss in the polling layer is the dangerous one.

## Root cause (verified file by file)

### Bug 1 — Output cap is too small for the configured workload

1. `analyzeBatch` sends 20 records per call (default `ACTIVITY_POLLING_BATCH_SIZE=20` from [ai-server/src/services/activity-polling-service.js:131](../ai-server/src/services/activity-polling-service.js#L131)).
2. Each call passes `max_tokens: 8192` ([ai-server/src/services/activity-service.js:427](../ai-server/src/services/activity-service.js#L427)).
3. `chatCompletionWithFallback` forwards this as `max_completion_tokens: 8192` to Portkey ([ai-server/src/services/ai/ai-client.js:185](../ai-server/src/services/ai/ai-client.js#L185)).
4. The output schema includes a freeform `reasoning` field ([ai-server/src/services/activity-service.js:179](../ai-server/src/services/activity-service.js#L179)) labelled "Brief explanation". The model ignores "brief" and writes paragraphs — empirically ~2,700 output tokens per record. 8,192 / 2,700 ≈ 3, matching the observed salvage count.
5. Portkey's saved Config (`pc-jira-857ce9`) primarily routes to Gemini 2.5 Flash (output cap 65,536 tokens, per [Google Cloud docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash)) with gpt-5-mini fallback (output cap 128,000 tokens, per [OpenAI docs](https://developers.openai.com/api/docs/models/gpt-5-mini)). **The 8,192 cap is ours, not the provider's** — it's a stale value from when Gemini 2.0 Flash (8,192 hard cap) was the primary.

The same `max_tokens: 8192` value is repeated at four other call sites — all underused given the current Portkey routing:
- [ai-server/src/services/activity-service.js:478](../ai-server/src/services/activity-service.js#L478) — `classifyUnknownApp`
- [ai-server/src/services/activity-service.js:571](../ai-server/src/services/activity-service.js#L571) — `identifyAppByName`
- [ai-server/src/services/clustering-service.js:229](../ai-server/src/services/clustering-service.js#L229) — `clusterUnassignedWork`
- [ai-server/src/services/feedback-service.js:257](../ai-server/src/services/feedback-service.js#L257) — `analyzeFeedbackWithAI`

### Bug 2 — Silent data loss in the polling layer

1. When the LLM returns a truncated JSON array, `parseAnalysisResponse` calls `salvageTruncatedJsonArray` ([ai-server/src/services/activity-service.js:249](../ai-server/src/services/activity-service.js#L249)) which returns whatever complete records it could extract — 3 of 20 in the production case.
2. `analyzeBatch` returns `{ analyses, recordsProcessed: records.length, ... }` at [ai-server/src/services/activity-service.js:445](../ai-server/src/services/activity-service.js#L445), reporting that **all 20 were processed** even though `analyses.length === 3`.
3. `persistAnalysisResults` ([ai-server/src/services/activity-service.js:368](../ai-server/src/services/activity-service.js#L368)) only updates the rows for records whose `recordIndex` appears in the salvaged `analyses` — so 17 rows are never updated.
4. The polling service marks all 20 records as "claimed" / done because `analyzeBatch` did not throw ([ai-server/src/services/activity-polling-service.js:208-210](../ai-server/src/services/activity-polling-service.js#L208-L210)), and logs `"all succeeded"`.
5. **Net result:** 17 records sit in the DB stamped as analyzed-but-blank. They are never re-tried. Accuracy reports built on these rows are silently wrong.

### Why naive chunking is not the answer

The batch prompt at [ai-server/src/services/activity-service.js:155](../ai-server/src/services/activity-service.js#L155) has an explicit `SESSION CONTINUITY` rule — consecutive records in the same call inherit the matches their predecessors received. Splitting one batch into two LLM calls would break this rule and reduce match accuracy. Any fix must keep the full batch in one call (or pass prior matches as context if a continuation is required).

### Latency / timeout interaction

Gemini 2.5 Flash generates output at ~185 tokens/sec on Google Vertex (per [Artificial Analysis benchmarks](https://artificialanalysis.ai/models/gemini-2-5-flash/providers)). At that rate:
- 8,192 tokens ≈ 44s output time
- 30,000 tokens ≈ 162s output time
- 65,536 tokens ≈ 354s output time

Portkey's `request_timeout` is currently `60000` (60s). Raising `max_tokens` without raising the timeout would just trade truncation for timeouts. **The timeout has to move with `max_tokens`.**

## Industry-standard remedy

- **Inspect `finish_reason`** to detect truncation deterministically ([OpenAI guidance](https://developers.openai.com/api/docs/guides/structured-outputs); same field shape on Gemini via Portkey's OpenAI-compatible endpoint).
- **Right-size the output cap** to the model's real ceiling, leaving headroom inside the request timeout.
- **Tighten the prompt's freeform fields** so output stays predictable and cheap.
- **Re-queue partial work** instead of pretending it succeeded, so the polling cycle gives it another shot.

## Changes

Four code changes in three files, plus one Portkey dashboard change.

---

### Change 1 — Bump Portkey `request_timeout` (Portkey dashboard, not code)

**Where:** Portkey UI → Configs → `pc-jira-857ce9`.

**What:** Change `"request_timeout": 60000` → `"request_timeout": 180000` (3 minutes).

**Why:** Foundational. Without this, raising `max_tokens` is theater — Portkey kills the request before the model finishes generating. 3 minutes leaves 18s of safety margin against the 162s expected for a worst-case 30K-token response.

**Also:** Bump local `AI_REQUEST_TIMEOUT_MS` env var to match (or higher) on the AI server. Default in code is 60s ([ai-server/src/services/ai/ai-client.js:12](../ai-server/src/services/ai/ai-client.js#L12)) — set `AI_REQUEST_TIMEOUT_MS=180000` in the deployed `.env`.

---

### Change 2 — Bump `max_tokens` 8192 → 30000 at all 5 call sites

**Files & lines:**
- [ai-server/src/services/activity-service.js:427](../ai-server/src/services/activity-service.js#L427) — `analyzeBatch`
- [ai-server/src/services/activity-service.js:478](../ai-server/src/services/activity-service.js#L478) — `classifyUnknownApp`
- [ai-server/src/services/activity-service.js:571](../ai-server/src/services/activity-service.js#L571) — `identifyAppByName`
- [ai-server/src/services/clustering-service.js:229](../ai-server/src/services/clustering-service.js#L229) — `clusterUnassignedWork`
- [ai-server/src/services/feedback-service.js:257](../ai-server/src/services/feedback-service.js#L257) — `analyzeFeedbackWithAI`

**What:** Change every `max_tokens: 8192` → `max_tokens: 30000`.

**Why:** 30,000 sits in the sweet spot — ~3.7× headroom over today's worst case (20 records × 2,700 tokens = 54K, but with Change 4 reasoning shrinks ~30×, dropping the worst case to ~3K), comfortably inside the 3-minute timeout, and below both providers' hard caps (Gemini 65,536; gpt-5-mini 128,000) so we never truncate at the model layer.

---

### Change 3 — Detect `finish_reason === 'length'` and stop the silent loss

**File:** `ai-server/src/services/activity-service.js`
**Location:** Inside `analyzeBatch` ([:421-450](../ai-server/src/services/activity-service.js#L421-L450)), after `chatCompletionWithFallback` returns and after `parseAnalysisResponse` produces `analyses`.

**What:**
1. Read `response.choices[0].finish_reason` after the API call.
2. If it equals `'length'`, log a warning with hard numbers: `[ActivityService] Response truncated by max_tokens: salvaged N of M records — N records will be re-queued`.
3. Change the return shape:
   - `recordsProcessed: analyses.length` (the actually-analyzed count, not `records.length`).
   - Add `truncated: finish_reason === 'length'` so the polling service can react.
4. In `activity-polling-service.js` `processSingleBatch` ([:181-212](../ai-server/src/services/activity-polling-service.js#L181-L212)), after `analyzeBatch` returns, identify which `recordIndex` values were *not* covered by `analyses`. For those record IDs, call a new `releaseRecordsToPending(recordIds)` helper in `activityDbService` that flips `status='pending'` and does **not** increment `retry_count` (this isn't a record-level failure; the record never got a fair shot). They'll be picked up on the next poll cycle.

**Why permanent:** Even if Changes 1, 2, 4 were ever undone or a future model change shrinks output budget again, this layer guarantees no record is ever marked done without an actual analysis. The worst failure mode becomes "delayed by 3 minutes," not "silently lost forever."

---

### Change 4 — Tighten the `reasoning` field constraint in the prompt

**File:** `ai-server/src/services/activity-service.js`
**Locations:** `BATCH_ANALYSIS_SYSTEM_PROMPT` ([:80-108](../ai-server/src/services/activity-service.js#L80-L108)) and `buildBatchAnalysisPrompt` output schema ([:172-182](../ai-server/src/services/activity-service.js#L172-L182)).

**What:**
1. In the schema example, replace `"reasoning": "Brief explanation"` with `"reasoning": "≤80 chars, fragment is fine, no narration"`.
2. Add a new section to the system prompt:
   ```
   REASONING FIELD RULES:
   - Maximum 80 characters per record. Hard limit.
   - Use fragments, not sentences. Examples:
     - "Window title shows ABC-123"
     - "VS Code on api/ folder, related to API epic"
     - "Slack DM, no semantic match"
   - Do NOT narrate your thought process. Do NOT restate the rules.
   ```

**Why:** Cuts output tokens ~30× (from ~2,700 per record to ~80) without changing the matching logic. The model still does the same internal reasoning — it's just not asked to write a thesis. Cheaper per call, faster, and makes truncation effectively impossible at any plausible batch size. **Match quality is unchanged** because `taskKey`, `confidenceScore`, and `workType` (the fields that drive downstream behavior) are not touched.

---

## What does NOT need to change

- **`chatCompletionWithFallback` shape** — already returns `response` with `choices[0]` intact.
- **`salvageTruncatedJsonArray`** — keep as-is. With Changes 1+2+4 it should never run; with Change 3 it stays as a last-ditch safety net that converts "broken JSON" into "salvaged what we could + re-queue the rest."
- **Portkey provider list / weights / cb_config / retry rules** — already correct.
- **Polling batch size, polling interval, concurrency** — unaffected.
- **The `SESSION CONTINUITY` rule in the prompt** — preserved (full batch still goes in one call).

## Testing

1. **Unit:** Update `tests/services/activity-service.test.js` for the new `analyzeBatch` return shape (`recordsProcessed: analyses.length`, `truncated: bool`). Add cases for:
   - `finish_reason === 'length'` triggers the truncation branch.
   - `finish_reason === 'stop'` returns `truncated: false`.
   - Salvaged-partial responses report the salvaged count, not the input count.
2. **Unit:** Update `tests/services/activity-polling-service.test.js` to assert that records *not* in the `analyses` list get released back to `pending` without `retry_count` increment.
3. **Manual smoke test:** Run a 20-record batch in dev with the new caps + tightened prompt. Confirm: response completes inside 30s, all 20 records persisted with non-null analysis, log shows `finish_reason: 'stop'`.
4. **Manual truncation test:** Temporarily set `max_tokens: 500` in `analyzeBatch` to force truncation; confirm the truncation warning fires, salvaged records persist, the rest go back to `pending`, and the next poll picks them up.

## Rollback

All four changes are independently revertible:
- Code changes — `git revert` the commit.
- Portkey timeout — flip `request_timeout` back to 60000 in the dashboard.

If only Change 1 is rolled back, Changes 2-4 are safe (you'll just get timeouts instead of truncation, and the truncation-detection layer will re-queue them). If Change 3 is rolled back, the silent-loss bug returns. **Do not roll back Change 3 alone** — it's the layer that makes the rest of the fix permanent.

## Sources

- [Gemini 2.0 Flash docs — 8,192 output cap](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-0-flash)
- [Gemini 2.5 Flash docs — 65,536 output cap](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash)
- [Gemini 2.5 Flash output speed benchmarks](https://artificialanalysis.ai/models/gemini-2-5-flash/providers)
- [GPT-5 mini docs — 128K output cap](https://developers.openai.com/api/docs/models/gpt-5-mini)
- [OpenAI structured outputs — `finish_reason: "length"` is the truncation signal](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Continuation pattern background](https://www.educative.io/answers/how-to-continue-the-incomplete-response-of-openai-api)

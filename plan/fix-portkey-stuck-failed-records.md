# Fix: Activity Records Stuck in `failed` After Portkey Outages

## Problem

When the Portkey AI gateway has even a brief outage, activity records in the `activity_records` table get permanently marked `status='failed'` and never get retried. The only current workaround is to manually edit the database to flip them back to `pending` — which has been required repeatedly. The fix needs to be permanent: no manual DB intervention should ever be needed again, regardless of how long Portkey is down.

## Root cause (verified, line by line)

1. The activity polling cycle runs every 3 minutes by default ([ai-server/src/services/activity-polling-service.js:130](../ai-server/src/services/activity-polling-service.js#L130)).
2. On each cycle, it picks up records where `status='pending' AND retry_count < 3` ([ai-server/src/services/db/activity-db-service.js:22-23](../ai-server/src/services/db/activity-db-service.js#L22-L23)).
3. If `analyzeBatch` throws **any** error — including upstream provider outages like Portkey returning 5xx, "All AI providers failed" thrown by [ai-server/src/services/ai/ai-client.js:593](../ai-server/src/services/ai/ai-client.js#L593), or per-batch timeouts — the catch in `processUserBatches` calls `markBatchFailed` ([ai-server/src/services/activity-polling-service.js:241](../ai-server/src/services/activity-polling-service.js#L241)).
4. `markBatchFailed` increments `retry_count` for every failure type, with no error classification ([ai-server/src/services/db/activity-db-service.js:147](../ai-server/src/services/db/activity-db-service.js#L147)).
5. The moment `retry_count >= 3`, status flips to `'failed'` ([ai-server/src/services/db/activity-db-service.js:148](../ai-server/src/services/db/activity-db-service.js#L148)).
6. The pending query then excludes those records forever (`status='pending'` filter at line 22). No code path anywhere in `ai-server/` resets `failed` records back to `pending` — `resetStuckProcessingRecords` only handles the `processing` state.

**Net result:** A Portkey outage of ~9 minutes (3 attempts × 3-minute polling interval) is enough to permanently fail any record being processed during that window. Portkey's own gateway config (load-balanced Google + OpenAI fallback with `cb_config`) catches *most* upstream issues, but when both lanes return 5xx within Portkey's `request_timeout: 30000`, the failure surfaces to our server and the retry budget gets burned.

## Industry-standard remedy

Production job queues classify errors into:
- **Transient** (network, 429, 500, 503, timeout) → retry indefinitely; do not count against retry budget.
- **Permanent** (validation, parse error, schema violation) → count against retry budget; eventually mark `failed`.

Combined with a periodic dead-letter re-drive sweep so nothing stays stuck forever. Sources: Microsoft Azure transient-fault-handling guidance, Portkey's own retry recommendations, standard job-queue patterns (BullMQ, Temporal).

## Changes

Three changes in `ai-server/src/services/db/activity-db-service.js`, one wiring change in `ai-server/src/services/activity-polling-service.js`, and one one-time SQL backfill.

---

### Change 1 — Classify transient errors in `markBatchFailed`

**File:** `ai-server/src/services/db/activity-db-service.js`
**Location:** Replace the existing `markBatchFailed` function (lines 126-166).

**What:** Inspect the error message before incrementing `retry_count`. If it matches the transient pattern (network errors, gateway timeouts, "All AI providers failed"), set the row back to `status='pending'` **without** incrementing `retry_count`. Only count permanent/unclassified errors against the retry budget.

```js
/**
 * Patterns that identify transient/upstream failures.
 * These are not the record's fault — retrying after the provider recovers
 * will succeed, so we don't burn retry budget on them.
 */
const TRANSIENT_ERROR_PATTERNS = [
  'enotfound',
  'econnrefused',
  'etimedout',
  'econnreset',
  'timeout',
  'timed out',
  'fetch failed',
  'socket hang up',
  'all ai providers failed', // thrown by ai-client.js when every provider is unreachable
  'service unavailable',
  '429',
  '500',
  '502',
  '503',
  '504',
  '408'
];

function isTransientError(errorMessage) {
  if (!errorMessage) return false;
  const lower = String(errorMessage).toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some(p => lower.includes(p));
}

/**
 * Mark records as failed after an analysis attempt.
 * - Transient/upstream errors (Portkey down, network, "All AI providers failed"):
 *   keep status='pending', do NOT increment retry_count. The next polling cycle
 *   will retry once the provider recovers.
 * - Permanent errors (parse, validation, anything else): increment retry_count
 *   and flip to 'failed' once it reaches the cap.
 */
async function markBatchFailed(recordIds, errorMessage) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const transient = isTransientError(errorMessage);

  try {
    const { data: records } = await supabase
      .from('activity_records')
      .select('id, retry_count, metadata')
      .in('id', recordIds);

    if (!records || records.length === 0) return;

    await Promise.all(records.map(record => {
      const currentCount = record.retry_count || 0;
      const retryCount = transient ? currentCount : currentCount + 1;
      const newStatus = !transient && retryCount >= 3 ? 'failed' : 'pending';
      const newMetadata = record.metadata
        ? { ...record.metadata, error: errorMessage, transient }
        : { error: errorMessage, transient };

      return supabase
        .from('activity_records')
        .update({
          status: newStatus,
          retry_count: retryCount,
          metadata: newMetadata,
          updated_at: new Date().toISOString()
        })
        .eq('id', record.id);
    }));

    if (transient) {
      logger.warn(`[ActivityDB] Transient error on ${records.length} record(s), keeping pending without burning retry budget: ${errorMessage}`);
    }
  } catch (err) {
    logger.error('[ActivityDB] Failed to mark batch as failed:', err);
  }
}
```

**Why each pattern is in the list:**

| Pattern | Where it comes from |
|---|---|
| `enotfound`, `econnrefused`, `etimedout`, `econnreset` | Node.js socket errors during outages |
| `timeout`, `timed out` | OpenAI SDK timeout (`AI_REQUEST_TIMEOUT_MS`) and `ACTIVITY_BATCH_TIMEOUT_MS` |
| `fetch failed`, `socket hang up` | undici/Node 18+ network errors |
| `all ai providers failed` | Thrown explicitly by `chatCompletionWithFallback` at [ai-server/src/services/ai/ai-client.js:593](../ai-server/src/services/ai/ai-client.js#L593) |
| `429, 500, 502, 503, 504, 408` | HTTP statuses returned by Portkey when upstream lanes fail (matches Portkey's own default retry codes) |
| `service unavailable` | Generic upstream-down message |

**Safety:** Conservative classifier. Anything not matching one of these patterns still goes through the existing increment-and-cap logic, so unknown error types still get bounded retries.

---

### Change 2 — Add `resetStuckFailedRecords` (dead-letter re-drive)

**File:** `ai-server/src/services/db/activity-db-service.js`
**Location:** After `resetStuckProcessingRecords` (after line 198), before `module.exports`.

**What:** A new function that mirrors `resetStuckProcessingRecords` but acts on `failed` rows. After 30 minutes (configurable), reset them to `pending` with `retry_count=0` so they can be retried.

```js
/**
 * Reset records permanently marked 'failed' if they've been stuck long enough.
 * Acts as a dead-letter re-drive: if a record was marked failed during a Portkey
 * outage and we missed classifying it as transient, this safety net brings it
 * back into the processing pool once the provider has had time to recover.
 *
 * @param {number} minutesThreshold - Minutes a record must have been failed before reset
 */
async function resetStuckFailedRecords(minutesThreshold = 30) {
  const supabase = getClient();
  if (!supabase) return;

  try {
    const threshold = new Date(Date.now() - minutesThreshold * 60 * 1000).toISOString();

    const { data } = await supabase
      .from('activity_records')
      .update({
        status: 'pending',
        retry_count: 0,
        updated_at: new Date().toISOString()
      })
      .eq('status', 'failed')
      .lt('updated_at', threshold)
      .select();

    if (data && data.length > 0) {
      logger.info(`[ActivityDB] Re-queued ${data.length} stuck failed records for retry`);
    }
  } catch (error) {
    if (!isNetworkError(error)) {
      logger.error('[ActivityDB] Error resetting stuck failed records:', error);
    }
  }
}
```

Add `resetStuckFailedRecords` to the `module.exports` block at the bottom of the file.

**Safety:** Same shape as the existing `resetStuckProcessingRecords` (which is already in production). Only touches rows older than the threshold so freshly-failed rows aren't disturbed. Re-processing is idempotent because `updateActivityRecordAnalysis` is keyed on `id` and overwrites — no duplicate side effects.

---

### Change 3 — Call the new reset from the polling cycle

**File:** `ai-server/src/services/activity-polling-service.js`
**Location:** Inside `processPendingRecords`, immediately after the existing call to `resetStuckProcessingRecords` (line 263).

**What:** Add a single line so the dead-letter re-drive runs every polling cycle.

```js
// Existing line:
await activityDbService.resetStuckProcessingRecords(10);

// Add immediately after:
const failedResetMinutes = Number.parseInt(process.env.FAILED_RECORD_RESET_MINUTES || '30', 10);
await activityDbService.resetStuckFailedRecords(failedResetMinutes);
```

**Why an env var:** Lets you tune the threshold without redeploying. Default 30 minutes is longer than Portkey's `cooldown_interval` (1 min) and the AI server's `COOLDOWN_MINUTES=30`, so by the time records re-enter the queue the circuit breakers will have had a chance to recover. No thundering herd into a still-broken provider.

---

### Change 4 — One-time SQL backfill for the existing stuck records

**Where to run:** Supabase SQL editor (production), once, after Changes 1-3 are deployed.

**What:** Clear the existing backlog of stuck records. Capture a backup first so the operation is reversible.

```sql
-- 1. Backup snapshot (reversible if anything goes sideways)
CREATE TABLE IF NOT EXISTS failed_backfill_20260427 AS
  SELECT id, status, retry_count, updated_at, metadata
  FROM activity_records
  WHERE status = 'failed';

-- 2. Re-queue everything currently failed
UPDATE activity_records
SET
  status = 'pending',
  retry_count = 0,
  updated_at = NOW()
WHERE status = 'failed';
```

**Safety:**
- `'pending'` is a valid value for the `status` CHECK constraint defined in [supabase/migrations/20260221_add_activity_records.sql](../supabase/migrations/20260221_add_activity_records.sql).
- Backup table preserves the original state for rollback (`UPDATE … FROM failed_backfill_20260427`).
- Records that are *legitimately* unprocessable will simply re-fail — but with Change 1 in place, transient failures won't put them back into `failed`, so only true permanent errors will hit the cap. Same outcome as their original first run, just with correct classification this time.

---

## Rollout sequence

1. **Deploy code changes** (Changes 1, 2, 3) to the AI server. No DB migration required, no new dependencies.
2. **Verify in logs** that the next polling cycle prints either "Activity polling completed" cleanly or, if Portkey hiccups, the new "Transient error on N record(s)" message instead of marking records failed.
3. **Run the SQL backfill** (Change 4) to clear the existing backlog.
4. **Monitor** for one polling cycle (~3 minutes) — the previously-stuck records should transition from `pending` → `processing` → `analyzed`.

## Rollback

- **Code:** revert the file changes. Behavior returns to today's (immediate retry-budget burn on transient errors).
- **SQL:** restore from the `failed_backfill_20260427` backup table:
  ```sql
  UPDATE activity_records ar
  SET status = b.status, retry_count = b.retry_count, metadata = b.metadata
  FROM failed_backfill_20260427 b
  WHERE ar.id = b.id;
  ```

## Tests to add

- `tests/services/activity-db-service.test.js`:
  - `markBatchFailed` with a transient error message → status stays `pending`, `retry_count` does NOT increment.
  - `markBatchFailed` with a "fake permanent" error message (e.g. `"Invalid JSON in response"`) → existing increment-and-cap behavior.
  - `markBatchFailed` with `"All AI providers failed: …"` → treated as transient.
  - `resetStuckFailedRecords` only touches `status='failed'` rows older than the threshold; leaves fresh failures alone.
- Existing tests at `tests/services/activity-db-service.test.js:372-444` will need updates to use a non-transient error message so the increment-and-cap path is still exercised.

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Misclassified permanent error keeps looping forever | Low | The `TRANSIENT_ERROR_PATTERNS` list is conservative — only well-known transient signals match. Anything else still hits the 3-attempt cap. |
| Re-queued records flood Portkey when it just barely came back | Low | `claimBatchForProcessing` already serializes through the `pending → processing` state machine. Polling batch size (`ACTIVITY_POLLING_BATCH_SIZE=20`) caps throughput per cycle. Portkey's own circuit breaker (`cb_config`) provides upstream protection. |
| Backup table grows unbounded | Negligible | One-time backfill table; drop it once the deployment is confirmed stable: `DROP TABLE failed_backfill_20260427;` |
| Same record re-analyzed produces duplicate Jira worklog | Not possible | `updateActivityRecordAnalysis` is an UPDATE keyed on `id`. Worklog sync reads from the analyzed row — there's still only one row per activity. |

## Files touched

- `ai-server/src/services/db/activity-db-service.js` — Changes 1, 2
- `ai-server/src/services/activity-polling-service.js` — Change 3
- `ai-server/tests/services/activity-db-service.test.js` — test updates
- Supabase production DB — Change 4 (one-time SQL)

No changes to schema, manifest, frontend, desktop app, or Portkey config.

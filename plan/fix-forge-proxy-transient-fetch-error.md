# Fix — Forge Proxy returns 400 for transient Supabase fetch failures

**Date:** 2026-05-11
**Component:** ai-server
**Severity:** User-facing intermittent failure on UnassignedWork list load (and any other resolver routing through the Supabase proxy)

## Problem

When the ai-server's outbound `fetch()` to Supabase REST hits a transient socket-level error (undici `TypeError: fetch failed`, `ECONNRESET`, `socket hang up`, etc.), supabase-js captures the error into the result object as `{ error: { message: 'TypeError: fetch failed' } }`. The Forge proxy controller maps that to **HTTP 400** and returns it to the Forge app.

The Forge app's `remote.js` retry logic recognises `'fetch failed'` and the 5xx range as retryable, but it does **not** retry 400 responses (correctly — 400 normally means a client/query error). So the transient blip is never retried and the user sees the failure.

This was first observed in production at `2026-05-11T14:53:09Z` during `getUnassignedGroups`. Verified end to end:

1. Failing call: `activity_records?id=in.(...)` — only ~19–52 UUIDs (~2 KB URL), well under any URL limit.
2. Forge log: `[Remote] Request failed: 400 {"success":false,"error":"TypeError: fetch failed"}`.
3. ai-server code path: `forge-proxy-controller.js:307` returns 400 because `result.error` is truthy.
4. Forge `remote.js` `isRetryableStatus()` excludes 400 — no retry triggered.

URL length, query shape, and data volume are **not** the cause. The actual cause is a transient outbound-fetch failure from ai-server → Supabase, mis-mapped to a non-retryable status by the proxy.

## Root cause

`forge-proxy-controller.js` treats every supabase-js `result.error` as a client error (HTTP 400). Network-level errors surface through the same channel as legitimate query errors but require different treatment — they are retryable, query errors are not.

## Fix

Detect transient fetch/network errors in `forge-proxy-controller.js` and return **HTTP 503** for those. Real query errors (invalid column, bad cast, RLS denial, etc.) continue to return 400. The Forge app's existing retry logic handles 5xx automatically — no Forge-side changes needed.

### Detection strategy

A small predicate matching the substrings undici/Node surface for socket-level failures:

- `fetch failed`
- `ECONNRESET`
- `ETIMEDOUT`
- `socket hang up`
- `UND_ERR_SOCKET`
- `other side closed`

These are the patterns documented in [nodejs/undici#2400](https://github.com/nodejs/undici/issues/2400), [#1923](https://github.com/nodejs/undici/issues/1923), and [#3492](https://github.com/nodejs/undici/issues/3492).

## Files touched

1. `ai-server/src/controllers/forge-proxy-controller.js` — add `isTransientNetworkError()` helper; use it in the `result.error` branch of `supabaseQuery` to choose 503 vs 400.
2. `ai-server/tests/controllers/forge-proxy-controller.test.js` — add test cases covering both transient (503) and non-transient (400) error mapping.

No changes to the Forge app, no DB changes, no manifest changes, no migration.

## Behavioural change

| Scenario | Before | After |
|---|---|---|
| Real query error (bad column, RLS, cast) | 400 | 400 (unchanged) |
| supabase-js fetch fails with `TypeError: fetch failed` | 400 (user sees failure) | 503 → Forge `remote.js` retries once after 200 ms → succeeds |
| supabase-js fetch ECONNRESET / hang up | 400 (user sees failure) | 503 → retry → succeeds |
| Unknown thrown error in handler | 500 | 500 (unchanged — handled by outer catch, already retryable) |

## Why this is the permanent fix (not a workaround)

- Addresses the actual class of failure (transient network blip) rather than a single symptom (one resolver).
- Covers every resolver that uses the proxy, not just `getUnassignedGroups`.
- Reuses the retry mechanism that already exists in `remote.js` — no duplicate retry logic in two layers.
- Does not depend on undici version, keep-alive timing, or Supabase LB behaviour. Even if a future supabase-js or Node upgrade changes error wording slightly, the fallback (no match → 400 → no retry) degrades exactly to today's behaviour, never worse.

## Out of scope (deliberately not bundled)

- **Undici keep-alive tuning (Option C from the discussion).** Useful but optional; reduces frequency but doesn't make the system *resilient*. Can be added later if telemetry shows the retry rate climbing.
- **Chunking large `IN` clauses.** The data measurement showed no `IN` clause anywhere near a URL limit on this codebase. Not the bug.
- **The `column organizations.jira_host does not exist` errors** observed in Postgres logs. Real bug but unrelated; file separately.

## Verification

- Existing forge-proxy tests pass (no regression on the 400 path).
- New tests assert: `TypeError: fetch failed` → 503, `ECONNRESET` → 503, "column does not exist" → 400.
- Manual: trigger UnassignedWork list reload during a transient outage simulation (e.g. firewall the Supabase host briefly) and confirm the user sees no error and Forge logs show a retry succeeding.

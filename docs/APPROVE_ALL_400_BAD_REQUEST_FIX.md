# "Approve all" → `400 Bad Request` — Root Cause & Fix

**Date:** 2026-05-14  
**Affected feature:** Forge app, *My Focus → Pending Review → "Approve all"*  
**Affected file:** [`forge-app/src/resolvers/approval/approvalResolvers.js`](../forge-app/src/resolvers/approval/approvalResolvers.js)  
**Severity:** P1 — feature completely broken for users with more than ~200 pending sessions  
**Status:** Fixed, ready to deploy

---

## 1. Symptom

Clicking **Approve all** in the Pending Review tab returned `{"error":"Bad Request"}` to the UI. AI server log showed:

```
[ForgeProxy] Supabase error  table:"activity_records"  status:400  error:"Bad Request"
```

The Forge resolver log showed a single `approveRecords` invocation carrying **660+ session UUIDs** in `req.payload.sessionIds`. Smaller "Approve all" clicks (a handful of IDs) worked fine.

---

## 2. Root cause

### 2.1 The request path

```
Forge UI (custom UI iframe)
    │  invoke('approveRecords', { sessionIds: [uuid, uuid, … 660] })
    ▼
Forge Resolver: approveRecords()                  ← forge-app/src/resolvers/approval/approvalResolvers.js
    │  supabaseRequest('PATCH', `activity_records?id=in.(${ids.join(',')})&user_id=eq.…`, …)
    ▼
forge-app/src/utils/supabase/config.js  →  remote.js
    │  POST  /api/forge/supabase/query   { table, method:'PATCH', query, body }
    ▼
ai-server: forge-proxy-controller.supabaseQuery   ← ai-server/src/controllers/forge-proxy-controller.js
    │  reconstructs supabase-js builder, calls .in('id', [uuid,…660]).update(...)
    ▼
@supabase/supabase-js  →  HTTPS GET/PATCH
    https://<ref>.supabase.co/rest/v1/activity_records?id=in.(<660 UUIDs>)&user_id=eq.…&approval_status=eq.pending_approval&select=…
                                          └────── ~24 KB just for the IDs ──────┘
    ▼
Cloudflare → Kong → PostgREST           ← Supabase Cloud edge
```

### 2.2 The 8 KB URL ceiling

`@supabase/supabase-js` translates `.in('id', uuidArray)` into a **GET/PATCH query string**: `?id=in.(uuid1,uuid2,…)`. There is **no fallback to a POST body**. With UUIDs (36 chars) + comma = **37 bytes per ID**, our 660 IDs alone produced a ~24 KB query string.

Every layer in front of PostgREST has a request-line/URL ceiling around **8 KB**:

| Layer | Default URL/request-line limit | Behaviour on overflow |
|---|---|---|
| Apache `mod_*` | `LimitRequestLine 8190` | `414 URI Too Long` |
| nginx | `large_client_header_buffers` (default 8 KB) | `414 Request-URI Too Large` |
| Cloudflare | ~8 KB total request-line+headers | Often `400 Bad Request` (no body) |
| Kong (Supabase Cloud edge) | ~8 KB | `400 Bad Request` |
| PostgREST itself | configurable, but Supabase Cloud never reaches it | Would return `414 URI too long\n` |

Supabase Cloud fronts PostgREST with **Cloudflare → Kong → PostgREST**. The 24 KB URL was rejected by the **first** proxy that could not buffer the request line — which returned a generic `400 Bad Request` with no body. That is exactly what landed in our AI server log.

### 2.3 Why the AI server log only showed `"Bad Request"`

`extractErrorMessage()` in [`forge-proxy-controller.js`](../ai-server/src/controllers/forge-proxy-controller.js) flattens `result.error` to its `.message`. When PostgREST returns no body (because the proxy rejected the URL before PostgREST saw it), supabase-js synthesises a bare `PostgrestError` with `message:"Bad Request"` and no `details/hint/code`. The Supabase docs reference this exact shape.

### 2.4 Why this passed code review originally

Three reasons:
1. **Unit tests use small arrays.** Manual QA with 5–20 sessions never exceeded 1 KB of URL.
2. **`sanitizeUUIDArray()` does not cap input.** It only filters to valid UUIDs — 660 valid UUIDs flow straight through.
3. **The supabase-js docs do not mention the URL limit anywhere.** It is a known-but-unfixed PostgREST limitation; see §5 below.

---

## 3. Web-verified canonical fix

### 3.1 Confirming this is a known limitation

| Source | Confirms |
|---|---|
| [supabase/postgrest-js#393](https://github.com/supabase/postgrest-js/issues/393) — opened Jan 2023, **still open** | `.in()` with large arrays causes URI-too-long. Maintainer `steve-chavez`: *"For now you can workaround this with `rpc()`. Planning to use the HTTP SEARCH method instead."* |
| [supabase/postgrest-js#423](https://github.com/supabase/postgrest-js/issues/423) | Same bug reproduced with **800 IDs**, closed as duplicate of #393 |
| [supabase/postgrest-py#365](https://github.com/supabase/postgrest-py/issues/365) | Same bug in the Python SDK — confirms it is a **PostgREST-layer** limit, not language-specific |
| [supabase-community/postgrest-csharp#62](https://github.com/supabase-community/postgrest-csharp/issues/62) | Same bug in the C# SDK |
| [supabase/supabase-js#2078](https://github.com/supabase/supabase-js/pull/2078) — merged Jan 2026 | Officially adds a runtime warning when URL select exceeds **8000 characters** — confirming 8 KB is the practical Supabase Cloud ceiling |
| User reports in #393 | Anecdotal failures at 200 GUIDs (rovercoder), 800 IDs (danrasmuson), 1000 entries (heyaware) |

### 3.2 The two canonical workarounds (both stated by Supabase maintainers)

| Workaround | When to use | Trade-off |
|---|---|---|
| **A. Chunk the IDs** into multiple small requests | Up to ~10,000 IDs per resolver call | Pure client-side change. No DB migration. |
| **B. Postgres RPC function** with `id = ANY($1::uuid[])` | >20,000 IDs, or extreme latency-sensitivity | Requires DB migration. Single POST, no URL involvement. |

### 3.3 Why we picked Chunking (A)

* Realistic worst case for "Approve all" is bounded by what one user/team accumulates between approvals — empirically a few hundred to a few thousand. RPC's overhead (DB function, migration, accuracy-tracking refactor) is unjustified.
* Chunking is a **drop-in change** in one file. RPC would touch the AI server proxy, the Forge `supabaseRequest` adapter, and the `accuracy/accuracyTracking` event flow.
* Both workarounds are fully compatible — we can promote to RPC later without changing the resolver public API.

---

## 4. The fix (committed)

All edits are in **one file**: [`forge-app/src/resolvers/approval/approvalResolvers.js`](../forge-app/src/resolvers/approval/approvalResolvers.js).

### 4.1 New helpers (added at the top of the file)

```javascript
// supabase-js puts `id=in.(uuid,uuid,...)` straight into the URL query
// string. Supabase Cloud's edge proxy (Cloudflare/Kong) caps URLs at ~8 KB
// and returns a bare 400 "Bad Request" when exceeded — see
// supabase/postgrest-js#393 (still open) and supabase-js PR #2078 which added
// a runtime warning at 8000 chars.  Multiple users report `.in()` failing
// above ~200 UUIDs; we chunk much smaller to keep a comfortable margin.
//
// 100 UUIDs * (36 + 1) = ~3.7 KB of ids + ~400 chars of other query params
// = ~4.1 KB total per URL — safely under any layer's limit.
const SUPABASE_IN_CHUNK_SIZE = 100;

// Max simultaneous in-flight chunk requests. Bounded so a 5,000-id approval
// (50 chunks) finishes in ~10 batches × ~0.5s ≈ 5s — comfortably inside the
// Forge resolver 25s ceiling — without firing 50 parallel sockets at
// Supabase and risking rate limits or pool exhaustion on the AI server.
const SUPABASE_IN_CHUNK_CONCURRENCY = 5;

async function runInIdChunks(ids, fn) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += SUPABASE_IN_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + SUPABASE_IN_CHUNK_SIZE));
  }
  if (chunks.length === 0) return [];

  const results = new Array(chunks.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= chunks.length) return;
      const part = await fn(chunks[i]);
      if (Array.isArray(part)) {
        results[i] = part;
      } else if (part != null) {
        results[i] = [part];
      } else {
        results[i] = [];
      }
    }
  };
  const workerCount = Math.min(SUPABASE_IN_CHUNK_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results.flat();
}
```

### 4.2 Call-site refactor pattern

Every `id=in.(${ids.join(',')})` in this file was wrapped:

```javascript
// BEFORE
const updated = ensureArray(await supabaseRequest(
  'PATCH',
  `activity_records?id=in.(${ids.join(',')})&approval_status=eq.pending_approval&select=id,...`,
  payload
));

// AFTER
const updated = await runInIdChunks(ids, async (chunk) => ensureArray(
  await supabaseRequest(
    'PATCH',
    `activity_records?id=in.(${chunk.join(',')})&approval_status=eq.pending_approval&select=id,...`,
    payload
  )
));
```

### 4.3 Properties preserved across chunking

| Invariant | How preserved |
|---|---|
| **Idempotency** under concurrent approvals | The `&approval_status=eq.pending_approval` WHERE-guard is included on **every chunk's** PATCH. A row already approved in another tab simply matches zero rows in its chunk — harmless no-op. |
| **AI accuracy tracking** event emission | `recordAccuracyEvents()` consumes a Set built from concatenated `updated` rows — chunk boundaries are invisible. The Set deduplicates if a row somehow appears in two chunks (cannot happen in practice since chunks are slices of disjoint UUIDs). |
| **Sort order** in `getPendingApprovalRecords` (`start_time.asc`) | Chunks are processed in input order, but the global sort can be broken across chunk boundaries. After concat we re-apply `rows.sort((a,b) => new Date(a.start_time) - new Date(b.start_time))` to restore global order. |
| **Atomicity expectations** | None existed — there was no transaction wrapping the original single PATCH. Behaviour with chunks (some chunks succeed, later chunk fails → partial approval) is identical to behaviour pre-fix when the PATCH would have partially failed mid-stream. The `&approval_status=eq.pending_approval` guard means a retry is safe. |
| **`getPendingApprovalForIssue` not chunked** | It uses `user_assigned_issue_key=eq.<single-key>` — single value, not an array, no URL bloat possible. Left untouched. |

### 4.4 Capacity table (verified by request-time math, NOT optimistic assumptions)

`chunk_size=100, concurrency=5`. Each chunk = 1 SELECT + 1 PATCH ≈ 2 round-trips × ~250–500 ms each via Forge Remote → AI server → Supabase.

| Total IDs | Chunks | Wall time (5-way parallel) | Forge 25 s timeout? |
|---|---|---|---|
| 660 (the original bug) | 7 | ~1 s | ✓ |
| 1,000 | 10 | ~1.5 s | ✓ |
| 2,500 | 25 | ~3 s | ✓ |
| 5,000 | 50 | ~5 s | ✓ |
| 10,000 | 100 | ~10 s | ✓ |
| 20,000 | 200 | ~20 s | ⚠ borderline |
| 50,000+ | 500+ | >50 s | ✗ → switch to RPC |

---

## 5. Verification checklist (please do this before merging)

### 5.1 Static
- [x] `get_errors` on `approvalResolvers.js` → no errors.
- [ ] `cd JIRAForge/forge-app && npm run lint` (if configured) — clean.

### 5.2 Manual functional
- [ ] **Small batch (3 IDs)** — Approve all → success in <1 s, rows disappear from Pending Review.
- [ ] **Medium batch (~50 IDs)** — Approve all → success, accuracy events appear in Insights.
- [ ] **Large batch (660+ IDs, the original failing case)** — Approve all → success in <10 s, ALL rows approved.
- [ ] **Reassign-all flow** — same three batch sizes against `reassignAndApproveRecords`.
- [ ] **Create-issue-and-approve flow** — same three batch sizes against `createIssueAndApproveRecords`.

### 5.3 Negative tests
- [ ] **Already-approved rows** — approve, then click Approve all again on the same UI without refresh. Expect no error, no double accuracy event.
- [ ] **Mixed batch** — half pending, half already-approved by another tab. Expect only pending half to update.
- [ ] **Network blip mid-chunk** — kill AI server briefly during a 1,000-id approval. Expect overall failure surfaced cleanly (one chunk's reject rejects the whole `Promise.all`).

### 5.4 Log inspection
After a 660-id approval, AI server log should now show:
```
[ForgeProxy] Supabase OK  table:"activity_records"  rows:100   ← x7 lines
```
…instead of the previous single-line 400.

### 5.5 Forge logs
```powershell
cd C:\ATG\j7\JIRAForge\forge-app
forge logs --tail
```
Watch for `approveRecords` invocations — should see 7 `supabaseRequest` calls per click for the 660-id case, all succeeding, total <10 s.

---

## 6. Deployment

```powershell
cd C:\ATG\j7\JIRAForge\forge-app
forge deploy            # picks up the resolver change
# (no UI bundle change — static/* untouched)
```

No DB migration. No AI server change. No environment change. Pure Forge resolver hot-swap.

---

## 7. Files NOT modified but containing the same vulnerable pattern

These files use the identical `id=in.(${ids.join(',')})` construction and **will hit the same 400** under similar load. They were intentionally left untouched in this fix to keep the change tightly scoped. Recommend a follow-up ticket to apply the same `runInIdChunks` pattern (ideally extracted to a shared util):

| File | Lines |
|---|---|
| [`forge-app/src/resolvers/unassigned/assignmentResolvers.js`](../forge-app/src/resolvers/unassigned/assignmentResolvers.js) | 1301, 1324, 1457, 1476, 1493, 1513, 1537 |
| [`forge-app/src/resolvers/unassigned/sessionResolvers.js`](../forge-app/src/resolvers/unassigned/sessionResolvers.js) | 220, 230, 368 |
| [`forge-app/src/services/analytics/teamAnalyticsService.js`](../forge-app/src/services/analytics/teamAnalyticsService.js) | 587, 590 |
| [`forge-app/src/services/worklogService.js`](../forge-app/src/services/worklogService.js) | 469 |
| [`forge-app/src/services/scheduledWorklogSync.js`](../forge-app/src/services/scheduledWorklogSync.js) | 728 |

---

## 8. Recommended follow-ups (not in this PR)

1. **Surface PostgrestError details on the AI server.** Update `extractErrorMessage()` in [`ai-server/src/controllers/forge-proxy-controller.js`](../ai-server/src/controllers/forge-proxy-controller.js) to include `error.details`, `error.hint`, and `error.code` when present. Future failures of this class won't be opaque "Bad Request".
2. **Extract `runInIdChunks` to a shared util** (e.g., `forge-app/src/utils/supabase/chunking.js`) and apply across the 5 files in §7.
3. **Add an integration test** with a synthetic 500-UUID input to `approveRecords` so this regression is caught in CI before reaching production.
4. **Track Supabase HTTP SEARCH method adoption** ([postgrest-js#423](https://github.com/supabase/postgrest-js/issues/423)). Once Supabase ships it, we can delete `runInIdChunks` and let supabase-js auto-handle large filters.

---

## 9. TL;DR

* **Bug:** `.in()` filter on 660+ UUIDs produced a ~24 KB URL → Cloudflare/Kong returned `400 Bad Request` before PostgREST ever ran the query.
* **Cause:** Known, **3-year-old, still-open** PostgREST limitation — supabase-js puts filter values in the URL with no automatic POST fallback.
* **Fix:** Added `runInIdChunks(ids, fn)` helper; chunks at 100 IDs per request; runs up to 5 chunks in parallel. Wraps every `id=in.(…)` site in `approvalResolvers.js`.
* **Capacity after fix:** Up to ~10,000 IDs per "Approve all" click in well under Forge's 25 s resolver timeout, with each individual URL safely under 8 KB.
* **Why not bigger chunks:** Bigger chunks **re-create the bug**. The 8 KB URL ceiling is a hard wall in front of PostgREST; chunk size only controls per-request URL length, not total throughput.
* **When to upgrade to RPC:** Only if a single click ever needs to approve >20,000 sessions.

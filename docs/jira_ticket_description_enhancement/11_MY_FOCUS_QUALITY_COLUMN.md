# Enhancement #11 — Description Quality Column in My Focus

> **Status:** Planning only. No code changes in this commit.
> **Parent spec:** [plan/2026-06-04_forge-app_my-focus-description-quality.md](../../plan/2026-06-04_forge-app_my-focus-description-quality.md)
>
> **2026-06-04 update:** Strategy revised — V1 now does **eager bulk
> analysis on My Focus open** (cache-first read followed by synchronous
> fill of cache misses through the existing analyze pipeline). The earlier
> "per-row Check button" fallback has been removed.

---

## 1. Strategy: Eager Bulk Analysis (Cache-First + Sync Fill)

Every visible row on My Focus must show a description quality score the
moment the page finishes loading. There is no manual "Check" button.

### 1.1 Two-pass load

```
Pass 1 — Cache read   (always, fast, $0)
  → batched read of description_quality_cache for all visible issue keys
  → render badges immediately for cache hits

Pass 2 — Cache fill   (only for cache misses)
  → bulk endpoint runs the existing analyzeDescription pipeline per miss
  → results stream back per-key
  → cells flip from spinner → badge as each key resolves
```

A cell is never idle waiting for a user click. From the user's point of
view:

- **Hit**: badge appears in <300 ms (single round-trip).
- **Miss**: a per-cell spinner shows for the duration of analysis, then
  flips to a badge.

### 1.2 Options Reconsidered

| # | Approach | Cost on page open | UX | Decision |
|---|---|---|---|---|
| A | Manual "Check" button per row | $0 | Quality stays invisible until clicked | **Rejected** — defeats the visibility goal |
| B | Eager analysis ignoring the cache | N × LLM every load | Slow, expensive, redundant | Rejected — wastes spend on unchanged tickets |
| C | **Cache-first read + sync fill of misses** | 1 read + (≤ N) LLM, deduped by content hash | Fast for known tickets, bounded latency for new ones | **Selected** |

### 1.3 Why Option C Stays Affordable

The deterministic scorer (already running inside `analyzeDescription` —
see [descriptionResolvers.js](../../forge-app/src/resolvers/descriptionResolvers.js))
runs first and the LLM is only invoked when the deterministic score < 80
(the existing **LLM Gate** from
[01_ARCHITECTURE.md](./01_ARCHITECTURE.md)). So a typical 30-row My Focus
page with ~70% well-described tickets triggers, in the worst case, ~9
LLM calls — and only on the **first** open per content version. Subsequent
loads are pure cache hits.

The cache key is the SHA-256 content hash, so:

- Unchanged ticket → permanent cache hit, no LLM cost.
- Edited ticket → cache miss, one re-analysis, then cache hit again.

### 1.4 Cost & Latency Budget

| Population | Expected LLM calls per first-time open | Page-ready latency (p95) |
|---|---|---|
| All 30 rows already cached (steady state) | 0 | < 300 ms |
| 30 rows new, ~30% need LLM (rest pass deterministic gate) | ≤ 9 | 4–7 s for last cell to resolve; cache-hit rows visible instantly |
| 30 rows new, ~70% need LLM (worst case) | ≤ 21 | 6–10 s for last cell to resolve |

The worst case is bounded by:

- Per-page hard cap: **50 issues** analyzed per page open. Anything beyond
  page 1 paginates and re-uses the same flow.
- Per-tenant rate limit (existing) on the analyze endpoint.
- Concurrency cap: **5 parallel LLM calls** in the bulk-fill endpoint.
- Hard timeout: **20 s**. Any unresolved keys at the deadline return
  `{ error: "timeout" }` and the cell shows a retry icon.

### 1.5 Why Not Manual "Check" (Option A)

- The current screenshot shows users have no signal at all about
  description quality on this page.
- A "Check" button would only be clicked for tickets the user already
  suspects are poor — exactly the opposite of the discovery goal.
- The scheduler in
  [13_SCHEDULED_QUALITY_NOTIFICATIONS.md](./13_SCHEDULED_QUALITY_NOTIFICATIONS.md)
  cannot replace at-page-load visibility because it only nudges about
  **already-cached** low-quality scores.

## 2. Data Flow

```
My Focus opens
      │
      ▼
DashboardTab.js collects visible issueKeys (page = ≤ 50)
      │
      ▼
invoke('getDescriptionScores', { issueKeys, fillMisses: true })
      │
      ├── Step 1: batched cache read (Supabase)
      │       └── return cache hits immediately (partial response or first chunk)
      │
      └── Step 2: for each cache miss, run analyzeDescription()
              ├── deterministic scoring (free)
              ├── LLM gate: only if deterministic < 80 → call LLM
              ├── write result to description_quality_cache
              └── stream back per-key result
      │
      ▼
Frontend reduces results into rowState[issueKey] = { score, source, status }
      │
      ▼
Render rules:
   score ≥ 80 → green badge
   50–79     → yellow badge + "Improve →" button (see #12)
   < 50      → red badge + "Improve →" button
   pending   → inline spinner
   error     → grey "—" + retry icon
```

## 3. API Contracts

### 3.1 Forge resolver: `getDescriptionScores`

**Request payload**

```json
{ "issueKeys": ["FEEDBACK-87", "FEEDBACK-83"], "fillMisses": true }
```

**Response**

```json
{
  "success": true,
  "scores": {
    "FEEDBACK-87": { "score": 42, "source": "llm",           "cached": true,  "cachedAt": "2026-06-04T10:11:00Z" },
    "FEEDBACK-83": { "score": 86, "source": "deterministic", "cached": false, "cachedAt": "2026-06-04T11:02:14Z" },
    "FEEDBACK-85": { "error": "analysis_failed" }
  },
  "stats": { "cacheHits": 22, "filled": 7, "errors": 1 }
}
```

Constraints:

- `issueKeys.length` capped at **50** (one page). Reject with 400 if exceeded.
- Each key validated via existing `isValidIssueKey`.
- Resolver fetches issue summaries/descriptions only for the cache-miss
  set (Pass 2); only those keys cost a Jira read.
- Resolver must return progressively if the Forge bridge supports
  streaming; otherwise it returns one final response after all misses
  are filled — see §3.3.

### 3.2 ai-server endpoint: `POST /api/forge/description/scores/batch`

- Auth: existing `forgeAuthMiddleware`.
- Tenant scope: `org_id` resolved from FIT context — RLS enforced in SQL.
- Two-stage handling:
  1. SQL read against `description_quality_cache` for all keys.
  2. For cache-miss keys: call existing analyze pipeline (deterministic +
     LLM gate + cache upsert) with **concurrency = 5**.
- Hard timeout: **20 s** total request budget.
- p95 targets:
  - All-hit case: < 300 ms.
  - 50% miss case (15 of 30 keys, ~5 LLM): < 8 s.

### 3.3 Streaming option (recommended at impl time)

If the Forge bridge `invoke()` does not support streaming, use a
two-call pattern:

1. `getDescriptionScores({ issueKeys, fillMisses: false })` — fast cache
   read (~200 ms). Renders badges + spinners.
2. `fillDescriptionScores({ issueKeys: missKeys })` — runs analysis for
   the misses. Returns when complete; for very long fills, the frontend
   may chunk into batches of 10 and update progressively.

Both options satisfy the AC; the choice is an implementation detail.

## 4. UI Specification

### 4.1 Column placement

Existing order: `ID | TITLE | STATUS | PRIORITY | TIME TRACKED`
New order:    `ID | TITLE | STATUS | PRIORITY | QUALITY | TIME TRACKED`

Column width: 140px. Right-aligned content, left-aligned header.

### 4.2 Cell states

| State | Render | Tooltip |
|---|---|---|
| Cache hit, score ≥ 80 | Green pill `82 · Good` | "Last analysed {{relative time}}" |
| Cache hit, 50–79 | Yellow pill `64 · Needs work` + `Improve →` | "Click Improve to enhance with AI" |
| Cache hit, < 50 | Red pill `38 · Poor` + `Improve →` | "Click Improve to enhance with AI" |
| Pass 2 in flight | Inline spinner with caption "Analysing…" | — |
| Pass 2 returned error / timeout | Grey pill `—` + retry icon | "Couldn't analyse — click to retry" |

> **Removed from this revision:** the grey "Check" button. Cells either
> show a badge or a transient analysing state — never an idle button.

Retry icon: clicking re-issues `fillDescriptionScores({ issueKeys: [thisKey] })`
for the single row.

### 4.3 Sorting

Quality column is sortable. Default sort retained (current dashboard
default). When user clicks the header:

- Ascending → worst first (lowest score first; pending/error rows sort to
  the end).
- Descending → best first; pending/error rows still sort to the end.

### 4.4 Filter chip

Add a new filter chip "Low quality only" next to existing
`All Issues / In Progress / Done / Pending Review`. When active, the table
shows only rows whose score is < 80. Pending rows are kept visible during
the initial fill so the filter does not flicker as scores arrive.

### 4.5 Page-level "Re-check all" action

A small text-button above the table:

> Last analysed: 2 minutes ago · **Re-check all**

Clicking "Re-check all" forces a re-analysis of all visible rows,
ignoring the cache. Rate-limited to once per 60 s per user.

## 5. Files (planned — not yet created/changed)

### 5.1 New files

| Path | Purpose |
|---|---|
| `forge-app/src/resolvers/descriptionScoresResolvers.js` | `getDescriptionScores` + `fillDescriptionScores` resolvers; registered in `src/index.js`. |
| `forge-app/static/main/src/components/tabs/QualityCell.js` | Single-row cell component (badge / spinner / error). |
| `forge-app/static/main/src/components/tabs/QualityCell.css` | Styles for pills and spinner. |
| `ai-server/src/controllers/forgeDescriptionScoresController.js` | `POST /api/forge/description/scores/batch` controller (two-stage). |
| `ai-server/src/services/db/descriptionQualityCacheReader.js` | Batched read helper. |
| `ai-server/src/services/descriptionBulkAnalysisService.js` | Bounded-concurrency bulk-fill orchestrator (max 5 in flight). |
| `forge-app/tests/resolvers/descriptionScoresResolvers.test.js` | Resolver tests (cache hit, partial fill, ≤ 50 cap, error propagation). |
| `ai-server/tests/controllers/forgeDescriptionScoresController.test.js` | Endpoint tests. |
| `ai-server/tests/services/descriptionBulkAnalysisService.test.js` | Concurrency, timeout, partial-success tests. |
| `ai-server/tests/services/db/descriptionQualityCacheReader.test.js` | DB helper tests. |
| `forge-app/static/main/src/components/tabs/__tests__/QualityCell.test.js` | Component tests (badge / spinner / error). |

### 5.2 Modified files

| Path | Change |
|---|---|
| `forge-app/src/index.js` | Register new `descriptionScoresResolvers`. |
| `forge-app/static/main/src/components/tabs/DashboardTab.js` | Add Quality column, two-pass fetch on mount, filter chip, sort handler, "Re-check all" button. |
| `forge-app/static/main/src/components/tabs/DashboardTab.css` | Column width, filter chip, "Last analysed" caption styles. |
| `ai-server/src/routes/forge.js` (or equivalent — confirm at impl time) | Mount new controller path. |

> No migration required — `description_quality_cache` already exists
> (see [08_DATABASE_SCHEMA.md](./08_DATABASE_SCHEMA.md)).

## 6. Test Strategy (red tests first, per CLAUDE.md workflow)

| AC | Test type | File |
|---|---|---|
| All rows scored on open | Resolver | `descriptionScoresResolvers.test.js` — given 30 keys (15 cached, 15 missing), assert all 30 returned with score after fill |
| ≤ 50 keys per request | Resolver | Reject 51-key request with 400 |
| Concurrency cap | Service | `descriptionBulkAnalysisService.test.js` — never more than 5 LLM calls in flight |
| Timeout | Service | Mock slow LLM, assert deadline returns `{ error: "timeout" }` for unresolved keys |
| Sort & filter | Component | `DashboardTab.test.js` — score column sort + Low-Quality-Only chip |
| Improve button visibility | Component | `QualityCell.test.js` — only when score < 80 |
| Re-check all | Component + Resolver | Force-bypass cache, throttle 60 s |
| Endpoint | Integration | `forgeDescriptionScoresController.test.js` — auth, RLS, ≤ 50 cap |

## 7. Performance & Cost Budget

| Phase | Network | LLM | Latency |
|---|---|---|---|
| Cache read pass | 1 round-trip → 1 SQL | 0 | < 300 ms p95 (50 keys) |
| Fill pass (worst case) | up to 50 Jira reads + up to 50 LLM calls (capped) | up to 50 (typically far fewer due to deterministic gate) | < 10 s p95 with concurrency 5 |
| Steady state (return visit) | 1 round-trip | 0 | < 300 ms |

Per-tenant safety net: existing rate limiter on the analyze endpoint
applies to bulk fill calls one-by-one.

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| First-time My Focus open is slow for users with many low-quality tickets | Cap visible page at 50 rows; cache-hit rows render in < 300 ms regardless of fill duration; spinners give clear progress feedback |
| Stale cache after description edits | Content-hash cache key — edited tickets miss the cache and are re-scored on next open |
| LLM cost spike if many users open My Focus simultaneously | Per-tenant rate limiter, per-request concurrency cap of 5, and the deterministic gate keep the realistic LLM call rate well below 1 per visible row |
| Page > 50 rows | Pagination — only the visible page is bulk-analyzed |
| LLM provider outage | Per-key error state with retry icon; rest of the page still functional |

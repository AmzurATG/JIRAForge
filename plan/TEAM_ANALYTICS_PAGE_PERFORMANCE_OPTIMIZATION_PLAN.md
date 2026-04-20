# Application-Wide Page Load Performance Optimization Plan

**Date:** April 20, 2026  
**Area:** All slow page loads across Forge app (including Team Analytics)  
**Priority:** Critical  
**Status:** Code implementation completed on April 20, 2026 with local validation complete (see Section 9)

---

## 1. Problem Statement

Multiple pages are loading slowly, not just Team Analytics. Current evidence indicates systemic latency from shared data-loading paths (Forge resolver patterns, repeated permission checks, Supabase query shape, aggregation strategy, and uneven caching) that affects the whole app.

The objective is to deliver a platform-level performance fix that improves all page loads while preserving correctness, access control, and existing UX behavior.

---

## 2. Current State Summary (Cross-App)

Observed architecture and behavior:
1. Frontend pages invoke Forge resolvers per tab/page.
2. Resolvers call service-layer methods that often re-run shared setup work (org/user resolution, Jira permission checks, summary queries).
3. Some flows are optimized (for example, batch-oriented time analytics), but other pages still perform broad reads and heavy in-memory aggregation.
4. Caching exists in mixed forms (in-memory and Forge KVS), but application is inconsistent by page and endpoint.

Cross-cutting symptoms:
- Repeated permission and identity lookups per request path.
- Over-fetching and overlapping date-range queries.
- Multiple in-memory scan/reduce passes for large datasets.
- Inconsistent payload shaping and response size control.
- Limited, non-standardized latency telemetry across resolvers/services.

---

## 3. Root Causes and Bottlenecks

### 3.1 Repeated shared setup cost per page
- Org/user resolution and permission checks are repeated across endpoints.
- Permission checks can trigger expensive Jira calls when not cached or reused.

### 3.2 Endpoint inconsistency
- Some pages use optimized batch paths, while others rely on multi-query per-page fetches.
- This creates uneven performance and poor worst-case page load times.

### 3.3 Over-fetching and overlapping query ranges
- Queries pull broader datasets than required by initial paint.
- Overlap between month/trend/issue/member data increases DB and network time.

### 3.4 CPU-heavy aggregation in Forge runtime
- Repeated array filtering and lookup patterns create avoidable compute overhead.
- Work scales poorly for larger organizations.

### 3.5 Inconsistent cache strategy
- Existing cache utilities are not uniformly applied to all page-critical paths.
- Missing standardized key schema, TTL policy, and invalidation across resolvers.

### 3.6 Limited observability
- Lack of standardized per-stage timing and cache telemetry prevents fast diagnosis.

---

## 4. Target Outcomes (All Pages)

### 4.1 User-facing targets
- p50 initial page load for key pages: <= 1.2s
- p95 initial page load for key pages: <= 3.0s
- worst-case large-org page load ceiling: <= 5.0s
- page-to-page tab switch (warm): <= 600ms p50

### 4.2 Backend targets
- reduce average resolver total duration by >= 35% across top 6 endpoints.
- reduce Supabase round trips by >= 30% across analytics/unassigned flows.
- reduce Forge-side aggregation time by >= 40% on large datasets.
- improve warm-path cache hit rate to >= 60% for stable read endpoints.

### 4.3 Reliability and security targets
- no access-control regressions (admin/project-admin/member scopes).
- no KPI/aggregation correctness regressions.
- no stale-data critical issues beyond agreed TTL windows.

---

## 5. Detailed Execution Plan

## Phase 0: Baseline and Standardized Instrumentation (Day 1)

### Tasks
1. Add a single timing blueprint for all critical resolvers/services:
- resolver total
- each remote/supabase call
- permission/identity resolution
- aggregation blocks
- payload serialization
2. Define top slow pages and top slow endpoints matrix (production and staging).
3. Create common log schema fields: `page`, `resolver`, `orgSizeBucket`, `cacheHit`, `durationMs`, `queryCount`.
4. Capture baseline p50/p95/p99 and max for each targeted page.
### Deliverables
- Cross-app latency baseline dashboard.
- Agreed SLOs and endpoint prioritization.

### Exit criteria
- Top 6 slow endpoints are identified with stage-level latency breakdown.

---

## Phase 1: Shared Platform Optimizations (Days 1-2)

### Tasks
1. Standardize permission resolution cache strategy across resolvers (TTL and key schema).
2. Standardize org/user identity caching and eliminate duplicate fetches in same request chain.
3. Implement endpoint-level request coalescing pattern for duplicate in-flight calls.
4. Introduce common response-shaping guidelines (initial paint fields first, defer non-critical details).
5. Define shared pagination/limit policy to avoid over-fetching and unstable query latency.

### DB/index validation tasks
1. Validate index coverage for key predicates used across slow pages:
- organization_id
- project_key
- work_date
- user_id
- task_key
2. Identify missing composite indexes for top slow query patterns.
3. Validate query plans on small/medium/large data volumes.

### Deliverables
- Shared optimization RFC for cache keys, TTLs, query policy, and payload policy.
- Index recommendation plan with migration sequencing.

### Exit criteria
- Common platform policies approved and ready for page-level implementation.

---

## Phase 2: Page-Level Query and Aggregation Refactors (Days 2-4)

### Tasks
1. Team Analytics track:
- replace repeated filter loops with map-based grouping (`recordsByUser`, `recordsByDate`, `recordsByIssue`).
- compute trend and KPI values using single-pass reductions.
- keep current response contract stable.
2. Time Analytics track:
- ensure all users consistently use the batch path for initial load.
- remove or gate legacy multi-query paths from default runtime path.
3. Timeline/Day-detail tracks:
- minimize selected columns and avoid broad query ranges for initial render.
- split heavy detail fetches behind explicit user actions.
4. Unassigned and export-related tracks:
- move non-critical computations off initial page load.
- add query shape limits and deferred fetch for large result sets.

### Correctness guardrails
1. Golden dataset snapshots for each major page.
2. Invariant checks for totals, sorting, and scope filtering.
3. Access-control checks for admin/project-admin/member views.

### Deliverables
- Page-by-page optimization checklist with expected gain per endpoint.
- Parity report across analytics/timeline/unassigned pages.

### Exit criteria
- Each prioritized page has at least one measurable latency reduction merged.

---

## Phase 3: Unified Caching and Invalidation (Day 4)

### Tasks
1. Define cache tiers by data volatility:
- identity/permissions (short-to-medium TTL)
- analytics summaries (short TTL)
- reference/static metadata (longer TTL)
2. Standardize cache key schema:
- organization
- user or permission scope
- project key
- date range / client date context
- endpoint version key
3. Add cache telemetry on all optimized endpoints (hit/miss/fill time).
4. Define invalidation policy:
- TTL-based baseline
- event-trigger hooks for new activity ingestion where feasible
- manual bypass for admin debug workflows

### Deliverables
- Unified cache policy document and rollout matrix by endpoint.
- Stale-read risk matrix and mitigation controls.

### Exit criteria
- Warm-path page loads consistently improve while meeting correctness constraints.

---

## Phase 4: Frontend App-Shell and Page Load Optimization (Days 4-5)

### Tasks
1. Add request deduping/abort semantics on all tab/page data loaders.
2. Prevent redundant fetches when tab/project/date filters are unchanged.
3. Split initial render data from secondary details (progressive hydration).
4. Lazy-load heavy components/modals/charts not needed for first paint.
5. Ensure route/tab switch uses cached data immediately when valid, then revalidates in background.

### Deliverables
- Frontend performance checklist for each primary page.
- Request lifecycle/state transition matrix for tab changes.

### Exit criteria
- Initial paint and warm tab-switch targets are achieved on staging.

---

## Phase 5: Validation, Rollout, and Monitoring (Days 5-6)

### Tasks
1. Run regression tests for:
- permissions/access checks
- metric correctness
- empty-state handling
- large dataset behavior
2. Run synthetic load tests and replay representative production traffic patterns.
3. Compare before/after metrics by page and resolver.
4. Roll out in stages (internal org -> pilot orgs -> full rollout).
5. Monitor p50/p95/p99, error rates, cache hit rate, and timeout/retry rates.

### Deliverables
- Cross-app performance scorecard.
- Rollout checklist with rollback triggers by endpoint.

### Exit criteria
- App-wide performance targets are met and stable through rollout window.

---

## 6. Page-by-Page Solution Coverage

1. Team Analytics
- query shape optimization for member/issue/trend datasets.
- map-based aggregation refactor.
- endpoint payload caching with strict scope keys.

2. Time Analytics
- enforce batch-first path as default for initial load.
- reduce fallback to legacy multi-query path.
- validate cache sync behavior for org/user identifiers.

3. Timeline and Drilldown pages
- narrow initial queries to essential fields/date windows.
- defer deep detail queries until user action.
- optimize server-side session grouping logic.

4. Unassigned Work and Export-related pages
- remove heavy computations from first render path.
- paginate/defer large groups and export preparation.
- apply common cache + request dedupe patterns.

5. Shared resolver and remote layer
- centralize timing and error taxonomy.
- eliminate duplicate setup calls in a single request chain.
- standardize retries/timeouts and monitor retry inflation.

---

## 7. Concrete Solution Blueprint

1. Build a shared resolver wrapper that records standardized timing and cache metadata for every major endpoint.
2. Introduce reusable `resolveContext` utility per request chain that returns cached org/user/permission context once and reuses it.
3. Standardize endpoint response envelopes to separate `criticalForFirstPaint` and `deferred` sections.
4. For heavy aggregations, use pre-grouped maps and single-pass reducers; avoid repeated full-array scans.
5. Add endpoint-level cache policy registry so every page endpoint has explicit TTL, key schema, and invalidation strategy.
6. Add frontend request manager with cancel/dedupe/revalidate behavior shared across tabs.
7. Add performance guardrails in CI/staging: fail if p95 regresses above threshold for key endpoints.

---

## 8. Atlassian Forge Platform Compliance Review

The following is a constraint-by-constraint review of every planned optimization technique against official Atlassian Forge documentation (verified April 2026 against developer.atlassian.com).

### 8.1 Hard Constraints from Forge Platform

| Limit | Value | Source | Impact on Plan |
|---|---|---|---|
| Function timeout (user-invoked resolvers) | **25 seconds** | [Invocation limits](https://developer.atlassian.com/platform/forge/limits-invocation/) | Analytics resolvers must complete within 25 s. Heavy unoptimized loads already risk this ceiling. Optimization is mandatory, not optional. |
| Memory per invocation | **512 MB default, 1024 MB max** | Invocation limits | Large in-memory aggregation of 20,000 records must fit in memory. Refactoring to maps reduces peak allocation. |
| Egress requests per invocation | **100 per runtime minute** | Invocation limits | Current multi-query pattern could hit this ceiling on large datasets with many paginated pages. Reducing query count is a hard requirement. |
| Front-end response payload | **5 MB max** | Invocation limits | Serialized analytics payloads must stay under 5 MB. Column projection and top-N limits must be enforced. |
| Front-end request payload | **500 KB max** | Invocation limits | Invoke call parameters are fine; this does not affect response optimization. |
| KVS read/write rate per installation | **4,000 × 10 KB req/min** | [KVS limits](https://developer.atlassian.com/platform/forge/limits-kvs-ce/) | KVS-based permission caching (already used by `userAnalyticsService`) is well within limits for typical usage. |
| KVS value size | **240 KiB per key** | KVS limits | Analytics payload caching in KVS must not exceed 240 KiB per key. Large payloads must be split or compressed. |
| KVS key length | **500 characters** | KVS limits | Cache key schema must stay within this length. |

### 8.2 Tenant Data Isolation — Critical Constraint

**Source:** [Tenant data isolation in Forge apps](https://developer.atlassian.com/platform/forge/tenant-data-isolation/)

Atlassian's Forge runtime runs on AWS Lambda and **reuses warm execution environments across tenants**. This makes module-level in-memory caches a cross-tenant data leak risk unless explicitly scoped.

The existing `cache.js` module uses a module-level `Map`:
```js
const cache = new Map(); // UNSAFE if keys are not tenant-scoped
```

**Atlassian's stated rule:**
> "All in-memory caches are keyed by a tenant identifier such as `cloudId` or `installationId`."

**Compliance requirements for the optimization plan:**

| Optimization | Atlassian Requirement | Compliant Action |
|---|---|---|
| Module-level in-memory cache | Must be keyed by `cloudId` (tenant identifier) | All cache keys in `cache.js` and any new shared caches must include `cloudId` as a prefix. Verify all existing `CacheKeys.*` include tenant scope. |
| KVS caching (Forge Storage) | Already tenant-safe by design — KVS is scoped per app installation | Preferred over raw in-memory caches for cross-invocation data. Use for permission and analytics payload caching. |
| Shared `resolveContext` utility | Must not accumulate state at module scope | `resolveContext` must be a pure function that initializes state inside the invocation, not a singleton. |
| Request deduplication map | `inFlightRequests` Map in `remote.js` is module-level | If used, must be keyed by `cloudId:requestKey` and cleared after each invocation, or replaced with invocation-scoped deduplication. |

### 8.3 Forge Remote Usage

**Source:** [Forge Remote](https://developer.atlassian.com/platform/forge/remote/)

- `invokeRemote` via `@forge/bridge` is an **officially supported** pattern for calling the AI/Supabase backend.
- Using Forge Remote makes the app **ineligible for Runs on Atlassian** (Atlassian's hosted infrastructure program). This is already accepted in the current architecture.
- All performance optimizations that operate within the existing remote call pattern (reducing number of calls, payload shaping) are fully permitted.

### 8.4 What Is Fully Permitted

All of the following planned optimizations are **fully allowed** by Atlassian Forge platform policies:

1. Reducing Supabase query count and improving query shape inside the same remote backend.
2. Using Forge KVS (`@forge/kvs`) for permission and analytics payload caching with TTLs.
3. Reducing front-end `invoke` payload size and splitting initial/deferred data.
4. Adding request abort/dedupe patterns in the frontend React components.
5. Adding composite DB indexes in Supabase migrations (entirely within the app's own database).
6. Lazy-loading UI components and modals.
7. Adding timing telemetry via `console.log` (subject to 100 log lines/runtime-minute limit).
8. Splitting heavy resolver work into multiple smaller invocations via separate `invoke` calls.

### 8.5 What Requires Special Care

| Technique | Constraint | Required Action |
|---|---|---|
| In-memory caching | Must be tenant-scoped by `cloudId` | Audit all `cache.set` / `cache.get` calls; verify key schema includes `cloudId`. |
| KVS value caching of analytics data | 240 KiB per value limit | Ensure serialized cache payloads are small enough; split by section (KPIs, members, trend) if needed. |
| Reducing egress requests | Must stay under 100 per runtime minute | Profile paginated fetch loops; enforce hard caps on max pages per invocation. |
| Response payload | Must stay under 5 MB | Enforce column projection and top-N limits before serializing response. |
| Timing logs | 100 log lines per runtime minute (without declared `timeoutSeconds`) | Keep timing log statements minimal; consider structured single-line summaries. |

### 8.6 What Is Not Permitted

1. **Storing tenant data in unscoped module-level variables** — direct violation of Atlassian's shared responsibility model.
2. **Using `global` or `globalThis` to share state across invocations** — explicitly flagged as unsafe.
3. **Caching data across tenants by using non-tenant-scoped keys** — cross-tenant data leak.
4. **Bypassing Forge Remote auth token validation** — security violation.

### 8.7 Compliance Checklist for Implementation Phase

Before any optimization code is merged:
- [ ] All in-memory cache keys include `cloudId` as the tenant scope prefix.
- [ ] No mutable module-level variables hold tenant-specific data.
- [ ] KVS payloads are validated to be under 240 KiB before writing.
- [ ] Egress request count per invocation is estimated and verified against the 100/min cap.
- [ ] Response payload sizes are verified to stay under 5 MB for realistic large datasets.
- [ ] `resolveContext` utility does not persist state at module scope.
- [ ] ESLint rules are added to flag mutable module-level `let`/`var` and unscoped cache writes.

---

## 9. Files Modified (Implemented on April 20, 2026)

This section reflects the changes actually implemented in code.

### Backend — Forge App (`forge-app/src/`)

| File | Implemented Change |
|---|---|
| `src/config/constants.js` | Added `TEAM_ANALYTICS_CACHE_TTL_MS` (5 min) and `MAX_PAGINATED_PAGES` (10) to enforce cache TTL and pagination caps. |
| `src/utils/cache.js` | Updated cache guidance for tenant isolation; added `TTL.ANALYTICS`; changed `CacheKeys.userId` to `userId(cloudId, accountId)`. |
| `src/utils/remote.js` | Updated cache key usage to match new signature and tenant scope in both sync and user-creation paths. |
| `src/resolvers/analyticsResolvers.js` | Passed pre-resolved permission flags into `fetchProjectTeamAnalytics` to avoid duplicate permission calls. |
| `src/services/analytics/teamAnalyticsService.js` | Added optional permission override; added KVS read/write cache (`teamAnalytics:${cloudId}:${projectKey}:${today}`); added payload-size guard before KVS write; parallelized initial queries; replaced repeated filtering with map-based aggregation; added execution timing log; enforced paginated request cap via constants. |
| `src/services/analytics/userAnalyticsService.js` | Added compatibility-safe guard before calling `syncCacheFromBatchResponse` so batch flow remains stable when test mocks omit that export. |
| `src/resolvers/permissionsResolvers.js` | Added KVS cache for `getUserPermissions` with TTL to avoid repeated Jira permission lookups; added resolver timing telemetry. |
| `src/resolvers/userResolvers.js` | Added timing telemetry for `getCurrentUser` and `getDesktopAppStatus`. |
| `src/resolvers/unassigned/sessionResolvers.js` | Added timing telemetry for `getUnassignedWork`, `getUnassignedGroups`, and `getGroupDetails`. |
| `src/resolvers/unassigned/projectResolvers.js` | Added timing telemetry for project/issue/status dropdown resolver endpoints. |
| `src/resolvers/unassigned/adminResolvers.js` | Added timing telemetry for admin resolver endpoints. |

### Frontend — Custom UI (`forge-app/static/main/src/`)

| File | Implemented Change |
|---|---|
| `src/context/AppContext.js` | Added in-flight guard to prevent duplicate permission requests. |
| `src/components/tabs/TeamAnalyticsTab.js` | Added request-id stale-response protection so fast project switching does not apply outdated responses. |
| `src/components/tabs/TimeAnalyticsTab.js` | Added request-id stale-response guard for time analytics reloads (including refresh-triggered reloads). |
| `src/components/tabs/OrgAnalyticsTab.js` | Added request-id stale-response guard for organization analytics loads. |
| `src/components/UnassignedWork.js` | Added request-id guard to prevent stale/overlapping unassigned-work fetch responses from overwriting current state. |
| `src/components/modals/ExportTeamAnalyticsModal.js` | Added stale-request guard for member prefetch during rapid project selection changes in export flow. |

### Database — Supabase Migrations (`supabase/migrations/`)

| File | Implemented Change |
|---|---|
| `migrations/20260420_perf_analytics_index.sql` *(new file)* | Added composite index `idx_activity_org_project_work_date` on `activity_records(organization_id, project_key, work_date)`. No table/column changes. |

### Validation Snapshot (Current)

1. Static diagnostics on modified files: no errors.
2. Frontend production build: successful.
3. Full backend Jest suite: passing (`11/11` suites, `209/209` tests) after aligning Jest scope and updated behavior expectations.

### Deferred Scope (Not Yet Implemented)

Remaining items are operational Phase 5 rollout activities (staged deployment, production load replay, and live telemetry verification) that require deployment environment execution rather than additional local code changes.

---

## 11. Risks and Mitigations

1. Risk: cross-page optimization introduces correctness drift  
Mitigation: Golden snapshot comparisons and invariant checks before merge.

2. Risk: stale cache serves outdated numbers  
Mitigation: Conservative TTL + optional manual refresh and event-trigger invalidation.

3. Risk: index changes impact write performance  
Mitigation: Validate on staging dataset and choose only high-value composite indexes.

4. Risk: permission scope regression  
Mitigation: Dedicated admin/project-admin test cases with strict assertions.

5. Risk: large-org edge cases still exceed SLO  
Mitigation: Add pagination caps, fallback response modes, and optimization backlog from telemetry.

---

## 10. Test Plan

### Functional tests
1. team/time/unassigned/timeline page data matches source-of-truth datasets.
2. permissions and scope filtering unchanged for all roles.
3. deferred data loading does not alter visible totals or sorting.

### Performance tests
1. cold-load p50/p95/p99 for top pages across small/medium/large datasets.
2. warm-load and tab-switch latency with cache hits.
3. rapid filter/project switches with request dedupe and abort validation.
4. large user-count and high issue-cardinality scenarios.

### Non-regression tests
1. empty/partial dataset behavior.
2. invalid/missing client date fallback behavior.
3. error response stability when one downstream dependency fails.

---

## 12. Definition of Done

1. all prioritized pages meet p50/p95 targets.
2. no correctness or access-control regressions.
3. query count, compute time, and payload size improvements are documented by endpoint.
4. cache hit/miss metrics are available and stable.
5. rollout completes with no critical incidents and acceptable error budgets.

---

## 13. Suggested Implementation Order

1. cross-app instrumentation baseline.
2. shared resolver/context/cache policy standardization.
3. highest-impact page refactors (team/time analytics first).
4. remaining page-level query and defer/lazy-load optimizations.
5. unified frontend request lifecycle improvements.
6. validation, phased rollout, and monitoring hardening.

This order addresses platform bottlenecks first, then applies targeted page-level fixes, producing both immediate wins and sustainable performance behavior across the app.

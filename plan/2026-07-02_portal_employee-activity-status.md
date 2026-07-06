# Portal — Employee Activity Status (live presence on the Employees page)

**Date:** 2026-07-02
**Component:** Portal (ai-server/src/portal) + ai-server + supabase migration
**Scope decision (user-confirmed):** Employees page only. No Dashboard widget, no
alerts/emails, no desktop-app heartbeat change.

## Problem

Admins cannot tell who is NOT working today. The Employees page is built from
`portal_employee_summary`, whose `HAVING count(*) FILTER (WHERE is_idle <> true) > 0`
drops every user with no non-idle activity in the selected range — inactive people
are not rows, so the only way to spot them is to remember names and notice absence.
Verified in prod (2026-07-02): 66 users exist, only 42 appear for "Today".
The existing "Last Activity" column renders date-only (`toLocaleDateString()`), so
"20 minutes ago" and "9 hours ago" are indistinguishable.

## Root cause / context (verified in prod `bzdoztgfozxkhkvctvdk`, 2026-07-02)

- Freshest liveness signal: `activity_records` — desktop uploads batches every 5 min
  (`batch_upload_interval = 300`, desktop_app.py:6528). Measured upload lag today:
  median 4.1 min, p90 5.4 min, p99 37 min (offline catch-up).
- `users.desktop_last_heartbeat` is sent every 4 HOURS (desktop_app.py:12455),
  despite its column comment claiming 5 min — unusable for 2–3 h windows
  (prod now: 42 users active <2 h by activity vs only 15 by heartbeat).
- `users.last_sync_at`: dead column, 0 of 66 populated.
- `work_date` = user-LOCAL calendar date (set by desktop; 100% of last-30-day rows
  match `start_time AT TIME ZONE user_timezone`; all current users IST).
- Covering index `idx_activity_portal_analytics (work_date, user_id) INCLUDE
  (duration_seconds, classification, is_idle, start_time, application_name)` is
  applied and valid in prod → presence queries are index-only and cheap.
- 6 of 66 users have never produced a single activity record; 0 NULL `is_idle`
  rows in the last 30 days; 0 idle-only users today.

## Proposed solution

### 1. New SQL function (migration `20260702_portal_employee_presence.sql`)

`portal_employee_presence(p_today date, p_user_ids uuid[] default null)` →
`(user_id, name, email, last_active_at, active_today, ever_tracked)`.

- Base set: `public.users WHERE is_active = true` (LEFT JOIN pattern — nobody hidden),
  optionally narrowed by `p_user_ids` (same LOB-scoping contract as the other RPCs).
- `last_active_at` = `max(start_time) FILTER (WHERE is_idle <> true)` over
  `work_date BETWEEN p_today - 7 AND p_today` (one aggregate pass over the covering
  index; older than 7 days reads as NULL → "inactive 7+ days").
- `active_today` = has a non-idle row with `work_date = p_today`.
- `ever_tracked` = any `activity_records` row ever (per-user index seek).
- NULL-idle parity: keep `is_idle <> true` (NULL rows counted nowhere), matching
  `portal_employee_summary`.
- No org filter — matches the existing cross-org behavior of the other portal RPCs.
- Dashboard-paste-safe: plain `CREATE OR REPLACE FUNCTION`, single statement, no
  CONCURRENTLY. **User applies the SQL** (hard rule: code never writes to the DB).

### 2. ai-server merge (`portal-service.getEmployees`)

- Call `portal_employee_presence` in parallel with the (unchanged)
  `portal_employee_summary`; `p_today` comes from a new optional `today=YYYY-MM-DD`
  query param (viewer's local date, computed by the frontend exactly like the
  existing date presets) falling back to the server's local date.
- Attach to every row: `lastActivityAt` (now LIVE presence, no longer range-bound),
  `activeToday`, `everTracked`.
- Users returned by presence but absent from the summary are appended with zero
  hours / 0% productivity — this is the feature: inactive people become visible.
- New filter `activityStatus` (applied in Node, like search/productivityRange):
  - `active`      — lastActivityAt within 15 min of now
  - `away`        — older than 15 min, within 2 h
  - `inactive2h`  — older than 2 h, or none in 7 days
  - `inactive3h`  — older than 3 h, or none in 7 days
  - `nottoday`    — activeToday = false
  - `never`       — everTracked = false
- `productivityRange` semantics preserved: it only ever matches summary-backed rows
  (zero-hour presence rows are excluded from high/medium/low, exactly as before).
- Degrade gracefully: if the presence RPC errors (e.g. migration not applied yet),
  log a warning and return the summary-only list with presence fields null —
  deploy order (code before SQL) must not break the page.
- Presence is **opt-in** via `filters.includePresence`, set only by the
  `/api/portal/employees` controller. `portal-reports-controller`'s Employee
  Summary report reuses `getEmployees` directly — without the flag it must get
  the byte-identical pre-presence result (no zero-hour rows, no new fields, no
  presence RPC call), so existing report output does not change.

### 3. Portal frontend (EmployeesPage)

- "Last Activity" column → status dot + relative time, computed client-side from
  the raw fields: 🟢 Active (≤15 min) · 🟡 Away (15 min–2 h) · 🔴 Inactive
  ("3h ago" / "Not active today" / "Inactive 7+ days") · ⚪ Never tracked.
  Falls back to the old date rendering when presence fields are absent (degraded mode).
- New "Activity Status" dropdown filter (All / Active now / Away / Inactive > 2h /
  Inactive > 3h / Not active today / Never tracked) wired to `activityStatus`.
- New `timeAgo()` helper in `utils/formatters.js`.
- Page sends `today` (local date) with every employees request.

## Acceptance criteria

1. **AC1 — RPC call & mapping:** `getEmployees` calls `portal_employee_presence`
   with `{ p_today, p_user_ids }` (array when LOB-scoped, null otherwise) and each
   returned employee row carries `lastActivityAt`, `activeToday`, `everTracked`
   from the presence result.
2. **AC2 — inactive users visible:** a user present in presence but absent from
   the summary appears in the list with 0 hours, 0% productivity, and their
   presence fields set.
3. **AC3 — activityStatus filter:** each of the six values filters per the
   definitions above (boundary: exactly-15-min → away, not active; null
   lastActivityAt matches inactive2h/inactive3h).
4. **AC4 — productivityRange unchanged:** zero-hour presence-only rows never match
   high/medium/low.
5. **AC5 — empty scope short-circuit:** `visibleUserIds = []` returns empty
   without any RPC call (including presence).
6. **AC6 — graceful degrade:** presence RPC error → list still returns from the
   summary alone; presence fields null; no throw.
7. **AC7 — UI (manual + lint):** status dot + relative label renders per bucket;
   filter narrows the table; page passes `npm run lint`.
8. **AC8 — reports parity:** `getEmployees` WITHOUT `includePresence` never calls
   the presence RPC, appends no rows, and adds no presence fields — the Employee
   Summary report's output is unchanged.

## Out of scope

- Dashboard widget / card (user chose Employees page only).
- Any email/notification on inactivity (notification service already has its own).
- Desktop heartbeat interval fix (4 h → 5 min) — separate future phase.
- Auto-refresh/polling of presence; data refreshes on load & filter change only.
- Org-scoping changes; the RPC mirrors existing cross-org + LOB behavior.
- EmployeeDetailPage; `portal_employee_summary` and all other RPCs unchanged.

## Test plan

Jest (ai-server) `tests/services/portal-service-presence.test.js` mapped 1:1 to
AC1–AC6, committed red first (presence merge not yet implemented). AC7 manual +
ESLint. SQL verified read-only in prod after user applies (EXPLAIN + spot-check
counts: expect 66 rows, 42 active_today as of 2026-07-02).

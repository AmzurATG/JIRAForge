# Web Productivity Portal — Holidays, Legal Hours & Category Percentages

- **Date:** 2026-06-23
- **Components:** `ai-server` (portal backend + React frontend), `supabase` (new migration)
- **Requested by:** Manager (relayed by user)
- **Status:** Spec — awaiting approval + final holiday list before implementation

---

## 1. Problem

The manager asked for three related changes to the web productivity portal:

1. **Category percentages in reports.** Remove the single **Productivity %** column and instead
   show each activity category — Productive, **Unknown**, Idle, Non-Productive — as a percentage,
   displayed **beside the hours in the same column** (e.g. `5.0h (62%)`).
2. **Read holidays.** The portal has no concept of company holidays, so a holiday currently looks
   like an empty / 0%-productive workday and is not excluded from any "expected hours" maths.
3. **Legal hours on the monthly report.** The Employee Summary report (which over a one-month
   range is "the monthly report") should display **legal hours** = the expected working hours for
   the period, derived from working days **minus holidays**.

The manager also wants admins to **add the holiday list inside the portal** (UI modelled on the
"Holidays 2026" calendar panel they shared) so it is easy to maintain.

## 2. Context / current state (verified)

- **Taxonomy (WS-C):** `productive` / `non_productive` / `neutral` / `idle`. The manager's
  **"Unknown" is exactly the existing "Neutral" category** (private / unclassified / unknown / NULL,
  non-idle). See `ai-server/src/portal/src/components/common/CategoryBadge.jsx` and `CategoryLegend.jsx`.
- **Productivity %** is currently `productive ÷ (productive + non_productive)`, computed in
  `ai-server/src/services/portal-service.js` (`getEmployees`, `getEmployeeDetail`, `getDashboardData`)
  and surfaced by the reports controller.
- **Employee Summary report columns today** (`portal-reports-controller.js`): Employee, Email,
  Productive Hours, Non-Productive Hours, Total Hours, **Productivity %**, Location/Branch,
  Neutral Hours, Idle Hours — for CSV, Excel, PDF and the on-screen preview.
- **No holiday/leave feature exists anywhere in the repo** — this is greenfield. The screenshot is a
  design reference, not an existing data source.
- **Existing pattern to mirror:** `portal_locations` + the "Employee Branches" card in
  `SettingsPage.jsx` — a portal-owned, company-wide, superadmin-managed list using the service-role
  key (authorization enforced in ai-server code; RLS `service_role` policy is defense-in-depth).
- **DB hard rule:** migrations are authored as `.sql` files; the **user applies them**. This plan
  never applies a migration or mutates the database.

## 3. Decisions (confirmed by manager via user)

| Topic | Decision |
|-------|----------|
| % display | Keep hours, show `% beside hours in the same column` (`5.0h (62%)`); remove standalone Productivity %. |
| % denominator | Each category ÷ **total tracked time** (Productive + Non-Productive + Unknown + Idle); the four sum to 100%. |
| "Neutral" wording | Relabel to **"Unknown"** in the report columns. |
| Holiday scope | **Global, company-wide** (one list for everyone). |
| Leaves | **Out of scope** for now (holidays only). |
| Standard hours/day | **9 hours**. |
| Working week | **Mon–Fri** (Sat/Sun non-working). |
| Legal hours placement | **Employee Summary report** (add Legal Hours, Tracked Hours, Attainment %). |

### Author's defaults for two under-specified points (change if desired)
- **"Tracked Hours"** (for attainment) = **Active Time** = Productive + Non-Productive + Unknown
  (i.e. time at the machine **excluding Idle**). Attainment % = `Tracked ÷ Legal × 100`.
- **Hours/day (9)** implemented as an env-overridable constant `PORTAL_LEGAL_HOURS_PER_DAY`
  (default `9`) rather than hard-coded, so it can change without a deploy.

## 4. Proposed solution

### 4.1 Database — new migration (user applies)
`supabase/migrations/20260623_portal_holidays.sql`
- Table `public.portal_holidays`:
  - `id uuid pk default gen_random_uuid()`
  - `holiday_date date NOT NULL` with `UNIQUE (holiday_date)` (global ⇒ one row per date)
  - `name text NOT NULL`
  - `is_active boolean NOT NULL default true`
  - `created_by uuid REFERENCES portal_admin_users(id) ON DELETE SET NULL`
  - `created_at`, `updated_at timestamptz` (+ `updated_at` trigger, matching repo convention)
  - Company-wide (**no `org_id`**), same rationale as `portal_locations`.
  - RLS enabled + `service_role` policy (defense-in-depth); index on `holiday_date`.
- Seed migration (separate file) `20260623_seed_portal_holidays_2026.sql` — the 10 holidays visible
  in the manager's screenshot, **pending confirmation of the official list**:
  2026‑01‑01 New Year · 01‑15 Pongal/Makar Sankranti · 01‑26 Republic Day · 03‑03 Holi ·
  03‑19 Ugadi · 03‑20 Ramzan Id/Eid‑ul‑Fitar · 09‑14 Ganesh Chaturthi · 10‑02 Gandhi Jayanti ·
  10‑20 Vijaya Dashami · 12‑25 Christmas.

### 4.2 Backend (ai-server)
- `services/db/portal-holiday-db-service.js` — CRUD over `portal_holidays` (list, listByYear, getByDate, create, update, delete).
- `services/portal-holiday-service.js` — validation (dup date → 409), plus the work-calendar maths:
  - `WORK_DAYS = [Mon..Fri]`, `HOURS_PER_DAY = Number(process.env.PORTAL_LEGAL_HOURS_PER_DAY) || 9`.
  - `countWorkingDays(from, to)` = weekdays in `[from,to]` minus active holiday dates in range.
  - `legalHours(from, to)` = `countWorkingDays(from,to) × HOURS_PER_DAY`.
- `controllers/portal-holiday-controller.js` — `getHolidays` (any portal user), `create/update/delete`
  (superadmin only) — mirrors `portal-employee-profile-controller.js` locations handlers.
- Routes in `index.js` under the existing portal block:
  - `GET    /api/portal/holidays` (any user, optional `?year=`)
  - `POST   /api/portal/holidays` (superadmin)
  - `PUT    /api/portal/holidays/:id` (superadmin)
  - `DELETE /api/portal/holidays/:id` (superadmin)
- **Reports controller** (`portal-reports-controller.js`):
  - `employee-summary` rows gain `trackedHours`, `legalHours`, `attainmentPct`. `legalHours` is one
    value for the selected range (company-wide); `attainmentPct` is per employee.
  - `employee-summary` and `daily-summary` rows gain per-category percentages
    (`productivePct`, `nonProductivePct`, `unknownPct`, `idlePct`) = category ÷ total tracked.
  - Remove `productivityPercentage` from `employee-summary` and `daily-summary` (CSV/Excel/PDF/preview),
    relabel **Neutral → Unknown**, and render each category cell as `Xh (YY%)`.

### 4.3 Frontend (ai-server/src/portal)
- New **Holidays** page `pages/HolidaysPage.jsx` + route `/holidays`, **superadmin-only**, styled like
  the screenshot (year navigator, cards with month chip + day number + name + weekday). Add a
  Sidebar entry (superadmin only). `api/holidays.js` client.
- **ReportsPage.jsx** column definitions for `employee-summary` / `daily-summary`: render
  `hours (pct%)` per category, drop the Productivity % column, add Legal/Tracked/Attainment to
  `employee-summary`, rename Neutral → Unknown.

## 5. Acceptance criteria

1. `20260623_portal_holidays.sql` creates `portal_holidays` with RLS + `service_role` policy +
   `updated_at` trigger + unique `holiday_date`; re-runnable (`IF NOT EXISTS` / `DROP POLICY IF EXISTS`).
2. `GET /api/portal/holidays` returns active holidays (optionally filtered by `?year=`) for any
   authenticated portal user.
3. `POST/PUT/DELETE /api/portal/holidays` are superadmin-only (403 otherwise); a duplicate
   `holiday_date` returns 409.
4. The Holidays admin page lists holidays sorted by date (month chip + day + name + weekday) and
   supports add / edit / delete; it is visible only to superadmin.
5. Employee Summary report: each category column shows `hours (pct%)`; the four percentages sum to
   100% (±rounding); the standalone Productivity % column is removed; "Neutral" reads "Unknown".
6. Daily Summary report: same per-category `hours (pct%)` treatment; Productivity % removed.
7. Employee Summary report adds **Legal Hours**, **Tracked Hours**, **Attainment %**, where
   `Legal Hours = (Mon–Fri days in range − active holidays in range) × 9` and
   `Attainment % = Tracked ÷ Legal × 100`.
8. CSV, Excel and PDF exports of Employee Summary and Daily Summary reflect the new columns
   (and drop Productivity %).
9. The working-day count excludes Sat/Sun and active holiday dates within the selected range
   (unit-tested across a month containing ≥1 holiday and a weekend).

## 6. Out of scope
- Per-employee leaves; per-branch / per-LOB holiday scoping.
- Dashboard KPI cards / donut chart, the Employees list page, Time Logs.
- Forge app and desktop app (no changes).

## 7. Open items (need from user before/at implementation)
- **Final official 2026 holiday list** (can proceed by seeding the 10 from the screenshot meanwhile).
- Confirm **Tracked Hours = Active Time (excludes Idle)** for attainment, and that **9h** may be an
  env-overridable constant.

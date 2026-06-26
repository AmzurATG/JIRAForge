# Web Productivity Portal — Per-User Day Timeline

- **Date:** 2026-06-26
- **Component:** ai-server (portal frontend only — no backend/schema change)
- **Status:** Draft spec — pending sign-off on the decisions in §7
- **Related:** `EmployeeDetailPage.jsx`, `portal-service.getTimeLogs`

---

## 1. Problem

The Employee Detail page shows a user's day only as a **paginated table** of activity
rows and a multi-day bar/line chart. There's no way to *see the shape of a single day* —
when the person was active, on what, and where productive vs non-productive vs idle vs
untracked time fell across the clock.

We want a **per-user, per-day timeline**: a horizontal time track for a day, with the
user's activity laid out chronologically and color-coded by category.

## 2. Context (verified in code, not assumed)

- **Best home = Employee Detail page** (`/employees/:userId`, [EmployeeDetailPage.jsx](../ai-server/src/portal/src/pages/EmployeeDetailPage.jsx)). It is already scoped to one user, already has a date picker defaulting to **Today** (a single day — the timeline's natural unit), and already loads that user's activity logs.
- **Data already exists.** `portal-service.getTimeLogs` returns, per record: `startTime`, `endTime`, `durationSeconds`, canonical `category` (`productive | non-productive | neutral | idle`), `application`, `windowTitle`. The employee-scoped endpoint `GET /api/portal/employees/:userId/logs` ([portal-controller.js:203](../ai-server/src/controllers/portal-controller.js#L203)) reuses `getTimeLogs`, accepts `limit`, and **already enforces LOB scope**. So no new backend or schema is needed.
- **Conventions exist.** Category colors are standardized (`#10b981` productive, `#ef4444` non-productive, `#64748b` neutral/unknown, `#9ca3af` idle) in [DailyLineChart.jsx](../ai-server/src/portal/src/components/charts/DailyLineChart.jsx); `CategoryBadge`/`CategoryLegend` already encode the taxonomy.

## 3. Proposed solution

Add a **Timeline ⇄ Table toggle to the existing "Activity Logs" section** of the Employee
Detail page. *Table* = today's `DataTable` (unchanged). *Timeline* = a new visual day track.

### 3.1 The DayTimeline component (new, frontend-only)
- New `components/charts/DayTimeline.jsx`. For each **day** in the selected range, render one
  horizontal track spanning that day's active window (first activity → last activity, padded
  to the hour) with a time axis.
- The day is **one continuous bar** spanning the **active window (first activity → last
  activity, hour-padded)** — no empty 00:00→first or last→24:00 padding, so it's dense.
- Consecutive records of the **same category are coalesced into a single block** (bridging
  sub-threshold gaps), so the bar reads as a few meaningful colored runs
  (productive → non-productive → idle → …) — **not** a fence of per-capture session tiles.
  Color changes only at category boundaries; a **real untracked gap** (beyond a small
  threshold) breaks the bar (empty track, distinct from idle's solid gray).
- Blocks are **keyed by run identity** (run-start + category) and positioned with
  `left%`/`width%` over the active-window span; width/left changes **ease via CSS transition**
  so the bar grows smoothly with no remount/blink (see §3.5).
- Hovering a block shows its category, time span, total duration, and the apps within the run.
- **Hover tooltip** per segment: application, window title, start–end (local), duration,
  category. Reuse the standard category colors + `CategoryBadge` styling.
- A small inline legend (reuse `CategoryLegend`).
- The segment math lives in a **pure exported helper** `buildDayTracks(records, range)` →
  `[{ date, startMs, endMs, segments: [{ leftPct, widthPct, category, ...record }] }]`, so
  the positioning logic is isolated and unit-testable later.

### 3.2 Data fetch
- The timeline needs the **whole day**, not the 10-row page. When the Timeline view is active,
  fetch via the existing `employeesApi.getLogs(userId, { from, to, limit: 2000 })` (single
  page, high limit) — **no classification filter** (the timeline always shows all categories;
  the category tabs apply to the Table view only).
- For a single user/day this is comfortably within one request. (See §7 for the very-long-day
  cap consideration.)

### 3.3 Multi-day & empty handling
- Range = 1 day (the default "Today") → one track.
- Range > 1 day → **one labelled track per day** (date heading per lane).
- If the range spans more than **31 days**, show a hint to narrow rather than rendering dozens
  of tracks (keeps the fetch and DOM bounded).
- A day with no records → "No activity tracked for this day."

### 3.5 Silent live refresh (no loading UI)

When the selected range includes **today** and the tab is **visible**, the timeline
**silently background-polls** (~60s) and the new activity simply extends the track — **no
spinner, no loading/rounding icon, no blink or flicker**. Mechanics:

- **Initial load** may use the page's normal spinner; **background refreshes never set the
  loading state** — the current timeline stays on screen and new data merges in underneath it.
- **Run-keyed blocks + CSS transitions** (§3.1): as new activity arrives the **latest run
  simply extends to the right** (or a new colored block starts on a category change); the
  active-window scale eases smoothly so earlier blocks adjust without any blink or remount. No
  spinner ever shows on a background refresh.
- Polling is **paused** when the tab is hidden (`document.visibilitychange`) and **off** when
  the range is entirely in the past (past days don't change).
- A small **manual "Refresh"** affordance is still available but not required.

**Honest limit:** the track only grows as fast as data arrives — capture → batch upload → AI
classification is **minutes-scale**, and a just-arrived segment may show as "Unknown" until
classified, then settle to its real color. Visually seamless, but "near-live (≈1–2 min)", not
per-second. No UI technique can beat the pipeline.

### 3.4 What does NOT change
- The Table view, KPIs, daily trend chart, date picker, and all backend code are untouched.
- No new route, endpoint, table, or migration.

## 4. Acceptance criteria

1. The Employee Detail "Activity Logs" section shows a **Timeline | Table** toggle; Table is
   the current `DataTable`, unchanged.
2. Timeline renders the selected user's activity for **each day in range** as a horizontal
   track; segments are positioned by `startTime`/`endTime` and filled by `category` color
   (productive/non-productive/unknown/idle).
3. **Untracked gaps** render as empty track, visually distinct from idle.
4. Hovering a segment shows application, window title, start–end, duration, and category.
5. The timeline shows **all categories** regardless of the table's classification tab, and
   fetches the full day (high-limit single fetch), not the 10-row page.
6. Range > 1 day → one labelled track per day; range > 31 days → a "narrow the range" hint.
7. A day with no activity shows an explicit empty-state message.
8. **No backend/schema/route change**; the existing LOB-scoped logs endpoint is reused; no writes.
9. `buildDayTracks` is a pure function (no DOM/network) returning positioned segments per day.

## 5. Verification

The portal has **no frontend test runner** (`package.json` scripts are `dev`/`build`/`preview`/
`lint` only) and this feature touches **no backend**, so there are no Jest tests to add.
Verification is:
- `npm run build` (portal) succeeds.
- Visual check on the Employee Detail page (Today, a multi-day range, and an empty day) — via
  the `/verify` or `/run` flow or a screenshot.
- `buildDayTracks` is written pure/exported so a frontend test harness (e.g. vitest) could
  cover it later if we add one — out of scope here.

## 6. Out of scope (candidate later)

- A multi-user "everyone's day" timeline on the Time Logs page.
- Click-a-segment-to-filter-the-table interaction; zoom/pan.
- Page-walking the fetch for extreme high-frequency days (see §7).
- Any backend aggregation/dedicated timeline endpoint.

## 7. Decisions

1. **Live refresh — RESOLVED: silent background poll.** When the range includes today and the
   tab is visible, poll ~60s and extend the track with **no loading UI** (see §3.5). Past-only
   ranges don't poll. (Decision 2026-06-26.)
2. **Axis & rendering — RESOLVED: trim to active window + single merged bar.** Each track spans
   first→last activity (hour-padded), rendered as one continuous bar with consecutive
   same-category time merged into single blocks (not per-session tiles). Silent growth stays
   smooth via run-keyed blocks + CSS transitions (§3.1/§3.5), so trimming to the active window
   does not cause a jarring reflow. (Decision 2026-06-26.)
3. **Default view** — open the Activity Logs section on **Timeline** (page defaults to Today)
   or keep **Table**? *Proposed: Timeline.* (Still open — low stakes.)
4. **Very long / high-frequency day** — single high-limit fetch for v1; page-walk only if a day
   can exceed the per-request cap. *Proposed: single fetch, note the cap.*

## 8. Files to change

- **New:** `ai-server/src/portal/src/components/charts/DayTimeline.jsx` (component + `buildDayTracks` helper).
- **Edit:** `ai-server/src/portal/src/pages/EmployeeDetailPage.jsx` — add the Timeline/Table toggle, the timeline fetch, and render `DayTimeline`.
- (Reuse existing `employeesApi.getLogs`, `CategoryLegend`, formatters, category colors — no new API/CSS system.)

## 9. Implementation order

1. Sign off §7 decisions.
2. Build `DayTimeline.jsx` + `buildDayTracks` (pure helper first).
3. Wire the toggle + full-day fetch into `EmployeeDetailPage`.
4. `npm run build` + visual check (Today / multi-day / empty day).

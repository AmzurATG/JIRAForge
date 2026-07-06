# Portal — Employee timeline revamp (comparable days, honest boundaries, paged range)

**Date:** 2026-07-03
**Component:** Portal (`DayTimeline`, `EmployeeDetailPage`) + ai-server (`getTimeLogs` select)
**Supersedes the display rules of:** `plan/2026-06-26_web-productivity-portal_employee-day-timeline.md`
(the single-day visual language — merged runs, hover tooltip, untracked stripes — is kept).

## Problems (verified 2026-07-03, code + prod/dev data)

1. **Days are visually incomparable.** Each day-bar's axis is trimmed to its own
   first→last activity (DayTimeline.jsx:85-87), so a 4-minute day (observed:
   Mon Jun 22, 08:27–08:31 PM) renders as a full-width solid bar identical to a
   13-hour day. A glance reads 4 minutes as a full productive day.
2. **Cross-midnight bleed.** Grouping is by viewer-local date of `start_time`;
   a run extending past midnight stretches the previous day's bar into the next
   morning (observed: "Thu Jul 2" bar spanning 08:31 PM – 09:44 AM), overlapping
   the next row's hours. Three different "day" definitions coexist on the page
   (viewer-local here, `work_date` in the cards/chart, UTC in the range filter).
3. **Silent truncation.** The timeline fetches the whole range in ONE request,
   `limit: 5000`, newest-first (EmployeeDetailPage.jsx:64; server hard-cap 10000,
   portal-service.js:775). Prod example: 90-day range = 5,837 rows → the oldest
   ~4½ days silently vanish and the boundary day renders partial, with no
   indication. The `MAX_DAYS=31` "+N more days" note is computed from the
   truncated set, so it can be absent exactly when data is missing.
4. **31 stacked bars is the wrong tool for a quarter.** The daily chart above
   already serves the long-range view.

## Solution

### 1. ai-server — expose day identity on log rows
`getTimeLogs` selects and maps two more columns: `work_date` → `workDate`,
`user_timezone` → `userTimezone`. Purely additive to the response shape.

### 2. DayTimeline — truthful, comparable day tracks
- **Split at midnight:** merged runs are cut at each midnight of the record's
  `userTimezone` (fallback: viewer TZ), pieces keyed by the local date they fall
  in (equals `work_date` for normal records — desktop sets work_date from the
  local start date). A day-bar never contains another day's hours.
- **Shared axis:** all displayed bars use ONE minutes-of-day window —
  `[floor(earliest start), ceil(latest end)]` hour-snapped across the visible
  days, minimum span 4 h. Equal width = equal duration on every row; a 4-minute
  day is now a sliver on a mostly-striped (untracked) track.
- Per-day header keeps the true active window text ("08:27 PM – 08:31 PM");
  hover/tooltip/legend/live-extend behavior preserved.

### 3. EmployeeDetailPage — page the range by tracked days
- Day index = `employeeDetail.dailyTrend` dates (one per `work_date` with data,
  idle-only days included), newest first, chunked 7 per page.
- Timeline fetches ONLY the visible chunk (`from/to` = chunk bounds ±1 day to
  cover midnight spill; client keeps tracks whose date is in the chunk). A week
  of one user ≈ ≤2k rows — far under every cap; no silent loss.
- Pager (only when >7 tracked days): "‹ Newer · Days 1–7 of 22 · Older ›".
- Defensive truncation banner if a fetch still returns `limit` rows.
- 60-second live refresh only on page 0 when the range includes today.

## Acceptance criteria

1. **AC1 (server):** `getTimeLogs` rows carry `workDate` and `userTimezone`
   (Jest, red first).
2. **AC2 (split):** a run crossing local midnight renders as two pieces on two
   consecutive day-bars; no bar spans hours belonging to another calendar day.
3. **AC3 (shared axis):** all visible bars share one axis window; equal pixel
   width = equal duration across rows; minimum window 4 h.
4. **AC4 (pager):** >7 tracked days → pager appears; each page fetches only its
   chunk; ≤7 days → no pager, single fetch.
5. **AC5 (no silent loss):** a fetch returning `limit` rows shows a visible
   truncation notice.
6. **AC6 (parity):** tooltips, untracked gaps, category colors, live refresh on
   the newest page — unchanged behavior.
7. **AC7 (hover/paint consistency):** the desktop can write activity records
   that OVERLAP an idle block (verified in dev+prod; e.g. idle 11:25–11:31
   "containing" productive 11:28–11:31 — reported from the Vercel deployment
   2026-07-03). Overlaps are resolved by clipping so pieces never stack, and
   hover resolves the topmost painted run — the tooltip always matches the
   pixels. **Clip direction — IDLE WINS** (revised 2026-07-03, supersedes the
   first activity-wins cut of this AC): the idle span is input-authoritative
   (anchor = last real input, resume = next real input), so the overlapped
   "activity" is phantom input-less focus time. Root-cause + data fixes live in
   plan/2026-07-03_python-desktop-app_idle-activity-overlap-c5.md (C5–C7).

AC2–AC6 are frontend-only; the portal has no JS test runner (lint config absent,
no vitest/jest) — verified by `npm run build` + manual walkthrough, consistent
with prior portal specs.

## Out of scope
- The overnight ~10 h "productive" run observed on Jul 2 (possible inflated
  duration record — cousin of the idle lock-flap bug) — data investigation, not
  a rendering concern.
- TimeLogsPage/table view (unchanged; extra response fields are ignored there).
- The duplicate-user merge (own spec, same date).

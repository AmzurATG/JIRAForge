# C5–C7: Idle-vs-Activity Overlap — phantom work time recorded during no-input windows

**Date:** 2026-07-03
**Component:** python-desktop-app (`desktop_app.py`) — primary; supabase (trigger migration) — defense; portal timeline — consistency
**Continues:** `2026-06-30_multi-component_fix-idle-overcount-lock-flap.md` (C1–C4, deployed in v1.4.10 — working; this covers the overlap class that plan's §6 left out of scope).

## 1. Problem (verified 2026-07-03, dev DB + code, v1.4.10 data)

Idle records overlap ACTIVITY records. Observed for user `5265d5b1…` on 2026-07-03
(five cases in one morning, e.g. idle `11:25:48–11:31:51 IST` containing productive
Code.exe `11:27:57–11:30:49`; ~18 min double-counted in ~1.5 h). Both rows count in
SUM-based analytics (Employees/Dashboard/Reports), and "productive" time is
credited for minutes with provably zero input.

## 2. Root cause (code-verified, no assumptions)

The idle span is **input-authoritative**: anchor = last real input
(`last_activity_time`, backdated at [desktop_app.py:11834](../python-desktop-app/desktop_app.py#L11834)),
resume = next real input. Under the C1–C3 state machine there is **no input inside
an idle span**. But three things still record "work" inside it:

1. **The current session's final timer segment.** `enter_idle` calls
   `session_manager.stop_current_timer()` with **no `end_time`**
   ([:11825](../python-desktop-app/desktop_app.py#L11825)) → the segment is banked
   up to the idle-DETECTION moment (anchor + `idle_timeout` = up to 5 min of
   no-input wall time), and `last_seen` = detection moment. The suspend path
   already does this right (`stop_current_timer(end_time=pre_suspend_iso)`,
   [:12704](../python-desktop-app/desktop_app.py#L12704)); the screenshots-table
   path also already trims to last input (`_finalize_active_session`,
   [:11745](../python-desktop-app/desktop_app.py#L11745)). Only the
   `active_sessions` → `activity_records` path is missing it.
2. **Sessions born inside the no-input window.** Window focus can change with zero
   input (IDE/browser auto-focus); `on_window_switch` creates/extends sessions
   regardless of input. These sessions lie entirely inside the idle span.
3. **Already-uploaded rows.** `harvest_and_clear` drains ALL sessions (including
   the running one) every 5-min batch — a batch that fires inside the pre-timeout
   window uploads phantom time to the cloud before idle is even detected. No
   desktop-local fix can reach those rows retroactively.

## 3. Fix

### C5 — Desktop: trim sessions to the idle anchor (source fix)
In `enter_idle` (ACTIVE branch): resolve the anchor FIRST (`idle_start_time` if an
idle period is already open — C2 semantics — else backdated `last_activity_time`),
then:
- `stop_current_timer(end_time=anchor_iso)` — the final segment banks only up to
  the last input (mirrors the suspend path).
- NEW `ActiveSessionManager.trim_sessions_after(anchor_iso)`:
  - DELETE sessions with `first_seen >= anchor` (born input-less — pure phantom);
  - for sessions with `last_seen > anchor`: `last_seen = anchor`,
    `total_time_seconds = max(0, total − (old_last_seen − anchor))`,
    `timer_started_at = NULL`.
  ISO-8601 UTC strings compare lexicographically — same convention the table
  already relies on. Known approximation: if a session had interleaved post-anchor
  visits, the subtraction can also remove some pre-anchor banked time (bounded by
  the post-anchor span; errs toward NOT counting input-less time). Dominant case
  (one trailing segment) is exact.

### C6 — Server: reconcile on insert (defense; catches what the desktop can't)
Migration `20260703_trim_idle_activity_overlap.sql` (user applies; both DBs):
- AFTER INSERT of an idle row (sane span ≤ 16 h): NEUTRALIZE same-user non-idle
  rows fully inside the idle span (durations → 0, `end_time = start_time`,
  pending → analyzed); TRIM rows straddling the span's edges
  (`end_time → idle.start` / `start_time → idle.end`, durations reduced, floor 0).
- BEFORE INSERT of a non-idle row: clip the incoming row against existing
  overlapping idle rows (neutralize to a zero-duration stub if fully covered).
- **Rows are never deleted or dropped** — the desktop requires a non-empty
  insert result and re-fetches the first inserted row by id to verify uploads
  (desktop_app.py:10716/10748/10784); removal would trigger its restore/retry
  path and re-insert the same `request_id` → unique-index violation → retry
  loop. Zero-duration stubs are inert in every analytics path (SUMs add 0; the
  detail-page interval-merge and the timeline both skip `end_time <= start_time`).
- `SECURITY DEFINER`, pinned `search_path`, indexed probes
  (`idx_activity_user_timestamp`). Covers: rows uploaded by mid-window batches,
  offline replays, and every desktop still on ≤1.4.10 during rollout.

### C7 — Portal timeline: idle wins (reverses part of 2026-07-03 revamp AC7)
Yesterday's DayTimeline clip made ACTIVITY win overlaps. That was the wrong
winner: the idle span is input-authoritative, the overlapped activity is the
phantom. Flip the clip (non-idle pieces clipped to the gaps left by idle pieces;
fully-covered non-idle dropped), so display matches the C5/C6 data contract.

## 4. Acceptance criteria (1:1 tests; desktop tests red first)

1. **AC1:** `enter_idle` (from ACTIVE) calls `stop_current_timer(end_time=<anchor ISO>)`
   where anchor = backdated `last_activity_time`.
2. **AC2:** `enter_idle` (from ACTIVE) calls `trim_sessions_after(<anchor ISO>)`
   after stopping the timer; with an already-open anchor (C2 flap re-entry) it
   uses the ORIGINAL anchor, not a newer one.
3. **AC3:** `trim_sessions_after` deletes sessions with `first_seen >= cutoff`.
4. **AC4:** `trim_sessions_after` trims a straddling session: `last_seen = cutoff`,
   `total_time_seconds` reduced by the post-cutoff span (floored at 0),
   `timer_started_at` nulled; sessions entirely before the cutoff are untouched.
5. **AC5 (regression):** existing C1–C3 suite (`test_idle_lock_flap.py`) stays green;
   a normal idle→resume still emits exactly one idle record.
6. **AC6 (server, manual after user applies SQL):** inserting an idle row trims
   pre-existing straddling activity and deletes fully-covered activity;
   verification queries ship in the migration file.
7. **AC7 (portal, build + manual):** timeline renders idle-wins clipping; the
   11:25–11:31 case shows gray for the whole span with the phantom green gone.

## 5. Rollout / order

1. ai-server/portal build (C7) — display-only.
2. User applies C6 migration (dev, then prod) — immediately stops NEW overlap
   accumulation fleet-wide, even before desktops update.
3. Desktop v1.4.11 build after dev-soak (C5) — stops generating phantom at source.
Historical cleanup of already-stored overlaps: NOT in scope (same decision as
C1–C4 — read-time merging + C6 keeps new data clean; a one-time cleanup `.sql`
can be written on request).

## 6. Out of scope
- Suspend-path residual (trims to `pre_suspend`, not to last input — pre-existing,
  small).
- Cross-category union in the SQL aggregate RPCs for historical rows.
- The 4-second adjacent-idle overlap artifact (cosmetic, C6's clip direction
  handles its display; source is pynput-vs-GetLastInputInfo clock skew).

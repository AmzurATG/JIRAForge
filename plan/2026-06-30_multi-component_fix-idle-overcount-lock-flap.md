# Fix: Idle/Office Hours Wildly Overcounted — Screen-Lock Flap Emits Overlapping Cumulative Idle Records

**Date**: 2026-06-30
**Status**: 🔴 Proposed — pending approval
**Severity**: High (time data is wrong; one locked period reported as ~16–19 h of idle; daily totals exceed 24 h)
**Component**: python-desktop-app (`desktop_app.py`) — primary; ai-server portal (`portal-service.js`) — defense
**Related (prior fixes whose interaction caused this)**:
- [fix-lockapp-overnight-tracking.md](./fix-lockapp-overnight-tracking.md) — added `_is_screen_locked()` + the "screen still locked → re-enter idle" guard.
- [2026-06-15_python-desktop-app_fix-phantom-idle-time-inflation.md](./2026-06-15_python-desktop-app_fix-phantom-idle-time-inflation.md) — moved idle detection to `GetLastInputInfo` + added the resume safeguard. Fixed *active* inflation; did not cover *idle* inflation.

---

## 1. Problem

On the MyWorkMate portal, employee **Manikanta Tanagala** (prod DB `bzdoztgfozxkhkvctvdk`), date **2026-06-29**, "Today" shows:

- **Office Time 23.50 h**, **Idle Hours 18.19 h**, on a day whose activity timeline only spans **11:26 AM – ~9:40 PM (~10 h)**.

The database holds **24.31 h of tracked time for that one calendar day** — physically impossible (a day has 24 h). It is not unique to this user: across the last 21 days, **18 user-days exceed 24 h of tracked time, spanning 14 distinct users**, worst case **468 h of "idle" recorded in a single day**.

The correct contract: a continuous idle/locked period must be recorded **once**, and no day's total tracked time may exceed real elapsed time.

## 2. Root cause (verified end-to-end against DB + desktop logs + code, 2026-06-30)

### Evidence (read directly, no assumptions)

- **DB** (`activity_records`, `user=manikanta.tanagala`, `work_date='2026-06-29'`): 604 rows; idle = **266 rows summing 18.98 h**. Merging every row's real `[start_time, end_time]` interval (overlap counted once) gives **true office coverage ≈ 10.07 h, true idle ≈ 5.06 h**. So idle is overcounted ~3.7× purely by overlap.
- **DB — overlap shape**: dozens of idle rows share an **identical frozen `start_time`** with a **growing `end_time`** (e.g. `13:07:04 → 13:08:07 (63 s)`, `13:07:04 → 13:08:27 (83 s)`, `13:07:04 → 13:08:34 (90 s)` …), each a distinct `request_id`, `metadata.idle_reason = "idle timeout"`. One idle stretch is rewritten as ~20–40 nested cumulative rows.
- **Desktop log** (`%LOCALAPPDATA%\TimeTracker\logs\timetracker.log`, 2026-06-29): from the instant the screen locked at 13:07:04, this sequence repeats every ~5 s:
  ```
  Screen lock detected — entering idle state      → [STATE] ACTIVE → IDLE (reason: screen lock)
  Activity detected — resuming from idle          → [STATE] IDLE → ACTIVE
  Screen locked — entering idle state             → [STATE] ACTIVE → IDLE (reason: screen still locked)
  ...5s later: Activity detected — resuming from idle ... (repeats)
  [IDLE] Created idle record: 07:37:04 → 07:38:07 (63s, reason: idle timeout)   (UTC; = 13:07:04 IST)
  [IDLE] Created idle record: 07:37:04 → 07:38:27 (83s, reason: idle timeout)
  ```
  Counts for that day: **361** "screen still locked" idle-entries, **379** "resuming from idle", **272** "Created idle record". Grouped by frozen anchor: genuine idle periods → **1** record; lock-flap episodes → **30–42** records each (`07:37:04 ×37`, `10:55:40 ×37`, `11:35:38 ×39`, `15:05:23 ×42`, …). ~7 episodes × ~35 = ~250 phantom rows = the inflated idle hours.
- **Key proof it is the safeguard, not real input**: across the whole flap the anchor stays pinned at the lock second, i.e. `last_activity_time` never advances. The only writer of `idle_resume_event` that does **not** advance `last_activity_time` is the resume safeguard.

### Why it happens — interaction of two correct-in-isolation guards

The idle anchor and the idle/resume **decision** use two different clocks:

- **Anchor clock** — `enter_idle()` backdates `idle_start_time = last_activity_time` ([desktop_app.py:11783](../python-desktop-app/desktop_app.py#L11783)). `last_activity_time` is **jitter-filtered** (sub-threshold mouse drift is ignored, [:12010](../python-desktop-app/desktop_app.py#L12010)), so while the user is away it is **frozen** at the lock second.
- **Decision clock** — `_compute_idle_duration()` → `GetLastInputInfo` ([:11987](../python-desktop-app/desktop_app.py#L11987)) counts every OS input. **While the workstation is locked this clock does not reflect true away-time** (observed: it stays ≤ the 300 s threshold, so the app thinks the user keeps returning).

The flap, per loop iteration while the screen is locked:

1. **Resume safeguard** ([:12735](../python-desktop-app/desktop_app.py#L12735)) — `if self.is_idle and idle_duration <= current_idle_timeout: self.idle_resume_event.set()`. Fires because the decision clock reads low while locked.
2. **Resume processing** ([:12760](../python-desktop-app/desktop_app.py#L12760)) — `resume_from_idle()` → `_create_idle_record("idle timeout")` ([:11823](../python-desktop-app/desktop_app.py#L11823)) emits a row `anchor → now` (when the cumulative gap ≥ 60 s), sets `idle_start_time = None`, state → ACTIVE.
3. **Locked-screen guard** ([:12779](../python-desktop-app/desktop_app.py#L12779)) — `if self._is_screen_locked() and state == ACTIVE: enter_idle("screen still locked")` **re-anchors** `idle_start_time` back to the frozen `last_activity_time`; `time.sleep(5); continue`.
4. Loop repeats → another cumulative row from the same frozen anchor.

So each 5 s cycle re-emits the *entire* idle interval from the lock second. `reason: idle timeout` is just the string `resume_from_idle()` hard-codes — the actual driver is the lock flap. The **suspension-detection** path ([:12560-12604](../python-desktop-app/desktop_app.py#L12560)) has the same shape (`_create_idle_record` then `enter_idle("screen still locked after suspension")`) and contributes the smaller "system suspension detected" clusters.

**Display amplifier** — the portal sums blindly: `getEmployeeDetail()` does `totals[category] += duration_seconds` with no interval merge, and `officeHours = (active + idle)/3600` ([portal-service.js:431-467](../ai-server/src/services/portal-service.js#L431)). Overlapping rows are therefore counted multiple times.

---

## 3. Proposed solution

Principle: **a locked workstation is unambiguously idle — never "resume" from it until a real unlock or genuine input — and one continuous idle period must produce exactly one record.**

### Desktop (primary — stop generating overlapping rows)

**C1 — Do not resume from idle while the screen is locked.**
Gate both the resume safeguard ([:12735](../python-desktop-app/desktop_app.py#L12735)) and the resume processing block ([:12760](../python-desktop-app/desktop_app.py#L12760)) on `not self._is_screen_locked()`. While locked, `idle_resume_event` must not be set by the safeguard and a set event must not be acted on. Genuine resume still works: the `WTS_SESSION_UNLOCK` handler ([:12186-12189](../python-desktop-app/desktop_app.py#L12186)) and real input via `_register_activity` ([:12002](../python-desktop-app/desktop_app.py#L12002)) both fire after the screen is actually unlocked (`_is_screen_locked()` false by then). This breaks the flap at its source — no false resume ⇒ no re-emit ⇒ no re-anchor.

**C2 — One idle period = one record (no re-anchor mid-period).**
With C1, state stays IDLE while locked, so `enter_idle()`’s existing `if state == IDLE: return False` guard ([:11768](../python-desktop-app/desktop_app.py#L11768)) already prevents re-anchoring. Add an explicit assertion of that intent: `enter_idle()` must never overwrite a non-null `idle_start_time` with a later/again value for an already-open idle period.

**C3 — Overlap-proof `_create_idle_record` (hard backstop).**
Make `_create_idle_record` idempotent against re-emission: track the last emitted idle interval end for the current anchor and emit only the **non-overlapping increment** (or refuse to emit a row whose `[start,end]` is contained in / overlaps the previously queued idle row for the same anchor). Even if any other path (suspension flap, future regression) re-enters, totals cannot inflate.

### Portal (defense — make the employee view honest, including already-polluted history)

**C4 — Overlap-safe aggregation in `getEmployeeDetail`.**
Replace the blind `SUM(duration_seconds)` per category with **interval-merge coverage**: union each category’s `[start_time, end_time]` rows and sum the merged spans, so overlapping rows are counted once. `officeHours = merged(all)`, `idleHours = merged(idle)`, etc. This requires selecting `start_time, end_time` (already available) alongside the current fields. Restores the employee page to true ≈10 h office / ≈5 h idle for 2026-06-29 with no DB write.

---

## 4. Acceptance criteria (each maps 1:1 to a test)

1. While `_is_screen_locked()` is true, the resume safeguard does **not** set `idle_resume_event`, even when `_compute_idle_duration()` returns a value ≤ the idle threshold. *(test: state IDLE + locked + low idle_duration → event stays clear.)*
2. While locked, a set `idle_resume_event` is **not** acted upon — `resume_from_idle()` is not called and no idle record is created that cycle. *(test: locked + event set → no `_create_idle_record`, state stays IDLE.)*
3. A genuine **unlock** (`WTS_SESSION_UNLOCK`) followed by `_is_screen_locked()` false resumes normally and emits exactly **one** idle record for the locked span. *(test: lock → 3 flap cycles suppressed → unlock → one record, duration = lock→unlock.)*
4. `enter_idle()` does not overwrite an already-open `idle_start_time` (no re-anchor for an open idle period). *(test: enter_idle twice without resume; anchor unchanged, second call no-ops.)*
5. `_create_idle_record` called repeatedly for the same anchor produces **non-overlapping** output: total queued idle seconds for the anchor ≤ `now − idle_start`, never the triangular sum. *(test: drive 5 re-emissions from a fixed anchor with a controllable clock; assert no overlap / single covering record.)*
6. Regression: a normal idle-timeout period with the screen **unlocked** (user simply away) still produces exactly one idle record of the correct duration. *(test: unlocked, no input > threshold, then input → one record.)*
7. Portal `getEmployeeDetail` returns **merged-coverage** hours: given overlapping idle rows summing to 18.98 h within a 5.06 h merged span, `idleHours ≈ 5.06` and `officeHours ≈ merged(all) ≈ 10.07`, not 18.98 / 24.31. *(test: feed synthetic overlapping rows; assert merged totals.)*
8. Regression: portal `getEmployeeDetail` with **non-overlapping** rows yields the same totals as the old sum (no undercount). *(test: disjoint rows → merged sum == plain sum.)*
9. Integration / dev-soak (manual, AC for sign-off): on dev, lock the workstation for >10 min (and separately, sleep/suspend), unlock, and confirm the log shows **no** ACTIVE↔IDLE flapping while locked, and `activity_records` contains **one** idle row for the locked span (no frozen-anchor cumulative cluster).

Test locations (per repo convention):
- python-desktop-app pytest — new `tests/test_idle_lock_flap.py` → AC1–AC6; may extend `tests/test_idle_detection.py` / `tests/test_state_machine.py`.
- ai-server Jest — extend `tests/services/portal-service.test.js` → AC7, AC8.
Tests are written **failing/red first**, mapped 1:1 to the criteria, before any production change.

---

## 5. Rollout

- Validate the full loop on **dev** first, reproducing the original incident (lock >10 min + a real suspend), per the dev-soak rule — not a partial check.
- Deploy order: ai-server (portal C4) → desktop build/distribute (`build.bat`) after dev soak passes and on explicit go. One commit per the user’s one-commit-per-feature flow.
- Rollback: ai-server redeploy previous image; desktop users can stay on the prior installer via `app_releases`.

## 6. Out of scope (separate follow-ups)

- **Physical cleanup of already-recorded overlapping idle rows** (this user’s 2026-06-29 cluster, plus the 18 impossible user-days / 14 users / 468 h-worst-day fleet-wide). **Decision (2026-06-30): not planned** — C4’s read-time interval-merge is the chosen remedy, so raw rows are left untouched (no DB write, fully reversible). A one-time correction `.sql` remains available on request if a surface that cannot merge at read time later needs it.
- **Applying overlap-safe aggregation to the other surfaces** that sum durations (portal Dashboard/Employees-list/Reports RPCs and views, forge-app team analytics). Tracked as a follow-up once the source is fixed and history is cleaned.
- The **active/productive** inflation already addressed by [2026-06-15_…phantom-idle-time-inflation](./2026-06-15_python-desktop-app_fix-phantom-idle-time-inflation.md) (window-title-as-activity, session-timer cap, suspend exclusion). Unchanged here.
- `screenshots`/OCR capture, classification, and worklog sync (unchanged).

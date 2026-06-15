# Fix: Phantom "Productive" Time — Idle/Sleep Counted as Active Work

**Date**: 2026-06-15
**Status**: 🔴 Proposed — pending approval
**Severity**: High (time data is wrong; a non-working day reported ~15.5 h productive)
**Component**: python-desktop-app (`desktop_app.py`)
**Related**: [FIX_PLAN_SSL_PGRST102_SESSIONTIMER.md](../python-desktop-app/plan/FIX_PLAN_SSL_PGRST102_SESSIONTIMER.md) (earlier idle-record / session-timer fixes; different bugs)

---

## 1. Problem

On Saturday 2026-06-13, user **Vishnu Sai Kanthamraju** (dev DB `jvijitdewbypqbatfboi`) did roughly **1 hour** of real work but the dashboard reported **~15.5 h of "productive" time**. The laptop was left with the lid open and VS Code on screen overnight; no keyboard/mouse was touched.

The user's expectation — the correct contract — is: **no genuine keyboard/mouse input ⇒ the clock stops, regardless of time of day or day of week.** That is not how the app currently behaves.

## 2. Root cause (verified end-to-end against code + logs + DB, 2026-06-13/15)

### Evidence (read directly, no assumptions)

- **DB** (`activity_records`, `work_date='2026-06-13'`, this user): **63 rows, every one `is_idle=false` / `classification='productive'`, zero idle rows, sum = 56,368 s ≈ 15.66 h.** Two **single-visit** rows dominate:
  - `00:43:22 → 10:07:03` IST = **33,821 s (9.4 h)**, `Code.exe`, title "Visual Studio Code"
  - `18:04:09 → 22:09:32` IST = **14,722 s (4.1 h)**, `Code.exe`, title "Understand location feat…"
  - Together = **13.5 h** of the 15.66 h. Each row's `total_time_seconds` equals exactly `end − start`.
- **Cross-check**: for the overnight window the `screenshots` table has **0 rows**, but `activity_records` has the 33,821 s row — the two storage paths diverged completely.
- **Log** (`%LOCALAPPDATA%\TimeTracker\logs\timetracker.log`): after idle entry at 00:43:17, a window switch to "Visual Studio Code" at 00:43:22, then **6.5 h with no window switch, no idle timeout, no state change** — only settings reloads every 5 min. The 9.4 h timer was finally stopped at 10:07:03 by the suspend handler and uploaded (after JWT/DNS retries) at 10:45.

### Why it happened — four confirmed code defects

The idle decision is a single line — [desktop_app.py:12193](../python-desktop-app/desktop_app.py#L12193):
```python
idle_duration = time.time() - self.last_activity_time
if idle_duration > current_idle_timeout:   # 300 s → enter idle
```
So everything depends on what is allowed to refresh `last_activity_time`. There are 7 writers; the harmful ones:

**D1 — A window-title change is treated as user activity.** [get_active_window():10910-10913](../python-desktop-app/desktop_app.py#L10910-L10913) runs every ~2 s and does, on *any* `app|||title` change:
```python
if window_key != self.current_window_key:
    is_new_window = True
    # Window switch = user is active (reset idle timer even if pynput fails)
    self.last_activity_time = time.time()
```
Apps change their own titles with no human input (VS Code focus flips to/from bare "Visual Studio Code", extensions, git, file watchers; browser tabs; Teams). A duplicate fallback exists at [12196-12212](../python-desktop-app/desktop_app.py#L12196-L12212). This independently defeats the "no input → idle" contract.

**D2 — The idle signal trusts raw pynput events, which fire from an open lid.** [on_activity():11593-11600](../python-desktop-app/desktop_app.py#L11593-L11600) treats every `on_move`/`on_click`/`on_scroll`/`on_press` as activity. With the lid open, the OS/trackpad emits spurious mouse-move events. **By elimination this was the actual overnight trigger**: there were no window switches logged 00:43→10:07, so the only remaining writer of `last_activity_time` was `on_activity` — i.e. the app was receiving input you did not intentionally make, and never crossed the 5-minute line.

**D3 — The session stopwatch has no cap.** [_stop_timer_internal():5395-5418](../python-desktop-app/desktop_app.py#L5395-L5418) accumulates `elapsed = now − timer_started_at` with no upper bound and no idle/sleep subtraction. The parallel `screenshots` path **does** cap (`max(interval*2, 600)` at [11325](../python-desktop-app/desktop_app.py#L11325), [12345](../python-desktop-app/desktop_app.py#L12345), [12426](../python-desktop-app/desktop_app.py#L12426)) — the timer path was simply never given the same guard. This turns "didn't go idle" into a 9.4 h block instead of, at worst, minutes.

**D4 — Suspend/sleep time is counted as active.** The suspend handler at [12047-12050](../python-desktop-app/desktop_app.py#L12047-L12050) calls `stop_current_timer()` (comment: "so suspension time isn't counted"), but `stop_current_timer` stops at **`now` (wake time)** while `timer_started_at` is still the stale pre-sleep value — so the whole sleep gap is included. The 4.1 h evening row is entirely this path.

**D5 (design) — Work-hours gating of idle.** [_create_idle_record():11539-11543](../python-desktop-app/desktop_app.py#L11539-L11543) skips idle records via [_is_within_work_hours():11485](../python-desktop-app/desktop_app.py#L11485). Because 2026-06-13 is a Saturday (config `work_days=[1,2,3,4,5]`, `09:00–18:00`), every idle period the app *did* notice was discarded as "outside work hours." Per the user, idle/active must not depend on time of day at all — you can work whenever you want.

---

## 3. Proposed solution (code)

Principle: **active time is time with genuine human input. Nothing else may keep the clock alive, and a single window can never bank more than the cap.**

### C1 — Stop counting window-title changes as activity
In `get_active_window()` remove the `self.last_activity_time = time.time()` assignment at [10913](../python-desktop-app/desktop_app.py#L10913) (keep `is_new_window` detection — it is still needed for screenshot/session segmentation). Remove the window-switch-as-activity fallback block at [12196-12212](../python-desktop-app/desktop_app.py#L12196-L12212). Window switches segment sessions; they do **not** prove a human is present.

### C2 — Drive idle from real OS input, and ignore mouse jitter
- Use Windows **`GetLastInputInfo`** (via `ctypes`/`win32api`) as the authoritative idle source for `idle_duration` — it reports time since the OS's last real keyboard/mouse input and does not depend on Python-level hooks or window titles. Keep pynput only as the resume trigger / non-Windows fallback.
- For the pynput path, add a **mouse-move distance threshold**: `on_move` only counts as activity if the pointer moved more than `MOUSE_MOVE_MIN_PX` (e.g. 8 px) since the last counted position. Clicks, scroll, and key presses always count. This suppresses trackpad/optical drift while preserving real cursor use.

### C3 — Cap the session-timer segment (the hard backstop)
In `_stop_timer_internal` apply the **same cap the screenshots path already uses**:
```python
elapsed = min(elapsed, max(capture_interval * 2, 600))
```
No single continuous timer segment can exceed the cap (30 min at the default 900 s interval), so even if idle detection is ever fooled again, the worst case is one capped segment, not 9 hours. Legitimate single-window work up to the cap is unaffected; longer real work is segmented normally by interval captures.

### C4 — Exclude suspend/sleep from active time
Allow `stop_current_timer(end_time=…)` / `_stop_timer_internal(cursor, now=…)` to accept an explicit end timestamp. In the suspend handler ([12049-12050](../python-desktop-app/desktop_app.py#L12049-L12050)) finalize the active session at the **pre-suspend** time (`last_activity_time`, equivalently the loop's `last_loop_time` before the gap) instead of wake time, so the gap is dropped, not counted. Mirror what `_finalize_active_session` already does for the `screenshots` table (it ends at `last_activity_time`). C3 also bounds this independently.

### C5 — Remove work-hours gating from idle
Delete the `_is_within_work_hours` skip in `_create_idle_record` ([11539-11543](../python-desktop-app/desktop_app.py#L11539-L11543)); record idle (and therefore stop active accrual) regardless of time of day or weekday. `_is_within_work_hours` itself becomes unused for this path and can be removed or left dormant. (Active accrual already stops via C1–C4; this makes idle visible/honest and removes the wrong "weekend = no idle" behavior.)

---

## 4. Acceptance criteria (each maps 1:1 to a test)

1. A foreground window-title change does **not** advance `last_activity_time` (with pynput active). *(test: drive `get_active_window` across two titles via mocked `win32gui`; assert `last_activity_time` unchanged.)*
2. With no genuine input for longer than the idle threshold, the app enters idle **even though the window title changed** repeatedly. *(test: simulate title churn + zero input; assert state → IDLE after threshold.)*
3. Idle duration is computed from the OS real-input time (`GetLastInputInfo`) on Windows; a frozen OS-input time for > threshold yields idle. *(test: monkeypatch the OS-input reader; assert idle decision.)*
4. A sub-threshold `on_move` (< `MOUSE_MOVE_MIN_PX`) does **not** count as activity; a click/key/scroll or a supra-threshold move does. *(test: feed jitter vs. real events to the activity callback.)*
5. A session-timer segment is capped at `max(interval*2, 600)` s: starting a timer, advancing the clock 9 h, then stopping yields `total_time_seconds == cap`, not 9 h. *(test: `ActiveSessionManager` in isolation with a controllable clock.)*
6. On a suspend gap, the active session is finalized at the pre-suspend time; the sleep gap is excluded from `total_time_seconds`. *(test: start timer, jump the clock to simulate a gap, finalize with pre-suspend end; assert gap excluded.)*
7. `_create_idle_record` produces a record for a **Saturday 02:00** `idle_start_time` (i.e. no work-hours/weekday skip). *(test: construct instance, set idle window on a weekend timestamp, assert a record is queued.)*
8. Regression: genuine continuous single-window work shorter than the cap is still counted at its true duration (no undercount). *(test: timer run of e.g. 600 s with input present → 600 s recorded.)*
9. Integration / dev-soak (manual, AC for sign-off): reproduce the original scenario on dev — one unchanged window, no input, across an idle period and a real sleep — and confirm: app enters idle within the threshold, **no** productive `activity_records` accrue during idle/sleep, and no single row exceeds the cap.

Test locations (pytest, per repo convention `tests/test_<module>.py`):
- New `tests/test_idle_detection.py` → AC1–AC4, AC7.
- Extend `test_session_management.py` / `tests/test_session_maintenance.py` → AC5, AC6, AC8.
- `tests/test_state_machine.py` may cover the idle/suspend transitions for AC2/AC6.
Per the workflow, these tests are written **failing/red first**, mapped to the criteria above, before any production change.

## 5. Rollout

Per the dev-soak rule: validate the **full** loop on dev (`jvijit`) first, **including the original incident scenario** (unchanged window + no input + a real sleep), not just a partial check. Build/distribute a new `.exe` (`build.bat`) only after the dev soak passes and on explicit go. Changes batched into one commit per the user's one-commit-per-feature flow.

## 6. Out of scope (separate follow-ups)

- **Cleanup of already-recorded bad data** (the ~15.5 h on 2026-06-13 and any equivalent inflated rows for other days/users). This is a DB operation; per project rule Claude only delivers SQL for the user to run — a targeted correction query can be provided as a follow-up, not part of this code change.
- Portal/ai-server **display or aggregation** changes (the dashboard simply sums what the desktop writes; fixing the source fixes the dashboard).
- `screenshots`/OCR capture timing, classification, and the interval/event tracking modes (unchanged).
- General pynput reliability / watchdog behavior beyond the de-noise threshold in C2.

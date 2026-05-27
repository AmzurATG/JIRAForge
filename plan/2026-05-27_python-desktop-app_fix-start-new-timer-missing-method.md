# Fix: `AttributeError: ActiveSessionManager.start_new_timer` on Idle Resume

**Date:** 2026-05-27
**Component:** `python-desktop-app`
**Type:** Critical Bug Fix
**Files Changed:**
- `python-desktop-app/desktop_app.py`
- `python-desktop-app/tests/test_state_machine.py`
**Status:** Fixed

---

## Problem

Every time a user woke their machine from sleep, unlocked their screen, or returned from any idle state, the tracking loop crashed with an unhandled `AttributeError`:

```
[ERROR] Tracking loop error: 'ActiveSessionManager' object has no attribute 'start_new_timer'
AttributeError: 'ActiveSessionManager' object has no attribute 'start_new_timer'
```

This was confirmed by repeated occurrences in production logs (`timetrackerlogs.md`):

| Timestamp (local) | Error |
|---|---|
| 2026-05-25 13:29:28 | `AttributeError: 'ActiveSessionManager' object has no attribute 'start_new_timer'` |
| 2026-05-25 14:14:50 | same |
| 2026-05-25 14:52:56 | same |
| 2026-05-25 15:44:00 | same |
| 2026-05-25 15:56:35 | same |
| 2026-05-25 16:07:26 | same |
| 2026-05-25 17:25:06 | same |
| 2026-05-25 17:46:56 | same |
| 2026-05-26 04:53:10 | same |

The exception was raised inside `resume_from_idle()` before it could complete its state-reset block. This caused:

- **Window state not reset** — `current_window_title`, `current_window_db_start_time`, `current_project_key`, `current_window_screenshot_id` retained stale idle-period values.
- **Tray icon not updated** — `update_tray_icon()` never ran; the IDLE icon remained after wake.
- **Admin log not written** — `add_admin_log('INFO', 'Resumed from idle - tracking active')` was skipped.
- **Dashboard "Last Tracked" not advancing** — timeline blocks stop appearing past the idle start time.
- **No user-visible error** — the exception was caught by the outer tracking loop, silently logged, and the loop continued; the user saw nothing wrong.

---

## Root Cause

### The Missing Method

`resume_from_idle()` (`desktop_app.py:9979`) calls:

```python
self.session_manager.start_new_timer()
```

`session_manager` is an instance of `ActiveSessionManager`. That class defines:

- `stop_current_timer()` — called by `enter_idle()` at line ~9913
- `get_all_sessions()`
- `clear_all()`
- `harvest_and_clear()`

**`start_new_timer()` was never added to `ActiveSessionManager`.** The call was added to `resume_from_idle()` along with an explanatory comment (`# Start new SQLite timer for the active session`) and test assertions — but the method body itself was never written.

### Why CI Did Not Catch It

`test_state_machine.py` (lines 100 and 117) contains:

```python
tracker.session_manager.start_new_timer.assert_called_once()
tracker.session_manager.start_new_timer.assert_not_called()
```

Both tests pass because `session_manager` is replaced with `unittest.mock.Mock()` at the top of each test. `Mock` accepts **any** attribute access and returns a new `Mock` — so `start_new_timer` appeared to exist, `assert_called_once()` passed, and CI was green throughout.

This is a well-known pitfall of over-mocking: tests verify call-site behaviour (the mock was called) but never verify that the real implementation exists.

### Why Self-Healing Partially Worked

The underlying tracking database was not permanently broken. When the next window-focus event fired:

1. `process_window_event()` → `on_window_switch()` → `_stop_timer_internal()` checked `WHERE timer_started_at IS NOT NULL` — since `stop_current_timer()` already nulled `timer_started_at` during `enter_idle()`, the UPDATE was a safe no-op.
2. The `SELECT / UPDATE / INSERT` path then created or resumed the correct session row for the new window.

So the database self-healed on the next event. However, the window-state variables (`current_window_title`, etc.) were still stale until the next switch, which could produce a spurious short session attributed to the wrong window.

### Why `_current_key` Reset Matters

`clear_all()` already sets `self._current_key = None` after a successful batch upload. If a batch upload occurred *during* idle:

1. `harvest_and_clear()` deleted the row that `_current_key` pointed to.
2. `_current_key` still held the old `(title, app_name)` tuple.
3. On the next `on_window_switch()`, `_stop_timer_internal()` would query for a row matching that key — finding nothing, but still executing a no-op UPDATE. No data corruption, but a stale lookup.

Resetting `_current_key = None` in `start_new_timer()` closes this window, consistent with the pattern established by `clear_all()`.

---

## Fix

### 1. Add `start_new_timer()` to `ActiveSessionManager`

**File:** `python-desktop-app/desktop_app.py`
**Location:** Line 4590 — between `stop_current_timer()` and `get_all_sessions()`

```python
def start_new_timer(self):
    """Reset _current_key so the next window switch starts a fresh session.

    The pre-idle row's timer was already nulled by stop_current_timer();
    if a batch upload ran during idle, the row may have been harvested.
    Clearing _current_key avoids a stale lookup on the next
    on_window_switch() call.
    """
    with self._lock:
        self._current_key = None
```

**Design decisions:**

| Decision | Rationale |
|---|---|
| `with self._lock` | Mirrors `stop_current_timer()` and `clear_all()` — all public writes on `ActiveSessionManager` are lock-guarded |
| `self._current_key = None` | Prevents stale-key lookup after a batch upload that ran during idle; matches `clear_all()` precedent |
| No SQLite I/O | The database row is already in the correct state from `stop_current_timer()` (timer nulled, total accumulated); no write needed |
| Name kept as `start_new_timer` | Renaming would require changing the caller, the test assertions, and the explanatory comment — unnecessary blast radius |

### 2. Add Regression Tests Against the Real Class

**File:** `python-desktop-app/tests/test_state_machine.py`
**Location:** New class `TestActiveSessionManagerStartNewTimer` added before `TestEdgeCases`

```python
class TestActiveSessionManagerStartNewTimer:
    """Regression tests for ActiveSessionManager.start_new_timer."""

    def test_start_new_timer_resets_current_key(self):
        """start_new_timer() must clear _current_key on a real instance."""
        from desktop_app import ActiveSessionManager
        from unittest.mock import MagicMock
        mgr = ActiveSessionManager(db_manager=MagicMock())
        mgr._current_key = ("some title", "some.exe")
        mgr.start_new_timer()
        assert mgr._current_key is None

    def test_start_new_timer_idempotent_when_already_none(self):
        """Calling start_new_timer() when _current_key is already None is a safe no-op."""
        from desktop_app import ActiveSessionManager
        from unittest.mock import MagicMock
        mgr = ActiveSessionManager(db_manager=MagicMock())
        mgr._current_key = None
        mgr.start_new_timer()  # must not raise
        assert mgr._current_key is None
```

These tests instantiate the **real** `ActiveSessionManager` (not a Mock). If the method is ever removed or renamed, the test fails at collection time — not at runtime in production.

---

## Call Path (After Fix)

```
screen unlock / wake-from-sleep
  └── system event handler
        └── resume_from_idle()                          [desktop_app.py:9960]
              ├── _create_idle_record("idle timeout")
              ├── idle_start_time = None
              ├── idle_reason = None
              ├── state = TrackingState.ACTIVE
              ├── is_idle = False
              ├── needs_idle_resume = False
              ├── session_manager.start_new_timer()      ← WAS: AttributeError / NOW: resets _current_key
              ├── update_tray_icon()                     ← now executes (was aborted before fix)
              ├── add_admin_log(...)                     ← now executes (was aborted before fix)
              ├── last_interval_time = time.time()
              └── current_window_title = None  (+ other state resets)
                    └── on next window event:
                          on_window_switch()
                            _stop_timer_internal()       safe no-op (_current_key is None)
                            INSERT / UPDATE session row  new session starts correctly
```

---

## Files Changed

### `python-desktop-app/desktop_app.py`

| Lines | Change |
|---|---|
| 4590–4600 | Added `ActiveSessionManager.start_new_timer()` with docstring, lock acquisition, and `_current_key` reset |

### `python-desktop-app/tests/test_state_machine.py`

| Lines | Change |
|---|---|
| 197–222 | Added `TestActiveSessionManagerStartNewTimer` class with two tests against a real `ActiveSessionManager` instance |

---

## Testing

### Automated

Run the existing state machine tests to confirm no regression:

```bash
cd python-desktop-app
pytest tests/test_state_machine.py -v
```

All tests should pass, including:
- `TestStateTransitions::test_resume_from_idle_resets_tracking_state` — mock-based, confirms call-site contract
- `TestActiveSessionManagerStartNewTimer::test_start_new_timer_resets_current_key` — real-instance, confirms implementation exists
- `TestActiveSessionManagerStartNewTimer::test_start_new_timer_idempotent_when_already_none` — real-instance, confirms idempotency

### Manual Verification

1. Build the updated exe: `cd python-desktop-app && build.bat`
2. Install the new build and start the tracker.
3. Lock the machine (Win+L) and wait ~30 seconds.
4. Unlock. The log should show:
   ```
   [STATE] IDLE → ACTIVE
   [INFO] Resumed from idle - tracking active
   ```
   **without** an `AttributeError` traceback.
5. Verify the tray icon switches from IDLE back to ACTIVE immediately on unlock.
6. Verify the dashboard "Last Tracked" advances and timeline blocks appear after the unlock time.

### Audit of Other Mocked Methods on `session_manager`

The code review identified that other `session_manager` methods in `test_state_machine.py` are also called only via `Mock()`. These should be audited for the same gap:

| Method | Has real-instance test? |
|---|---|
| `stop_current_timer()` | ❌ No — covered only by mock |
| `restore_sessions()` | ❌ No — covered only by mock |
| `harvest_and_clear()` | ❌ No — covered only by mock |
| `clear_all()` | ❌ No — covered only by mock |
| `start_new_timer()` | ✅ **Yes — added by this fix** |

A follow-up task should add real-instance tests for the remaining four methods to close the blind-spot pattern.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `start_new_timer` removed in future refactor | Low | High (silent regression to production) | Real-instance tests now in `test_state_machine.py` fail immediately |
| Thread contention between `start_new_timer` and `on_window_switch` | Very low | Low (lock serialises both) | `self._lock` acquired in both paths |
| `_current_key` reset causes missed OCR backfill | None | None | `_pending_ocr_keys` is keyed by `(title, app_name)`, not `_current_key`; unaffected |
| Stale window-state variables during idle gap | Pre-existing | Low | Mitigated by full state reset block that now runs in `resume_from_idle()` |

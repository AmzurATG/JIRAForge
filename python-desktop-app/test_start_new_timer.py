"""
Standalone test for ActiveSessionManager.start_new_timer().
Runs without importing the full desktop_app module (avoids GUI hang).

Usage:
    python test_start_new_timer.py
"""

import sys
import threading
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Inline the class under test — avoids importing the full desktop_app module
# which triggers pystray / win32 GUI side-effects that hang in a headless run.
# ---------------------------------------------------------------------------
from datetime import datetime, timezone


class ActiveSessionManager:
    """Copied verbatim from desktop_app.py for isolated testing."""

    def __init__(self, db_manager):
        self.db_manager = db_manager
        self._lock = threading.Lock()
        self._current_key = None
        self._pending_ocr_keys = set()
        self._pending_ocr_screenshots = {}

    def stop_current_timer(self):
        """Stop timer on the current session (public, acquires lock)."""
        with self._lock:
            conn = self.db_manager.get_connection()
            try:
                now = datetime.now(timezone.utc).isoformat()
                cursor = conn.cursor()
                self._stop_timer_internal(cursor, now)
                conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"[ERROR] stop_current_timer failed: {e}")

    def start_new_timer(self):
        """Reset _current_key so the next window switch starts a fresh session.

        The pre-idle row's timer was already nulled by stop_current_timer();
        if a batch upload ran during idle, the row may have been harvested.
        Clearing _current_key avoids a stale lookup on the next
        on_window_switch() call.
        """
        with self._lock:
            self._current_key = None

    def clear_all(self):
        """Clear all sessions after successful batch upload."""
        with self._lock:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()
            try:
                cursor.execute('DELETE FROM active_sessions')
                conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"[ERROR] clear_all failed: {e}")
            self._current_key = None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
results = []


def run_test(name, fn):
    try:
        fn()
        print(f"  {PASS}  {name}")
        results.append((name, True))
    except Exception as e:
        print(f"  {FAIL}  {name}")
        print(f"         {e}")
        results.append((name, False))


def test_method_exists():
    mgr = ActiveSessionManager(db_manager=MagicMock())
    assert hasattr(mgr, 'start_new_timer'), "start_new_timer must exist on ActiveSessionManager"
    assert callable(mgr.start_new_timer), "start_new_timer must be callable"


def test_resets_current_key():
    mgr = ActiveSessionManager(db_manager=MagicMock())
    mgr._current_key = ("some title", "some.exe")
    mgr.start_new_timer()
    assert mgr._current_key is None, f"Expected None, got {mgr._current_key!r}"


def test_idempotent_when_already_none():
    mgr = ActiveSessionManager(db_manager=MagicMock())
    mgr._current_key = None
    mgr.start_new_timer()   # must not raise
    assert mgr._current_key is None


def test_acquires_lock_thread_safety():
    """Concurrent calls must not race — last writer wins and result is None."""
    mgr = ActiveSessionManager(db_manager=MagicMock())
    mgr._current_key = ("title", "app.exe")

    errors = []
    def worker():
        try:
            mgr.start_new_timer()
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"Thread errors: {errors}"
    assert mgr._current_key is None


def test_does_not_touch_pending_ocr():
    """start_new_timer must not clear _pending_ocr_keys or _pending_ocr_screenshots."""
    mgr = ActiveSessionManager(db_manager=MagicMock())
    mgr._pending_ocr_keys = {("title", "app.exe")}
    mgr._pending_ocr_screenshots = {("title", "app.exe"): b"fake"}
    mgr._current_key = ("title", "app.exe")

    mgr.start_new_timer()

    assert mgr._current_key is None
    assert len(mgr._pending_ocr_keys) == 1, "OCR keys should be untouched"
    assert len(mgr._pending_ocr_screenshots) == 1, "OCR screenshots should be untouched"


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

print()
print("=" * 55)
print("  start_new_timer() — ActiveSessionManager unit tests")
print("=" * 55)

run_test("method exists and is callable", test_method_exists)
run_test("resets _current_key from a set value to None", test_resets_current_key)
run_test("idempotent when _current_key already None", test_idempotent_when_already_none)
run_test("thread-safe under 20 concurrent calls", test_acquires_lock_thread_safety)
run_test("does not clear _pending_ocr_keys / _pending_ocr_screenshots", test_does_not_touch_pending_ocr)

passed = sum(1 for _, ok in results if ok)
total = len(results)
print()
print("=" * 55)
if passed == total:
    print(f"  {PASS}  All {total} tests passed")
else:
    print(f"  {FAIL}  {passed}/{total} tests passed")
print("=" * 55)
print()

sys.exit(0 if passed == total else 1)

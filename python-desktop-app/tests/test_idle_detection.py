"""
RED-phase tests for the phantom-"productive"-time fix.

Plan: plan/2026-06-15_python-desktop-app_fix-phantom-idle-time-inflation.md

These tests encode the corrected contract:
  * Only genuine keyboard/mouse input counts as activity (NOT window-title
    changes, NOT mouse micro-jitter).
  * Idle is decided from the OS's real last-input time when available.
  * A single session-timer segment can never bank more than the cap, and
    suspend/sleep time is excluded by stopping the timer at the pre-suspend
    moment.
  * Idle accrual stops regardless of time-of-day / day-of-week (no work-hours
    gating).

Mapping to acceptance criteria (AC1-AC8) is noted on each test.
"""

import sqlite3
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

import pytest

import desktop_app
from desktop_app import TimeTracker, ActiveSessionManager


# ---------------------------------------------------------------------------
# Fixtures / helpers for the SQLite-backed ActiveSessionManager
# ---------------------------------------------------------------------------

ACTIVE_SESSIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS active_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    window_title TEXT,
    application_name TEXT,
    classification TEXT,
    ocr_text TEXT,
    ocr_method TEXT,
    ocr_confidence REAL,
    ocr_error_message TEXT,
    total_time_seconds REAL DEFAULT 0,
    visit_count INTEGER DEFAULT 1,
    first_seen TEXT,
    last_seen TEXT,
    timer_started_at TEXT,
    UNIQUE(window_title, application_name)
);
"""


class _FakeDbManager:
    """Minimal db_manager: one persistent SQLite connection with the real schema."""

    def __init__(self, path):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.executescript(ACTIVE_SESSIONS_SCHEMA)
        self._conn.commit()

    def get_connection(self):
        return self._conn


@pytest.fixture
def session_mgr(tmp_path):
    return ActiveSessionManager(_FakeDbManager(str(tmp_path / "sessions.db")))


def _insert_running_session(mgr, title, app, started_iso, total=0):
    conn = mgr.db_manager.get_connection()
    conn.execute(
        "INSERT INTO active_sessions "
        "(window_title, application_name, classification, total_time_seconds, "
        " visit_count, first_seen, last_seen, timer_started_at) "
        "VALUES (?,?,?,?,1,?,?,?)",
        (title, app, "productive", total, started_iso, started_iso, started_iso),
    )
    conn.commit()
    mgr._current_key = (title, app)


def _total(mgr, title, app):
    row = mgr.db_manager.get_connection().execute(
        "SELECT total_time_seconds FROM active_sessions "
        "WHERE window_title=? AND application_name=?",
        (title, app),
    ).fetchone()
    return row[0] if row else None


# ---------------------------------------------------------------------------
# AC5 / AC8 — session-timer cap (no inflation, no undercount below the cap)
# ---------------------------------------------------------------------------

def test_session_segment_is_capped(session_mgr):
    """AC5: a 9h+ continuous segment is clamped to max_segment_seconds."""
    mgr = session_mgr
    t0 = datetime(2026, 6, 13, 0, 43, 22, tzinfo=timezone.utc)
    _insert_running_session(mgr, "Visual Studio Code", "Code.exe", t0.isoformat())

    end = (t0 + timedelta(hours=9, minutes=23, seconds=41)).isoformat()
    mgr.stop_current_timer(end_time=end)

    total = _total(mgr, "Visual Studio Code", "Code.exe")
    assert total == mgr.max_segment_seconds
    assert total <= 1800  # default cap = max(900*2, 600)


def test_session_below_cap_keeps_full_duration(session_mgr):
    """AC8: genuine work shorter than the cap is recorded at its true length."""
    mgr = session_mgr
    t0 = datetime(2026, 6, 13, 10, 0, 0, tzinfo=timezone.utc)
    _insert_running_session(mgr, "doc.py - Code", "Code.exe", t0.isoformat())

    mgr.stop_current_timer(end_time=(t0 + timedelta(seconds=600)).isoformat())
    assert _total(mgr, "doc.py - Code", "Code.exe") == 600


# ---------------------------------------------------------------------------
# AC6 — suspend/sleep excluded by stopping at the pre-suspend moment
# ---------------------------------------------------------------------------

def test_stop_at_presuspend_excludes_sleep_gap(session_mgr):
    """AC6: stopping the timer at the pre-suspend time drops the sleep gap."""
    mgr = session_mgr
    t0 = datetime(2026, 6, 13, 18, 4, 9, tzinfo=timezone.utc)
    _insert_running_session(mgr, "feat - Code", "Code.exe", t0.isoformat())

    last_activity = t0 + timedelta(seconds=120)   # active for 2 min, then slept ~4h
    mgr.stop_current_timer(end_time=last_activity.isoformat())

    assert _total(mgr, "feat - Code", "Code.exe") == 120  # gap NOT counted


def test_stop_current_timer_defaults_to_now(session_mgr):
    """Regression: stop_current_timer() with no end_time still works (uses now)."""
    mgr = session_mgr
    t0 = datetime.now(timezone.utc) - timedelta(seconds=30)
    _insert_running_session(mgr, "w", "a", t0.isoformat())
    mgr.stop_current_timer()
    total = _total(mgr, "w", "a")
    assert 25 <= total <= 120


# ---------------------------------------------------------------------------
# AC1 — a window-title change must NOT count as user activity
# ---------------------------------------------------------------------------

def test_window_title_change_does_not_register_activity():
    """AC1: get_active_window() must not advance last_activity_time on a title change."""
    t = TimeTracker.__new__(TimeTracker)  # avoid full __init__ side effects
    t.last_activity_time = 1000.0
    t.current_window_key = None
    t.add_admin_log = MagicMock()

    with patch.object(desktop_app, "WIN32_AVAILABLE", True), \
         patch.object(desktop_app, "win32gui", create=True) as wg, \
         patch.object(desktop_app, "win32process", create=True) as wp, \
         patch.object(desktop_app, "psutil", create=True) as ps, \
         patch.object(desktop_app.time, "time", return_value=2000.0):
        wg.GetForegroundWindow.return_value = 1
        wp.GetWindowThreadProcessId.return_value = (0, 123)
        ps.Process.return_value.name.return_value = "Code.exe"

        wg.GetWindowText.return_value = "File A - Visual Studio Code"
        t.get_active_window()                       # first observation
        wg.GetWindowText.return_value = "File B - Visual Studio Code"
        t.get_active_window()                       # title changed on its own

    assert t.last_activity_time == 1000.0, \
        "a self-changing window title must not be treated as user activity"


# ---------------------------------------------------------------------------
# AC4 — mouse micro-jitter is ignored; real input counts
# ---------------------------------------------------------------------------

def test_mouse_jitter_is_not_enough_movement():
    """AC4: sub-threshold pointer drift is not movement; a real jump is."""
    t = TimeTracker.__new__(TimeTracker)
    t._last_mouse_pos = (500, 500)
    assert t._mouse_moved_enough(503, 502) is False     # ~3.6 px
    t._last_mouse_pos = (500, 500)
    assert t._mouse_moved_enough(560, 540) is True       # big jump


def test_mouse_jitter_does_not_register_activity():
    """AC4: a jitter on_move event leaves last_activity_time untouched."""
    t = TimeTracker.__new__(TimeTracker)
    t.last_activity_time = 1000.0
    t.is_idle = False
    t.idle_resume_event = MagicMock()
    t._activity_monitor_heartbeat = 0
    t._last_mouse_pos = (500, 500)
    with patch.object(desktop_app.time, "time", return_value=2000.0):
        t._on_mouse_move(502, 501)                       # jitter
    assert t.last_activity_time == 1000.0


def test_real_input_registers_activity():
    """AC4: a click/keypress/scroll always counts as activity."""
    t = TimeTracker.__new__(TimeTracker)
    t.last_activity_time = 1000.0
    t.is_idle = False
    t.idle_resume_event = MagicMock()
    t._activity_monitor_heartbeat = 0
    with patch.object(desktop_app.time, "time", return_value=2000.0):
        t._on_input_activity()
    assert t.last_activity_time == 2000.0


# ---------------------------------------------------------------------------
# AC2 / AC3 — idle is computed from OS real-input time, with fallback
# ---------------------------------------------------------------------------

def test_compute_idle_uses_system_idle_when_available():
    """AC3: when the OS reports real idle seconds, use them."""
    t = TimeTracker.__new__(TimeTracker)
    t.last_activity_time = 0.0  # would look hugely idle via fallback
    with patch.object(t, "get_system_idle_seconds", return_value=42.0):
        assert t._compute_idle_duration() == 42.0


def test_compute_idle_falls_back_to_last_activity():
    """AC2: with no OS signal, fall back to last genuine-input time."""
    t = TimeTracker.__new__(TimeTracker)
    t.last_activity_time = 1000.0
    with patch.object(t, "get_system_idle_seconds", return_value=None), \
         patch.object(desktop_app.time, "time", return_value=1300.0):
        assert t._compute_idle_duration() == 300.0


def test_get_system_idle_seconds_is_safe():
    """AC3: helper returns a float or None and never raises."""
    t = TimeTracker.__new__(TimeTracker)
    result = t.get_system_idle_seconds()
    assert result is None or isinstance(result, (int, float))


# ---------------------------------------------------------------------------
# AC7 — idle is recorded regardless of time-of-day / day-of-week
# ---------------------------------------------------------------------------

def test_idle_record_created_outside_work_hours():
    """AC7: no work-hours/weekday gating — idle still produces a record."""
    t = TimeTracker.__new__(TimeTracker)
    t._pending_idle_records = []
    t.current_user_id = "user-1"
    t.organization_id = "org-1"
    t.current_project_key = "TA"
    t.idle_project_key = None
    t.user_issues = None
    t.app_version = "test"
    t.get_user_project_key = MagicMock(return_value="TA")
    # The fix removes work-hours/weekday gating entirely, so _create_idle_record
    # no longer consults tracking_settings. idle_start_time is a Saturday — the
    # OLD code skipped this as "outside work hours"; the fixed code records it.
    t.idle_start_time = datetime(2026, 6, 13, 12, 0, 0, tzinfo=timezone.utc)

    t._create_idle_record("idle timeout")

    assert len(t._pending_idle_records) == 1
    assert t._pending_idle_records[0]["is_idle"] is True
    assert t._pending_idle_records[0]["classification"] == "idle"

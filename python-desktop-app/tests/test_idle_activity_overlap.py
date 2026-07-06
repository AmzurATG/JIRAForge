"""
Test Suite: Idle-vs-Activity Overlap (C5) — phantom work during no-input windows

Covers plan/2026-07-03_python-desktop-app_idle-activity-overlap-c5.md (AC1-AC4).

Root cause: the idle span is input-authoritative (anchor = last real input,
backdated), but enter_idle() banked the current session's timer up to the idle
DETECTION moment (anchor + idle_timeout) and never reconciled sessions that were
extended or even created during the no-input window — so activity_records rows
overlapped the idle record by up to idle_timeout (5 min) per idle break
(verified in dev/prod data, v1.4.10).

The fix:
  C5a — enter_idle stops the current timer AT THE ANCHOR
        (stop_current_timer(end_time=anchor), mirroring the suspend path).
  C5b — new ActiveSessionManager.trim_sessions_after(anchor): deletes sessions
        born inside the no-input window, trims stragglers' last_seen/total back
        to the anchor.

RED phase: these tests fail until the C5 changes exist.
"""

import sqlite3
import time
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock

import pytest

from desktop_app import TimeTracker, TrackingState, ActiveSessionManager


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

def _make_tracker():
    """TimeTracker with collaborators mocked (mirrors test_idle_lock_flap.py)."""
    tracker = TimeTracker()
    tracker._finalize_active_session = Mock()
    tracker.session_manager = Mock()
    tracker.update_tray_icon = Mock()
    tracker.upload_activity_batch = Mock()
    tracker.add_admin_log = Mock()
    tracker.current_user_id = 'user-1'
    tracker.organization_id = 'org-1'
    tracker.app_version = '9.9.9'
    tracker.current_project_key = 'PROJ'
    tracker.idle_project_key = 'PROJ'
    tracker.user_issues = None
    tracker.get_user_project_key = Mock(return_value='PROJ')
    return tracker


class _FakeDbManager:
    """Minimal db_manager: one shared in-memory SQLite with the real schema."""

    def __init__(self):
        self._conn = sqlite3.connect(':memory:', check_same_thread=False)
        self._conn.execute('''
            CREATE TABLE active_sessions (
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
            )
        ''')
        self._conn.commit()

    def get_connection(self):
        return self._conn


def _iso(dt):
    return dt.isoformat()


def _insert_session(conn, title, app, total, first_seen, last_seen, timer_started_at=None):
    conn.execute(
        '''INSERT INTO active_sessions
           (window_title, application_name, classification, total_time_seconds,
            visit_count, first_seen, last_seen, timer_started_at)
           VALUES (?, ?, 'productive', ?, 1, ?, ?, ?)''',
        (title, app, total, _iso(first_seen), _iso(last_seen),
         _iso(timer_started_at) if timer_started_at else None)
    )
    conn.commit()


def _rows(conn):
    cur = conn.execute(
        'SELECT window_title, total_time_seconds, first_seen, last_seen, timer_started_at '
        'FROM active_sessions ORDER BY window_title')
    return {r[0]: {'total': r[1], 'first_seen': r[2], 'last_seen': r[3], 'timer': r[4]}
            for r in cur.fetchall()}


ANCHOR = datetime(2026, 7, 3, 5, 55, 48, tzinfo=timezone.utc)  # last real input


# ---------------------------------------------------------------------------
# AC1 / AC2 — enter_idle wiring (session_manager mocked)
# ---------------------------------------------------------------------------

class TestEnterIdleTrimsToAnchor:
    def test_ac1_stop_current_timer_receives_the_backdated_anchor(self):
        """AC1: the final segment must bank only up to the LAST INPUT, not up to
        the idle-detection moment 5 minutes later."""
        tracker = _make_tracker()
        tracker.state = TrackingState.ACTIVE
        anchor_ts = time.time() - 300  # input stopped 5 min ago
        tracker.last_activity_time = anchor_ts

        tracker.enter_idle('idle timeout')

        expected_iso = datetime.fromtimestamp(anchor_ts, tz=timezone.utc).isoformat()
        tracker.session_manager.stop_current_timer.assert_called_once_with(end_time=expected_iso)

    def test_ac2_trim_sessions_after_called_with_anchor(self):
        """AC2: pending sessions are reconciled against the same anchor."""
        tracker = _make_tracker()
        tracker.state = TrackingState.ACTIVE
        anchor_ts = time.time() - 300
        tracker.last_activity_time = anchor_ts

        tracker.enter_idle('idle timeout')

        expected_iso = datetime.fromtimestamp(anchor_ts, tz=timezone.utc).isoformat()
        tracker.session_manager.trim_sessions_after.assert_called_once_with(expected_iso)

    def test_ac2_open_anchor_wins_over_newer_input_time(self):
        """AC2 (C2 interplay): during a lock flap the idle period is already open —
        trimming must use the ORIGINAL anchor, never a newer last_activity_time."""
        tracker = _make_tracker()
        original_anchor = datetime.now(timezone.utc) - timedelta(minutes=10)
        tracker.idle_start_time = original_anchor
        tracker.state = TrackingState.ACTIVE
        tracker.last_activity_time = time.time()  # much newer — must be ignored

        tracker.enter_idle('screen still locked')

        tracker.session_manager.stop_current_timer.assert_called_once_with(
            end_time=original_anchor.isoformat())
        tracker.session_manager.trim_sessions_after.assert_called_once_with(
            original_anchor.isoformat())


# ---------------------------------------------------------------------------
# AC3 / AC4 — trim_sessions_after against a real SQLite table
# ---------------------------------------------------------------------------

class TestTrimSessionsAfter:
    def setup_method(self):
        self.db = _FakeDbManager()
        self.mgr = ActiveSessionManager(self.db)
        self.conn = self.db.get_connection()

    def test_ac3_sessions_born_after_cutoff_are_deleted(self):
        """A session whose first_seen >= anchor existed only inside the no-input
        window (auto-focus flip) — pure phantom, must be removed."""
        _insert_session(self.conn, 'phantom.py - Code', 'Code.exe', total=126,
                        first_seen=ANCHOR + timedelta(seconds=129),      # 05:57:57
                        last_seen=ANCHOR + timedelta(seconds=301))       # 06:00:49
        _insert_session(self.conn, 'real work - Code', 'Code2.exe', total=600,
                        first_seen=ANCHOR - timedelta(minutes=20),
                        last_seen=ANCHOR - timedelta(minutes=1))

        self.mgr.trim_sessions_after(_iso(ANCHOR))

        rows = _rows(self.conn)
        assert 'phantom.py - Code' not in rows, 'phantom session must be deleted'
        assert 'real work - Code' in rows, 'pre-anchor session must survive'

    def test_ac4_straddling_session_is_trimmed_to_cutoff(self):
        """A session that started before the anchor but was extended into the
        no-input window keeps only its pre-anchor time."""
        # 10 min of real work before the anchor + 5 phantom minutes after it.
        _insert_session(self.conn, 'main.py - Code', 'Code.exe',
                        total=900,                                       # 15 min banked
                        first_seen=ANCHOR - timedelta(minutes=10),
                        last_seen=ANCHOR + timedelta(minutes=5),
                        timer_started_at=ANCHOR - timedelta(minutes=2))

        self.mgr.trim_sessions_after(_iso(ANCHOR))

        row = _rows(self.conn)['main.py - Code']
        assert row['last_seen'] == _iso(ANCHOR)
        # 900 banked − 300 post-anchor = 600; never negative.
        assert row['total'] == pytest.approx(600, abs=1)
        assert row['timer'] is None

    def test_ac4_floor_at_zero_and_untouched_before_cutoff(self):
        _insert_session(self.conn, 'tiny', 'app.exe',
                        total=30,                                        # less than the span past cutoff
                        first_seen=ANCHOR - timedelta(seconds=10),
                        last_seen=ANCHOR + timedelta(minutes=4))
        _insert_session(self.conn, 'before', 'app2.exe', total=120,
                        first_seen=ANCHOR - timedelta(minutes=30),
                        last_seen=ANCHOR - timedelta(minutes=25))

        self.mgr.trim_sessions_after(_iso(ANCHOR))

        rows = _rows(self.conn)
        assert rows['tiny']['total'] == 0, 'floored at zero, not negative'
        assert rows['tiny']['last_seen'] == _iso(ANCHOR)
        assert rows['before']['total'] == 120, 'untouched'
        assert rows['before']['last_seen'] == _iso(ANCHOR - timedelta(minutes=25))

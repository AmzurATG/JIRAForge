"""
Test Suite: Idle / Office Hours Overcount — Screen-Lock Flap

Covers the fix in plan/2026-06-30_multi-component_fix-idle-overcount-lock-flap.md.

Root cause: while the workstation is locked, the OS "genuine input" clock
(GetLastInputInfo) reads low, so the resume safeguard falsely "resumes" every
~5 s. Each false resume emits a cumulative idle record from a frozen anchor and
the locked-screen guard re-anchors idle — producing dozens of overlapping rows
whose blind SUM(duration_seconds) inflates a single day past 24 h.

The fix:
  C1 — do not resume from idle while the screen is locked
       (_should_resume_from_idle / _process_idle_resume gate on _is_screen_locked).
  C2 — enter_idle() never re-anchors an already-open idle period.
  C3 — _create_idle_record is overlap-proof (emits only the non-overlapping
       increment for a given anchor).

RED phase: these tests fail until the new methods/guards exist.

Maps 1:1 to acceptance criteria AC1–AC6 in the plan.
"""

import pytest
from unittest.mock import Mock, MagicMock, patch
from datetime import datetime, timezone, timedelta
import time

import desktop_app as da
from desktop_app import TimeTracker, TrackingState


def _make_tracker():
    """A tracker with the collaborators _create_idle_record / resume paths touch,
    mocked so no network/DB/UI is exercised."""
    tracker = TimeTracker()
    tracker._finalize_active_session = Mock()
    tracker.session_manager = Mock()
    tracker.update_tray_icon = Mock()
    tracker.upload_activity_batch = Mock()
    tracker.add_admin_log = Mock()
    # Attributes read by _create_idle_record
    tracker.current_user_id = 'user-1'
    tracker.organization_id = 'org-1'
    tracker.app_version = '9.9.9'
    tracker.current_project_key = 'PROJ'
    tracker.idle_project_key = 'PROJ'
    tracker.user_issues = None
    tracker.get_user_project_key = Mock(return_value='PROJ')
    return tracker


class TestC1ResumeSafeguardGatedOnLock:
    """AC1 — the resume safeguard must not fire while the screen is locked."""

    def test_locked_screen_suppresses_resume_safeguard(self):
        """AC1: state IDLE + locked + low idle_duration → safeguard does NOT fire."""
        tracker = _make_tracker()
        tracker.state = TrackingState.IDLE
        tracker.is_idle = True
        tracker._is_screen_locked = Mock(return_value=True)

        # idle_duration (10s) is well under the threshold (300s) — the OS clock
        # reads low because the workstation is locked, not because the user is back.
        assert tracker._should_resume_from_idle(10, 300) is False

    def test_unlocked_screen_allows_resume_safeguard(self):
        """AC1 (converse): unlocked + low idle_duration → safeguard fires."""
        tracker = _make_tracker()
        tracker.state = TrackingState.IDLE
        tracker.is_idle = True
        tracker._is_screen_locked = Mock(return_value=False)

        assert tracker._should_resume_from_idle(10, 300) is True

    def test_high_idle_duration_never_resumes(self):
        """Still idle when genuine input is old, regardless of lock state."""
        tracker = _make_tracker()
        tracker.state = TrackingState.IDLE
        tracker.is_idle = True
        tracker._is_screen_locked = Mock(return_value=False)

        assert tracker._should_resume_from_idle(9999, 300) is False


class TestC1ResumeProcessingGatedOnLock:
    """AC2 — a set resume event must not be acted on while locked."""

    def test_locked_set_event_is_not_acted_on(self):
        """AC2: locked + event set → resume_from_idle not called, no idle record,
        state stays IDLE, and the event stays set (so a real unlock still resumes)."""
        tracker = _make_tracker()
        tracker.state = TrackingState.IDLE
        tracker.is_idle = True
        tracker.idle_start_time = datetime.now(timezone.utc) - timedelta(minutes=10)
        tracker._is_screen_locked = Mock(return_value=True)
        tracker.resume_from_idle = Mock()
        tracker._create_idle_record = Mock()
        tracker.idle_resume_event.set()

        resumed = tracker._process_idle_resume()

        assert resumed is False
        tracker.resume_from_idle.assert_not_called()
        tracker._create_idle_record.assert_not_called()
        assert tracker.state == TrackingState.IDLE
        assert tracker.idle_resume_event.is_set() is True

    def test_no_event_is_a_noop(self):
        """No pending signal → nothing happens."""
        tracker = _make_tracker()
        tracker.state = TrackingState.IDLE
        tracker._is_screen_locked = Mock(return_value=False)
        tracker.resume_from_idle = Mock()
        tracker.idle_resume_event.clear()

        assert tracker._process_idle_resume() is False
        tracker.resume_from_idle.assert_not_called()


class TestC1GenuineUnlockResumesOnce:
    """AC3 — lock, flap suppressed, then a real unlock emits exactly one record."""

    def test_flap_suppressed_then_unlock_emits_single_record(self):
        tracker = _make_tracker()
        tracker.state = TrackingState.ACTIVE
        # Locked ~10 minutes ago; anchor backdates to last genuine activity.
        tracker.last_activity_time = time.time() - 600

        locked = {'v': True}
        tracker._is_screen_locked = Mock(side_effect=lambda: locked['v'])

        # Lock → enter idle (anchor set once).
        tracker.enter_idle('screen lock')
        anchor = tracker.idle_start_time
        assert anchor is not None

        # Flap cycles while locked: the safeguard would set the event, but
        # processing must be suppressed — no resume, no idle record.
        for _ in range(3):
            tracker.idle_resume_event.set()
            assert tracker._process_idle_resume() is False
            assert len(tracker._pending_idle_records) == 0
            assert tracker.state == TrackingState.IDLE

        # Genuine unlock: screen no longer locked, event still set from the loop.
        locked['v'] = False
        tracker.idle_resume_event.set()
        resumed = tracker._process_idle_resume()

        assert resumed is True
        assert tracker.state == TrackingState.ACTIVE
        # Exactly ONE idle record for the whole locked span (not a cumulative cluster).
        assert len(tracker._pending_idle_records) == 1
        rec = tracker._pending_idle_records[0]
        assert rec['is_idle'] is True
        # Duration ≈ lock→unlock span (~600s), not multiplied by the flap count.
        assert 540 <= rec['duration_seconds'] <= 660


class TestC2NoReAnchor:
    """AC4 — enter_idle() must not overwrite an already-open idle anchor."""

    def test_second_enter_idle_when_already_idle_is_noop(self):
        tracker = _make_tracker()
        tracker.state = TrackingState.ACTIVE
        tracker.last_activity_time = time.time() - 100

        assert tracker.enter_idle('screen lock') is True
        anchor = tracker.idle_start_time
        assert anchor is not None

        # Second call while IDLE: rejected, anchor unchanged.
        assert tracker.enter_idle('screen lock again') is False
        assert tracker.idle_start_time == anchor

    def test_enter_idle_does_not_overwrite_open_anchor_even_from_active(self):
        """C2 defense-in-depth: if an anchor is already open, a fresh ACTIVE→IDLE
        transition must preserve it rather than re-anchor to a later time."""
        tracker = _make_tracker()
        existing_anchor = datetime.now(timezone.utc) - timedelta(minutes=10)
        tracker.idle_start_time = existing_anchor
        tracker.state = TrackingState.ACTIVE
        tracker.last_activity_time = time.time()  # a much later "now"

        tracker.enter_idle('re-anchor attempt')

        assert tracker.idle_start_time == existing_anchor


class TestC3OverlapProofIdleRecord:
    """AC5 — repeated emission from a fixed anchor is non-overlapping."""

    def _emit_at(self, tracker, anchor, now_dt):
        """Emit one idle record with datetime.now() pinned to now_dt."""
        tracker.idle_start_time = anchor
        fake = MagicMock(wraps=da.datetime)
        fake.now.return_value = now_dt
        with patch.object(da, 'datetime', fake):
            tracker._create_idle_record('idle timeout')

    def test_repeated_emissions_do_not_overlap(self):
        tracker = _make_tracker()
        anchor = datetime(2026, 6, 29, 13, 0, 0, tzinfo=timezone.utc)

        # 5 re-emissions from the SAME frozen anchor, clock advancing 100s each.
        for k in range(1, 6):
            self._emit_at(tracker, anchor, anchor + timedelta(seconds=100 * k))

        recs = tracker._pending_idle_records
        assert len(recs) >= 1

        # No record's [start,end] overlaps another (sorted by start).
        intervals = sorted(
            (datetime.fromisoformat(r['start_time']), datetime.fromisoformat(r['end_time']))
            for r in recs
        )
        for (s1, e1), (s2, e2) in zip(intervals, intervals[1:]):
            assert s2 >= e1, f"overlap: {e1} > {s2}"

        # Total queued idle ≤ real elapsed (500s), never the triangular sum
        # (100+200+300+400+500 = 1500s).
        total = sum(r['duration_seconds'] for r in recs)
        assert total <= 500 + 1  # +1s rounding tolerance
        assert total < 1500


class TestC3RegressionSingleIdle:
    """AC6 — a normal (unlocked) idle period still yields one correct record."""

    def test_single_idle_period_one_record(self):
        tracker = _make_tracker()
        tracker.idle_start_time = datetime.now(timezone.utc) - timedelta(seconds=600)

        tracker._create_idle_record('idle timeout')

        assert len(tracker._pending_idle_records) == 1
        rec = tracker._pending_idle_records[0]
        assert rec['is_idle'] is True
        assert 540 <= rec['duration_seconds'] <= 660

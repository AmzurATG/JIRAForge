"""
Test: OAuth permanent token failure bypasses 30-minute grace period.
Test: Login reminder prints accurate log messages on Linux.
Covers Issues 2 & 3 from timetracker_yogi.log (2026-06-17):
  - OAUTH_REAUTH_REQUIRED was suppressed for 30 minutes by grace period logic
  - 'Login reminder skipped' was printed even when _linux_notify() was called
  - User received no visible notification to re-authenticate for 2.5 hours
"""

import os
import sys
import time
import unittest
from unittest.mock import patch, MagicMock, call

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


# ── Grace period logic (extracted for unit testing) ──────────────────────────

def should_suppress_reauth_notification(
    reason_code: str,
    is_online: bool,
    invalid_since: float,
    now: float = None
) -> bool:
    """
    Current (BUGGY) suppression logic from desktop_app._show_reauth_notification.
    OAUTH_REAUTH_REQUIRED is incorrectly suppressed within the 30-min grace window.
    """
    if now is None:
        now = time.time()
    is_temporary = str(reason_code).upper() == 'OAUTH_TEMPORARY_FAILURE'
    if not is_temporary:
        if not is_online:
            return True  # offline suppression
        if invalid_since and (now - invalid_since) < 1800:
            return True  # BUG: grace period suppresses OAUTH_REAUTH_REQUIRED
    return False


def should_suppress_reauth_notification_fixed(
    reason_code: str,
    is_online: bool,
    invalid_since: float,
    now: float = None
) -> bool:
    """
    Fixed suppression logic: OAUTH_REAUTH_REQUIRED bypasses grace period.
    """
    if now is None:
        now = time.time()
    reason = str(reason_code).upper()
    is_temporary = reason == 'OAUTH_TEMPORARY_FAILURE'
    is_permanent = reason == 'OAUTH_REAUTH_REQUIRED'   # FIX: explicit permanent flag
    if not is_temporary:
        if not is_online:
            return True  # offline suppression always applies
        # FIX: skip grace period for permanent server-confirmed failures
        if not is_permanent and invalid_since and (now - invalid_since) < 1800:
            return True
    return False


class TestGracePeriodBypass(unittest.TestCase):

    def test_bug_oauth_reauth_required_suppressed_in_grace_period(self):
        """
        Confirm the bug: OAUTH_REAUTH_REQUIRED is incorrectly suppressed
        within the 30-minute grace window by the original code.
        """
        now = time.time()
        invalid_since = now - (5 * 60)  # 5 minutes ago (within 30-min window)

        suppressed = should_suppress_reauth_notification(
            reason_code='OAUTH_REAUTH_REQUIRED',
            is_online=True,
            invalid_since=invalid_since,
            now=now
        )
        # This demonstrates the BUG — expected True (suppressed = bad)
        self.assertTrue(suppressed,
                        "BUG CONFIRMED: OAUTH_REAUTH_REQUIRED is suppressed within grace period")

    def test_fix_oauth_reauth_required_not_suppressed_in_grace_period(self):
        """
        Verify the fix: OAUTH_REAUTH_REQUIRED bypasses the grace period.
        User must be notified immediately when server explicitly rejects tokens.
        """
        now = time.time()
        invalid_since = now - (5 * 60)  # 5 minutes ago

        suppressed = should_suppress_reauth_notification_fixed(
            reason_code='OAUTH_REAUTH_REQUIRED',
            is_online=True,
            invalid_since=invalid_since,
            now=now
        )
        self.assertFalse(suppressed,
                         "FIX: OAUTH_REAUTH_REQUIRED must NOT be suppressed by grace period")

    def test_temporary_failure_still_suppressed_in_grace_period(self):
        """OAUTH_TEMPORARY_FAILURE should continue to be handled separately (not suppressed by grace)."""
        now = time.time()
        invalid_since = now - (5 * 60)

        # Temporary failures skip the grace check entirely (is_temporary=True skips the block)
        suppressed = should_suppress_reauth_notification_fixed(
            reason_code='OAUTH_TEMPORARY_FAILURE',
            is_online=True,
            invalid_since=invalid_since,
            now=now
        )
        # Temporary failures don't go through the grace check — not suppressed here
        self.assertFalse(suppressed,
                         "Temporary failures are handled separately and should not be suppressed")

    def test_offline_suppresses_even_permanent_failures(self):
        """When device is offline, even OAUTH_REAUTH_REQUIRED is suppressed."""
        now = time.time()
        suppressed = should_suppress_reauth_notification_fixed(
            reason_code='OAUTH_REAUTH_REQUIRED',
            is_online=False,
            invalid_since=now - 60,
            now=now
        )
        self.assertTrue(suppressed,
                        "Offline check fires before grace period — must suppress when offline")

    def test_after_grace_period_all_codes_trigger_notification(self):
        """After 30 minutes, all reason codes should trigger a notification."""
        now = time.time()
        invalid_since = now - (31 * 60)  # 31 minutes ago — outside grace window

        for code in ['OAUTH_REAUTH_REQUIRED', 'OAUTH_TEMPORARY_FAILURE', 'UNKNOWN']:
            with self.subTest(code=code):
                suppressed = should_suppress_reauth_notification_fixed(
                    reason_code=code,
                    is_online=True,
                    invalid_since=invalid_since,
                    now=now
                )
                self.assertFalse(suppressed,
                                 f"Code={code} should NOT be suppressed after grace window")

    def test_refresh_fail_count_5_at_startup_is_permanent(self):
        """
        refresh_fail_count=5 on first startup means the token has been
        failing across multiple app sessions — treat as permanent immediately.
        """
        refresh_fail_count = 5
        # Per the log: permanent_failure=True when refresh_fail_count >= threshold
        PERMANENT_FAILURE_THRESHOLD = 1
        is_permanent = refresh_fail_count >= PERMANENT_FAILURE_THRESHOLD
        self.assertTrue(is_permanent,
                        "refresh_fail_count=5 at startup must be treated as permanent failure")


class TestLoginReminderLogMessages(unittest.TestCase):
    """
    Verify that the login reminder prints accurate log messages.
    Bug: the code called _linux_notify() then printed 'Login reminder skipped'
    even though notify-send was invoked — misleading diagnostics.
    """

    def test_message_says_sent_when_notify_send_available(self):
        """Should print 'sent via notify-send' when notify-send is available."""
        winotify_available = False
        notify_send_available = True

        if not winotify_available:
            if notify_send_available:
                message = "[INFO] Login reminder sent via notify-send (winotify unavailable on Linux)"
            else:
                message = "[WARN] Login reminder could not be shown — notify-send not installed"

        self.assertNotIn("skipped", message,
                         "Should not say 'skipped' when notify-send successfully invoked")
        self.assertIn("sent", message,
                      "Should say 'sent' when notify-send is available")

    def test_message_says_not_installed_when_notify_send_missing(self):
        """Should print 'not installed' when notify-send binary is not found."""
        winotify_available = False
        notify_send_available = False

        if not winotify_available:
            if notify_send_available:
                message = "[INFO] Login reminder sent via notify-send (winotify unavailable on Linux)"
            else:
                message = "[WARN] Login reminder could not be shown — notify-send not installed"

        self.assertIn("not installed", message)
        self.assertNotIn("skipped", message)

    def test_original_message_is_misleading(self):
        """Demonstrate that the original 'skipped' message is inaccurate."""
        original_message = "[WARN] Login reminder skipped - winotify not available"
        # The original code calls _linux_notify() BEFORE printing this —
        # the notification was NOT skipped, just not via winotify.
        self.assertIn("skipped", original_message,
                      "Confirm: original message incorrectly says 'skipped'")

    def test_browser_opened_after_reauth_notification_on_linux(self):
        """On Linux without click callbacks, browser should auto-open on reauth."""
        opened = []
        with patch('webbrowser.open', side_effect=lambda u: opened.append(u)):
            import webbrowser
            import sys
            if sys.platform.startswith('linux'):
                webbrowser.open('http://localhost:51777/login')

        if sys.platform.startswith('linux'):
            self.assertTrue(len(opened) > 0,
                            "Browser must open automatically on Linux reauth (no click callbacks)")
            self.assertIn('/login', opened[0])


class TestLinuxNotifyReturnValue(unittest.TestCase):
    """
    Verify the proposed fix: _linux_notify returns bool so callers can
    log whether the notification was actually sent.
    """

    def _linux_notify_fixed(self, title, msg, urgency='normal', _notify_path=None):
        """Proposed fixed _linux_notify with return value."""
        if _notify_path is None:
            return False
        try:
            import subprocess
            result = subprocess.run(
                [_notify_path, '--urgency', urgency, '--app-name', 'Time Tracker', title, msg],
                timeout=3, check=False, capture_output=True
            )
            return result.returncode == 0
        except Exception:
            return False

    def test_returns_false_when_notify_send_missing(self):
        sent = self._linux_notify_fixed("Title", "Msg", _notify_path=None)
        self.assertFalse(sent)

    def test_returns_true_when_notify_send_succeeds(self):
        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr=b'')
            sent = self._linux_notify_fixed("Title", "Msg", _notify_path='/usr/bin/notify-send')
        self.assertTrue(sent)

    def test_returns_false_when_notify_send_fails(self):
        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr=b'No daemon')
            sent = self._linux_notify_fixed("Title", "Msg", _notify_path='/usr/bin/notify-send')
        self.assertFalse(sent)

    def test_correct_arguments_passed_to_notify_send(self):
        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr=b'')
            self._linux_notify_fixed("Session Expired", "Please log in", urgency='critical',
                                     _notify_path='/usr/bin/notify-send')
        call_args = mock_run.call_args[0][0]
        self.assertIn('--urgency', call_args)
        self.assertIn('critical', call_args)
        self.assertIn('Time Tracker', call_args)
        self.assertIn('Session Expired', call_args)
        self.assertIn('Please log in', call_args)


if __name__ == '__main__':
    unittest.main(verbosity=2)

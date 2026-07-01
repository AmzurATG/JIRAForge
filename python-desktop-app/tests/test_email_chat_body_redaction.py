"""
Test Suite: Email / Chat Body Redaction (Gmail, Google Chat, Outlook)

Covers plan/EMAIL_CHAT_BODY_REDACTION.md.

Behaviour under test: on Gmail / Google Chat / Outlook the desktop tracker
never reads the on-screen body. It skips screen capture/OCR entirely and stores
the body as the literal mask '***' (ocr_method='redacted_body'), while the
window title is still captured and the activity is still tracked. Every other
app is unchanged (screen text is OCR'd as before).

These tests exercise the REAL shipped code: they import desktop_app and drive
the actual TimeTracker._should_redact_body and process_window_event.

Run:
    python -m pytest tests/test_email_chat_body_redaction.py -v   # from python-desktop-app/
    python tests/test_email_chat_body_redaction.py                # proof report
"""

import os
import sys
from unittest.mock import Mock

import pytest

# Make desktop_app importable when this file is run directly (python tests/...),
# not just under `python -m pytest` from the app dir.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import desktop_app as da
from desktop_app import (
    TimeTracker,
    REDACTED_BODY_PLACEHOLDER,
    REDACTED_BODY_TITLE_MARKERS,
    REDACTED_BODY_PROCESSES,
)


def _bare_tracker():
    """A TimeTracker built without __init__ (no network/UI/OCR startup), wired
    with just the collaborators process_window_event touches, all mocked."""
    t = TimeTracker.__new__(TimeTracker)
    t.classification_manager = Mock()
    t.session_manager = Mock()
    t.ocr_processor = Mock()
    t.offline_manager = Mock()
    t.offline_manager.is_online = True
    t._unknown_apps_classified = set()
    return t


# --------------------------------------------------------------------------- #
# Decision level — _should_redact_body (real helper, no instance state)
# --------------------------------------------------------------------------- #

class TestShouldRedactBodyDecision:
    def test_placeholder_is_masked(self):
        assert REDACTED_BODY_PLACEHOLDER == '***'

    def test_target_surfaces_are_configured(self):
        # Gmail, Google Chat, Outlook web markers present; Outlook desktop procs present.
        markers = ' '.join(REDACTED_BODY_TITLE_MARKERS)
        assert 'gmail' in markers
        assert 'google chat' in markers
        assert 'outlook' in markers
        assert 'outlook.exe' in REDACTED_BODY_PROCESSES

    @pytest.mark.parametrize("app_name, window_title", [
        ('chrome.exe', 'Inbox (2) - Gmail'),
        ('msedge.exe', 'mail.google.com/mail'),
        ('chrome.exe', 'Team standup - Google Chat'),
        ('firefox.exe', 'chat.google.com'),
        ('msedge.exe', 'Calendar - Outlook'),
        ('outlook.exe', 'Whatever the title is'),
        ('hxoutlook.exe', ''),
        ('OLK.EXE', 'Mail'),                 # case-insensitive process match
    ])
    def test_email_chat_surfaces_are_redacted(self, app_name, window_title):
        t = TimeTracker.__new__(TimeTracker)  # no instance state needed
        assert t._should_redact_body(app_name, window_title) is True

    @pytest.mark.parametrize("app_name, window_title", [
        ('Code.exe', 'desktop_app.py - Visual Studio Code'),
        ('chrome.exe', 'AmzurATG/JIRAForge - GitHub'),   # browser, no mail/chat marker
        ('chrome.exe', 'How to write Python - Stack Overflow'),
        ('slack.exe', 'general - Slack'),                # not in scope (follow-up)
        ('notepad.exe', 'Untitled - Notepad'),
    ])
    def test_normal_apps_are_not_redacted(self, app_name, window_title):
        t = TimeTracker.__new__(TimeTracker)
        assert t._should_redact_body(app_name, window_title) is False

    @pytest.mark.parametrize("app_name, window_title", [
        ('', ''),
        (None, None),
        ('chrome.exe', None),      # browser, missing title → no marker → not redacted
        (None, 'Inbox - Gmail'),   # missing app → not a known surface
    ])
    def test_empty_and_none_inputs_are_safe(self, app_name, window_title):
        t = TimeTracker.__new__(TimeTracker)
        assert t._should_redact_body(app_name, window_title) is False


# --------------------------------------------------------------------------- #
# End-to-end — process_window_event stores the mask, keeps title, skips capture
# --------------------------------------------------------------------------- #

class TestProcessWindowEventRedaction:
    def _capture_on_window_switch(self, tracker):
        """Return (display_title, app_name, classification, ocr_result) passed to
        session_manager.on_window_switch."""
        assert tracker.session_manager.on_window_switch.called, "session was never created"
        args, _ = tracker.session_manager.on_window_switch.call_args
        return args

    def test_gmail_browser_body_redacted_title_kept_no_capture(self):
        t = _bare_tracker()
        # Classified productive — the redaction override must still kick in.
        t.classification_manager.classify = Mock(return_value=('productive', 'exact'))
        title = 'Inbox - Gmail'
        t.process_window_event({'app': 'chrome.exe', 'title': title})

        display_title, app_name, classification, ocr_result = self._capture_on_window_switch(t)
        assert ocr_result['text'] == '***'
        assert ocr_result['method'] == 'redacted_body'
        assert app_name == 'chrome.exe'
        assert display_title == title                       # title preserved
        # No screen was ever captured for this surface.
        t.ocr_processor.capture_screenshot_only.assert_not_called()
        t.ocr_processor.submit_ocr_async.assert_not_called()

    def test_outlook_desktop_body_redacted(self):
        t = _bare_tracker()
        t.classification_manager.classify = Mock(return_value=('unknown', 'none'))
        t.process_window_event({'app': 'outlook.exe', 'title': 'Inbox - Outlook'})

        _, app_name, _, ocr_result = self._capture_on_window_switch(t)
        assert app_name == 'outlook.exe'
        assert ocr_result['text'] == '***'
        assert ocr_result['method'] == 'redacted_body'
        t.ocr_processor.capture_screenshot_only.assert_not_called()

    def test_normal_app_is_not_redacted_and_capture_runs(self):
        t = _bare_tracker()
        t.classification_manager.classify = Mock(return_value=('productive', 'exact'))
        # No screenshot returned → keeps the test off the async-OCR path.
        t.ocr_processor.capture_screenshot_only = Mock(
            return_value={'screenshot': None, 'throttled': False}
        )
        t.process_window_event({'app': 'Code.exe', 'title': 'desktop_app.py - VS Code'})

        display_title, app_name, classification, ocr_result = self._capture_on_window_switch(t)
        assert app_name == 'Code.exe'
        # Not masked — a normal app records ocr_result=None here (real text arrives via OCR).
        assert ocr_result is None
        # Capture WAS attempted for the normal app.
        t.ocr_processor.capture_screenshot_only.assert_called()


# --------------------------------------------------------------------------- #
# Human-readable proof report (run the file directly)
# --------------------------------------------------------------------------- #

def _run_proof():
    checks = []

    def check(name, cond):
        checks.append((name, bool(cond)))

    t = TimeTracker.__new__(TimeTracker)
    check("placeholder == '***'", REDACTED_BODY_PLACEHOLDER == '***')
    check("Gmail (chrome) redacted", t._should_redact_body('chrome.exe', 'Inbox - Gmail'))
    check("Google Chat (edge) redacted", t._should_redact_body('msedge.exe', 'x - Google Chat'))
    check("Outlook web (chrome) redacted", t._should_redact_body('chrome.exe', 'Mail - Outlook'))
    check("Outlook desktop redacted", t._should_redact_body('outlook.exe', 'anything'))
    check("VS Code NOT redacted", not t._should_redact_body('Code.exe', 'a.py - VS Code'))
    check("GitHub tab NOT redacted", not t._should_redact_body('chrome.exe', 'repo - GitHub'))
    check("empty inputs safe", not t._should_redact_body('', ''))

    et = _bare_tracker()
    et.classification_manager.classify = Mock(return_value=('productive', 'exact'))
    et.process_window_event({'app': 'chrome.exe', 'title': 'Inbox - Gmail'})
    args, _ = et.session_manager.on_window_switch.call_args
    _, _, _, ocr_result = args
    check("e2e: body stored as '***'", ocr_result and ocr_result['text'] == '***')
    check("e2e: method redacted_body", ocr_result and ocr_result['method'] == 'redacted_body')
    check("e2e: no screen capture", not et.ocr_processor.capture_screenshot_only.called)

    print("\n  Email/Chat Body Redaction — proof report")
    print("  " + "-" * 44)
    passed = 0
    for name, ok in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
        passed += ok
    total = len(checks)
    print("  " + "-" * 44)
    verdict = 'PASS' if passed == total else 'FAIL'
    print(f"  VERDICT: {verdict} ({passed}/{total})")
    return passed == total


if __name__ == '__main__':
    sys.exit(0 if _run_proof() else 1)

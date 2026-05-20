"""
Tests for reason-specific authentication notification text.

Reference:
plan/2026-05-20_python-desktop-app_reason-specific-auth-notification.md
"""

import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from desktop_app import TimeTracker


def _make_tracker():
    tracker = TimeTracker.__new__(TimeTracker)
    tracker._reauth_notification_last_shown = 0
    tracker._auth_temp_notification_last_shown = 0
    return tracker


@patch("desktop_app.WINOTIFY_AVAILABLE", True)
@patch("desktop_app.Notification")
@patch("desktop_app.audio")
def test_temporary_auth_notification_text(mock_audio, mock_notification_cls):
    tracker = _make_tracker()
    mock_audio.Default = "default"
    mock_notification = MagicMock()
    mock_notification_cls.return_value = mock_notification

    with patch("desktop_app.time.time", return_value=1000):
        tracker._show_reauth_notification("OAUTH_TEMPORARY_FAILURE")

    kwargs = mock_notification_cls.call_args.kwargs
    assert kwargs["title"] == "Authentication Issue"
    assert "retry" in kwargs["msg"].lower()
    assert "log in again" not in kwargs["msg"].lower()


@patch("desktop_app.WINOTIFY_AVAILABLE", True)
@patch("desktop_app.Notification")
@patch("desktop_app.audio")
def test_reauth_required_notification_text(mock_audio, mock_notification_cls):
    tracker = _make_tracker()
    mock_audio.Default = "default"
    mock_notification = MagicMock()
    mock_notification_cls.return_value = mock_notification

    with patch("desktop_app.time.time", return_value=1000):
        tracker._show_reauth_notification("OAUTH_REAUTH_REQUIRED")

    kwargs = mock_notification_cls.call_args.kwargs
    assert kwargs["title"] == "Authentication Expired"
    assert "log in again" in kwargs["msg"].lower()


@patch("desktop_app.WINOTIFY_AVAILABLE", True)
@patch("desktop_app.Notification")
@patch("desktop_app.audio")
def test_default_notification_text_remains_reauth(mock_audio, mock_notification_cls):
    tracker = _make_tracker()
    mock_audio.Default = "default"
    mock_notification = MagicMock()
    mock_notification_cls.return_value = mock_notification

    with patch("desktop_app.time.time", return_value=1000):
        tracker._show_reauth_notification()

    kwargs = mock_notification_cls.call_args.kwargs
    assert kwargs["title"] == "Authentication Expired"
    assert "log in again" in kwargs["msg"].lower()

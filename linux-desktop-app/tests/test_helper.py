"""
Tests for the session helper (real subprocess on the system Python, with a
GStreamer test source instead of the portal) and its client-side backends.

Spec: implementation plan §5.3, §6.4.5 (portal ScreenCast), §6.3 (AT-SPI).
"""

import os
import subprocess
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from timetracker_linux.capture.result import CaptureStatus
from timetracker_linux.capture.validator import FrameValidator
from timetracker_linux.helper_client import (AtspiWindow, HelperClient, HelperError,
                                             PermissionPrompter, PortalScreenCastCapture, TokenStore,
                                             system_python)


def _system_gst_available():
    python = system_python()
    if not python:
        return False
    code = "import gi; gi.require_version('Gst','1.0'); from gi.repository import Gst; Gst.init(None); " \
           "assert Gst.ElementFactory.find('videotestsrc') and Gst.ElementFactory.find('appsink')"
    return subprocess.run([python, '-c', code], capture_output=True).returncode == 0


needs_helper = pytest.mark.skipif(not _system_gst_available(), reason='system python3-gi + GStreamer needed')

WINDOW = {'window_id': 'w1', 'monitor_rect': (0, 0, 640, 480), 'monitor_name': 'm0', 'minimized': False}


class MemoryTokens:
    def __init__(self, token=None):
        self.token = token
        self.saved = []

    def get(self):
        return self.token

    def set(self, token):
        self.token = token
        self.saved.append(token)


@pytest.fixture
def helper():
    client = HelperClient(extra_args=['--test-source'])
    yield client
    client.close()


@needs_helper
def test_ping_runs_on_system_python(helper):
    header, _ = helper.request('ping', timeout=10)
    assert header['ok'] is True
    assert header['pid'] != os.getpid()


@needs_helper
def test_no_token_non_interactive_is_denied_without_dialog(helper):
    permission = Mock()
    backend = PortalScreenCastCapture(helper, lambda: dict(WINDOW), tokens=MemoryTokens(None),
                                      on_permission_needed=permission)
    result = backend.capture()
    assert result.status == CaptureStatus.DENIED
    permission.assert_called_once_with(backend)


@needs_helper
def test_stream_frames_and_token_saved(helper):
    tokens = MemoryTokens('previous-token')
    backend = PortalScreenCastCapture(helper, lambda: dict(WINDOW), tokens=tokens)
    result = backend.capture()
    assert result.status == CaptureStatus.OK, result.detail
    assert result.image.size == (640, 480)
    assert FrameValidator().check(result.image) == CaptureStatus.OK
    assert tokens.saved == ['test-token']       # newest token always stored
    second = backend.capture()                  # reuses the running stream
    assert second.status == CaptureStatus.OK
    backend.stop()


@needs_helper
def test_unknown_monitor_is_skipped(helper):
    backend = PortalScreenCastCapture(helper, lambda: dict(WINDOW, monitor_rect=(5000, 0, 100, 100)),
                                      tokens=MemoryTokens('t'))
    assert backend.capture().status == CaptureStatus.SKIPPED_UNKNOWN_MONITOR
    backend.stop()


@needs_helper
def test_single_monitor_used_only_when_known_single(helper):
    backend = PortalScreenCastCapture(helper, lambda: dict(WINDOW, monitor_rect=None),
                                      monitor_count_reader=lambda: 2, tokens=MemoryTokens('t'))
    assert backend.capture().status == CaptureStatus.SKIPPED_UNKNOWN_MONITOR
    backend = PortalScreenCastCapture(helper, lambda: dict(WINDOW, monitor_rect=None),
                                      monitor_count_reader=lambda: 1, tokens=MemoryTokens('t'))
    assert backend.capture().status == CaptureStatus.OK
    backend.stop()


@needs_helper
def test_helper_crash_is_restarted(helper):
    helper.request('ping', timeout=10)
    helper._proc.kill()
    helper._proc.wait()
    header, _ = helper.request('ping', timeout=10)
    assert header['ok'] is True


def test_restart_limit():
    client = HelperClient(python='/bin/false', script='/nonexistent')
    for _ in range(3):
        with pytest.raises(HelperError):
            client.request('ping', timeout=1)
    with pytest.raises(HelperError, match='giving up'):
        client.request('ping', timeout=1)


def test_no_system_python():
    client = HelperClient(python=None)
    client._python = None
    with pytest.raises(HelperError, match='no system python3'):
        client.request('ping')


# ------------------------------------------------------------- permission

def test_permission_notice_once_per_day(tmp_path):
    sent = []
    now = [1000.0]
    notifier = SimpleNamespace(notify=lambda title, message, **kw: sent.append(kw['actions'][0][0]))
    prompter = PermissionPrompter(lambda: notifier, state_path=str(tmp_path / 'notice'), clock=lambda: now[0])
    backend = Mock()
    assert prompter(backend) is True
    assert prompter(backend) is False
    now[0] += 24 * 3600 + 1
    assert prompter(backend) is True
    assert sent == ['Allow', 'Allow']


def test_token_store_file_fallback(tmp_path, monkeypatch):
    import keyring
    monkeypatch.setattr(keyring, 'get_password', Mock(side_effect=RuntimeError('no keyring')))
    monkeypatch.setattr(keyring, 'set_password', Mock(side_effect=RuntimeError('no keyring')))
    store = TokenStore(str(tmp_path / 'cfg' / 'token'))
    store.set('abc')
    assert store.get() == 'abc'
    assert oct(os.stat(tmp_path / 'cfg' / 'token').st_mode & 0o777) == '0o600'


# ------------------------------------------------------------------ AT-SPI

def test_atspi_window_mapping():
    helper = SimpleNamespace(request=lambda cmd, timeout: (
        {'ok': True, 'window': {'title': 'Board - Jira', 'app_name': 'Firefox', 'pid': 55}}, b''),
        probe=lambda: {'atspi': True})
    window = AtspiWindow(helper).focused_window()
    assert window['title'] == 'Board - Jira'
    assert window['wm_class'] == 'firefox'
    assert window['pid'] == 55


def test_atspi_no_active_window():
    helper = SimpleNamespace(request=lambda cmd, timeout: ({'ok': True, 'window': None}, b''),
                             probe=lambda: {'atspi': True})
    assert AtspiWindow(helper).focused_window() is None

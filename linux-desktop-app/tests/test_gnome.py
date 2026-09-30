"""
Unit tests for the GNOME extension client and setup (the real extension is
exercised by gnome-extension/tests/run_headless_test.sh).

Spec: implementation plan §6.4.2, §7.
"""

import io
import os

from PIL import Image

from fakes import FakeBus
from timetracker_linux.capture.result import CaptureStatus
from timetracker_linux.dbus_bus import DBusCallError
from timetracker_linux.gnome.extension_client import (INTERFACE, GnomeExtensionCapture,
                                                      GnomeExtensionClient, window_from_extension)
from timetracker_linux.gnome.setup import EXTENSIONS, ExtensionSetup

SHELL = 'org.gnome.Shell'

INFO = {'focused': ('b', True), 'title': ('s', 'PROJ-3 - Jira'), 'wm_class': ('s', 'firefox'),
        'app_id': ('s', 'firefox'), 'pid': ('i', 321), 'window_id': ('s', '17'),
        'monitor_index': ('i', 1), 'monitor_x': ('i', 1920), 'monitor_y': ('i', 0),
        'monitor_width': ('i', 2560), 'monitor_height': ('i', 1440), 'scale': ('d', 1.5),
        'minimized': ('b', False), 'locked': ('b', False), 'overview': ('b', False)}


def _png_bytes(size=(64, 40)):
    buffer = io.BytesIO()
    img = Image.new('RGB', size, 'white')
    img.putpixel((3, 3), (0, 0, 0))
    img.save(buffer, format='PNG')
    return buffer.getvalue()


def test_window_mapping():
    from timetracker_linux.gnome.extension_client import unpack
    window = window_from_extension(unpack(INFO))
    assert window['window_id'] == 'gnome:17'
    assert window['title'] == 'PROJ-3 - Jira'
    assert window['pid'] == 321
    assert window['monitor_rect'] == (1920, 0, 2560, 1440)
    assert window['scale'] == 1.5


def test_unfocused_or_locked_is_none():
    from timetracker_linux.gnome.extension_client import unpack
    assert window_from_extension(unpack(dict(INFO, focused=('b', False)))) is None
    assert window_from_extension(unpack(dict(INFO, locked=('b', True)))) is None


def test_version_and_recheck():
    now = [0.0]
    bus = FakeBus(answers={(SHELL, INTERFACE, 'GetVersion'): RuntimeError('UnknownObject')})
    client = GnomeExtensionClient(bus, clock=lambda: now[0])
    assert client.available() is False
    bus.answers[(SHELL, INTERFACE, 'GetVersion')] = (1, '1.0.0', '46.0')
    assert client.available() is False          # cached negative for 5 s
    now[0] = 5.1
    assert client.available() is True
    client.forget()
    bus.answers[(SHELL, INTERFACE, 'GetVersion')] = (2, '2.0.0', '50.0')
    assert client.available() is False          # incompatible protocol


def _capture(reply):
    def answer(args):
        fd = args[0]
        if isinstance(reply, dict) and reply.get('status') == ('s', 'ok'):
            os.write(fd, _png_bytes())
        if isinstance(reply, Exception):
            raise reply
        return (reply,)

    bus = FakeBus(answers={(SHELL, INTERFACE, 'GetVersion'): (1, '1', '46'),
                           (SHELL, INTERFACE, 'CaptureFocusedMonitor'): answer})
    client = GnomeExtensionClient(bus)
    window = {'window_id': 'gnome:17', 'minimized': False}
    return GnomeExtensionCapture(client, lambda: dict(window)).capture()


def test_capture_reads_png_from_memfd():
    result = _capture({'status': ('s', 'ok'), 'window_id': ('s', '17'), 'monitor_index': ('i', 1),
                       'scale': ('d', 1.0)})
    assert result.status == CaptureStatus.OK
    assert result.image.size == (64, 40)
    assert result.window_id == 'gnome:17'


def test_capture_status_mapping():
    assert _capture({'status': ('s', 'locked')}).status == CaptureStatus.SKIPPED_LOCKED
    assert _capture({'status': ('s', 'rate_limited')}).status == CaptureStatus.SKIPPED_RATE_LIMITED
    assert _capture({'status': ('s', 'no_focus')}).status == CaptureStatus.SKIPPED_NO_FOCUS
    denied = DBusCallError('denied', name='com.amzur.TimeTracker.Error.AccessDenied')
    assert _capture(denied).status == CaptureStatus.DENIED
    gone = DBusCallError('gone', name='org.freedesktop.DBus.Error.UnknownMethod')
    assert _capture(gone).status == CaptureStatus.BACKEND_UNAVAILABLE


def test_capture_closes_memfd():
    before = len(os.listdir('/proc/self/fd'))
    for _ in range(20):
        _capture({'status': ('s', 'ok'), 'window_id': ('s', '17')})
    assert len(os.listdir('/proc/self/fd')) <= before + 1


# -------------------------------------------------------------------- setup

class Notifier:
    def __init__(self):
        self.sent = []

    def notify(self, title, message, **kw):
        self.sent.append(title)


def _setup(tmp_path, info, user_enabled=True, enable_result=None):
    answers = {(EXTENSIONS[0], EXTENSIONS[2], 'GetExtensionInfo'): info}
    if enable_result is not None:
        answers[(EXTENSIONS[0], EXTENSIONS[2], 'EnableExtension')] = enable_result
    bus = FakeBus(answers=answers,
                  properties={(EXTENSIONS[0], EXTENSIONS[2], 'UserExtensionsEnabled'): user_enabled})
    notifier = Notifier()
    return ExtensionSetup(bus, notifier=notifier, config_dir=str(tmp_path)), bus, notifier


def test_setup_enabled(tmp_path):
    setup, _, notifier = _setup(tmp_path, ({'state': ('d', 1.0)},))
    assert setup.ensure_enabled() == 'ENABLED'
    assert notifier.sent == []


def test_setup_enables_disabled_extension(tmp_path):
    states = iter([({'state': ('d', 2.0)},), ({'state': ('d', 1.0)},)])
    setup, bus, _ = _setup(tmp_path, lambda args: next(states), enable_result=(True,))
    assert setup.ensure_enabled() == 'ENABLED'
    assert any(c[3] == 'EnableExtension' for c in bus.calls)


def test_setup_policy_block_told_once(tmp_path):
    setup, _, notifier = _setup(tmp_path, ({},), user_enabled=False)
    assert setup.ensure_enabled() == 'BLOCKED_BY_POLICY'
    setup.ensure_enabled()
    assert notifier.sent == ['Screen text capture needs a GNOME extension']


def test_setup_needs_relogin_when_files_installed(tmp_path, monkeypatch):
    monkeypatch.setattr(ExtensionSetup, '_files_installed', staticmethod(lambda: True))
    setup, _, notifier = _setup(tmp_path, ({},))
    assert setup.ensure_enabled() == 'NEEDS_RELOGIN'
    assert notifier.sent == ['Finish TimeTracker setup']

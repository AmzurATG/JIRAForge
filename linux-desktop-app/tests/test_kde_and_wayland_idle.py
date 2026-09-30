"""
Tests for KDE (KWin script focus, ScreenShot2 capture) and the pure-Python
Wayland ext-idle-notify client (against a fake compositor socket).

Spec: implementation plan §6.3, §6.4.3, §6.6 (phase 5).
"""

import os
import socket
import struct
import threading
import time

import pytest

from fakes import FakeBus, FakeMessage
from timetracker_linux.capture.result import CaptureStatus
from timetracker_linux.dbus_bus import DBusCallError, DBusMethodError
from timetracker_linux.kde.kwin_screenshot import SCREENSHOT, KWinCapture, image_from_raw
from timetracker_linux.kde.kwin_script import (OBJECT_PATH, SCRIPTING, KWinFocusService,
                                               KWinScriptWindow, window_from_call)
from timetracker_linux import wayland_idle as wi

KWIN_OWNER = ':1.10'
FOCUS_ARGS = ('PROJ-5 review - Konsole', 'konsole', 'org.kde.konsole', 777, '{abc-123}', 'DP-1',
              1920, 0, 2560, 1440, 1.25, False)


def _kwin_bus(script_loaded=False, run_path='/Scripting/Script7'):
    def run(args):
        return ()

    answers = {
        ('org.kde.KWin', 'org.kde.kwin.Scripting', 'isScriptLoaded'): (script_loaded,),
        ('org.kde.KWin', 'org.kde.kwin.Scripting', 'unloadScript'): (True,),
        ('org.kde.KWin', 'org.kde.kwin.Scripting', 'loadScript'): (7,),
        ('org.kde.KWin', 'org.kde.kwin.Script', 'run'): run,
        ('org.freedesktop.DBus', 'org.freedesktop.DBus', 'GetNameOwner'): (KWIN_OWNER,),
    }
    return FakeBus(answers=answers, owners={'org.kde.KWin'})


# ---------------------------------------------------------------- KWin focus

def test_window_from_call():
    window = window_from_call(FOCUS_ARGS)
    assert window['window_id'] == 'kwin:{abc-123}'
    assert window['wm_class'] == 'konsole'
    assert window['pid'] == 777
    assert window['monitor_rect'] == (1920, 0, 2560, 1440)
    assert window['scale'] == 1.25


def test_no_focus_report_is_none():
    assert window_from_call(('', '', '', 0, '', '', 0, 0, 0, 0, 1.0, False)) is None


def test_load_script_and_accept_kwin_calls():
    bus = _kwin_bus(script_loaded=True)
    service = KWinFocusService(bus)
    assert service.ensure_loaded() is True
    members = [c[3] for c in bus.calls]
    assert members.index('unloadScript') < members.index('loadScript') < members.index('run')
    assert 'com.amzur.TimeTracker' in bus.owners
    bus.exports[OBJECT_PATH](FakeMessage(FOCUS_ARGS, member='FocusChanged', sender=KWIN_OWNER))
    assert KWinScriptWindow(service).focused_window()['title'] == 'PROJ-5 review - Konsole'


def test_calls_from_other_processes_rejected():
    bus = _kwin_bus()
    service = KWinFocusService(bus)
    service.ensure_loaded()
    with pytest.raises(DBusMethodError):
        bus.exports[OBJECT_PATH](FakeMessage(FOCUS_ARGS, member='FocusChanged', sender=':1.66'))
    assert service.focused_window() is None


def test_no_kwin_no_load():
    bus = FakeBus()
    assert KWinFocusService(bus).ensure_loaded() is False


# ------------------------------------------------------------ ScreenShot2

def _screenshot_bus(results=None, error=None, frame=b''):
    def capture(args):
        options, fd = args
        assert options['include-cursor'] == ('b', False)
        assert options['native-resolution'] == ('b', True)
        if error:
            raise error
        writer = os.dup(fd)
        threading.Thread(target=lambda: (os.write(writer, frame), os.close(writer)), daemon=True).start()
        return (results,)

    return FakeBus(answers={(SCREENSHOT[0], SCREENSHOT[2], 'CaptureActiveScreen'): capture},
                   properties={(SCREENSHOT[0], SCREENSHOT[2], 'Version'): 4})


WINDOW = {'window_id': 'kwin:1', 'monitor_name': 'DP-1', 'minimized': False}


def test_capture_active_screen_bgra_with_stride():
    width, height, stride = 4, 3, 20      # 4 bytes of row padding
    row = bytes([10, 20, 30, 255]) * width + b'\0' * 4
    bus = _screenshot_bus({'width': ('u', width), 'height': ('u', height), 'stride': ('u', stride),
                           'format': ('u', 6), 'type': ('s', 'raw')}, frame=row * height)
    result = KWinCapture(bus, lambda: dict(WINDOW)).capture()
    assert result.status == CaptureStatus.OK, result.detail
    assert result.image.size == (4, 3)
    assert result.image.getpixel((0, 0)) == (30, 20, 10)


def test_large_frame_no_pipe_deadlock():
    width, height = 1920, 1080
    frame = bytes([200, 100, 50, 255]) * (width * height)
    bus = _screenshot_bus({'width': ('u', width), 'height': ('u', height), 'stride': ('u', width * 4),
                           'format': ('u', 5)}, frame=frame)
    start = time.monotonic()
    result = KWinCapture(bus, lambda: dict(WINDOW)).capture()
    assert result.status == CaptureStatus.OK
    assert time.monotonic() - start < 5


def test_not_authorized_is_denied():
    error = DBusCallError('no', name='org.kde.KWin.ScreenShot2.Error.NoAuthorized')
    result = KWinCapture(_screenshot_bus(error=error), lambda: dict(WINDOW)).capture()
    assert result.status == CaptureStatus.DENIED


def test_version_check():
    assert KWinCapture(_screenshot_bus(), lambda: None).is_available() is True
    assert KWinCapture(FakeBus(), lambda: None).is_available() is False


def test_unsupported_format():
    with pytest.raises(ValueError):
        image_from_raw(b'\0' * 12, 1, 1, 12, 99)


# ---------------------------------------------- Wayland ext-idle-notify client

class FakeCompositor:
    """Speaks just enough of the Wayland wire protocol for the idle client."""

    def __init__(self, with_idle=True):
        self.client, self.server = socket.socketpair()
        self.with_idle = with_idle
        self.requests = []
        self.notification_id = None
        threading.Thread(target=self._serve, daemon=True).start()

    def _send(self, object_id, opcode, args=b''):
        self.server.sendall(wi.message(object_id, opcode, args))

    def _serve(self):
        buffer = b''
        while True:
            try:
                data = self.server.recv(65536)
            except OSError:
                return
            if not data:
                return
            buffer += data
            while len(buffer) >= 8:
                object_id, size_opcode = struct.unpack_from('<II', buffer)
                size = size_opcode >> 16
                if len(buffer) < size:
                    break
                self._handle(object_id, size_opcode & 0xffff, buffer[8:size])
                buffer = buffer[size:]

    def _handle(self, object_id, opcode, payload):
        self.requests.append((object_id, opcode))
        if object_id == 1 and opcode == wi.WL_DISPLAY_GET_REGISTRY:
            (self.registry,) = struct.unpack('<I', payload)
            globals_ = [(1, 'wl_compositor', 5), (2, 'wl_seat', 7)]
            if self.with_idle:
                globals_.append((3, 'ext_idle_notifier_v1', 1))
            for name, interface, version in globals_:
                self._send(self.registry, wi.WL_REGISTRY_EVENT_GLOBAL,
                           struct.pack('<I', name) + wi.encode_string(interface) + struct.pack('<I', version))
        elif object_id == 1 and opcode == wi.WL_DISPLAY_SYNC:
            (callback,) = struct.unpack('<I', payload)
            self._send(callback, wi.WL_CALLBACK_EVENT_DONE, struct.pack('<I', 0))
        elif opcode == wi.IDLE_NOTIFIER_GET_NOTIFICATION and object_id not in (1, self.registry):
            self.notification_id, timeout_ms, _seat = struct.unpack('<III', payload)
            self.timeout_ms = timeout_ms

    def idled(self):
        self._send(self.notification_id, wi.IDLE_NOTIFICATION_EVENT_IDLED)

    def resumed(self):
        self._send(self.notification_id, wi.IDLE_NOTIFICATION_EVENT_RESUMED)


def _idle_client(compositor, clock):
    connection = wi.WaylandConnection(compositor.client)
    registry, globals_ = wi.list_globals(connection)
    if 'ext_idle_notifier_v1' not in globals_:
        return None
    seat = wi.bind(connection, registry, globals_['wl_seat'][0], 'wl_seat', 1)
    notifier = wi.bind(connection, registry, globals_['ext_idle_notifier_v1'][0], 'ext_idle_notifier_v1', 1)
    notification = connection.new_id()
    connection.send(wi.message(notifier, wi.IDLE_NOTIFIER_GET_NOTIFICATION,
                               struct.pack('<III', notification, wi.NOTIFY_AFTER_MS, seat)))
    return wi.WaylandIdleNotify(connection, notification, clock=clock)


def test_string_encoding_padding():
    encoded = wi.encode_string('wl_seat')
    assert len(encoded) % 4 == 0
    assert wi.decode_string(encoded, 0) == ('wl_seat', len(encoded))


def test_idle_notify_idled_and_resumed():
    now = [100.0]
    compositor = FakeCompositor()
    backend = _idle_client(compositor, lambda: now[0])
    deadline = time.monotonic() + 2
    while compositor.notification_id is None and time.monotonic() < deadline:
        time.sleep(0.01)
    assert compositor.timeout_ms == 1000
    assert backend.idle_seconds() == 0.0
    compositor.idled()
    time.sleep(0.1)
    now[0] = 130.0
    assert backend.idle_seconds() == pytest.approx(31.0)     # 30 s + the 1 s threshold
    compositor.resumed()
    time.sleep(0.1)
    assert backend.idle_seconds() == 0.0
    backend.close()


def test_no_idle_protocol_returns_none():
    assert _idle_client(FakeCompositor(with_idle=False), time.monotonic) is None


def test_create_or_none_without_wayland():
    assert wi.WaylandIdleNotify.create_or_none({}) is None

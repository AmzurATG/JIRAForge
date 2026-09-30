"""
Client for the TimeTracker GNOME Shell extension (gnome-extension/src/core.js).

The extension lives on GNOME Shell's bus connection (org.gnome.Shell) at
/com/amzur/TimeTracker/Shell. Frames are written into an anonymous memfd we
pass along, so image bytes never travel over the bus or touch the disk.
"""

import io
import logging
import os
import time

from PIL import Image

from ..capture.backends.common import precheck_window
from ..capture.result import CaptureResult, CaptureStatus
from ..dbus_bus import DBusCallError
from ..window.common import empty_window

logger = logging.getLogger(__name__)

SHELL_NAME = 'org.gnome.Shell'
OBJECT_PATH = '/com/amzur/TimeTracker/Shell'
INTERFACE = 'com.amzur.TimeTracker.Shell1'
PROTOCOL = 1
# GNOME disables extensions while the screen is locked and re-enables them on
# unlock, so a missing extension is re-checked quickly (and immediately via
# forget() when the provider sees an unlock).
UNAVAILABLE_RECHECK_S = 5.0
CAPTURE_TIMEOUT_S = 5.0

_STATUS = {
    'ok': CaptureStatus.OK,
    'locked': CaptureStatus.SKIPPED_LOCKED,
    'no_focus': CaptureStatus.SKIPPED_NO_FOCUS,
    'minimized': CaptureStatus.SKIPPED_MINIMIZED,
    'rate_limited': CaptureStatus.SKIPPED_RATE_LIMITED,
    'error': CaptureStatus.ERROR,
}


def unpack(dict_of_variants):
    """jeepney a{sv} values are (signature, value) pairs."""
    return {key: value[1] if isinstance(value, tuple) and len(value) == 2 else value
            for key, value in (dict_of_variants or {}).items()}


class GnomeExtensionClient:

    def __init__(self, bus, clock=time.monotonic):
        self._bus = bus
        self._clock = clock
        self._version = None
        self._checked_at = None
        self.last_error = None

    def version(self):
        """(protocol, extension_version, shell_version) or None if the extension isn't loaded."""
        if self._version is not None:
            return self._version
        now = self._clock()
        if self._checked_at is not None and now - self._checked_at < UNAVAILABLE_RECHECK_S:
            return None
        self._checked_at = now
        try:
            self._version = tuple(self._bus.call(SHELL_NAME, OBJECT_PATH, INTERFACE, 'GetVersion', timeout=1.0))
        except Exception as e:
            self.last_error = str(e)
            self._version = None
        return self._version

    def available(self):
        version = self.version()
        return version is not None and version[0] == PROTOCOL

    def forget(self):
        """Re-check on next use (after login, extension update, errors)."""
        self._version = None
        self._checked_at = None

    def _call(self, method, signature='', args=(), timeout=None):
        try:
            return self._bus.call(SHELL_NAME, OBJECT_PATH, INTERFACE, method, signature, args,
                                  timeout=timeout)
        except DBusCallError as e:
            if e.name in ('org.freedesktop.DBus.Error.UnknownObject', 'org.freedesktop.DBus.Error.UnknownMethod',
                          'org.freedesktop.DBus.Error.ServiceUnknown'):
                self.forget()
            raise

    def focused_window(self):
        (info,) = self._call('GetFocusedWindow', timeout=1.0)
        return unpack(info)

    def is_locked(self):
        (locked,) = self._call('IsLocked', timeout=1.0)
        return bool(locked)

    def capture_into(self, fd):
        (result,) = self._call('CaptureFocusedMonitor', 'ha{sv}', (fd, {}), timeout=CAPTURE_TIMEOUT_S)
        return unpack(result)


def window_from_extension(info):
    """Common window dict from GetFocusedWindow, or None if nothing usable is focused."""
    if not info.get('focused') or info.get('locked'):
        return None
    window = empty_window()
    window['window_id'] = f"gnome:{info.get('window_id')}"
    window['title'] = info.get('title') or ''
    window['wm_class'] = (info.get('wm_class') or '').lower()
    window['app_id'] = info.get('app_id') or ''
    pid = info.get('pid')
    window['pid'] = pid if pid and pid > 0 else None
    window['monitor_name'] = f"monitor-{info.get('monitor_index', 0)}"
    window['monitor_rect'] = (info.get('monitor_x', 0), info.get('monitor_y', 0),
                              info.get('monitor_width', 0), info.get('monitor_height', 0))
    window['scale'] = float(info.get('scale') or 1.0)
    window['minimized'] = bool(info.get('minimized'))
    return window


class GnomeExtensionWindow:
    name = 'gnome_extension'

    def __init__(self, client):
        self._client = client

    def is_available(self):
        return self._client.available()

    def focused_window(self):
        return window_from_extension(self._client.focused_window())

    def is_locked(self):
        return self._client.is_locked()


class GnomeExtensionCapture:
    name = 'gnome_extension'

    def __init__(self, client, window_reader, memfd_create=None):
        self._client = client
        self._read_window = window_reader
        self._memfd_create = memfd_create or (lambda: os.memfd_create('timetracker-frame', os.MFD_CLOEXEC))

    def is_available(self):
        return self._client.available()

    def capture(self):
        window = self._read_window()
        skip = precheck_window(window, self.name)
        if skip is not None:
            return skip
        fd = self._memfd_create()
        try:
            try:
                reply = self._client.capture_into(fd)
            except DBusCallError as e:
                status = CaptureStatus.DENIED if e.name and e.name.endswith('AccessDenied') \
                    else CaptureStatus.BACKEND_UNAVAILABLE if e.name and 'Unknown' in e.name \
                    else CaptureStatus.ERROR
                return CaptureResult(image=None, status=status, backend=self.name,
                                     window_id=window.get('window_id'), detail=str(e))
            status = _STATUS.get(reply.get('status'), CaptureStatus.ERROR)
            if status != CaptureStatus.OK:
                return CaptureResult(image=None, status=status, backend=self.name,
                                     window_id=window.get('window_id'), detail=f"extension: {reply.get('status')}")
            os.lseek(fd, 0, os.SEEK_SET)
            data = b''
            while True:
                chunk = os.read(fd, 1 << 20)
                if not chunk:
                    break
                data += chunk
        finally:
            os.close(fd)
        if not data:
            return CaptureResult(image=None, status=CaptureStatus.ERROR, backend=self.name,
                                 window_id=window.get('window_id'), detail='extension wrote no image')
        image = Image.open(io.BytesIO(data))
        image.load()
        return CaptureResult(
            image=image.convert('RGB'), status=CaptureStatus.OK, backend=self.name,
            window_id=f"gnome:{reply.get('window_id')}" if reply.get('window_id') else window.get('window_id'),
            monitor_name=f"monitor-{reply.get('monitor_index', 0)}", scale=float(reply.get('scale') or 1.0))

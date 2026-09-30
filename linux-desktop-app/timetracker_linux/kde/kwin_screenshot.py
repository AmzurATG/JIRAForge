"""
KDE Plasma capture via org.kde.KWin.ScreenShot2.CaptureActiveScreen.

"Active screen" is the monitor with the focused window, exactly our rule.
KWin allows it only for apps whose installed .desktop file declares
X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2 and whose Exec is
the real binary (/opt/timetracker/TimeTracker). Silent: no flash, no prompt.
"""

import os
import threading

from PIL import Image

from ..capture.backends.common import precheck_window
from ..capture.result import CaptureResult, CaptureStatus
from ..dbus_bus import DBusCallError

SCREENSHOT = ('org.kde.KWin.ScreenShot2', '/org/kde/KWin/ScreenShot2', 'org.kde.KWin.ScreenShot2')
CAPTURE_TIMEOUT_S = 5.0

# QImage::Format → PIL (mode, rawmode). 32-bit Qt formats are native-endian ARGB,
# i.e. B G R A in memory on little-endian machines.
QIMAGE_FORMATS = {
    4: ('RGB', 'BGRX'),     # Format_RGB32
    5: ('RGB', 'BGRX'),     # Format_ARGB32 (alpha ignored; screens are opaque)
    6: ('RGB', 'BGRX'),     # Format_ARGB32_Premultiplied
    16: ('RGB', 'RGBX'),    # Format_RGBX8888
    17: ('RGB', 'RGBX'),    # Format_RGBA8888
    18: ('RGB', 'RGBX'),    # Format_RGBA8888_Premultiplied
}


def image_from_raw(data, width, height, stride, qformat):
    if qformat not in QIMAGE_FORMATS:
        raise ValueError(f'unsupported QImage format {qformat}')
    mode, rawmode = QIMAGE_FORMATS[qformat]
    if len(data) < stride * height:
        raise ValueError(f'short frame: {len(data)} < {stride * height}')
    return Image.frombuffer(mode, (width, height), data, 'raw', rawmode, stride, 1).copy()


def _read_all(fd, sink):
    chunks = []
    try:
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        os.close(fd)
        sink.append(b''.join(chunks))


class KWinCapture:
    name = 'kwin'

    def __init__(self, bus, window_reader):
        self._bus = bus
        self._read_window = window_reader
        self._version = None

    def is_available(self):
        if self._version is None:
            try:
                self._version = int(self._bus.get_property(*SCREENSHOT[:2], SCREENSHOT[2], 'Version'))
            except Exception:
                self._version = 0
        return self._version >= 2

    def capture(self):
        window = self._read_window()
        skip = precheck_window(window, self.name)
        if skip is not None:
            return skip
        read_fd, write_fd = os.pipe()
        data = []
        # Read while KWin writes: reading after the call returns can deadlock
        # once the frame is larger than the pipe buffer.
        reader = threading.Thread(target=_read_all, args=(read_fd, data), name='kwin-screenshot', daemon=True)
        reader.start()
        try:
            (results,) = self._bus.call(*SCREENSHOT, 'CaptureActiveScreen', 'a{sv}h',
                                        ({'include-cursor': ('b', False), 'native-resolution': ('b', True)},
                                         write_fd), timeout=CAPTURE_TIMEOUT_S)
        except DBusCallError as e:
            os.close(write_fd)
            reader.join(2)
            denied = bool(e.name and ('NoAuthorized' in e.name or 'AccessDenied' in e.name))
            return CaptureResult(image=None, status=CaptureStatus.DENIED if denied else CaptureStatus.ERROR,
                                 backend=self.name, window_id=window.get('window_id'), detail=str(e))
        os.close(write_fd)
        reader.join(CAPTURE_TIMEOUT_S)
        if reader.is_alive() or not data:
            return CaptureResult(image=None, status=CaptureStatus.TIMEOUT, backend=self.name,
                                 window_id=window.get('window_id'), detail='no frame data from KWin')
        values = {k: v[1] if isinstance(v, tuple) else v for k, v in results.items()}
        try:
            image = image_from_raw(data[0], int(values['width']), int(values['height']),
                                   int(values['stride']), int(values['format']))
        except (KeyError, ValueError) as e:
            return CaptureResult(image=None, status=CaptureStatus.ERROR, backend=self.name,
                                 window_id=window.get('window_id'), detail=str(e))
        return CaptureResult(image=image, status=CaptureStatus.OK, backend=self.name,
                             window_id=window.get('window_id'), monitor_name=window.get('monitor_name'),
                             scale=float(values.get('scale') or window.get('scale') or 1.0))

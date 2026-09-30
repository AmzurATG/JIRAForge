"""
X11 capture: the monitor holding the focused window, nothing else.

Used only when XDG_SESSION_TYPE=x11 (selection.plan_for). Grabs exactly the
monitor rect chosen by largest overlap with the focused window's frame
(the Windows build's rule); never the whole virtual screen.
"""

from PIL import Image

from ..result import CaptureResult, CaptureStatus
from .common import precheck_window


def _grab_mss(rect):
    import mss
    x, y, w, h = rect
    with mss.mss() as grabber:
        shot = grabber.grab({'left': x, 'top': y, 'width': w, 'height': h})
        return Image.frombytes('RGB', shot.size, shot.bgra, 'raw', 'BGRX')


def _grab_xlib(rect, x11):
    from Xlib import X
    x, y, w, h = rect
    with x11.lock:
        root = x11.display.screen().root
        raw = root.get_image(x, y, w, h, X.ZPixmap, 0xffffffff)
    return Image.frombytes('RGB', (w, h), raw.data, 'raw', 'BGRX')


class X11Capture:
    name = 'x11'

    def __init__(self, window_reader, x11=None, grabbers=None):
        self._read_window = window_reader
        self._x11 = x11
        self._grabbers = grabbers or [_grab_mss, lambda rect: _grab_xlib(rect, self._x11)]

    def is_available(self):
        return True

    def capture(self):
        window = self._read_window()
        skip = precheck_window(window, self.name)
        if skip is not None:
            return skip
        rect = window.get('monitor_rect')
        if not rect:
            return CaptureResult(image=None, status=CaptureStatus.SKIPPED_UNKNOWN_MONITOR, backend=self.name,
                                 window_id=window.get('window_id'), detail='focused monitor unknown')
        errors = []
        for grab in self._grabbers:
            try:
                image = grab(rect)
                return CaptureResult(image=image, status=CaptureStatus.OK, backend=self.name,
                                     window_id=window.get('window_id'), monitor_name=window.get('monitor_name'),
                                     monitor_size=(rect[2], rect[3]), scale=1.0)
            except Exception as e:
                errors.append(f'{type(e).__name__}: {e}')
        return CaptureResult(image=None, status=CaptureStatus.ERROR, backend=self.name,
                             window_id=window.get('window_id'), detail='; '.join(errors))

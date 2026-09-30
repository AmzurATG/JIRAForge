"""
Tests for the X11 and wlroots capture backends.

Spec: plan/2026-09-29_linux-desktop-app_phase1b-core-seams-and-services.md (AC 12)
"""

import io
import subprocess
from types import SimpleNamespace

from PIL import Image

from timetracker_linux.capture.backends.wlroots import WlrootsCapture
from timetracker_linux.capture.backends.x11 import X11Capture
from timetracker_linux.capture.result import CaptureStatus

WINDOW = {'window_id': 'x11:0x1', 'title': 't', 'monitor_name': 'HDMI-1',
          'monitor_rect': (1920, 0, 2560, 1440), 'minimized': False, 'scale': 1.0}


class TestX11Capture:

    def test_grabs_exactly_the_focused_monitor(self):
        grabbed = []

        def grab(rect):
            grabbed.append(rect)
            return Image.new('RGB', rect[2:], (200, 200, 200))

        result = X11Capture(lambda: dict(WINDOW), grabbers=[grab]).capture()
        assert grabbed == [(1920, 0, 2560, 1440)]
        assert result.status == CaptureStatus.OK
        assert result.image.size == (2560, 1440)
        assert result.monitor_size == (2560, 1440)
        assert result.window_id == 'x11:0x1'

    def test_falls_back_to_second_grabber(self):
        def broken(rect):
            raise OSError('XShm unavailable')

        result = X11Capture(lambda: dict(WINDOW),
                            grabbers=[broken, lambda rect: Image.new('RGB', rect[2:])]).capture()
        assert result.status == CaptureStatus.OK

    def test_all_grabbers_fail(self):
        def broken(rect):
            raise OSError('no display')

        result = X11Capture(lambda: dict(WINDOW), grabbers=[broken]).capture()
        assert result.status == CaptureStatus.ERROR
        assert 'no display' in result.detail

    def test_skips(self):
        assert X11Capture(lambda: None, grabbers=[]).capture().status == CaptureStatus.SKIPPED_NO_FOCUS
        assert X11Capture(lambda: dict(WINDOW, minimized=True), grabbers=[]).capture().status \
            == CaptureStatus.SKIPPED_MINIMIZED
        assert X11Capture(lambda: dict(WINDOW, monitor_rect=None), grabbers=[]).capture().status \
            == CaptureStatus.SKIPPED_UNKNOWN_MONITOR


def _ppm(size=(64, 32)):
    buffer = io.BytesIO()
    Image.new('RGB', size, (10, 120, 200)).save(buffer, format='PPM')
    return buffer.getvalue()


class TestWlrootsCapture:

    def _backend(self, completed=None, raises=None, window=None, output_reader=None):
        calls = []

        def run(cmd, **kwargs):
            calls.append((cmd, kwargs))
            if raises:
                raise raises
            return completed

        backend = WlrootsCapture(lambda: window if window is not None else dict(WINDOW),
                                 output_reader=output_reader, run=run, which=lambda *a, **k: '/usr/bin/grim')
        return backend, calls

    def test_grim_focused_output_to_stdout(self):
        backend, calls = self._backend(SimpleNamespace(returncode=0, stdout=_ppm(), stderr=b''))
        result = backend.capture()
        cmd, kwargs = calls[0]
        assert cmd == ['grim', '-t', 'ppm', '-o', 'HDMI-1', '-']
        assert 'LD_LIBRARY_PATH' not in kwargs['env'] or kwargs['env']['LD_LIBRARY_PATH'] != '/opt/timetracker/_internal'
        assert result.status == CaptureStatus.OK
        assert result.image.size == (64, 32)

    def test_output_from_reader_when_window_has_none(self):
        backend, calls = self._backend(SimpleNamespace(returncode=0, stdout=_ppm(), stderr=b''),
                                       window=dict(WINDOW, monitor_name=None), output_reader=lambda: 'DP-3')
        backend.capture()
        assert calls[0][0][4] == 'DP-3'

    def test_unknown_output_skips(self):
        backend, calls = self._backend(window=dict(WINDOW, monitor_name=None))
        assert backend.capture().status == CaptureStatus.SKIPPED_UNKNOWN_MONITOR
        assert calls == []

    def test_timeout(self):
        backend, _ = self._backend(raises=subprocess.TimeoutExpired('grim', 3))
        assert backend.capture().status == CaptureStatus.TIMEOUT

    def test_unsupported_compositor_is_denied(self):
        backend, _ = self._backend(SimpleNamespace(
            returncode=1, stdout=b'', stderr=b'compositor does not support screencopy: not supported'))
        assert backend.capture().status == CaptureStatus.DENIED

    def test_uses_clean_env(self, monkeypatch):
        monkeypatch.setenv('LD_LIBRARY_PATH', '/opt/timetracker/_internal')
        monkeypatch.setattr('sys.frozen', True, raising=False)
        backend, calls = self._backend(SimpleNamespace(returncode=0, stdout=_ppm(), stderr=b''))
        backend.capture()
        assert 'LD_LIBRARY_PATH' not in calls[0][1]['env']

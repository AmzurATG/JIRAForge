"""
wlroots capture (Sway, Hyprland, labwc, river, Wayfire): `grim -o <output>`.

Silent (wlr-screencopy / ext-image-copy-capture). The image is read from
grim's stdout as PPM; nothing is written to disk.
"""

import io
import shutil
import subprocess

from PIL import Image

from ...childenv import clean_env
from ..result import CaptureResult, CaptureStatus
from .common import precheck_window

GRIM_TIMEOUT_S = 3.0


class WlrootsCapture:
    name = 'wlroots'

    def __init__(self, window_reader, output_reader=None, run=subprocess.run, which=shutil.which):
        self._read_window = window_reader
        self._read_output = output_reader
        self._run = run
        self._which = which

    def is_available(self):
        return self._which('grim', path=clean_env().get('PATH')) is not None

    def capture(self):
        window = self._read_window()
        skip = precheck_window(window, self.name)
        if skip is not None:
            return skip
        output = window.get('monitor_name')
        if not output and self._read_output is not None:
            try:
                output = self._read_output()
            except Exception:
                output = None
        if not output:
            return CaptureResult(image=None, status=CaptureStatus.SKIPPED_UNKNOWN_MONITOR, backend=self.name,
                                 window_id=window.get('window_id'), detail='focused output unknown')
        try:
            done = self._run(['grim', '-t', 'ppm', '-o', output, '-'], capture_output=True,
                             timeout=GRIM_TIMEOUT_S, env=clean_env(), check=False)
        except subprocess.TimeoutExpired:
            return CaptureResult(image=None, status=CaptureStatus.TIMEOUT, backend=self.name,
                                 window_id=window.get('window_id'), detail='grim timed out')
        if done.returncode != 0:
            stderr = (done.stderr or b'').decode('utf-8', 'replace').strip()
            status = CaptureStatus.DENIED if 'not supported' in stderr.lower() else CaptureStatus.ERROR
            return CaptureResult(image=None, status=status, backend=self.name,
                                 window_id=window.get('window_id'), detail=f'grim: {stderr[:200]}')
        image = Image.open(io.BytesIO(done.stdout))
        image.load()
        return CaptureResult(image=image.convert('RGB'), status=CaptureStatus.OK, backend=self.name,
                             window_id=window.get('window_id'), monitor_name=output,
                             scale=float(window.get('scale') or 1.0))

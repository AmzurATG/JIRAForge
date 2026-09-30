"""
Main-process side of the session helper (session-helper/tt_session_helper.py),
plus the two backends it serves: portal ScreenCast capture and AT-SPI window info.

The helper is started only when one of those backends is actually used, with
the system Python and a clean environment (no bundled LD_LIBRARY_PATH).
A hung or crashed helper is killed and restarted (at most 3 times per 10 min)
without affecting tracking.
"""

import json
import logging
import os
import socket
import struct
import subprocess
import sys
import threading
import time

from PIL import Image

from . import paths
from .capture.backends.common import precheck_window
from .capture.result import CaptureResult, CaptureStatus
from .childenv import clean_env
from .window.common import empty_window

logger = logging.getLogger(__name__)

SYSTEM_PYTHON_CANDIDATES = ('/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3')
MAX_RESTARTS = 3
RESTART_WINDOW_S = 600
STREAM_IDLE_STOP_S = 180        # stop screen sharing when tracking stops asking for frames
PERMISSION_NOTICE_INTERVAL_S = 24 * 3600
TOKEN_SERVICE = 'TimeTracker'
TOKEN_KEY = 'screencast_restore_token'


def helper_script_path():
    """Installed next to the frozen binary, or in the source tree."""
    base = getattr(sys, '_MEIPASS', None)
    candidates = []
    if getattr(sys, 'frozen', False):
        candidates.append(os.path.join(os.path.dirname(sys.executable), 'session-helper', 'tt_session_helper.py'))
    if base:
        candidates.append(os.path.join(base, 'session-helper', 'tt_session_helper.py'))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.normpath(os.path.join(here, '..', 'session-helper', 'tt_session_helper.py')))
    for path in candidates:
        if os.path.exists(path):
            return path
    return candidates[-1]


def system_python():
    for path in SYSTEM_PYTHON_CANDIDATES:
        if os.access(path, os.X_OK):
            return path
    return None


class HelperError(Exception):
    pass


class HelperClient:

    def __init__(self, python=None, script=None, extra_args=(), clock=time.monotonic):
        self._python = python or system_python()
        self._script = script or helper_script_path()
        self._extra_args = list(extra_args)
        self._clock = clock
        self._lock = threading.Lock()
        self._proc = None
        self._sock = None
        self._reader = None
        self._pending = {}              # id → [event, header, payload]
        self._next_id = 0
        self._restarts = []
        self._probe = None
        self.last_error = None

    # ------------------------------------------------------------- process

    def _spawn(self):
        if not self._python:
            raise HelperError('no system python3 found')
        now = self._clock()
        self._restarts = [t for t in self._restarts if now - t < RESTART_WINDOW_S]
        if len(self._restarts) >= MAX_RESTARTS:
            raise HelperError(f'helper restarted {MAX_RESTARTS} times in {RESTART_WINDOW_S // 60} min; giving up')
        self._restarts.append(now)
        parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self._proc = subprocess.Popen(
                [self._python, self._script, '--fd', str(child.fileno())] + self._extra_args,
                pass_fds=(child.fileno(),), env=clean_env(), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
        finally:
            child.close()
        self._sock = parent
        self._reader = threading.Thread(target=self._read_loop, args=(parent,), name='helper-reader', daemon=True)
        self._reader.start()
        threading.Thread(target=self._log_stderr, args=(self._proc,), name='helper-log', daemon=True).start()
        logger.info(f'[LINUX] session helper started (pid {self._proc.pid})')

    def _log_stderr(self, proc):
        for line in proc.stderr:
            logger.info(line.decode('utf-8', 'replace').rstrip())

    def _read_loop(self, sock):
        buffer = b''
        try:
            while True:
                data = sock.recv(1 << 20)
                if not data:
                    break
                buffer += data
                while len(buffer) >= 4:
                    (length,) = struct.unpack('>I', buffer[:4])
                    if len(buffer) < 4 + length:
                        break
                    header = json.loads(buffer[4:4 + length].decode('utf-8'))
                    need = header.get('payload', 0)
                    if len(buffer) < 4 + length + need:
                        break
                    payload = buffer[4 + length:4 + length + need]
                    buffer = buffer[4 + length + need:]
                    waiter = self._pending.pop(header.get('id'), None)
                    if waiter is not None:
                        waiter[1], waiter[2] = header, payload
                        waiter[0].set()
        except OSError:
            pass
        for waiter in list(self._pending.values()):
            waiter[0].set()             # wake callers; they see no header
        self._pending.clear()

    def _alive(self):
        return self._proc is not None and self._proc.poll() is None

    def request(self, command, timeout=2.0, **params):
        """Send a command; return (header, payload). Raises HelperError."""
        with self._lock:
            if not self._alive():
                self._close_locked()
                self._spawn()
            self._next_id += 1
            request_id = self._next_id
            waiter = [threading.Event(), None, b'']
            self._pending[request_id] = waiter
            data = json.dumps(dict(params, id=request_id, cmd=command)).encode('utf-8')
            try:
                self._sock.sendall(struct.pack('>I', len(data)) + data)
            except OSError as e:
                self._pending.pop(request_id, None)
                self._close_locked()
                raise HelperError(f'helper connection lost: {e}')
        if not waiter[0].wait(timeout):
            self._pending.pop(request_id, None)
            if command != 'screencast.start':
                # A hung helper blocks everything behind it; restart it on next use.
                with self._lock:
                    self._close_locked()
            raise HelperError(f'helper did not answer {command} within {timeout}s')
        header = waiter[1]
        if header is None:
            raise HelperError('helper exited')
        if not header.get('ok'):
            raise HelperError(header.get('error') or 'helper error')
        return header, waiter[2]

    def probe(self):
        if self._probe is None:
            try:
                self._probe, _ = self.request('probe', timeout=5.0)
            except HelperError as e:
                self.last_error = str(e)
                self._probe = {}
        return self._probe

    def _close_locked(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
        self._sock = None
        if self._proc is not None and self._proc.poll() is None:
            self._proc.kill()
            try:
                self._proc.wait(2)
            except Exception:
                pass
        self._proc = None

    def close(self):
        with self._lock:
            self._close_locked()


# --------------------------------------------------------------- tokens

class TokenStore:
    """ScreenCast restore token: keyring, else a 0600 file in the config dir."""

    def __init__(self, path=None):
        self._path = path or os.path.join(paths.config_dir(), 'screencast-restore-token')

    def get(self):
        try:
            import keyring
            value = keyring.get_password(TOKEN_SERVICE, TOKEN_KEY)
            if value:
                return value
        except Exception:
            pass
        try:
            with open(self._path, encoding='utf-8') as f:
                return f.read().strip() or None
        except OSError:
            return None

    def set(self, token):
        if not token:
            return
        try:
            import keyring
            keyring.set_password(TOKEN_SERVICE, TOKEN_KEY, token)
            try:
                os.remove(self._path)
            except OSError:
                pass
            return
        except Exception:
            pass
        paths.ensure_dir(os.path.dirname(self._path))
        fd = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(token)

    def clear(self):
        try:
            import keyring
            keyring.delete_password(TOKEN_SERVICE, TOKEN_KEY)
        except Exception:
            pass
        try:
            os.remove(self._path)
        except OSError:
            pass


# ------------------------------------------------------ portal capture

class PortalScreenCastCapture:
    """Fallback capture on any Wayland desktop via the XDG ScreenCast portal.

    The first grant shows the desktop's "share your screen" dialog, started
    only from an explicit user action (notification button / settings), never
    in the middle of work. Later sessions restore silently with the token.
    """
    name = 'portal_screencast'

    def __init__(self, helper, window_reader, monitor_count_reader=None, tokens=None,
                 on_permission_needed=None, clock=time.monotonic):
        self._helper = helper
        self._read_window = window_reader
        self._monitor_count = monitor_count_reader or (lambda: 0)
        self._tokens = tokens or TokenStore()
        self._on_permission_needed = on_permission_needed
        self._clock = clock
        self._running = False
        self._last_request = 0.0
        self._denied_detail = None
        self._idle_timer = None

    def is_available(self):
        probe = self._helper.probe()
        return bool(probe.get('pipewiresrc')) and probe.get('screencast_version', 0) >= 4

    def _start(self, interactive):
        header, _ = self._helper.request('screencast.start', timeout=310 if interactive else 35,
                                         restore_token=self._tokens.get(), interactive=interactive)
        if header.get('restore_token'):
            self._tokens.set(header['restore_token'])       # single-use: always keep the newest
        self._running = header.get('state') == 'running'
        self._denied_detail = None if self._running else header.get('detail') or header.get('state')
        return header

    def request_permission(self):
        """Interactive grant (shows the portal dialog). Call from a user action only."""
        try:
            return self._start(interactive=True).get('state')
        except Exception as e:
            logger.warning(f'[LINUX] screen sharing permission request failed: {e}')
            return 'failed'

    def stop(self):
        if self._running:
            try:
                self._helper.request('screencast.stop', timeout=5)
            except Exception:
                pass
        self._running = False

    def _schedule_idle_stop(self):
        if self._idle_timer is not None:
            self._idle_timer.cancel()
        self._idle_timer = threading.Timer(STREAM_IDLE_STOP_S, self._stop_if_idle)
        self._idle_timer.daemon = True
        self._idle_timer.start()

    def _stop_if_idle(self):
        if self._clock() - self._last_request >= STREAM_IDLE_STOP_S - 1:
            logger.info('[LINUX] no captures for a while: stopping screen sharing')
            self.stop()

    def capture(self):
        window = self._read_window()
        skip = precheck_window(window, self.name)
        if skip is not None:
            return skip
        self._last_request = self._clock()
        if not self._running:
            header = self._start(interactive=False)
            if not self._running:
                if header.get('state') == 'denied' and self._on_permission_needed is not None:
                    self._on_permission_needed(self)
                status = CaptureStatus.DENIED if header.get('state') == 'denied' else CaptureStatus.ERROR
                return CaptureResult(image=None, status=status, backend=self.name,
                                     window_id=window.get('window_id'), detail=self._denied_detail or '')
        self._schedule_idle_stop()
        header, payload = self._helper.request(
            'screencast.frame', timeout=3.0, monitor_rect=window.get('monitor_rect'),
            monitor_count=self._monitor_count(), wait_s=1.2)
        status = header.get('status')
        if status == 'unknown_monitor':
            return CaptureResult(image=None, status=CaptureStatus.SKIPPED_UNKNOWN_MONITOR, backend=self.name,
                                 window_id=window.get('window_id'), detail='focused monitor not shared or unknown')
        if status == 'unavailable':
            self._running = False
            return CaptureResult(image=None, status=CaptureStatus.ERROR, backend=self.name,
                                 window_id=window.get('window_id'), detail=header.get('detail', ''))
        if status != 'ok':
            return CaptureResult(image=None, status=CaptureStatus.TIMEOUT if status == 'no_frame'
                                 else CaptureStatus.ERROR, backend=self.name,
                                 window_id=window.get('window_id'), detail=status or '')
        size = (header['width'], header['height'])
        image = Image.frombuffer('RGB', size, payload, 'raw', 'BGRX', 0, 1).copy()
        return CaptureResult(image=image, status=CaptureStatus.OK, backend=self.name,
                             window_id=window.get('window_id'), monitor_name=window.get('monitor_name'),
                             scale=float(window.get('scale') or 1.0))


class PermissionPrompter:
    """At most one "allow screen access" notification per day, with a button
    that starts the interactive portal grant."""

    def __init__(self, notifier_factory, state_path=None, clock=time.time):
        self._notifier_factory = notifier_factory
        self._state_path = state_path or os.path.join(paths.config_dir(), 'screencast-permission-notice')
        self._clock = clock

    def __call__(self, backend):
        try:
            with open(self._state_path, encoding='utf-8') as f:
                last = float(f.read().strip())
        except (OSError, ValueError):
            last = None             # never shown
        now = self._clock()
        if last is not None and now - last < PERMISSION_NOTICE_INTERVAL_S:
            return False
        try:
            paths.ensure_dir(os.path.dirname(self._state_path))
            with open(self._state_path, 'w', encoding='utf-8') as f:
                f.write(str(now))
        except OSError:
            pass

        def grant():
            threading.Thread(target=backend.request_permission, name='screencast-grant', daemon=True).start()

        self._notifier_factory().notify(
            'Allow screen access for TimeTracker',
            'TimeTracker reads the text on the monitor you work on, on this computer only. '
            'Click "Allow", choose your monitors and tick "Remember".',
            duration='long', actions=[('Allow', grant)])
        return True


# -------------------------------------------------------- AT-SPI windows

class AtspiWindow:
    """Last-resort window info through the accessibility bus (slow; titles only
    for toolkits with accessibility enabled)."""
    name = 'atspi'

    def __init__(self, helper):
        self._helper = helper

    def is_available(self):
        return bool(self._helper.probe().get('atspi'))

    def focused_window(self):
        header, _ = self._helper.request('atspi.focused', timeout=2.0)
        info = header.get('window')
        if not info:
            return None
        window = empty_window()
        window['title'] = info.get('title') or ''
        window['wm_class'] = (info.get('app_name') or '').lower()
        window['pid'] = info.get('pid') or None
        window['window_id'] = f"atspi:{window['pid']}:{window['title']}"
        return window

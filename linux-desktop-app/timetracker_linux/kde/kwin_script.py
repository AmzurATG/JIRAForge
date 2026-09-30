"""
Focused window on KDE Plasma (Wayland) via a KWin script.

Wayland gives apps no way to ask which window is focused. KWin scripts can
see it, so we load kwin-script/timetracker-focus at runtime; it calls our
D-Bus service com.amzur.TimeTracker on every focus or title change. Calls
are accepted only when the sender is KWin's own bus connection.
"""

import logging
import os
import sys
import threading
import time

from ..dbus_bus import DBusMethodError
from ..window.common import empty_window

logger = logging.getLogger(__name__)

SERVICE_NAME = 'com.amzur.TimeTracker'
OBJECT_PATH = '/com/amzur/TimeTracker/KWin'
PLUGIN_NAME = 'timetracker-focus'
SCRIPTING = ('org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting')


def script_path():
    """main.js from the package, next to the frozen binary, or in the source tree."""
    relative = os.path.join('kwin-script', PLUGIN_NAME, 'contents', 'code', 'main.js')
    candidates = [os.path.join('/usr/share/kwin/scripts', PLUGIN_NAME, 'contents', 'code', 'main.js')]
    if getattr(sys, 'frozen', False):
        candidates.append(os.path.join(os.path.dirname(sys.executable), relative))
        if getattr(sys, '_MEIPASS', None):
            candidates.append(os.path.join(sys._MEIPASS, relative))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.normpath(os.path.join(here, '..', '..', relative)))
    for path in candidates:
        if os.path.exists(path):
            return path
    return candidates[-1]


def window_from_call(body):
    """FocusChanged(title, resourceClass, desktopFile, pid, id, output, x, y, w, h, scale, minimized)."""
    (title, resource_class, desktop_file, pid, window_id, output,
     x, y, width, height, scale, minimized) = body
    if not window_id:
        return None
    window = empty_window()
    window['window_id'] = f'kwin:{window_id}'
    window['title'] = title or ''
    window['wm_class'] = (resource_class or '').lower()
    window['app_id'] = desktop_file or ''
    window['pid'] = int(pid) if pid else None
    window['monitor_name'] = output or None
    window['monitor_rect'] = (int(x), int(y), int(width), int(height)) if width and height else None
    window['scale'] = float(scale or 1.0)
    window['minimized'] = bool(minimized)
    return window


class KWinFocusService:

    def __init__(self, bus, clock=time.monotonic):
        self._bus = bus
        self._clock = clock
        self._lock = threading.Lock()
        self._window = None
        self._updated_at = None
        self._kwin_owner = None
        self.loaded = False
        self._handle = None

    def ensure_loaded(self):
        if self.loaded:
            return True
        if not self._bus.name_has_owner('org.kde.KWin'):
            return False
        if self._handle is None:
            self._handle = self._bus.export(OBJECT_PATH, self._handle_call)
            if not self._bus.request_name(SERVICE_NAME):
                logger.warning(f'[LINUX] {SERVICE_NAME} is owned by another process (second instance?)')
                return False
        try:
            (already,) = self._bus.call(*SCRIPTING, 'isScriptLoaded', 's', (PLUGIN_NAME,))
            if already:
                self._bus.call(*SCRIPTING, 'unloadScript', 's', (PLUGIN_NAME,))
            (script_id,) = self._bus.call(*SCRIPTING, 'loadScript', 'ss', (script_path(), PLUGIN_NAME))
        except Exception as e:
            logger.warning(f'[LINUX] could not load the KWin script: {e}')
            return False
        for path in (f'/Scripting/Script{script_id}', f'/{script_id}'):    # Plasma 6, Plasma 5
            try:
                self._bus.call('org.kde.KWin', path, 'org.kde.kwin.Script', 'run')
                self.loaded = True
                logger.info('[LINUX] KWin focus script running')
                return True
            except Exception:
                continue
        logger.warning('[LINUX] KWin script loaded but could not be started')
        return False

    def _is_kwin(self, sender):
        if self._kwin_owner is None or self._kwin_owner != sender:
            try:
                (self._kwin_owner,) = self._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                                                     'org.freedesktop.DBus', 'GetNameOwner', 's', ('org.kde.KWin',))
            except Exception:
                return False
        return sender == self._kwin_owner

    def _handle_call(self, message):
        if message.member != 'FocusChanged':
            raise DBusMethodError('org.freedesktop.DBus.Error.UnknownMethod', message.member or '')
        if not self._is_kwin(message.sender):
            raise DBusMethodError('com.amzur.TimeTracker.Error.AccessDenied', 'only KWin may report focus')
        window = window_from_call(message.body)
        with self._lock:
            self._window = window
            self._updated_at = self._clock()
        return None

    def focused_window(self):
        with self._lock:
            return dict(self._window) if self._window else None


class KWinScriptWindow:
    name = 'kwin_script'

    def __init__(self, service):
        self._service = service

    def is_available(self):
        return self._service.loaded or self._service.ensure_loaded()

    def focused_window(self):
        return self._service.focused_window()

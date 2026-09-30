"""
System idle clock: seconds since the last real keyboard/mouse input.

Uses the compositor's own clock. Global input hooks (pynput) see nothing
from native Wayland apps, which marks working users as idle, and reading
/dev/input directly would be a keylogger, so neither is used on Wayland.
"""

import logging
import time

logger = logging.getLogger(__name__)

ERRORS_BEFORE_SKIP = 3


class MutterIdle:
    """GNOME (X11 and Wayland)."""
    name = 'mutter'

    def __init__(self, session_bus):
        self._bus = session_bus

    def idle_seconds(self):
        (ms,) = self._bus.call('org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core',
                               'org.gnome.Mutter.IdleMonitor', 'GetIdletime', timeout=1.0)
        return ms / 1000.0


class FreedesktopScreenSaverIdle:
    """org.freedesktop.ScreenSaver.GetSessionIdleTime (Xfce, MATE, KDE on X11, ...).

    The spec says seconds, but KDE's implementation returns milliseconds.
    """
    name = 'freedesktop_screensaver'

    def __init__(self, session_bus, milliseconds=False):
        self._bus = session_bus
        self._divisor = 1000.0 if milliseconds else 1.0

    def idle_seconds(self):
        (value,) = self._bus.call('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver',
                                  'org.freedesktop.ScreenSaver', 'GetSessionIdleTime', timeout=1.0)
        return value / self._divisor


class XScreenSaverIdle:
    """X11 MIT-SCREEN-SAVER extension via python-xlib."""
    name = 'xss'

    def __init__(self, display_factory=None):
        self._display_factory = display_factory
        self._display = None

    def idle_seconds(self):
        from Xlib.ext import screensaver
        if self._display is None:
            if self._display_factory is not None:
                self._display = self._display_factory()
            else:
                from Xlib import display
                self._display = display.Display()
        info = screensaver.query_info(self._display, self._display.screen().root)
        return info.idle / 1000.0


class LogindIdleHint:
    """Coarse fallback: logind IdleHint, set by the desktop after its idle delay."""
    name = 'logind_idlehint'

    def __init__(self, system_bus, session_path_provider, monotonic_us=None):
        self._bus = system_bus
        self._session_path = session_path_provider
        self._monotonic_us = monotonic_us or (lambda: time.clock_gettime(time.CLOCK_MONOTONIC) * 1e6)

    def idle_seconds(self):
        path = self._session_path()
        if not path:
            raise RuntimeError('no logind session')
        iface = 'org.freedesktop.login1.Session'
        if not self._bus.get_property('org.freedesktop.login1', path, iface, 'IdleHint'):
            return 0.0
        since = self._bus.get_property('org.freedesktop.login1', path, iface, 'IdleSinceHintMonotonic')
        return max(0.0, (self._monotonic_us() - since) / 1e6)


class IdleService:

    def __init__(self, backends):
        self._backends = list(backends)
        self._errors = {b.name: 0 for b in self._backends}
        self.active_backend_name = None

    def get_idle_seconds(self):
        for backend in self._backends:
            if self._errors[backend.name] >= ERRORS_BEFORE_SKIP:
                continue
            try:
                seconds = float(backend.idle_seconds())
            except Exception as e:
                self._errors[backend.name] += 1
                if self._errors[backend.name] == ERRORS_BEFORE_SKIP:
                    logger.warning(f"[LINUX] idle backend '{backend.name}' failed "
                                   f"{ERRORS_BEFORE_SKIP} times, skipping it: {e}")
                continue
            self._errors[backend.name] = 0
            if backend.name != self.active_backend_name:
                logger.info(f"[LINUX] idle clock: {backend.name}")
                self.active_backend_name = backend.name
            return max(0.0, seconds)
        return None

    def reset(self):
        """Give every backend another chance (after resume / unlock)."""
        for name in self._errors:
            self._errors[name] = 0

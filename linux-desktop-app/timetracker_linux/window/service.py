"""
WindowService: focused window from the first working backend.

Returns None when nothing reliable is focused or no backend works; the
core then keeps the current session instead of opening an "Unknown" one.
"""

import logging
import time

from .common import resolve_app_name

logger = logging.getLogger(__name__)

ERRORS_BEFORE_SKIP = 3
RETRY_SKIPPED_AFTER_S = 1800


class WindowService:

    def __init__(self, backends, psutil_module=None, clock=time.monotonic):
        self._backends = list(backends)
        self._psutil = psutil_module
        self._clock = clock
        self._errors = {b.name: 0 for b in self._backends}
        self._skipped_at = {}
        self.active_backend_name = None
        self.last_window = None

    @property
    def backend_names(self):
        return [b.name for b in self._backends]

    def has_backend(self):
        """True if any real (non-null) backend reports itself available."""
        for backend in self._backends:
            try:
                if backend.is_available():
                    return True
            except Exception:
                continue
        return False

    def get_focused_window(self):
        now = self._clock()
        for backend in self._backends:
            skipped_at = self._skipped_at.get(backend.name)
            if skipped_at is not None:
                if now - skipped_at < RETRY_SKIPPED_AFTER_S:
                    continue
                self._skipped_at.pop(backend.name)
                self._errors[backend.name] = 0
            try:
                if not backend.is_available():
                    continue
                window = backend.focused_window()
            except Exception as e:
                self._errors[backend.name] += 1
                if self._errors[backend.name] >= ERRORS_BEFORE_SKIP:
                    self._skipped_at[backend.name] = now
                    logger.warning(f"[LINUX] window backend '{backend.name}' failed "
                                   f"{ERRORS_BEFORE_SKIP} times, skipping it for 30 min: {e}")
                continue
            self._errors[backend.name] = 0
            if backend.name != self.active_backend_name:
                logger.info(f"[LINUX] window info: {backend.name}")
                self.active_backend_name = backend.name
            if window is None:
                self.last_window = None
                return None
            window['app'] = window.get('app') or resolve_app_name(window, self._psutil)
            window['backend'] = backend.name
            self.last_window = window
            return window
        self.active_backend_name = None
        return None

    def reset(self):
        self._errors = {name: 0 for name in self._errors}
        self._skipped_at.clear()

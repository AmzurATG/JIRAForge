"""
Enable the TimeTracker GNOME Shell extension for this user and explain
what is still needed (plan §7.4).

The package installs the files; only the user's own session can enable the
extension. On Wayland, GNOME loads a newly installed extension only at the
next login, so the first run falls back to the portal and asks the user to
log out and back in once.
"""

import json
import logging
import os

from .. import paths
from ..environment import EXTENSION_UUID, extension_state_name

logger = logging.getLogger(__name__)

EXTENSIONS = ('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions')
STATE_FILE = 'gnome-extension-state.json'


class ExtensionSetup:

    def __init__(self, bus, notifier=None, config_dir=None):
        self._bus = bus
        self._notifier = notifier
        self._config_dir = config_dir

    def state(self):
        try:
            (info,) = self._bus.call(*EXTENSIONS, 'GetExtensionInfo', 's', (EXTENSION_UUID,), timeout=2.0)
        except Exception as e:
            return f'UNKNOWN ({e})'
        if not info:
            return 'NOT_INSTALLED'
        state = info.get('state')
        if isinstance(state, tuple):
            state = state[1]
        return extension_state_name(state)

    def user_extensions_enabled(self):
        try:
            return bool(self._bus.get_property(*EXTENSIONS[:2], EXTENSIONS[2], 'UserExtensionsEnabled'))
        except Exception:
            return None

    def ensure_enabled(self):
        """Enable if installed; tell the user what to do otherwise. Returns the final state."""
        state = self.state()
        if state == 'ENABLED':
            return state
        if self.user_extensions_enabled() is False:
            self._tell_once('policy', 'Screen text capture needs a GNOME extension',
                            'Extensions are turned off on this computer (possibly by your IT policy). '
                            'TimeTracker will use screen sharing instead. Ask IT to allow the '
                            '"timetracker@amzur.com" extension.')
            return 'BLOCKED_BY_POLICY'
        if state in ('DISABLED', 'INITIALIZED'):
            try:
                self._bus.call(*EXTENSIONS, 'EnableExtension', 's', (EXTENSION_UUID,), timeout=5.0)
            except Exception as e:
                logger.info(f'[LINUX] could not enable the GNOME extension: {e}')
            state = self.state()
            if state == 'ENABLED':
                logger.info('[LINUX] GNOME extension enabled')
                return state
        if state in ('NOT_INSTALLED', 'INITIALIZED', 'DISABLED') and self._files_installed():
            self._tell_once('relogin', 'Finish TimeTracker setup',
                            'Log out and back in once so GNOME can load the TimeTracker integration. '
                            'Until then TimeTracker may ask you to share your screen.')
            return 'NEEDS_RELOGIN'
        if state in ('ERROR', 'OUT_OF_DATE'):
            self._tell_once(f'broken-{state}', 'TimeTracker GNOME integration is not working',
                            f'The GNOME extension reports {state}. Updating TimeTracker usually fixes this.')
        return state

    @staticmethod
    def _files_installed():
        candidates = ['/usr/share/gnome-shell/extensions',
                      os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'),
                                   'gnome-shell/extensions')]
        return any(os.path.isdir(os.path.join(c, EXTENSION_UUID)) for c in candidates)

    def _tell_once(self, key, title, message):
        state_path = os.path.join(self._config_dir or paths.config_dir(), STATE_FILE)
        told = {}
        try:
            with open(state_path, encoding='utf-8') as f:
                told = json.load(f)
        except (OSError, ValueError):
            pass
        if told.get(key):
            return
        told[key] = True
        try:
            paths.ensure_dir(os.path.dirname(state_path))
            with open(state_path, 'w', encoding='utf-8') as f:
                json.dump(told, f)
        except OSError:
            pass
        logger.info(f'[LINUX] {title}: {message}')
        if self._notifier is not None:
            try:
                self._notifier.notify(title, message, duration='long')
            except Exception:
                pass

"""
Update notices on Linux.

Packages are updated by the system (signed APT/YUM repository, plan §6.13),
never by the app replacing files under /opt. The in-app version check only
tells the user, and a mandatory update pauses tracking the same way as on
Windows (the core's `update_required` flag).
"""

import logging
import os
import sys

logger = logging.getLogger(__name__)

SYSTEM_INSTALL_PREFIX = '/opt/timetracker/'


def install_mode(executable=None, frozen=None):
    """'package' (/opt via .deb/.rpm), 'user' (tarball --user), or 'dev' (source)."""
    executable = executable or sys.executable
    frozen = getattr(sys, 'frozen', False) if frozen is None else frozen
    if not frozen:
        return 'dev'
    if os.path.realpath(executable).startswith(SYSTEM_INSTALL_PREFIX):
        return 'package'
    return 'user'


class UpdateNotifier:

    def __init__(self, notifier_factory=None, mode=None):
        self._notifier_factory = notifier_factory
        self._mode = mode or install_mode()
        self._notified = set()

    def _notifier(self):
        if self._notifier_factory is not None:
            return self._notifier_factory()
        from .compat.winotify import get_notifier
        return get_notifier()

    def handle(self, app, info):
        version = info.get('latest_version') or 'unknown'
        mandatory = bool(info.get('is_mandatory'))
        app.update_available = True
        if mandatory:
            app.update_required = True
        key = (version, mandatory)
        if key in self._notified:
            return True
        self._notified.add(key)

        if self._mode == 'package':
            message = f'Version {version} will be installed by your system software updater.'
            launch = ''
        else:
            message = f'Download version {version} to update this installation.'
            launch = info.get('download_url') or ''
        if mandatory:
            message += ' Tracking is paused until the update is installed.'
        title = f"TimeTracker update {'required' if mandatory else 'available'}: v{version}"
        logger.info(f'[LINUX] {title} ({self._mode} install)')
        self._notifier().notify(title, message, duration='long' if mandatory else 'short', launch=launch)
        return True

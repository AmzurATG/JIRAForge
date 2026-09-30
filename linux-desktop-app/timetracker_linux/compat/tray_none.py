"""
pystray-compatible icon for sessions with no tray at all (bare Sway,
vanilla GNOME without the AppIndicator extension and no session bus).

run() blocks like a real tray so the core's main thread behaves the same;
the app stays reachable through its launcher entry and the local web UI.
"""

import threading

import pystray._base as pystray_base


class Icon(pystray_base.Icon):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._stop_event = threading.Event()

    def _show(self):
        pass

    def _hide(self):
        pass

    def _update_icon(self):
        self._icon_valid = True

    def _update_title(self):
        pass

    def _update_menu(self):
        pass

    def _run(self):
        self._mark_ready()
        while not self._stop_event.wait(1.0):
            pass

    def _run_detached(self):
        self._mark_ready()

    def _stop(self):
        self._stop_event.set()

    def _notify(self, message, title=None):
        from .winotify import get_notifier
        get_notifier().notify(title or 'TimeTracker', message)

    def _remove_notification(self):
        pass

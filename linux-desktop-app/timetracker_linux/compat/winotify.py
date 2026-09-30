"""
The subset of the `winotify` API used by the shared core, delivered through
org.freedesktop.Notifications (GNOME, KDE, Cinnamon, Xfce, mako, dunst...).

The launcher registers this module as `winotify` in sys.modules, so the
core's 29 notification call sites work unchanged on Linux.
"""

import html
import logging
import subprocess
import threading

from ..childenv import clean_env

logger = logging.getLogger(__name__)

APP_NAME = 'TimeTracker'
DESKTOP_ENTRY = 'com.amzur.timetracker'
NOTIFICATIONS = ('org.freedesktop.Notifications', '/org/freedesktop/Notifications',
                 'org.freedesktop.Notifications')
TIMEOUT_MS = {'short': 7000, 'long': 25000}


class audio:
    """winotify.audio constants (sounds are left to the notification server)."""
    Default = 'ms-winsoundevent:Notification.Default'
    IM = 'ms-winsoundevent:Notification.IM'
    Mail = 'ms-winsoundevent:Notification.Mail'
    Reminder = 'ms-winsoundevent:Notification.Reminder'
    SMS = 'ms-winsoundevent:Notification.SMS'
    Silent = 'silent'


class Notifier:
    """Sends notifications and opens action URLs when clicked."""

    def __init__(self, bus_factory=None, opener=None):
        self._bus_factory = bus_factory
        self._bus = None
        self._opener = opener or open_url
        self._capabilities = None
        self._pending = {}          # notification id → {action_key: url}
        self._lock = threading.Lock()

    def _get_bus(self):
        if self._bus is None:
            if self._bus_factory is not None:
                self._bus = self._bus_factory()
            else:
                from ..dbus_bus import get_bus
                self._bus = get_bus('SESSION')
            self._bus.subscribe(self._on_action, interface=NOTIFICATIONS[2], member='ActionInvoked')
            self._bus.subscribe(self._on_closed, interface=NOTIFICATIONS[2], member='NotificationClosed')
        return self._bus

    @property
    def capabilities(self):
        if self._capabilities is None:
            try:
                (caps,) = self._get_bus().call(*NOTIFICATIONS, 'GetCapabilities')
                self._capabilities = set(caps)
            except Exception as e:
                logger.info(f'[LINUX] notification server unavailable: {e}')
                self._capabilities = set()
        return self._capabilities

    def notify(self, title, message, duration='short', actions=(), launch='', silent=False, icon=''):
        """Show a notification. Returns its id, or None if it could not be sent."""
        bus = self._get_bus()
        caps = self.capabilities
        body = html.escape(message or '', quote=False) if 'body-markup' in caps else (message or '')

        action_list, urls = [], {}
        if 'actions' in caps:
            if launch:
                action_list += ['default', 'Open']
                urls['default'] = launch
            for index, (label, url) in enumerate(actions):
                key = f'action-{index}'
                action_list += [key, label]
                urls[key] = url

        hints = {'desktop-entry': ('s', DESKTOP_ENTRY), 'urgency': ('y', 2 if duration == 'long' else 1)}
        if silent:
            hints['suppress-sound'] = ('b', True)
        try:
            (notification_id,) = bus.call(*NOTIFICATIONS, 'Notify', 'susssasa{sv}i',
                                          (APP_NAME, 0, icon or DESKTOP_ENTRY, title or APP_NAME, body,
                                           action_list, hints, TIMEOUT_MS.get(duration, -1)))
        except Exception as e:
            logger.warning(f'[LINUX] notification failed: {e}')
            return None
        if urls:
            with self._lock:
                self._pending[notification_id] = urls
        return notification_id

    def _on_action(self, message):
        notification_id, key = message.body[0], message.body[1]
        with self._lock:
            target = self._pending.get(notification_id, {}).get(key)
        if callable(target):
            threading.Thread(target=target, name='notification-action', daemon=True).start()
        elif target:
            self._opener(target)

    def _on_closed(self, message):
        with self._lock:
            self._pending.pop(message.body[0], None)


def open_url(url):
    """Open a URL in the user's browser with the system (not bundled) libraries."""
    try:
        subprocess.Popen(['xdg-open', url], env=clean_env(), stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except Exception as e:
        logger.warning(f'[LINUX] could not open {url}: {e}')


_notifier = None
_notifier_lock = threading.Lock()


def get_notifier():
    global _notifier
    with _notifier_lock:
        if _notifier is None:
            _notifier = Notifier()
        return _notifier


def set_notifier(notifier):
    """Replace the process-wide notifier (tests, provider setup)."""
    global _notifier
    with _notifier_lock:
        _notifier = notifier


class Notification:
    """winotify.Notification-compatible."""

    def __init__(self, app_id, title, msg='', icon='', duration='short', launch=''):
        self.app_id = app_id
        self.title = title
        self.msg = msg
        self.icon = icon
        self.duration = duration
        self.launch = launch
        self.audio = audio.Default
        self.actions = []

    def set_audio(self, sound, loop=False):
        self.audio = sound

    def add_actions(self, label, launch=''):
        self.actions.append((label, launch))

    def show(self):
        get_notifier().notify(self.title, self.msg, duration=self.duration, actions=self.actions,
                              launch=self.launch, silent=self.audio == audio.Silent, icon=self.icon)

"""
Lock / unlock / sleep / wake / shutdown events on Linux.

Sources (all optional; whichever exist are used):
  system bus : systemd-logind (or elogind) Manager.PrepareForSleep,
               Manager.PrepareForShutdown, Session LockedHint changes
  session bus: org.gnome.ScreenSaver / org.freedesktop.ScreenSaver ActiveChanged

A "delay" inhibitor lock is held so the app gets a few seconds to finish its
session and upload before the machine sleeps or shuts down (the Windows build
uses WM_ENDSESSION for the same purpose). App handlers run on their own
thread, never on the D-Bus dispatcher.
"""

import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

LOGIND = 'org.freedesktop.login1'
LOGIND_PATH = '/org/freedesktop/login1'
MANAGER = 'org.freedesktop.login1.Manager'
SESSION = 'org.freedesktop.login1.Session'
PROPERTIES = 'org.freedesktop.DBus.Properties'

SCREENSAVERS = (
    ('org.gnome.ScreenSaver', '/org/gnome/ScreenSaver', 'org.gnome.ScreenSaver'),
    ('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver', 'org.freedesktop.ScreenSaver'),
)

HANDLER_BUDGET_S = 4.0          # logind's default InhibitDelayMaxSec is 5 s
LOCK_POLL_INTERVAL_S = 5.0


class SessionEvents:

    def __init__(self, system_bus=None, session_bus=None, clock=time.monotonic,
                 run_async=None, environ=None):
        self._system = system_bus
        self._session = session_bus
        self._clock = clock
        self._run_async = run_async or _run_in_thread
        self._environ = os.environ if environ is None else environ
        self._app = None
        self._started = False
        self._session_path = None
        self._inhibitor = None
        self._locked = None                 # last known state from any source
        self._lock_polled_at = None
        self._handles = []
        self._mutex = threading.Lock()

    # ----------------------------------------------------------------- public

    def start(self, app):
        """Subscribe to all available sources. Idempotent. True if any source works."""
        with self._mutex:
            self._app = app
            if self._started:
                return True
            self._started = True
        sources = 0
        if self._system is not None:
            sources += self._start_logind()
        if self._session is not None:
            for bus_name, path, interface in SCREENSAVERS:
                self._handles.append(self._session.subscribe(
                    self._on_screensaver_active_changed, interface=interface, member='ActiveChanged'))
            sources += 1
        logger.info(f'[LINUX] session events: logind={"yes" if self._session_path else "no"}, '
                    f'screensaver={"yes" if self._session is not None else "no"}')
        return sources > 0

    def is_locked(self):
        """Current lock state: signal-driven, refreshed by polling LockedHint."""
        now = self._clock()
        if self._lock_polled_at is None or now - self._lock_polled_at >= LOCK_POLL_INTERVAL_S:
            self._lock_polled_at = now
            polled = self._poll_locked()
            if polled is not None:
                self._set_locked(polled, notify=self._started)
        return bool(self._locked)

    def stop(self):
        for handle in self._handles:
            try:
                handle.remove()
            except Exception:
                pass
        self._handles = []
        self._release_inhibitor()
        self._started = False

    # ----------------------------------------------------------------- logind

    def _start_logind(self):
        try:
            self._session_path = self._find_session_path()
        except Exception as e:
            logger.info(f'[LINUX] logind not available: {e}')
            return 0
        self._handles.append(self._system.subscribe(
            self._on_prepare_for_sleep, interface=MANAGER, member='PrepareForSleep'))
        self._handles.append(self._system.subscribe(
            self._on_prepare_for_shutdown, interface=MANAGER, member='PrepareForShutdown'))
        if self._session_path:
            self._handles.append(self._system.subscribe(
                self._on_session_properties_changed, interface=PROPERTIES,
                member='PropertiesChanged', path=self._session_path))
            self._handles.append(self._system.subscribe(
                lambda msg: self._set_locked(True), interface=SESSION, member='Lock',
                path=self._session_path))
            self._handles.append(self._system.subscribe(
                lambda msg: self._set_locked(False), interface=SESSION, member='Unlock',
                path=self._session_path))
        self._take_inhibitor()
        return 1

    def _find_session_path(self):
        try:
            (path,) = self._system.call(LOGIND, LOGIND_PATH, MANAGER, 'GetSessionByPID', 'u', (os.getpid(),))
            return path
        except Exception:
            pass
        session_id = self._environ.get('XDG_SESSION_ID')
        if session_id:
            try:
                (path,) = self._system.call(LOGIND, LOGIND_PATH, MANAGER, 'GetSession', 's', (session_id,))
                return path
            except Exception:
                pass
        # Started outside the login session (e.g. a systemd user unit):
        # pick our user's session that sits on a seat (the graphical one).
        (sessions,) = self._system.call(LOGIND, LOGIND_PATH, MANAGER, 'ListSessions')
        uid = os.getuid()
        for _sid, session_uid, _user, seat, path in sessions:
            if session_uid == uid and seat:
                return path
        for _sid, session_uid, _user, _seat, path in sessions:
            if session_uid == uid:
                return path
        return None

    def _take_inhibitor(self):
        if self._inhibitor is not None or self._system is None:
            return
        try:
            (fd,) = self._system.call(LOGIND, LOGIND_PATH, MANAGER, 'Inhibit', 'ssss',
                                      ('shutdown:sleep', 'TimeTracker',
                                       'Saving the current tracking session', 'delay'))
            self._inhibitor = fd
        except Exception as e:
            logger.info(f'[LINUX] could not take logind delay inhibitor: {e}')

    def _release_inhibitor(self):
        inhibitor, self._inhibitor = self._inhibitor, None
        if inhibitor is None:
            return
        try:
            if hasattr(inhibitor, 'close'):
                inhibitor.close()
            elif isinstance(inhibitor, int):
                os.close(inhibitor)
        except Exception:
            pass

    def _poll_locked(self):
        if self._system is not None and self._session_path:
            try:
                return bool(self._system.get_property(LOGIND, self._session_path, SESSION, 'LockedHint'))
            except Exception:
                pass
        if self._session is not None:
            for bus_name, path, interface in SCREENSAVERS:
                try:
                    (active,) = self._session.call(bus_name, path, interface, 'GetActive', timeout=1.0)
                    return bool(active)
                except Exception:
                    continue
        return None

    # ---------------------------------------------------------------- signals

    def _on_prepare_for_sleep(self, message):
        going_down = bool(message.body[0])
        if going_down:
            self._call_app('_on_system_sleep', then=self._release_inhibitor)
        else:
            self._take_inhibitor()
            self._call_app('_on_system_wake')

    def _on_prepare_for_shutdown(self, message):
        if bool(message.body[0]):
            self._call_app('_on_system_shutdown', then=self._release_inhibitor)

    def _on_session_properties_changed(self, message):
        interface, changed = message.body[0], message.body[1]
        if interface != SESSION or 'LockedHint' not in changed:
            return
        value = changed['LockedHint']
        if isinstance(value, tuple):        # jeepney variant (signature, value)
            value = value[1]
        self._set_locked(bool(value))

    def _on_screensaver_active_changed(self, message):
        self._set_locked(bool(message.body[0]))

    def _set_locked(self, locked, notify=True):
        with self._mutex:
            changed = self._locked is not None and self._locked != locked
            first = self._locked is None
            self._locked = locked
        if not notify or first and not locked:
            return
        if changed or (first and locked):
            self._call_app('_on_screen_lock' if locked else '_on_screen_unlock')

    def _call_app(self, method_name, then=None):
        app = self._app
        handler = getattr(app, method_name, None) if app is not None else None

        def run():
            try:
                if handler is not None:
                    handler()
            except Exception as e:
                logger.warning(f'[LINUX] {method_name} failed: {e}')

        self._run_async(run, then, HANDLER_BUDGET_S)


def _run_in_thread(target, then, budget_s):
    """Run `target` on its own thread; call `then` when it ends or after budget_s."""
    worker = threading.Thread(target=target, name='session-event', daemon=True)
    worker.start()
    if then is None:
        return

    def finish():
        worker.join(budget_s)
        then()

    threading.Thread(target=finish, name='session-event-finish', daemon=True).start()

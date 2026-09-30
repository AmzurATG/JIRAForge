"""
Tests for SessionEvents (logind + ScreenSaver).

Spec: plan/2026-09-29_linux-desktop-app_phase1b-core-seams-and-services.md (AC 9)
"""

import os
from unittest.mock import Mock

from fakes import FakeBus, run_sync
from timetracker_linux.session_events import (LOGIND, MANAGER, SESSION, PROPERTIES,
                                              SessionEvents)

SESSION_PATH = '/org/freedesktop/login1/session/_32'


class FakeFD:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def _system_bus(**extra):
    fd = FakeFD()
    answers = {
        (LOGIND, MANAGER, 'GetSessionByPID'): (SESSION_PATH,),
        (LOGIND, MANAGER, 'Inhibit'): lambda args: (fd,),
    }
    answers.update(extra)
    bus = FakeBus(answers=answers, properties={(LOGIND, SESSION, 'LockedHint'): False})
    bus.fd = fd
    return bus


def _events(system=None, session=None, clock=None):
    return SessionEvents(system_bus=system, session_bus=session, run_async=run_sync,
                         clock=clock or (lambda: 0.0), environ={})


def _app():
    return Mock(spec=['_on_system_sleep', '_on_system_wake', '_on_screen_lock',
                      '_on_screen_unlock', '_on_system_shutdown'])


def test_start_is_idempotent():
    system = _system_bus()
    events = _events(system=system)
    assert events.start(_app()) is True
    count = len(system.subscriptions)
    assert events.start(_app()) is True
    assert len(system.subscriptions) == count


def test_sleep_releases_inhibitor_and_wake_retakes_it():
    system = _system_bus()
    events = _events(system=system)
    app = _app()
    events.start(app)
    inhibits = [c for c in system.calls if c[3] == 'Inhibit']
    assert inhibits and inhibits[0][4][0] == 'shutdown:sleep' and inhibits[0][4][3] == 'delay'

    system.fire(MANAGER, 'PrepareForSleep', (True,))
    app._on_system_sleep.assert_called_once()
    assert system.fd.closed is True

    system.fire(MANAGER, 'PrepareForSleep', (False,))
    app._on_system_wake.assert_called_once()
    assert len([c for c in system.calls if c[3] == 'Inhibit']) == 2


def test_shutdown_runs_handler_then_releases():
    system = _system_bus()
    events = _events(system=system)
    app = _app()
    events.start(app)
    system.fire(MANAGER, 'PrepareForShutdown', (True,))
    app._on_system_shutdown.assert_called_once()
    assert system.fd.closed is True


def test_locked_hint_changes_map_to_lock_unlock():
    system = _system_bus()
    events = _events(system=system)
    app = _app()
    events.start(app)
    system.fire(PROPERTIES, 'PropertiesChanged', (SESSION, {'LockedHint': ('b', True)}, []), path=SESSION_PATH)
    app._on_screen_lock.assert_called_once()
    system.fire(PROPERTIES, 'PropertiesChanged', (SESSION, {'LockedHint': ('b', False)}, []), path=SESSION_PATH)
    app._on_screen_unlock.assert_called_once()


def test_duplicate_lock_sources_collapse():
    system = _system_bus()
    session = FakeBus()
    events = _events(system=system, session=session)
    app = _app()
    events.start(app)
    system.fire(PROPERTIES, 'PropertiesChanged', (SESSION, {'LockedHint': True}, []), path=SESSION_PATH)
    session.fire('org.gnome.ScreenSaver', 'ActiveChanged', (True,))
    session.fire('org.freedesktop.ScreenSaver', 'ActiveChanged', (True,))
    assert app._on_screen_lock.call_count == 1
    session.fire('org.gnome.ScreenSaver', 'ActiveChanged', (False,))
    system.fire(PROPERTIES, 'PropertiesChanged', (SESSION, {'LockedHint': False}, []), path=SESSION_PATH)
    assert app._on_screen_unlock.call_count == 1


def test_other_session_properties_ignored():
    system = _system_bus()
    events = _events(system=system)
    app = _app()
    events.start(app)
    system.fire(PROPERTIES, 'PropertiesChanged', (SESSION, {'IdleHint': True}, []), path=SESSION_PATH)
    app._on_screen_lock.assert_not_called()


def test_is_locked_polls_locked_hint():
    now = [0.0]
    system = _system_bus()
    events = _events(system=system, clock=lambda: now[0])
    events.start(_app())
    assert events.is_locked() is False
    system.properties[(LOGIND, SESSION, 'LockedHint')] = True
    assert events.is_locked() is False      # cached for 5 s
    now[0] = 6.0
    assert events.is_locked() is True


def test_screensaver_poll_without_logind():
    session = FakeBus(answers={('org.gnome.ScreenSaver', 'org.gnome.ScreenSaver', 'GetActive'): (True,)})
    events = _events(session=session)
    events.start(_app())
    assert events.is_locked() is True


def test_session_path_fallback_list_sessions():
    uid = os.getuid()
    system = FakeBus(answers={
        (LOGIND, MANAGER, 'GetSessionByPID'): RuntimeError('not in a session'),
        (LOGIND, MANAGER, 'ListSessions'): ([('c1', uid, 'me', '', '/s/c1'), ('2', uid, 'me', 'seat0', '/s/2')],),
        (LOGIND, MANAGER, 'Inhibit'): RuntimeError('no inhibit'),
    })
    events = _events(system=system)
    events.start(_app())
    assert events._session_path == '/s/2'


def test_no_logind_no_screensaver():
    system = FakeBus()  # every call fails
    events = _events(system=system)
    assert events.start(_app()) is False

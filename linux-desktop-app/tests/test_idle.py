"""
Tests for the idle clock backends and IdleService.

Spec: plan/2026-09-29_linux-desktop-app_phase1b-core-seams-and-services.md (AC 10)
"""

from types import SimpleNamespace

from fakes import FakeBus
from timetracker_linux.idle import (FreedesktopScreenSaverIdle, IdleService, LogindIdleHint,
                                    MutterIdle, XScreenSaverIdle)


class Backend:
    def __init__(self, name, values):
        self.name = name
        self.values = list(values)
        self.calls = 0

    def idle_seconds(self):
        self.calls += 1
        value = self.values.pop(0) if len(self.values) > 1 else self.values[0]
        if isinstance(value, Exception):
            raise value
        return value


def test_mutter_ms_to_seconds():
    bus = FakeBus(answers={('org.gnome.Mutter.IdleMonitor', 'org.gnome.Mutter.IdleMonitor',
                            'GetIdletime'): (12500,)})
    assert MutterIdle(bus).idle_seconds() == 12.5


def test_freedesktop_seconds_and_kde_milliseconds():
    key = ('org.freedesktop.ScreenSaver', 'org.freedesktop.ScreenSaver', 'GetSessionIdleTime')
    assert FreedesktopScreenSaverIdle(FakeBus(answers={key: (30,)})).idle_seconds() == 30
    assert FreedesktopScreenSaverIdle(FakeBus(answers={key: (30000,)}), milliseconds=True).idle_seconds() == 30


def test_xss_uses_query_info(monkeypatch):
    import Xlib.ext.screensaver as ss
    monkeypatch.setattr(ss, 'query_info', lambda display, root: SimpleNamespace(idle=4200))
    fake_display = SimpleNamespace(screen=lambda: SimpleNamespace(root='root'))
    assert XScreenSaverIdle(display_factory=lambda: fake_display).idle_seconds() == 4.2


def test_logind_idlehint():
    iface = 'org.freedesktop.login1.Session'
    bus = FakeBus(properties={('org.freedesktop.login1', iface, 'IdleHint'): True,
                              ('org.freedesktop.login1', iface, 'IdleSinceHintMonotonic'): 10_000_000})
    backend = LogindIdleHint(bus, lambda: '/s/2', monotonic_us=lambda: 70_000_000)
    assert backend.idle_seconds() == 60.0
    bus.properties[('org.freedesktop.login1', iface, 'IdleHint')] = False
    assert backend.idle_seconds() == 0.0


def test_service_first_working_backend():
    a = Backend('a', [RuntimeError('down')])
    b = Backend('b', [7.0])
    service = IdleService([a, b])
    assert service.get_idle_seconds() == 7.0
    assert service.active_backend_name == 'b'


def test_service_skips_after_three_errors():
    a = Backend('a', [RuntimeError('down')])
    b = Backend('b', [1.0])
    service = IdleService([a, b])
    for _ in range(5):
        service.get_idle_seconds()
    assert a.calls == 3


def test_service_success_resets_error_count():
    a = Backend('a', [RuntimeError(), RuntimeError(), 5.0, RuntimeError(), RuntimeError(), 6.0])
    service = IdleService([a])
    results = [service.get_idle_seconds() for _ in range(6)]
    assert results == [None, None, 5.0, None, None, 6.0]


def test_service_none_when_nothing_works():
    assert IdleService([Backend('a', [RuntimeError()])]).get_idle_seconds() is None
    assert IdleService([]).get_idle_seconds() is None


def test_negative_clamped_and_reset():
    a = Backend('a', [RuntimeError(), RuntimeError(), RuntimeError(), -3.0])
    service = IdleService([a])
    for _ in range(3):
        service.get_idle_seconds()
    assert service.get_idle_seconds() is None
    service.reset()
    assert service.get_idle_seconds() == 0.0

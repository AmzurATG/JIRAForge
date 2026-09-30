"""
Regression tests for the old build's portal bugs, against a fake
ScreenCast portal on a private D-Bus daemon (no dialog, no real screen).

- C-2: persist_mode and restore_token must be sent to SelectSources, never CreateSession.
- C-1: the helper must subscribe to Response BEFORE calling; the fake portal
       replies instantly (before the method returns), so a late subscription
       would miss it and time out.
- The newest restore token from Start is handed back to the app.
"""

import os
import subprocess
import threading

import pytest

from test_helper import needs_helper, MemoryTokens, WINDOW
from timetracker_linux.dbus_bus import Bus
from timetracker_linux.helper_client import HelperClient, PortalScreenCastCapture

PORTAL = 'org.freedesktop.portal.Desktop'
PATH = '/org/freedesktop/portal/desktop'


@pytest.fixture
def private_bus(monkeypatch):
    daemon = subprocess.Popen(['dbus-daemon', '--session', '--nofork', '--print-address=1'],
                              stdout=subprocess.PIPE, text=True)
    address = daemon.stdout.readline().strip()
    monkeypatch.setenv('DBUS_SESSION_BUS_ADDRESS', address)
    yield address
    daemon.kill()
    daemon.wait()


class FakePortal:
    def __init__(self):
        self.bus = Bus('SESSION')
        assert self.bus.request_name(PORTAL)
        self.calls = []
        self.devnull = os.open('/dev/null', os.O_RDONLY)
        self.bus.export(PATH, self.handle)

    def respond(self, sender, token, results):
        request_path = f"/org/freedesktop/portal/desktop/request/{sender[1:].replace('.', '_')}/{token}"
        self.bus.emit_signal(request_path, 'org.freedesktop.portal.Request', 'Response', 'ua{sv}', (0, results))

    def handle(self, message):
        if message.interface == 'org.freedesktop.DBus.Properties':
            return 'v', (('u', 5),)
        options = message.body[-1] if message.body else {}
        self.calls.append((message.member, {k: v[1] for k, v in options.items()}))
        if message.member == 'OpenPipeWireRemote':
            return 'h', (self.devnull,)
        token = options['handle_token'][1]
        results = {}
        if message.member == 'CreateSession':
            results = {'session_handle': ('s', '/org/freedesktop/portal/desktop/session/1_1/tt')}
        elif message.member == 'Start':
            results = {'restore_token': ('s', 'fresh-token'),
                       'streams': ('a(ua{sv})', [(42, {'position': ('(ii)', (0, 0)),
                                                       'size': ('(ii)', (640, 480))})])}
        # Reply BEFORE returning from the method call (C-1 regression).
        self.respond(message.sender, token, results)
        return 'o', (f'/org/freedesktop/portal/desktop/request/x/{token}',)


@needs_helper
def test_option_placement_and_early_response(private_bus):
    portal = FakePortal()
    helper = HelperClient()
    tokens = MemoryTokens('old-token')
    backend = PortalScreenCastCapture(helper, lambda: dict(WINDOW), tokens=tokens)
    try:
        header = backend._start(interactive=False)
    finally:
        backend.stop()
        helper.close()
        portal.bus.close()
    members = [member for member, _ in portal.calls]
    assert members[:3] == ['CreateSession', 'SelectSources', 'Start']
    create, select = portal.calls[0][1], portal.calls[1][1]
    assert 'persist_mode' not in create and 'restore_token' not in create
    assert select['persist_mode'] == 2
    assert select['restore_token'] == 'old-token'
    assert select['types'] == 1 and select['multiple'] is True and select['cursor_mode'] == 1
    assert header['state'] == 'running', header
    assert tokens.saved == ['fresh-token']

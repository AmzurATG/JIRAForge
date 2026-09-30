"""
Integration tests for the shared D-Bus layer against a real session bus.
Skipped when no session bus is reachable. Uses private object paths only.
"""

import os
import threading

import pytest

from timetracker_linux.dbus_bus import Bus, DBusCallError, DBusMethodError


def _session_bus_available():
    try:
        bus = Bus('SESSION')
        bus.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _session_bus_available(), reason='no session bus')

PATH = '/com/amzur/TimeTracker/Test'
IFACE = 'com.amzur.TimeTracker.Test'


@pytest.fixture
def pair():
    server, client = Bus('SESSION'), Bus('SESSION')
    yield server, client
    server.close()
    client.close()


def test_exported_method_round_trip(pair):
    server, client = pair

    def handler(message):
        assert message.member == 'Echo'
        return 's', (message.body[0].upper(),)

    server.export(PATH, handler)
    (reply,) = client.call(server.unique_name, PATH, IFACE, 'Echo', 's', ('hello',))
    assert reply == 'HELLO'


def test_method_error_reply(pair):
    server, client = pair

    def handler(message):
        raise DBusMethodError('com.amzur.TimeTracker.Error.AccessDenied', 'nope')

    server.export(PATH, handler)
    with pytest.raises(DBusCallError) as exc:
        client.call(server.unique_name, PATH, IFACE, 'Anything')
    assert exc.value.name == 'com.amzur.TimeTracker.Error.AccessDenied'


def test_unknown_object(pair):
    server, client = pair
    with pytest.raises(DBusCallError) as exc:
        client.call(server.unique_name, '/nothing/here', IFACE, 'X')
    assert 'UnknownObject' in exc.value.name


def test_signal_subscription(pair):
    server, client = pair
    received = threading.Event()
    seen = {}

    def on_signal(message):
        seen['body'] = message.body
        received.set()

    handle = client.subscribe(on_signal, interface=IFACE, member='Changed')
    server.emit_signal(PATH, IFACE, 'Changed', 's', ('state',))
    assert received.wait(3)
    assert seen['body'] == ('state',)
    handle.remove()


def test_name_has_owner(pair):
    _, client = pair
    assert client.name_has_owner('org.freedesktop.DBus') is True
    assert client.name_has_owner('com.amzur.TimeTracker.DoesNotExist') is False


def test_call_timeout_to_missing_service(pair):
    _, client = pair
    with pytest.raises(DBusCallError):
        client.call('com.amzur.TimeTracker.DoesNotExist', PATH, IFACE, 'X', timeout=0.5)

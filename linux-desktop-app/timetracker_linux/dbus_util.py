"""
Small blocking D-Bus client on jeepney (pure Python, no GLib).

Every call has a timeout, so a missing or hung service can never block the
caller for long. Errors are raised as DBusCallError.
"""

from jeepney import DBusAddress, DBusErrorResponse, Properties, new_method_call
from jeepney.io.blocking import open_dbus_connection
from jeepney.wrappers import unwrap_msg

DEFAULT_TIMEOUT_S = 2.0

_DBUS_NAME = 'org.freedesktop.DBus'
_DBUS_PATH = '/org/freedesktop/DBus'


class DBusCallError(Exception):
    """A D-Bus call failed (error reply, timeout, or connection problem)."""


class DBusClient:
    def __init__(self, bus='SESSION', timeout=DEFAULT_TIMEOUT_S, enable_fds=False):
        self.timeout = timeout
        self._conn = open_dbus_connection(bus=bus, enable_fds=enable_fds)

    def call(self, bus_name, path, interface, method, signature='', args=()):
        """Call a method and return the reply body as a tuple."""
        address = DBusAddress(path, bus_name=bus_name, interface=interface)
        message = new_method_call(address, method, signature or None, tuple(args))
        return self._send(message)

    def get_property(self, bus_name, path, interface, name):
        """Return the unwrapped value of a D-Bus property."""
        address = DBusAddress(path, bus_name=bus_name, interface=interface)
        (variant,) = self._send(Properties(address).get(name))
        _signature, value = variant
        return value

    def name_has_owner(self, bus_name):
        (owned,) = self.call(_DBUS_NAME, _DBUS_PATH, _DBUS_NAME, 'NameHasOwner', 's', (bus_name,))
        return bool(owned)

    def close(self):
        try:
            self._conn.close()
        except Exception:
            pass

    def _send(self, message):
        try:
            reply = self._conn.send_and_get_reply(message, timeout=self.timeout)
            return unwrap_msg(reply)
        except DBusErrorResponse as e:
            raise DBusCallError(f"{e.name}: {e.data}") from e
        except TimeoutError as e:
            raise DBusCallError(f"timed out after {self.timeout}s") from e
        except OSError as e:
            raise DBusCallError(str(e)) from e

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

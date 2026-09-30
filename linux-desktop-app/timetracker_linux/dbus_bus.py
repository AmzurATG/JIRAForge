"""
Shared, thread-safe D-Bus connection (jeepney threading router, no GLib).

One Bus per bus type is shared by the services in this process: it sends
method calls from any thread, delivers subscribed signals, and serves
exported objects (tray icon, KWin callbacks). Callbacks run on one
dispatcher thread; anything slow must hand off to its own thread.

The old Linux build ran portal callbacks on GLib contexts that nobody
iterated and hung the tracker (C-1). Nothing here needs a main loop.
"""

import logging
import queue
import threading

from jeepney import (DBusAddress, DBusErrorResponse, HeaderFields, MatchRule, MessageType,
                     Properties, new_error, new_method_call, new_method_return, new_signal)
from jeepney.bus_messages import message_bus
from jeepney.io.threading import DBusRouter, open_dbus_connection
from jeepney.wrappers import unwrap_msg

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = 2.0

_buses = {}
_buses_lock = threading.Lock()


class DBusCallError(Exception):
    """A call failed: error reply, timeout or lost connection."""

    def __init__(self, message, name=None):
        super().__init__(message)
        self.name = name


class DBusMethodError(Exception):
    """Raise from an exported method handler to send a D-Bus error reply."""

    def __init__(self, name, message=''):
        super().__init__(message)
        self.name = name


class Message:
    """Read-only view of an incoming signal or method call."""

    def __init__(self, raw):
        self.raw = raw
        fields = raw.header.fields
        self.path = fields.get(HeaderFields.path)
        self.interface = fields.get(HeaderFields.interface)
        self.member = fields.get(HeaderFields.member)
        self.sender = fields.get(HeaderFields.sender)
        self.signature = fields.get(HeaderFields.signature, '')
        self.body = raw.body


class _Handle:
    def __init__(self, remove):
        self._remove = remove

    def remove(self):
        self._remove()


def get_bus(bus='SESSION'):
    """Process-wide shared Bus for 'SESSION' or 'SYSTEM'."""
    with _buses_lock:
        existing = _buses.get(bus)
        if existing is None:
            existing = _buses[bus] = Bus(bus)
        return existing


class Bus:

    def __init__(self, bus='SESSION', timeout=DEFAULT_TIMEOUT_S, enable_fds=True):
        self.bus = bus
        self.timeout = timeout
        self._router = DBusRouter(open_dbus_connection(bus=bus, enable_fds=enable_fds))
        self._incoming = queue.Queue()
        self._lock = threading.Lock()
        self._subscriptions = []        # (rule, callback)
        self._exports = {}              # path → handler
        self._closed = False
        self._filter_handles = [
            self._router.filter(MatchRule(type='signal'), queue=self._incoming),
            self._router.filter(MatchRule(type='method_call'), queue=self._incoming),
        ]
        self._dispatcher = threading.Thread(target=self._dispatch_loop,
                                            name=f'dbus-{bus.lower()}', daemon=True)
        self._dispatcher.start()

    # ------------------------------------------------------------------ calls

    @property
    def unique_name(self):
        return self._router.unique_name

    def call(self, bus_name, path, interface, method, signature='', args=(), timeout=None):
        address = DBusAddress(path, bus_name=bus_name, interface=interface)
        message = new_method_call(address, method, signature or None, tuple(args))
        return self._send_and_unwrap(message, timeout)

    def get_property(self, bus_name, path, interface, name, timeout=None):
        address = DBusAddress(path, bus_name=bus_name, interface=interface)
        (variant,) = self._send_and_unwrap(Properties(address).get(name), timeout)
        return variant[1]

    def name_has_owner(self, name):
        (owned,) = self._send_and_unwrap(message_bus.NameHasOwner(name), None)
        return bool(owned)

    def get_connection_pid(self, sender):
        (pid,) = self._send_and_unwrap(message_bus.GetConnectionUnixProcessID(sender), None)
        return int(pid)

    def request_name(self, name):
        """Own a well-known name. True if we are now the primary owner."""
        (result,) = self._send_and_unwrap(message_bus.RequestName(name, 4), None)  # DO_NOT_QUEUE
        return result in (1, 4)  # PRIMARY_OWNER, ALREADY_OWNER

    def _send_and_unwrap(self, message, timeout):
        if self._closed:
            raise DBusCallError('bus closed')
        try:
            reply = self._router.send_and_get_reply(message, timeout=timeout or self.timeout)
            return unwrap_msg(reply)
        except DBusErrorResponse as e:
            raise DBusCallError(f'{e.name}: {e.data}', name=e.name) from e
        except TimeoutError as e:
            raise DBusCallError(f'timed out after {timeout or self.timeout}s') from e
        except Exception as e:
            raise DBusCallError(str(e)) from e

    # ---------------------------------------------------------------- signals

    def subscribe(self, callback, *, interface=None, member=None, path=None, sender=None):
        """Call `callback(Message)` for matching signals. Returns a handle with remove()."""
        rule = MatchRule(type='signal', interface=interface, member=member, path=path, sender=sender)
        entry = (rule, callback)
        with self._lock:
            self._subscriptions.append(entry)
        try:
            self._send_and_unwrap(message_bus.AddMatch(rule), None)
        except DBusCallError as e:
            logger.debug(f'AddMatch failed ({interface}.{member}): {e}')

        def remove():
            with self._lock:
                if entry in self._subscriptions:
                    self._subscriptions.remove(entry)
            try:
                self._send_and_unwrap(message_bus.RemoveMatch(rule), None)
            except DBusCallError:
                pass

        return _Handle(remove)

    def emit_signal(self, path, interface, member, signature='', body=()):
        emitter = DBusAddress(path, interface=interface)
        self._router.send(new_signal(emitter, member, signature or None, tuple(body)))

    # ----------------------------------------------------------------- export

    def export(self, path, handler):
        """Serve method calls on `path`. handler(Message) → (signature, body) or None."""
        with self._lock:
            self._exports[path] = handler

        def remove():
            with self._lock:
                self._exports.pop(path, None)

        return _Handle(remove)

    # --------------------------------------------------------------- dispatch

    def _dispatch_loop(self):
        while not self._closed:
            try:
                raw = self._incoming.get(timeout=1.0)
            except queue.Empty:
                continue
            if raw is None:
                break
            try:
                if raw.header.message_type == MessageType.method_call:
                    self._handle_call(raw)
                else:
                    self._handle_signal(raw)
            except Exception as e:
                logger.warning(f'D-Bus dispatch error: {e}')

    def _handle_signal(self, raw):
        with self._lock:
            targets = [cb for rule, cb in self._subscriptions if rule.matches(raw)]
        if not targets:
            return
        message = Message(raw)
        for callback in targets:
            try:
                callback(message)
            except Exception as e:
                logger.warning(f'D-Bus signal handler error ({message.interface}.{message.member}): {e}')

    def _handle_call(self, raw):
        message = Message(raw)
        with self._lock:
            handler = self._exports.get(message.path)
        if handler is None:
            if message.interface == 'org.freedesktop.DBus.Peer' and message.member == 'Ping':
                self._router.send(new_method_return(raw))
            elif not raw.header.flags & 1:  # NO_REPLY_EXPECTED
                self._router.send(new_error(raw, 'org.freedesktop.DBus.Error.UnknownObject',
                                            's', (f'no object at {message.path}',)))
            return
        try:
            result = handler(message)
            if raw.header.flags & 1:
                return
            signature, body = result if result else (None, ())
            self._router.send(new_method_return(raw, signature, tuple(body)))
        except DBusMethodError as e:
            self._router.send(new_error(raw, e.name, 's', (str(e),)))
        except Exception as e:
            logger.warning(f'D-Bus method handler error ({message.interface}.{message.member}): {e}')
            self._router.send(new_error(raw, 'org.freedesktop.DBus.Error.Failed', 's', (str(e),)))

    def close(self):
        self._closed = True
        self._incoming.put(None)
        try:
            self._router.close()
        except Exception:
            pass

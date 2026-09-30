"""
Idle time via the Wayland `ext-idle-notify-v1` protocol (KWin 6, Sway,
Hyprland, labwc, river, niri, COSMIC, ...), with a tiny pure-Python Wayland
client: no libwayland binding, no compiled dependency.

Only three interfaces are used: wl_registry, wl_seat (as an argument only)
and ext_idle_notifier_v1. We ask to be told after 1 s without input
("idled") and when input comes back ("resumed"); idle seconds are derived
from those two events. No input events are ever read.
"""

import logging
import os
import socket
import struct
import threading
import time

logger = logging.getLogger(__name__)

NOTIFY_AFTER_MS = 1000

# wl_display (object 1) requests / events
WL_DISPLAY_SYNC = 0
WL_DISPLAY_GET_REGISTRY = 1
WL_DISPLAY_EVENT_ERROR = 0
WL_DISPLAY_EVENT_DELETE_ID = 1
# wl_registry
WL_REGISTRY_BIND = 0
WL_REGISTRY_EVENT_GLOBAL = 0
# wl_callback
WL_CALLBACK_EVENT_DONE = 0
# ext_idle_notifier_v1 / ext_idle_notification_v1
IDLE_NOTIFIER_GET_NOTIFICATION = 1
IDLE_NOTIFICATION_EVENT_IDLED = 0
IDLE_NOTIFICATION_EVENT_RESUMED = 1


def _pad(n):
    return (n + 3) & ~3


def encode_string(value):
    data = value.encode('utf-8') + b'\0'
    return struct.pack('<I', len(data)) + data + b'\0' * (_pad(len(data)) - len(data))


def decode_string(payload, offset):
    (length,) = struct.unpack_from('<I', payload, offset)
    offset += 4
    value = payload[offset:offset + length - 1].decode('utf-8', 'replace') if length else ''
    return value, offset + _pad(length)


def message(object_id, opcode, args=b''):
    return struct.pack('<II', object_id, ((8 + len(args)) << 16) | opcode) + args


class WaylandConnection:
    """Minimal Wayland wire protocol client (no fd passing needed here)."""

    def __init__(self, sock):
        self.sock = sock
        self.next_id = 2            # 1 is wl_display
        self.buffer = b''

    @classmethod
    def connect(cls, environ=None):
        environ = os.environ if environ is None else environ
        display = environ.get('WAYLAND_DISPLAY') or 'wayland-0'
        path = display if display.startswith('/') else os.path.join(environ.get('XDG_RUNTIME_DIR', ''), display)
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(path)
        return cls(sock)

    def new_id(self):
        value = self.next_id
        self.next_id += 1
        return value

    def send(self, data):
        self.sock.sendall(data)

    def read_events(self, timeout=None):
        """Block for data, then return all complete (object_id, opcode, payload) events."""
        self.sock.settimeout(timeout)
        data = self.sock.recv(65536)
        if not data:
            raise ConnectionError('compositor closed the connection')
        self.buffer += data
        events = []
        while len(self.buffer) >= 8:
            object_id, size_opcode = struct.unpack_from('<II', self.buffer)
            size = size_opcode >> 16
            if len(self.buffer) < size:
                break
            events.append((object_id, size_opcode & 0xffff, self.buffer[8:size]))
            self.buffer = self.buffer[size:]
        return events

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def list_globals(connection, timeout=2.0):
    """{interface: (name, version)} advertised by the compositor."""
    registry = connection.new_id()
    callback = connection.new_id()
    connection.send(message(1, WL_DISPLAY_GET_REGISTRY, struct.pack('<I', registry)) +
                    message(1, WL_DISPLAY_SYNC, struct.pack('<I', callback)))
    globals_ = {}
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('no reply from the compositor')
        for object_id, opcode, payload in connection.read_events(remaining):
            if object_id == registry and opcode == WL_REGISTRY_EVENT_GLOBAL:
                (name,) = struct.unpack_from('<I', payload)
                interface, offset = decode_string(payload, 4)
                (version,) = struct.unpack_from('<I', payload, offset)
                globals_[interface] = (name, version)
            elif object_id == callback and opcode == WL_CALLBACK_EVENT_DONE:
                return registry, globals_
            elif object_id == 1 and opcode == WL_DISPLAY_EVENT_ERROR:
                raise ConnectionError('Wayland protocol error')


def bind(connection, registry, name, interface, version):
    new_id = connection.new_id()
    connection.send(message(registry, WL_REGISTRY_BIND, struct.pack('<I', name) + encode_string(interface) +
                            struct.pack('<II', version, new_id)))
    return new_id


class WaylandIdleNotify:
    """Idle backend over ext-idle-notify-v1; runs its own event thread."""
    name = 'wayland_idle_notify'

    def __init__(self, connection, notification_id, clock=time.monotonic):
        self._connection = connection
        self._notification = notification_id
        self._clock = clock
        self._idle_since = None         # clock() when input stopped, None while active
        self._alive = True
        self._lock = threading.Lock()
        threading.Thread(target=self._loop, name='wayland-idle', daemon=True).start()

    @classmethod
    def create_or_none(cls, environ=None):
        """Connect and subscribe; None if the compositor lacks the protocol."""
        environ = os.environ if environ is None else environ
        if not environ.get('WAYLAND_DISPLAY'):
            return None
        try:
            connection = WaylandConnection.connect(environ)
            registry, globals_ = list_globals(connection)
        except Exception as e:
            logger.info(f'[LINUX] Wayland idle protocol unavailable: {e}')
            return None
        if 'ext_idle_notifier_v1' not in globals_ or 'wl_seat' not in globals_:
            connection.close()
            return None
        seat = bind(connection, registry, globals_['wl_seat'][0], 'wl_seat', 1)
        notifier = bind(connection, registry, globals_['ext_idle_notifier_v1'][0], 'ext_idle_notifier_v1', 1)
        notification = connection.new_id()
        connection.send(message(notifier, IDLE_NOTIFIER_GET_NOTIFICATION,
                                struct.pack('<III', notification, NOTIFY_AFTER_MS, seat)))
        return cls(connection, notification)

    def handle_event(self, object_id, opcode):
        if object_id != self._notification:
            return
        with self._lock:
            if opcode == IDLE_NOTIFICATION_EVENT_IDLED:
                self._idle_since = self._clock() - NOTIFY_AFTER_MS / 1000.0
            elif opcode == IDLE_NOTIFICATION_EVENT_RESUMED:
                self._idle_since = None

    def _loop(self):
        try:
            while self._alive:
                for object_id, opcode, _payload in self._connection.read_events(None):
                    self.handle_event(object_id, opcode)
        except Exception as e:
            logger.info(f'[LINUX] Wayland idle connection ended: {e}')
        self._alive = False

    def idle_seconds(self):
        if not self._alive:
            raise ConnectionError('Wayland idle connection lost')
        with self._lock:
            if self._idle_since is None:
                return 0.0
            return max(0.0, self._clock() - self._idle_since)

    def close(self):
        self._alive = False
        self._connection.close()

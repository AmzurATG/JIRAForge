"""
Focused window and output on Sway (i3 IPC) and Hyprland (hyprctl socket).
"""

import json
import os
import socket
import struct

from .common import empty_window, xdg_runtime_dir

# ------------------------------------------------------------------- Sway

_I3_MAGIC = b'i3-ipc'
SWAY_GET_OUTPUTS = 3
SWAY_GET_TREE = 4


def sway_request(socket_path, message_type, payload=b'', timeout=2.0):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(socket_path)
        sock.sendall(_I3_MAGIC + struct.pack('<II', len(payload), message_type) + payload)
        header = _recv_exact(sock, len(_I3_MAGIC) + 8)
        length, _reply_type = struct.unpack('<II', header[len(_I3_MAGIC):])
        return json.loads(_recv_exact(sock, length))


def _recv_exact(sock, size):
    data = b''
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError('IPC socket closed')
        data += chunk
    return data


def sway_focused_from_tree(tree):
    """Common window dict for the focused view in a sway GET_TREE reply (pure)."""
    def walk(node, output):
        if node.get('type') == 'output':
            output = node
        if node.get('focused') and node.get('type') in ('con', 'floating_con') and node.get('pid'):
            return node, output
        for child in node.get('nodes', []) + node.get('floating_nodes', []):
            found = walk(child, output)
            if found:
                return found
        return None

    found = walk(tree, None)
    if not found:
        return None
    node, output = found
    window = empty_window()
    props = node.get('window_properties') or {}
    window['window_id'] = f"sway:{node.get('id')}"
    window['title'] = node.get('name') or ''
    window['app_id'] = node.get('app_id') or ''
    window['wm_class'] = (props.get('class') or '').lower()
    window['pid'] = node.get('pid')
    if output is not None:
        rect = output.get('rect') or {}
        window['monitor_name'] = output.get('name')
        window['monitor_rect'] = (rect.get('x', 0), rect.get('y', 0), rect.get('width', 0), rect.get('height', 0))
        window['scale'] = float(output.get('scale') or 1.0)
    return window


class SwayWindow:
    name = 'sway'

    def __init__(self, environ=None):
        self._environ = os.environ if environ is None else environ

    @property
    def socket_path(self):
        return self._environ.get('SWAYSOCK')

    def is_available(self):
        return bool(self.socket_path) and os.path.exists(self.socket_path)

    def focused_window(self):
        return sway_focused_from_tree(sway_request(self.socket_path, SWAY_GET_TREE))

    def focused_output(self):
        for output in sway_request(self.socket_path, SWAY_GET_OUTPUTS):
            if output.get('focused'):
                return output.get('name')
        return None


# --------------------------------------------------------------- Hyprland

def hyprland_socket_path(environ=None):
    environ = os.environ if environ is None else environ
    signature = environ.get('HYPRLAND_INSTANCE_SIGNATURE')
    if not signature:
        return None
    for base in (os.path.join(xdg_runtime_dir(environ), 'hypr'), '/tmp/hypr'):
        path = os.path.join(base, signature, '.socket.sock')
        if os.path.exists(path):
            return path
    return None


def hyprland_request(socket_path, command, timeout=2.0):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(socket_path)
        sock.sendall(command.encode())
        data = b''
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
    return json.loads(data.decode('utf-8', 'replace') or 'null')


def hyprland_window(active, monitors):
    """Common window dict from `j/activewindow` and `j/monitors` replies (pure)."""
    if not active or not active.get('address'):
        return None
    window = empty_window()
    window['window_id'] = f"hypr:{active['address']}"
    window['title'] = active.get('title') or ''
    window['wm_class'] = (active.get('class') or active.get('initialClass') or '').lower()
    window['app_id'] = window['wm_class']
    window['pid'] = active.get('pid')
    window['minimized'] = bool(active.get('hidden'))
    for monitor in monitors or []:
        if monitor.get('id') == active.get('monitor'):
            window['monitor_name'] = monitor.get('name')
            window['monitor_rect'] = (monitor.get('x', 0), monitor.get('y', 0),
                                      monitor.get('width', 0), monitor.get('height', 0))
            window['scale'] = float(monitor.get('scale') or 1.0)
            break
    return window


class HyprlandWindow:
    name = 'hyprland'

    def __init__(self, environ=None):
        self._environ = os.environ if environ is None else environ

    def is_available(self):
        return hyprland_socket_path(self._environ) is not None

    def focused_window(self):
        path = hyprland_socket_path(self._environ)
        return hyprland_window(hyprland_request(path, 'j/activewindow'),
                               hyprland_request(path, 'j/monitors'))

    def focused_output(self):
        path = hyprland_socket_path(self._environ)
        for monitor in hyprland_request(path, 'j/monitors') or []:
            if monitor.get('focused'):
                return monitor.get('name')
        return None

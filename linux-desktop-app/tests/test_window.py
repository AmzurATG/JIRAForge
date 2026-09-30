"""
Tests for window-info backends and WindowService.

Spec: plan/2026-09-29_linux-desktop-app_phase1b-core-seams-and-services.md (AC 11)
"""

import json
import os
import socket
import struct
import threading
from types import SimpleNamespace

import pytest

from timetracker_linux.window.common import monitor_for_rect, resolve_app_name
from timetracker_linux.window.service import WindowService
from timetracker_linux.window.wlroots_ipc import (SWAY_GET_TREE, hyprland_request, hyprland_window,
                                                  sway_focused_from_tree, sway_request)
from timetracker_linux.window.x11_ewmh import window_from_props

MONITORS = [
    {'name': 'eDP-1', 'rect': (0, 0, 1920, 1200)},
    {'name': 'HDMI-1', 'rect': (1920, 0, 2560, 1440)},
]


class FakePsutil:
    def __init__(self, names):
        self.names = names

    def Process(self, pid):
        if pid not in self.names:
            raise LookupError(pid)
        return SimpleNamespace(name=lambda: self.names[pid])


# ------------------------------------------------------------------- common

class TestAppName:

    def test_process_name_used(self):
        assert resolve_app_name({'pid': 10, 'wm_class': 'Code'}, FakePsutil({10: 'code'})) == 'code'

    def test_generic_runtime_uses_wm_class(self):
        window = {'pid': 11, 'wm_class': 'jetbrains-idea'}
        assert resolve_app_name(window, FakePsutil({11: 'java'})) == 'jetbrains-idea'

    def test_reverse_dns_app_id_shortened(self):
        window = {'pid': 12, 'app_id': 'com.slack.Slack'}
        assert resolve_app_name(window, FakePsutil({12: 'bwrap'})) == 'slack'

    def test_no_pid_uses_app_id(self):
        assert resolve_app_name({'app_id': 'org.gnome.Nautilus'}, FakePsutil({})) == 'nautilus'

    def test_python_versioned_runtime(self):
        window = {'pid': 13, 'wm_class': 'meld'}
        assert resolve_app_name(window, FakePsutil({13: 'python3.12'})) == 'meld'


def test_monitor_largest_overlap():
    # Window mostly on the external monitor
    assert monitor_for_rect((1800, 100, 1000, 800), MONITORS)['name'] == 'HDMI-1'
    assert monitor_for_rect((100, 100, 800, 600), MONITORS)['name'] == 'eDP-1'
    assert monitor_for_rect((-5000, -5000, 10, 10), MONITORS) is None


# ---------------------------------------------------------------------- X11

def test_x11_props_to_window():
    props = {'window_id': 0x3a00007, 'title': 'PROJ-7 fix — Mozilla Firefox',
             'wm_class': ('Navigator', 'firefox'), 'pid': 4242, 'state': ['_NET_WM_STATE_FOCUSED'],
             'geometry': (2000, 40, 1200, 900), 'frame_extents': (0, 0, 37, 0)}
    window = window_from_props(props, MONITORS)
    assert window['window_id'] == 'x11:0x3a00007'
    assert window['title'] == 'PROJ-7 fix — Mozilla Firefox'
    assert window['wm_class'] == 'firefox'
    assert window['pid'] == 4242
    assert window['monitor_name'] == 'HDMI-1'
    assert window['monitor_rect'] == (1920, 0, 2560, 1440)
    assert window['minimized'] is False


def test_x11_hidden_is_minimized():
    props = {'window_id': 1, 'title': 't', 'state': ['_NET_WM_STATE_HIDDEN'], 'geometry': None}
    assert window_from_props(props, MONITORS)['minimized'] is True


# --------------------------------------------------------------------- Sway

SWAY_TREE = {
    'type': 'root', 'nodes': [
        {'type': 'output', 'name': '__i3', 'nodes': []},
        {'type': 'output', 'name': 'DP-2', 'rect': {'x': 1920, 'y': 0, 'width': 2560, 'height': 1440},
         'scale': 1.5, 'nodes': [
             {'type': 'workspace', 'name': '1', 'nodes': [
                 {'type': 'con', 'id': 7, 'name': 'Terminal', 'focused': False, 'pid': 100, 'app_id': 'foot'},
                 {'type': 'con', 'id': 9, 'name': 'PROJ-9 - VS Code', 'focused': True, 'pid': 200,
                  'app_id': None, 'window_properties': {'class': 'Code'}},
             ], 'floating_nodes': []},
         ]},
    ]}


def test_sway_tree():
    window = sway_focused_from_tree(SWAY_TREE)
    assert window['window_id'] == 'sway:9'
    assert window['title'] == 'PROJ-9 - VS Code'
    assert window['wm_class'] == 'code'
    assert window['pid'] == 200
    assert window['monitor_name'] == 'DP-2'
    assert window['scale'] == 1.5


def test_sway_no_focused_view():
    assert sway_focused_from_tree({'type': 'root', 'nodes': []}) is None


@pytest.fixture
def unix_server(tmp_path):
    """One-shot Unix socket server; handler(conn) writes the reply."""
    path = str(tmp_path / 'ipc.sock')
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(1)
    received = {}

    def serve(handler):
        def run():
            conn, _ = server.accept()
            with conn:
                handler(conn, received)
        threading.Thread(target=run, daemon=True).start()
        return path, received

    yield serve
    server.close()


def test_sway_ipc_wire_format(unix_server):
    def handler(conn, received):
        header = conn.recv(14)
        received['type'] = struct.unpack('<II', header[6:])[1]
        payload = json.dumps(SWAY_TREE).encode()
        conn.sendall(b'i3-ipc' + struct.pack('<II', len(payload), SWAY_GET_TREE) + payload)

    path, received = unix_server(handler)
    tree = sway_request(path, SWAY_GET_TREE)
    assert received['type'] == SWAY_GET_TREE
    assert sway_focused_from_tree(tree)['pid'] == 200


# ----------------------------------------------------------------- Hyprland

def test_hyprland_window():
    active = {'address': '0x55d0', 'class': 'firefox', 'title': 'Board - Jira', 'pid': 300, 'monitor': 1}
    monitors = [{'id': 0, 'name': 'eDP-1', 'x': 0, 'y': 0, 'width': 1920, 'height': 1080, 'scale': 1.0},
                {'id': 1, 'name': 'DP-1', 'x': 1920, 'y': 0, 'width': 3840, 'height': 2160, 'scale': 2.0}]
    window = hyprland_window(active, monitors)
    assert window['window_id'] == 'hypr:0x55d0'
    assert window['wm_class'] == 'firefox'
    assert window['monitor_name'] == 'DP-1'
    assert window['scale'] == 2.0


def test_hyprland_empty_active_window():
    assert hyprland_window({}, []) is None


def test_hyprland_request(unix_server):
    def handler(conn, received):
        received['cmd'] = conn.recv(100).decode()
        conn.sendall(json.dumps({'address': '0x1', 'title': 'x'}).encode())

    path, received = unix_server(handler)
    assert hyprland_request(path, 'j/activewindow')['address'] == '0x1'
    assert received['cmd'] == 'j/activewindow'


# ------------------------------------------------------------------ service

class Backend:
    def __init__(self, name, windows, available=True):
        self.name = name
        self.windows = list(windows)
        self.available = available
        self.calls = 0

    def is_available(self):
        return self.available

    def focused_window(self):
        self.calls += 1
        value = self.windows.pop(0) if len(self.windows) > 1 else self.windows[0]
        if isinstance(value, Exception):
            raise value
        return dict(value) if value else value


def test_service_resolves_app_and_backend():
    backend = Backend('x11_ewmh', [{'title': 'A', 'pid': 5, 'wm_class': 'x'}])
    service = WindowService([backend], psutil_module=FakePsutil({5: 'gedit'}))
    window = service.get_focused_window()
    assert window['app'] == 'gedit'
    assert window['backend'] == 'x11_ewmh'


def test_service_falls_through_and_skips_failing():
    now = [0.0]
    bad = Backend('bad', [RuntimeError('ipc down')])
    good = Backend('good', [{'title': 'B', 'app': 'b'}])
    service = WindowService([bad, good], psutil_module=FakePsutil({}), clock=lambda: now[0])
    for _ in range(5):
        assert service.get_focused_window()['title'] == 'B'
    assert bad.calls == 3
    now[0] = 1801
    service.get_focused_window()
    assert bad.calls == 4


def test_service_none_focus_is_none():
    service = WindowService([Backend('a', [None])], psutil_module=FakePsutil({}))
    assert service.get_focused_window() is None


def test_service_unavailable_backends():
    service = WindowService([Backend('a', [{}], available=False)], psutil_module=FakePsutil({}))
    assert service.get_focused_window() is None
    assert service.has_backend() is False

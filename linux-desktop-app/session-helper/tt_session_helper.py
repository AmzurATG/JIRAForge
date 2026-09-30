#!/usr/bin/env python3
"""
TimeTracker session helper.

Runs on the distribution's own /usr/bin/python3 with the distribution's
PyGObject and GStreamer, so their versions always match (the old Linux build
imported the distro's python3-gi into its bundled Python). It owns the only
GLib main loop, on its main thread (the old build waited on GLib contexts
nobody iterated and hung, finding C-1). It serves:

  - XDG portal ScreenCast (PipeWire) frames      -> fallback capture on Wayland
  - AT-SPI focused window                        -> fallback window info

Protocol over the inherited socket (--fd N), both directions:
  4-byte big-endian header length, UTF-8 JSON header, then
  header["payload"] raw bytes (frames only).

Must stay compatible with Python 3.6 (RHEL/Alma 8 system Python).
"""

import argparse
import json
import os
import socket
import struct
import sys
import threading
import time

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gio, GLib, Gst  # noqa: E402

PORTAL = 'org.freedesktop.portal.Desktop'
PORTAL_PATH = '/org/freedesktop/portal/desktop'
SCREENCAST = 'org.freedesktop.portal.ScreenCast'
REQUEST = 'org.freedesktop.portal.Request'
SOURCE_MONITOR = 1
CURSOR_HIDDEN = 1
PERSIST_UNTIL_REVOKED = 2
FIRST_FRAME_WAIT_S = 2.0
PORTAL_STEP_TIMEOUT_S = 30
INTERACTIVE_TIMEOUT_S = 300
ATSPI_TIMEOUT_MS = 800


def log(message):
    sys.stderr.write('[helper] {}\n'.format(message))
    sys.stderr.flush()


# ---------------------------------------------------------------- protocol

class Channel:
    """Length-prefixed JSON messages (+ optional raw payload) over a socket."""

    def __init__(self, sock):
        self.sock = sock
        self.buffer = b''

    def send(self, header, payload=b''):
        if payload:
            header = dict(header, payload=len(payload))
        data = json.dumps(header).encode('utf-8')
        self.sock.sendall(struct.pack('>I', len(data)) + data + payload)

    def feed(self, data):
        """Add received bytes; return complete (header, payload) messages."""
        self.buffer += data
        messages = []
        while len(self.buffer) >= 4:
            (length,) = struct.unpack('>I', self.buffer[:4])
            if len(self.buffer) < 4 + length:
                break
            header = json.loads(self.buffer[4:4 + length].decode('utf-8'))
            need = header.get('payload', 0)
            if len(self.buffer) < 4 + length + need:
                break
            payload = self.buffer[4 + length:4 + length + need]
            self.buffer = self.buffer[4 + length + need:]
            messages.append((header, payload))
        return messages


# ------------------------------------------------------- portal ScreenCast

class ScreenCast:
    """One persistent portal ScreenCast session with one appsink per monitor.

    Fixes for the old build's failures (plan §3.1):
      C-2: persist_mode / restore_token go into SelectSources; every Start's new
           token is returned to the app (tokens are single-use).
      C-1: Response signals are subscribed on the precomputed request path
           BEFORE each call, on this thread's (default) main context.
      C-3: one long-lived stream, latest frame kept by appsink; the PipeWire
           fd is owned here and closed exactly once in stop().
    """

    def __init__(self, bus, test_source=None):
        self.bus = bus
        self.test_source = test_source
        self.state = 'stopped'          # stopped | starting | running | denied | failed
        self.detail = ''
        self.session_handle = None
        self.streams = []               # [{'node','position','size','pipeline','sink'}]
        self.pw_fd = -1
        self.restore_token = None
        self._token_counter = 0
        self._pending_start = []        # callbacks waiting for the start result
        self._started_at = 0.0

    # --- portal plumbing ---------------------------------------------------

    def _token(self):
        self._token_counter += 1
        return 'tt{}_{}'.format(os.getpid(), self._token_counter)

    def _request_path(self, token):
        sender = self.bus.get_unique_name()[1:].replace('.', '_')
        return '/org/freedesktop/portal/desktop/request/{}/{}'.format(sender, token)

    def _portal_call(self, method, params, token, on_response, timeout_s=PORTAL_STEP_TIMEOUT_S):
        path = self._request_path(token)
        state = {'sub': 0, 'timer': 0}

        def finish(code, results):
            if state['sub']:
                self.bus.signal_unsubscribe(state['sub'])
                state['sub'] = 0
            if state['timer']:
                GLib.source_remove(state['timer'])
                state['timer'] = 0
            on_response(code, results)

        def on_signal(conn, sender, obj_path, iface, signal, response):
            code, results = response.unpack()
            finish(code, results)

        def on_timeout():
            state['timer'] = 0
            finish(-1, {'error': 'no response from the portal within {}s'.format(timeout_s)})
            return False

        # Subscribe first, then call: a fast portal cannot slip past us.
        state['sub'] = self.bus.signal_subscribe(PORTAL, REQUEST, 'Response', path, None,
                                                 Gio.DBusSignalFlags.NONE, on_signal)
        state['timer'] = GLib.timeout_add_seconds(timeout_s, on_timeout)

        def on_called(conn, result):
            try:
                conn.call_finish(result)
            except GLib.Error as e:
                finish(-1, {'error': e.message})

        self.bus.call(PORTAL, PORTAL_PATH, SCREENCAST, method, params, None,
                      Gio.DBusCallFlags.NONE, -1, None, on_called)

    def available(self):
        try:
            reply = self.bus.call_sync(PORTAL, PORTAL_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                                       GLib.Variant('(ss)', (SCREENCAST, 'version')), None,
                                       Gio.DBusCallFlags.NONE, 2000, None)
            return int(reply.unpack()[0])
        except GLib.Error:
            return 0

    # --- lifecycle ------------------------------------------------------------

    def start(self, restore_token, interactive, done):
        """Start (or reuse) the session. done(result_dict) is called once."""
        if self.state == 'running':
            done(self._status())
            return
        self._pending_start.append(done)
        if self.state == 'starting':
            return
        if not restore_token and not interactive:
            self._finish_start('denied', 'no screen sharing permission yet')
            return
        self.state = 'starting'
        self._started_at = time.monotonic()
        if self.test_source:
            self._open_pipelines([{'node': 0, 'position': (0, 0), 'size': (640, 480)}], -1)
            self.restore_token = 'test-token'
            self._finish_start('running', '')
            return

        version = self.available()
        if version < 4:
            self._finish_start('failed', 'ScreenCast portal v{} lacks restore tokens (need 4+)'.format(version))
            return
        session_token = self._token()
        token = self._token()
        self._portal_call('CreateSession', GLib.Variant('(a{sv})', ({
            'handle_token': GLib.Variant('s', token),
            'session_handle_token': GLib.Variant('s', session_token)},)), token,
            lambda code, results: self._on_session(code, results, restore_token, interactive))

    def _on_session(self, code, results, restore_token, interactive):
        if code != 0:
            self._finish_start('failed', 'CreateSession failed: {}'.format(results.get('error', code)))
            return
        self.session_handle = results['session_handle']
        token = self._token()
        options = {
            'handle_token': GLib.Variant('s', token),
            'types': GLib.Variant('u', SOURCE_MONITOR),
            'multiple': GLib.Variant('b', True),
            'cursor_mode': GLib.Variant('u', CURSOR_HIDDEN),
            'persist_mode': GLib.Variant('u', PERSIST_UNTIL_REVOKED),
        }
        if restore_token:
            options['restore_token'] = GLib.Variant('s', restore_token)
        self._portal_call('SelectSources', GLib.Variant('(oa{sv})', (self.session_handle, options)), token,
                          lambda code, results: self._on_sources(code, results, interactive))

    def _on_sources(self, code, results, interactive):
        if code != 0:
            self._finish_start('failed', 'SelectSources failed: {}'.format(results.get('error', code)))
            return
        token = self._token()
        self._portal_call('Start', GLib.Variant('(osa{sv})', (self.session_handle, '', {
            'handle_token': GLib.Variant('s', token)})), token, self._on_started,
            timeout_s=INTERACTIVE_TIMEOUT_S if interactive else PORTAL_STEP_TIMEOUT_S)

    def _on_started(self, code, results):
        if code == 1:
            self._close_session()
            self._finish_start('denied', 'the user did not allow screen sharing')
            return
        if code != 0:
            self._close_session()
            self._finish_start('failed', 'Start failed: {}'.format(results.get('error', code)))
            return
        self.restore_token = results.get('restore_token')
        streams = []
        for node, props in results.get('streams', []):
            streams.append({'node': node, 'position': tuple(props.get('position', (0, 0))),
                            'size': tuple(props.get('size', (0, 0)))})
        try:
            reply, fds = self.bus.call_with_unix_fd_list_sync(
                PORTAL, PORTAL_PATH, SCREENCAST, 'OpenPipeWireRemote',
                GLib.Variant('(oa{sv})', (self.session_handle, {})), None, Gio.DBusCallFlags.NONE,
                5000, None, None)
            pw_fd = fds.get(reply.unpack()[0])
        except GLib.Error as e:
            self._close_session()
            self._finish_start('failed', 'OpenPipeWireRemote failed: {}'.format(e.message))
            return
        self._open_pipelines(streams, pw_fd)
        self._finish_start('running', '')

    def _open_pipelines(self, streams, pw_fd):
        self.pw_fd = pw_fd
        for stream in streams:
            if self.test_source:
                width, height = stream['size']
                source = 'videotestsrc is-live=true pattern=smpte ! video/x-raw,width={},height={}'.format(
                    width, height)
            else:
                # always-copy: some GPUs hand out DMA-BUF frames that read back empty.
                source = 'pipewiresrc fd={} path={} always-copy=true do-timestamp=true'.format(
                    pw_fd, stream['node'])
            description = ('{} ! videoconvert ! video/x-raw,format=BGRx ! '
                           'appsink name=sink max-buffers=1 drop=true sync=false emit-signals=false').format(source)
            pipeline = Gst.parse_launch(description)
            stream['pipeline'] = pipeline
            stream['sink'] = pipeline.get_by_name('sink')
            # pipewiresrc connects synchronously and can block for its whole
            # connect timeout if PipeWire misbehaves; keep the main loop free.
            _set_state_async(pipeline, Gst.State.PLAYING)
        self.streams = streams

    def _finish_start(self, state, detail):
        self.state = state
        self.detail = detail
        callbacks, self._pending_start = self._pending_start, []
        for callback in callbacks:
            callback(self._status())

    def _status(self):
        return {'state': self.state, 'detail': self.detail, 'restore_token': self.restore_token,
                'streams': [{'position': list(s['position']), 'size': list(s['size'])} for s in self.streams]}

    def _close_session(self):
        if self.session_handle and not self.test_source:
            try:
                self.bus.call_sync(PORTAL, self.session_handle, 'org.freedesktop.portal.Session', 'Close',
                                   None, None, Gio.DBusCallFlags.NONE, 2000, None)
            except GLib.Error:
                pass
        self.session_handle = None

    def stop(self):
        stopping = [_set_state_async(stream['pipeline'], Gst.State.NULL) for stream in self.streams]
        for worker in stopping:
            worker.join(3.0)
        self.streams = []
        self._close_session()
        if self.pw_fd >= 0:
            try:
                os.close(self.pw_fd)
            except OSError:
                pass
        self.pw_fd = -1
        if self.state in ('running', 'starting'):
            self.state = 'stopped'

    # --- frames ---------------------------------------------------------------

    def pick_stream(self, monitor_rect, monitor_count):
        if not self.streams:
            return None
        if monitor_rect:
            x, y, w, h = monitor_rect
            cx, cy = x + w / 2.0, y + h / 2.0
            for stream in self.streams:
                sx, sy = stream['position']
                sw, sh = stream['size']
                if sx <= cx < sx + sw and sy <= cy < sy + sh:
                    return stream
            return None
        # Focused monitor unknown: only safe when there is a single monitor.
        if len(self.streams) == 1 and monitor_count == 1:
            return self.streams[0]
        return None

    def frame(self, monitor_rect, monitor_count, wait_s):
        if self.state != 'running':
            return {'status': 'unavailable', 'detail': self.state + (': ' + self.detail if self.detail else '')}, b''
        stream = self.pick_stream(monitor_rect, monitor_count)
        if stream is None:
            return {'status': 'unknown_monitor'}, b''
        deadline = time.monotonic() + wait_s
        sample = None
        while sample is None:
            sample = stream['sink'].emit('try-pull-sample', 50 * Gst.MSECOND)
            if sample is None:
                if time.monotonic() >= deadline:
                    return {'status': 'no_frame'}, b''
                # Let pipeline bus/portal callbacks run while we wait.
                GLib.MainContext.default().iteration(False)
        stream['last_sample'] = sample
        caps = sample.get_caps().get_structure(0)
        width, height = caps.get_value('width'), caps.get_value('height')
        buffer = sample.get_buffer()
        ok, info = buffer.map(Gst.MapFlags.READ)
        if not ok:
            return {'status': 'error', 'detail': 'could not map frame'}, b''
        try:
            data = bytes(info.data)
        finally:
            buffer.unmap(info)
        return {'status': 'ok', 'width': width, 'height': height, 'format': 'BGRX',
                'position': list(stream['position']), 'size': list(stream['size'])}, data


def _set_state_async(pipeline, state):
    worker = threading.Thread(target=pipeline.set_state, args=(state,), daemon=True)
    worker.start()
    return worker


# ------------------------------------------------------------------ AT-SPI

def atspi_focused_window():
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    Atspi.set_timeout(ATSPI_TIMEOUT_MS, ATSPI_TIMEOUT_MS)
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is None:
            continue
        try:
            count = app.get_child_count()
        except GLib.Error:
            continue
        for j in range(count):
            try:
                window = app.get_child_at_index(j)
                if window is None or not window.get_state_set().contains(Atspi.StateType.ACTIVE):
                    continue
                return {'title': window.get_name() or '', 'app_name': app.get_name() or '',
                        'pid': app.get_process_id()}
            except GLib.Error:
                continue
    return None


# ------------------------------------------------------------------ server

class Helper:

    def __init__(self, sock, test_source=None):
        self.channel = Channel(sock)
        self.sock = sock
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.screencast = ScreenCast(self.bus, test_source)
        self.loop = GLib.MainLoop()
        GLib.io_add_watch(sock.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR,
                          self._on_readable)

    def run(self):
        self.loop.run()
        self.screencast.stop()

    def _on_readable(self, fd, condition):
        try:
            data = self.sock.recv(65536)
        except OSError:
            data = b''
        if not data:
            self.loop.quit()
            return False
        for header, payload in self.channel.feed(data):
            self._dispatch(header, payload)
        return True

    def _reply(self, request, header, payload=b''):
        header = dict(header, id=request.get('id'))
        try:
            self.channel.send(header, payload)
        except OSError:
            self.loop.quit()

    def _dispatch(self, request, payload):
        command = request.get('cmd')
        try:
            if command == 'ping':
                self._reply(request, {'ok': True, 'pid': os.getpid(), 'python': sys.version.split()[0]})
            elif command == 'probe':
                self._reply(request, {'ok': True, 'screencast_version': self.screencast.available(),
                                      'pipewiresrc': bool(Gst.ElementFactory.find('pipewiresrc')),
                                      'atspi': _has_atspi()})
            elif command == 'screencast.start':
                self.screencast.start(request.get('restore_token'), bool(request.get('interactive')),
                                      lambda status: self._reply(request, dict(status, ok=True)))
            elif command == 'screencast.stop':
                self.screencast.stop()
                self._reply(request, {'ok': True})
            elif command == 'screencast.frame':
                header, data = self.screencast.frame(request.get('monitor_rect'), request.get('monitor_count', 0),
                                                     float(request.get('wait_s', FIRST_FRAME_WAIT_S)))
                self._reply(request, dict(header, ok=True), data)
            elif command == 'atspi.focused':
                self._reply(request, {'ok': True, 'window': atspi_focused_window()})
            elif command == 'quit':
                self._reply(request, {'ok': True})
                self.loop.quit()
            else:
                self._reply(request, {'ok': False, 'error': 'unknown command {}'.format(command)})
        except Exception as e:  # never let one request kill the helper
            self._reply(request, {'ok': False, 'error': '{}: {}'.format(type(e).__name__, e)})


def _has_atspi():
    try:
        gi.require_version('Atspi', '2.0')
        return True
    except ValueError:
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fd', type=int, required=True, help='inherited socket file descriptor')
    parser.add_argument('--test-source', action='store_true', help='videotestsrc instead of the portal (tests)')
    args = parser.parse_args()
    Gst.init(None)
    sock = socket.socket(fileno=args.fd)
    Helper(sock, test_source=args.test_source).run()
    return 0


if __name__ == '__main__':
    sys.exit(main())

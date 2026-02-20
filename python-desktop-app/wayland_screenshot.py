#!/usr/bin/env python3
"""
Wayland Screenshot via XDG ScreenCast Portal + PipeWire

Uses persist_mode=2 + restore_token for permanent permission.
First time: Shows dialog - select screen and click "Share"
After that: No more prompts!

PERSISTENT SESSION: Keeps screen share open for fast subsequent captures.

Must be run with system Python (has PyGObject installed).
"""

import sys
import os
import json
import time
import threading

TOKEN_FILE = os.path.expanduser("~/.local/share/timetracker/.screencast_token")

# Global persistent session state
_session_state = {
    'session_handle': None,
    'node_id': None,
    'pw_fd': None,
    'bus': None,
    'initialized': False,
    'lock': threading.Lock(),
    'Gst': None,
    'GLib': None,
    'Gio': None,
}


def get_saved_token():
    try:
        if os.path.exists(TOKEN_FILE):
            with open(TOKEN_FILE, 'r') as f:
                return json.load(f).get('restore_token')
    except:
        pass
    return None


def save_token(token):
    try:
        os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
        with open(TOKEN_FILE, 'w') as f:
            json.dump({'restore_token': token, 'saved_at': time.time()}, f)
    except Exception as e:
        print(f"WARN: Could not save token: {e}", file=sys.stderr)


def _init_gstreamer():
    """Initialize GStreamer and PyGObject."""
    if _session_state['Gst'] is not None:
        return True
    
    try:
        import gi
        gi.require_version('Gst', '1.0')
        from gi.repository import GLib, Gio, Gst
        Gst.init(None)
        _session_state['Gst'] = Gst
        _session_state['GLib'] = GLib
        _session_state['Gio'] = Gio
        return True
    except ImportError as e:
        print(f"ERROR: Missing PyGObject/GStreamer: {e}", file=sys.stderr)
        return False


def _initialize_session():
    """Initialize the ScreenCast session (called once, kept open)."""
    if _session_state['initialized'] and _session_state['pw_fd'] is not None:
        return True
    
    if not _init_gstreamer():
        return False
    
    GLib = _session_state['GLib']
    Gio = _session_state['Gio']
    
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        _session_state['bus'] = bus
        loop = GLib.MainLoop()
        context = loop.get_context()
        
        responses = []
        def on_any_response(conn, sender, path, iface, signal, params):
            response, results = params.unpack()
            responses.append({'path': path, 'response': response, 'results': results})
        
        sub_id = bus.signal_subscribe(
            "org.freedesktop.portal.Desktop",
            "org.freedesktop.portal.Request",
            "Response",
            None, None, 0,
            on_any_response
        )
        
        def wait_for_path(expected_path, timeout_secs):
            deadline = time.time() + timeout_secs
            while time.time() < deadline:
                while context.pending():
                    context.iteration(False)
                for r in responses:
                    if r['path'] == expected_path:
                        return r
                time.sleep(0.05)
            return None
        
        restore_token = get_saved_token()
        has_token = restore_token is not None
        
        # Step 1: Create session
        token = f"tt{int(time.time())}"
        result = bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
            "CreateSession",
            GLib.Variant("(a{sv})", ({
                "handle_token": GLib.Variant("s", token),
                "session_handle_token": GLib.Variant("s", f"s{token}"),
            },)),
            GLib.VariantType("(o)"),
            0, 5000, None
        )
        request_path = result.unpack()[0]
        
        resp = wait_for_path(request_path, 10)
        if not resp or resp['response'] != 0:
            print("ERROR: CreateSession failed", file=sys.stderr)
            return False
        
        session_handle = resp['results'].get('session_handle')
        if not session_handle:
            print("ERROR: No session handle", file=sys.stderr)
            return False
        
        _session_state['session_handle'] = session_handle
        
        # Step 2: Select sources with persist_mode=2
        token = f"sel{int(time.time())}"
        options = {
            "handle_token": GLib.Variant("s", token),
            "types": GLib.Variant("u", 1),
            "multiple": GLib.Variant("b", False),
            "persist_mode": GLib.Variant("u", 2),
        }
        if restore_token:
            options["restore_token"] = GLib.Variant("s", restore_token)
        
        result = bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
            "SelectSources",
            GLib.Variant("(oa{sv})", (session_handle, options)),
            GLib.VariantType("(o)"),
            0, 5000, None
        )
        request_path = result.unpack()[0]
        
        timeout = 10 if has_token else 60
        resp = wait_for_path(request_path, timeout)
        if not resp or resp['response'] != 0:
            if has_token:
                print("INFO: Token expired, need new permission", file=sys.stderr)
                try:
                    os.unlink(TOKEN_FILE)
                except:
                    pass
            print("ERROR: SelectSources failed", file=sys.stderr)
            _session_state['session_handle'] = None
            return False
        
        # Step 3: Start stream
        token = f"st{int(time.time())}"
        result = bus.call_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
            "Start",
            GLib.Variant("(osa{sv})", (session_handle, "", {
                "handle_token": GLib.Variant("s", token),
            })),
            GLib.VariantType("(o)"),
            0, 30000, None
        )
        request_path = result.unpack()[0]
        
        resp = wait_for_path(request_path, 30)
        if not resp or resp['response'] != 0:
            print("ERROR: Start failed", file=sys.stderr)
            _session_state['session_handle'] = None
            return False
        
        new_token = resp['results'].get('restore_token')
        if new_token:
            save_token(new_token)
        
        streams = resp['results'].get('streams', [])
        if not streams:
            print("ERROR: No streams", file=sys.stderr)
            _session_state['session_handle'] = None
            return False
        
        _session_state['node_id'] = streams[0][0]
        
        # Step 4: Open PipeWire remote (keep fd open for reuse)
        result = bus.call_with_unix_fd_list_sync(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
            "OpenPipeWireRemote",
            GLib.Variant("(oa{sv})", (session_handle, {})),
            GLib.VariantType("(h)"),
            0, 5000, None, None
        )
        
        fd_list = result[1]
        fd_idx = result[0].unpack()[0]
        _session_state['pw_fd'] = fd_list.get(fd_idx)
        
        _session_state['initialized'] = True
        bus.signal_unsubscribe(sub_id)
        print("INFO: PipeWire session initialized (persistent)", file=sys.stderr)
        return True
        
    except Exception as e:
        print(f"ERROR: Session init failed: {e}", file=sys.stderr)
        _session_state['initialized'] = False
        return False


def capture_screenshot(output_path):
    """Capture screenshot using persistent PipeWire ScreenCast session."""
    with _session_state['lock']:
        # Initialize session if needed (only happens once)
        if not _session_state['initialized']:
            if not _initialize_session():
                return False
        
        Gst = _session_state['Gst']
        pw_fd = _session_state['pw_fd']
        node_id = _session_state['node_id']
        
        if pw_fd is None or node_id is None:
            print("ERROR: No active PipeWire connection", file=sys.stderr)
            _session_state['initialized'] = False
            return False
        
        # Duplicate the fd for GStreamer - it may close the fd after use
        dup_fd = None
        try:
            dup_fd = os.dup(pw_fd)
            
            # Capture frame using GStreamer (using duplicated fd)
            pipeline_str = (
                f"pipewiresrc fd={dup_fd} path={node_id} do-timestamp=true ! "
                f"videoconvert ! pngenc snapshot=true ! filesink location={output_path}"
            )
            
            pipeline = Gst.parse_launch(pipeline_str)
            gst_bus = pipeline.get_bus()
            pipeline.set_state(Gst.State.PLAYING)
            
            success = False
            deadline = time.time() + 5
            while time.time() < deadline:
                msg = gst_bus.pop()
                if msg:
                    if msg.type == Gst.MessageType.EOS:
                        success = True
                        break
                    elif msg.type == Gst.MessageType.ERROR:
                        err, _ = msg.parse_error()
                        print(f"ERROR: GStreamer: {err.message}", file=sys.stderr)
                        break
                time.sleep(0.02)
            
            pipeline.set_state(Gst.State.NULL)
            
            # Close the duplicated fd (original pw_fd stays open)
            try:
                os.close(dup_fd)
            except:
                pass
            dup_fd = None
            
            if success and os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                print("SUCCESS")
                return True
            else:
                # Session might be dead, reset for next attempt
                print("WARN: Capture failed, will reinitialize", file=sys.stderr)
                _session_state['initialized'] = False
                return False
                
        except Exception as e:
            print(f"ERROR: Frame capture failed: {e}", file=sys.stderr)
            # Close dup_fd if we failed before closing it
            if dup_fd is not None:
                try:
                    os.close(dup_fd)
                except:
                    pass
            _session_state['initialized'] = False
            return False


def close_session():
    """Close the persistent session (call on app exit)."""
    with _session_state['lock']:
        if _session_state['pw_fd'] is not None:
            try:
                os.close(_session_state['pw_fd'])
            except:
                pass
        _session_state['session_handle'] = None
        _session_state['node_id'] = None
        _session_state['pw_fd'] = None
        _session_state['initialized'] = False
        print("INFO: PipeWire session closed", file=sys.stderr)


# ============================================================================
# DAEMON MODE - Keeps screen share alive and accepts capture requests via socket
# ============================================================================

SOCKET_PATH = os.path.expanduser("~/.local/share/timetracker/.screenshot_socket")


def run_daemon():
    """Run as a daemon, listening for capture requests on a Unix socket.
    Auto-restarts screen share if user stops it.
    """
    import socket
    
    # Remove stale socket
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    
    # Initialize session FIRST (this may show permission dialog)
    print("DAEMON: Initializing screen share session...", file=sys.stderr)
    if not _initialize_session():
        print("DAEMON: Failed to initialize session", file=sys.stderr)
        print("DAEMON_FAILED")  # Signal to parent that daemon failed
        sys.stdout.flush()
        sys.exit(1)
    
    print("DAEMON: Session initialized", file=sys.stderr)
    
    # Now bind socket and start listening
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    server.listen(1)
    server.settimeout(None)  # No timeout - run forever
    
    print(f"DAEMON: Listening on {SOCKET_PATH}", file=sys.stderr)
    print("DAEMON_READY")  # Signal to parent AFTER session is ready
    sys.stdout.flush()
    
    print("DAEMON: Ready for captures", file=sys.stderr)
    
    try:
        while True:
            try:
                conn, _ = server.accept()
                data = conn.recv(4096).decode('utf-8').strip()
                
                if data.startswith("CAPTURE:"):
                    output_path = data[8:]
                    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
                    
                    # Try capture - if session died, reinitialize and retry
                    success = capture_screenshot(output_path)
                    
                    if not success and not _session_state['initialized']:
                        # Session died (user stopped sharing?), reinitialize
                        print("DAEMON: Session lost, reinitializing...", file=sys.stderr)
                        if _initialize_session():
                            print("DAEMON: Session reinitialized", file=sys.stderr)
                            # Retry capture
                            success = capture_screenshot(output_path)
                        else:
                            print("DAEMON: Failed to reinitialize session", file=sys.stderr)
                    
                    if success:
                        conn.send(b"SUCCESS\n")
                    else:
                        conn.send(b"FAILED\n")
                elif data == "PING":
                    conn.send(b"PONG\n")
                elif data == "STATUS":
                    status = "ACTIVE" if _session_state['initialized'] else "INACTIVE"
                    conn.send(f"{status}\n".encode())
                elif data == "RESTART":
                    # Force restart session
                    close_session()
                    if _initialize_session():
                        conn.send(b"RESTARTED\n")
                    else:
                        conn.send(b"FAILED\n")
                elif data == "QUIT":
                    conn.send(b"BYE\n")
                    conn.close()
                    break
                else:
                    conn.send(b"UNKNOWN\n")
                
                conn.close()
                
            except socket.timeout:
                print("DAEMON: Socket timeout", file=sys.stderr)
            except ConnectionResetError:
                print("DAEMON: Client disconnected", file=sys.stderr)
            except Exception as e:
                import traceback
                print(f"DAEMON: Error: {e}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                
    finally:
        close_session()
        server.close()
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
        print("DAEMON: Shutdown complete", file=sys.stderr)


def capture_via_daemon(output_path):
    """Send capture request to the daemon."""
    import socket
    
    if not os.path.exists(SOCKET_PATH):
        return False
    
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(10)
        client.connect(SOCKET_PATH)
        client.send(f"CAPTURE:{output_path}\n".encode('utf-8'))
        response = client.recv(1024).decode('utf-8').strip()
        client.close()
        return response == "SUCCESS"
    except Exception:
        return False


def is_daemon_running():
    """Check if daemon is running."""
    import socket
    
    if not os.path.exists(SOCKET_PATH):
        return False
    
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(2)
        client.connect(SOCKET_PATH)
        client.send(b"PING\n")
        response = client.recv(1024).decode('utf-8').strip()
        client.close()
        return response == "PONG"
    except Exception:
        return False


def stop_daemon():
    """Stop the daemon."""
    import socket
    
    if not os.path.exists(SOCKET_PATH):
        return
    
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(2)
        client.connect(SOCKET_PATH)
        client.send(b"QUIT\n")
        client.recv(1024)
        client.close()
    except Exception:
        pass


def main():
    if len(sys.argv) < 2:
        print("Usage:", file=sys.stderr)
        print("  python3 wayland_screenshot.py /path/to/output.png  # Single capture", file=sys.stderr)
        print("  python3 wayland_screenshot.py --daemon              # Run as daemon", file=sys.stderr)
        print("  python3 wayland_screenshot.py --stop-daemon         # Stop daemon", file=sys.stderr)
        sys.exit(1)
    
    if sys.argv[1] == "--daemon":
        run_daemon()
    elif sys.argv[1] == "--stop-daemon":
        stop_daemon()
        print("Daemon stopped")
    else:
        output_path = sys.argv[1]
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        
        success = capture_screenshot(output_path)
        sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()


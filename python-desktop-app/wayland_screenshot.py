#!/usr/bin/env python3
"""
Wayland Screenshot via XDG ScreenCast Portal + PipeWire

Uses persist_mode=2 + restore_token for permanent permission.
First time: Shows dialog - select screen and click "Share"
After that: No more prompts!

Must be run with system Python (has PyGObject installed).
"""

import sys
import os
import json
import time

TOKEN_FILE = os.path.expanduser("~/.local/share/timetracker/.screencast_token")


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


def capture_screenshot(output_path):
    """Capture screenshot using PipeWire ScreenCast portal."""
    try:
        import gi
        gi.require_version('Gst', '1.0')
        from gi.repository import GLib, Gio, Gst
        Gst.init(None)
    except ImportError as e:
        print(f"ERROR: Missing PyGObject/GStreamer: {e}", file=sys.stderr)
        return False
    
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    loop = GLib.MainLoop()
    context = loop.get_context()
    
    # Subscribe to ALL Response signals upfront to avoid race conditions
    responses = []
    def on_any_response(conn, sender, path, iface, signal, params):
        response, results = params.unpack()
        responses.append({'path': path, 'response': response, 'results': results})
    
    sub_id = bus.signal_subscribe(
        "org.freedesktop.portal.Desktop",
        "org.freedesktop.portal.Request",
        "Response",
        None,  # Any path
        None,
        0,  # Gio.DBusSignalFlags.NONE
        on_any_response
    )
    
    def wait_for_path(expected_path, timeout_secs):
        deadline = time.time() + timeout_secs
        while time.time() < deadline:
            # Process pending events
            while context.pending():
                context.iteration(False)
            # Check if we have the response
            for r in responses:
                if r['path'] == expected_path:
                    return r
            time.sleep(0.05)
        return None
    
    restore_token = get_saved_token()
    has_token = restore_token is not None
    
    try:
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
        
        # Step 2: Select sources with persist_mode=2
        token = f"sel{int(time.time())}"
        options = {
            "handle_token": GLib.Variant("s", token),
            "types": GLib.Variant("u", 1),  # Monitor
            "multiple": GLib.Variant("b", False),
            "persist_mode": GLib.Variant("u", 2),  # Permanent
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
        
        # Wait longer if no token (user needs to interact with dialog)
        timeout = 10 if has_token else 60
        resp = wait_for_path(request_path, timeout)
        if not resp or resp['response'] != 0:
            if has_token:
                # Token expired, clear it
                print("INFO: Token expired, need new permission", file=sys.stderr)
                try:
                    os.unlink(TOKEN_FILE)
                except:
                    pass
            print("ERROR: SelectSources failed", file=sys.stderr)
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
            return False
        
        # Save new token for next time
        new_token = resp['results'].get('restore_token')
        if new_token:
            save_token(new_token)
        
        streams = resp['results'].get('streams', [])
        if not streams:
            print("ERROR: No streams", file=sys.stderr)
            return False
        
        node_id = streams[0][0]
        
        # Step 4: Open PipeWire remote
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
        pw_fd = fd_list.get(fd_idx)
        
        # Step 5: Capture frame using GStreamer
        pipeline_str = (
            f"pipewiresrc fd={pw_fd} path={node_id} do-timestamp=true ! "
            f"videoconvert ! pngenc snapshot=true ! filesink location={output_path}"
        )
        
        pipeline = Gst.parse_launch(pipeline_str)
        gst_bus = pipeline.get_bus()
        pipeline.set_state(Gst.State.PLAYING)
        
        # Wait for EOS or error
        success = False
        deadline = time.time() + 10
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
            time.sleep(0.05)
        
        pipeline.set_state(Gst.State.NULL)
        
        if success and os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            print("SUCCESS")
            return True
        else:
            print("ERROR: Screenshot capture failed", file=sys.stderr)
            return False
        
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return False


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 wayland_screenshot.py /path/to/output.png", file=sys.stderr)
        sys.exit(1)
    
    output_path = sys.argv[1]
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    
    success = capture_screenshot(output_path)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()


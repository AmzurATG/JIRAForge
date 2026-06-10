#!/usr/bin/env python3
"""
Proof of Concept: PipeWire ScreenCast Portal Screenshot
NO FLASH - NO ADMIN ACCESS NEEDED

This uses ScreenCast portal instead of Screenshot portal.
ScreenCast doesn't trigger the flash because it's a video capture API, not screenshot.
"""

import gi
gi.require_version('Gio', '2.0')
gi.require_version('GLib', '2.0')
gi.require_version('Gst', '1.0')
from gi.repository import Gio, GLib, Gst
import sys
import os
import tempfile
import random
import string

class ScreenCastCapture:
    def __init__(self):
        self.session_handle = None
        self.request_token = None
        self.session_token = None
        self.pipewire_fd = None
        self.loop = None
        self.output_path = None
        self.error = None
        
        # Initialize GStreamer
        Gst.init(None)
        
    def generate_token(self):
        """Generate random token for D-Bus request"""
        chars = string.ascii_letters + string.digits
        return ''.join(random.choice(chars) for _ in range(10))
    
    def create_session(self):
        """Step 1: Create ScreenCast session"""
        print("[1/5] Creating ScreenCast session...")
        
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        
        # Generate tokens
        self.request_token = self.generate_token()
        self.session_token = self.generate_token()
        
        # Create request path
        sender = bus.get_unique_name()[1:].replace('.', '_')
        request_path = f'/org/freedesktop/portal/desktop/request/{sender}/{self.request_token}'
        
        # Subscribe to Response signal first
        bus.signal_subscribe(
            'org.freedesktop.portal.Desktop',
            'org.freedesktop.portal.Request',
            'Response',
            request_path,
            None,
            Gio.DBusSignalFlags.NONE,
            self.on_session_created,
            None
        )
        
        proxy = Gio.DBusProxy.new_sync(
            bus,
            Gio.DBusProxyFlags.NONE,
            None,
            'org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.ScreenCast',
            None
        )
        
        options = {
            'handle_token': GLib.Variant('s', self.request_token),
            'session_handle_token': GLib.Variant('s', self.session_token)
        }
        
        proxy.call(
            'CreateSession',
            GLib.Variant('(a{sv})', (options,)),
            Gio.DBusCallFlags.NONE,
            -1,
            None,
            None,
            None
        )
        
    def on_session_created(self, connection, sender, object_path, interface, signal, parameters, user_data):
        """Callback when session is created"""
        response, results = parameters.unpack()
        
        if response != 0:
            self.error = f"CreateSession failed with response {response}"
            self.loop.quit()
            return
            
        self.session_handle = results['session_handle']
        print(f"✓ Session created: {self.session_handle}")
        
        # Step 2: Select sources
        self.select_sources()
        
    def select_sources(self):
        """Step 2: Select monitor as source"""
        print("[2/5] Selecting monitor source...")
        
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        
        # Generate new request token
        self.request_token = self.generate_token()
        sender = bus.get_unique_name()[1:].replace('.', '_')
        request_path = f'/org/freedesktop/portal/desktop/request/{sender}/{self.request_token}'
        
        # Subscribe to Response signal
        bus.signal_subscribe(
            'org.freedesktop.portal.Desktop',
            'org.freedesktop.portal.Request',
            'Response',
            request_path,
            None,
            Gio.DBusSignalFlags.NONE,
            self.on_sources_selected,
            None
        )
        
        proxy = Gio.DBusProxy.new_sync(
            bus,
            Gio.DBusProxyFlags.NONE,
            None,
            'org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.ScreenCast',
            None
        )
        
        options = {
            'handle_token': GLib.Variant('s', self.request_token),
            'types': GLib.Variant('u', 1),        # 1 = Monitor
            'multiple': GLib.Variant('b', False),
            'cursor_mode': GLib.Variant('u', 1)   # 1 = Hidden
        }
        
        proxy.call(
            'SelectSources',
            GLib.Variant('(oa{sv})', (self.session_handle, options)),
            Gio.DBusCallFlags.NONE,
            -1,
            None,
            None,
            None
        )
        
    def on_sources_selected(self, connection, sender, object_path, interface, signal, parameters, user_data):
        """Callback when sources are selected"""
        response, results = parameters.unpack()
        
        if response != 0:
            self.error = f"SelectSources failed with response {response}"
            self.loop.quit()
            return
            
        print("✓ Monitor source selected")
        
        # Step 3: Start capture
        self.start_capture()
        
    def start_capture(self):
        """Step 3: Start the capture (shows consent dialog first time)"""
        print("[3/5] Starting capture (may show consent dialog)...")
        
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        
        # Generate new request token
        self.request_token = self.generate_token()
        sender = bus.get_unique_name()[1:].replace('.', '_')
        request_path = f'/org/freedesktop/portal/desktop/request/{sender}/{self.request_token}'
        
        # Subscribe to Response signal
        bus.signal_subscribe(
            'org.freedesktop.portal.Desktop',
            'org.freedesktop.portal.Request',
            'Response',
            request_path,
            None,
            Gio.DBusSignalFlags.NONE,
            self.on_capture_started,
            None
        )
        
        proxy = Gio.DBusProxy.new_sync(
            bus,
            Gio.DBusProxyFlags.NONE,
            None,
            'org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.ScreenCast',
            None
        )
        
        options = {
            'handle_token': GLib.Variant('s', self.request_token),
        }
        
        proxy.call(
            'Start',
            GLib.Variant('(osa{sv})', (self.session_handle, '', options)),
            Gio.DBusCallFlags.NONE,
            -1,
            None,
            None,
            None
        )
        
    def on_capture_started(self, connection, sender, object_path, interface, signal, parameters, user_data):
        """Callback when capture is started"""
        response, results = parameters.unpack()
        
        if response != 0:
            if response == 1:
                self.error = "User cancelled consent dialog"
            else:
                self.error = f"Start failed with response {response}"
            self.loop.quit()
            return
            
        print("✓ Capture started (consent granted)")
        
        # Step 4: Open PipeWire connection
        self.open_pipewire()
        
    def open_pipewire(self):
        """Step 4: Open PipeWire remote connection"""
        print("[4/5] Opening PipeWire connection...")
        
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        
        proxy = Gio.DBusProxy.new_sync(
            bus,
            Gio.DBusProxyFlags.NONE,
            None,
            'org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.ScreenCast',
            None
        )
        
        # Use UnixFDList to receive file descriptor
        fd_list = Gio.UnixFDList.new()
        
        result = proxy.call_with_unix_fd_list_sync(
            'OpenPipeWireRemote',
            GLib.Variant('(oa{sv})', (self.session_handle, {})),
            Gio.DBusCallFlags.NONE,
            -1,
            None,
            None
        )
        
        if result is None:
            self.error = "Failed to open PipeWire remote"
            self.loop.quit()
            return
        
        fd_list_out = result[1]
        fd_index = result[0].unpack()[0]
        self.pipewire_fd = fd_list_out.get(fd_index)
        
        print(f"✓ PipeWire connection opened (fd={self.pipewire_fd})")
        
        # Step 5: Capture frame with GStreamer
        self.capture_frame_gstreamer()
        
    def capture_frame_gstreamer(self):
        """Step 5: Use GStreamer to capture single frame from PipeWire"""
        print("[5/5] Capturing frame with GStreamer...")
        
        # Create temporary output file
        fd, self.output_path = tempfile.mkstemp(suffix='.png', prefix='screencast_')
        os.close(fd)
        
        # Build GStreamer pipeline
        pipeline_str = (
            f'pipewiresrc fd={self.pipewire_fd} do-timestamp=true ! '
            f'videoconvert ! '
            f'videoscale ! '
            f'pngenc ! '
            f'filesink location={self.output_path}'
        )
        
        try:
            pipeline = Gst.parse_launch(pipeline_str)
            
            # Set up message bus
            bus = pipeline.get_bus()
            bus.add_signal_watch()
            bus.connect('message::eos', self.on_gst_eos)
            bus.connect('message::error', self.on_gst_error)
            
            # Start pipeline
            pipeline.set_state(Gst.State.PLAYING)
            
            # Capture first frame then stop
            GLib.timeout_add(2000, self.stop_gst_pipeline, pipeline)
            
        except Exception as e:
            self.error = f"GStreamer error: {e}"
            self.loop.quit()
            
    def stop_gst_pipeline(self, pipeline):
        """Stop GStreamer pipeline after capturing frame"""
        pipeline.send_event(Gst.Event.new_eos())
        return False
        
    def on_gst_eos(self, bus, message):
        """GStreamer end-of-stream"""
        pipeline = message.src
        pipeline.set_state(Gst.State.NULL)
        
        # Verify output file
        if os.path.exists(self.output_path) and os.path.getsize(self.output_path) > 0:
            print(f"✓ Frame captured: {self.output_path}")
            print(f"  Size: {os.path.getsize(self.output_path)} bytes")
        else:
            self.error = "Output file is empty or missing"
            
        self.loop.quit()
        
    def on_gst_error(self, bus, message):
        """GStreamer error"""
        err, debug = message.parse_error()
        self.error = f"GStreamer error: {err.message}"
        pipeline = message.src
        pipeline.set_state(Gst.State.NULL)
        self.loop.quit()
        
    def capture(self, output_path=None):
        """Main entry point - capture screenshot via ScreenCast"""
        if output_path:
            self.output_path = output_path
            
        self.loop = GLib.MainLoop()
        
        # Start async process
        self.create_session()
        
        # Run event loop
        self.loop.run()
        
        if self.error:
            raise Exception(self.error)
            
        return self.output_path


def main():
    print("="*70)
    print("PipeWire ScreenCast Screenshot Test - NO FLASH!")
    print("="*70)
    print()
    print("This test uses ScreenCast portal instead of Screenshot portal.")
    print("ScreenCast does NOT trigger the flash animation.")
    print()
    print("IMPORTANT: You may see a consent dialog on first run.")
    print("Click 'Share' to grant permission (one-time only).")
    print()
    print("-"*70)
    print()
    
    try:
        capturer = ScreenCastCapture()
        output = capturer.capture()
        
        print()
        print("="*70)
        print("SUCCESS! Screenshot captured WITHOUT flash.")
        print(f"Output: {output}")
        print()
        print("❓ Did you see a flash? (y/n)")
        
        response = input("> ").strip().lower()
        if response == 'y':
            print("⚠️  UNEXPECTED: Flash was visible")
            print("   Please report this - ScreenCast should not flash")
            return 1
        else:
            print("✅ VERIFIED: No flash observed")
            print()
            print("This confirms ScreenCast is the correct solution:")
            print("  • No flash")
            print("  • No admin access needed")
            print("  • No GNOME Shell extensions needed")
            print("  • Works immediately (no restart)")
            return 0
            
    except Exception as e:
        print()
        print("="*70)
        print(f"❌ ERROR: {e}")
        print()
        
        if "User cancelled" in str(e):
            print("You cancelled the consent dialog.")
            print("Run again and click 'Share' to test.")
        else:
            print("Debug info:")
            print(f"  GStreamer available: {Gst.version()}")
            import traceback
            traceback.print_exc()
            
        return 1


if __name__ == '__main__':
    sys.exit(main())

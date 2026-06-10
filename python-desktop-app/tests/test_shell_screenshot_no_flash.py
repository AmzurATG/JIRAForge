#!/usr/bin/env python3
"""
Test calling org.gnome.Shell.Screenshot directly with flash=false
to see if we can bypass the Portal and disable the flash.
"""
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib
import tempfile
import os

def test_shell_screenshot_no_flash():
    """Try calling GNOME Shell Screenshot with flash=false"""
    print("Testing org.gnome.Shell.Screenshot with flash=false...")
    
    try:
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        print("✓ Connected to session bus")
        
        # Create temporary file for screenshot
        fd, temp_path = tempfile.mkstemp(suffix='.png')
        os.close(fd)
        print(f"✓ Temp file: {temp_path}")
        
        # Call Screenshot method with flash=false
        result = connection.call_sync(
            'org.gnome.Shell.Screenshot',
            '/org/gnome/Shell/Screenshot',
            'org.gnome.Shell.Screenshot',
            'Screenshot',
            GLib.Variant('(bbs)', (False, False, temp_path)),  # includeCursor, flash, filename
            GLib.VariantType('(bs)'),
            Gio.DBusCallFlags.NONE,
            5000,
            None
        )
        
        success, filename = result.unpack()
        print(f"✓ Screenshot result: success={success}, file={filename}")
        
        if success and os.path.exists(filename):
            size = os.path.getsize(filename)
            print(f"✓ Screenshot saved: {size} bytes")
            print(f"\n✓✓✓ SUCCESS: Screenshot without flash!")
            return True
        else:
            print(f"✗ Screenshot failed or file doesn't exist")
            return False
            
    except GLib.Error as e:
        print(f"✗ D-Bus Error: {e.message}")
        if "AccessDenied" in e.message:
            print("  → GNOME 46+ blocks this API (expected)")
        return False
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

if __name__ == '__main__':
    test_shell_screenshot_no_flash()

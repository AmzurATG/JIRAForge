#!/usr/bin/env python3
"""
Test using Shell.Screenshot directly via GObject introspection
instead of D-Bus. This might bypass the security restriction.
"""
import gi
import tempfile
import os

try:
    gi.require_version('Shell', '14')
    from gi.repository import Shell
    print("✓ Shell module loaded")
except Exception as e:
    print(f"✗ Cannot load Shell module: {e}")
    print("  This is expected - Shell is only available inside GNOME Shell process")
    exit(1)

def test_shell_screenshot():
    """Try using Shell.Screenshot object directly"""
    try:
        screenshot = Shell.Screenshot.new()
        print("✓ Created Shell.Screenshot object")
        
        fd, temp_path = tempfile.mkstemp(suffix='.png')
        os.close(fd)
        print(f"✓ Temp file: {temp_path}")
        
        # Try to take screenshot
        stream = Gio.UnixOutputStream.new(os.open(temp_path, os.O_WRONLY), True)
        screenshot.screenshot(False, stream)  # includeCursor=False
        print(f"✓ Screenshot taken without flash!")
        
        if os.path.exists(temp_path):
            size = os.path.getsize(temp_path)
            print(f"✓ Screenshot saved: {size} bytes")
            return True
            
    except Exception as e:
        print(f"✗ Error: {e}")
        return False

if __name__ == '__main__':
    test_shell_screenshot()

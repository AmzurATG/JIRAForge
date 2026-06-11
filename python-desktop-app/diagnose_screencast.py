#!/usr/bin/env python3
"""
Diagnostic script to check ScreenCast prerequisites and identify which capture method is being used
"""

import os
import sys
import subprocess
import shutil

print("=" * 70)
print("ScreenCast Diagnostic Tool")
print("=" * 70)
print()

# 1. Check if running on Wayland
print("[1] Display Server Check")
print("-" * 70)
wayland_display = os.environ.get('WAYLAND_DISPLAY', '')
xdg_session_type = os.environ.get('XDG_SESSION_TYPE', '').lower()
display = os.environ.get('DISPLAY', '')

print(f"WAYLAND_DISPLAY: {wayland_display!r}")
print(f"XDG_SESSION_TYPE: {xdg_session_type!r}")
print(f"DISPLAY: {display!r}")

is_wayland = bool(wayland_display or xdg_session_type == 'wayland')
print(f"\n✓ Running on: {'Wayland' if is_wayland else 'X11'}")
print()

# 2. Check GStreamer
print("[2] GStreamer Check")
print("-" * 70)
gstreamer_available = False
try:
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import Gst
    Gst.init(None)
    gstreamer_available = True
    print("✓ GStreamer is AVAILABLE")
    print(f"  Version: {Gst.version_string()}")
except (ImportError, ValueError) as e:
    print(f"✗ GStreamer is NOT AVAILABLE: {e}")
    print("  Install with: sudo apt install python3-gst-1.0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good")
print()

# 3. Check XDG Desktop Portal
print("[3] XDG Desktop Portal Check")
print("-" * 70)
portal_available = False
try:
    result = subprocess.run(
        ['gdbus', 'introspect', '--session',
         '--dest', 'org.freedesktop.portal.Desktop',
         '--object-path', '/org/freedesktop/portal/desktop'],
        capture_output=True,
        text=True,
        timeout=3
    )
    if result.returncode == 0:
        print("✓ XDG Desktop Portal is AVAILABLE")
        if 'org.freedesktop.portal.ScreenCast' in result.stdout:
            print("✓ ScreenCast interface is AVAILABLE")
            portal_available = True
        else:
            print("✗ ScreenCast interface is NOT AVAILABLE")
        
        if 'org.freedesktop.portal.Screenshot' in result.stdout:
            print("✓ Screenshot interface is available (fallback, has flash)")
    else:
        print(f"✗ XDG Desktop Portal is NOT AVAILABLE (rc={result.returncode})")
except Exception as e:
    print(f"✗ Failed to check Portal: {e}")
print()

# 4. Check PipeWire
print("[4] PipeWire Check")
print("-" * 70)
try:
    result = subprocess.run(['pipewire', '--version'], capture_output=True, text=True, timeout=2)
    if result.returncode == 0:
        print(f"✓ PipeWire is installed: {result.stdout.strip()}")
    else:
        print("✗ PipeWire not found")
except:
    print("✗ PipeWire not found")
print()

# 5. Check gnome-screenshot
print("[5] Fallback Screenshot Tools")
print("-" * 70)
if shutil.which('gnome-screenshot'):
    print("✓ gnome-screenshot is available (fallback, may have flash)")
else:
    print("✗ gnome-screenshot not found")

if shutil.which('scrot'):
    print("✓ scrot is available (fallback)")
else:
    print("✗ scrot not found")
print()

# 6. Check restore token
print("[6] Restore Token Check")
print("-" * 70)
token_file = os.path.expanduser('~/.config/timetracker/screencast_restore_token.json')
if os.path.exists(token_file):
    print(f"✓ Restore token file exists: {token_file}")
    try:
        import json
        with open(token_file, 'r') as f:
            data = json.load(f)
        print(f"  Session handle: {data.get('session_handle', 'N/A')[:50]}...")
        print(f"  Node ID: {data.get('node_id', 'N/A')}")
        print(f"  Restore token: {data.get('restore_token', 'N/A')[:30]}...")
        if 'saved_at' in data:
            import time
            age_hours = (time.time() - data['saved_at']) / 3600
            print(f"  Age: {age_hours:.1f} hours old")
    except Exception as e:
        print(f"  Warning: Could not read token file: {e}")
else:
    print(f"✗ No restore token file found at: {token_file}")
print()

# 7. Summary and recommendation
print("=" * 70)
print("SUMMARY & RECOMMENDATION")
print("=" * 70)

if gstreamer_available and portal_available and is_wayland:
    print("✓ All prerequisites met for FLASH-FREE ScreenCast capture!")
    print("  ScreenCast should work without permission dialogs or flash.")
    print()
    print("If you're still seeing flash or dialogs:")
    print("  1. Check app logs for 'ScreenCast' messages")
    print("  2. Run: journalctl -f | grep -i 'screencast|portal'")
    print("  3. Look for GStreamer errors in logs")
elif not is_wayland:
    print("⚠ Running on X11, not Wayland")
    print("  ScreenCast portal only works on Wayland sessions.")
    print("  App will use X11 capture methods (scrot, Pillow XCB)")
elif not gstreamer_available:
    print("✗ GStreamer is NOT available - ScreenCast WILL NOT work")
    print("  App will fall back to methods that may have flash.")
    print()
    print("FIX: Install GStreamer:")
    print("  sudo apt install python3-gst-1.0 gstreamer1.0-plugins-base \\")
    print("                   gstreamer1.0-plugins-good gstreamer1.0-pipewire")
elif not portal_available:
    print("✗ ScreenCast Portal is NOT available")
    print("  App will fall back to GNOME Screenshot (may have flash).")
    print()
    print("FIX: Ensure xdg-desktop-portal-gnome is installed:")
    print("  sudo apt install xdg-desktop-portal-gnome")
else:
    print("⚠ Some prerequisites are missing")

print()
print("=" * 70)

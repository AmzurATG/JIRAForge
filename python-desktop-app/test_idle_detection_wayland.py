#!/usr/bin/env python3
"""
Smoke-test: idle detection backend probe and live idle-time reading.

Run this script directly on the target machine (inside an active desktop session)
to verify which idle-detection backends are available before / after the fix:

    python3 test_idle_detection_wayland.py

No pytest required.  Exit code 0 = at least one backend working.
"""
import os
import sys
import time
import glob
import struct
import subprocess

PASS = "\033[32m[PASS]\033[0m"
FAIL = "\033[31m[FAIL]\033[0m"
WARN = "\033[33m[WARN]\033[0m"
INFO = "\033[36m[INFO]\033[0m"

results = {}   # backend → True/False


# ---------------------------------------------------------------------------
# Environment info
# ---------------------------------------------------------------------------
print("=" * 60)
print("  Idle Detection Backend Smoke-Test")
print("=" * 60)
print(f"\n{INFO} Environment")
print(f"  XDG_SESSION_TYPE : {os.environ.get('XDG_SESSION_TYPE', 'not set')}")
print(f"  WAYLAND_DISPLAY  : {os.environ.get('WAYLAND_DISPLAY', 'not set')}")
print(f"  DISPLAY          : {os.environ.get('DISPLAY', 'not set')}")
print(f"  USER             : {os.environ.get('USER', 'not set')}")
try:
    groups = subprocess.check_output(['groups'], text=True).strip()
    in_input = 'input' in groups.split()
    print(f"  Groups           : {groups}")
    print(f"  In 'input' group : {in_input}")
except Exception:
    pass

# ---------------------------------------------------------------------------
# Tier 1 — D-Bus ScreenSaver
# ---------------------------------------------------------------------------
print(f"\n{INFO} Tier 1: D-Bus ScreenSaver (org.freedesktop.ScreenSaver)")
try:
    import dbus
    bus = dbus.SessionBus()
    ss = bus.get_object('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver')
    iface = dbus.Interface(ss, 'org.freedesktop.ScreenSaver')
    idle_ms = int(iface.GetSessionIdleTime())
    print(f"{PASS} GetSessionIdleTime() = {idle_ms} ms  ({idle_ms / 1000:.1f}s)")
    results['dbus_screensaver'] = True
except ImportError:
    print(f"{FAIL} python-dbus not installed")
    print(f"       Install: sudo apt install python3-dbus  # or pip install dbus-python")
    results['dbus_screensaver'] = False
except Exception as e:
    print(f"{FAIL} {e}")
    results['dbus_screensaver'] = False

# ---------------------------------------------------------------------------
# Tier 2 — GNOME Mutter IdleMonitor
# ---------------------------------------------------------------------------
print(f"\n{INFO} Tier 2: GNOME Mutter (org.gnome.Mutter.IdleMonitor)")
try:
    import dbus
    bus = dbus.SessionBus()
    obj = bus.get_object('org.gnome.Mutter.IdleMonitor',
                         '/org/gnome/Mutter/IdleMonitor/Core')
    iface = dbus.Interface(obj, 'org.gnome.Mutter.IdleMonitor')
    idle_ms = int(iface.GetIdletime())
    print(f"{PASS} GetIdletime() = {idle_ms} ms  ({idle_ms / 1000:.1f}s)")
    results['gnome_mutter'] = True
except ImportError:
    print(f"{FAIL} python-dbus not installed (shared with Tier 1)")
    results['gnome_mutter'] = False
except Exception as e:
    print(f"{FAIL} {e}")
    results['gnome_mutter'] = False

# ---------------------------------------------------------------------------
# Tier 3 — evdev raw input
# ---------------------------------------------------------------------------
print(f"\n{INFO} Tier 3: evdev /dev/input/event*")
devices = glob.glob('/dev/input/event*')
readable = [d for d in devices if os.access(d, os.R_OK)]
print(f"  Total devices found : {len(devices)}")
print(f"  Readable by user    : {len(readable)}")
if readable:
    print(f"{PASS} evdev backend usable — e.g. {readable[:2]}")
    results['evdev'] = True
else:
    print(f"{FAIL} No readable /dev/input/event* devices.")
    print(f"       Fix: sudo usermod -aG input $USER && newgrp input")
    print(f"       Or install udev rule: KERNEL==\"event*\", SUBSYSTEM==\"input\", TAG+=\"uaccess\"")
    results['evdev'] = False

# ---------------------------------------------------------------------------
# Tier 4 — pynput
# ---------------------------------------------------------------------------
print(f"\n{INFO} Tier 4: pynput (X11 / XWayland)")
try:
    from pynput import mouse
    received = []

    def _on_move(x, y):
        received.append(True)

    listener = mouse.Listener(on_move=_on_move)
    listener.start()
    print(f"  Waiting 3 seconds for mouse events (move your mouse) ...")
    time.sleep(3)
    listener.stop()

    if received:
        print(f"{PASS} pynput received {len(received)} mouse event(s)")
        results['pynput'] = True
    else:
        session = os.environ.get('XDG_SESSION_TYPE', 'unknown')
        if session == 'wayland':
            print(f"{WARN} pynput started but received NO events in 3s")
            print(f"       Running on Wayland — pynput requires XWayland or a higher-priority backend.")
        else:
            print(f"{WARN} pynput started but received NO events in 3s (did you move the mouse?)")
        results['pynput'] = False
except ImportError:
    print(f"{FAIL} pynput not installed.  Install: pip install pynput")
    results['pynput'] = False
except Exception as e:
    print(f"{FAIL} {e}")
    results['pynput'] = False

# ---------------------------------------------------------------------------
# XWayland check
# ---------------------------------------------------------------------------
print(f"\n{INFO} XWayland status")
try:
    result = subprocess.run(['pgrep', '-x', 'Xwayland'], capture_output=True, timeout=2)
    if result.returncode == 0:
        print(f"{PASS} XWayland is running (supports pynput on Wayland)")
    else:
        print(f"{WARN} XWayland is NOT running")
        session = os.environ.get('XDG_SESSION_TYPE', 'unknown')
        if session == 'wayland':
            print(f"       pynput will not work without XWayland on this Wayland session")
except Exception:
    print(f"{WARN} Could not determine XWayland status")

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print("\n" + "=" * 60)
print("  SUMMARY")
print("=" * 60)

working = [b for b, ok in results.items() if ok]
if working:
    best = working[0]
    print(f"{PASS} Idle detection AVAILABLE — best backend: {best}")
    print(f"  All working backends: {', '.join(working)}")
    exit_code = 0
else:
    print(f"{FAIL} No idle detection backend available on this machine!")
    print(f"  Recommendations:")
    print(f"    1. Install python-dbus:  sudo apt install python3-dbus")
    print(f"    2. Add to input group:   sudo usermod -aG input $USER && newgrp input")
    print(f"    3. Enable XWayland and install pynput: pip install pynput")
    exit_code = 1

print("=" * 60)
sys.exit(exit_code)

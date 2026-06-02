# PyInstaller runtime hook: pyi_rth_pystray_wayland.py
#
# Runs BEFORE desktop_app.py so that when `import pystray` executes,
# the environment is already correct for the active display server.
#
# Problem:
#   pystray reads PYSTRAY_BACKEND from the environment at import time.
#   On Wayland + GNOME, the tray icon is only visible when pystray uses
#   AyatanaAppIndicator3 (D-Bus SNI).  AppIndicator3 (XEmbed) is silently
#   invisible even with the ubuntu-appindicators extension enabled.
#
# Fix:
#   1. Add the system gi dist-packages path to sys.path so that
#      pystray._appindicator can `import gi` inside the frozen bundle.
#   2. On Wayland, set PYSTRAY_BACKEND=appindicator so pystray skips the
#      X11-only backends (_xorg, _gtk) and goes straight to _appindicator.
#      The patched _appindicator.py in the venv then picks AyatanaAppIndicator3
#      automatically on Wayland.
#
# This hook complements (not replaces) the bootstrap in desktop_app.py;
# belt-and-suspenders: if the bootstrap's timing is ever affected by import
# ordering changes, this hook ensures the env is already set up.

import os
import sys

if not sys.platform.startswith('linux'):
    raise SystemExit(0)

# --- 1. Add system gi to sys.path (gi is not bundled — it's system-only) -----
_candidate_gi_paths = [
    '/usr/lib/python3/dist-packages',
    f'/usr/lib/python{sys.version_info.major}/dist-packages',
    f'/usr/lib/python{sys.version_info.major}.{sys.version_info.minor}/dist-packages',
    '/usr/local/lib/python3/dist-packages',
]

for _gi_path in _candidate_gi_paths:
    if not os.path.isdir(_gi_path):
        continue
    if _gi_path in sys.path:
        break  # Already present
    # Safety: skip paths that contain cv2 (would break the bundled cv2 pre-load)
    try:
        _entries = os.listdir(_gi_path)
    except OSError:
        continue
    if any(e.startswith('cv2') for e in _entries):
        continue
    # Verify gi is actually here before adding the path
    _gi_pkg = os.path.join(_gi_path, 'gi')
    if os.path.isdir(_gi_pkg) or os.path.isfile(_gi_pkg + '.py'):
        sys.path.append(_gi_path)
        break

# --- 2. On Wayland, force appindicator backend so AyatanaAppIndicator3 is used
_is_wayland = bool(
    os.environ.get('WAYLAND_DISPLAY') or
    os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
)

if _is_wayland:
    # Force appindicator — do NOT use setdefault; AppRun might have set a
    # different value which we must override to get the correct backend.
    os.environ['PYSTRAY_BACKEND'] = 'appindicator'

# PyInstaller runtime hook: pyi_rth_cv2.py
#
# Pre-loads stdlib modules and cv2 before application code runs.
#
# 1. optparse: gi's GTK loader imports optparse internally. If it's not already
#    in sys.modules when gi.repository.Gtk is imported, the import fails with
#    "gtk-unavailable: No module named 'optparse'" even though optparse is in
#    base_library.zip.  Pre-importing it here ensures sys.modules is warm.
#
# 2. cv2: On Linux, the opencv namespace-package bootstrap conflicts with the
#    PyInstaller import machinery when system dist-packages are added to sys.path
#    by the tray backend detection code. Pre-loading cv2 from _MEIPASS before
#    any sys.path mutation prevents the recursion guard from firing.

import sys

# Pre-import optparse so gi/GTK can find it
try:
    import optparse  # noqa: F401
except Exception:
    pass

# cv2 pre-load only needed on Linux
if not sys.platform.startswith('linux'):
    raise SystemExit(0)

_MEIPASS = getattr(sys, '_MEIPASS', None)
if _MEIPASS:
    _original_path = sys.path[:]
    sys.path = [p for p in sys.path if p == _MEIPASS or p.startswith(_MEIPASS)]
    try:
        import cv2  # noqa: F401
    except Exception:
        pass
    finally:
        sys.path = _original_path

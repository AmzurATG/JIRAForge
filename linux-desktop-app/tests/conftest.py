"""Put the Linux package and the shared core on sys.path for tests."""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_LINUX_ROOT = os.path.dirname(_HERE)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
_CORE_ROOT = os.path.join(os.path.dirname(_LINUX_ROOT), 'python-desktop-app')

for path in (_LINUX_ROOT, _CORE_ROOT):
    if path not in sys.path:
        sys.path.insert(0, path)

# pystray picks a GUI backend at import; tests use the SNI class or none.
os.environ.setdefault('PYSTRAY_BACKEND', 'dummy')

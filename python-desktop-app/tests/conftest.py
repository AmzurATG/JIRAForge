"""
conftest.py — pre-mock all heavy/GUI modules before any test imports desktop_app.

This file runs automatically when pytest collects the tests/ directory.
It stubs out every module that desktop_app.py imports at module level so that
the large application file can be imported in a test environment without needing
a real display, GPU, database, or system libraries installed.
"""
import sys
import os
import types
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Modules to stub out BEFORE desktop_app.py is imported
# ---------------------------------------------------------------------------
_STUBS = [
    # GUI / tray
    'tkinter', 'tkinter.ttk', 'tkinter.messagebox', 'tkinter.filedialog',
    'pystray', 'pystray._base',
    # Image / OCR
    'PIL', 'PIL.Image', 'PIL.ImageGrab', 'PIL.ImageDraw', 'PIL.ImageFont',
    'PIL.ImageFilter', 'PIL.ImageEnhance', 'PIL.ImageChops',
    'cv2', 'numpy', 'pytesseract', 'easyocr', 'rapidocr_onnxruntime',
    # Input listeners
    'pynput', 'pynput.mouse', 'pynput.keyboard',
    # Database / network
    'supabase', 'supabase.lib', 'supabase.lib.client_options',
    'postgrest', 'postgrest._sync', 'postgrest._async',
    'requests', 'requests.adapters', 'requests.exceptions',
    'flask', 'flask_cors',
    # Crypto
    'cryptography', 'cryptography.fernet', 'cryptography.hazmat',
    'cryptography.hazmat.primitives', 'cryptography.hazmat.primitives.kdf',
    'cryptography.hazmat.primitives.kdf.pbkdf2',
    'cryptography.hazmat.backends',
    # System utilities
    'psutil',
    'dotenv',
    # GI / GTK (Linux tray)
    'gi', 'gi.repository', 'gi.repository.Gtk', 'gi.repository.GLib',
    'gi.repository.AppIndicator3', 'gi.repository.AyatanaAppIndicator3',
    # certifi — mock where() so the CA-fix block doesn't crash
    'certifi',
    # Internal OCR / monitor submodules
    'ocr', 'monitor_capture',
    # Misc
    'dbus',
]

for _mod in _STUBS:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

# certifi.where() must return a real-looking path (doesn't have to exist in tests)
sys.modules['certifi'].where = lambda: '/dev/null'

# PIL.Image.open must return something iterable for code that inspects images
sys.modules['PIL'].Image = MagicMock()
sys.modules['PIL.Image'].open = MagicMock(return_value=MagicMock())

# pystray.MenuItem alias
import pystray as _pystray
_pystray.MenuItem = MagicMock()

# flask.Flask() constructor is called at module level — make it return a mock app
import flask as _flask
_flask.Flask = MagicMock(return_value=MagicMock())
_flask.render_template_string = MagicMock()
_flask.jsonify = MagicMock()
_flask.request = MagicMock()
_flask.session = MagicMock()
_flask.redirect = MagicMock()
_flask.url_for = MagicMock()

# supabase.create_client is called at module-level in some helpers
import supabase as _supabase
_supabase.create_client = MagicMock(return_value=MagicMock())
_supabase.lib = MagicMock()
_supabase.lib.client_options = MagicMock()
_supabase.lib.client_options.ClientOptions = MagicMock()

# dotenv.load_dotenv is a no-op in tests
import dotenv as _dotenv
_dotenv.load_dotenv = lambda *a, **kw: None

# psutil — process/system queries used in get_active_window etc.
import psutil as _psutil
_psutil.Process = MagicMock()
_psutil.pid_exists = MagicMock(return_value=False)
_psutil.NoSuchProcess = Exception
_psutil.AccessDenied = Exception

# Make ocr and monitor_capture importable as modules
import ocr as _ocr
_ocr.extract_text_from_image = MagicMock(return_value=('', None, None, None))

import monitor_capture as _mc
_mc.capture_screen = MagicMock(return_value=None)

# ---------------------------------------------------------------------------
# Suppress the _bootstrap_linux_tray_backend() side effects at import time
# by pre-setting the env var it would set.
# ---------------------------------------------------------------------------
os.environ.setdefault('PYSTRAY_BACKEND', 'xorg')

print("[conftest] Heavy modules stubbed — desktop_app can now be imported safely in tests.")

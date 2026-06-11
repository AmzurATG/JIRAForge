"""
Time Tracker - Python Desktop Application
Desktop app for automatic time tracking via screenshot capture with Atlassian OAuth
"""

import os
import re
import sys
import time
import logging
import json
import queue
import atexit
import threading
import subprocess
import webbrowser
import tempfile
import traceback
import urllib.parse
import secrets
import hashlib
import base64
import uuid
import platform
from datetime import datetime, timezone, timedelta
from io import BytesIO
from enum import Enum

_LINUX_TRAY_BOOTSTRAP_STATUS = 'not-linux'


def _bootstrap_linux_tray_backend():
    """Expose distro GI bindings to the app before pystray selects a backend."""
    global _LINUX_TRAY_BOOTSTRAP_STATUS

    if not sys.platform.startswith('linux'):
        return

    candidate_paths = [
        '/usr/lib/python3/dist-packages',
        f'/usr/lib/python{sys.version_info.major}/dist-packages',
        f'/usr/lib/python{sys.version_info.major}.{sys.version_info.minor}/dist-packages',
        '/usr/local/lib/python3/dist-packages',
        f'/usr/local/lib/python{sys.version_info.major}/dist-packages',
        f'/usr/local/lib/python{sys.version_info.major}.{sys.version_info.minor}/dist-packages',
    ]

    # In frozen / AppImage mode (PyInstaller), adding system dist-package paths
    # can shadow bundled extensions (especially cv2) and cause recursion errors.
    is_frozen = getattr(sys, 'frozen', False)

    added_paths = []
    if not is_frozen:
        for path in candidate_paths:
            if not os.path.isdir(path) or path in sys.path:
                continue
            # Skip paths that would shadow bundled cv2 (directory OR .so file).
            has_cv2 = (
                os.path.exists(os.path.join(path, 'cv2')) or
                os.path.exists(os.path.join(path, 'cv2.py')) or
                any(f.startswith('cv2') for f in os.listdir(path))
            )
            if has_cv2:
                continue
            sys.path.append(path)
            added_paths.append(path)
    else:
        # Frozen / AppImage mode: cv2 IS bundled inside the PyInstaller onefile
        # binary (cv2.abi3.so is extracted to _MEIPASS/cv2/ at runtime).
        # Add system gi paths so pystray's _appindicator backend can `import gi`,
        # but SKIP any system path that contains cv2 to prevent a namespace-package
        # stub from shadowing the bundled cv2 before cv2's own bootstrap runs.
        for path in candidate_paths:
            if not os.path.isdir(path) or path in sys.path:
                continue
            try:
                entries = os.listdir(path)
            except OSError:
                continue
            # Skip system paths with cv2 — system cv2 may be a namespace package
            # (no .so) that would cause `No module named 'cv2'` inside rapidocr.
            if any(e.startswith('cv2') for e in entries):
                continue
            sys.path.append(path)
            added_paths.append(path)

    # Before importing gi, verify that the system's _gi C-extension matches
    # the ABI of the bundled Python.  In frozen builds (PyInstaller + AppImage)
    # the bundled interpreter is Python {major}.{minor} from the BUILD machine.
    # If the TARGET machine has a different system Python (e.g. 3.10 vs 3.12),
    # the _gi.cpython-3XX-*.so on disk won't load → "partially initialized
    # module" ImportError.  Additionally, PyInstaller sets _MEIPASS first in
    # LD_LIBRARY_PATH, which causes the bundled libffi.so.8 to shadow the
    # system copy — this can also make _gi.so fail to load.
    # When gi is unavailable, we fall back to the xorg backend (pure X11 via
    # python-xlib, which IS bundled) so the app starts even without a visible
    # Wayland/GNOME tray icon.
    if is_frozen:
        # Quick compatibility check: see if a matching _gi C-extension exists.
        abi_tag = f'cpython-{sys.version_info.major}{sys.version_info.minor}'
        gi_so_found = False
        for p in added_paths:
            gi_dir = os.path.join(p, 'gi')
            if os.path.isdir(gi_dir):
                try:
                    for f in os.listdir(gi_dir):
                        if f.startswith('_gi.') and abi_tag in f:
                            gi_so_found = True
                            break
                except OSError:
                    pass
            if gi_so_found:
                break
        if not gi_so_found:
            _LINUX_TRAY_BOOTSTRAP_STATUS = (
                f'gi-abi-mismatch:no _gi.{abi_tag}-*.so found on system '
                f'(paths searched: {", ".join(added_paths)})'
            )
            os.environ.setdefault('PYSTRAY_BACKEND', 'xorg')
            return

    try:
        import gi
    except Exception as exc:
        _LINUX_TRAY_BOOTSTRAP_STATUS = f'gi-unavailable:{exc}'
        # Critical: set a backend that does NOT need gi so pystray can fall
        # back to xorg (python-xlib, bundled) instead of trying appindicator
        # → gtk → xorg with a poisoned gi in sys.modules.
        os.environ.setdefault('PYSTRAY_BACKEND', 'xorg')
        # Remove the broken partial gi module from sys.modules so that
        # pystray's fallback backends don't hit "partially initialized" errors.
        for _mod_name in list(sys.modules):
            if _mod_name == 'gi' or _mod_name.startswith('gi.'):
                del sys.modules[_mod_name]
        return

    try:
        gi.require_version('Gtk', '3.0')
        from gi.repository import Gtk  # noqa: F401
    except Exception as exc:
        _LINUX_TRAY_BOOTSTRAP_STATUS = f'gtk-unavailable:{exc}'
        os.environ.setdefault('PYSTRAY_BACKEND', 'xorg')
        return

    indicator_name = None
    indicator_error = None

    # On Wayland, AppIndicator3 uses X11 XEmbed which is invisible.
    # AyatanaAppIndicator3 uses the D-Bus SNI protocol which works on Wayland.
    # Prefer Ayatana on Wayland sessions; keep AppIndicator3 first on X11.
    is_wayland = bool(os.environ.get('WAYLAND_DISPLAY') or
                      os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland')
    if is_wayland:
        indicator_candidates = ('AyatanaAppIndicator3', 'AppIndicator3')
    else:
        indicator_candidates = ('AppIndicator3', 'AyatanaAppIndicator3')

    for module_name in indicator_candidates:
        try:
            gi.require_version(module_name, '0.1')
            __import__('gi.repository', fromlist=[module_name])
            indicator_name = module_name
            break
        except Exception as exc:
            indicator_error = exc

    if indicator_name:
        # On Wayland, pystray._appindicator always tries AppIndicator3 (XEmbed)
        # first, regardless of which indicator was detected here.  AppIndicator3
        # uses X11 XEmbed which is invisible on GNOME/Wayland even when
        # XWayland is running.  AyatanaAppIndicator3 uses the D-Bus SNI
        # StatusNotifierItem protocol which IS visible via the
        # ubuntu-appindicators GNOME Shell extension.
        #
        # Fix: when AyatanaAppIndicator3 is selected on Wayland, pre-register
        # AppIndicator3 in gi with a deliberately wrong version ('99.0').
        # pystray._appindicator then calls gi.require_version('AppIndicator3',
        # '0.1') which raises ValueError (99.0 ≠ 0.1), and pystray falls back
        # to gi.require_version('AyatanaAppIndicator3', '0.1') — exactly what
        # we want.  This avoids the need for a fragile post-import monkey-patch.
        if is_wayland and indicator_name == 'AyatanaAppIndicator3':
            try:
                gi.require_version('AppIndicator3', '99.0')
            except Exception:
                # If AppIndicator3 was already required with a different version
                # (shouldn't happen here), ignore — the Wayland patch below acts
                # as a safety net.
                pass

        # Force-set the backend — do NOT use setdefault, because AppRun or the
        # user's environment may have pre-set PYSTRAY_BACKEND to something else
        # (e.g. 'xorg') which setdefault would silently leave in place.
        os.environ['PYSTRAY_BACKEND'] = 'appindicator'
        added_suffix = f" via {', '.join(added_paths)}" if added_paths else ''
        _LINUX_TRAY_BOOTSTRAP_STATUS = f'appindicator-ready:{indicator_name}{added_suffix}'
    else:
        # AppIndicator not available — fall back to xorg (requires a system tray
        # like trayer/stalonetray to be running; no-op on plain GNOME).
        os.environ.setdefault('PYSTRAY_BACKEND', 'xorg')
        _LINUX_TRAY_BOOTSTRAP_STATUS = f'appindicator-unavailable:{indicator_error}'


_bootstrap_linux_tray_backend()

# Fix broken TLS CA-bundle env vars before any HTTPS library is imported.
# The PostgreSQL Windows installer (v14-17) sets CURL_CA_BUNDLE to a path
# that doesn't exist, which makes every Python requests HTTPS call fail.
# When running as a PyInstaller bundle, certifi.where() may also return a
# stale/wrong path if cacert.pem was not correctly placed — fall back to
# the explicit _MEIPASS/certifi/cacert.pem location in that case.
import certifi as _certifi_startup
import sys as _sys_certifi
_certifi_bundle = _certifi_startup.where()
if not os.path.isfile(_certifi_bundle):
    # PyInstaller bundle: try the canonical extracted location
    _meipass = getattr(_sys_certifi, '_MEIPASS', None)
    if _meipass:
        _candidate = os.path.join(_meipass, 'certifi', 'cacert.pem')
        if os.path.isfile(_candidate):
            _certifi_bundle = _candidate
for _var in ('REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE'):
    _existing = os.environ.get(_var)
    if not _existing or not os.path.isfile(_existing):
        if os.path.isfile(_certifi_bundle):
            os.environ[_var] = _certifi_bundle
del _certifi_startup, _sys_certifi, _certifi_bundle, _var, _existing

# Core dependencies
from PIL import Image, ImageGrab, ImageDraw
import psutil
import requests
from flask import Flask, render_template_string, jsonify, request, session, redirect, url_for
from flask_cors import CORS
try:
    import pystray
    from pystray import MenuItem as item
except ImportError as _pystray_err:
    # pystray could not load ANY backend (appindicator, gtk, xorg all failed).
    # Create a no-op fallback so the app runs without a tray icon.
    # This can happen when:
    #   - System python3-gi is missing or has a Python-version ABI mismatch
    #   - LD_LIBRARY_PATH from _MEIPASS shadows system libffi/libglib
    #   - python-xlib is also unavailable
    print(f'[WARN] pystray backend unavailable — running without tray icon: '
          f'{_pystray_err}')

    class _DummyMenuItem:
        def __init__(self, *a, **kw):
            pass

    class _DummyIcon:
        def __init__(self, *a, **kw):
            self.visible = False
        def run(self, setup=None):
            if setup:
                setup(self)
        def run_detached(self, setup=None):
            if setup:
                setup(self)
        def stop(self):
            pass
        def update_menu(self):
            pass
        @property
        def icon(self):
            return None
        @icon.setter
        def icon(self, value):
            pass
        @property
        def title(self):
            return ''
        @title.setter
        def title(self, value):
            pass
        @property
        def menu(self):
            return None
        @menu.setter
        def menu(self, value):
            pass

    class _DummyPystray:
        Icon = _DummyIcon
        Menu = lambda *a, **kw: None
        MenuItem = _DummyMenuItem

    import types
    pystray = _DummyPystray()
    item = _DummyMenuItem

# --- Wayland: safety-net to guarantee AyatanaAppIndicator3 (D-Bus SNI) -------
# The venv's pystray/_appindicator.py has been patched to prefer
# AyatanaAppIndicator3 on Wayland, so normally this block is a no-op.
#
# Edge cases this handles:
#  (a) pystray fell back to _xorg because gi was not yet on sys.path when
#      `import pystray` ran (shouldn't happen — bootstrap adds it first —
#      but defensive in case of import ordering surprises).
#  (b) pystray._appindicator somehow loaded AppIndicator3 (XEmbed) instead of
#      AyatanaAppIndicator3 (D-Bus SNI) — we replace the module-level binding
#      so all subsequent Icon creation / update calls use the patched library.
#
# In case (a) we also switch pystray.Icon to _appindicator.Icon and set
# PYSTRAY_BACKEND so any future re-init also picks the right backend.
_pystray_is_real = hasattr(pystray, '__file__') or hasattr(pystray, '__path__')
if _pystray_is_real and sys.platform.startswith('linux') and (
    os.environ.get('WAYLAND_DISPLAY') or
    os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
):
    try:
        import gi as _gi_patch
        _gi_patch.require_version('AyatanaAppIndicator3', '0.1')
        from gi.repository import AyatanaAppIndicator3 as _Ayatana

        import pystray._appindicator as _pai

        # Case (b): _appindicator loaded but with the wrong (XEmbed) lib
        _current_indicator = getattr(_pai, 'AppIndicator', None)
        _is_ayatana = _current_indicator is not None and 'Ayatana' in repr(_current_indicator)
        if not _is_ayatana:
            _pai.AppIndicator = _Ayatana
            print('[INFO] Wayland safety-net: pystray._appindicator patched to AyatanaAppIndicator3 (SNI)')

        # Case (a): pystray.Icon is _xorg.Icon — force switch to appindicator
        if 'xorg' in getattr(pystray.Icon, '__module__', ''):
            pystray.Icon = _pai.Icon
            os.environ['PYSTRAY_BACKEND'] = 'appindicator'
            print('[INFO] Wayland safety-net: pystray.Icon forced to _appindicator backend')
        else:
            print('[INFO] Wayland: pystray is using AyatanaAppIndicator3 (SNI/D-Bus) — OK')

    except Exception as _patch_err:
        print(f'[WARN] Wayland AyatanaAppIndicator3 safety-net failed: {_patch_err}')

from PIL import Image as PILImage

if sys.platform.startswith('linux'):
    print(f"[INFO] Linux tray bootstrap: {_LINUX_TRAY_BOOTSTRAP_STATUS}")

# Supabase
from supabase import create_client, Client
from supabase.lib.client_options import ClientOptions
from dotenv import load_dotenv

# SQLite for offline storage
import sqlite3
import socket
import fnmatch

# OCR for text extraction
from ocr import extract_text_from_image

# Multi-monitor focused capture (addresses multi-display OCR mismatch)
from monitor_capture import (
    capture_focused_monitor,
    get_focused_monitor_work_rect,
    log_display_environment,
    get_capture_stats,
)

# System dependency checker (PipeWire, GStreamer, XDG Portal)
try:
    from system_check import check_dependencies_startup
    SYSTEM_CHECK_AVAILABLE = True
except ImportError:
    SYSTEM_CHECK_AVAILABLE = False
    print("[WARN] system_check module not found - dependency checks disabled")

# OCR dependency check is deferred until after AI server config is fetched
# (so it uses the correct engines from the server, not local defaults)

# Application logging module
try:
    from app_logger import (
        setup_logging, get_logger, get_log_file_path, get_log_stats,
        log_auth_event, log_tracking_event, log_network_event,
        log_ocr_event, log_system_event, log_performance
    )
    APP_LOGGER_AVAILABLE = True
except ImportError:
    APP_LOGGER_AVAILABLE = False
    print("[WARN] app_logger module not found - logging to file disabled")

# ============================================================================
# SECURE LOGGING (PII SANITIZATION) - Embedded for single-file bundling
# ============================================================================

# Secure logging configuration from environment
_SECURE_LOG_ENABLED = os.environ.get('SECURE_LOG_ENABLED', 'true').lower() == 'true'
_SECURE_LOG_LEVEL = os.environ.get('SECURE_LOG_LEVEL', 'standard')  # minimal, standard, strict

# Sanitization patterns (matching ai-server patterns)
_SANITIZATION_PATTERNS = [
    # Email addresses (HIGH PRIORITY - always sanitize)
    {
        'pattern': re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', re.IGNORECASE),
        'replacement': '[EMAIL]',
        'type': 'EMAIL',
        'levels': ['minimal', 'standard', 'strict']
    },
    # Credit card numbers
    {
        'pattern': re.compile(r'\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b'),
        'replacement': '[CREDIT_CARD]',
        'type': 'CREDIT_CARD',
        'levels': ['minimal', 'standard', 'strict']
    },
    # Phone numbers
    {
        'pattern': re.compile(r'\b(?:\+?1[-.\s]?)?(?:\(?[0-9]{3}\)?[-.\s]?)?[0-9]{3}[-.\s]?[0-9]{4}\b'),
        'replacement': '[PHONE]',
        'type': 'PHONE',
        'levels': ['minimal', 'standard', 'strict']
    },
    # JWT Tokens
    {
        'pattern': re.compile(r'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'),
        'replacement': '[JWT]',
        'type': 'JWT',
        'levels': ['minimal', 'standard', 'strict']
    },
    # Atlassian Account IDs (format: 712020:uuid) - Must come before UUID
    {
        'pattern': re.compile(r'\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE),
        'replacement': '[ATLASSIAN_ACCOUNT]',
        'type': 'ATLASSIAN_ACCOUNT',
        'levels': ['standard', 'strict']
    },
    # UUIDs (user IDs, organization IDs, cloud IDs)
    {
        'pattern': re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.IGNORECASE),
        'replacement': '[UUID]',
        'type': 'UUID',
        'levels': ['standard', 'strict']
    },
    # IP Addresses
    {
        'pattern': re.compile(r'\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b'),
        'replacement': '[IP]',
        'type': 'IP_ADDRESS',
        'levels': ['standard', 'strict']
    },
    # API Keys with labels
    {
        'pattern': re.compile(r'(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)[\s]*[=:]+[\s]*["\']?([A-Za-z0-9_-]{16,})["\']?', re.IGNORECASE),
        'replacement': '[API_KEY]',
        'type': 'API_KEY',
        'levels': ['minimal', 'standard', 'strict']
    },
    # AWS Keys
    {
        'pattern': re.compile(r'\b(AKIA[0-9A-Z]{16})\b'),
        'replacement': '[AWS_KEY]',
        'type': 'AWS_KEY',
        'levels': ['minimal', 'standard', 'strict']
    },
    # GitHub tokens
    {
        'pattern': re.compile(r'\b(gh[ps]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]+)\b'),
        'replacement': '[GITHUB_TOKEN]',
        'type': 'GITHUB_TOKEN',
        'levels': ['minimal', 'standard', 'strict']
    },
]

def _should_apply_pattern(pattern_config: dict, level: str) -> bool:
    """Check if pattern should be applied at current level"""
    return level in pattern_config.get('levels', [])

def sanitize_value(value, level: str = None) -> str:
    """Sanitize a single value by redacting PII patterns."""
    if level is None:
        level = _SECURE_LOG_LEVEL
    if not _SECURE_LOG_ENABLED:
        return str(value)
    text = str(value)
    for config in _SANITIZATION_PATTERNS:
        if not _should_apply_pattern(config, level):
            continue
        text = config['pattern'].sub(config['replacement'], text)
    return text

def _sanitize_dict(data: dict, level: str = None) -> dict:
    """Sanitize all values in a dictionary."""
    if level is None:
        level = _SECURE_LOG_LEVEL
    result = {}
    for key, value in data.items():
        if isinstance(value, dict):
            result[key] = _sanitize_dict(value, level)
        elif isinstance(value, list):
            result[key] = [sanitize_value(v, level) for v in value]
        else:
            result[key] = sanitize_value(value, level)
    return result

def secure_log(message: str, level: str = "INFO", **kwargs) -> None:
    """Print a sanitized log message with optional key=value pairs."""
    sanitized_message = sanitize_value(message)
    if kwargs:
        sanitized_kwargs = _sanitize_dict(kwargs)
        kwargs_str = " | ".join(f"{k}={v}" for k, v in sanitized_kwargs.items())
        log_line = f"{sanitized_message} | {kwargs_str}"
    else:
        log_line = sanitized_message
    if os.environ.get('LOG_TIMESTAMPS', 'false').lower() == 'true':
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        print(f"[{timestamp}] [{level}] {log_line}")
    else:
        print(log_line)


def log_auth_diagnostic(event: str, level: str = "INFO", **kwargs) -> None:
    """Write a structured auth diagnostic line to the application log."""
    if not APP_LOGGER_AVAILABLE:
        return

    try:
        logger = get_logger(__name__, 'AUTH')
        sanitized_kwargs = _sanitize_dict(kwargs) if kwargs else {}
        details = " | ".join(f"{k}={v}" for k, v in sanitized_kwargs.items())
        message = event if not details else f"{event} | {details}"

        log_method = getattr(logger, str(level).lower(), logger.info)
        log_method(message)
    except Exception:
        pass

# ============================================================================

# Secure credential storage
try:
    from auth import SecureTokenStorage, SecurityError, KEYRING_AVAILABLE
    SECURE_STORAGE_AVAILABLE = True
    print("[OK] Secure token storage initialized")
except ImportError:
    SECURE_STORAGE_AVAILABLE = False
    print("[ERROR] Secure token storage module not found - this should not happen")
    raise

# Windows-specific imports
try:
    import win32gui
    import win32process
    import win32con
    import win32event
    import winerror
    import win32api
    WIN32_AVAILABLE = True
except ImportError:
    WIN32_AVAILABLE = False

# Tkinter for pause popup window
try:
    import tkinter as tk
    from tkinter import ttk
    TKINTER_AVAILABLE = True
except ImportError:
    TKINTER_AVAILABLE = False
    print("[WARN] tkinter not available - pause popup window disabled")

# ============================================================================
# SINGLE INSTANCE LOCK
# ============================================================================

_instance_mutex = None

def acquire_single_instance_lock():
    """
    Acquire a system-wide mutex to ensure only one instance runs.
    Returns True if lock acquired (this is the only instance).
    Returns False if another instance is already running.
    """
    global _instance_mutex

    if not WIN32_AVAILABLE:
        # On non-Windows, use a lock file approach
        return _acquire_lock_file()

    try:
        # Create a named mutex - if it already exists, another instance is running
        mutex_name = "TimeTracker_SingleInstance_Mutex"
        _instance_mutex = win32event.CreateMutex(None, True, mutex_name)

        # Check if we got the mutex or if it already existed
        last_error = win32event.GetLastError() if hasattr(win32event, 'GetLastError') else 0

        # Alternative way to check - try to get last error via ctypes
        import ctypes
        last_error = ctypes.windll.kernel32.GetLastError()

        if last_error == winerror.ERROR_ALREADY_EXISTS:
            print("[WARN] Another instance of Time Tracker is already running!")
            return False

        print("[OK] Single instance lock acquired")
        return True

    except Exception as e:
        print(f"[WARN] Could not create single instance lock: {e}")
        # Fall back to lock file approach
        return _acquire_lock_file()

def _acquire_lock_file():
    """Fallback lock file approach for non-Windows or when mutex fails"""
    lock_file = os.path.join(get_app_data_dir(), '.lock')

    try:
        # Check if lock file exists and if the process is still running
        if os.path.exists(lock_file):
            with open(lock_file, 'r') as f:
                pid = int(f.read().strip())

            # Check if process is still running
            if psutil.pid_exists(pid):
                try:
                    proc = psutil.Process(pid)
                    # Check if it's actually our app by looking at command line
                    cmdline = ' '.join(proc.cmdline()).lower()
                    if 'desktop_app.py' in cmdline or 'timetracker' in proc.name().lower():
                        print(f"[WARN] Another instance is running (PID: {pid})")
                        return False
                    else:
                        # Different app with same PID - remove stale lock
                        print(f"[INFO] Removing stale lock file (PID {pid} is not TimeTracker)")
                        os.remove(lock_file)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    # Process doesn't exist or we can't access it - remove stale lock
                    print(f"[INFO] Removing stale lock file (PID {pid} no longer exists)")
                    try:
                        os.remove(lock_file)
                    except:
                        pass
            else:
                # Process doesn't exist - remove stale lock
                print(f"[INFO] Removing stale lock file (PID {pid} not running)")
                try:
                    os.remove(lock_file)
                except:
                    pass

        # Write our PID to lock file
        with open(lock_file, 'w') as f:
            f.write(str(os.getpid()))

        print("[OK] Lock file acquired")
        return True

    except Exception as e:
        print(f"[WARN] Lock file error: {e}")
        return True  # Allow running if we can't check

def release_single_instance_lock():
    """Release the single instance lock"""
    global _instance_mutex

    if _instance_mutex:
        try:
            win32event.ReleaseMutex(_instance_mutex)
            win32event.CloseHandle(_instance_mutex)
        except:
            pass
        _instance_mutex = None

    # Also clean up lock file
    lock_file = os.path.join(get_app_data_dir(), '.lock')
    try:
        if os.path.exists(lock_file):
            os.remove(lock_file)
    except:
        pass

# Windows toast notifications
try:
    from winotify import Notification, audio
    WINOTIFY_AVAILABLE = True
except ImportError:
    WINOTIFY_AVAILABLE = False
    print("[WARN] winotify not available - desktop notifications disabled")

# Linux desktop notifications via notify-send (libnotify)
import shutil as _shutil
_NOTIFY_SEND = _shutil.which("notify-send")
NOTIFY_SEND_AVAILABLE = _NOTIFY_SEND is not None

def _linux_notify(title: str, msg: str, urgency: str = "normal") -> None:
    """Send a desktop notification on Linux using notify-send.
    No-op when notify-send is not available or on non-Linux platforms."""
    if not NOTIFY_SEND_AVAILABLE:
        return
    try:
        import subprocess as _sp
        _sp.run(
            [_NOTIFY_SEND, "--urgency", urgency, "--app-name", "Time Tracker", title, msg],
            timeout=3, check=False, capture_output=True
        )
    except Exception:
        pass

# Note: AI analysis is now handled by the separate AI server
# Desktop app only captures and uploads screenshots to Supabase

# Load environment variables
load_dotenv()

# ============================================================================
# CONFIGURATION
# ============================================================================

# Application version - IMPORTANT: Update this when releasing new versions
# This is used for update checking and notifications
APP_VERSION = "1.0.0"

# True when the process is running inside an AppImage bundle.
# In FUSE mode, the AppImage runtime sets $APPIMAGE to the .AppImage file path.
# In extract-and-run mode (APPIMAGE_EXTRACT_AND_RUN=1), the runtime does NOT
# set $APPIMAGE — only APPIMAGE_EXTRACT_AND_RUN is present in the environment.
# We must detect BOTH modes to correctly identify we're inside an AppImage.
_APPIMAGE_PATH = os.environ.get('APPIMAGE', '')
_APPIMAGE_EXTRACT_MODE = bool(os.environ.get('APPIMAGE_EXTRACT_AND_RUN'))
IS_APPIMAGE = bool(_APPIMAGE_PATH) or _APPIMAGE_EXTRACT_MODE

# Hard-disable screenshot monitoring/storage in desktop app.
# OCR text extraction for activity records still runs via event-based flow.
SCREENSHOT_MONITORING_HARD_DISABLED = True

# Embedded credentials (for production builds - no .env file needed)
# SECURITY: All sensitive keys moved to AI Server - fetched at runtime after authentication
EMBEDDED_CONFIG = {
    'ATLASSIAN_CLIENT_ID': 'Q8HT4Jn205AuTiAarj088oWNDrOqwvM5',
    # Google OAuth (non-Jira users). PUBLIC client ID only — the client SECRET
    # stays on the AI Server, never in the desktop build. Same handling as
    # ATLASSIAN_CLIENT_ID above. Must match GOOGLE_DESKTOP_CLIENT_ID on the AI server.
    'GOOGLE_DESKTOP_CLIENT_ID': '508843846019-glrru7r3m622vt75e215lmf5ih1bcgju.apps.googleusercontent.com',
    # REMOVED: ATLASSIAN_CLIENT_SECRET - now on AI Server only (security fix)
    # REMOVED: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY - fetched from AI Server
    'AI_SERVER_URL': 'https://forgesync.amzur.com',  # AI Server for secure token exchange & config
    'CAPTURE_INTERVAL': '300',
    'WEB_PORT': '51777',
}

# Runtime Supabase config (fetched from AI server after authentication)
RUNTIME_SUPABASE_CONFIG = {
    'SUPABASE_URL': None,
    'SUPABASE_ANON_KEY': None
}

# Runtime OCR config (fetched from AI server after authentication)
RUNTIME_OCR_CONFIG = {}

def get_env_var(key, default=None):
    """Get environment variable with fallback to embedded/runtime values"""
    # First try environment variable (for development with .env)
    value = os.getenv(key)
    if value:
        return value
    # Then try runtime Supabase config (fetched from AI server)
    if key in RUNTIME_SUPABASE_CONFIG and RUNTIME_SUPABASE_CONFIG[key]:
        return RUNTIME_SUPABASE_CONFIG[key]
    # Then try runtime OCR config (fetched from AI server)
    if key in RUNTIME_OCR_CONFIG and RUNTIME_OCR_CONFIG[key]:
        return RUNTIME_OCR_CONFIG[key]
    # Then try embedded config (for production builds)
    if key in EMBEDDED_CONFIG:
        return EMBEDDED_CONFIG[key]
    # Finally use default
    return default

def set_runtime_supabase_config(url, anon_key):
    """Set Supabase config fetched from AI server"""
    global RUNTIME_SUPABASE_CONFIG
    RUNTIME_SUPABASE_CONFIG['SUPABASE_URL'] = url
    RUNTIME_SUPABASE_CONFIG['SUPABASE_ANON_KEY'] = anon_key
    print(f"[OK] Supabase config loaded from AI server")

def set_runtime_ocr_config(config_dict):
    """
    Set OCR config fetched from AI server.
    
    Converts the nested config dict from AI server into flat OCR_* environment-style keys.
    This allows OCRConfig.from_env() to work seamlessly with runtime config.
    
    Args:
        config_dict: Dict from AI server with structure:
            {
                'primary_engine': 'rapidocr',
                'fallback_engines': ['winrtocr'],
                'use_preprocessing': True,
                'engines': {'rapidocr': {'min_confidence': 0.6, ...}, ...}
            }
    """
    global RUNTIME_OCR_CONFIG
    RUNTIME_OCR_CONFIG = {}

    # Use whatever engines the AI server has configured — no hardcoded overrides.
    primary = config_dict.get('primary_engine', 'rapidocr')
    fallbacks = config_dict.get('fallback_engines', ['winrtocr'])
    if isinstance(fallbacks, list):
        fallbacks = ','.join(fallbacks)
    RUNTIME_OCR_CONFIG['OCR_PRIMARY_ENGINE'] = primary
    RUNTIME_OCR_CONFIG['OCR_FALLBACK_ENGINES'] = fallbacks

    # Global preprocessing settings
    RUNTIME_OCR_CONFIG['OCR_USE_PREPROCESSING'] = str(config_dict.get('use_preprocessing', True)).lower()
    RUNTIME_OCR_CONFIG['OCR_MAX_IMAGE_DIMENSION'] = str(config_dict.get('max_image_dimension', 4096))
    RUNTIME_OCR_CONFIG['OCR_PREPROCESSING_TARGET_DPI'] = str(config_dict.get('preprocessing_target_dpi', 300))

    # Per-engine configurations — apply all engines returned by the server
    engines = config_dict.get('engines', {})
    for engine_name, engine_config in engines.items():
        prefix = f'OCR_{engine_name.upper()}_'
        RUNTIME_OCR_CONFIG[f'{prefix}ENABLED'] = str(engine_config.get('enabled', True)).lower()
        RUNTIME_OCR_CONFIG[f'{prefix}MIN_CONFIDENCE'] = str(engine_config.get('min_confidence', 0.5))
        RUNTIME_OCR_CONFIG[f'{prefix}USE_GPU'] = str(engine_config.get('use_gpu', False)).lower()
        RUNTIME_OCR_CONFIG[f'{prefix}LANGUAGE'] = engine_config.get('language', 'en')

        # Extra engine-specific params
        for param_name, param_value in engine_config.get('extra_params', {}).items():
            RUNTIME_OCR_CONFIG[f'{prefix}{param_name.upper()}'] = str(param_value)

    # Push all OCR config values into os.environ so the OCR facade and config modules
    # (which use os.getenv() directly) pick up the values fetched from the AI server.
    for key, value in RUNTIME_OCR_CONFIG.items():
        os.environ[key] = str(value)

    # Now that the correct engine config is in os.environ, run the dependency check
    # so missing packages for the server-configured engines are installed.
    try:
        from ocr.auto_installer import check_and_install_dependencies
        check_and_install_dependencies(auto_install=True, silent=False)
    except Exception as _e:
        print(f"[WARN] OCR dependency check failed: {_e}")

    # Reset the global OCRFacade singleton so the next OCR call re-reads os.environ
    # and picks up the config just fetched from the AI server instead of the stale
    # startup defaults that were baked in before authentication.
    try:
        from ocr.facade import reset_facade
        reset_facade()
        print("[OK] OCR facade reset — will reinitialise with AI server config on next call")
    except Exception as _e:
        print(f"[WARN] Could not reset OCR facade: {_e}")

    print(f"[OK] OCR config loaded from AI server (engines: {primary}, {fallbacks})")


def set_runtime_privacy_config(config_dict):
    """
    Set privacy filter config fetched from AI server.

    Converts the privacy config dict into PRIVACY_* environment variables
    so PrivacyConfig.from_env() picks them up when the OCR facade reinitialises.

    Args:
        config_dict: Dict from AI server with structure:
            {
                'enabled': True,
                'min_confidence': 0.7,
                'detect_pii': True,
                'detect_custom_patterns': True,
                'detect_secrets': False,
                'redaction_strategy': 'mask',
                'mask_char': '*',
                'mask_length': 8,
                'fail_open': False,
            }
    """
    env_mapping = {
        'enabled': 'PRIVACY_FILTER_ENABLED',
        'min_confidence': 'PRIVACY_MIN_CONFIDENCE',
        'detect_pii': 'PRIVACY_DETECT_PII',
        'detect_secrets': 'PRIVACY_DETECT_SECRETS',
        'detect_custom_patterns': 'PRIVACY_DETECT_CUSTOM_PATTERNS',
        'redaction_strategy': 'PRIVACY_REDACTION_STRATEGY',
        'mask_char': 'PRIVACY_MASK_CHAR',
        'mask_length': 'PRIVACY_MASK_LENGTH',
        'fail_open': 'PRIVACY_FAIL_OPEN',
    }

    for key, env_var in env_mapping.items():
        if key in config_dict:
            value = config_dict[key]
            # Convert booleans to lowercase strings for env var compatibility
            if isinstance(value, bool):
                value = str(value).lower()
            os.environ[env_var] = str(value)

    detect_pii = config_dict.get('detect_pii', True)
    print(f"[OK] Privacy config loaded from AI server (PII detection: {'enabled' if detect_pii else 'disabled'})")


# ============================================================================
# VERSION CHECKING UTILITIES
# ============================================================================

def is_version_newer(latest_version, current_version):
    """
    Compare two semantic version strings (e.g., "1.2.3").
    Returns True if latest_version is newer than current_version.
    """
    try:
        latest_parts = [int(x) for x in latest_version.split('.')]
        current_parts = [int(x) for x in current_version.split('.')]
        
        # Pad with zeros if needed
        while len(latest_parts) < 3:
            latest_parts.append(0)
        while len(current_parts) < 3:
            current_parts.append(0)
        
        for i in range(3):
            if latest_parts[i] > current_parts[i]:
                return True
            if latest_parts[i] < current_parts[i]:
                return False
        
        return False  # Versions are equal
    except (ValueError, AttributeError):
        return False

def check_for_updates(ai_server_url=None):
    """
    Check the AI server for available updates.
    Returns a dict with update info if available, None otherwise.
    
    Response format:
    {
        'update_available': bool,
        'latest_version': str,
        'download_url': str,
        'release_notes': str,
        'is_mandatory': bool,
        'checksum': str (SHA256 hash for integrity verification)
    }
    """
    server_url = ai_server_url or get_env_var('AI_SERVER_URL')
    if not server_url:
        print("[WARN] AI Server URL not configured, skipping update check")
        return None
    
    _platform = 'linux' if sys.platform.startswith('linux') else 'windows'
    url = f"{server_url}/api/app-version/check?platform={_platform}&current={APP_VERSION}"
    
    # Retry logic with exponential backoff for transient network failures
    max_attempts = 3
    backoff_delays = [0, 2, 4]  # seconds between attempts
    
    for attempt in range(max_attempts):
        try:
            if attempt > 0:
                delay = backoff_delays[attempt]
                print(f"[INFO] Retrying update check (attempt {attempt + 1}/{max_attempts}) after {delay}s delay...")
                time.sleep(delay)
            
            response = requests.get(url, timeout=10)
            
            if response.status_code != 200:
                print(f"[WARN] Update check failed: HTTP {response.status_code}")
                # Don't retry on HTTP errors (4xx/5xx) - these are not transient
                return None
            
            data = response.json()
            
            if not data.get('success'):
                print(f"[WARN] Update check failed: {data.get('error', 'Unknown error')}")
                # Server returned error response - don't retry
                return None
            
            result = data.get('data', {})
            
            return {
                'update_available': result.get('updateAvailable', False),
                'latest_version': result.get('latestVersion'),
                'current_version': result.get('currentVersion', APP_VERSION),
                'download_url': result.get('downloadUrl'),
                'release_notes': result.get('releaseNotes'),
                'is_mandatory': result.get('isMandatory', False),
                'can_update': result.get('canUpdate', True),
                'checksum': result.get('checksum'),  # SHA256 for integrity verification
                'file_size_bytes': result.get('fileSizeBytes')
            }
        
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            # Retry on timeout and connection errors (transient failures)
            if attempt < max_attempts - 1:
                print(f"[WARN] Update check failed (attempt {attempt + 1}/{max_attempts}): {type(e).__name__}")
                continue  # Retry
            else:
                print(f"[WARN] Update check failed after {max_attempts} attempts: {e}")
                return None
        
        except requests.exceptions.RequestException as e:
            # Other request exceptions (DNS errors, SSL errors, etc.) - don't retry
            print(f"[WARN] Update check failed: {e}")
            return None
        
        except Exception as e:
            print(f"[WARN] Unexpected error during update check: {e}")
            return None
    
    return None

def compute_file_checksum(file_path):
    """
    Compute SHA256 checksum of a local file.
    
    Args:
        file_path: Path to the file to hash
        
    Returns:
        str: SHA256 hash as lowercase hex string, or None on error
    """
    import hashlib
    
    try:
        sha256_hash = hashlib.sha256()
        with open(file_path, "rb") as f:
            # Read in chunks to handle large files
            for chunk in iter(lambda: f.read(8192), b""):
                sha256_hash.update(chunk)
        return sha256_hash.hexdigest()
    except Exception as e:
        print(f"[WARN] Failed to compute checksum for {file_path}: {e}")
        return None

def verify_download_checksum(file_path, expected_checksum):
    """
    Verify that a downloaded file matches the expected checksum.
    
    Args:
        file_path: Path to the downloaded file
        expected_checksum: Expected SHA256 hash (from API)
        
    Returns:
        bool: True if checksum matches, False otherwise
    """
    # Accept common checksum formats from APIs (plain hash or sha256:<hash>).
    expected_checksum = (expected_checksum or '').strip()
    if expected_checksum.lower().startswith('sha256:'):
        expected_checksum = expected_checksum.split(':', 1)[1].strip()

    if not expected_checksum:
        print("[INFO] No checksum provided, skipping verification")
        return True  # No checksum to verify against
    
    actual_checksum = compute_file_checksum(file_path)
    
    if actual_checksum is None:
        print("[WARN] Could not compute checksum of downloaded file")
        return False
    
    # Compare checksums (case-insensitive)
    if actual_checksum.lower() == expected_checksum.lower():
        print(f"[OK] Checksum verified: {actual_checksum[:16]}...")
        return True
    else:
        print(f"[ERROR] Checksum mismatch!")
        print(f"  Expected: {expected_checksum}")
        print(f"  Actual:   {actual_checksum}")
        return False

def show_update_notification(update_info, callback=None, state='available', web_port=None, install_callback=None):
    """
    Show a Windows toast notification about available update.
    
    Args:
        update_info: Dict with update information from check_for_updates()
        callback: Optional callback function to call when notification is clicked
        state: Current update state ('available', 'downloading', 'ready', 'mandatory_ready', 'failed')
        web_port: Local web server port for notification click actions
        install_callback: Callable to trigger update installation directly (no browser)
    """
    if not WINOTIFY_AVAILABLE:
        latest_version = (update_info or {}).get('latest_version', 'unknown')
        is_mandatory = (update_info or {}).get('is_mandatory', False)

        if state == 'downloading':
            title = "Update Downloading"
            message = f"Downloading update v{latest_version} in background..."
            urgency = "normal"
        elif state == 'ready':
            title = "Update Ready"
            message = f"Update v{latest_version} downloaded and ready to install."
            urgency = "normal"
        elif state == 'mandatory_ready':
            title = "Update Required"
            message = f"Required update v{latest_version} is ready to install."
            urgency = "critical"
        elif state == 'failed':
            title = "Update Failed"
            message = "Update download failed. The app will retry later."
            urgency = "normal"
        else:
            title = "Update Required" if is_mandatory else "Update Available"
            message = f"Update v{latest_version} is available"
            urgency = "normal"

        _linux_notify(title, message, urgency=urgency)
        print(f"[INFO] Linux update notification: {title} - {message}")
        return
    
    try:
        latest_version = update_info.get('latest_version', 'unknown')
        release_notes = update_info.get('release_notes', 'A new version is available.') or 'A new version is available.'
        is_mandatory = update_info.get('is_mandatory', False)

        if state == 'downloading':
            title = "Update Available"
            release_notes = f"Update v{latest_version} available - downloading in background..."
        elif state == 'ready':
            title = "Update Ready"
            release_notes = f"Update v{latest_version} is ready to install. Click Install Now to update."
        elif state == 'mandatory_ready':
            title = "Update Required"
            release_notes = f"Required update v{latest_version} is ready. Click Install Now to update."
        elif state == 'failed':
            title = "Update Failed"
            release_notes = "Update download failed. The app will retry later."
        else:
            if len(release_notes) > 200:
                release_notes = release_notes[:197] + "..."
            title = "Update Required" if is_mandatory else "Update Available"
        
        notification = Notification(
            app_id="Time Tracker",
            title=f"{title}: v{latest_version}",
            msg=release_notes,
            duration="long" if is_mandatory else "short"
        )
        
        notification.set_audio(audio.Default, loop=False)

        # Add "Install Now" button that triggers install directly (no browser)
        if install_callback and state in ('ready', 'mandatory_ready'):
            install_url = f"http://localhost:{web_port}/api/update/install" if web_port else None
            if install_url:
                notification.add_actions(label="Install Now", launch=install_url)
        
        notification.show()
        
        print(f"[OK] Update notification shown: v{latest_version}")
        
    except Exception as e:
        print(f"[WARN] Could not show update notification: {e}")

def _utc_ts_to_local_date(utc_str):
    """Convert a UTC timestamp string to the local calendar date (YYYY-MM-DD).

    first_seen/last_seen are stored as UTC strings (e.g. '2026-03-08 21:30:27+00').
    Taking [:10] gives the UTC date which is wrong for users ahead of UTC (e.g.
    UTC+5:30 — 21:30 UTC on March 8 is 03:00 AM IST on March 9).
    We convert to local time first so work_date matches the user's calendar day.
    """
    if not utc_str:
        return datetime.now().date().isoformat()
    try:
        import tzlocal
        local_tz = tzlocal.get_localzone()
        # Handle both '+00' and '+00:00' offset suffixes
        ts = utc_str.strip()
        if ts.endswith('+00') or ts.endswith(' UTC'):
            ts = ts.replace(' UTC', '+00:00').replace('+00', '+00:00')
        if '.' in ts:
            # Strip microseconds for fromisoformat compatibility
            ts = ts.split('.')[0] + '+00:00'
        from datetime import timezone
        dt_utc = datetime.fromisoformat(ts)
        if dt_utc.tzinfo is None:
            dt_utc = dt_utc.replace(tzinfo=timezone.utc)
        return dt_utc.astimezone(local_tz).date().isoformat()
    except Exception:
        # Fallback: use current local date
        return datetime.now().date().isoformat()


def get_local_timezone_name():
    """
    Auto-detect user's IANA timezone name (e.g., 'Asia/Kolkata', 'America/New_York').
    This is used to correctly compute work_date for sessions that cross midnight.
    """
    try:
        import tzlocal
        local_tz = tzlocal.get_localzone()
        return str(local_tz)
    except ImportError:
        # Fallback to UTC offset format if tzlocal not available
        # Etc/GMT format works with PostgreSQL's AT TIME ZONE
        offset_seconds = -time.timezone if time.daylight == 0 else -time.altzone
        hours = abs(offset_seconds) // 3600
        sign = '+' if offset_seconds >= 0 else '-'
        # Note: Etc/GMT signs are inverted (Etc/GMT-5 is UTC+5)
        return f"Etc/GMT{'-' if sign == '+' else '+'}{hours}"

def get_app_data_dir():
    """Get the application data directory in LocalAppData"""
    if sys.platform == 'win32':
        app_data = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
    else:
        app_data = os.path.expanduser('~/.local/share')

    app_dir = os.path.join(app_data, 'TimeTracker')

    # Create directory if it doesn't exist
    if not os.path.exists(app_dir):
        os.makedirs(app_dir)
        print(f"[OK] Created app data directory: {app_dir}")

    return app_dir

def get_app_executable_dir():
    """Get the directory where the executable is located"""
    if getattr(sys, 'frozen', False):
        # Running as compiled executable
        return os.path.dirname(sys.executable)
    else:
        # Running as script
        return os.path.dirname(os.path.abspath(__file__))

def get_app_executable_path():
    """Get the full path to the executable"""
    if getattr(sys, 'frozen', False):
        return sys.executable
    else:
        return os.path.abspath(__file__)

def get_installed_exe_path():
    """Get the path where the exe should be installed"""
    return os.path.join(get_app_data_dir(), 'TimeTracker.exe')

def get_linux_installed_binary_path():
    """Get the canonical install path for the Linux binary (~/.local/share/TimeTracker/TimeTracker)."""
    return os.path.join(get_app_data_dir(), 'TimeTracker')

def get_linux_installed_appimage_path():
    """Return the canonical install path of the AppImage.

    Always returns ~/.local/share/TimeTracker/TimeTracker.AppImage regardless
    of where the app was launched from ($APPIMAGE).  Auto-update and the
    autostart entry always target this stable canonical location so the app
    remains in a predictable place even if the user first ran it from
    ~/Downloads or another temporary directory.
    """
    return os.path.join(get_app_data_dir(), 'TimeTracker.AppImage')

def get_shutdown_signal_path():
    """Get the path to the shutdown signal file"""
    return os.path.join(get_app_data_dir(), '.shutdown_signal')

def find_running_timetracker_processes():
    """
    Find all running TimeTracker processes except the current one.
    Returns list of psutil.Process objects.
    """
    current_pid = os.getpid()

    # Collect ancestor PIDs to avoid accidentally killing our own AppImage runner.
    # On Linux AppImages the FUSE mount helper is a *parent* of the Python
    # interpreter and has 'TimeTracker' in its exe path.  Without this guard
    # terminate_old_version() would send SIGTERM to that parent, which then
    # propagates to the current Python process → exit 143 "Terminated".
    ancestor_pids = set()
    try:
        for ancestor in psutil.Process(current_pid).parents():
            ancestor_pids.add(ancestor.pid)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass

    running_processes = []

    for proc in psutil.process_iter(['pid', 'name', 'exe']):
        try:
            # Skip current process and its ancestor processes
            if proc.pid == current_pid or proc.pid in ancestor_pids:
                continue

            proc_name = proc.info['name'].lower() if proc.info['name'] else ''
            proc_exe = proc.info['exe'].lower() if proc.info['exe'] else ''

            # Check if it's a TimeTracker process
            if 'timetracker' in proc_name or 'timetracker' in proc_exe:
                running_processes.append(proc)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

    return running_processes

def request_graceful_shutdown():
    """
    Request the running TimeTracker instance to shut down gracefully.
    Creates a signal file that the running instance will detect.
    Returns True if signal was created.
    """
    try:
        signal_path = get_shutdown_signal_path()
        with open(signal_path, 'w') as f:
            f.write(f"shutdown_requested_at={datetime.now(timezone.utc).isoformat()}\n")
            f.write(f"requested_by_pid={os.getpid()}\n")
        print("[INFO] Shutdown signal sent to running instance")
        return True
    except Exception as e:
        print(f"[WARN] Could not create shutdown signal: {e}")
        return False

def clear_shutdown_signal():
    """Remove the shutdown signal file"""
    try:
        signal_path = get_shutdown_signal_path()
        if os.path.exists(signal_path):
            os.remove(signal_path)
    except:
        pass

def check_for_shutdown_signal():
    """
    Check if a shutdown signal has been received.
    Called periodically by the running app.
    Returns True if shutdown was requested.
    """
    signal_path = get_shutdown_signal_path()
    return os.path.exists(signal_path)

def terminate_old_version(processes, timeout=10):
    """
    Terminate old TimeTracker processes.
    First tries graceful termination, then force kills if needed.

    Args:
        processes: List of psutil.Process objects
        timeout: Seconds to wait for graceful termination

    Returns:
        bool: True if all processes were terminated
    """
    if not processes:
        return True

    print(f"[INFO] Terminating {len(processes)} old instance(s)...")

    # First, try graceful termination (SIGTERM)
    for proc in processes:
        try:
            print(f"       - Requesting shutdown of PID {proc.pid}")
            proc.terminate()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    # Wait for processes to exit
    start_time = time.time()
    while time.time() - start_time < timeout:
        still_running = []
        for proc in processes:
            try:
                if proc.is_running():
                    still_running.append(proc)
            except psutil.NoSuchProcess:
                pass

        if not still_running:
            print("[OK] Old instance(s) terminated gracefully")
            return True

        time.sleep(0.5)

    # Force kill remaining processes
    for proc in still_running:
        try:
            print(f"[WARN] Force killing PID {proc.pid}")
            proc.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

    # Final check
    time.sleep(1)
    for proc in processes:
        try:
            if proc.is_running():
                print(f"[ERROR] Could not terminate PID {proc.pid}")
                return False
        except psutil.NoSuchProcess:
            pass

    print("[OK] All old instances terminated")
    return True

def wait_for_file_unlock(file_path, max_attempts=20, delay=0.5):
    """
    Wait for a file to become writable (unlocked).

    Args:
        file_path: Path to the file
        max_attempts: Maximum number of attempts
        delay: Seconds between attempts

    Returns:
        bool: True if file is writable, False if still locked
    """
    print(f"[INFO] Waiting for file to be unlocked: {os.path.basename(file_path)}")

    for attempt in range(max_attempts):
        try:
            # Try to open the file for writing
            if os.path.exists(file_path):
                with open(file_path, 'r+b') as f:
                    # If we can open it, it's unlocked
                    pass
            # File doesn't exist or is unlocked
            print(f"[OK] File is ready (attempt {attempt + 1})")
            return True
        except (IOError, OSError, PermissionError) as e:
            if attempt < max_attempts - 1:
                print(f"       Attempt {attempt + 1}/{max_attempts} - file locked, waiting...")
                time.sleep(delay)
            else:
                print(f"[ERROR] File still locked after {max_attempts} attempts")
                return False

def is_running_from_install_location():
    """Check if the app is running from the correct install location"""
    if not getattr(sys, 'frozen', False):
        # Running as script (development mode) - always return True
        return True

    # AppImages are self-contained executables — there is no separate "install"
    # location to compare against (sys.executable points inside a FUSE mount).
    if IS_APPIMAGE:
        return True

    current_path = os.path.normpath(get_app_executable_path()).lower()
    install_path = os.path.normpath(get_installed_exe_path()).lower()

    return current_path == install_path

def _try_enable_gnome_appindicator_extension() -> None:
    """Enable the ubuntu-appindicators GNOME Shell extension in the live user session.

    This MUST run inside the user's running session — it uses D-Bus to talk to
    the live gnome-shell process.  It is a no-op (silently succeeds) if:
      - Not on Linux
      - No GNOME session is active
      - Extension is already enabled
      - gnome-extensions CLI and gdbus are unavailable

    Tries two methods in order:
      1. gdbus call directly to org.gnome.Shell.Extensions (reliable on Ubuntu 22.04+)
      2. gnome-extensions enable CLI (fallback for older GNOME)

    NOTE: This must NOT be called from postinst/dpkg — there is no GNOME session
    D-Bus at package-install time.  Call it at first app launch instead.
    """
    if not sys.platform.startswith('linux'):
        return

    EXTENSION_UUID = 'ubuntu-appindicators@ubuntu.com'

    # Only attempt if inside a GNOME session
    desktop = os.environ.get('XDG_CURRENT_DESKTOP', '').lower()
    session = os.environ.get('DESKTOP_SESSION', '').lower()
    if 'gnome' not in desktop and 'gnome' not in session and 'ubuntu' not in desktop:
        return

    # Method 1: gdbus — most reliable (works without gnome-extensions installed)
    try:
        result = subprocess.run(
            [
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell',
                '--method', 'org.gnome.Shell.Extensions.EnableExtension',
                EXTENSION_UUID,
            ],
            capture_output=True, timeout=5, text=True
        )
        if result.returncode == 0:
            print(f"[OK] GNOME AppIndicator extension enabled via gdbus: {EXTENSION_UUID}")
            return
        # Non-zero returncode does not always mean failure — if already enabled,
        # some GNOME versions return a D-Bus reply without error.
        stderr_lower = (result.stderr or '').lower()
        if 'not found' not in stderr_lower and 'no such' not in stderr_lower:
            print(f"[INFO] gdbus extension enable returned rc={result.returncode}: "
                  f"{result.stderr.strip() or 'no output'}")
            return
    except FileNotFoundError:
        pass  # gdbus not installed — fall through to CLI
    except subprocess.TimeoutExpired:
        print("[WARN] gdbus extension enable timed out — skipping")
        return
    except Exception as e:
        print(f"[WARN] gdbus extension enable error: {e}")

    # Method 2: gnome-extensions CLI (fallback)
    try:
        result = subprocess.run(
            ['gnome-extensions', 'enable', EXTENSION_UUID],
            capture_output=True, timeout=5, text=True
        )
        if result.returncode == 0:
            print(f"[OK] GNOME AppIndicator extension enabled via CLI: {EXTENSION_UUID}")
        else:
            print(f"[INFO] gnome-extensions enable: "
                  f"{result.stderr.strip() or result.stdout.strip() or 'no output'}")
    except FileNotFoundError:
        print("[INFO] gnome-extensions CLI not available — "
              "tray icon may require manual AppIndicator extension enable")
    except subprocess.TimeoutExpired:
        print("[WARN] gnome-extensions enable timed out — skipping")
    except Exception as e:
        print(f"[WARN] gnome-extensions enable error: {e}")


def _ensure_install_scaffold(install_dir: str, canonical_appimage: str) -> None:
    """Create all directories and helper files expected in the TimeTracker
    install folder, regardless of how the app was started.

    Called at every startup (even when already at the canonical path) so that
    a fresh .deb install produces a fully-populated install directory without
    requiring the user to run the app twice or authenticate first.

    Idempotent — only creates files/dirs that are missing; never overwrites.

    Files / directories created if missing:
      <install_dir>/
        logs/                            ← app_logger writes timetracker.log here
        updates/                         ← UpdateManager stages downloads here
        uninstall.sh                     ← end-user uninstall script
      ~/.config/autostart/timetracker.desktop  ← XDG autostart entry
      <install_dir>/.first_launch_done   ← one-time first-launch notification marker
    """
    import stat as _stat

    # ── 1. Subdirectories ─────────────────────────────────────────────────────
    for sub in ('logs', 'updates'):
        path = os.path.join(install_dir, sub)
        if not os.path.isdir(path):
            try:
                os.makedirs(path, exist_ok=True)
                print(f"[OK] Created directory: {path}")
            except OSError as e:
                print(f"[WARN] Could not create {path}: {e}")

    # ── 2. uninstall.sh ───────────────────────────────────────────────────────
    uninstall_path = os.path.join(install_dir, 'uninstall.sh')
    if not os.path.isfile(uninstall_path):
        try:
            _generate_linux_uninstaller_at_path(uninstall_path, install_dir)
            print(f"[OK] Uninstaller created: {uninstall_path}")
        except Exception as e:
            print(f"[WARN] Could not generate uninstaller: {e}")

    # ── 3. XDG autostart entry ────────────────────────────────────────────────
    autostart_dir = os.path.expanduser('~/.config/autostart')
    autostart_path = os.path.join(autostart_dir, 'timetracker.desktop')
    if not os.path.isfile(autostart_path):
        try:
            os.makedirs(autostart_dir, exist_ok=True)
            content = (
                '[Desktop Entry]\n'
                'Type=Application\n'
                'Name=TimeTracker\n'
                'Comment=Automatic time tracking for JIRA issues\n'
                f'Exec=env APPIMAGE_EXTRACT_AND_RUN=1 APPIMAGE={canonical_appimage} {canonical_appimage}\n'
                'Terminal=false\n'
                'Hidden=false\n'
                'X-GNOME-Autostart-enabled=true\n'
            )
            with open(autostart_path, 'w') as _f:
                _f.write(content)
            os.chmod(autostart_path, 0o644)
            print(f"[OK] Autostart entry created: {autostart_path}")
        except Exception as e:
            print(f"[WARN] Could not write autostart entry: {e}")

    # ── 4. Ensure AppImage is executable ──────────────────────────────────────
    if os.path.isfile(canonical_appimage):
        try:
            current_mode = os.stat(canonical_appimage).st_mode
            if not (current_mode & _stat.S_IXUSR):
                os.chmod(
                    canonical_appimage,
                    current_mode | _stat.S_IXUSR | _stat.S_IXGRP | _stat.S_IXOTH,
                )
                print(f"[OK] Made AppImage executable: {canonical_appimage}")
        except OSError as e:
            print(f"[WARN] Could not chmod AppImage: {e}")

    # ── 5. Enable GNOME AppIndicator extension (live session only) ────────────
    # This runs inside the user's already-running GNOME session, so D-Bus is
    # available — unlike the postinst which has no GNOME session at all.
    _try_enable_gnome_appindicator_extension()

    # ── 6. First-launch notification ──────────────────────────────────────────
    # Show only on the very first run (marker absent).
    # Gives users a visible signal that TimeTracker is running even before the
    # tray icon appears (GNOME may need a shell reload to show the indicator).
    _first_launch_marker = os.path.join(install_dir, '.first_launch_done')
    if not os.path.isfile(_first_launch_marker):
        try:
            _linux_notify(
                'TimeTracker installed',
                'TimeTracker is running in the background. '
                'Look for it in the system tray. '
                'If the tray icon is not visible, log out and back in.',
                urgency='normal',
            )
            with open(_first_launch_marker, 'w') as _mf:
                _mf.write(
                    f"first_launch={datetime.now(timezone.utc).isoformat()}\n"
                )
            print(f"[OK] First-launch marker written: {_first_launch_marker}")
        except Exception as e:
            print(f"[WARN] First-launch notification failed (non-fatal): {e}")


def _cleanup_stale_user_desktop():
    """Remove the user-level .desktop if it points to a missing AppImage.

    When ~/.local/share/TimeTracker/ is deleted (uninstall, manual cleanup) the
    user-level .desktop written by a previous self-install still exists and
    SHADOWS the system .desktop installed by the .deb.  The shadow entry points
    to a non-existent AppImage so double-clicking in the launcher does nothing.

    This function removes the stale entry so the system .desktop (Exec=timetracker
    → /usr/local/bin/timetracker → /opt/timetracker/TimeTracker.AppImage) takes
    effect on the next launch.
    """
    if not sys.platform.startswith('linux'):
        return

    desktop_path = os.path.expanduser('~/.local/share/applications/timetracker.desktop')
    if not os.path.isfile(desktop_path):
        return

    try:
        with open(desktop_path) as _df:
            content = _df.read()
    except OSError:
        return

    # Extract the AppImage path from the Exec line (first /…/*.AppImage token)
    import re as _re_desktop
    match = _re_desktop.search(r'(/[^\s]+\.AppImage)', content)
    if not match:
        return  # No AppImage path in Exec — not our entry format

    appimage_path = match.group(1)
    if os.path.isfile(appimage_path):
        return  # Path exists → entry is valid, leave it alone

    # AppImage path is missing — remove the stale entry
    try:
        os.remove(desktop_path)
        print(f'[INFO] Removed stale user .desktop (AppImage missing: {appimage_path})')
        import subprocess as _sub_db_cleanup
        _sub_db_cleanup.run(
            ['update-desktop-database', os.path.dirname(desktop_path)],
            capture_output=True, timeout=5
        )
    except Exception as _e_cleanup:
        print(f'[WARN] Could not remove stale .desktop: {_e_cleanup}')


def _install_appimage():
    """Handle AppImage first-run install and manual version upgrades on Linux.

    Called by install_application() whenever the process IS_APPIMAGE is True.

    When the user double-clicks a newly-downloaded AppImage whose path differs
    from the canonical install location (~/.local/share/TimeTracker/TimeTracker.AppImage),
    this function:

      1. Terminates any currently-running old instance gracefully.
      2. Copies the .AppImage file to the canonical install path (atomic rename).
      3. Makes the canonical file executable.
      4. Generates a Linux uninstall.sh script.
      5. Relaunches from the canonical location (detached).
      6. Returns False so the caller (run()) exits this installer instance.

    If the app is already running from the canonical location, returns True
    immediately so startup continues normally.

    Note: sys.executable points inside a FUSE mount (/tmp/.mount_*/usr/bin/TimeTracker)
    and cannot be shutil.copy2'd.  We copy the .AppImage FILE on disk (os.environ['APPIMAGE'])
    which is a plain regular file and can be copied safely.
    """
    canonical = os.path.join(get_app_data_dir(), 'TimeTracker.AppImage')
    current_appimage = os.environ.get('APPIMAGE', '')

    # In APPIMAGE_EXTRACT_AND_RUN=1 mode, the AppImage runtime does NOT set
    # $APPIMAGE.  Infer the path from the canonical location on disk or the
    # system .deb copy at /opt/timetracker/.
    if not current_appimage and _APPIMAGE_EXTRACT_MODE:
        if os.path.isfile(canonical):
            current_appimage = canonical
            print(f"[INFO] Extract-and-run mode: inferred AppImage path: {canonical}")
        elif os.path.isfile('/opt/timetracker/TimeTracker.AppImage'):
            current_appimage = '/opt/timetracker/TimeTracker.AppImage'
            print(f"[INFO] Extract-and-run mode: using system AppImage: {current_appimage}")

    # Always clean up any stale user-level .desktop that points to a missing
    # AppImage path.  This can happen when ~/.local/share/TimeTracker/ is deleted
    # (e.g. after uninstall or re-install via .deb) while the user-level .desktop
    # written by a previous self-install still exists.  The stale entry shadows the
    # system .desktop and causes a silent launch failure on double-click.
    _cleanup_stale_user_desktop()

    if not current_appimage:
        # No $APPIMAGE env var and not in extract-and-run mode — dev/test mode.
        print("[INFO] AppImage install: $APPIMAGE not set — skipping install step")
        return True

    try:
        current_norm = os.path.normpath(os.path.realpath(current_appimage))
        canonical_norm = os.path.normpath(os.path.realpath(canonical))
    except OSError:
        current_norm = os.path.normpath(current_appimage)
        canonical_norm = os.path.normpath(canonical)

    if current_norm == canonical_norm:
        # Already running from the canonical install location.
        # Run the scaffold to ensure all expected subdirectories and helper
        # files exist.  This is a no-op after the first successful run, but
        # is essential for fresh .deb installs where postinst only copies the
        # AppImage — no uninstall.sh, logs/, or updates/ are present yet.
        print(f"[INFO] Running from canonical AppImage location: {canonical}")
        _ensure_install_scaffold(get_app_data_dir(), canonical)
        return True

    # Running from a non-canonical path (e.g. ~/Downloads/) — install/upgrade.
    is_upgrade = os.path.exists(canonical)
    if is_upgrade:
        print(f"[INFO] AppImage upgrade detected — replacing {canonical}")
        print(f"       New AppImage: {current_appimage}")
    else:
        print(f"[INFO] First AppImage install — installing to {canonical}")

    # Step 1: Terminate any existing running instance gracefully.
    running_processes = find_running_timetracker_processes()
    if running_processes:
        print(f"[INFO] Found {len(running_processes)} running instance(s) — shutting down...")
        request_graceful_shutdown()
        time.sleep(1)
        terminate_old_version(running_processes, timeout=10)
        clear_shutdown_signal()

    # Step 2: Copy the AppImage file to the canonical install location atomically.
    try:
        import shutil as _shutil_install
        install_dir = get_app_data_dir()
        os.makedirs(install_dir, exist_ok=True)

        tmp = canonical + '.new'
        _shutil_install.copy2(current_appimage, tmp)
        os.chmod(tmp, 0o755)
        os.replace(tmp, canonical)   # atomic rename — no partial state visible
        print(f"[OK] AppImage {'upgraded' if is_upgrade else 'installed'}: {canonical}")
    except Exception as e:
        print(f"[ERROR] AppImage install failed — continuing from current location: {e}")
        import traceback
        traceback.print_exc()
        # Fall back: let the app run from the Downloads path rather than crashing.
        return True

    # Step 3: Create all scaffold files (uninstaller, logs/, updates/,
    # autostart entry, GNOME extension activation, first-launch notification).
    # This also covers what was previously "Step 3b" (.desktop update).
    try:
        _ensure_install_scaffold(get_app_data_dir(), canonical)
    except Exception as e:
        print(f"[WARN] Scaffold generation failed (non-fatal): {e}")

    # Step 4: Relaunch from the canonical location (detached) and exit this instance.
    # Pass APPIMAGE_EXTRACT_AND_RUN=1 so the new instance extracts without FUSE,
    # ensuring it starts reliably even before the FUSE kernel module is active.
    try:
        import subprocess as _sub_install
        _env_relaunch = os.environ.copy()
        _env_relaunch['APPIMAGE_EXTRACT_AND_RUN'] = '1'
        _sub_install.Popen(
            [canonical],
            start_new_session=True,
            stdin=_sub_install.DEVNULL,
            stdout=_sub_install.DEVNULL,
            stderr=_sub_install.DEVNULL,
            env=_env_relaunch,
        )
        print(f"[INFO] New instance launched from {canonical}. Exiting installer.")
    except Exception as e:
        print(f"[ERROR] Could not launch installed AppImage: {e}")
        import traceback
        traceback.print_exc()
        # Fall back: keep running from the current path.
        return True

    return False  # Signal run() to call sys.exit(0) for this installer instance.


def install_application():
    r"""
    Self-install the application to %LOCALAPPDATA%\TimeTracker\
    Handles both fresh installation and updates (replacing old version).

    Returns:
        bool: True if app should continue running, False if it should exit (restart from new location)
    """
    if not getattr(sys, 'frozen', False):
        # Running as script (development mode) - skip installation
        print("[INFO] Running in development mode - skipping self-installation")
        return True

    # AppImages are self-contained — sys.executable points inside a FUSE mount
    # (/tmp/.mount_*/usr/bin/TimeTracker) and cannot be shutil.copy2'd.
    # _install_appimage() copies the .AppImage FILE on disk instead, which is a
    # plain regular file.  It handles: first-run install, manual version upgrade
    # (user double-clicks a new AppImage), and canonical-path enforcement so that
    # auto-update and autostart always target the stable canonical location.
    if IS_APPIMAGE:
        return _install_appimage()

    # Check if already running from install location
    if is_running_from_install_location():
        print("[OK] Running from installed location")
        return True

    current_exe = get_app_executable_path()
    install_dir = get_app_data_dir()
    installed_exe = get_installed_exe_path()

    # Check if this is a fresh install or an update
    is_update = os.path.exists(installed_exe)

    if is_update:
        print("")
        print("=" * 50)
        print("  UPDATE DETECTED")
        print("=" * 50)
        print("")
        print(f"  Updating Time Tracker...")
        print(f"  From: {current_exe}")
        print(f"  To:   {installed_exe}")
        print("")
    else:
        print(f"[INFO] First run detected - installing application...")
        print(f"       From: {current_exe}")
        print(f"       To:   {installed_exe}")

    try:
        import shutil
        import subprocess

        # If updating, handle the old version
        if is_update:
            # Step 1: Find any running instances
            running_processes = find_running_timetracker_processes()

            if running_processes:
                print(f"[INFO] Found {len(running_processes)} running instance(s)")
                print("")
                print("  Closing old version automatically...")
                print("")

                # Step 2: Request graceful shutdown via signal file
                request_graceful_shutdown()

                # Give the app a moment to see the signal
                time.sleep(1)

                # Step 3: Terminate old version (graceful first, then force)
                if not terminate_old_version(running_processes, timeout=10):
                    print("[ERROR] Could not close old version")
                    print("[INFO] Please close Time Tracker manually and try again")
                    input("Press Enter to exit...")
                    return False

                # Clean up shutdown signal
                clear_shutdown_signal()

            # Step 4: Wait for the exe file to be unlocked
            if not wait_for_file_unlock(installed_exe, max_attempts=20, delay=0.5):
                print("[ERROR] Could not access the installation file")
                print("[INFO] The old version may still be running")
                print("[INFO] Please close it manually and try again")
                input("Press Enter to exit...")
                return False

        # Step 5: Copy the executable to install location
        # Use a temporary file first to ensure atomic replacement
        temp_exe = installed_exe + '.new'
        try:
            shutil.copy2(current_exe, temp_exe)

            # If old version exists, remove it first
            if os.path.exists(installed_exe):
                os.remove(installed_exe)

            # Rename temp to final
            os.rename(temp_exe, installed_exe)
            print(f"[OK] Application {'updated' if is_update else 'installed'}: {installed_exe}")

        except Exception as copy_error:
            # Clean up temp file if it exists
            if os.path.exists(temp_exe):
                try:
                    os.remove(temp_exe)
                except:
                    pass
            raise copy_error

        # Generate/update uninstaller in install location
        uninstall_path = os.path.join(install_dir, 'uninstall.bat')
        _generate_uninstaller_at_path(uninstall_path, install_dir)
        if not is_update:
            print(f"[OK] Uninstaller created: {uninstall_path}")

        # Start the installed version
        print("[INFO] Starting application...")
        subprocess.Popen([installed_exe], creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)

        # Show message to user
        print("")
        print("=" * 50)
        if is_update:
            print("  UPDATE COMPLETE!")
        else:
            print("  INSTALLATION COMPLETE!")
        print("=" * 50)
        print("")
        print(f"  Application {'updated' if is_update else 'installed'} at:")
        print(f"  {install_dir}")
        print("")
        print("  The application is now starting.")
        print("  You can delete the downloaded file if you wish.")
        print("")
        print("=" * 50)

        # Exit this instance (the new one will continue)
        return False

    except PermissionError as e:
        print(f"[ERROR] Permission denied: {e}")
        print("[INFO] The old version may still be running or locked")
        print("[INFO] Please close Time Tracker and try again")
        import traceback
        traceback.print_exc()
        input("Press Enter to exit...")
        return False

    except Exception as e:
        print(f"[ERROR] {'Update' if is_update else 'Installation'} failed: {e}")
        print("[INFO] Continuing to run from current location...")
        import traceback
        traceback.print_exc()
        return True


def create_update_script(app_data_dir, current_pid, staged_exe, installed_exe):
    """Create a detached batch script that atomically applies a staged update."""
    updates_dir = os.path.join(app_data_dir, 'updates')
    os.makedirs(updates_dir, exist_ok=True)

    updater_script = os.path.join(updates_dir, 'apply_update.bat')
    backup_exe = installed_exe + '.bak'
    install_dir = os.path.dirname(installed_exe)
    update_log = os.path.join(updates_dir, 'update_install.log')

    script_lines = [
        '@echo off',
        'setlocal enableextensions enabledelayedexpansion',
        f'set "LOG_FILE={update_log}"',
        'echo ===============================================>>"%LOG_FILE%"',
        'echo [%DATE% %TIME%] Update apply script started>>"%LOG_FILE%"',
        f'echo Staged: {staged_exe}>>"%LOG_FILE%"',
        f'echo Target: {installed_exe}>>"%LOG_FILE%"',
        '',
        'REM === Phase 1: Wait briefly for old process, then force-kill ===',
        f'echo [INFO] Waiting up to 5s for PID {current_pid} to exit...>>"%LOG_FILE%"',
        'set /a WAIT_COUNT=0',
        ':wait_loop',
        f'tasklist /FI "PID eq {current_pid}" /FI "IMAGENAME eq TimeTracker.exe" 2>nul | find /I "TimeTracker.exe" >nul 2>&1',
        'if errorlevel 1 goto :pid_gone',
        'set /a WAIT_COUNT+=1',
        'if !WAIT_COUNT! GEQ 5 goto :force_kill',
        'timeout /t 1 /nobreak >nul',
        'goto :wait_loop',
        '',
        ':force_kill',
        f'echo [WARN] PID {current_pid} still alive after 5s — force killing.>>"%LOG_FILE%"',
        f'taskkill /F /PID {current_pid} >nul 2>&1',
        'REM Also kill by name in case PID-based kill missed child processes',
        'taskkill /F /IM TimeTracker.exe >nul 2>&1',
        'timeout /t 2 /nobreak >nul',
        '',
        ':pid_gone',
        'echo [INFO] Old process terminated.>>"%LOG_FILE%"',
        '',
        'REM === Phase 2: Verify staged file exists ===',
        f'if not exist "{staged_exe}" (',
        '    echo [ERROR] Staged update file is missing.>>"%LOG_FILE%"',
        '    goto :cleanup',
        ')',
        '',
        'REM === Phase 3: Replace executable (retry up to 15 times) ===',
        'for /L %%i in (1,1,15) do (',
        '    echo [INFO] Replace attempt %%i...>>"%LOG_FILE%"',
        f'    if exist "{backup_exe}" del /F /Q "{backup_exe}" >nul 2>&1',
        f'    if exist "{installed_exe}" move /Y "{installed_exe}" "{backup_exe}" >nul 2>&1',
        f'    copy /Y "{staged_exe}" "{installed_exe}" >nul 2>&1',
        f'    if exist "{installed_exe}" goto :launch_new',
        '    echo [WARN] Replace attempt %%i failed — retrying...>>"%LOG_FILE%"',
        '    timeout /t 1 /nobreak >nul',
        ')',
        'echo [ERROR] Could not replace executable after 15 retries.>>"%LOG_FILE%"',
        'REM Rollback: restore old exe from backup so user is not left with nothing',
        f'if exist "{backup_exe}" move /Y "{backup_exe}" "{installed_exe}" >nul 2>&1',
        f'if exist "{installed_exe}" (',
        f'    echo [INFO] Rolled back to previous version.>>"%LOG_FILE%"',
        f'    start "" /D "{install_dir}" "{installed_exe}"',
        ')',
        'goto :cleanup',
        '',
        'REM === Phase 4: Launch updated executable ===',
        ':launch_new',
        'echo [OK] Executable replaced successfully.>>"%LOG_FILE%"',
        'echo [INFO] Launching updated executable...>>"%LOG_FILE%"',
        f'start "" /D "{install_dir}" "{installed_exe}"',
        '',
        ':cleanup',
        f'if exist "{staged_exe}" del /F /Q "{staged_exe}" >nul 2>&1',
        f'if exist "{backup_exe}" del /F /Q "{backup_exe}" >nul 2>&1',
        'echo [INFO] Update apply script finished.>>"%LOG_FILE%"',
        'del "%~f0"',
        'endlocal',
    ]

    with open(updater_script, 'w', encoding='utf-8') as f:
        f.write('\n'.join(script_lines) + '\n')

    return updater_script


def _extract_appimage_from_deb(deb_path, output_path):
    """Extract TimeTracker.AppImage from a .deb package without root or dpkg.

    A .deb file is an `ar` archive whose entries include:
      debian-binary   — version string
      control.tar.*   — package metadata
      data.tar.*      — the actual filesystem (xz, gz, or zst compressed)

    This function parses the ar format in pure Python (stdlib only), decompresses
    the data tarball, and extracts the AppImage entry directly to output_path.
    No external tools, no root, no dpkg required.
    """
    import io
    import struct

    AR_MAGIC = b'!<arch>\n'
    ENTRY_HEADER_SIZE = 60

    def _read_ar_entries(f):
        magic = f.read(8)
        if magic != AR_MAGIC:
            raise ValueError('Not a valid .deb — bad ar magic header')
        while True:
            hdr = f.read(ENTRY_HEADER_SIZE)
            if not hdr:
                break
            if len(hdr) < ENTRY_HEADER_SIZE:
                break
            name = hdr[0:16].rstrip(b' /').decode('ascii', errors='replace')
            size = int(hdr[48:58].rstrip(b' '))
            data = f.read(size)
            if size % 2:  # ar entries are padded to even byte boundaries
                f.read(1)
            yield name, data

    with open(deb_path, 'rb') as f:
        for name, data in _read_ar_entries(f):
            if not name.startswith('data.tar'):
                continue
            # Decompress the data archive (xz is most common on modern Ubuntu)
            import tarfile
            if name.endswith('.xz'):
                import lzma
                raw = lzma.decompress(data)
            elif name.endswith('.gz'):
                import gzip
                raw = gzip.decompress(data)
            elif name.endswith('.zst'):
                try:
                    import zstandard
                    raw = zstandard.ZstdDecompressor().decompress(data)
                except ImportError:
                    # zstandard not bundled — try system dpkg-deb as a fallback.
                    # dpkg-deb --fsys-tarfile streams the data tarball to stdout,
                    # handling any compression format the host dpkg supports.
                    import subprocess as _sub_zst
                    _dpkg = _sub_zst.which('dpkg-deb')
                    if _dpkg:
                        try:
                            _result = _sub_zst.run(
                                [_dpkg, '--fsys-tarfile', deb_path],
                                capture_output=True, timeout=120
                            )
                            if _result.returncode == 0:
                                # dpkg-deb already emits an uncompressed tar stream
                                with tarfile.open(fileobj=io.BytesIO(_result.stdout)) as _tf2:
                                    _member = next(
                                        (m for m in _tf2.getmembers()
                                         if m.name.endswith('TimeTracker.AppImage')),
                                        None
                                    )
                                    if _member is None:
                                        raise ValueError(
                                            'TimeTracker.AppImage not found inside .deb'
                                        )
                                    _src = _tf2.extractfile(_member)
                                    import shutil as _shutil_zst
                                    with open(output_path, 'wb') as _out:
                                        _shutil_zst.copyfileobj(_src, _out)
                                os.chmod(output_path, 0o755)
                                print(f'[INFO] AppImage extracted via dpkg-deb: {output_path}')
                                return
                        except Exception as _dpkg_err:
                            print(f'[WARN] dpkg-deb fallback failed: {_dpkg_err}')
                    raise ValueError(
                        'This .deb uses zstd compression; install the "zstandard" '
                        'Python package or use dpkg >= 1.21.18 on the target system'
                    )
            else:
                raw = data  # uncompressed

            with tarfile.open(fileobj=io.BytesIO(raw)) as tf:
                member = next(
                    (m for m in tf.getmembers() if m.name.endswith('TimeTracker.AppImage')),
                    None
                )
                if member is None:
                    raise ValueError('TimeTracker.AppImage not found inside .deb data archive')
                src = tf.extractfile(member)
                if src is None:
                    raise ValueError('Could not read TimeTracker.AppImage from .deb data archive')
                import shutil as _shutil_deb
                with open(output_path, 'wb') as out:
                    _shutil_deb.copyfileobj(src, out)
            os.chmod(output_path, 0o755)
            print(f'[INFO] AppImage extracted from .deb: {output_path}')
            return

    raise ValueError('data.tar not found in .deb — the package may be corrupt')


def create_linux_update_script(app_data_dir, current_pid, staged_binary, installed_binary):
    """Create a detached shell script that atomically applies a staged Linux update.

    Mirrors the Windows create_update_script() bat logic:
      1. Wait up to 5 s for current process to exit, then SIGKILL it.
      2. Verify the staged binary exists.
      3. Replace the installed binary (up to 15 retries), making it executable.
      4. Update the XDG autostart entry to point to the (canonical) installed binary.
      5. Relaunch the new binary detached.
      6. Clean up staged file + self-delete the script.
    """
    updates_dir = os.path.join(app_data_dir, 'updates')
    os.makedirs(updates_dir, exist_ok=True)

    updater_script = os.path.join(updates_dir, 'apply_update.sh')
    backup_binary = installed_binary + '.bak'
    install_dir = os.path.dirname(installed_binary)
    update_log = os.path.join(updates_dir, 'update_install.log')
    autostart_dir = os.path.join(os.path.expanduser('~'), '.config', 'autostart')
    autostart_file = os.path.join(autostart_dir, 'timetracker.desktop')

    script = f"""#!/bin/bash
# Time Tracker Linux Auto-Updater
# Auto-generated — do not edit.
set -e

LOG="{update_log}"
STAGED="{staged_binary}"
INSTALLED="{installed_binary}"
BACKUP="{backup_binary}"
INSTALL_DIR="{install_dir}"
OLD_PID={current_pid}

log() {{ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }}

log "=== Update apply script started ==="
log "Staged:    $STAGED"
log "Installed: $INSTALLED"

# === Phase 1: Wait for the old process to exit, then force-kill ===
log "Waiting up to 5s for PID $OLD_PID to exit..."
for i in $(seq 1 5); do
    kill -0 "$OLD_PID" 2>/dev/null || {{ log "PID $OLD_PID exited."; break; }}
    sleep 1
done
if kill -0 "$OLD_PID" 2>/dev/null; then
    log "PID $OLD_PID still alive — force killing."
    kill -9 "$OLD_PID" 2>/dev/null || true
    sleep 2
fi

# === Phase 2: Verify staged file ===
if [ ! -f "$STAGED" ]; then
    log "ERROR: staged binary missing — aborting."
    exit 1
fi

# === Phase 3: Replace binary (up to 15 retries) ===
REPLACED=0
for i in $(seq 1 15); do
    log "Replace attempt $i..."
    rm -f "$BACKUP" 2>/dev/null || true
    [ -f "$INSTALLED" ] && mv -f "$INSTALLED" "$BACKUP" 2>/dev/null || true
    cp -f "$STAGED" "$INSTALLED" && chmod +x "$INSTALLED" && {{ REPLACED=1; break; }}
    log "Attempt $i failed — retrying..."
    sleep 1
done

if [ "$REPLACED" -eq 0 ]; then
    log "ERROR: could not replace binary after 15 retries — rolling back."
    [ -f "$BACKUP" ] && mv -f "$BACKUP" "$INSTALLED" && log "Rolled back to previous version."
    [ -f "$INSTALLED" ] && nohup "$INSTALLED" >/dev/null 2>&1 &
    rm -f "$STAGED" "$BACKUP" "$0" 2>/dev/null || true
    exit 1
fi

# === Phase 4: Update XDG autostart entry ===
# Always point autostart at the canonical installed binary so it survives
# reboots even if the user has since deleted the original Downloads AppImage.
mkdir -p "{autostart_dir}" 2>/dev/null || true
printf '[Desktop Entry]\\nType=Application\\nName=TimeTracker\\nComment=Automatic time tracking for JIRA\\nExec=%s\\nTerminal=false\\nHidden=false\\nX-GNOME-Autostart-enabled=true\\n' "$INSTALLED" > "{autostart_file}" 2>/dev/null \\
    && log "Autostart entry updated: $INSTALLED" \\
    || log "WARN: could not update autostart entry"

# === Phase 5: Launch updated binary ===
log "Binary replaced. Launching new version..."
nohup "$INSTALLED" >/dev/null 2>&1 &
disown

# === Phase 6: Cleanup ===
rm -f "$STAGED" "$BACKUP" 2>/dev/null || true
log "Update complete."
rm -f "$0"
"""
    with open(updater_script, 'w') as f:
        f.write(script)
    os.chmod(updater_script, 0o755)
    return updater_script


class UpdateManager:
    """Manages background download and installation of desktop app updates."""

    def __init__(self, app_data_dir, current_version, on_status_change=None, on_apply_update=None):
        self.app_data_dir = app_data_dir
        self.current_version = current_version
        self.state = 'idle'
        self.download_progress = 0.0
        self.downloaded_bytes = 0
        self.total_bytes = 0
        self.update_info = None
        self.download_path = None
        self.last_error = None
        self._download_thread = None
        self._cancel_event = threading.Event()
        self._lock = threading.Lock()
        self._on_status_change = on_status_change
        self._on_apply_update = on_apply_update
        
        # Automatic retry for failed downloads
        self._last_download_attempt = 0
        self._download_retry_interval = 30 * 60  # 30 minutes

        # Set to True when a bundle (.deb / .tar.gz) has already had its
        # checksum verified during download, before extraction.  Prevents a
        # false 'checksum mismatch' in apply_update() where the staged file is
        # an extracted AppImage (different hash from the original bundle).
        self._bundle_checksum_verified = False

    def _set_state(self, new_state, error=None):
        self.state = new_state
        self.last_error = error
        if callable(self._on_status_change):
            try:
                self._on_status_change(self.get_status())
            except Exception as e:
                print(f"[WARN] UpdateManager status callback failed: {e}")

    def get_status(self):
        return {
            'state': self.state,
            'progress': self.download_progress,
            'downloaded_bytes': self.downloaded_bytes,
            'total_bytes': self.total_bytes,
            'update_info': self.update_info,
            'download_path': self.download_path,
            'error': self.last_error
        }

    def load_staged_update_if_exists(self):
        """Restore staged update state after app restart."""
        updates_dir = os.path.join(self.app_data_dir, 'updates')
        if not os.path.exists(updates_dir):
            return False

        if IS_APPIMAGE:
            _ext = '.AppImage'
        elif sys.platform.startswith('linux'):
            _ext = '.bin'
        else:
            _ext = '.exe'
        candidates = []
        for name in os.listdir(updates_dir):
            if not (name.startswith('TimeTracker_v') and name.endswith(_ext)):
                continue
            full_path = os.path.join(updates_dir, name)
            if os.path.isfile(full_path):
                candidates.append(full_path)

        if not candidates:
            return False

        staged_path = max(candidates, key=os.path.getmtime)
        staged_name = os.path.basename(staged_path)
        version = staged_name.replace('TimeTracker_v', '').replace(_ext, '')

        self.download_path = staged_path
        self.update_info = {
            'latest_version': version,
            'download_url': None,
            'checksum': None,
            'is_mandatory': False,
            'release_notes': 'A previously downloaded update is ready to install.'
        }
        self.download_progress = 1.0
        self.downloaded_bytes = 0
        self.total_bytes = 0
        self._set_state('ready')
        return True

    def check_and_download(self, update_info):
        """Start background download for a newer version."""
        if not update_info or not update_info.get('update_available'):
            return False

        latest_version = update_info.get('latest_version')
        download_url = update_info.get('download_url')
        if not latest_version or not download_url:
            return False

        with self._lock:
            if self.state == 'downloading':
                existing = (self.update_info or {}).get('latest_version')
                if existing == latest_version:
                    return False

            if self.state in ('ready', 'mandatory_ready'):
                existing = (self.update_info or {}).get('latest_version')
                if existing == latest_version and self.download_path and os.path.exists(self.download_path):
                    return False

            self._cancel_event.clear()
            self.update_info = update_info
            self.download_path = None
            self.download_progress = 0.0
            self.downloaded_bytes = 0
            self.total_bytes = int(update_info.get('file_size_bytes') or 0)

            self._set_state('checking')
            self._set_state('downloading')
            
            # Record download attempt time for retry logic
            self._last_download_attempt = time.time()
            
            self._download_thread = threading.Thread(target=self._download_worker, daemon=True)
            self._download_thread.start()
            return True

    def _download_worker(self):
        version = self.update_info.get('latest_version', 'unknown')
        download_url = self.update_info.get('download_url')
        expected_checksum = self.update_info.get('checksum', '')
        expected_size = int(self.update_info.get('file_size_bytes') or 0)

        updates_dir = os.path.join(self.app_data_dir, 'updates')
        os.makedirs(updates_dir, exist_ok=True)

        # Detect whether the download URL points to a bundle format.
        # Both .deb and .tar.gz are transparently unpacked to extract the
        # .AppImage, so the rest of the update pipeline is unchanged.
        url_lower = (download_url or '').lower()
        is_targz = url_lower.endswith('.tar.gz') or url_lower.endswith('.tgz')
        is_deb   = url_lower.endswith('.deb')
        is_bundle = (is_targz or is_deb) and sys.platform.startswith('linux')

        if IS_APPIMAGE or is_bundle:
            _ext = '.AppImage'
        elif sys.platform.startswith('linux'):
            _ext = '.bin'
        else:
            _ext = '.exe'

        # Temp path reflects the actual downloaded format.
        if is_deb:
            _dl_ext = '.deb'
        elif is_targz:
            _dl_ext = '.tar.gz'
        else:
            _dl_ext = _ext

        temp_path   = os.path.join(updates_dir, f"TimeTracker_v{version}{_dl_ext}.tmp")
        final_path  = os.path.join(updates_dir, f"TimeTracker_v{version}{_ext}")
        bundle_path = os.path.join(updates_dir, f"TimeTracker_v{version}{_dl_ext}")
        tar_path    = bundle_path  # kept for cleanup compatibility

        for stale in (temp_path, final_path, bundle_path):
            if os.path.exists(stale):
                try:
                    os.remove(stale)
                except Exception:
                    pass

        try:
            response = requests.get(download_url, stream=True, timeout=(10, 30))
            response.raise_for_status()
            server_content_len = 0
            content_len = response.headers.get('Content-Length')
            if content_len and content_len.isdigit() and int(content_len) > 0:
                server_content_len = int(content_len)
                self.total_bytes = server_content_len
            elif expected_size > 0:
                self.total_bytes = expected_size

            self.downloaded_bytes = 0
            with open(temp_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if self._cancel_event.is_set():
                        self._set_state('idle')
                        return
                    if not chunk:
                        continue
                    f.write(chunk)
                    self.downloaded_bytes += len(chunk)
                    if self.total_bytes > 0:
                        self.download_progress = min(1.0, self.downloaded_bytes / self.total_bytes)

            if self._cancel_event.is_set():
                self._set_state('idle')
                return

            # First trust transport-level size from the file host itself.
            if server_content_len > 0 and self.downloaded_bytes != server_content_len:
                raise ValueError(
                    f"Downloaded size mismatch from server: expected={server_content_len}, actual={self.downloaded_bytes}"
                )

            # API metadata can be stale during release rollouts; do not hard-fail
            # solely on metadata mismatch when checksum is available.
            if expected_size > 0 and self.downloaded_bytes != expected_size:
                if expected_checksum:
                    print(
                        f"[WARN] Update metadata size mismatch: api_expected={expected_size}, "
                        f"actual={self.downloaded_bytes}. Continuing with checksum verification."
                    )
                else:
                    raise ValueError(
                        f"Downloaded size mismatch: expected={expected_size}, actual={self.downloaded_bytes}"
                    )

            if not verify_download_checksum(temp_path, expected_checksum):
                raise ValueError('Checksum verification failed')

            if is_bundle:
                # The checksum above was verified against the bundle (.deb /
                # .tar.gz).  After extraction the staged file is an AppImage
                # whose hash differs from the bundle — flag this so apply_update
                # knows not to re-verify against the bundle checksum.
                self._bundle_checksum_verified = True
                # Extract the AppImage from the bundle (.deb or .tar.gz).
                os.replace(temp_path, bundle_path)
                if is_deb:
                    print(f'[INFO] Extracting AppImage from .deb: {bundle_path}')
                    _extract_appimage_from_deb(bundle_path, final_path)
                else:
                    import tarfile
                    print(f'[INFO] Extracting AppImage from tar.gz: {bundle_path}')
                    with tarfile.open(bundle_path, 'r:gz') as tf:
                        appimage_member = next(
                            (m for m in tf.getmembers()
                             if m.name.endswith('.AppImage') and not m.name.startswith('/')),
                            None
                        )
                        if appimage_member is None:
                            raise ValueError('No .AppImage found inside the tar.gz bundle')
                        appimage_member.name = os.path.basename(appimage_member.name)
                        tf.extract(appimage_member, path=updates_dir)
                        extracted = os.path.join(updates_dir, appimage_member.name)
                    os.chmod(extracted, 0o755)
                    os.replace(extracted, final_path)
                os.remove(bundle_path)
                print(f'[INFO] AppImage staged for install: {final_path}')
            else:
                os.replace(temp_path, final_path)

            self.download_path = final_path
            self.download_progress = 1.0

            if self.update_info.get('is_mandatory', False):
                self._set_state('mandatory_ready')
            else:
                self._set_state('ready')

        except Exception as e:
            self._set_state('failed', error=str(e))
            print(f"[WARN] Update download failed: {e}")
            
            # Notify user about download failure
            if WINOTIFY_AVAILABLE:
                try:
                    error_msg = str(e)[:100]  # Truncate to 100 chars
                    notification = Notification(
                        app_id="Time Tracker",
                        title="Update Download Failed",
                        msg=f"Failed to download update: {error_msg}\n\nWill retry automatically.",
                        duration="long"
                    )
                    notification.set_audio(audio.Default, loop=False)
                    notification.show()
                except Exception as notify_error:
                    # Don't let notification failure break the app
                    print(f"[WARN] Failed to show download failure notification: {notify_error}")
            else:
                _linux_notify("Update Download Failed",
                              f"Failed to download update: {str(e)[:100]}. Will retry automatically.",
                              urgency="normal")
        finally:
            for _cleanup in (temp_path, tar_path):
                if os.path.exists(_cleanup):
                    try:
                        os.remove(_cleanup)
                    except Exception:
                        pass

    def defer_update(self):
        if self.state in ('ready', 'mandatory_ready'):
            if self.state == 'mandatory_ready':
                return False
            self._set_state('deferred')
            return True
        return False

    def cancel_download(self):
        if self.state != 'downloading':
            return False
        self._cancel_event.set()
        return True

    def should_retry_download(self):
        """Check if we should retry a failed download (30-minute interval)."""
        if self.state != 'failed':
            return False
        
        if self._last_download_attempt == 0:
            return False
        
        time_since_last_attempt = time.time() - self._last_download_attempt
        
        if time_since_last_attempt >= self._download_retry_interval:
            print(f"[INFO] Retrying failed download after {int(time_since_last_attempt / 60)} minutes")
            return True
        
        return False

    def apply_update(self):
        """Apply a previously staged update and request app shutdown."""
        if self.state not in ('ready', 'mandatory_ready', 'deferred'):
            return False
        if not self.download_path or not os.path.exists(self.download_path):
            self._set_state('failed', error='Staged update missing')
            return False

        expected_checksum = (self.update_info or {}).get('checksum')
        # Skip re-verification when the staged file is an AppImage that was
        # extracted from a .deb/.tar.gz bundle: the bundle itself was already
        # verified during download, and the extracted AppImage naturally has a
        # different SHA256 than the original bundle archive.
        if expected_checksum and not self._bundle_checksum_verified:
            if not verify_download_checksum(self.download_path, expected_checksum):
                self._set_state('failed', error='Staged update checksum mismatch')
                return False

        try:
            # ── Linux path ──────────────────────────────────────────────────
            if sys.platform.startswith('linux'):
                if IS_APPIMAGE:
                    installed_binary = get_linux_installed_appimage_path()
                else:
                    installed_binary = get_linux_installed_binary_path()
                updater_script = create_linux_update_script(
                    self.app_data_dir,
                    os.getpid(),
                    self.download_path,
                    installed_binary,
                )
                try:
                    updates_dir = os.path.join(self.app_data_dir, 'updates')
                    os.makedirs(updates_dir, exist_ok=True)
                    launcher_log = os.path.join(updates_dir, 'update_launcher.log')
                    with open(launcher_log, 'a') as f:
                        f.write(f"[{datetime.now().isoformat()}] apply_update called (linux)\n")
                        f.write(f"pid={os.getpid()}\n")
                        f.write(f"script={updater_script}\n")
                        f.write(f"staged={self.download_path}\n")
                        f.write(f"installed={installed_binary}\n")
                except Exception as log_err:
                    print(f"[WARN] Could not write update launcher log: {log_err}")

                subprocess.Popen(
                    ['bash', updater_script],
                    start_new_session=True,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                if callable(self._on_apply_update):
                    self._on_apply_update()
                self._set_state('installing')
                return True

            # ── Windows path ────────────────────────────────────────────────
            installed_exe = get_installed_exe_path()
            updater_script = create_update_script(
                self.app_data_dir,
                os.getpid(),
                self.download_path,
                installed_exe
            )

            # Launcher diagnostics help verify the detached updater was invoked.
            try:
                updates_dir = os.path.join(self.app_data_dir, 'updates')
                os.makedirs(updates_dir, exist_ok=True)
                launcher_log = os.path.join(updates_dir, 'update_launcher.log')
                with open(launcher_log, 'a', encoding='utf-8') as f:
                    f.write(f"[{datetime.now().isoformat()}] apply_update called\n")
                    f.write("updater_build_marker=apply_update_r4\n")
                    f.write(f"app_version={APP_VERSION}\n")
                    f.write(f"pid={os.getpid()}\n")
                    f.write(f"script={updater_script}\n")
                    f.write(f"staged={self.download_path}\n")
                    f.write(f"installed={installed_exe}\n")
            except Exception as log_err:
                print(f"[WARN] Could not write update launcher log: {log_err}")

            # CREATE_NEW_PROCESS_GROUP detaches from parent; CREATE_NO_WINDOW
            # prevents cmd.exe from opening a visible console window.
            # Do NOT combine with DETACHED_PROCESS — on some Windows builds
            # that combination still shows a window.
            subprocess.Popen(
                ['cmd.exe', '/d', '/c', updater_script],
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW,
                cwd=os.path.dirname(updater_script),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # Request shutdown immediately after spawning updater to avoid any
            # potential UI callback deadlocks keeping this PID alive.
            if callable(self._on_apply_update):
                self._on_apply_update()
            self._set_state('installing')
            return True

        except Exception as e:
            self._set_state('failed', error=str(e))
            print(f"[ERROR] Failed to apply update: {e}")
            return False

    def auto_apply(self):
        """Automatically apply a downloaded update without user interaction.
        Called by _on_update_manager_state_changed when state transitions
        to 'ready' or 'mandatory_ready'."""
        if self.state not in ('ready', 'mandatory_ready'):
            return False
        return self.apply_update()

def _generate_linux_uninstaller_at_path(uninstall_path, install_dir):
    """Generate an executable uninstall.sh shell script at *uninstall_path*.

    The script:
      1. Kills any running TimeTracker process.
      2. Removes the XDG autostart entry.
      3. Deletes all application data files from *install_dir*.
      4. Self-deletes the install directory once done.
    """
    autostart_file = os.path.join(os.path.expanduser('~'), '.config', 'autostart', 'timetracker.desktop')
    script = f'''#!/bin/bash
# ============================================================================
# Time Tracker - Linux Uninstall Script
# Auto-generated — removes the application and all associated data.
# ============================================================================

echo ""
echo "============================================"
echo " Time Tracker - Uninstaller"
echo "============================================"
echo ""
echo "This will remove Time Tracker and all associated data."
echo ""
echo "The following will be deleted:"
echo "  - Application binary:  {install_dir}/TimeTracker.AppImage"
echo "  - All session/auth data in {install_dir}/"
echo "  - Autostart entry:     {autostart_file}"
echo ""
read -r -p "Are you sure you want to uninstall? (y/N): " CONFIRM
case "$CONFIRM" in
    [yY]|[yY][eE][sS]) ;;
    *)
        echo ""
        echo "Uninstall cancelled."
        exit 0
        ;;
esac

INSTALL_DIR="{install_dir}"

echo ""
echo "[STEP 1/4] Stopping application if running..."

# IMPORTANT: pkill -f TimeTracker matches the full command line of every
# process.  The bash process running THIS script has a cmdline of:
#   bash /home/.../.local/share/TimeTracker/uninstall.sh
# which also contains "TimeTracker", so pkill -f would kill our own shell
# before rm -rf ever runs.  Instead we use pgrep to collect matching PIDs,
# then explicitly exclude $$ (this script's own PID) before killing.
SELF_PID=$$
TT_PIDS=$(pgrep -f TimeTracker 2>/dev/null | grep -v "^${{SELF_PID}}$")

if [ -n "$TT_PIDS" ]; then
    echo "  Sending shutdown signal to TimeTracker process(es)..."
    echo "$TT_PIDS" | xargs kill 2>/dev/null || true
    # Wait up to 5 s for graceful exit
    for i in 1 2 3 4 5; do
        REMAINING=$(pgrep -f TimeTracker 2>/dev/null | grep -v "^${{SELF_PID}}$")
        [ -z "$REMAINING" ] && break
        sleep 1
    done
    # Force-kill any survivors
    SURVIVORS=$(pgrep -f TimeTracker 2>/dev/null | grep -v "^${{SELF_PID}}$")
    if [ -n "$SURVIVORS" ]; then
        echo "  Force-stopping remaining process(es)..."
        echo "$SURVIVORS" | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
    echo "  Application stopped."
else
    echo "  Application was not running."
fi

echo ""
echo "[STEP 2/4] Removing autostart entry..."
AUTOSTART_FILE="{autostart_file}"
if [ -f "$AUTOSTART_FILE" ]; then
    rm -f "$AUTOSTART_FILE"
    echo "  Removed from autostart."
else
    echo "  Was not in autostart."
fi

echo ""
echo "[STEP 3/4] Removing application files..."
for f in TimeTracker.AppImage TimeTracker \\
          time_tracker_auth.json time_tracker_offline.db \\
          time_tracker_consent.json time_tracker_user_cache.json \\
          auth_metadata.json .lock .shutdown_signal; do
    TARGET="$INSTALL_DIR/$f"
    if [ -e "$TARGET" ]; then
        rm -rf "$TARGET"
        echo "  - Removed: $f"
    fi
done
for d in updates screenshots logs; do
    TARGET="$INSTALL_DIR/$d"
    if [ -d "$TARGET" ]; then
        rm -rf "$TARGET"
        echo "  - Removed: $d/"
    fi
done

echo ""
echo "============================================"
echo " Uninstall Complete!"
echo "============================================"
echo ""
echo "Time Tracker has been removed from your system."
echo ""

# Remove the entire install directory including this script.
# On Linux, bash holds an open fd to the script file so deleting the directory
# while the script is still running is safe — the shell keeps reading from the
# already-open fd and the directory entry is removed immediately.
# We do NOT use a background subshell here because when the file manager closes
# the terminal window the background process receives SIGHUP and is killed
# before it can run.
rm -rf "{install_dir}"
echo "  Installation directory removed."
'''
    with open(uninstall_path, 'w') as f:
        f.write(script)
    os.chmod(uninstall_path, 0o755)


def _generate_uninstaller_at_path(uninstall_path, install_dir):
    """Generate uninstall.bat at the specified path"""

    uninstall_script = f'''@echo off
REM ============================================================================
REM Time Tracker - Uninstall Script
REM Removes the application and all associated data
REM ============================================================================

echo.
echo ============================================
echo  Time Tracker - Uninstaller
echo ============================================
echo.

echo This will remove Time Tracker and all associated data.
echo.
echo The following will be deleted:
echo   - Application executable
echo   - OAuth tokens and session data
echo   - Offline screenshot database
echo   - User preferences and consent data
echo   - Windows startup entry
echo.
set /p CONFIRM="Are you sure you want to uninstall? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo.
    echo Uninstall cancelled.
    pause
    exit /b 0
)

echo.
echo [STEP 1/4] Stopping application if running...
taskkill /f /im TimeTracker.exe >nul 2>&1
if %errorlevel%==0 (
    echo   Application stopped.
) else (
    echo   Application was not running.
)

echo.
echo [STEP 2/4] Removing from Windows startup...
reg delete "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v TimeTracker /f >nul 2>&1
if %errorlevel%==0 (
    echo   Removed from startup.
) else (
    echo   Was not in startup.
)

echo.
echo [STEP 3/4] Waiting for application to fully close...
timeout /t 2 /nobreak >nul

echo.
echo [STEP 4/4] Removing application files...

REM Store the install directory path
set "INSTALL_DIR={install_dir}"

REM Delete the executable first
if exist "%INSTALL_DIR%\\TimeTracker.exe" (
    del /f /q "%INSTALL_DIR%\\TimeTracker.exe"
    echo   - Removed: TimeTracker.exe
)

REM Delete data files
if exist "%INSTALL_DIR%\\time_tracker_auth.json" del /f /q "%INSTALL_DIR%\\time_tracker_auth.json"
if exist "%INSTALL_DIR%\\time_tracker_offline.db" del /f /q "%INSTALL_DIR%\\time_tracker_offline.db"
if exist "%INSTALL_DIR%\\time_tracker_consent.json" del /f /q "%INSTALL_DIR%\\time_tracker_consent.json"
if exist "%INSTALL_DIR%\\time_tracker_user_cache.json" del /f /q "%INSTALL_DIR%\\time_tracker_user_cache.json"
echo   - Removed: Application data files

REM Also clean up old TEMP location if exists
if exist "%TEMP%\\time_tracker_auth.json" del /f /q "%TEMP%\\time_tracker_auth.json"
if exist "%TEMP%\\time_tracker_offline.db" del /f /q "%TEMP%\\time_tracker_offline.db"
if exist "%TEMP%\\time_tracker_consent.json" del /f /q "%TEMP%\\time_tracker_consent.json"
if exist "%TEMP%\\time_tracker_user_cache.json" del /f /q "%TEMP%\\time_tracker_user_cache.json"

echo.
echo ============================================
echo  Uninstall Complete!
echo ============================================
echo.
echo Time Tracker has been removed from your system.
echo.
echo This window will close and the uninstaller will
echo delete itself along with the application folder.
echo.
pause

REM Self-delete: remove this batch file and the folder
cd /d "%TEMP%"
rmdir /s /q "%INSTALL_DIR%" 2>nul
'''

    with open(uninstall_path, 'w') as f:
        f.write(uninstall_script)

# ============================================================================
# AUTO-START (REGISTRY) MANAGEMENT
# ============================================================================

APP_NAME = "TimeTracker"
REGISTRY_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"

def add_to_startup():
    """Add application to Windows startup via registry"""
    if sys.platform != 'win32':
        print("[INFO] Auto-start only supported on Windows")
        return False

    try:
        import winreg

        # Prefer the installed path only if it actually exists; otherwise fall back
        # to the current executable path to avoid writing a broken startup entry.
        if getattr(sys, 'frozen', False):
            installed_exe = get_installed_exe_path()
            if installed_exe and os.path.isfile(installed_exe):
                exe_path = installed_exe
            else:
                exe_path = get_app_executable_path()
        else:
            exe_path = get_app_executable_path()

        # Open registry key
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            REGISTRY_PATH,
            0,
            winreg.KEY_SET_VALUE
        )

        # Set the value
        winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, f'"{exe_path}"')
        winreg.CloseKey(key)

        print(f"[OK] Added to Windows startup: {exe_path}")
        return True

    except Exception as e:
        print(f"[ERROR] Failed to add to startup: {e}")
        return False

def remove_from_startup():
    """Remove application from Windows startup"""
    if sys.platform != 'win32':
        return False

    try:
        import winreg

        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            REGISTRY_PATH,
            0,
            winreg.KEY_SET_VALUE
        )

        try:
            winreg.DeleteValue(key, APP_NAME)
            print(f"[OK] Removed from Windows startup")
        except FileNotFoundError:
            print("[INFO] App was not in startup")

        winreg.CloseKey(key)
        return True

    except Exception as e:
        print(f"[ERROR] Failed to remove from startup: {e}")
        return False

def is_in_startup():
    """Check if application is in Windows startup"""
    if sys.platform != 'win32':
        return False

    try:
        import winreg

        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            REGISTRY_PATH,
            0,
            winreg.KEY_READ
        )

        try:
            value, _ = winreg.QueryValueEx(key, APP_NAME)
            winreg.CloseKey(key)
            return True
        except FileNotFoundError:
            winreg.CloseKey(key)
            return False

    except Exception as e:
        return False


# ============================================================================
# LINUX XDG AUTOSTART (equivalent of Windows registry startup entry)
# ============================================================================

_LINUX_AUTOSTART_DIR = os.path.expanduser('~/.config/autostart')
_LINUX_AUTOSTART_FILE = os.path.join(_LINUX_AUTOSTART_DIR, 'timetracker.desktop')


def add_to_linux_autostart():
    """Register the app as an XDG autostart entry so it launches on login.

    Creates ~/.config/autostart/timetracker.desktop pointing to the installed
    binary.  Equivalent of the Windows registry HKCU Run entry.
    """
    if not sys.platform.startswith('linux'):
        return False

    try:
        if IS_APPIMAGE:
            binary_path = get_linux_installed_appimage_path()
        else:
            binary_path = get_linux_installed_binary_path()
            # Fall back to current executable if install binary doesn't exist yet
            if not os.path.isfile(binary_path):
                binary_path = get_app_executable_path()

        os.makedirs(_LINUX_AUTOSTART_DIR, exist_ok=True)
        desktop_content = (
            '[Desktop Entry]\n'
            'Type=Application\n'
            f'Name={APP_NAME}\n'
            'Comment=Automatic time tracking for JIRA\n'
            f'Exec={binary_path}\n'
            'Terminal=false\n'
            'Hidden=false\n'
            'X-GNOME-Autostart-enabled=true\n'
        )
        with open(_LINUX_AUTOSTART_FILE, 'w') as f:
            f.write(desktop_content)
        print(f'[OK] Added to Linux autostart: {binary_path}')
        return True
    except Exception as e:
        print(f'[ERROR] Failed to add to Linux autostart: {e}')
        return False


def remove_from_linux_autostart():
    """Remove the XDG autostart entry."""
    if not sys.platform.startswith('linux'):
        return False
    try:
        if os.path.exists(_LINUX_AUTOSTART_FILE):
            os.remove(_LINUX_AUTOSTART_FILE)
            print('[OK] Removed from Linux autostart')
        return True
    except Exception as e:
        print(f'[ERROR] Failed to remove from Linux autostart: {e}')
        return False


def is_in_linux_autostart():
    """Return True if an XDG autostart entry exists for the app."""
    return os.path.isfile(_LINUX_AUTOSTART_FILE)
# ============================================================================

# Keyring service name for secure credential storage
KEYRING_SERVICE = "TimeTracker"

# Sensitive token keys that should be stored in keyring.
# MUST match auth/secure_storage.py's SENSITIVE_TOKEN_KEYS — that module iterates
# its own copy when LOADING from keyring/encrypted storage, so any key here that is
# missing there would be saved but silently dropped on restart.
SENSITIVE_TOKEN_KEYS = ['access_token', 'refresh_token', 'supabase_token', 'google_refresh_token']

# Windows Credential Manager has a 2560-byte limit per credential (CredWrite API).
# OAuth/JWT tokens often exceed this, causing error 1783 "The stub received bad data".
# We chunk large tokens across multiple keyring entries to work around this limit.
# using base64 encoding to avoid special character issues with Windows Credential Manager.
KEYRING_CHUNK_SIZE = 2000  # Reduced to 2000 to be safe (limit is 2560)


def _keyring_set(service, key, value):
    """Save a value to keyring, base64-encoding and chunking if needed.
    
    Base64 encoding prevents Windows Credential Manager issues with special chars
    in JWT tokens that can cause error 1783 'The stub received bad data'.
    """
    import base64
    import keyring
    # Base64 encode to avoid special character issues
    encoded = base64.b64encode(value.encode('utf-8')).decode('ascii')
    encoded_with_marker = f"__b64__:{encoded}"
    
    if len(encoded_with_marker) <= KEYRING_CHUNK_SIZE:
        keyring.set_password(service, key, encoded_with_marker)
        # Clean up any leftover chunks from previous saves
        for i in range(1, 10):
            try:
                keyring.delete_password(service, f"{key}_chunk{i}")
            except Exception:
                break
    else:
        # Split into chunks (base64 is ASCII-safe, so byte boundaries are fine)
        chunks = []
        for i in range(0, len(encoded), KEYRING_CHUNK_SIZE - 20):  # Leave room for marker
            chunks.append(encoded[i:i + KEYRING_CHUNK_SIZE - 20])
        
        # Store chunk count in the main key
        keyring.set_password(service, key, f"__b64_chunked__:{len(chunks)}")
        for i, chunk in enumerate(chunks):
            keyring.set_password(service, f"{key}_chunk{i+1}", chunk)
        # Clean up extra old chunks beyond current count
        for i in range(len(chunks) + 1, len(chunks) + 10):
            try:
                keyring.delete_password(service, f"{key}_chunk{i}")
            except Exception:
                break


def _keyring_get(service, key):
    """Load a value from keyring, decoding base64 and reassembling chunks if needed."""
    import base64
    import keyring
    value = keyring.get_password(service, key)
    if value is None:
        return None
    
    # Handle base64-encoded chunked values
    if value.startswith("__b64_chunked__:"):
        try:
            num_chunks = int(value.split(":")[1])
        except (ValueError, IndexError):
            # Corrupted chunk marker - clean up and return None
            try:
                keyring.delete_password(service, key)
            except Exception:
                pass
            return None
        parts = []
        for i in range(1, num_chunks + 1):
            chunk = keyring.get_password(service, f"{key}_chunk{i}")
            if chunk is None:
                return None  # Corrupted, missing chunk
            parts.append(chunk)
        encoded = "".join(parts)
        try:
            return base64.b64decode(encoded.encode('ascii')).decode('utf-8')
        except Exception:
            return None
    
    # Handle base64-encoded single values
    if value.startswith("__b64__:"):
        encoded = value[8:]  # Skip "__b64__:" prefix
        try:
            return base64.b64decode(encoded.encode('ascii')).decode('utf-8')
        except Exception:
            return None
    
    # Legacy: handle old chunked format (non-base64)
    if value.startswith("__chunked__:"):
        try:
            num_chunks = int(value.split(":")[1])
        except (ValueError, IndexError):
            # Corrupted chunk marker - clean up and return None
            try:
                keyring.delete_password(service, key)
            except Exception:
                pass
            return None
        parts = []
        for i in range(1, num_chunks + 1):
            chunk = keyring.get_password(service, f"{key}_chunk{i}")
            if chunk is None:
                return None  # Corrupted, missing chunk
            parts.append(chunk)
        return "".join(parts)
    
    # Legacy: plain value (will be re-encoded on next save)
    return value


def _keyring_delete(service, key):
    """Delete a value from keyring, including any chunks."""
    import keyring
    try:
        value = keyring.get_password(service, key)
        if value and (value.startswith("__chunked__:") or value.startswith("__b64_chunked__:")):
            try:
                num_chunks = int(value.split(":")[1])
            except (ValueError, IndexError):
                num_chunks = 0  # Corrupted marker, skip chunk deletion
            for i in range(1, num_chunks + 1):
                try:
                    keyring.delete_password(service, f"{key}_chunk{i}")
                except Exception:
                    pass
        keyring.delete_password(service, key)
    except Exception:
        pass

class AtlassianAuthManager:
    """Manages Atlassian OAuth 3LO flow via AI Server (secure token exchange)"""

    def __init__(self, web_port=51777, store_path=None):
        self.web_port = web_port
        self.client_id = get_env_var('ATLASSIAN_CLIENT_ID', '')
        # SECURITY: client_secret is now on AI Server only, not in desktop app
        self.redirect_uri = f'http://localhost:{web_port}/auth/callback'
        self.authorization_url = 'https://auth.atlassian.com/authorize'

        # Google SSO (non-Jira users). Google requires the loopback IP 127.0.0.1
        # (NOT localhost) for Desktop-app OAuth clients. Client secret lives on
        # the AI server; PKCE protects this public client.
        self.google_client_id = get_env_var('GOOGLE_DESKTOP_CLIENT_ID', '')
        self.google_authorization_url = 'https://accounts.google.com/o/oauth2/v2/auth'
        self.google_redirect_uri = f'http://127.0.0.1:{web_port}/auth/google/callback'
        # Token exchange now goes through AI Server
        self.ai_server_url = get_env_var('AI_SERVER_URL', 'https://forgesync.amzur.com')
        self.store_path = store_path or os.path.join(get_app_data_dir(), 'time_tracker_auth.json')
        self.metadata_path = os.path.join(get_app_data_dir(), 'auth_metadata.json')  # For non-sensitive data

        # Prevents concurrent token refreshes from burning the same refresh_token twice.
        # Atlassian uses token rotation: each refresh invalidates the old refresh_token.
        # Without a lock, two threads racing on an expired token will both send the same
        # refresh_token — the second call arrives after rotation and gets "token invalid".
        self._refresh_lock = threading.Lock()

        # Session resilience: track when the invalid flag was set so it can auto-expire.
        # This prevents a transient outage from permanently killing the session.
        self._refresh_token_invalid = False
        self._refresh_fail_count = 0
        self._refresh_invalid_set_at = 0  # timestamp when _refresh_token_invalid was set
        self._last_refresh_fail_time = 0
        self._last_refresh_error_code = ''

        # Initialize secure storage
        self.secure_storage = SecureTokenStorage(get_app_data_dir())
        self._log_keyring_availability()

        # Migrate from plain-text JSON to secure storage if needed
        self._migrate_from_plaintext()

        # Load tokens (from secure storage)
        self.tokens = self._load_tokens()

        # Which provider authenticated this session: 'atlassian' (default, Jira)
        # or 'google' (non-Jira SSO). Persisted in token metadata so it survives restarts.
        self.auth_provider = self.tokens.get('auth_provider', 'atlassian')

    def _log_keyring_availability(self):
        """Log whether a functional keyring backend is available (Linux diagnostic)."""
        if not KEYRING_AVAILABLE:
            print("[WARN] Python 'keyring' package not installed — tokens stored in encrypted file only")
            return
        try:
            import keyring as _kr
            backend = _kr.get_keyring()
            backend_name = type(backend).__name__
            if 'Fail' in backend_name or 'Null' in backend_name:
                print(f"[WARN] Keyring backend '{backend_name}' is a no-op — "
                      "tokens will use encrypted file fallback. "
                      "On headless Linux, install 'gnome-keyring' or 'pass' and ensure D-Bus is running.")
            else:
                print(f"[INFO] Keyring backend: {backend_name}")
        except Exception as e:
            print(f"[WARN] Could not query keyring backend: {e} — tokens will use encrypted file fallback")

    def _migrate_from_plaintext(self):
        """Migrate sensitive tokens from plain-text JSON to secure storage.
        
        This handles migration from the old insecure system that stored tokens
        in plaintext JSON when keyring was unavailable.
        """
        try:
            # Check if old JSON file exists
            if not os.path.exists(self.store_path):
                return

            # Read the old file BEFORE calling migrate_from_plaintext(), which
            # deletes it.  This preserves non-sensitive metadata (including
            # supabase_token_expires_at) so it can be written to auth_metadata.json.
            old_data = {}
            try:
                with open(self.store_path, 'r') as f:
                    old_data = json.load(f)
            except Exception as read_err:
                print(f"[WARN] Could not read old token file before migration: {read_err}")

            # Use SecureTokenStorage's migration method (deletes store_path on success)
            migrated = self.secure_storage.migrate_from_plaintext(self.store_path)
            
            if migrated:
                print("[OK] Migrated tokens from plaintext to secure storage")
                
                # Save non-sensitive metadata (e.g. supabase_token_expires_at, expires_at)
                # to auth_metadata.json using the data we read before deletion.
                try:
                    metadata = {k: v for k, v in old_data.items() if k not in SENSITIVE_TOKEN_KEYS}
                    if metadata:
                        with open(self.metadata_path, 'w') as f:
                            json.dump(metadata, f)
                        print(f"[OK] Saved non-sensitive metadata separately (migration)")
                except Exception as meta_err:
                    print(f"[WARN] Could not save metadata during migration: {meta_err}")

        except Exception as e:
            print(f"[WARN] Migration to secure storage failed: {e}")

    def _load_tokens(self):
        """Load tokens from secure storage (keyring or encrypted file).
        
        Sensitive tokens are loaded from SecureTokenStorage (keyring → encrypted fallback).
        Non-sensitive metadata (oauth_state, code_verifier) is loaded from metadata JSON.
        """
        tokens = {}

        # Load non-sensitive metadata from JSON file
        try:
            if os.path.exists(self.metadata_path):
                with open(self.metadata_path, 'r') as f:
                    tokens = json.load(f)
                    print(f"[OK] Loaded metadata from {self.metadata_path}")
        except Exception as e:
            print(f"[WARN] Failed to load metadata: {e}")

        # Load sensitive tokens from secure storage
        try:
            secure_tokens = self.secure_storage.load_tokens()
            if secure_tokens:
                tokens.update(secure_tokens)
                print(f"[OK] Loaded {len(secure_tokens)} tokens from secure storage")
        except Exception as e:
            print(f"[ERROR] Failed to load from secure storage: {e}")

        return tokens

    def _save_tokens(self):
        """Save tokens to secure storage (keyring or encrypted file).
        
        Sensitive tokens (access_token, refresh_token, supabase_token) are saved to
        SecureTokenStorage (keyring with automatic encrypted fallback).
        Non-sensitive metadata (oauth_state, code_verifier) is saved to JSON.
        
        SECURITY NOTE: No plaintext backup for sensitive tokens.
        """
        # Separate sensitive and non-sensitive data
        sensitive_data = {}
        metadata = {}

        for key, value in self.tokens.items():
            if key in SENSITIVE_TOKEN_KEYS:
                sensitive_data[key] = value
            else:
                metadata[key] = value

        # Save sensitive tokens to secure storage (keyring → encrypted fallback)
        if sensitive_data:
            try:
                self.secure_storage.save_tokens(sensitive_data)
                print(f"[OK] Saved {len(sensitive_data)} tokens to secure storage")
            except SecurityError as e:
                print(f"[ERROR] Cannot save tokens securely: {e}")
                # This is a critical error - do not fall back to plaintext
                raise
            except Exception as e:
                print(f"[ERROR] Failed to save tokens: {e}")
                raise

        # Save non-sensitive metadata to JSON file
        if metadata:
            try:
                with open(self.metadata_path, 'w') as f:
                    json.dump(metadata, f)
                print(f"[OK] Saved metadata to {self.metadata_path}")
            except Exception as e:
                print(f"[WARN] Failed to save metadata: {e}")
    
    def get_auth_url(self):
        """Generate Atlassian OAuth authorization URL with PKCE"""
        if not self.client_id:
            raise ValueError("ATLASSIAN_CLIENT_ID not configured")

        # Generate state for CSRF protection
        state = secrets.token_urlsafe(32)

        # PKCE: Generate code_verifier (43-128 characters, URL-safe)
        code_verifier = secrets.token_urlsafe(64)

        # PKCE: Create code_challenge = BASE64URL(SHA256(code_verifier))
        code_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode()).digest()
        ).decode().rstrip('=')

        # Store state and code_verifier for callback verification
        self.tokens['oauth_state'] = state
        self.tokens['code_verifier'] = code_verifier
        self._save_tokens()

        print(f"[OK] PKCE code_challenge generated (S256)")

        params = {
            'audience': 'api.atlassian.com',
            'client_id': self.client_id,
            'scope': 'read:me read:jira-work write:jira-work offline_access',
            'redirect_uri': self.redirect_uri,
            'state': state,
            'response_type': 'code',
            'prompt': 'consent',
            'code_challenge': code_challenge,
            'code_challenge_method': 'S256'
        }

        auth_url = f"{self.authorization_url}?{urllib.parse.urlencode(params)}"
        return auth_url

    def get_google_auth_url(self):
        """Generate Google OAuth authorization URL (Desktop app client) with PKCE.
        Used for non-Jira employees who sign in with their company Google account."""
        if not self.google_client_id:
            raise ValueError("GOOGLE_DESKTOP_CLIENT_ID not configured")

        state = secrets.token_urlsafe(32)
        code_verifier = secrets.token_urlsafe(64)
        code_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(code_verifier.encode()).digest()
        ).decode().rstrip('=')

        self.tokens['google_oauth_state'] = state
        self.tokens['google_code_verifier'] = code_verifier
        self._save_tokens()

        params = {
            'client_id': self.google_client_id,
            'redirect_uri': self.google_redirect_uri,
            'response_type': 'code',
            'scope': 'openid email profile',
            'access_type': 'offline',   # request a refresh token
            'prompt': 'consent',        # ensure a refresh token is returned
            'state': state,
            'code_challenge': code_challenge,
            'code_challenge_method': 'S256'
        }
        return f"{self.google_authorization_url}?{urllib.parse.urlencode(params)}"

    def handle_google_callback(self, code, state):
        """Exchange a Google OAuth code (PKCE) for a Supabase JWT via the AI server.
        On success, marks this session as a Google (non-Jira) session and stores the
        Supabase token + Google refresh token. Returns the AI server's response dict."""
        if state != self.tokens.get('google_oauth_state'):
            raise ValueError("Invalid state parameter - possible CSRF attack")
        code_verifier = self.tokens.get('google_code_verifier')
        if not code_verifier:
            raise ValueError("Missing code_verifier - PKCE flow was not properly initiated")

        print("[INFO] Exchanging Google OAuth code via AI Server (with PKCE)...")
        response = requests.post(
            f"{self.ai_server_url}/api/auth/desktop-google",
            json={
                'code': code,
                'redirect_uri': self.google_redirect_uri,
                'code_verifier': code_verifier
            },
            headers={'Content-Type': 'application/json'},
            timeout=(30, 90)
        )

        if response.status_code != 200:
            error_data = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
            raise Exception(error_data.get('error') or f"Google login failed (HTTP {response.status_code})")

        result = response.json()
        if not result.get('success'):
            raise Exception(result.get('error', 'Google login failed'))

        # Mark this as a Google session and persist the Supabase + refresh tokens.
        self.auth_provider = 'google'
        self.tokens['auth_provider'] = 'google'
        self.tokens['supabase_token'] = result.get('supabase_token')
        self.tokens['supabase_token_expires_at'] = time.time() + result.get('expires_in', 3600)
        if result.get('google_refresh_token'):
            self.tokens['google_refresh_token'] = result['google_refresh_token']
        else:
            # We request access_type=offline + prompt=consent, so Google should always
            # return a refresh token. If it's missing, we can only use the cached
            # Supabase JWT (~1h); after that uploads stop until the user signs in again.
            # Warn loudly (don't hard-fail and lock the user out over a transient omission).
            print("[WARN] Google login returned no refresh token — tracking will stop in ~1h without re-login")
        user_data = result.get('user', {})
        if user_data:
            self.tokens['exchange_user_id'] = user_data.get('id')
            self.tokens['exchange_organization_id'] = user_data.get('organization_id')
        # Cache the Supabase client config: google users have no Atlassian token to
        # call /api/auth/supabase-config, so get_supabase_config() reads this cache.
        if result.get('supabase_url') and result.get('supabase_anon_key'):
            self.tokens['cached_supabase_url'] = result['supabase_url']
            self.tokens['cached_supabase_anon_key'] = result['supabase_anon_key']
            self.tokens['cached_supabase_config_at'] = time.time()
        # code_verifier is single-use; drop it.
        self.tokens.pop('google_code_verifier', None)
        self._save_tokens()
        print("[OK] Google login successful — Supabase token stored")
        return result

    def handle_callback(self, code, state):
        """Handle OAuth callback and exchange code for tokens via AI Server (with PKCE)"""
        # Verify state
        stored_state = self.tokens.get('oauth_state')
        if state != stored_state:
            raise ValueError("Invalid state parameter - possible CSRF attack")

        # PKCE: Get the code_verifier we stored during get_auth_url()
        code_verifier = self.tokens.get('code_verifier')
        if not code_verifier:
            raise ValueError("Missing code_verifier - PKCE flow was not properly initiated")

        # Exchange code for tokens via AI Server (client_secret is on server only)
        # Use (connect, read) timeout tuple - the AI server itself calls Atlassian's
        # token endpoint which can take up to 30s, so we need a longer read timeout.
        # Retry up to 3 times since the server may be cold-starting or temporarily slow.
        print("[INFO] Exchanging OAuth code via AI Server (with PKCE)...")
        payload = {
            'code': code,
            'redirect_uri': self.redirect_uri,
            'code_verifier': code_verifier  # PKCE: Send verifier to AI server
        }
        headers = {'Content-Type': 'application/json'}

        response = None
        last_error = None
        for attempt in range(3):
            try:
                response = requests.post(
                    f"{self.ai_server_url}/api/auth/atlassian/callback",
                    json=payload,
                    headers=headers,
                    timeout=(30, 90)  # Generous timeouts: 30s connect, 90s read
                )
                break  # Success — exit retry loop
            except (requests.exceptions.ConnectTimeout, requests.exceptions.ConnectionError) as e:
                last_error = e
                if attempt < 2:
                    wait = (attempt + 1) * 5
                    print(f"[WARN] Token exchange attempt {attempt + 1} failed ({type(e).__name__}), retrying in {wait}s...")
                    time.sleep(wait)
                else:
                    print(f"[ERROR] Token exchange failed after 3 attempts: {e}")
            except requests.exceptions.Timeout as e:
                last_error = e
                print(f"[ERROR] Token exchange timed out (read): {e}")
                break  # Read timeout means server received the request; don't resend to avoid double-exchange

        if response is None:
            raise Exception(f"Could not reach the authentication server. Please check your internet connection and try again. ({last_error})")

        if response.status_code != 200:
            error_data = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
            error = error_data.get('error', response.text)
            
            # Provide more helpful error messages
            if response.status_code == 403:
                if 'not associated with an organization' in error.lower() or 'forge app installed' in error.lower():
                    raise Exception(
                        f"Access denied: Your Jira account is not registered with an organization that has the TimeTracker Forge app installed. "
                        f"Please ask your Jira administrator to install the TimeTracker app from the Atlassian Marketplace. "
                        f"(Server: {error})"
                    )
                else:
                    raise Exception(f"Access denied: {error}")
            elif response.status_code == 401:
                raise Exception(f"Authentication failed: Invalid or expired OAuth code. Please try logging in again. (Server: {error})")
            elif response.status_code == 500:
                raise Exception(f"Server error during token exchange. This may be a temporary issue with the authentication server. (Server: {error})")
            else:
                raise Exception(f"Token exchange failed (HTTP {response.status_code}): {error}")

        result = response.json()
        if not result.get('success'):
            raise Exception(f"Token exchange failed: {result.get('error', 'Unknown error')}")

        self.tokens.update({
            'access_token': result.get('access_token'),
            'refresh_token': result.get('refresh_token'),
            'expires_at': time.time() + result.get('expires_in', 3600)
        })
        # Mark this as an Atlassian session (symmetry with the Google flow).
        self.auth_provider = 'atlassian'
        self.tokens['auth_provider'] = 'atlassian'
        self._save_tokens()
        self._refresh_token_invalid = False  # Clear any prior permanent-failure flag
        self._refresh_fail_count = 0  # Reset consecutive failure counter
        self._refresh_invalid_set_at = 0  # Clear grace-period timestamp
        self._last_refresh_fail_time = 0  # Reset failure window
        self._last_refresh_error_code = ''

        print("[OK] OAuth tokens received via AI Server")
        return result
    
    def get_user_info(self):
        """Get Atlassian user information with automatic token refresh on 401"""
        access_token = self.tokens.get('access_token')
        if not access_token:
            return None

        try:
            response = requests.get(
                'https://api.atlassian.com/me',
                headers={
                    'Authorization': f'Bearer {access_token}',
                    'Accept': 'application/json'
                },
                timeout=10
            )

            # Handle 401 - token expired
            if response.status_code == 401:
                print("[WARN] Access token expired (401) in get_user_info, attempting refresh...")
                if self.refresh_access_token():
                    # Retry with new token
                    access_token = self.tokens.get('access_token')
                    response = requests.get(
                        'https://api.atlassian.com/me',
                        headers={
                            'Authorization': f'Bearer {access_token}',
                            'Accept': 'application/json'
                        },
                        timeout=10
                    )
                else:
                    print("[ERROR] Token refresh failed in get_user_info")
                    return None

            if response.status_code == 200:
                return response.json()
            return None
        except requests.exceptions.ConnectionError:
            print("[WARN] Network unavailable - cannot fetch user info")
            return None
        except requests.exceptions.Timeout:
            print("[WARN] Request timed out - cannot fetch user info")
            return None
        except Exception as e:
            print(f"[ERROR] Failed to get user info: {e}")
            return None
    
    def refresh_access_token(self):
        """Refresh access token using refresh token via AI Server.

        Thread-safe: uses a lock to prevent concurrent refreshes burning the same
        refresh_token. Atlassian rotates refresh tokens on each use — if two threads
        both send the same refresh_token simultaneously, the second call will fail
        with 'refresh_token is invalid' because the first call already consumed it.

        The double-check inside the lock compares the refresh_token value: if it changed
        while waiting for the lock, another thread already did the refresh successfully,
        so we skip the network call and return True.
        """
        # Fast-path: if the refresh token was marked invalid, check if the grace
        # period (30 min) has elapsed. If so, auto-clear and allow one more attempt.
        # This prevents a transient outage from permanently killing the session.
        if getattr(self, '_refresh_token_invalid', False):
            grace_period = 1800  # 30 minutes
            invalid_since = getattr(self, '_refresh_invalid_set_at', 0)
            if invalid_since and (time.time() - invalid_since) >= grace_period:
                print("[INFO] Refresh invalid flag expired after grace period — allowing retry")
                self._refresh_token_invalid = False
                self._refresh_fail_count = 0
                self._refresh_invalid_set_at = 0
            else:
                print("[WARN] Refresh token is marked invalid — re-authentication required")
                grace_remaining = max(0, int(grace_period - (time.time() - invalid_since))) if invalid_since else grace_period
                log_auth_diagnostic(
                    'token_refresh_blocked_invalid_flag',
                    level='WARNING',
                    reason_code=getattr(self, '_last_refresh_error_code', '') or 'UNKNOWN',
                    refresh_fail_count=getattr(self, '_refresh_fail_count', 0),
                    grace_remaining_sec=grace_remaining,
                    invalid_flag=True,
                    next_action='show_auth_notification'
                )
                return False

        refresh_token_before = self.tokens.get('refresh_token')
        if not refresh_token_before:
            print("[ERROR] No refresh token available")
            log_auth_diagnostic(
                'token_refresh_failed',
                level='ERROR',
                reason_code='OAUTH_REAUTH_REQUIRED',
                permanent_failure=True,
                refresh_fail_count=getattr(self, '_refresh_fail_count', 0),
                invalid_flag=getattr(self, '_refresh_token_invalid', False),
                next_action='manual_reauth_required',
                failure_reason='missing_refresh_token'
            )
            return False

        with self._refresh_lock:
            # Re-check invalid flag inside the lock — another thread may have set it
            # while we were waiting to acquire the lock.
            if getattr(self, '_refresh_token_invalid', False):
                grace_period = 1800
                invalid_since = getattr(self, '_refresh_invalid_set_at', 0)
                if not (invalid_since and (time.time() - invalid_since) >= grace_period):
                    print("[INFO] Another thread marked token invalid while waiting for lock")
                    return False
                # Grace period expired — clear and proceed
                self._refresh_token_invalid = False
                self._refresh_fail_count = 0
                self._refresh_invalid_set_at = 0

            # Double-check: if the refresh_token in self.tokens changed while we were
            # waiting for the lock, another thread already refreshed successfully.
            # The new access_token is in self.tokens — caller will pick it up.
            refresh_token_now = self.tokens.get('refresh_token')
            if refresh_token_now and refresh_token_now != refresh_token_before:
                print("[INFO] Token already refreshed by another thread, skipping")
                return True

            refresh_token = refresh_token_now or refresh_token_before
            if not refresh_token:
                self._last_refresh_error_code = 'OAUTH_REAUTH_REQUIRED'
                log_auth_diagnostic(
                    'token_refresh_failed',
                    level='ERROR',
                    reason_code='OAUTH_REAUTH_REQUIRED',
                    permanent_failure=True,
                    refresh_fail_count=getattr(self, '_refresh_fail_count', 0),
                    invalid_flag=getattr(self, '_refresh_token_invalid', False),
                    next_action='manual_reauth_required',
                    failure_reason='missing_refresh_token_after_lock'
                )
                return False

            print("[INFO] Refreshing access token via AI Server...")
            try:
                response = requests.post(
                    f"{self.ai_server_url}/api/auth/refresh-token",
                    json={
                        'refresh_token': refresh_token
                    },
                    headers={'Content-Type': 'application/json'},
                    timeout=(10, 60)
                )

                if response.status_code != 200:
                    error_data = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
                    error = error_data.get('error', response.text)
                    print(f"[ERROR] Token refresh failed: {error}")
                    # Check if re-authentication is TRULY required (permanent failure only).
                    # Be precise: only mark as permanently invalid for actual token revocation/expiry,
                    # NOT for transient errors that happen to contain the word "invalid".
                    # Atlassian returns 'invalid_grant' when the refresh token is truly revoked/expired.
                    error_lower = str(error).lower()
                    error_code = str(error_data.get('errorCode', '')).upper()
                    if error_code == 'OAUTH_REAUTH_REQUIRED':
                        is_permanent_failure = True
                    elif error_code == 'OAUTH_TEMPORARY_FAILURE':
                        is_permanent_failure = False
                    else:
                        is_permanent_failure = (
                            error_data.get('requiresReauth') or
                            'invalid_grant' in error_lower or
                            'refresh token is invalid' in error_lower or
                            'token has been revoked' in error_lower or
                            'token has been expired' in error_lower
                        )

                    if not error_code:
                        error_code = 'OAUTH_REAUTH_REQUIRED' if is_permanent_failure else 'OAUTH_TEMPORARY_FAILURE'
                    self._last_refresh_error_code = error_code

                    projected_fail_count = getattr(self, '_refresh_fail_count', 0)
                    invalid_flag_after_failure = getattr(self, '_refresh_token_invalid', False)
                    next_action = 'retry_refresh'

                    if is_permanent_failure:
                        now = time.time()
                        # Distinguish between server-explicit error codes (certain) and
                        # heuristic text-pattern matches (may have false positives).
                        # When the server explicitly confirms OAUTH_REAUTH_REQUIRED, mark
                        # invalid IMMEDIATELY (1 request). Preserve the 5-failure threshold
                        # only for text-matched errors as a safety net against transients.
                        server_explicit_reauth = (str(error_data.get('errorCode', '')).upper() == 'OAUTH_REAUTH_REQUIRED')
                        if server_explicit_reauth:
                            print("[WARN] Server confirmed refresh token permanently invalid (OAUTH_REAUTH_REQUIRED) — marking invalid immediately")
                            self._refresh_token_invalid = True
                            self._refresh_invalid_set_at = now
                            self._refresh_fail_count = 5  # Saturate counter to block further retries
                            projected_fail_count = 5
                            invalid_flag_after_failure = True
                            next_action = 'show_auth_notification'
                        else:
                            # Heuristic text-match — keep the 5-failure threshold as a
                            # safety net to avoid false-positives from transient errors.
                            last_fail_time = getattr(self, '_last_refresh_fail_time', 0)
                            if (now - last_fail_time) > 600:  # 10 min window
                                self._refresh_fail_count = 0  # Reset — failures are not consecutive
                            self._last_refresh_fail_time = now
                            self._refresh_fail_count = getattr(self, '_refresh_fail_count', 0) + 1
                            projected_fail_count = self._refresh_fail_count
                            if self._refresh_fail_count >= 5:
                                print(f"[WARN] Refresh token failed {self._refresh_fail_count} times within window - marking invalid (will auto-recover in 30 min)")
                                self._refresh_token_invalid = True
                                self._refresh_invalid_set_at = now
                                invalid_flag_after_failure = True
                                next_action = 'show_auth_notification'
                            else:
                                print(f"[WARN] Refresh token failure {self._refresh_fail_count}/5 - will retry before requiring re-auth")
                                next_action = 'retry_refresh'
                    else:
                        next_action = 'retry_refresh'

                    log_auth_diagnostic(
                        'token_refresh_failed',
                        level='WARNING' if response.status_code < 500 else 'ERROR',
                        http_status=response.status_code,
                        error_code=error_code,
                        requires_reauth=bool(error_data.get('requiresReauth')),
                        permanent_failure=is_permanent_failure,
                        refresh_fail_count=projected_fail_count,
                        invalid_flag=invalid_flag_after_failure,
                        grace_period_sec=1800 if invalid_flag_after_failure else 0,
                        next_action=next_action,
                        server_error=error
                    )
                    return False

                result = response.json()
                if not result.get('success'):
                    print(f"[ERROR] Token refresh failed: {result.get('error', 'Unknown error')}")
                    return False

                self.tokens.update({
                    'access_token': result.get('access_token'),
                    'refresh_token': result.get('refresh_token', refresh_token),
                    'expires_at': time.time() + result.get('expires_in', 3600)
                })
                self._save_tokens()

                self._refresh_token_invalid = False  # Clear permanent-failure flag
                self._refresh_fail_count = 0  # Reset consecutive failure counter
                self._refresh_invalid_set_at = 0  # Clear grace-period timestamp
                self._last_refresh_fail_time = 0  # Reset failure window
                self._last_refresh_error_code = ''
                log_auth_diagnostic(
                    'token_refresh_succeeded',
                    level='INFO',
                    refresh_fail_count=0,
                    invalid_flag=False,
                    prior_error_code=getattr(self, '_last_refresh_error_code', '')
                )
                print("[OK] Access token refreshed successfully via AI Server")
                return True
            except Exception as e:
                print(f"[ERROR] Failed to refresh access token: {e}")
                self._last_refresh_error_code = 'OAUTH_TEMPORARY_FAILURE'
                log_auth_diagnostic(
                    'token_refresh_exception',
                    level='ERROR',
                    error_code='OAUTH_TEMPORARY_FAILURE',
                    exception_type=type(e).__name__,
                    message=str(e),
                    next_action='retry_refresh'
                )
                return False

    def is_authenticated(self):
        """Check if user is authenticated (has a valid or refreshable access token)"""
        # Google (non-Jira) sessions have no Atlassian access_token; they are
        # authenticated as long as we hold a Supabase token or a Google refresh token.
        if self.auth_provider == 'google':
            return bool(self.tokens.get('supabase_token') or self.tokens.get('google_refresh_token'))
        if not self.tokens.get('access_token'):
            return False
        # If refresh token is marked invalid, check if the 30-min grace period
        # has elapsed. If so, auto-clear the flag and allow a retry.
        if getattr(self, '_refresh_token_invalid', False):
            grace_period = 1800  # 30 minutes
            invalid_since = getattr(self, '_refresh_invalid_set_at', 0)
            if invalid_since and (time.time() - invalid_since) >= grace_period:
                print("[INFO] is_authenticated: invalid flag grace period expired — allowing retry")
                self._refresh_token_invalid = False
                self._refresh_fail_count = 0
                self._refresh_invalid_set_at = 0
            else:
                return False
        # If we have expiry info and the token is expired, try to refresh it now
        expires_at = self.tokens.get('expires_at', 0)
        if expires_at and time.time() > expires_at:
            # Retry refresh up to 3 times with backoff for transient failures
            # (network not ready after sleep, AI server cold start, etc.)
            for attempt in range(3):
                print(f"[INFO] Access token expired, attempting refresh (attempt {attempt + 1}/3)...")
                if self.refresh_access_token():
                    return True
                # If refresh token is permanently invalid, don't retry
                if getattr(self, '_refresh_token_invalid', False):
                    return False
                if attempt < 2:
                    wait = (attempt + 1) * 2  # 2s, 4s backoff
                    print(f"[INFO] Refresh failed, retrying in {wait}s...")
                    time.sleep(wait)
            print("[WARN] All refresh attempts failed — session may require re-authentication")
            return False
        return True

    def _refresh_google_supabase_token(self):
        """Re-mint the Supabase JWT for a Google (non-Jira) user via the AI server,
        using the stored Google refresh token. Mirrors the Atlassian get_supabase_token
        but goes through /api/auth/desktop-google/refresh (no Atlassian token involved)."""
        refresh_token = self.tokens.get('google_refresh_token')
        if not refresh_token:
            print("[ERROR] No Google refresh token available — re-login required")
            return None

        print("[INFO] Refreshing Supabase token for Google user...")
        try:
            response = requests.post(
                f"{self.ai_server_url}/api/auth/desktop-google/refresh",
                json={'google_refresh_token': refresh_token},
                headers={'Content-Type': 'application/json'},
                timeout=(10, 60)
            )
            if response.status_code != 200:
                error_data = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
                print(f"[ERROR] Google token refresh failed: {error_data.get('error', response.text)}")
                return None

            result = response.json()
            if not result.get('success'):
                print(f"[ERROR] Google token refresh failed: {result.get('error', 'Unknown error')}")
                return None

            supabase_token = result.get('supabase_token')
            expires_in = result.get('expires_in', 3600)
            self.tokens['supabase_token'] = supabase_token
            self.tokens['supabase_token_expires_at'] = time.time() + expires_in
            # Google may issue a rotated refresh token; keep it if present.
            new_refresh = result.get('google_refresh_token')
            if new_refresh:
                self.tokens['google_refresh_token'] = new_refresh
            user_data = result.get('user', {})
            if user_data:
                self.tokens['exchange_user_id'] = user_data.get('id')
                self.tokens['exchange_organization_id'] = user_data.get('organization_id')
            # Keep the Supabase config cache warm for google sessions.
            if result.get('supabase_url') and result.get('supabase_anon_key'):
                self.tokens['cached_supabase_url'] = result['supabase_url']
                self.tokens['cached_supabase_anon_key'] = result['supabase_anon_key']
                self.tokens['cached_supabase_config_at'] = time.time()
            self._save_tokens()
            print(f"[OK] Supabase token refreshed for Google user (expires in {expires_in}s)")
            return supabase_token
        except Exception as e:
            print(f"[ERROR] Failed to refresh Google Supabase token: {e}")
            return None

    def get_supabase_token(self):
        """Get Supabase JWT from AI Server using Atlassian token"""
        # Google (non-Jira) users have no Atlassian token — refresh via Google instead.
        if self.auth_provider == 'google':
            return self._refresh_google_supabase_token()

        access_token = self.tokens.get('access_token')
        if not access_token:
            print("[ERROR] No Atlassian access token available")
            return None

        print("[INFO] Requesting Supabase token from AI Server...")
        try:
            response = requests.post(
                f"{self.ai_server_url}/api/auth/exchange-token",
                json={
                    'atlassian_token': access_token
                },
                headers={'Content-Type': 'application/json'},
                timeout=(10, 60)
            )

            if response.status_code == 401:
                # Atlassian token expired, try to refresh (non-recursive: single retry)
                print("[WARN] Atlassian token expired, attempting refresh...")
                if self.refresh_access_token():
                    # Retry ONCE with the new token (no recursion)
                    new_access_token = self.tokens.get('access_token')
                    retry_response = requests.post(
                        f"{self.ai_server_url}/api/auth/exchange-token",
                        json={'atlassian_token': new_access_token},
                        headers={'Content-Type': 'application/json'},
                        timeout=(10, 60)
                    )
                    if retry_response.status_code == 200:
                        result = retry_response.json()
                        if result.get('success'):
                            supabase_token = result.get('supabase_token')
                            expires_in = result.get('expires_in', 3600)
                            self.tokens['supabase_token'] = supabase_token
                            self.tokens['supabase_token_expires_at'] = time.time() + expires_in
                            user_data = result.get('user', {})
                            if user_data:
                                self.tokens['exchange_user_id'] = user_data.get('id')
                                self.tokens['exchange_organization_id'] = user_data.get('organization_id')
                                retry_cloud_id = user_data.get('jira_cloud_id')
                                if retry_cloud_id:
                                    self.tokens['exchange_jira_cloud_id'] = retry_cloud_id
                            self._save_tokens()
                            print(f"[OK] Supabase token received on retry (expires in {expires_in}s)")
                            return supabase_token
                    print("[ERROR] Supabase token retry after refresh also failed")
                    return None
                print("[ERROR] Could not refresh Atlassian token")
                return None

            if response.status_code != 200:
                error_data = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
                error = error_data.get('error', response.text)
                print(f"[ERROR] Failed to get Supabase token: {error}")
                return None

            result = response.json()
            if not result.get('success'):
                print(f"[ERROR] Failed to get Supabase token: {result.get('error', 'Unknown error')}")
                return None

            supabase_token = result.get('supabase_token')
            expires_in = result.get('expires_in', 3600)

            # Store the Supabase token
            self.tokens['supabase_token'] = supabase_token
            self.tokens['supabase_token_expires_at'] = time.time() + expires_in

            # Store user data from exchange-token response (includes organization_id, user id)
            # The AI server creates/finds the org via service_role during token exchange,
            # so this is the authoritative source for organization_id AND jira_cloud_id.
            # jira_cloud_id is critical: without it, get_jira_cloud_id() falls back to
            # resources[0] which may be a different Jira site when the user has multiple
            # instances, causing issue fetches to return tickets from the wrong org.
            user_data = result.get('user', {})
            if user_data:
                self.tokens['exchange_user_id'] = user_data.get('id')
                self.tokens['exchange_organization_id'] = user_data.get('organization_id')
                exchange_cloud_id = user_data.get('jira_cloud_id')
                if exchange_cloud_id:
                    self.tokens['exchange_jira_cloud_id'] = exchange_cloud_id
                    print(f"[OK] Exchange-token user data: user_id={user_data.get('id')}, org_id={user_data.get('organization_id')}, jira_cloud_id={exchange_cloud_id}")
                else:
                    print(f"[OK] Exchange-token user data: user_id={user_data.get('id')}, org_id={user_data.get('organization_id')}")

            self._save_tokens()

            print(f"[OK] Supabase token received (expires in {expires_in}s)")
            return supabase_token

        except Exception as e:
            print(f"[ERROR] Failed to get Supabase token: {e}")
            return None

    def get_valid_supabase_token(self):
        """Get a valid Supabase token, refreshing if needed"""
        supabase_token = self.tokens.get('supabase_token')
        expires_at = self.tokens.get('supabase_token_expires_at', 0)
        time_remaining = expires_at - time.time()

        # Check if token exists and is not expired (with 5 min buffer)
        if supabase_token and time.time() < (expires_at - 300):
            if APP_LOGGER_AVAILABLE:
                logger = get_logger(__name__, 'AUTH')
                logger.debug(f"Using cached Supabase token (expires in {time_remaining:.0f}s)")
            return supabase_token

        # Token expired or doesn't exist, get a new one
        print("[INFO] Supabase token expired or missing, getting new one...")
        if APP_LOGGER_AVAILABLE:
            logger = get_logger(__name__, 'AUTH')
            logger.info(f"Supabase token refresh required: token_exists={bool(supabase_token)}, time_remaining={time_remaining:.0f}s")
        
        for attempt in range(3):
            try:
                return self.get_supabase_token()
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout, Exception) as e:
                error_type = type(e).__name__
                network_status = "unknown"
                try:
                    # Lightweight connectivity probe for diagnostics during retryable failures.
                    socket.create_connection(("8.8.8.8", 53), timeout=2).close()
                    network_status = "online"
                except Exception:
                    network_status = "offline"

                warn_message = (
                    f"[WARN] JWT exchange attempt {attempt + 1}/3 failed: {e} "
                    f"(error_type={error_type}, network_status={network_status})"
                )
                print(warn_message)
                logging.warning(warn_message)

                if attempt < 2:
                    wait_seconds = (attempt + 1) * 3
                    print(f"[INFO] Retrying JWT exchange in {wait_seconds}s...")
                    time.sleep(wait_seconds)

        error_message = "[ERROR] Could not get Supabase token after 3 attempts"
        print(error_message)
        logging.error(error_message)
        return None

    def get_supabase_config(self):
        """Fetch Supabase configuration from AI Server (requires valid Atlassian token).
        
        Caches the fetched URL and anon key in auth_metadata.json (TTL: 24 hours) so that
        brief AI server outages at startup do not permanently break Supabase initialization.
        The cached values are non-sensitive (anon key is intentionally public-facing).
        """
        # --- Use local cache if fresh enough ---
        cached_url = self.tokens.get('cached_supabase_url')
        cached_anon_key = self.tokens.get('cached_supabase_anon_key')
        cached_at = self.tokens.get('cached_supabase_config_at', 0)
        CACHE_TTL = 86400  # 24 hours — refresh once a day at most
        if cached_url and cached_anon_key and (time.time() - cached_at) < CACHE_TTL:
            print("[INFO] Using locally cached Supabase config (last fetched <24h ago)")
            set_runtime_supabase_config(cached_url, cached_anon_key)
            return True

        access_token = self.tokens.get('access_token')
        if not access_token:
            print("[ERROR] No valid Atlassian token - cannot fetch Supabase config")
            # Fall back to stale cache rather than failing completely
            if cached_url and cached_anon_key:
                print("[WARN] Using stale cached Supabase config (no access token for refresh)")
                set_runtime_supabase_config(cached_url, cached_anon_key)
                return True
            return False

        try:
            ai_server_url = get_env_var('AI_SERVER_URL')
            print("[INFO] Fetching Supabase config from AI Server...")

            response = requests.post(
                f"{ai_server_url}/api/auth/supabase-config",
                json={'atlassian_token': access_token},
                timeout=(10, 60)
            )

            if response.status_code == 401:
                # Token might be expired, try refreshing
                print("[WARN] Atlassian token rejected, attempting refresh...")
                if self.refresh_access_token():
                    return self.get_supabase_config()
                else:
                    print("[ERROR] Token refresh failed")
                    return False

            if response.status_code != 200:
                error = response.json().get('error', 'Unknown error')
                print(f"[ERROR] Failed to get Supabase config: {error}")
                return False

            result = response.json()
            if not result.get('success'):
                print(f"[ERROR] Failed to get Supabase config: {result.get('error', 'Unknown error')}")
                return False

            supabase_url = result.get('supabase_url')
            supabase_anon_key = result.get('supabase_anon_key')

            # Store the Supabase config in runtime config
            # Only URL and anon key are needed — JWT provides identity for RLS
            set_runtime_supabase_config(supabase_url, supabase_anon_key)

            # Cache to auth_metadata.json so next startup works even if AI server is briefly down.
            # The anon key is intentionally public-facing (safe to store locally).
            self.tokens['cached_supabase_url'] = supabase_url
            self.tokens['cached_supabase_anon_key'] = supabase_anon_key
            self.tokens['cached_supabase_config_at'] = time.time()
            try:
                self._save_tokens()
            except Exception as cache_err:
                print(f"[WARN] Could not cache Supabase config locally: {cache_err}")

            return True

        except Exception as e:
            print(f"[ERROR] Failed to fetch Supabase config: {e}")
            # Fall back to stale cache on network errors so startup can proceed
            if cached_url and cached_anon_key:
                print("[WARN] Using stale cached Supabase config after network error")
                set_runtime_supabase_config(cached_url, cached_anon_key)
                return True
            return False

    
    def get_ocr_config(self):
        """
        Fetch OCR configuration from AI Server (requires valid Atlassian token).
        
        This eliminates the need for OCR configuration in .env file.
        All OCR settings are centralized on the AI server for easy updates.
        
        Returns:
            bool: True if config fetched successfully, False otherwise
        """
        access_token = self.tokens.get('access_token')

        
        if not access_token:
            print("[ERROR] No valid Atlassian token - cannot fetch OCR config")
            return False

        ai_server_url = get_env_var('AI_SERVER_URL', 'https://forgesync.amzur.com')
        
        try:
            print("[INFO] Fetching OCR config from AI Server...")
            
            response = requests.post(
                f"{ai_server_url}/api/auth/ocr-config",
                json={'atlassian_token': access_token},
                timeout=(10, 60)
            )
            
            if response.status_code == 401:
                # Token might be expired, try refreshing
                print("[WARN] Atlassian token rejected, attempting refresh...")
                if self.refresh_access_token():
                    return self.get_ocr_config()
                else:
                    print("[ERROR] Token refresh failed")
                    return False
            
            if response.status_code != 200:
                error = response.json().get('error', 'Unknown error')
                print(f"[ERROR] Failed to get OCR config: {error}")
                return False
            
            result = response.json()
            if not result.get('success'):
                print(f"[ERROR] Failed to get OCR config: {result.get('error', 'Unknown error')}")
                return False
            
            # Store the OCR config in runtime config
            ocr_config = result.get('config', {})
            set_runtime_ocr_config(ocr_config)

            # Apply privacy filter config from server (delivered alongside OCR config)
            privacy_config = result.get('privacy', {})
            if privacy_config:
                set_runtime_privacy_config(privacy_config)

            return True
        
        except Exception as e:
            print(f"[ERROR] Failed to fetch OCR config: {e}")
            return False

    def logout(self):
        """Clear authentication tokens from all storage locations"""
        self.tokens = {}
        # Reset provider so a subsequent Atlassian login isn't treated as Google.
        self.auth_provider = 'atlassian'
        self._refresh_token_invalid = False
        self._refresh_fail_count = 0
        self._refresh_invalid_set_at = 0
        self._last_refresh_fail_time = 0
        self._last_refresh_error_code = ''

        # Clear sensitive tokens from secure storage (keyring + encrypted fallback)
        try:
            self.secure_storage.delete_tokens()
        except Exception as e:
            print(f"[WARN] Failed to clear secure storage: {e}")

        # Also clear from keyring directly (handles legacy entries)
        if KEYRING_AVAILABLE:
            for key in SENSITIVE_TOKEN_KEYS:
                _keyring_delete(KEYRING_SERVICE, key)

        # Remove old JSON file (contains metadata)
        if os.path.exists(self.store_path):
            os.remove(self.store_path)

        # Remove metadata file
        if os.path.exists(self.metadata_path):
            os.remove(self.metadata_path)
    
    def send_diagnostics(self, diag_type: str, diagnostics: dict) -> bool:
        """
        Send diagnostics to AI server for remote debugging.
        
        Args:
            diag_type: Type of diagnostics ('ocr', 'login', 'error')
            diagnostics: Dictionary with diagnostic information
            
        Returns:
            bool: True if sent successfully, False otherwise
        """
        access_token = self.tokens.get('access_token')
        if not access_token:
            print("[WARN] Cannot send diagnostics - not authenticated")
            return False
        
        try:
            payload = {
                'atlassian_token': access_token,
                'type': diag_type,
                'diagnostics': diagnostics,
                'app_version': APP_VERSION
            }
            
            response = requests.post(
                f"{self.ai_server_url}/api/auth/diagnostics",
                json=payload,
                headers={'Content-Type': 'application/json'},
                timeout=(10, 30)
            )
            
            if response.status_code == 200:
                print(f"[OK] {diag_type.upper()} diagnostics sent to server")
                return True
            else:
                print(f"[WARN] Failed to send diagnostics: {response.status_code}")
                return False
                
        except Exception as e:
            print(f"[WARN] Error sending diagnostics: {e}")
            return False


def send_ocr_diagnostics(auth_manager):
    """
    Collect and send OCR diagnostics to the AI server.
    Call this after OCR is initialized to report engine status.
    
    Args:
        auth_manager: AtlassianAuthManager instance
    """
    try:
        from ocr import get_facade
        facade = get_facade()
        diagnostics = facade.get_ocr_diagnostics()
        auth_manager.send_diagnostics('ocr', diagnostics)
    except Exception as e:
        print(f"[WARN] Failed to collect OCR diagnostics: {e}")


def send_login_diagnostics(auth_manager, status: str, step: str, error: str = None, error_details: dict = None):
    """
    Send login event diagnostics to the AI server and log locally.
    
    Args:
        auth_manager: AtlassianAuthManager instance
        status: 'success', 'failed', 'started'
        step: Login step ('oauth_start', 'oauth_callback', 'token_exchange', 'config_fetch', etc.)
        error: Error message if failed
        error_details: Additional error context
    """
    import platform
    from datetime import datetime
    
    diagnostics = {
        'status': status,
        'step': step,
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'system_info': {
            'platform': platform.system(),
            'platform_version': platform.version(),
            'hostname': platform.node(),
        }
    }
    
    if error:
        diagnostics['error'] = error
    if error_details:
        diagnostics['error_details'] = error_details
    
    # Log diagnostics locally in JSON format (AC8: structured diagnostic logging)
    print(f"[DIAGNOSTIC] Login flow: {json.dumps(diagnostics, indent=2)}")
    
    # Send to AI server for centralized logging
    auth_manager.send_diagnostics('login', diagnostics)

# ============================================================================
# OFFLINE DATA MANAGER
# ============================================================================

class OfflineManager:
    """Manages offline data storage and synchronization with Supabase"""
    
    def __init__(self, db_manager):
        """Initialize offline manager with shared database connection manager"""
        self.db_manager = db_manager
        self.db_path = db_manager.db_path  # backward compat
        self.is_online = True
        self._last_connectivity_check = 0
        self._connectivity_check_interval = 30  # Check every 30 seconds
        self._sync_lock = threading.Lock()
        self._syncing = False

        # Schema initialization handled by db_manager
        print(f"[OK] Offline manager initialized (DB: {self.db_path})")
    
    def check_connectivity(self, force=False):
        """Check if we have internet connectivity"""
        current_time = time.time()
        
        # Use cached result if checked recently (unless forced)
        if not force and (current_time - self._last_connectivity_check) < self._connectivity_check_interval:
            return self.is_online
        
        self._last_connectivity_check = current_time
        
        # Try multiple endpoints for reliability
        test_endpoints = [
            ("api.atlassian.com", 443),
            ("supabase.co", 443),
            ("8.8.8.8", 53),  # Google DNS
        ]
        
        for host, port in test_endpoints:
            sock = None
            try:
                # Create socket with per-socket timeout (not global)
                # Using setdefaulttimeout() would affect Flask's request handling
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(3)  # Per-socket timeout
                sock.connect((host, port))
                sock.close()
                if not self.is_online:
                    print("[OK] Network connectivity restored")
                self.is_online = True
                return True
            except (socket.error, socket.timeout, OSError):
                if sock:
                    try:
                        sock.close()
                    except:
                        pass
                continue
        
        if self.is_online:
            print("[WARN] Network connectivity lost - switching to offline mode")
        self.is_online = False
        return False
    
    def save_screenshot_offline(self, screenshot_data, image_bytes, thumbnail_bytes):
        """Save screenshot data locally when offline
        
        Args:
            screenshot_data: Dictionary with screenshot metadata
            image_bytes: Raw image data (PNG)
            thumbnail_bytes: Raw thumbnail data (JPEG)
        
        Returns:
            int: Local record ID
        """
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            # Convert complex objects to JSON strings
            user_issues = json.dumps(screenshot_data.get('user_assigned_issues', []))
            metadata = json.dumps(screenshot_data.get('metadata', {}))

            cursor.execute('''
                INSERT INTO offline_screenshots (
                    user_id, organization_id, timestamp, storage_path,
                    window_title, application_name, file_size_bytes,
                    start_time, end_time, duration_seconds, project_key,
                    user_assigned_issues, metadata, image_data, thumbnail_data
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                screenshot_data.get('user_id'),
                screenshot_data.get('organization_id'),
                screenshot_data.get('timestamp'),
                screenshot_data.get('storage_path'),
                screenshot_data.get('window_title'),
                screenshot_data.get('application_name'),
                screenshot_data.get('file_size_bytes'),
                screenshot_data.get('start_time'),
                screenshot_data.get('end_time'),
                screenshot_data.get('duration_seconds'),
                screenshot_data.get('project_key'),
                user_issues,
                metadata,
                image_bytes,
                thumbnail_bytes
            ))

            local_id = cursor.lastrowid
            conn.commit()

            print(f"[OK] Screenshot saved offline (local ID: {local_id})")
            return local_id

        except Exception as e:
            conn.rollback()
            print(f"[ERROR] Failed to save screenshot offline: {e}")
            traceback.print_exc()
            return None
    
    def get_pending_screenshots(self, limit=10):
        """Get screenshots that need to be synced (only those with valid user_id)
        
        Args:
            limit: Maximum number of records to retrieve
        
        Returns:
            List of dictionaries with screenshot data
        """
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            # Only get records with valid UUID user_id (not anonymous)
            # UUID format: 8-4-4-4-12 hex characters
            cursor.execute('''
                SELECT * FROM offline_screenshots
                WHERE synced = 0
                AND sync_attempts < 5
                AND user_id IS NOT NULL
                AND user_id != ''
                AND user_id NOT LIKE 'anonymous_%'
                AND length(user_id) = 36
                ORDER BY created_at ASC
                LIMIT ?
            ''', (limit,))

            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            return [dict(zip(columns, row)) for row in rows]

        except Exception as e:
            print(f"[ERROR] Failed to get pending screenshots: {e}")
            return []
    
    def mark_as_synced(self, local_id):
        """Mark a screenshot as successfully synced
        
        Args:
            local_id: Local database ID
        """
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            cursor.execute('''
                UPDATE offline_screenshots
                SET synced = 1, last_sync_error = NULL
                WHERE id = ?
            ''', (local_id,))

            conn.commit()

        except Exception as e:
            conn.rollback()
            print(f"[ERROR] Failed to mark screenshot as synced: {e}")
    
    def mark_sync_failed(self, local_id, error_message):
        """Mark a sync attempt as failed
        
        Args:
            local_id: Local database ID
            error_message: Error message from sync attempt
        """
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            cursor.execute('''
                UPDATE offline_screenshots
                SET sync_attempts = sync_attempts + 1,
                    last_sync_error = ?
                WHERE id = ?
            ''', (error_message, local_id))

            conn.commit()

        except Exception as e:
            conn.rollback()
            print(f"[ERROR] Failed to mark sync as failed: {e}")
    
    def get_pending_count(self, include_anonymous=True):
        """Get count of screenshots pending sync
        
        Args:
            include_anonymous: If True, includes records without user_id
        """
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            if include_anonymous:
                cursor.execute('''
                    SELECT COUNT(*) FROM offline_screenshots
                    WHERE synced = 0 AND sync_attempts < 5
                ''')
            else:
                cursor.execute('''
                    SELECT COUNT(*) FROM offline_screenshots
                    WHERE synced = 0 AND sync_attempts < 5 AND user_id IS NOT NULL AND user_id != ''
                ''')

            count = cursor.fetchone()[0]
            return count

        except Exception as e:
            print(f"[ERROR] Failed to get pending count: {e}")
            return 0
    
    def get_anonymous_count(self):
        """Get count of screenshots captured without user authentication"""
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            cursor.execute('''
                SELECT COUNT(*) FROM offline_screenshots
                WHERE synced = 0 AND (user_id IS NULL OR user_id = '' OR user_id LIKE 'anonymous_%')
            ''')

            count = cursor.fetchone()[0]
            return count

        except Exception as e:
            print(f"[ERROR] Failed to get anonymous count: {e}")
            return 0
    
    def associate_anonymous_records(self, user_id, organization_id=None):
        """Associate all anonymous offline records with a user after login
        
        Args:
            user_id: The actual user UUID from Supabase
            organization_id: The organization UUID (optional)
        
        Returns:
            int: Number of records updated
        """
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            # Update all anonymous records with the real user_id
            if organization_id:
                cursor.execute('''
                    UPDATE offline_screenshots
                    SET user_id = ?, organization_id = ?
                    WHERE synced = 0 AND (user_id IS NULL OR user_id = '' OR user_id LIKE 'anonymous_%')
                ''', (user_id, organization_id))
            else:
                cursor.execute('''
                    UPDATE offline_screenshots
                    SET user_id = ?
                    WHERE synced = 0 AND (user_id IS NULL OR user_id = '' OR user_id LIKE 'anonymous_%')
                ''', (user_id,))

            updated = cursor.rowcount
            conn.commit()

            if updated > 0:
                secure_log(f"[OK] Associated {updated} anonymous screenshots with user", user_id=user_id)

            return updated

        except Exception as e:
            conn.rollback()
            print(f"[ERROR] Failed to associate anonymous records: {e}")
            return 0

    def cleanup_synced(self, days_old=0):
        """Remove synced screenshots from local database
        
        Args:
            days_old: Number of days after which to delete synced records (0 = immediate)
        """
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            if days_old == 0:
                # Delete immediately after sync
                cursor.execute('''
                    DELETE FROM offline_screenshots
                    WHERE synced = 1
                ''')
            else:
                cursor.execute('''
                    DELETE FROM offline_screenshots
                    WHERE synced = 1
                    AND datetime(created_at) < datetime('now', ? || ' days')
                ''', (f'-{days_old}',))

            deleted = cursor.rowcount
            conn.commit()

            if deleted > 0:
                print(f"[OK] Deleted {deleted} synced screenshots from local storage")

        except Exception as e:
            conn.rollback()
            print(f"[ERROR] Failed to cleanup synced screenshots: {e}")
    
    def sync_all(self, supabase_client, storage_client):
        """Sync all pending screenshots to Supabase
        
        Args:
            supabase_client: Supabase client for database operations
            storage_client: Supabase client for storage operations
        
        Returns:
            tuple: (synced_count, failed_count)
        """
        if SCREENSHOT_MONITORING_HARD_DISABLED:
            print("[INFO] Screenshot sync is disabled by client configuration")
            return (0, 0)

        if self._syncing:
            print("[INFO] Sync already in progress, skipping...")
            return (0, 0)
        
        with self._sync_lock:
            self._syncing = True
            
        try:
            pending = self.get_pending_screenshots(limit=50)
            
            if not pending:
                # Check if there are anonymous records waiting
                anonymous_count = self.get_anonymous_count()
                if anonymous_count > 0:
                    print(f"[INFO] {anonymous_count} anonymous screenshots waiting for user login before sync")
                return (0, 0)
            
            print(f"[INFO] Starting offline sync: {len(pending)} screenshots to upload")
            synced = 0
            failed = 0
            
            for record in pending:
                try:
                    success = self._sync_single_screenshot(
                        record, supabase_client, storage_client
                    )
                    if success:
                        self.mark_as_synced(record['id'])
                        synced += 1
                    else:
                        # Don't increment failed for anonymous records - they're just waiting
                        user_id = record.get('user_id', '')
                        if not user_id.startswith('anonymous_'):
                            self.mark_sync_failed(record['id'], "Upload returned no success")
                            failed += 1
                except Exception as e:
                    self.mark_sync_failed(record['id'], str(e))
                    failed += 1
                    print(f"[ERROR] Failed to sync screenshot {record['id']}: {e}")
                
                # Small delay between uploads to avoid overwhelming the server
                time.sleep(0.5)
            
            print(f"[OK] Offline sync completed: {synced} synced, {failed} failed")
            
            # Cleanup old synced records
            self.cleanup_synced()
            
            return (synced, failed)
            
        finally:
            with self._sync_lock:
                self._syncing = False
    
    def _sync_single_screenshot(self, record, db_client, storage_client):
        """Sync a single screenshot record to Supabase
        
        Args:
            record: Dictionary with offline screenshot data
            db_client: Supabase client for database operations
            storage_client: Supabase client for storage operations
        
        Returns:
            bool: True if sync was successful
        """
        try:
            user_id = record['user_id']
            timestamp = record['timestamp']
            image_data = record['image_data']
            thumbnail_data = record['thumbnail_data']
            
            # Validate user_id is a proper UUID (not anonymous)
            if not user_id or user_id.startswith('anonymous_') or len(user_id) != 36:
                print(f"[WARN] Skipping record {record['id']} - invalid user_id (anonymous or not UUID)")
                return False  # Don't mark as synced, wait for user to login
            
            if not image_data:
                print(f"[WARN] Skipping record {record['id']} - no image data")
                return True  # Mark as synced to skip it
            
            # Generate filenames
            ts = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            filename = f"screenshot_{int(ts.timestamp())}.png"
            thumb_filename = f"thumb_{int(ts.timestamp())}.jpg"
            
            storage_path = f"{user_id}/{filename}"
            thumb_path = f"{user_id}/{thumb_filename}"
            
            # Try to upload image to storage (handle duplicates)
            screenshot_url = None
            upload_verified = False
            try:
                screenshot_result = storage_client.storage.from_('screenshots').upload(
                    storage_path, image_data, file_options={'content-type': 'image/png'}
                )
                # Validate upload response
                if screenshot_result:
                    if hasattr(screenshot_result, 'path') or hasattr(screenshot_result, 'Key'):
                        upload_verified = True
                    elif isinstance(screenshot_result, dict):
                        upload_verified = 'path' in screenshot_result or 'Key' in screenshot_result or 'Id' in screenshot_result
                    else:
                        # Verify file exists after upload
                        try:
                            list_result = storage_client.storage.from_('screenshots').list(user_id, {'search': filename, 'limit': 1})
                            upload_verified = list_result and len(list_result) > 0
                        except:
                            upload_verified = True  # Assume success if can't verify

                    if upload_verified:
                        screenshot_url = storage_client.storage.from_('screenshots').get_public_url(storage_path)
            except Exception as upload_err:
                error_str = str(upload_err)
                # Handle duplicate file error - file already exists, just get the URL
                if 'Duplicate' in error_str or '409' in error_str or 'already exists' in error_str.lower():
                    print(f"[INFO] File already exists in storage, using existing: {storage_path}")
                    screenshot_url = storage_client.storage.from_('screenshots').get_public_url(storage_path)
                    upload_verified = True
                else:
                    raise upload_err

            if not screenshot_url or not upload_verified:
                raise Exception(f"Failed to upload screenshot to storage - upload_verified: {upload_verified}")
            
            # Try to upload thumbnail (handle duplicates)
            thumb_url = None
            if thumbnail_data:
                try:
                    thumb_result = storage_client.storage.from_('screenshots').upload(
                        thumb_path, thumbnail_data, file_options={'content-type': 'image/jpeg'}
                    )
                    if thumb_result:
                        thumb_url = storage_client.storage.from_('screenshots').get_public_url(thumb_path)
                except Exception as thumb_err:
                    error_str = str(thumb_err)
                    if 'Duplicate' in error_str or '409' in error_str or 'already exists' in error_str.lower():
                        thumb_url = storage_client.storage.from_('screenshots').get_public_url(thumb_path)
                    # Don't fail if thumbnail upload fails
            
            # Parse JSON fields
            user_issues = json.loads(record.get('user_assigned_issues') or '[]')
            metadata = json.loads(record.get('metadata') or '{}')

            # Prepare database record
            screenshot_data = {
                'user_id': user_id,
                'organization_id': record.get('organization_id'),
                'timestamp': timestamp,
                'storage_url': screenshot_url,
                'storage_path': storage_path,
                'thumbnail_url': thumb_url,
                'window_title': record.get('window_title'),
                'application_name': record.get('application_name'),
                'file_size_bytes': record.get('file_size_bytes'),
                'status': 'pending',
                'project_key': record.get('project_key'),
                'user_assigned_issues': user_issues,
                'start_time': record.get('start_time'),
                'end_time': record.get('end_time'),
                'duration_seconds': record.get('duration_seconds'),
                'metadata': metadata
            }
            
            # Insert into database
            result = db_client.table('screenshots').insert(screenshot_data).execute()
            
            if result.data:
                print(f"[OK] Synced offline screenshot to Supabase (DB ID: {result.data[0]['id']})")
                return True
            
            return False
            
        except Exception as e:
            print(f"[ERROR] Error syncing screenshot: {e}")
            raise

    def save_project_settings_cache(self, organization_id, project_settings):
        """Save project settings to local cache for offline use
        
        Args:
            organization_id: Organization UUID
            project_settings: Dict of {project_key: {tracked_statuses: [...], project_name: '...'}}
        """
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            for project_key, settings in project_settings.items():
                tracked_statuses = json.dumps(settings.get('tracked_statuses', ['In Progress']))
                project_name = settings.get('project_name', project_key)

                # Upsert: Insert or replace
                cursor.execute('''
                    INSERT OR REPLACE INTO project_settings_cache
                    (organization_id, project_key, project_name, tracked_statuses, cached_at)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ''', (organization_id, project_key, project_name, tracked_statuses))

            conn.commit()
            print(f"[OK] Cached project settings for {len(project_settings)} projects")

        except Exception as e:
            conn.rollback()
            print(f"[ERROR] Failed to cache project settings: {e}")

    def load_project_settings_cache(self, organization_id):
        """Load project settings from local cache
        
        Args:
            organization_id: Organization UUID
            
        Returns:
            dict: {project_key: {tracked_statuses: [...], project_name: '...'}} or empty dict
        """
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            cursor.execute('''
                SELECT project_key, project_name, tracked_statuses
                FROM project_settings_cache
                WHERE organization_id = ?
            ''', (organization_id,))

            rows = cursor.fetchall()

            if rows:
                result = {}
                for row in rows:
                    result[row[0]] = {
                        'tracked_statuses': json.loads(row[2]) if row[2] else ['In Progress'],
                        'project_name': row[1] or row[0]
                    }
                print(f"[OK] Loaded {len(result)} project settings from local cache")
                return result

            return {}

        except Exception as e:
            print(f"[ERROR] Failed to load project settings cache: {e}")
            return {}

    def clear_project_settings_cache(self, organization_id=None):
        """Clear project settings cache
        
        Args:
            organization_id: If provided, only clear for this org. Otherwise clear all.
        """
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            if organization_id:
                cursor.execute('DELETE FROM project_settings_cache WHERE organization_id = ?', (organization_id,))
            else:
                cursor.execute('DELETE FROM project_settings_cache')

            deleted = cursor.rowcount
            conn.commit()

            if deleted > 0:
                print(f"[OK] Cleared {deleted} cached project settings")

        except Exception as e:
            conn.rollback()
            print(f"[ERROR] Failed to clear project settings cache: {e}")

# ============================================================================
# CONSENT MANAGER
# ============================================================================

class ConsentManager:
    """Manages user consent for screenshot capture - GDPR/Privacy compliance"""

    CONSENT_VERSION = "1.0"  # Increment when privacy policy changes significantly

    def __init__(self, store_path=None):
        self.store_path = store_path or os.path.join(
            get_app_data_dir(), 'time_tracker_consent.json'
        )
        self.consent_data = self._load_consent()

    def _load_consent(self):
        """Load stored consent data from file.

        If the file exists but is empty or contains invalid JSON (e.g. corrupted
        by a SIGTERM that arrived while _save_consent was mid-write), the corrupted
        file is removed so a clean write can happen on the next record_consent()
        call.  This does NOT log the user out — their auth tokens are untouched.
        """
        try:
            if os.path.exists(self.store_path):
                with open(self.store_path, 'r') as f:
                    data = json.load(f)
                return data
        except (json.JSONDecodeError, ValueError) as e:
            print(f"[WARN] Consent file is corrupted ({e}) — removing for clean re-write")
            try:
                os.remove(self.store_path)
            except OSError:
                pass
        except Exception as e:
            print(f"[WARN] Failed to load consent data: {e}")
        return {}

    def _save_consent(self):
        """Save consent data to file atomically to prevent corruption on SIGTERM.

        Uses write-to-temp + atomic rename so the consent file is never left in a
        partially-written (0-byte) state if the process is killed mid-write, e.g.
        by terminate_old_version() during an AppImage upgrade.
        """
        try:
            tmp = self.store_path + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(self.consent_data, f, indent=2)
            os.replace(tmp, self.store_path)  # atomic on Linux/POSIX
        except Exception as e:
            print(f"[WARN] Failed to save consent data: {e}")
            try:
                os.remove(self.store_path + '.tmp')
            except OSError:
                pass

    def has_valid_consent(self, user_id):
        """Check if user has given valid consent for current version"""
        if not user_id:
            return False

        user_consent = self.consent_data.get(user_id, {})
        if not user_consent.get('consented', False):
            return False

        # Check if consent is for current version
        consent_version = user_consent.get('version', '0.0')
        if consent_version != self.CONSENT_VERSION:
            print(f"[INFO] Consent version mismatch ({consent_version} vs {self.CONSENT_VERSION}) - re-consent required")
            return False

        return True

    def record_consent(self, user_id, consented=True, user_email=None):
        """Record user's consent decision"""
        self.consent_data[user_id] = {
            'consented': consented,
            'version': self.CONSENT_VERSION,
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'user_email': user_email,
            'data_collected': [
                'screenshots',
                'window_titles',
                'application_names',
                'timestamps',
                'jira_issues'
            ],
            'third_party_processing': [
                'OpenAI (screenshot analysis)',
                'Supabase (data storage)'
            ]
        }
        self._save_consent()
        secure_log(f"[OK] Consent {'granted' if consented else 'denied'} for user", user_id=user_id)

    def revoke_consent(self, user_id):
        """Revoke user's consent"""
        if user_id in self.consent_data:
            self.consent_data[user_id]['consented'] = False
            self.consent_data[user_id]['revoked_at'] = datetime.now(timezone.utc).isoformat()
            self._save_consent()
            secure_log("[OK] Consent revoked for user", user_id=user_id)

    def get_consent_info(self, user_id):
        """Get consent information for a user"""
        return self.consent_data.get(user_id, {})


# ============================================================================
# PAUSE POPUP WINDOW
# ============================================================================

class PausePopupWindow:
    """Floating always-on-top clock-style window that shows pause status with timer controls"""

    def __init__(self, on_resume_callback=None, on_set_timer_callback=None, on_close_callback=None, selection_mode=False):
        self.on_resume_callback = on_resume_callback
        self.on_set_timer_callback = on_set_timer_callback  # Callback to set timed pause
        self.on_close_callback = on_close_callback  # Callback when popup is closed (not resumed)
        self.selection_mode = selection_mode  # True = selecting duration before pause, False = already paused
        self.window = None
        self.timer_label = None
        self.title_label = None
        self.status_label = None
        self.canvas = None
        self.pause_start_time = None
        self.pause_end_time = None  # For timed pause countdown
        self.is_timed_pause = False
        self.running = False
        self._update_job = None
        self._drag_data = {"x": 0, "y": 0}
        self.duration_combo = None
        self.duration_options = None

    def show(self, pause_start_time=None, pause_end_time=None):
        """Show the pause popup window"""
        if not TKINTER_AVAILABLE:
            print("[WARN] Cannot show pause popup - tkinter not available")
            return

        self.pause_start_time = pause_start_time
        self.pause_end_time = pause_end_time
        self.is_timed_pause = pause_end_time is not None
        self.running = True

        # Run tkinter in a separate thread
        thread = threading.Thread(target=self._create_window, daemon=True)
        thread.start()

    def _create_window(self):
        """Create and run the tkinter window"""
        try:
            # Prevent implicit root window creation
            # This ensures no extra empty "tk" window appears
            self.window = tk.Tk()
            self.window.withdraw()  # Hide immediately to prevent flash
            self.window.title("Time Tracker - Paused")

            # Window configuration
            self.window.overrideredirect(True)  # Remove window decorations
            self.window.attributes('-topmost', True)  # Always on top
            self.window.attributes('-alpha', 0.95)  # Slight transparency

            # Window size and position (bottom right corner)
            window_width = 340  # Slightly wider for better visibility
            # Selection mode has smaller height (no clock display)
            window_height = 280 if self.selection_mode else 420
            # Position popup on the focused monitor's work area (P2-14)
            default_fallback = (
                0, 0,
                self.window.winfo_screenwidth(),
                self.window.winfo_screenheight()
            )
            left, top, right, bottom = get_focused_monitor_work_rect(
                fallback=default_fallback
            )
            x = right - window_width - 20
            y = bottom - window_height - 20  # Work rect excludes taskbar
            self.window.geometry(f"{window_width}x{window_height}+{x}+{y}")

            # Colors
            bg_color = '#1a1a2e'
            card_color = '#16213e'
            accent_color = '#FBBF24'  # Yellow/amber for paused
            text_color = '#ffffff'
            muted_color = '#9ca3af'
            green_color = '#10b981'

            # Main frame
            main_frame = tk.Frame(self.window, bg=bg_color, padx=3, pady=3)
            main_frame.pack(fill='both', expand=True)

            # Inner frame
            inner_frame = tk.Frame(main_frame, bg=card_color, padx=16, pady=12)
            inner_frame.pack(fill='both', expand=True)

            # Header with title and close button
            header_frame = tk.Frame(inner_frame, bg=card_color)
            header_frame.pack(fill='x', pady=(0, 8))

            # Title - different text based on mode
            if self.selection_mode:
                title_text = "⏱  PAUSE TRACKING"
            else:
                title_text = "⏸  PAUSED"
            
            self.title_label = tk.Label(
                header_frame,
                text=title_text,
                font=('Segoe UI', 14, 'bold'),
                fg=accent_color,
                bg=card_color
            )
            self.title_label.pack(side='left')

            # Close button (X) - just closes popup
            close_btn = tk.Label(
                header_frame,
                text="✕",
                font=('Segoe UI', 12),
                fg='#6b7280',
                bg=card_color,
                cursor='hand2'
            )
            close_btn.pack(side='right')
            close_btn.bind('<Button-1>', lambda e: self._close_only())
            close_btn.bind('<Enter>', lambda e: close_btn.config(fg='#ef4444'))
            close_btn.bind('<Leave>', lambda e: close_btn.config(fg='#6b7280'))

            if self.selection_mode:
                # Selection mode: Show instruction text instead of clock
                instruction_label = tk.Label(
                    inner_frame,
                    text="Select how long you want to\npause time tracking:",
                    font=('Segoe UI', 11),
                    fg=text_color,
                    bg=card_color,
                    justify='center'
                )
                instruction_label.pack(pady=(20, 20))
            else:
                # Paused mode: Show clock and timer
                # Clock circle canvas
                clock_frame = tk.Frame(inner_frame, bg=card_color)
                clock_frame.pack(pady=8)

                self.canvas = tk.Canvas(
                    clock_frame,
                    width=140,
                    height=140,
                    bg=card_color,
                    highlightthickness=0
                )
                self.canvas.pack()

                # Draw clock circle
                self._draw_clock_face()

                # Timer display in center of clock
                self.timer_label = tk.Label(
                    clock_frame,
                    text="00:00",
                    font=('Segoe UI Semibold', 22),
                    fg=text_color,
                    bg=card_color
                )
                self.timer_label.place(relx=0.5, rely=0.5, anchor='center')

                # Status label (Paused for / Resumes in)
                self.status_label = tk.Label(
                    inner_frame,
                    text="Paused for:" if not self.is_timed_pause else "Resumes in:",
                    font=('Segoe UI', 10),
                    fg=muted_color,
                    bg=card_color
                )
                self.status_label.pack(pady=(0, 12))

                # Prominent Resume button (at the top for easy access)
                resume_btn_top = tk.Button(
                    inner_frame,
                    text="▶  Resume Tracking Now",
                    font=('Segoe UI', 12, 'bold'),
                    fg='white',
                    bg=green_color,
                    activebackground='#059669',
                    activeforeground='white',
                    relief='flat',
                    cursor='hand2',
                    pady=10,
                    command=self._on_resume
                )
                resume_btn_top.pack(fill='x', pady=(0, 10))
                resume_btn_top.bind('<Enter>', lambda e: resume_btn_top.config(bg='#059669'))
                resume_btn_top.bind('<Leave>', lambda e: resume_btn_top.config(bg=green_color))

                # Separator label
                separator_label = tk.Label(
                    inner_frame,
                    text="─ OR SET AUTO-RESUME ─",
                    font=('Segoe UI', 8),
                    fg=muted_color,
                    bg=card_color
                )
                separator_label.pack(pady=(0, 12))

            # Duration picker section (Apple-style dropdown)
            picker_section = tk.Frame(inner_frame, bg=card_color)
            picker_section.pack(pady=(8, 8), fill='x')

            picker_label = tk.Label(
                picker_section,
                text="Select auto-resume duration:",
                font=('Segoe UI', 10, 'bold'),
                fg=text_color,
                bg=card_color
            )
            picker_label.pack(pady=(0, 10))

            # Duration options (in minutes) with display labels
            self.duration_options = [
                ("5 minutes", 5),
                ("10 minutes", 10),
                ("15 minutes", 15),
                ("20 minutes", 20),
                ("30 minutes", 30),
                ("45 minutes", 45),
                ("1 hour", 60),
                ("1.5 hours", 90),
                ("2 hours", 120),
                ("3 hours", 180),
            ]
            
            # Style the combobox for dark theme
            style = ttk.Style(self.window)  # Pass window as master to avoid creating implicit root
            style.theme_use('clam')
            style.configure('Dark.TCombobox',
                fieldbackground='#374151',
                background='#374151',
                foreground=text_color,
                arrowcolor=text_color,
                bordercolor='#4b5563',
                lightcolor='#4b5563',
                darkcolor='#4b5563',
                selectbackground=green_color,
                selectforeground='white'
            )
            style.map('Dark.TCombobox',
                fieldbackground=[('readonly', '#374151')],
                selectbackground=[('readonly', green_color)],
                selectforeground=[('readonly', 'white')]
            )

            # Picker row with dropdown and button
            picker_row = tk.Frame(picker_section, bg=card_color)
            picker_row.pack(fill='x')

            # Create combobox dropdown
            display_values = [opt[0] for opt in self.duration_options]
            self.duration_combo = ttk.Combobox(
                picker_row,
                values=display_values,
                state='readonly',
                width=15,
                font=('Segoe UI', 11),
                style='Dark.TCombobox'
            )
            self.duration_combo.set("15 minutes")  # Default selection
            self.duration_combo.pack(side='left', padx=(0, 10), ipady=6)

            # Set timer button - different text based on mode
            btn_text = "⏸  Pause Tracking" if self.selection_mode else "Set Timer"
            set_btn = tk.Button(
                picker_row,
                text=btn_text,
                font=('Segoe UI', 10, 'bold'),
                fg='white',
                bg=green_color,
                activebackground='#059669',
                activeforeground='white',
                relief='flat',
                cursor='hand2',
                padx=16,
                pady=8,
                command=self._set_selected_duration
            )
            set_btn.pack(side='left')
            set_btn.bind('<Enter>', lambda e: set_btn.config(bg='#059669'))
            set_btn.bind('<Leave>', lambda e: set_btn.config(bg=green_color))

            # In selection mode, add a Cancel button
            if self.selection_mode:
                cancel_btn = tk.Button(
                    inner_frame,
                    text="Cancel",
                    font=('Segoe UI', 10),
                    fg=text_color,
                    bg='#374151',
                    activebackground='#4b5563',
                    activeforeground=text_color,
                    relief='flat',
                    cursor='hand2',
                    pady=8,
                    command=self._close_only
                )
                cancel_btn.pack(fill='x', pady=(12, 0))
                cancel_btn.bind('<Enter>', lambda e: cancel_btn.config(bg='#4b5563'))
                cancel_btn.bind('<Leave>', lambda e: cancel_btn.config(bg='#374151'))

            # Make window draggable from header
            header_frame.bind('<Button-1>', self._start_drag)
            header_frame.bind('<B1-Motion>', self._on_drag)
            self.title_label.bind('<Button-1>', self._start_drag)
            self.title_label.bind('<B1-Motion>', self._on_drag)

            # Start timer updates only in paused mode (not selection mode)
            if not self.selection_mode:
                self._update_timer()

            # Show the window now that it's fully configured
            self.window.deiconify()
            
            # Run the window
            self.window.mainloop()
            
            # After mainloop exits, clean up in the same thread
            # This prevents the "Tcl_AsyncDelete: async handler deleted by the wrong thread" error
            try:
                if self.window:
                    self.window.destroy()
            except:
                pass
            finally:
                # Clear all tkinter references
                self.window = None
                self.timer_label = None
                self.title_label = None
                self.status_label = None
                self.canvas = None
                self.duration_combo = None

        except Exception as e:
            print(f"[ERROR] Failed to create pause popup: {e}")
        finally:
            self.running = False
            # Ensure all references are cleared
            self.window = None
            self.timer_label = None
            self.title_label = None
            self.status_label = None
            self.canvas = None
            self.duration_combo = None

    def _draw_clock_face(self):
        """Draw a clock-like circular face"""
        if not self.canvas:
            return

        # Clear canvas
        self.canvas.delete("all")

        cx, cy = 70, 70  # Center
        radius = 60

        # Outer ring (amber/yellow for paused state)
        self.canvas.create_oval(
            cx - radius, cy - radius,
            cx + radius, cy + radius,
            outline='#FBBF24',
            width=4
        )

        # Inner circle (darker)
        inner_radius = radius - 8
        self.canvas.create_oval(
            cx - inner_radius, cy - inner_radius,
            cx + inner_radius, cy + inner_radius,
            fill='#0f0f1a',
            outline='#374151',
            width=1
        )

        # Hour markers (12 small lines)
        import math
        for i in range(12):
            angle = math.radians(i * 30 - 90)
            x1 = cx + (radius - 12) * math.cos(angle)
            y1 = cy + (radius - 12) * math.sin(angle)
            x2 = cx + (radius - 18) * math.cos(angle)
            y2 = cy + (radius - 18) * math.sin(angle)
            self.canvas.create_line(x1, y1, x2, y2, fill='#6b7280', width=2)

    def _draw_progress_arc(self, progress):
        """Draw progress arc around the clock (0.0 to 1.0)"""
        if not self.canvas or progress <= 0:
            return

        cx, cy = 70, 70
        radius = 60

        # Draw arc (progress from top, clockwise)
        import math
        start_angle = 90  # Start from top
        extent = -360 * min(progress, 1.0)  # Clockwise

        self.canvas.create_arc(
            cx - radius, cy - radius,
            cx + radius, cy + radius,
            start=start_angle,
            extent=extent,
            outline='#10b981',  # Green progress
            width=4,
            style='arc'
        )

    def _start_drag(self, event):
        """Start dragging the window"""
        self._drag_data["x"] = event.x
        self._drag_data["y"] = event.y

    def _on_drag(self, event):
        """Handle window dragging"""
        if self.window:
            x = self.window.winfo_x() + (event.x - self._drag_data["x"])
            y = self.window.winfo_y() + (event.y - self._drag_data["y"])
            self.window.geometry(f"+{x}+{y}")

    def _update_timer(self):
        """Update the timer display"""
        if not self.running or not self.window:
            return

        try:
            current_time = time.time()

            if self.is_timed_pause and self.pause_end_time:
                # Countdown mode
                remaining = self.pause_end_time - current_time
                if remaining <= 0:
                    # Timer expired - auto resume
                    self._on_resume()
                    return

                total_duration = self.pause_end_time - self.pause_start_time
                elapsed = current_time - self.pause_start_time
                progress = elapsed / total_duration if total_duration > 0 else 0

                minutes = int(remaining // 60)
                seconds = int(remaining % 60)

                # Update status label
                if self.status_label:
                    self.status_label.config(text="Resumes in:")

                # Redraw clock with progress
                self._draw_clock_face()
                self._draw_progress_arc(progress)

            else:
                # Count up mode (indefinite pause)
                elapsed = current_time - self.pause_start_time
                minutes = int(elapsed // 60)
                seconds = int(elapsed % 60)

                # Update status label
                if self.status_label:
                    self.status_label.config(text="Paused for:")

            # Format time string
            if minutes >= 60:
                hours = minutes // 60
                minutes = minutes % 60
                time_str = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
            else:
                time_str = f"{minutes:02d}:{seconds:02d}"

            if self.timer_label:
                self.timer_label.config(text=time_str)

            # Schedule next update
            if self.running and self.window:
                self._update_job = self.window.after(1000, self._update_timer)

        except Exception as e:
            print(f"[WARN] Timer update error: {e}")

    def _set_timer(self, minutes):
        """Set a countdown timer for auto-resume"""
        self.pause_end_time = time.time() + (minutes * 60)
        self.is_timed_pause = True

        # Notify the main app about the timed pause (in a separate thread)
        if self.on_set_timer_callback:
            threading.Thread(target=self.on_set_timer_callback, args=(minutes,), daemon=True).start()

        print(f"[INFO] Auto-resume set for {minutes} minutes")

    def _set_selected_duration(self):
        """Set timer from dropdown selection"""
        try:
            if not self.duration_combo or not self.duration_options:
                return

            selected_text = self.duration_combo.get()
            if not selected_text:
                return
            
            # Find the minutes value for the selected option
            minutes = None
            for label, value in self.duration_options:
                if label == selected_text:
                    minutes = value
                    break
            
            if minutes is None:
                print(f"[WARN] Unknown duration selected: {selected_text}")
                return
            
            # In selection mode, close popup after triggering callback
            if self.selection_mode:
                if not self.running:
                    return  # Already closing
                self.running = False
                self._quit_mainloop()
                # Call the callback to actually pause tracking
                if self.on_set_timer_callback:
                    threading.Thread(target=self.on_set_timer_callback, args=(minutes,), daemon=True).start()
            else:
                # Normal paused mode - just set the timer
                self._set_timer(minutes)
            
        except Exception as e:
            print(f"[WARN] Error setting timer from dropdown: {e}")

    def _on_resume(self):
        """Handle resume button click"""
        if not self.running:
            return  # Already closing
        self.running = False
        # Quit the mainloop (cleanup happens after mainloop exits in _create_window)
        self._quit_mainloop()
        # Then call the callback in a separate thread to avoid blocking
        if self.on_resume_callback:
            threading.Thread(target=self.on_resume_callback, daemon=True).start()

    def _close_only(self):
        """Close the popup without resuming tracking"""
        if not self.running:
            return  # Already closing
        self.running = False
        # Quit the mainloop (cleanup happens after mainloop exits in _create_window)
        self._quit_mainloop()
        
        if self.selection_mode:
            print("[INFO] Pause selection cancelled")
        else:
            print("[INFO] Pause popup closed (tracking still paused)")
            
        # Notify main app that popup was closed
        if self.on_close_callback:
            threading.Thread(target=self.on_close_callback, daemon=True).start()

    def _quit_mainloop(self):
        """Quit the tkinter mainloop (cleanup happens after mainloop exits)"""
        try:
            if self._update_job and self.window:
                self.window.after_cancel(self._update_job)
                self._update_job = None
            if self.window:
                # Only quit the mainloop - don't destroy here
                # The destroy will happen after mainloop() returns in _create_window
                self.window.quit()
        except Exception as e:
            pass  # Window may already be closed

    def close(self):
        """Close the popup window (safe to call from any thread)"""
        if not self.running:
            return  # Already closed
        self.running = False
        try:
            if self.window:
                # Schedule quit on tkinter's thread
                self.window.after(0, self._quit_mainloop)
        except Exception as e:
            # Window might already be destroyed
            pass

    def update_for_timed_pause(self, pause_end_time):
        """Update the popup for a timed pause"""
        self.pause_end_time = pause_end_time
        self.is_timed_pause = True


# ============================================================================
# APPLICATION CLASSIFICATION MANAGER
# ============================================================================

# Lock screen / logon screen process names — these should NEVER be tracked
# as active work sessions. When the foreground window belongs to one of these,
# the user's screen is locked and any elapsed time is idle.
# FIX-3: Extended with Linux lock-screen process names so process_window_event()
# blocks them on Linux just as it does for lockapp.exe on Windows.
LOCK_SCREEN_APPS = {
    # Windows
    'lockapp.exe', 'logonui.exe',
    # Linux — common screen locker process names
    'gnome-screensaver', 'xscreensaver', 'i3lock', 'swaylock',
    'kscreenlocker_greet', 'xflock4', 'light-locker', 'slock',
    'physlock', 'xautolock', 'betterlockscreen',
}

# Browser process names — when one of these is the active process,
# we check the window title against URL-based entries instead of process-based.
BROWSER_PROCESSES = {
    'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe',
    'opera.exe', 'vivaldi.exe', 'arc.exe',
}

PROCESS_IDENTIFIER_ALIASES = {
    'code': 'vscode',
    'visualstudiocode': 'vscode',
    'vscode': 'vscode',
    'gitbash': 'gitbash',
    'gitbashterminal': 'gitbash',
    'teams': 'teams',
    'microsoftteams': 'teams',
    'msteams': 'teams',
    'jira': 'jira',
    'atlassianjira': 'jira',
    'chrome': 'chrome',
    'googlechrome': 'chrome',
    'firefox': 'firefox',
    'mozillafirefox': 'firefox',
    'edge': 'msedge',
    'msedge': 'msedge',
    'microsoftedge': 'msedge',
    'brave': 'brave',
    'bravebrowser': 'brave',
    'opera': 'opera',
    'vivaldi': 'vivaldi',
    'arc': 'arc',
}

BROWSER_PROCESS_NORMALIZED_KEYS = {
    'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc'
}


class AppClassificationManager:
    """Manages application classification lookups using local SQLite cache.

    Classifications are synced from Supabase and stored in SQLite.
    In-memory dicts provide O(1) lookup during tracking.
    """

    def __init__(self, db_manager):
        self.db_manager = db_manager
        # In-memory lookup dicts (populated from SQLite)
        self.process_classifications = {}  # exact identifier (lower) -> classification
        self.normalized_process_classifications = {}  # canonical identifier -> classification
        self.url_classifications = {}      # identifier (lower) -> classification
        self.url_wildcard_patterns = []    # [(pattern, classification)] for fnmatch
        self.reload_from_cache()

    def _normalize_process_identifier(self, identifier):
        """Normalize process identifiers so legacy names match real process names."""
        value = (identifier or '').strip().lower()
        value = re.sub(r'\.(exe|app|dmg|msi|deb|rpm|snap|flatpak|bin)$', '', value)
        value = re.sub(r'[\s\-_\.]+', '', value)
        return value

    def _canonical_process_key(self, identifier):
        normalized = self._normalize_process_identifier(identifier)
        return PROCESS_IDENTIFIER_ALIASES.get(normalized, normalized)

    def reload_from_cache(self):
        """Load classifications from SQLite into memory for fast lookup.

        Applies 3-tier merge precedence: global < organization < project.
        Rows are fetched in ascending priority order so that later writes
        into the in-memory dicts naturally override earlier (lower-priority) ones.

        Uses copy-on-write pattern: builds new dicts in locals, then atomically
        swaps references (single assignment is GIL-atomic).
        """
        new_process = {}
        new_normalized = {}
        new_url = {}
        new_wildcard = []
        try:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()
            # ORDER BY source priority ASC so higher-priority tiers overwrite lower ones
            cursor.execute('''
                SELECT identifier, classification, match_by
                FROM app_classifications_cache
                ORDER BY
                    CASE source
                        WHEN 'global'       THEN 0
                        WHEN 'organization' THEN 1
                        WHEN 'project'      THEN 2
                        ELSE 0
                    END ASC
            ''')
            for identifier, classification, match_by in cursor.fetchall():
                key = (identifier or '').lower().strip()
                if match_by == 'process':
                    new_process[key] = classification
                    canonical_key = self._canonical_process_key(identifier)
                    if canonical_key:
                        new_normalized[canonical_key] = classification
                elif match_by == 'url':
                    if '*' in identifier:
                        # Rebuild wildcard list: remove stale entry for same pattern
                        new_wildcard = [(p, c) for p, c in new_wildcard if p != key]
                        new_wildcard.append((key, classification))
                    else:
                        new_url[key] = classification
            # Atomic swap — single reference assignment is GIL-atomic
            self.process_classifications = new_process
            self.normalized_process_classifications = new_normalized
            self.url_classifications = new_url
            self.url_wildcard_patterns = new_wildcard
            total = len(new_process) + len(new_url) + len(new_wildcard)
            if total > 0:
                print(f"[OK] Loaded {total} app classifications into memory")
        except Exception as e:
            print(f"[WARN] Failed to load classifications from cache: {e}")

    def classify(self, app_name, window_title=''):
        """Classify an application based on process name and window title.

        Returns:
            tuple: (classification: str, match_type: str or None)
                classification: 'productive', 'non_productive', 'private', or 'unknown'
                match_type: 'process', 'url', 'browser_default', or None
        """
        app_lower = (app_name or '').lower().strip()
        app_canonical_key = self._canonical_process_key(app_name)

        # Check if it's a browser
        if app_lower in BROWSER_PROCESSES or app_canonical_key in BROWSER_PROCESS_NORMALIZED_KEYS:
            # Browser: check window title against URL entries first (most specific)
            title_lower = window_title.lower() if window_title else ''

            # Check exact URL matches first
            for url_key, classification in self.url_classifications.items():
                if url_key in title_lower:
                    return (classification, 'url')

            # Check wildcard patterns (e.g., *.atlassian.net, *.bank.*)
            for pattern, classification in self.url_wildcard_patterns:
                if fnmatch.fnmatch(title_lower, pattern):
                    return (classification, 'url')
                # Also check if any word in the title matches
                for word in title_lower.split():
                    if fnmatch.fnmatch(word, pattern):
                        return (classification, 'url')

            # No URL match — check if browser itself has a process-level classification
            # This allows admins to classify "chrome.exe" as productive/non_productive overall
            if app_lower in self.process_classifications:
                return (self.process_classifications[app_lower], 'process')
            if app_canonical_key in self.normalized_process_classifications:
                return (self.normalized_process_classifications[app_canonical_key], 'process')

            # No URL or process match — browser is unknown
            return ('unknown', 'browser_default')

        # Non-browser: check process name
        if app_lower in self.process_classifications:
            return (self.process_classifications[app_lower], 'process')
        if app_canonical_key in self.normalized_process_classifications:
            return (self.normalized_process_classifications[app_canonical_key], 'process')

        # No match found
        return ('unknown', None)

    def sync_classifications(self, supabase_client, organization_id, project_key=None, all_project_keys=None):
        """Fetch classifications from Supabase and write all 3 tiers to SQLite cache.

        Schema v2 strategy — store each tier as SEPARATE rows with a `source` tag:
          Tier 1 → source='global',       source_project_key=NULL
          Tier 2 → source='organization', source_project_key=NULL
          Tier 3 → source='project',      source_project_key=<project_key>

        The DB is NOT pre-merged; reload_from_cache() applies tier precedence
        (project > org > global) in memory at classify() time.

        This preserves full tier history so the /classifications page can show
        which tier each rule comes from and flag overridden rules.
        """
        try:
            all_rows = []   # list of (source, source_project_key, row_dict)
            defaults_count = 0
            org_count = 0
            project_count = 0

            # Tier 1: Global defaults
            result = supabase_client.table('application_classifications').select(
                'identifier, display_name, classification, match_by'
            ).eq('is_default', True).is_('organization_id', 'null').execute()
            defaults_rows = result.data or []
            defaults_count = len(defaults_rows)
            for row in defaults_rows:
                all_rows.append(('global', None, row))

            # Tier 2: Organization overrides
            if organization_id:
                result = supabase_client.table('application_classifications').select(
                    'identifier, display_name, classification, match_by'
                ).eq('organization_id', organization_id).is_('project_key', 'null').execute()
                org_rows = result.data or []
                org_count = len(org_rows)
                for row in org_rows:
                    all_rows.append(('organization', None, row))

            # Tier 3: Project overrides — load for ALL known projects so
            # multi-project users get correct classifications regardless of
            # which project is "current".
            project_keys_to_load = set()
            if project_key:
                project_keys_to_load.add(project_key)
            if all_project_keys:
                project_keys_to_load.update(all_project_keys)

            if organization_id and project_keys_to_load:
                for pk in project_keys_to_load:
                    try:
                        project_result = supabase_client.table('application_classifications').select(
                            'identifier, display_name, classification, match_by'
                        ).eq('organization_id', organization_id).eq('project_key', pk).execute()
                        project_rows = project_result.data or []
                        project_count += len(project_rows)
                        for row in project_rows:
                            all_rows.append(('project', pk, row))
                    except Exception as project_err:
                        print(f"[WARN] Project-level classification fetch failed for {pk}: {project_err}")

            # Write all tiers to SQLite — each row keeps its source tag
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()
            cursor.execute('DELETE FROM app_classifications_cache')
            for (source, source_project_key, row) in all_rows:
                cursor.execute('''
                    INSERT OR REPLACE INTO app_classifications_cache
                    (organization_id, source, source_project_key,
                     identifier, display_name, classification, match_by, cached_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ''', (
                    organization_id,
                    source,
                    source_project_key,
                    row['identifier'],
                    row.get('display_name', ''),
                    row['classification'],
                    row['match_by']
                ))
            conn.commit()

            total = len(all_rows)
            if project_keys_to_load:
                print(
                    f"[OK] Synced {total} app classification rows from Supabase "
                    f"({defaults_count} global, {org_count} org, {project_count} project "
                    f"for {sorted(project_keys_to_load)})"
                )
            else:
                print(
                    f"[OK] Synced {total} app classification rows from Supabase "
                    f"({defaults_count} global, {org_count} org)"
                )
            self.reload_from_cache()

        except Exception as e:
            try:
                self.db_manager.get_connection().rollback()
            except Exception:
                pass
            print(f"[WARN] Failed to sync classifications from Supabase: {e}")


class ActiveSessionManager:
    """Manages active_sessions SQLite table for real-time activity tracking.

    Tracks time accumulated per unique (window_title, application_name) pair.
    Thread-safe with a lock.
    """

    def __init__(self, db_manager):
        self.db_manager = db_manager
        self._lock = threading.Lock()
        self._current_key = None  # (window_title, application_name)
        self._pending_ocr_keys = set()  # Sessions that need OCR backfill
        self._pending_ocr_screenshots = {}  # (title, app) -> PIL.Image for throttled sessions

    def get_pending_ocr_entries(self):
        """Return and clear the dict of (title, app_name) -> PIL.Image awaiting OCR backfill."""
        with self._lock:
            entries = dict(self._pending_ocr_screenshots)
            self._pending_ocr_screenshots.clear()
            self._pending_ocr_keys.clear()
            return entries

    def get_pending_ocr_keys(self):
        """Return and clear the set of (title, app_name) keys awaiting OCR backfill.
        DEPRECATED: prefer get_pending_ocr_entries() which also returns saved screenshots.
        """
        with self._lock:
            keys = self._pending_ocr_keys.copy()
            self._pending_ocr_keys.clear()
            return keys

    def add_pending_ocr_screenshot(self, title, app_name, screenshot):
        """Add a screenshot for later OCR backfill (used when OCR queue is full after session created)."""
        with self._lock:
            key = (title, app_name)
            self._pending_ocr_keys.add(key)
            if screenshot is not None:
                self._pending_ocr_screenshots[key] = screenshot

    def backfill_ocr(self, title, app_name, ocr_result):
        """Fill in OCR data for a session that was previously throttled."""
        if not ocr_result or ocr_result.get('throttled'):
            return
        with self._lock:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()
            try:
                cursor.execute(
                    'SELECT id, ocr_method FROM active_sessions WHERE window_title = ? AND application_name = ?',
                    (title, app_name)
                )
                row = cursor.fetchone()
                if row and not row[1]:
                    ocr_text = ocr_result.get('text')
                    ocr_method = ocr_result.get('method')
                    ocr_confidence = ocr_result.get('confidence')
                    ocr_error = ocr_result.get('error_message')
                    cursor.execute(
                        'UPDATE active_sessions SET ocr_text = ?, ocr_method = ?, ocr_confidence = ?, ocr_error_message = ? WHERE id = ?',
                        (ocr_text, ocr_method, ocr_confidence, ocr_error, row[0])
                    )
                    conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"[WARN] OCR backfill failed: {e}")

    def on_window_switch(self, title, app_name, classification, ocr_result=None):
        """Handle a window switch event.

        Stops timer on previous session, creates or resumes session for new window.
        
        Args:
            title: Window title
            app_name: Application name
            classification: Activity classification (productive, non_productive, private, unknown)
            ocr_result: Optional dict with keys: text, method, confidence, error_message,
                        screenshot (PIL.Image, present when throttled)
        """
        with self._lock:
            now = datetime.now(timezone.utc).isoformat()
            new_key = (title, app_name)

            ocr_text = None
            ocr_method = None
            ocr_confidence = None
            ocr_error_message = None
            ocr_was_throttled = False
            throttled_screenshot = None
            
            if ocr_result:
                if isinstance(ocr_result, dict):
                    ocr_was_throttled = ocr_result.get('throttled', False)
                    throttled_screenshot = ocr_result.get('screenshot')
                    if not ocr_was_throttled:
                        ocr_text = ocr_result.get('text')
                        ocr_method = ocr_result.get('method')
                        ocr_confidence = ocr_result.get('confidence')
                        ocr_error_message = ocr_result.get('error_message')
                else:
                    ocr_text = ocr_result

            has_ocr_data = ocr_text or ocr_method

            conn = self.db_manager.get_connection()
            cursor = conn.cursor()

            try:
                if self._current_key is not None:
                    self._stop_timer_internal(cursor, now)

                cursor.execute(
                    'SELECT id, total_time_seconds, visit_count, ocr_method FROM active_sessions WHERE window_title = ? AND application_name = ?',
                    (title, app_name)
                )
                existing = cursor.fetchone()

                if existing:
                    session_id, total_time, visit_count, existing_ocr_method = existing
                    cursor.execute(
                        'UPDATE active_sessions SET visit_count = ?, timer_started_at = ?, last_seen = ?, classification = ? WHERE id = ?',
                        (visit_count + 1, now, now, classification, session_id)
                    )
                    if has_ocr_data:
                        cursor.execute(
                            'UPDATE active_sessions SET ocr_text = ?, ocr_method = ?, ocr_confidence = ?, ocr_error_message = ? WHERE id = ?',
                            (ocr_text, ocr_method, ocr_confidence, ocr_error_message, session_id)
                        )
                    elif ocr_was_throttled and not existing_ocr_method:
                        self._pending_ocr_keys.add(new_key)
                        if throttled_screenshot is not None:
                            self._pending_ocr_screenshots[new_key] = throttled_screenshot
                else:
                    if ocr_was_throttled:
                        self._pending_ocr_keys.add(new_key)
                        if throttled_screenshot is not None:
                            self._pending_ocr_screenshots[new_key] = throttled_screenshot
                    cursor.execute(
                        '''INSERT INTO active_sessions
                        (window_title, application_name, classification, ocr_text, ocr_method, ocr_confidence, ocr_error_message, total_time_seconds, visit_count, first_seen, last_seen, timer_started_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)''',
                        (title, app_name, classification, ocr_text, ocr_method, ocr_confidence, ocr_error_message, now, now, now)
                    )

                self._current_key = new_key
                conn.commit()
            except Exception as e:
                print(f"[ERROR] ActiveSessionManager.on_window_switch: {e}")
                conn.rollback()

    def _stop_timer_internal(self, cursor, now):
        """Stop the timer on the currently active session (internal, must hold lock)."""
        if self._current_key is None:
            return

        title, app_name = self._current_key
        cursor.execute(
            'SELECT id, total_time_seconds, timer_started_at FROM active_sessions WHERE window_title = ? AND application_name = ?',
            (title, app_name)
        )
        row = cursor.fetchone()
        if row and row[2]:  # timer_started_at is not None
            session_id, total_time, timer_started = row
            try:
                started = datetime.fromisoformat(timer_started)
                ended = datetime.fromisoformat(now)
                elapsed = max(0, (ended - started).total_seconds())
                new_total = (total_time or 0) + elapsed
                cursor.execute(
                    'UPDATE active_sessions SET total_time_seconds = ?, timer_started_at = NULL, last_seen = ? WHERE id = ?',
                    (new_total, now, session_id)
                )
            except Exception as e:
                print(f"[WARN] Error stopping timer: {e}")

    def stop_current_timer(self):
        """Stop timer on the current session (public, acquires lock)."""
        with self._lock:
            conn = self.db_manager.get_connection()
            try:
                now = datetime.now(timezone.utc).isoformat()
                cursor = conn.cursor()
                self._stop_timer_internal(cursor, now)
                conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"[ERROR] stop_current_timer failed: {e}")

    def start_new_timer(self):
        """Reset _current_key so the next window switch starts a fresh session.

        The pre-idle row's timer was already nulled by stop_current_timer();
        if a batch upload ran during idle, the row may have been harvested.
        Clearing _current_key avoids a stale lookup on the next
        on_window_switch() call.
        """
        with self._lock:
            self._current_key = None

    def get_all_sessions(self):
        """Get all sessions for batch upload."""
        with self._lock:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()
            cursor.execute('SELECT * FROM active_sessions')
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            return [dict(zip(columns, row)) for row in rows]

    def clear_all(self):
        """Clear all sessions after successful batch upload."""
        with self._lock:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()
            try:
                cursor.execute('DELETE FROM active_sessions')
                conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"[ERROR] clear_all failed: {e}")
            self._current_key = None

    def harvest_and_clear(self, min_duration_seconds=0):
        """Atomically harvest all sessions and clear the table under a single lock.

        Returns only sessions with total_time_seconds >= min_duration_seconds.
        Sessions below the threshold are also deleted (noise).
        New sessions written after this call will be stored normally.

        This prevents the TOCTOU race condition where new sessions could be
        inserted between separate get_all_sessions() and clear_all() calls.
        """
        with self._lock:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()
            try:
                # Stop any running timer first so accumulated time is accurate
                now = datetime.now(timezone.utc).isoformat()
                self._stop_timer_internal(cursor, now)

                # Read all sessions
                cursor.execute('SELECT * FROM active_sessions')
                columns = [desc[0] for desc in cursor.description]
                rows = cursor.fetchall()

                # Clear the table
                cursor.execute('DELETE FROM active_sessions')
                conn.commit()
            except Exception as e:
                print(f"[ERROR] harvest_and_clear failed: {e}")
                conn.rollback()
                return []

            self._current_key = None
            all_sessions = [dict(zip(columns, row)) for row in rows]

            if min_duration_seconds > 0:
                valid = [s for s in all_sessions
                         if (s.get('total_time_seconds') or 0) >= min_duration_seconds]
                filtered = len(all_sessions) - len(valid)
                if filtered > 0:
                    print(f"[BATCH] Filtered {filtered} noise sessions (< {min_duration_seconds}s)")
                return valid
            return all_sessions

    def restore_sessions(self, sessions):
        """Re-insert sessions back into SQLite after a failed upload.

        Used to restore data when batch upload to Supabase fails,
        so records are not lost and can be retried on the next cycle.
        """
        if not sessions:
            return
        with self._lock:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()
            try:
                for s in sessions:
                    cursor.execute(
                        '''INSERT OR REPLACE INTO active_sessions
                        (window_title, application_name, classification, ocr_text, ocr_method,
                         ocr_confidence, ocr_error_message, total_time_seconds, visit_count,
                         first_seen, last_seen, timer_started_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                        (s.get('window_title'), s.get('application_name'),
                         s.get('classification'), s.get('ocr_text'),
                         s.get('ocr_method'), s.get('ocr_confidence'),
                         s.get('ocr_error_message'), s.get('total_time_seconds', 0),
                         s.get('visit_count', 1), s.get('first_seen'),
                         s.get('last_seen'), s.get('timer_started_at'))
                    )
                conn.commit()
                print(f"[BATCH] Restored {len(sessions)} sessions to SQLite for retry")
            except Exception as e:
                print(f"[ERROR] Failed to restore sessions: {e}")
                conn.rollback()

    def update_classification(self, app_name, old_classification, new_classification):
        """Thread-safe update of classification for an app (called from async classify thread)."""
        with self._lock:
            conn = self.db_manager.get_connection()
            cursor = conn.cursor()
            try:
                cursor.execute(
                    'UPDATE active_sessions SET classification = ? WHERE application_name = ? AND classification = ?',
                    (new_classification, app_name, old_classification)
                )
                conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"[WARN] Failed to update classification: {e}")


class LocalOCRProcessor:
    """Handles local OCR processing using the dynamic OCR facade.

    Uses the OCR facade which reads configuration from environment variables:
    - OCR_PRIMARY_ENGINE (default: rapidocr)
    - OCR_FALLBACK_ENGINES (default: winrtocr)
    - Engine-specific settings (OCR_RAPIDOCR_MIN_CONFIDENCE, etc.)

    OCR models are automatically downloaded on first run if not present.

    Captures screenshot in memory, extracts text via configured engines, discards image.
    Throttled to max once per 3 seconds to limit CPU spikes on rapid switching.
    """

    def __init__(self):
        self._last_ocr_time = 0
        self._min_interval = 10  # seconds between OCR calls (matches min_screenshot_interval in tracking_loop)
        print("[OCR] LocalOCRProcessor initialized - using dynamic engine selection")

        # Detect a broken OpenCV install early (common in mixed opencv wheels).
        self._validate_cv2_runtime()

        # Log which OCR engines are configured from environment (with defaults)
        primary = os.getenv('OCR_PRIMARY_ENGINE', 'rapidocr')
        fallback = os.getenv('OCR_FALLBACK_ENGINES', 'winrtocr')
        print(f"[OCR] Primary engine: {primary}, Fallback: {fallback}")

        # Async OCR worker infrastructure
        self._ocr_queue = queue.Queue(maxsize=1)
        self._ocr_done_event = threading.Event()
        self._ocr_done_event.set()  # No job in-flight initially
        self._ocr_worker_thread = threading.Thread(
            target=self._ocr_worker, daemon=True, name="OCR-Worker"
        )
        self._ocr_worker_thread.start()
        print("[OCR] Async OCR worker thread started")

    def _validate_cv2_runtime(self):
        """Log actionable diagnostics when cv2 is importable but unusable."""
        try:
            import cv2  # noqa: F401

            has_cvt = hasattr(cv2, 'cvtColor')
            has_split = hasattr(cv2, 'split')
            cv2_file = getattr(cv2, '__file__', None)

            if not has_cvt or not has_split:
                print("[OCR][ERROR] OpenCV runtime is broken: cv2 is missing required functions")
                print(f"[OCR][ERROR] cv2.__file__={cv2_file}")
                print("[OCR][ERROR] OCR will fall back to metadata-only mode until OpenCV is fixed")
                print("[OCR][ERROR] Fix: pip uninstall -y opencv-python opencv-python-headless && pip install opencv-python-headless==4.10.0.84")
            else:
                print(f"[OCR] OpenCV check OK: cv2 available ({cv2_file})")
        except Exception as e:
            print(f"[OCR][WARN] Could not validate cv2 runtime: {e}")

    def _ocr_worker(self):
        """Background worker thread that runs OCR inference at below-normal priority."""
        # Lower thread priority on Windows to reduce UI lag during OCR.
        # THREAD_MODE_BACKGROUND_BEGIN tells the OS to deprioritize this thread's
        # CPU, memory, AND I/O scheduling — more aggressive than BELOW_NORMAL alone.
        if sys.platform == 'win32':
            try:
                import ctypes
                handle = ctypes.windll.kernel32.GetCurrentThread()
                THREAD_PRIORITY_BELOW_NORMAL = -1
                THREAD_MODE_BACKGROUND_BEGIN = 0x00010000
                # Set background mode first (deprioritizes CPU + I/O + memory)
                ctypes.windll.kernel32.SetThreadPriority(handle, THREAD_MODE_BACKGROUND_BEGIN)
                # Then also set BELOW_NORMAL as a belt-and-suspenders CPU priority hint
                ctypes.windll.kernel32.SetThreadPriority(handle, THREAD_PRIORITY_BELOW_NORMAL)
                print("[OCR] Worker thread set to BACKGROUND mode + BELOW_NORMAL priority")
            except Exception as e:
                print(f"[OCR] Could not lower worker thread priority: {e}")

        while True:
            job = self._ocr_queue.get()
            if job is None:
                # Sentinel — shutdown requested
                break
            screenshot, callback = job
            try:
                ocr_start = time.perf_counter()
                ocr_result = extract_text_from_image(
                    screenshot,
                    window_title='',
                    app_name='',
                    screenshot_mode=True
                )
                ocr_elapsed_ms = (time.perf_counter() - ocr_start) * 1000.0
                self._last_ocr_time = time.time()

                text = ocr_result.get('text', '')
                method = ocr_result.get('method', 'unknown')
                confidence = ocr_result.get('confidence', 0.0)
                success = ocr_result.get('success', False)
                prep_ms = ocr_result.get('prep_ms')
                infer_ms = ocr_result.get('infer_ms')
                total_ms = ocr_result.get('total_ms')

                if text and len(text) > 2000:
                    text = text[:2000]

                if success and text:
                    print(
                        f"[OCR-ASYNC] {method} "
                        f"(confidence: {confidence:.2f}, took: {ocr_elapsed_ms:.1f}ms, "
                        f"prep: {prep_ms if prep_ms is not None else 'NA'}ms, "
                        f"infer: {infer_ms if infer_ms is not None else 'NA'}ms, "
                        f"total: {total_ms if total_ms is not None else 'NA'}ms)"
                    )
                else:
                    print(
                        f"[OCR-ASYNC] capture failed ({method}) "
                        f"(took: {ocr_elapsed_ms:.1f}ms)"
                    )

                final_result = {
                    'text': text.strip() if text else None,
                    'method': method,
                    'confidence': confidence,
                    'error_message': None if success else f"OCR failed with method: {method}",
                    'prep_ms': prep_ms,
                    'infer_ms': infer_ms,
                    'total_ms': total_ms,
                    'screenshot': None
                }
                callback(final_result)
            except Exception as e:
                print(f"[OCR-ASYNC] Worker error: {e}")
                try:
                    callback({
                        'text': None, 'method': 'error', 'confidence': 0.0,
                        'error_message': str(e), 'screenshot': None
                    })
                except Exception:
                    pass
            finally:
                del screenshot
                self._ocr_done_event.set()

        print("[OCR] Worker thread exiting")

    def submit_ocr_async(self, screenshot, callback):
        """Submit a screenshot for async OCR processing.

        Args:
            screenshot: PIL.Image to OCR
            callback: callable(ocr_result_dict) invoked from worker thread when done

        Returns:
            bool: True if job was submitted, False if queue was full (caller should
                  save the screenshot for batch backfill instead of losing it).
        """
        self._ocr_done_event.clear()
        try:
            self._ocr_queue.put_nowait((screenshot, callback))
            return True
        except queue.Full:
            print("[OCR-ASYNC] Queue full — previous OCR still running, saving for batch backfill")
            self._ocr_done_event.set()
            return False

    def wait_for_ocr(self, timeout=5.0):
        """Block until any in-flight async OCR job finishes.

        Returns True if OCR completed (or no job was running), False on timeout.
        """
        return self._ocr_done_event.wait(timeout=timeout)

    def capture_screenshot_only(self, force=False):
        """Capture screenshot without running OCR (for async dispatch).

        Returns:
            dict with 'screenshot' (PIL.Image or None) and 'throttled' (bool)
        """
        now = time.time()
        if not force and (now - self._last_ocr_time) < self._min_interval:
            screenshot = capture_focused_monitor()
            return {'screenshot': screenshot, 'throttled': True}

        screenshot = capture_focused_monitor()
        if screenshot is None:
            print("[OCR] Screenshot capture skipped (no valid monitor target)")
        return {'screenshot': screenshot, 'throttled': False}

    def shutdown(self):
        """Stop the OCR worker thread gracefully."""
        try:
            self._ocr_queue.put_nowait(None)
        except queue.Full:
            # Queue is full with a real job; wait for it, then re-send sentinel
            self._ocr_done_event.wait(timeout=30)
            try:
                self._ocr_queue.put_nowait(None)
            except queue.Full:
                pass
        self._ocr_worker_thread.join(timeout=10)
        print("[OCR] Worker thread shut down")

    def capture_and_ocr(self, force=False):
        """Capture screenshot in memory and extract text via OCR facade.

        Uses the dynamic OCR system configured via environment variables.
        Automatically falls back to alternative engines if primary fails.

        Returns:
            dict: OCR result with keys:
                - text (str or None): Extracted text
                - method (str): OCR engine used (e.g., 'rapidocr', 'winrtocr', 'metadata')
                - confidence (float): Confidence score (0.0 to 1.0)
                - error_message (str or None): Error message if OCR failed
                - throttled (bool): True if OCR was skipped due to rate limiting
                - screenshot (PIL.Image or None): The captured screenshot when throttled,
                  so callers can save it for later OCR backfill instead of losing the image
        """
        now = time.time()
        if not force and (now - self._last_ocr_time) < self._min_interval:
            # Throttled: still capture the screenshot so the caller can save it
            # for later backfill with the ORIGINAL image, not a new one
            screenshot = capture_focused_monitor()
            return {
                'text': None, 'method': None, 'confidence': 0.0,
                'error_message': None, 'throttled': True,
                'screenshot': screenshot
            }

        try:
            screenshot = capture_focused_monitor()
            if screenshot is None:
                return {
                    'text': None, 'method': None, 'confidence': 0.0,
                    'error_message': 'No valid monitor target (minimized/cloaked)',
                    'throttled': False, 'screenshot': None
                }
            ocr_start = time.perf_counter()

            ocr_result = extract_text_from_image(
                screenshot,
                window_title='',
                app_name='',
                screenshot_mode=True
            )
            ocr_elapsed_ms = (time.perf_counter() - ocr_start) * 1000.0

            del screenshot

            self._last_ocr_time = time.time()

            text = ocr_result.get('text', '')
            method = ocr_result.get('method', 'unknown')
            confidence = ocr_result.get('confidence', 0.0)
            success = ocr_result.get('success', False)
            prep_ms = ocr_result.get('prep_ms')
            infer_ms = ocr_result.get('infer_ms')
            total_ms = ocr_result.get('total_ms')
            
            if success and text:
                print(
                    f"[OCR] Event-based capture: {method} "
                    f"(confidence: {confidence:.2f}, took: {ocr_elapsed_ms:.1f}ms, "
                    f"prep: {prep_ms if prep_ms is not None else 'NA'}ms, "
                    f"infer: {infer_ms if infer_ms is not None else 'NA'}ms, "
                    f"total: {total_ms if total_ms is not None else 'NA'}ms)"
                )
            else:
                print(
                    f"[OCR] Event-based capture failed ({method}) "
                    f"(took: {ocr_elapsed_ms:.1f}ms, "
                    f"prep: {prep_ms if prep_ms is not None else 'NA'}ms, "
                    f"infer: {infer_ms if infer_ms is not None else 'NA'}ms, "
                    f"total: {total_ms if total_ms is not None else 'NA'}ms)"
                )
            
            if text and len(text) > 2000:
                text = text[:2000]
            
            # Capture the error_message from OCR result if available
            error_message = ocr_result.get('error_message')
            if not success and not error_message:
                error_message = f"OCR failed with method: {method}"
            
            return {
                'text': text.strip() if text else None,
                'method': method,
                'confidence': confidence,
                'error_message': error_message,
                'prep_ms': prep_ms,
                'infer_ms': infer_ms,
                'total_ms': total_ms,
                'screenshot': None
            }

        except Exception as e:
            error_msg = str(e)
            print(f"[WARN] Local OCR failed: {error_msg}")
            return {
                'text': None,
                'method': 'error',
                'confidence': 0.0,
                'error_message': error_msg,
                'screenshot': None
            }

    def ocr_from_image(self, screenshot):
        """Run OCR on an already-captured PIL Image (for backfilling throttled sessions).

        Args:
            screenshot: PIL.Image to extract text from

        Returns:
            dict: OCR result with text, method, confidence, error_message keys
        """
        try:
            ocr_start = time.perf_counter()
            ocr_result = extract_text_from_image(
                screenshot,
                window_title='',
                app_name='',
                screenshot_mode=True
            )
            ocr_elapsed_ms = (time.perf_counter() - ocr_start) * 1000.0

            self._last_ocr_time = time.time()

            text = ocr_result.get('text', '')
            method = ocr_result.get('method', 'unknown')
            confidence = ocr_result.get('confidence', 0.0)
            success = ocr_result.get('success', False)
            prep_ms = ocr_result.get('prep_ms')
            infer_ms = ocr_result.get('infer_ms')
            total_ms = ocr_result.get('total_ms')

            if text and len(text) > 2000:
                text = text[:2000]

            print(
                f"[OCR] Backfill OCR: {method} "
                f"(confidence: {confidence:.2f}, took: {ocr_elapsed_ms:.1f}ms, "
                f"prep: {prep_ms if prep_ms is not None else 'NA'}ms, "
                f"infer: {infer_ms if infer_ms is not None else 'NA'}ms, "
                f"total: {total_ms if total_ms is not None else 'NA'}ms)"
            )

            # Capture the error_message from OCR result if available
            error_message = ocr_result.get('error_message')
            if not success and not error_message:
                error_message = f"OCR failed with method: {method}"

            return {
                'text': text.strip() if text else None,
                'method': method,
                'confidence': confidence,
                'error_message': error_message,
                'prep_ms': prep_ms,
                'infer_ms': infer_ms,
                'total_ms': total_ms
            }

        except Exception as e:
            error_msg = str(e)
            print(f"[WARN] OCR from saved image failed: {error_msg}")
            return {
                'text': None,
                'method': 'error',
                'confidence': 0.0,
                'error_message': error_msg
            }


# ============================================================================
# TRACKING STATE MACHINE
# ============================================================================

class TrackingState(Enum):
    """Tracking state machine states.
    
    - STOPPED: App not tracking (initial state, after logout)
    - ACTIVE: Actively capturing screenshots and tracking work
    - IDLE: User idle (no activity, screen locked, or system sleep)
    - PAUSED: User manually paused tracking (via tray menu)
    """
    STOPPED = 0
    ACTIVE = 1
    IDLE = 2
    PAUSED = 3


# ============================================================================
# MAIN APPLICATION
# ============================================================================

class TimeTracker:
    """Main application class"""

    def __init__(self):
        print("[INFO] Initializing Time Tracker...")
        
        # Get logger instance
        if APP_LOGGER_AVAILABLE:
            self.logger = get_logger(__name__, 'TRACKER')
            self.logger.info("TimeTracker.__init__() starting...")
        else:
            self.logger = None

        # Check system dependencies (PipeWire, GStreamer, XDG Portal)
        # This helps users understand why screenshot capture might fail
        self.screenshot_dependencies_ok = True
        self.missing_dependencies = []
        if SYSTEM_CHECK_AVAILABLE:
            deps_ok, missing_deps = check_dependencies_startup()
            self.screenshot_dependencies_ok = deps_ok
            self.missing_dependencies = missing_deps
            if not deps_ok:
                if self.logger:
                    self.logger.warning(f"Missing screenshot dependencies: {', '.join(missing_deps)}")
                    self.logger.warning("Screenshot capture will not work - running in metadata-only mode")
                    self.logger.warning("Run ./scripts/fix-screenshot-capture.sh to install dependencies")
        else:
            if self.logger:
                self.logger.debug("System dependency check module not available")

        # Configuration (defaults, will be overridden by server settings)
        self.capture_interval = int(get_env_var('CAPTURE_INTERVAL', 300))
        self.web_port = int(get_env_var('WEB_PORT', 51777))
        
        if self.logger:
            self.logger.info(f"Configuration: capture_interval={self.capture_interval}s, web_port={self.web_port}")

        # Supabase client (initialized after authentication)
        # Uses anon key + custom JWT for RLS-scoped access (no service role key)
        self.supabase = None
        self.supabase_url = None
        self.supabase_initialized = False

        # Initialize Atlassian Auth FIRST (needed to fetch Supabase config)
        if self.logger:
            self.logger.info("Initializing Atlassian authentication manager...")
        self.auth_manager = AtlassianAuthManager(web_port=self.web_port)
        if self.logger:
            self.logger.info("Atlassian authentication manager initialized")
        
        # User state
        self.current_user = None
        self.current_user_id = None  # UUID from public.users table
        self._login_reminder_last_shown = time.time()  # Don't remind immediately on startup
        
        # ============================================================================
        # TRACKING SETTINGS (loaded from Supabase, configurable by admins)
        # ============================================================================
        # ============================================================================
        # TRACKING SETTINGS (Per-Project Configuration)
        # ============================================================================
        # Tracking settings are now cached per-project since different projects
        # may have different productivity rules (e.g., Twitter = productive for
        # social media projects, but non-productive for internal tools)
        self.tracking_settings_cache = {}  # Dict: {project_key: settings_dict}
        self.tracking_settings_last_fetch = {}  # Dict: {project_key: timestamp}
        self.tracking_settings_cache_ttl = 300  # Refresh settings every 5 minutes
        self.current_project_key = None  # Track current project for settings
        
        # Default settings (used as fallback)
        self.default_tracking_settings = {
            'screenshot_monitoring_enabled': False,
            'screenshot_interval_seconds': 900,  # 15 minutes default
            'tracking_mode': 'event',  # event-only monitoring
            'event_tracking_enabled': True,
            'track_window_changes': True,
            'track_idle_time': True,
            'idle_threshold_seconds': 300,  # 5 minutes
            'project_key': None,
            'settings_source': 'default'
        }
        
        # ============================================================================
        # UNASSIGNED WORK NOTIFICATION SETTINGS
        # ============================================================================
        self.notification_settings = {
            'enabled': True,  # Whether desktop notifications are enabled
            'interval_hours': 24,  # How often to check/notify (hours) - once a day
            'min_unassigned_minutes': 30  # Minimum unassigned time before notifying
        }
        self.last_notification_time = 0  # Timestamp of last notification
        self.notification_settings_last_fetch = None
        self.notification_settings_cache_ttl = 300  # Refresh every 5 minutes
        
        # Tracking state
        self.running = False
        self.tracking_active = False
        self.is_idle = False  # KEEP for backward compatibility (will be phased out)
        
        # New state machine (replaces is_idle boolean)
        self.state = TrackingState.STOPPED
        self.state_lock = threading.Lock()  # Protect state transitions from race conditions
        self.idle_start_time = None  # Timestamp when idle state was entered
        self.idle_reason = None  # Reason for idle (e.g., 'system sleep', 'screen lock')

        # ============================================================================
        # PAUSE SETTINGS (stored locally on user's machine)
        # ============================================================================
        self.pause_settings = {
            'timed_pause_enabled': True,  # Offer timed pause options
            'pause_durations': [5, 10, 15, 30, 60],  # Available durations in minutes
            'show_resume_notification': True,  # Notify when auto-resume happens
            'pause_reminder_enabled': True,  # Show reminders while paused
            'pause_reminder_interval': 30  # Reminder interval in minutes
        }
        self.load_pause_settings()  # Load from file if exists

        # Pause tracking state
        self.pause_start_time = None  # When user paused tracking (None = not paused)
        self.pause_end_time = None  # Scheduled auto-resume time (for timed pause)
        self.pause_reminder_interval = self.pause_settings['pause_reminder_interval'] * 60  # Convert to seconds
        self.pause_reminder_enabled = self.pause_settings['pause_reminder_enabled']
        self.last_pause_reminder_time = 0  # Last time we sent a pause reminder
        self.pause_popup = None  # Floating popup window when paused
        self.next_popup_show_time = None  # When to show popup again (for periodic reappearance)
        self.popup_show_count = 0  # How many times popup has been shown (for calculating intervals)
        self.needs_idle_resume = False  # Flag set by pynput when activity detected during idle
        self.last_activity_time = time.time()  # Last mouse/keyboard activity
        self.idle_timeout = 300  # 5 minutes idle timeout (in seconds)
        self.idle_start_time = None  # When the current idle period began (UTC datetime)
        self.idle_project_key = None  # Project key at idle entry — used for idle record's project_key
        self._pending_idle_records = []  # Idle records waiting to be uploaded in next batch
        self._tracking_thread = None
        self._activity_monitor_thread = None  # Activity monitoring thread
        self._system_event_thread = None  # Windows sleep/lock event listener
        self._system_event_hwnd = None  # HWND for the system event message-only window
        self.screenshot_hash = None
        
        # Event-based tracking: Window switch detection
        self.current_window_key = None  # Unique identifier for current window (app + title)
        self.current_window_start_time = None  # When current window became active (updated after each screenshot)
        self.current_window_db_start_time = None  # Actual start_time saved to database (for accurate duration calc)
        self.current_window_record_created_at = None  # When the record was actually inserted (for interval safeguard)
        self.current_window_screenshot_id = None  # ID of the current screenshot (to update later when switching)
        self.last_interval_time = None  # When last INTERVAL screenshot was taken (fixed 5-min clock)
        self.last_screenshot_end_time = None  # End time of last screenshot record (to ensure no gaps)
        self.previous_window_key = None  # Previous window (to capture final screenshot with full duration)
        self.previous_window_start_time = None  # When previous window became active
        self.previous_window_db_start_time = None  # Actual start_time from database (for accurate duration calc)
        self.previous_window_info = None  # Previous window info (title, app)
        self.previous_window_screenshot_id = None  # ID of the "start" screenshot for previous window (to update)
        
        # Jira issue caching
        self.user_issues = []  # Cache of user's In Progress Jira issues
        self.issues_cache_time = None  # Last time issues were fetched
        self.issues_cache_ttl = 300  # 5 minutes cache TTL
        self.jira_cloud_id = None  # Cached Jira cloud ID

        # Multi-site Jira support: store ALL accessible resources
        # Users may have projects across multiple Jira sites (cloud IDs).
        # all_jira_resources stores every resource from accessible-resources API.
        self.all_jira_resources = []  # List of {id, name, url, ...} for all Jira sites
        self.all_jira_cloud_ids = []  # List of cloud ID strings for all sites

        # Jira project caching (for users without assigned issues)
        self.user_projects = []  # Cache of user's accessible Jira projects
        self.projects_cache_time = None  # Last time projects were fetched
        self.projects_cache_ttl = 3600  # 1 hour cache TTL (projects change less frequently)

        # Multi-project detection: recent project affinity tracker
        # Tracks the last N resolved project keys to use as tiebreaker when
        # window title / OCR don't give a confident match.
        self._recent_project_keys = []  # Ordered list, most recent last
        self._recent_project_max = 20  # Keep last 20 resolutions

        # Project settings caching (admin-configured tracked statuses per project)
        self.project_settings = {}  # Dict: {project_key: {tracked_statuses: [...], ...}}
        self.project_settings_cache_time = None
        self.project_settings_cache_ttl = 300  # 5 minutes cache TTL

        # Multi-tenancy: Organization info
        self.organization_id = None  # UUID from public.organizations table
        self.organization_name = None  # Organization name (Jira site name)
        self.jira_instance_url = None  # Jira instance URL
        
        # Offline mode support (encrypted SQLite via DatabaseConnectionManager)
        from db_connection import DatabaseConnectionManager
        self.db_manager = DatabaseConnectionManager()
        self.offline_manager = OfflineManager(self.db_manager)
        self._sync_thread = None
        self._last_sync_time = 0
        self._sync_interval = 60  # Try to sync every 60 seconds when online

        # Consent management (GDPR/Privacy compliance)
        self.consent_manager = ConsentManager()

        # ====================================================================
        # NEW: Event-based activity tracking components
        # ====================================================================
        self.classification_manager = AppClassificationManager(self.db_manager)
        self.session_manager = ActiveSessionManager(self.db_manager)
        
        # OCR engine setup is deferred until after authentication so it uses
        # the correct engine config fetched from the AI server.
        self.ocr_processor = None
        atexit.register(self._shutdown_cleanup)
        self.batch_upload_interval = 300  # 5 min default (overridden by project settings)
        self.last_batch_upload_time = time.time()
        self.batch_start_time = datetime.now(timezone.utc)
        self.last_classification_sync = 0
        self.classification_sync_interval = 1800  # 30 minutes
        self._unknown_apps_classified = set()  # Debounce: track apps already sent to AI this session

        # AI analysis is handled by the separate AI server
        # Desktop app only captures and uploads screenshots
        
        # Flask app
        self.app = Flask(__name__)
        self.app.secret_key = secrets.token_hex(16)
        CORS(self.app)
        
        # System tray
        self.tray = None

        # Admin configuration
        self.admin_session_token = None
        self.admin_logs = []  # In-memory log storage
        self.max_log_entries = 500  # Maximum log entries to keep

        # ============================================================================
        # VERSION CHECKING / UPDATE NOTIFICATIONS
        # ============================================================================
        self.app_version = APP_VERSION  # Use global constant
        self.latest_version_info = None  # Cached latest version info
        self.last_version_check_time = 0  # Last time we checked for updates
        self.version_check_interval = 1 * 60 * 60  # Check every 1 hour (in seconds)
        self.update_available = False  # Flag for UI to show update badge
        self.update_notification_shown = False  # Track if we've shown notification for this version
        self.update_required = False
        self._mandatory_update_enforced = False
        self._last_update_notification_state = None
        self._last_notified_update_version = None
        self.update_manager = UpdateManager(
            get_app_data_dir(),
            self.app_version,
            on_status_change=self._on_update_manager_state_changed,
            on_apply_update=self._shutdown_for_update
        )

        # Setup routes
        self.setup_routes()

        print("[OK] Application initialized")
        self.add_admin_log('INFO', f'Application started (v{self.app_version})')

    def _setup_ocr_engines(self):
        """
        Setup OCR engines and verify they are available.
        Called during app initialization to ensure OCR is ready.
        """
        try:
            from ocr.facade import get_facade
            facade = get_facade()
            diagnostics = facade.get_ocr_diagnostics()

            if diagnostics.get('ocr_available'):
                print(f"[OK] OCR ready — primary: {diagnostics['config']['primary_engine']}, "
                      f"fallbacks: {diagnostics['config']['fallback_engines']}")
            else:
                print(f"[WARN] No OCR engines available: {diagnostics.get('status', 'unknown')}")
                if diagnostics.get('engine_init_errors'):
                    for eng, err in diagnostics['engine_init_errors'].items():
                        err_short = err[:300] + '...' if len(err) > 300 else err
                        print(f"[OCR]   - {eng}: {err_short}")
                        self.add_admin_log('ERROR', f'OCR {eng} init error: {err_short}')
                if diagnostics.get('recommendations'):
                    for rec in diagnostics['recommendations']:
                        print(f"[OCR] {rec}")

        except Exception as e:
            print(f"[WARN] OCR setup encountered an error: {e}")
            self.add_admin_log('WARNING', f'OCR setup error: {str(e)}')

    def _shutdown_for_update(self):
        """Exit process after scheduling updater script."""
        # Keep update shutdown immediate. Any cleanup here can block and leave
        # updater script stuck waiting for this PID to exit.
        try:
            self.running = False
            self.tracking_active = False
        except Exception:
            pass
        print("[UPDATE] Exiting immediately for updater handoff...")
        os._exit(0)

    def _on_update_manager_state_changed(self, status):
        """Sync UpdateManager state into tray UI and app control flags."""
        state = status.get('state', 'idle')
        update_info = status.get('update_info') or {}
        latest_version = update_info.get('latest_version')

        if update_info:
            self.latest_version_info = update_info

        self.update_available = state in ('downloading', 'ready', 'mandatory_ready', 'deferred')
        self.update_required = state == 'mandatory_ready'

        if state != 'mandatory_ready':
            self._mandatory_update_enforced = False

        # Auto-apply: when download is verified and ready, install immediately
        if state in ('ready', 'mandatory_ready') and self.update_manager:
            latest = update_info.get('latest_version', 'unknown')
            print(f"[UPDATE] Auto-applying update v{latest}...")
            self.add_admin_log('INFO', f'Auto-applying update v{latest}')
            # Show brief "restarting" toast so user isn't surprised
            if WINOTIFY_AVAILABLE:
                try:
                    notification = Notification(
                        app_id="Time Tracker",
                        title="Updating Time Tracker",
                        msg=f"Installing v{latest}. The app will restart shortly.",
                        duration="short"
                    )
                    notification.set_audio(audio.Default, loop=False)
                    notification.show()
                except Exception:
                    pass
            else:
                _linux_notify("Updating Time Tracker",
                              f"Installing v{latest}. The app will restart shortly.")
            self.update_manager.auto_apply()
            return  # app is shutting down, skip tray updates

        # Still notify for downloading/failed states (informational only)
        should_notify = state in ('downloading', 'failed')
        if should_notify:
            version_changed = latest_version and self._last_notified_update_version != latest_version
            state_changed = self._last_update_notification_state != state
            if version_changed or state_changed:
                show_update_notification(
                    update_info,
                    state=state,
                    web_port=self.web_port,
                    install_callback=None  # No manual install button needed
                )
                self._last_update_notification_state = state
                self._last_notified_update_version = latest_version

        self.update_tray_menu()
        self.update_tray_icon()

    def _enforce_mandatory_update_pause(self):
        """Pause tracking when a mandatory update is ready to install."""
        if not self.update_required or self._mandatory_update_enforced:
            return
        if not self.tracking_active:
            return

        try:
            self._finalize_active_session("mandatory update")
            self.session_manager.stop_current_timer()
            self.upload_activity_batch()
        except Exception as e:
            print(f"[WARN] Mandatory update pre-pause flush failed: {e}")

        self.tracking_active = False
        self._mandatory_update_enforced = True
        self.add_admin_log('WARNING', 'Tracking paused until required update is installed')
        self.update_tray_icon()
        self.update_tray_menu()

    def check_for_app_updates(self, show_notification=True, force=False):
        """
        Check for available updates from the AI server.
        
        Args:
            show_notification: Whether to show a desktop notification if update is available
            force: Force check even if recently checked
        
        Returns:
            dict with update info or None if no update/error
        """
        try:
            # Check connectivity first - fail fast if offline.
            # When force=True (manual check / startup), bypass the 30-second cache so a
            # stale "offline" result from a previous failed probe doesn't silently block
            # the check (common right after system boot or a brief network blip).
            if not self.offline_manager.check_connectivity(force=force):
                print("[INFO] Offline - skipping update check")
                self.add_admin_log('INFO', 'Update check skipped (offline)')
                return None
            
            current_time = time.time()
            
            # Skip if checked recently (unless forced)
            if not force and (current_time - self.last_version_check_time) < self.version_check_interval:
                # Return cached info
                return self.latest_version_info
            
            print(f"[INFO] Checking for updates (current version: v{self.app_version})")
            
            # Call the global check function
            update_info = check_for_updates()
            
            self.last_version_check_time = current_time
            
            if update_info is None:
                print("[INFO] Could not check for updates")
                # Clear stale update flag to prevent showing outdated update prompts
                self.update_available = False
                return None
            
            self.latest_version_info = update_info
            self.update_available = update_info.get('update_available', False)
            
            # Local safety check: verify the latest version is genuinely newer
            # than our running version. Prevents showing "update available" for
            # the same version we're already running (e.g. stale server data,
            # race conditions, or the user already installed the update).
            if self.update_available:
                latest_version = update_info.get('latest_version', 'unknown')
                if not is_version_newer(latest_version, APP_VERSION):
                    self.update_available = False
                    print(f"[INFO] Server indicated update to v{latest_version} but v{APP_VERSION} is already current - ignoring")
                else:
                    print(f"[INFO] Update available: v{latest_version}")
                    self.add_admin_log('INFO', f'Update available: v{latest_version}')

                    if self._last_notified_update_version != latest_version:
                        self.update_notification_shown = False

                    self.update_manager.check_and_download(update_info)
                    self.update_notification_shown = True

                    # If mandatory, log a warning
                    if update_info.get('is_mandatory', False):
                        self.add_admin_log('WARNING', f'Mandatory update required: v{latest_version}')
            else:
                print(f"[INFO] App is up to date (v{self.app_version})")
            
            return update_info
            
        except Exception as e:
            print(f"[WARN] Error checking for updates: {e}")
            self.add_admin_log('WARNING', f'Update check failed: {str(e)}')
            return None

    def initialize_supabase(self):
        """Initialize Supabase client with custom JWT for RLS-scoped access.
        Uses anon key + custom JWT — no service role key needed.
        Must be called after successful authentication."""
        if self.supabase_initialized:
            print("[INFO] Supabase already initialized")
            return True

        # Fetch Supabase config from AI server (requires valid Atlassian token)
        print("[INFO] Fetching Supabase configuration from AI server...")
        if not self.auth_manager.get_supabase_config():
            print("[ERROR] Failed to get Supabase config from AI server")
            return False

        # Fetch OCR config from AI server (requires valid Atlassian token)
        print("[INFO] Fetching OCR configuration from AI server...")
        if not self.auth_manager.get_ocr_config():
            print("[WARN] Failed to get OCR config from AI server, using defaults")
            # OCR config is not critical - continue with defaults

        # Now that the correct engine config is in os.environ, set up OCR engines
        # and create the processor (uses AI-server-provided engine names).
        self._setup_ocr_engines()
        self.ocr_processor = LocalOCRProcessor()

        # Initialize single Supabase client with anon key + custom JWT
        try:
            self.supabase_url = get_env_var('SUPABASE_URL')
            supabase_anon_key = get_env_var('SUPABASE_ANON_KEY')

            if not self.supabase_url or not supabase_anon_key:
                print("[ERROR] Supabase URL or anon key not available")
                return False

            # Configure Supabase client with longer timeouts to handle slow networks
            supabase_options = ClientOptions(
                postgrest_client_timeout=60,  # Database query timeout
                storage_client_timeout=60      # File storage timeout
            )

            # Initialize client with anon key (RLS enforced)
            self.supabase: Client = create_client(
                self.supabase_url,
                supabase_anon_key,
                options=supabase_options
            )
            print(f"[OK] Supabase client initialized for {self.supabase_url} (timeout: 60s)")

            # Set custom JWT from AI server on the client for RLS-scoped access
            if not self._set_supabase_jwt():
                print("[ERROR] Could not set Supabase JWT - authentication incomplete")
                logging.error("Could not set Supabase JWT - authentication incomplete")
                return False

            self.supabase_initialized = True
            self.add_admin_log('INFO', 'Supabase initialized with custom JWT (RLS-scoped)')
            return True

        except Exception as e:
            print(f"[ERROR] Failed to initialize Supabase client: {e}")
            traceback.print_exc()
            return False

    def _set_supabase_jwt(self):
        """Set custom JWT on Supabase client for RLS-scoped access.
        The JWT contains sub=user_id and app_metadata.org_id for tenant isolation.
        Must be called after initialize_supabase() and whenever the JWT is refreshed."""
        if not self.supabase:
            print("[WARN] Supabase client not initialized — cannot set JWT")
            return False
        try:
            supabase_token = self.auth_manager.get_valid_supabase_token()
            if not supabase_token:
                print("[WARN] Could not get valid Supabase token")
                return False

            # Set JWT on PostgREST client (official API)
            self.supabase.postgrest.auth(supabase_token)

            # Set JWT on Storage client session headers
            # Access .storage to trigger lazy initialization if needed
            _ = self.supabase.storage
            self.supabase.storage.session.headers["Authorization"] = f"Bearer {supabase_token}"

            # Extract organization_id, user_id, and jira_cloud_id from exchange-token response data.
            # The AI server (service_role) creates/finds the org during token exchange,
            # so this is the authoritative source — avoids RLS chicken-and-egg issues.
            exchange_org_id = self.auth_manager.tokens.get('exchange_organization_id')
            exchange_user_id = self.auth_manager.tokens.get('exchange_user_id')
            exchange_cloud_id = self.auth_manager.tokens.get('exchange_jira_cloud_id')
            if exchange_org_id and not self.organization_id:
                self.organization_id = exchange_org_id
                print(f"[OK] Organization ID set from exchange-token: {self.organization_id}")
            if exchange_user_id and not self.current_user_id:
                self.current_user_id = exchange_user_id
                print(f"[OK] User ID set from exchange-token: {self.current_user_id}")
            # Pre-seed jira_cloud_id so get_jira_cloud_id() picks the right site
            # even before accessible-resources is fetched.
            if exchange_cloud_id and not self.jira_cloud_id:
                self.jira_cloud_id = exchange_cloud_id
                print(f"[OK] Jira Cloud ID pre-seeded from exchange-token: {self.jira_cloud_id}")

            print("[OK] Supabase JWT set on client (PostgREST + Storage)")
            return True

        except Exception as e:
            print(f"[ERROR] Failed to set Supabase JWT: {e}")
            return False

    def _is_session_valid(self):
        """Return True only when current_user exists AND the refresh token is not marked invalid."""
        if not self.current_user:
            return False
        if getattr(self.auth_manager, '_refresh_token_invalid', False):
            return False
        return True

    def setup_routes(self):
        """Setup Flask routes"""

        @self.app.route('/')
        def index():
            if self._is_session_valid():
                user_account_id = self.current_user.get('account_id')
                if not self.consent_manager.has_valid_consent(user_account_id):
                    return redirect('/consent')
                return redirect('/success')
            return redirect('/login')

        @self.app.route('/login')
        def login():
            session_expired = (
                self.current_user is not None
                and getattr(self.auth_manager, '_refresh_token_invalid', False)
            )
            if self._is_session_valid():
                user_account_id = self.current_user.get('account_id')
                if not self.consent_manager.has_valid_consent(user_account_id):
                    return redirect('/consent')
                return redirect('/success')
            return self.render_login_page(session_expired=session_expired)
        
        @self.app.route('/auth/atlassian')
        def auth_atlassian():
            """Start Atlassian OAuth flow"""
            try:
                auth_url = self.auth_manager.get_auth_url()
                print(f"[OK] Redirecting to Atlassian OAuth: {auth_url[:80]}...")
                return redirect(auth_url)
            except Exception as e:
                return f"OAuth error: {str(e)}", 500

        @self.app.route('/auth/google')
        def auth_google():
            """Start Google OAuth flow (non-Jira users)"""
            try:
                auth_url = self.auth_manager.get_google_auth_url()
                print(f"[OK] Redirecting to Google OAuth: {auth_url[:80]}...")
                return redirect(auth_url)
            except Exception as e:
                return f"Google OAuth error: {str(e)}", 500

        @self.app.route('/auth/google/callback')
        def auth_google_callback():
            """Handle Google OAuth callback for non-Jira users.
            Unlike the Atlassian path there is no Jira identity: the AI server has
            already created/looked-up the user (by google_sub) and returned the
            org/user ids, so we just init Supabase and start tracking."""
            error = request.args.get('error')
            if error:
                print(f"[ERROR] Google OAuth error: {error}")
                return f"Authentication failed: {error}", 400

            code = request.args.get('code')
            state = request.args.get('state')
            if not code:
                return "Authentication failed: no authorization code received", 400

            try:
                result = self.auth_manager.handle_google_callback(code, state)
                user = result.get('user', {})

                # Apply OCR + privacy config from the login response. Google users
                # can't fetch /api/auth/ocr-config (no Atlassian token), so without
                # this they'd run OCR with DEFAULT privacy settings. Must be set
                # BEFORE initialize_supabase() builds the OCR processor/privacy filter.
                if result.get('config'):
                    set_runtime_ocr_config(result['config'])
                if result.get('privacy'):
                    set_runtime_privacy_config(result['privacy'])

                # Initialize Supabase (uses the config cached during handle_google_callback)
                if not self.initialize_supabase():
                    return "Failed to initialize database connection - check AI server connectivity", 500

                # Google users have no Atlassian account id; use the DB user id as the
                # identity/consent key. organization_id + user_id come from the AI server.
                self.current_user = {
                    'account_id': user.get('id'),
                    'email': user.get('email'),
                    'name': user.get('display_name'),
                    'auth_provider': 'google'
                }
                self.current_user_id = user.get('id')
                self.organization_id = user.get('organization_id')

                # Mark logged in (best-effort; non-fatal for google)
                try:
                    self._update_desktop_status(logged_in=True)
                except Exception as e:
                    print(f"[WARN] desktop status update failed (non-fatal): {e}")

                # Sync app classifications so productive/non-productive works locally
                try:
                    self.classification_manager.sync_classifications(self.supabase, self.organization_id)
                except Exception as e:
                    print(f"[WARN] Classification sync failed during google auth: {e}")

                self._associate_offline_records()
                self.update_tray_icon()
                self.update_tray_menu()

                # Consent gate (same as the Atlassian path)
                if not self.consent_manager.has_valid_consent(self.current_user.get('account_id')):
                    return redirect('/consent')

                if not self.running:
                    self.start_tracking()

                return redirect('/success')
            except Exception as e:
                self.current_user = None
                print(f"[ERROR] Google auth callback failed: {e}")
                traceback.print_exc()
                return f"Authentication failed: {str(e)}", 400

        @self.app.route('/auth/callback')
        def auth_callback():
            """Handle OAuth callback"""
            error = request.args.get('error')
            if error:
                error_description = request.args.get('error_description', 'Unknown error')
                print(f"[ERROR] OAuth error from Atlassian: {error} - {error_description}")
                # Try to send login diagnostics even though login failed
                try:
                    send_login_diagnostics(
                        self.auth_manager, 
                        'failed', 
                        'oauth_callback', 
                        error=f"Atlassian OAuth error: {error}",
                        error_details={'error_code': error, 'error_description': error_description}
                    )
                except:
                    pass
                return f"Authentication failed: {error} - {error_description}", 400
            
            code = request.args.get('code')
            state = request.args.get('state')
            
            if not code:
                print("[ERROR] OAuth callback missing authorization code")
                return "Authentication failed: no authorization code received", 400
            
            try:
                # Exchange code for tokens via AI Server (ATLASSIAN_CLIENT_SECRET is on server)
                print("[INFO] Exchanging OAuth code for tokens...")
                tokens = self.auth_manager.handle_callback(code, state)

                # Get user info from Atlassian
                print("[INFO] Fetching user info from Atlassian...")
                user_info = self.auth_manager.get_user_info()
                if not user_info:
                    error_msg = "Failed to get user information from Atlassian API"
                    print(f"[ERROR] {error_msg}")
                    send_login_diagnostics(
                        self.auth_manager, 'failed', 'get_user_info',
                        error=error_msg
                    )
                    return error_msg, 500

                # Initialize Supabase clients (fetches config from AI server)
                print("[INFO] Initializing database connection...")
                if not self.initialize_supabase():
                    error_msg = "Failed to initialize database connection - check AI server connectivity"
                    print(f"[ERROR] {error_msg}")
                    send_login_diagnostics(
                        self.auth_manager, 'failed', 'initialize_supabase',
                        error=error_msg
                    )
                    return error_msg, 500

                # Check if we had anonymous tracking before login
                had_anonymous = self.current_user_id and self.current_user_id.startswith('anonymous_')

                # Create or update user in Supabase.
                # IMPORTANT: self.current_user is set AFTER ensure_user_exists succeeds to
                # prevent a partially-authenticated state. If ensure_user_exists raises (e.g.
                # a transient DNS failure on first-boot), self.current_user stays None so
                # the /login route cannot bypass the full auth flow on a "Try Again" retry.
                # Retry up to 3 times to handle first-boot DNS/network race conditions.
                _ensure_error = None
                for _db_attempt in range(3):
                    try:
                        self.current_user_id = self.ensure_user_exists(user_info)
                        _ensure_error = None
                        break
                    except Exception as _db_e:
                        _ensure_error = _db_e
                        _err_lower = str(_db_e).lower()
                        if _db_attempt < 2 and (
                            'getaddrinfo' in _err_lower
                            or 'connect' in _err_lower
                            or 'timeout' in _err_lower
                        ):
                            _wait = (_db_attempt + 1) * 3
                            print(f"[WARN] Database connection failed (attempt {_db_attempt + 1}/3), retrying in {_wait}s...")
                            time.sleep(_wait)
                        else:
                            break
                if _ensure_error:
                    raise _ensure_error
                self.current_user = user_info  # Set only after successful DB user create/update

                secure_log("[OK] Authenticated user", email=user_info.get('email', 'unknown'))
                
                # Reset notification timestamps on successful login
                self._reauth_notification_last_shown = 0
                self._login_reminder_last_shown = 0

                # Update desktop app status to logged in
                success = self._update_desktop_status(logged_in=True)
                if not success:
                    error_msg = "Failed to complete authentication - please try logging in again"
                    print(f"[ERROR] {error_msg}")
                    send_login_diagnostics(
                        self.auth_manager, 
                        'failed', 
                        'desktop_status_write',
                        error=error_msg
                    )
                    return error_msg, 500

                # Send successful login diagnostics (after status write verified)
                send_login_diagnostics(
                    self.auth_manager, 'success', 'complete',
                    error_details={'user_id': self.current_user_id}
                )
                
                # Send OCR diagnostics now that user is authenticated
                print("[INFO] Sending OCR diagnostics to server...")
                send_ocr_diagnostics(self.auth_manager)

                # Sync app classifications from Supabase (all projects)
                try:
                    client = self.supabase
                    self.classification_manager.sync_classifications(
                        client, self.organization_id, self.current_project_key,
                        all_project_keys=list(self._get_known_project_keys())
                    )
                except Exception as e:
                    print(f"[WARN] Classification sync failed during auth: {e}")

                # Associate any anonymous offline records with this user
                self._associate_offline_records()

                # Update tray icon and menu to reflect logged-in state
                self.update_tray_icon()
                self.update_tray_menu()

                # Check if user has given consent for screenshot capture
                user_account_id = user_info.get('account_id')
                if not self.consent_manager.has_valid_consent(user_account_id):
                    # Redirect to consent page first
                    secure_log("[INFO] User needs to provide consent", email=user_info.get('email'))
                    return redirect('/consent')

                # User has consent - start tracking if not already running
                if not self.running:
                    self.start_tracking()

                return redirect('/success')
                
            except Exception as e:
                # Clear any partial authentication state so the /login route does not
                # bypass the full auth flow on a subsequent "Try Again" click.
                self.current_user = None
                print(f"[ERROR] Auth callback failed: {e}")
                traceback.print_exc()
                
                # Categorize the error for better diagnostics
                error_msg = str(e)
                error_lower = error_msg.lower()
                
                error_category = 'unknown'
                if 'timeout' in error_lower or 'timed out' in error_lower:
                    error_category = 'timeout'
                elif (
                    'connection' in error_lower
                    or 'connect' in error_lower
                    or 'getaddrinfo' in error_lower
                    or 'nodename nor servname' in error_lower
                    or 'name resolution' in error_lower
                ):
                    error_category = 'connection'
                elif 'token' in error_lower:
                    error_category = 'token_exchange'
                elif 'state' in error_lower or 'csrf' in error_lower:
                    error_category = 'state_mismatch'
                elif 'access denied' in error_lower or 'forbidden' in error_lower:
                    error_category = 'access_denied'
                elif 'not found' in error_lower:
                    error_category = 'not_found'
                elif ('ca certificate' in error_lower
                      or 'certificate bundle' in error_lower
                      or 'ca-bundle' in error_lower
                      or 'ca_bundle' in error_lower
                      or 'ssl: certificate_verify_failed' in error_lower):
                    error_category = 'tls_config'
                
                # Send login failure diagnostics
                try:
                    send_login_diagnostics(
                        self.auth_manager, 
                        'failed', 
                        'auth_callback',
                        error=error_msg,
                        error_details={
                            'category': error_category,
                            'stack_trace': traceback.format_exc()[:500]  # First 500 chars
                        }
                    )
                except:
                    pass  # Don't fail login error page if diagnostics fail
                
                # Show a user-friendly error page with categorized messages
                is_timeout = error_category in ('timeout', 'connection')
                
                if error_category == 'timeout':
                    retry_hint = "The authentication server is taking too long to respond. This may be a temporary issue."
                elif error_category == 'connection':
                    retry_hint = "Could not connect to the authentication server. Please check your internet connection."
                elif error_category == 'access_denied':
                    retry_hint = "Access was denied. Please ensure your Jira account has the TimeTracker Forge app installed. Contact your administrator."
                elif error_category == 'token_exchange':
                    retry_hint = "Token exchange failed. This may be a temporary server issue."
                elif error_category == 'state_mismatch':
                    retry_hint = "Security check failed. Please try logging in again."
                elif error_category == 'tls_config':
                    retry_hint = (
                        "Your system's TLS certificate configuration is broken. "
                        "Another program (often PostgreSQL) set the CURL_CA_BUNDLE or "
                        "REQUESTS_CA_BUNDLE environment variable to a file that doesn't exist. "
                        "Open Windows System Properties > Environment Variables, delete "
                        "the CURL_CA_BUNDLE and REQUESTS_CA_BUNDLE entries, then restart the app."
                    )
                else:
                    retry_hint = "Please try again. If the problem persists, contact support."
                
                return f"""<!DOCTYPE html><html><head><title>Authentication Failed</title>
                    <style>body{{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f4f5f7}}
                    .card{{background:#fff;border-radius:8px;padding:40px;max-width:500px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.1)}}
                    h2{{color:#de350b;margin-bottom:8px}}p{{color:#5e6c84;line-height:1.5}}
                    .btn{{display:inline-block;margin-top:20px;padding:10px 24px;background:#0052CC;color:#fff;border-radius:4px;text-decoration:none;font-weight:500}}
                    .btn:hover{{background:#0747a6}}.detail{{font-size:12px;color:#97a0af;margin-top:16px;word-break:break-all}}
                    .category{{font-size:11px;color:#b3b3b3;margin-top:8px;text-transform:uppercase}}</style></head>
                    <body><div class="card"><h2>Authentication Failed</h2><p>{retry_hint}</p>
                    <a class="btn" href="/login">Try Again</a>
                    <p class="category">Error Type: {error_category}</p>
                    <p class="detail">{error_msg}</p></div></body></html>""", 500
        
        @self.app.route('/success')
        def success():
            return self.render_success_page()

        @self.app.route('/api/status')
        def api_status():
            # Get offline status
            is_online = self.offline_manager.check_connectivity(force=False)
            pending_offline = self.offline_manager.get_pending_count()

            # Calculate pause duration if paused
            pause_duration_seconds = 0
            if self.pause_start_time:
                pause_duration_seconds = int(time.time() - self.pause_start_time)

            return jsonify({
                'authenticated': self.current_user is not None,
                'tracking': self.tracking_active,
                'running': self.running,
                'user': self.current_user.get('email') if self.current_user else None,
                'online': is_online,
                'offline_pending': pending_offline,
                'idle': self.is_idle,
                'is_paused': self.pause_start_time is not None,
                'pause_duration_seconds': pause_duration_seconds
            })
        
        @self.app.route('/api/offline/sync', methods=['POST'])
        def api_trigger_sync():
            """Manually trigger offline sync"""
            if not self.current_user_id:
                return jsonify({'error': 'Not authenticated'}), 401
            
            result = self.sync_offline_data(force=True)
            if result:
                synced, failed = result
                return jsonify({
                    'success': True,
                    'synced': synced,
                    'failed': failed,
                    'remaining': self.offline_manager.get_pending_count()
                })
            else:
                return jsonify({
                    'success': False,
                    'message': 'No data to sync or offline',
                    'remaining': self.offline_manager.get_pending_count()
                })
        
        @self.app.route('/api/offline/status')
        def api_offline_status():
            """Get offline storage status"""
            is_online = self.offline_manager.check_connectivity(force=True)
            pending = self.offline_manager.get_pending_count()
            
            return jsonify({
                'online': is_online,
                'pending_screenshots': pending,
                'sync_interval_seconds': self._sync_interval,
                'last_sync_time': self._last_sync_time if self._last_sync_time > 0 else None,
                'database_path': self.offline_manager.db_path
            })
        
        @self.app.route('/api/screenshots')
        def api_screenshots():
            if not self.current_user_id:
                return jsonify({'error': 'Not authenticated'}), 401
            
            try:
                # Query via RLS-scoped client (JWT has user's identity)
                client = self.supabase
                result = client.table('screenshots').select('*').eq(
                    'user_id', self.current_user_id
                ).order('timestamp', desc=True).limit(50).execute()
                
                # Generate proxy URLs for private storage images
                screenshots = []
                for screenshot in result.data:
                    # Use proxy endpoint for thumbnails and full images
                    storage_path = screenshot.get('storage_path', '')
                    if storage_path:
                        # Get thumbnail path - extract directory and filename
                        # Format: user_id/screenshot_timestamp.png -> user_id/thumb_timestamp.jpg
                        if '/' in storage_path:
                            dir_path, filename = storage_path.rsplit('/', 1)
                            thumb_filename = filename.replace('screenshot_', 'thumb_').replace('.png', '.jpg')
                            thumb_path = f'{dir_path}/{thumb_filename}'
                        else:
                            thumb_path = storage_path.replace('screenshot_', 'thumb_').replace('.png', '.jpg')
                        
                        # Use proxy endpoint for thumbnail
                        screenshot['thumbnail_url'] = f'/api/screenshot/{thumb_path}'
                        
                        # Also provide proxy URL for full image
                        screenshot['proxy_url'] = f'/api/screenshot/{storage_path}'
                    
                    screenshots.append(screenshot)
                
                return jsonify(screenshots)
            except Exception as e:
                return jsonify({'error': str(e)}), 500
        
        @self.app.route('/api/screenshot/<path:file_path>')
        def serve_screenshot(file_path):
            """Proxy endpoint to serve screenshots from private storage"""
            if not self.current_user_id:
                return jsonify({'error': 'Not authenticated'}), 401
            
            try:
                # Verify the file belongs to the current user
                if not file_path.startswith(f"{self.current_user_id}/"):
                    return jsonify({'error': 'Unauthorized'}), 403
                
                # Use service client to get file
                client = self.supabase
                
                # Download file from storage
                file_response = client.storage.from_('screenshots').download(file_path)
                
                if file_response:
                    # Determine content type
                    content_type = 'image/png'
                    if file_path.endswith('.jpg') or file_path.endswith('.jpeg'):
                        content_type = 'image/jpeg'
                    
                    # Handle different response types from Supabase
                    file_data = file_response
                    if hasattr(file_response, 'read'):
                        file_data = file_response.read()
                    elif isinstance(file_response, dict):
                        # Supabase might return dict with 'data' key
                        file_data = file_response.get('data', file_response)
                    elif not isinstance(file_response, (bytes, bytearray)):
                        try:
                            file_data = bytes(file_response)
                        except:
                            file_data = str(file_response).encode()
                    
                    from flask import Response
                    return Response(file_data, mimetype=content_type)
                else:
                    return jsonify({'error': 'File not found'}), 404
            except Exception as e:
                print(f"[ERROR] Error serving screenshot: {e}")
                return jsonify({'error': str(e)}), 500

        # ============================================================================
        # ADMIN ROUTES
        # ============================================================================

        @self.app.route('/admin')
        def admin_login_page():
            """Admin login page"""
            if not self.supabase or not self.organization_id:
                return self.render_admin_locked_page()
            # Check if already authenticated
            session_token = request.cookies.get('admin_session')
            if session_token and session_token == self.admin_session_token:
                return redirect('/admin/dashboard')
            return self.render_admin_login_page()

        @self.app.route('/admin/login', methods=['POST'])
        def admin_login():
            """Handle admin login"""
            if not self.supabase or not self.organization_id:
                return self.render_admin_locked_page()
            password = request.form.get('password', '')

            # Always fetch the latest password from the server — never use a cached value
            current_password = self._fetch_admin_password()
            if current_password is None:
                self.add_admin_log('WARN', 'Admin login failed: could not fetch password from server')
                return self.render_admin_login_page(error='Could not verify password. Please try again.')

            if password == current_password:
                # Generate session token
                self.admin_session_token = secrets.token_hex(32)
                self.add_admin_log('INFO', 'Admin logged in successfully')

                response = redirect('/admin/dashboard')
                response.set_cookie('admin_session', self.admin_session_token, httponly=True, max_age=3600)
                return response
            else:
                self.add_admin_log('WARN', 'Failed admin login attempt')
                return self.render_admin_login_page(error='Invalid password')

        @self.app.route('/admin/dashboard')
        def admin_dashboard():
            """Admin dashboard"""
            session_token = request.cookies.get('admin_session')
            if not session_token or session_token != self.admin_session_token:
                return redirect('/admin')
            return self.render_admin_dashboard()

        @self.app.route('/admin/logout')
        def admin_logout():
            """Admin logout"""
            self.add_admin_log('INFO', 'Admin logged out')
            self.admin_session_token = None
            response = redirect('/admin')
            response.delete_cookie('admin_session')
            return response

        @self.app.route('/api/admin/logs')
        def api_admin_logs():
            """Get admin logs"""
            session_token = request.cookies.get('admin_session')
            if not session_token or session_token != self.admin_session_token:
                return jsonify({'error': 'Unauthorized'}), 401

            # Get optional filters
            level = request.args.get('level', None)
            limit = int(request.args.get('limit', 100))

            logs = self.admin_logs[-limit:]
            if level:
                logs = [l for l in logs if l['level'] == level.upper()]

            return jsonify({'logs': logs})

        @self.app.route('/api/admin/status')
        def api_admin_status():
            """Get detailed admin status"""
            session_token = request.cookies.get('admin_session')
            if not session_token or session_token != self.admin_session_token:
                return jsonify({'error': 'Unauthorized'}), 401

            # Count screenshots from today's logs
            # Use UTC date to match log timestamps which are stored in UTC
            today_utc = datetime.now(timezone.utc).date().isoformat()
            screenshots_today = sum(1 for log in self.admin_logs 
                                   if 'Screenshot captured' in log.get('message', '') 
                                   and log.get('timestamp', '').startswith(today_utc))

            # Get session start time from first log or tracking start
            session_start = None
            if self.admin_logs:
                session_start = self.admin_logs[0].get('timestamp')

            # Get version info
            version_info = self.latest_version_info or {}
            
            return jsonify({
                'tracking_active': self.tracking_active,
                'is_idle': self.is_idle,
                'running': self.running,
                'current_user': self.current_user.get('email') if self.current_user else None,
                'organization': self.organization_name,
                'online': self.offline_manager.check_connectivity(force=False),
                'offline_pending': self.offline_manager.get_pending_count(),
                'capture_interval': self.capture_interval,
                'screenshot_interval': self.capture_interval,
                'tracking_settings': self.tracking_settings,
                'total_logs': len(self.admin_logs),
                'screenshots_today': screenshots_today,
                'session_start': session_start,
                # Version info
                'app_version': self.app_version,
                'update_available': self.update_available,
                'latest_version': version_info.get('latest_version'),
                'download_url': version_info.get('download_url'),
                'release_notes': version_info.get('release_notes'),
                'is_mandatory_update': version_info.get('is_mandatory', False),
                'checksum': version_info.get('checksum'),  # SHA256 for integrity verification
                'file_size_bytes': version_info.get('file_size_bytes')
            })

        @self.app.route('/api/admin/control', methods=['POST'])
        def api_admin_control():
            """Admin control actions"""
            session_token = request.cookies.get('admin_session')
            if not session_token or session_token != self.admin_session_token:
                return jsonify({'error': 'Unauthorized'}), 401

            data = request.get_json() or {}
            action = data.get('action')

            if action == 'start_tracking':
                # GDPR compliance: Check consent before starting tracking
                if self.current_user:
                    user_account_id = self.current_user.get('account_id')
                    if not self.consent_manager.has_valid_consent(user_account_id):
                        self.add_admin_log('WARN', 'Cannot start tracking - user consent not given')
                        return jsonify({
                            'success': False,
                            'error': 'User consent required before tracking can start',
                            'redirect': '/consent'
                        }), 403

                if not self.running:
                    self.start_tracking()
                    self.add_admin_log('INFO', 'Tracking started by admin')
                return jsonify({'success': True, 'message': 'Tracking started'})

            elif action == 'stop_tracking':
                if self.running:
                    self.stop_tracking()
                    self.add_admin_log('INFO', 'Tracking stopped by admin')
                return jsonify({'success': True, 'message': 'Tracking stopped'})

            elif action == 'pause_tracking':
                if self.tracking_active:
                    self.pause_tracking()
                    self.add_admin_log('INFO', 'Tracking paused by user')
                return jsonify({'success': True, 'message': 'Tracking paused'})

            elif action == 'resume_tracking':
                if not self.tracking_active and self.running:
                    self.resume_tracking()
                    self.add_admin_log('INFO', 'Tracking resumed by user')
                return jsonify({'success': True, 'message': 'Tracking resumed'})

            elif action == 'clear_logs':
                self.admin_logs = []
                self.add_admin_log('INFO', 'Logs cleared by admin')
                return jsonify({'success': True, 'message': 'Logs cleared'})

            elif action == 'force_sync':
                try:
                    synced, failed = self.offline_manager.sync_pending_screenshots(self)
                    self.add_admin_log('INFO', f'Force sync completed: {synced} synced, {failed} failed')
                    return jsonify({'success': True, 'synced': synced, 'failed': failed})
                except Exception as e:
                    self.add_admin_log('ERROR', f'Force sync failed: {str(e)}')
                    return jsonify({'success': False, 'error': str(e)}), 500

            elif action == 'refresh_settings':
                self.fetch_tracking_settings()
                self.add_admin_log('INFO', 'Settings refreshed by admin')
                return jsonify({'success': True, 'message': 'Settings refreshed'})

            elif action == 'clear_user_credentials':
                # Clear user credentials (logout user) - for testing purposes
                try:
                    user_email = self.current_user.get('email', 'Unknown') if self.current_user else 'No user'

                    # Update desktop status to logged out (before clearing user_id)
                    self._update_desktop_status(logged_in=False)

                    # Stop tracking first
                    if self.running:
                        self.stop_tracking()

                    # Clear auth tokens (from keyring and JSON)
                    self.auth_manager.logout()

                    # Clear user state
                    self.current_user = None
                    self.current_user_id = None

                    # Clear Supabase state (will be re-initialized on next login)
                    self.supabase = None
                    self.supabase_initialized = False

                    # Clear organization state
                    self.organization_id = None
                    self.organization_name = None
                    self.jira_instance_url = None

                    # Update tray menu to show "Login" again
                    self.update_tray_menu()
                    self.update_tray_icon()

                    self.add_admin_log('INFO', f'User credentials cleared by admin (was: {user_email})')
                    return jsonify({
                        'success': True,
                        'message': f'User credentials cleared. Previous user: {user_email}'
                    })
                except Exception as e:
                    self.add_admin_log('ERROR', f'Failed to clear user credentials: {str(e)}')
                    return jsonify({'success': False, 'error': str(e)}), 500

            else:
                return jsonify({'error': 'Unknown action'}), 400

        # ============================================================================
        # PAUSE SETTINGS API
        # ============================================================================

        @self.app.route('/api/pause-settings', methods=['GET', 'POST'])
        def pause_settings_api():
            """Get or update pause settings"""
            if request.method == 'GET':
                return jsonify({
                    'success': True,
                    'settings': self.pause_settings
                })
            elif request.method == 'POST':
                try:
                    data = request.get_json()
                    if not data:
                        return jsonify({'success': False, 'error': 'No data provided'}), 400

                    # Update settings
                    if 'timed_pause_enabled' in data:
                        self.pause_settings['timed_pause_enabled'] = bool(data['timed_pause_enabled'])
                    if 'pause_durations' in data:
                        # Validate durations are positive integers
                        durations = data['pause_durations']
                        if isinstance(durations, list) and all(isinstance(d, int) and d > 0 for d in durations):
                            self.pause_settings['pause_durations'] = sorted(durations)
                    if 'show_resume_notification' in data:
                        self.pause_settings['show_resume_notification'] = bool(data['show_resume_notification'])
                    if 'pause_reminder_enabled' in data:
                        self.pause_settings['pause_reminder_enabled'] = bool(data['pause_reminder_enabled'])
                    if 'pause_reminder_interval' in data:
                        interval = int(data['pause_reminder_interval'])
                        if interval >= 5:  # Minimum 5 minutes
                            self.pause_settings['pause_reminder_interval'] = interval

                    # Save to file
                    if self.save_pause_settings():
                        self.add_admin_log('INFO', 'Pause settings updated')
                        return jsonify({
                            'success': True,
                            'message': 'Pause settings saved',
                            'settings': self.pause_settings
                        })
                    else:
                        return jsonify({'success': False, 'error': 'Failed to save settings'}), 500

                except Exception as e:
                    return jsonify({'success': False, 'error': str(e)}), 500

        # ============================================================================
        # APP CLASSIFICATION VIEWER PAGE
        # ============================================================================

        @self.app.route('/classifications')
        def classifications_page():
            """Display the app classification rules page."""
            if not self.current_user:
                return redirect('/login')
            return self.render_classifications_page()

        # ============================================================================
        # CONSENT ROUTES (GDPR/Privacy Compliance)
        # ============================================================================

        @self.app.route('/consent')
        def consent_page():
            """Display consent page for screenshot capture"""
            if not self.current_user:
                return redirect('/login')
            return self.render_consent_page()

        @self.app.route('/consent/submit', methods=['POST'])
        def consent_submit():
            """Handle consent form submission"""
            if not self.current_user:
                return redirect('/login')

            consented = request.form.get('consent') == 'agree'
            user_id = self.current_user.get('account_id')
            user_email = self.current_user.get('email')

            if consented:
                # Record consent
                self.consent_manager.record_consent(user_id, True, user_email)
                self.add_admin_log('INFO', f'User {user_email} granted consent for screenshot capture')

                # Now start tracking
                if not self.running:
                    self.start_tracking()

                return redirect('/success')
            else:
                # Record denial
                self.consent_manager.record_consent(user_id, False, user_email)
                self.add_admin_log('INFO', f'User {user_email} denied consent for screenshot capture')
                return self.render_consent_denied_page()

        @self.app.route('/consent/revoke', methods=['POST'])
        def consent_revoke():
            """Revoke previously given consent"""
            if not self.current_user:
                return jsonify({'error': 'Not authenticated'}), 401

            user_id = self.current_user.get('account_id')
            user_email = self.current_user.get('email')

            # Revoke consent
            self.consent_manager.revoke_consent(user_id)

            # Stop tracking
            if self.running:
                self.stop_tracking()

            self.add_admin_log('INFO', f'User {user_email} revoked consent for screenshot capture')
            return jsonify({'success': True, 'message': 'Consent revoked. Screenshot tracking has been stopped.'})

        @self.app.route('/api/consent/status')
        def api_consent_status():
            """Get consent status for current user"""
            if not self.current_user:
                return jsonify({'error': 'Not authenticated'}), 401

            user_id = self.current_user.get('account_id')
            has_consent = self.consent_manager.has_valid_consent(user_id)
            consent_info = self.consent_manager.get_consent_info(user_id)

            return jsonify({
                'has_consent': has_consent,
                'consent_version': ConsentManager.CONSENT_VERSION,
                'consent_info': consent_info
            })

        # ============================================================================
        # UPDATE INSTALL API (triggered from notification click)
        # ============================================================================

        @self.app.route('/api/update/install')
        def trigger_update_install():
            """Trigger update installation from notification click. Auto-closes the browser tab."""
            auto_close_page = lambda title, msg: (
                f'<html><head><title>{title}</title>'
                f'<script>setTimeout(function(){{window.close()}},1500)</script>'
                f'</head><body style="font-family:sans-serif;padding:20px">'
                f'<h2>{title}</h2><p>{msg}</p>'
                f'<p style="color:#888;font-size:12px">This tab will close automatically.</p>'
                f'</body></html>'
            )
            if not self.update_manager:
                return auto_close_page('Error', 'No update manager available.'), 503
            status = self.update_manager.get_status()
            state = status.get('state', 'idle')
            if state in ('ready', 'mandatory_ready', 'deferred'):
                threading.Thread(target=self.update_manager.apply_update, daemon=True).start()
                return auto_close_page('Installing update...', 'The application will restart shortly.'), 200
            elif state == 'downloading':
                progress = int((status.get('progress', 0) or 0) * 100)
                return auto_close_page(f'Download in progress ({progress}%)', 'The update will install automatically when complete.'), 200
            else:
                return auto_close_page('No update available', 'You are running the latest version.'), 200

        # ============================================================================
        # APP CLASSIFICATION VIEWER API
        # ============================================================================

        @self.app.route('/api/classifications')
        def api_classifications():
            """Return all cached app classification rules grouped by source tier.

            Response shape:
              {
                success: true,
                data: {
                  global: [...],
                  organization: [...],
                  project: { "ATG": [...], "PROJ": [...] }
                },
                current_window: { app, classification },
                summary: { total_effective, productive, non_productive, url_rules, process_rules },
                current_project: "ATG",
                known_projects: ["ATG", "PROJ"],
                last_synced: <epoch_seconds>
              }
            """
            if not self.current_user:
                return jsonify({'error': 'Not authenticated'}), 401

            try:
                conn = self.db_manager.get_connection()
                cursor = conn.cursor()
                cursor.execute('''
                    SELECT identifier, display_name, classification, match_by,
                           source, source_project_key, cached_at
                    FROM app_classifications_cache
                    ORDER BY source, classification, match_by, identifier
                ''')
                rows = cursor.fetchall()

                grouped = {'global': [], 'organization': [], 'project': {}}
                for (ident, disp, cls, mby, src, sproj, cat) in rows:
                    entry = {
                        'identifier': ident,
                        'display_name': disp or ident,
                        'classification': cls,
                        'match_by': mby,
                        'source': src,
                        'source_project_key': sproj,
                        'cached_at': cat,
                    }
                    if src == 'project':
                        pk = sproj or 'unknown'
                        grouped['project'].setdefault(pk, []).append(entry)
                    elif src == 'organization':
                        grouped['organization'].append(entry)
                    else:
                        grouped['global'].append(entry)

                # Live current-window classification from active_sessions
                current_app = None
                current_cls = None
                try:
                    active_cursor = conn.cursor()
                    active_cursor.execute('''
                        SELECT application_name, classification
                        FROM active_sessions
                        ORDER BY last_seen DESC LIMIT 1
                    ''')
                    row = active_cursor.fetchone()
                    if row:
                        current_app, current_cls = row
                except Exception:
                    pass

                # Summary from in-memory dicts (reflect effective merged state)
                proc_map = self.classification_manager.process_classifications
                url_map = self.classification_manager.url_classifications
                wildcards = self.classification_manager.url_wildcard_patterns
                productive = sum(1 for v in proc_map.values() if v == 'productive')
                non_productive = sum(1 for v in proc_map.values() if v == 'non_productive')

                return jsonify({
                    'success': True,
                    'data': grouped,
                    'current_window': {
                        'app': current_app,
                        'classification': current_cls,
                    },
                    'summary': {
                        'total_effective': len(proc_map) + len(url_map) + len(wildcards),
                        'productive': productive,
                        'non_productive': non_productive,
                        'process_rules': len(proc_map),
                        'url_rules': len(url_map) + len(wildcards),
                    },
                    'current_project': self.current_project_key,
                    'known_projects': sorted(self._get_known_project_keys()),
                    'last_synced': self.last_classification_sync,
                })

            except Exception as e:
                print(f"[ERROR] /api/classifications failed: {e}")
                return jsonify({'error': str(e)}), 500

        @self.app.route('/api/classifications/refresh', methods=['POST'])
        def api_classifications_refresh():
            """Trigger an on-demand sync of classification rules from Supabase."""
            if not self.current_user:
                return jsonify({'error': 'Not authenticated'}), 401
            if not self.supabase:
                return jsonify({'error': 'Not connected to Supabase'}), 503

            try:
                self.classification_manager.sync_classifications(
                    self.supabase,
                    self.organization_id,
                    self.current_project_key,
                    all_project_keys=list(self._get_known_project_keys()),
                )
                self.last_classification_sync = time.time()
                return jsonify({'success': True, 'message': 'Classifications refreshed'})
            except Exception as e:
                print(f"[ERROR] /api/classifications/refresh failed: {e}")
                return jsonify({'error': str(e)}), 500

        # ============================================================================
        # APPLICATION DETECTION API (for Admin App Classification)
        # ============================================================================

        @self.app.route('/api/search-running-app', methods=['POST'])
        def search_running_app():
            """
            Search running processes for an application matching the search term.
            Used when admin searches for an app not in the database.
            
            Request body:
                { "search_term": "Zoom" }
            
            Returns matching running process with metadata if found.
            """
            try:
                data = request.get_json()
                search_term = (data.get('search_term') or '').strip().lower() if data else ''
                
                if not search_term or len(search_term) < 2:
                    return jsonify({
                        'success': False,
                        'error': 'search_term must be at least 2 characters'
                    }), 400
                
                # System processes to skip
                SYSTEM_PROCESSES = {
                    'svchost.exe', 'conhost.exe', 'csrss.exe', 'dwm.exe',
                    'system', 'registry', 'idle', 'smss.exe', 'lsass.exe',
                    'services.exe', 'wininit.exe', 'winlogon.exe', 'fontdrvhost.exe',
                    'spoolsv.exe', 'searchindexer.exe', 'audiodg.exe', 'runtimebroker.exe',
                    'searchhost.exe', 'sihost.exe', 'taskhostw.exe', 'ctfmon.exe',
                    'securityhealthservice.exe', 'sgrmbroker.exe', 'searchprotocolhost.exe'
                }
                
                matches = []
                seen_names = set()
                
                for proc in psutil.process_iter(['pid', 'name', 'exe']):
                    try:
                        info = proc.info
                        name = info.get('name', '')
                        exe_path = info.get('exe')
                        
                        # Skip system processes
                        if name.lower() in SYSTEM_PROCESSES:
                            continue
                        
                        # Skip duplicates
                        name_lower = name.lower()
                        if name_lower in seen_names:
                            continue
                        seen_names.add(name_lower)
                        
                        # Skip processes without exe path
                        if not exe_path:
                            continue
                        
                        # Check if search term matches process name or display name
                        name_without_ext = name_lower.replace('.exe', '').replace('.app', '')
                        
                        # Try to get display name for better matching
                        display_name = None
                        description = None
                        company = None
                        version = None
                        
                        if WIN32_AVAILABLE:
                            try:
                                version_info = self._get_file_version_info(exe_path)
                                if version_info:
                                    display_name = version_info.get('ProductName', '')
                                    description = version_info.get('FileDescription', '')
                                    company = version_info.get('CompanyName', '')
                                    version = version_info.get('FileVersion', '')
                            except Exception:
                                pass
                        
                        # Match against process name, display name, or description
                        searchable = f"{name_without_ext} {display_name or ''} {description or ''}".lower()
                        
                        if search_term in searchable:
                            match_score = 1.0 if search_term == name_without_ext else 0.8
                            if display_name and search_term in display_name.lower():
                                match_score = 0.95
                            
                            matches.append({
                                'identifier': name,  # The actual process name (e.g., "Zoom.exe")
                                'display_name': display_name or name.replace('.exe', '').replace('.app', '').title(),
                                'description': description,
                                'company': company,
                                'version': version,
                                'executable_path': exe_path,
                                'match_score': match_score,
                                'source': 'psutil',
                                'confidence': 'high' if display_name else 'medium'
                            })
                            
                    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                        continue
                
                # Sort by match score (best matches first)
                matches.sort(key=lambda x: x['match_score'], reverse=True)
                
                if matches:
                    return jsonify({
                        'success': True,
                        'found': True,
                        'matches': matches[:5],  # Return top 5 matches
                        'best_match': matches[0]
                    })
                else:
                    return jsonify({
                        'success': True,
                        'found': False,
                        'matches': [],
                        'message': f'No running process found matching "{search_term}"'
                    })
                
            except Exception as e:
                self.add_admin_log('ERROR', f'search_running_app failed: {str(e)}')
                return jsonify({
                    'success': False,
                    'error': str(e)
                }), 500

        # ============================================================================
        # USER SETTINGS PAGE (Accessible to all users via system tray)
        # ============================================================================

        @self.app.route('/settings')
        def settings_page():
            """User settings page - accessible to all users"""
            return self.render_settings_page()

    # ============================================================================
    # ADMIN HELPER METHODS
    # ============================================================================

    def add_admin_log(self, level, message, details=None):
        """Add a log entry for admin panel

        Args:
            level: Log level (INFO, WARN, ERROR)
            message: Log message
            details: Optional dict with additional details to display
        """
        log_entry = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'level': level.upper(),
            'message': message
        }
        if details:
            log_entry['details'] = details
        self.admin_logs.append(log_entry)

        # Keep only last N entries
        if len(self.admin_logs) > self.max_log_entries:
            self.admin_logs = self.admin_logs[-self.max_log_entries:]

    def refresh_supabase_client(self):
        """Refresh the Supabase JWT on the client"""
        return self._set_supabase_jwt()

    def ensure_user_exists(self, atlassian_user):
        """Ensure user exists in Supabase users table and is linked to organization"""
        account_id = atlassian_user.get('account_id')
        email = atlassian_user.get('email')
        name = atlassian_user.get('name', email.split('@')[0] if email else 'User')

        if not account_id:
            raise ValueError("No account_id in Atlassian user info")

        # First, ensure we have organization info
        if not self.organization_id:
            self.get_jira_cloud_id()  # This will also register the organization

        # Use RLS-scoped client (JWT grants access to own records)
        client = self.supabase

        # Check if user exists
        result = client.table('users').select('id, organization_id').eq(
            'atlassian_account_id', account_id
        ).execute()

        if result.data:
            user_id = result.data[0]['id']
            existing_org_id = result.data[0].get('organization_id')
            secure_log("[OK] Found existing user", user_id=user_id)

            # Check if we need to update user details
            existing_user = client.table('users').select('display_name, email').eq('id', user_id).execute()
            existing_display_name = existing_user.data[0].get('display_name') if existing_user.data else None
            existing_email = existing_user.data[0].get('email') if existing_user.data else None

            # Update if organization changed OR if details are missing
            needs_update = (
                (self.organization_id and existing_org_id != self.organization_id) or
                (not existing_display_name and name) or
                (not existing_email and email)
            )

            if needs_update:
                update_data = {
                    'organization_id': self.organization_id or existing_org_id,
                    'display_name': name or existing_display_name,
                    'email': email or existing_email
                }
                client.table('users').update(update_data).eq('id', user_id).execute()
                secure_log("[OK] Updated user details", org_id=self.organization_id, name=name)

                # Ensure organization membership exists
                if self.organization_id:
                    self._ensure_organization_membership(user_id)
        else:
            # Create new user with organization
            user_data = {
                'atlassian_account_id': account_id,
                'email': email,
                'display_name': name,
                'organization_id': self.organization_id
            }
            create_result = client.table('users').insert(user_data).execute()
            if create_result.data:
                user_id = create_result.data[0]['id']
                secure_log("[OK] Created new user", user_id=user_id)

                # Create organization membership
                self._ensure_organization_membership(user_id)
            else:
                raise Exception("Failed to create user")

        # Cache user info for offline mode
        self._save_cached_user_info(atlassian_user, user_id)
        
        return user_id

    def _get_file_version_info(self, exe_path):
        """
        Extract file version information from an executable using Windows API.
        Returns dict with ProductName, FileDescription, CompanyName, FileVersion.
        """
        if not WIN32_AVAILABLE:
            return None
        
        try:
            # Get the fixed file info
            info = {}
            
            try:
                # Get the file version info block
                fixed_info = win32api.GetFileVersionInfo(exe_path, '\\')
                
                # Get the language and codepage
                lang_info = win32api.GetFileVersionInfo(exe_path, '\\VarFileInfo\\Translation')
                if lang_info:
                    # Use the first language/codepage pair
                    lang, codepage = lang_info[0]
                    
                    # String file info keys we want
                    keys = ['ProductName', 'FileDescription', 'CompanyName', 'FileVersion', 'ProductVersion']
                    
                    for key in keys:
                        try:
                            str_info_path = f'\\StringFileInfo\\{lang:04x}{codepage:04x}\\{key}'
                            value = win32api.GetFileVersionInfo(exe_path, str_info_path)
                            if value:
                                info[key] = value.strip()
                        except Exception:
                            pass
                            
            except Exception:
                pass
            
            return info if info else None
            
        except Exception as e:
            return None

    def _get_user_cache_path(self):
        """Get path to user cache file"""
        return os.path.join(get_app_data_dir(), 'time_tracker_user_cache.json')
    
    def _save_cached_user_info(self, atlassian_user, user_id):
        """Save user info locally for offline mode"""
        try:
            cache_data = {
                'account_id': atlassian_user.get('account_id'),
                'email': atlassian_user.get('email'),
                'name': atlassian_user.get('name'),
                'user_id': user_id,
                'organization_id': self.organization_id,
                'cached_at': datetime.now(timezone.utc).isoformat()
            }
            with open(self._get_user_cache_path(), 'w') as f:
                json.dump(cache_data, f)
            print(f"[OK] User info cached for offline mode")
        except Exception as e:
            print(f"[WARN] Failed to cache user info: {e}")
    
    def _load_cached_user_info(self):
        """Load cached user info for offline mode"""
        try:
            cache_path = self._get_user_cache_path()
            if os.path.exists(cache_path):
                with open(cache_path, 'r') as f:
                    cache_data = json.load(f)
                
                # Restore organization_id from cache
                if cache_data.get('organization_id'):
                    self.organization_id = cache_data['organization_id']
                
                return cache_data
        except Exception as e:
            print(f"[WARN] Failed to load cached user info: {e}")
        return None
    
    def _clear_cached_user_info(self):
        """Clear stale cached user info (e.g. after FK violation from deleted user).
        Forces re-authentication on next startup."""
        try:
            cache_path = self._get_user_cache_path()
            if os.path.exists(cache_path):
                os.remove(cache_path)
                print("[OK] Cleared stale cached user info")
        except Exception as e:
            print(f"[WARN] Failed to clear cached user info: {e}")

    def _load_cached_user_id(self):
        """Load only the user_id from cache"""
        cached = self._load_cached_user_info()
        if cached:
            return cached.get('user_id')
        return None

    def _update_desktop_status(self, logged_in=True):
        """Update desktop app login status in Supabase.

        Args:
            logged_in: True when logging in, False when logging out

        Returns:
            bool: True if successful, False if failed
        """
        if not self.current_user_id or self.current_user_id.startswith('anonymous_'):
            return False

        try:
            client = self.supabase
            if not client:
                print("[WARN] No Supabase client available for status update")
                return False

            update_data = {
                'desktop_logged_in': logged_in,
                'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat()
            }

            # Add app version if logging in
            if logged_in:
                update_data['desktop_app_version'] = self.app_version

            result = client.table('users').update(update_data).eq('id', self.current_user_id).execute()
            if not result.data or len(result.data) == 0:
                print("[WARN] Desktop status update returned no rows - RLS may be blocking")
                return False

            status_text = "logged in" if logged_in else "logged out"
            print(f"[OK] Desktop status updated: {status_text}")
            return True

        except Exception as e:
            print(f"[WARN] Failed to update desktop status: {e}")
            traceback.print_exc()
            return False

    def _send_heartbeat(self):
        """Send heartbeat to Supabase to indicate app is still running.
        
        CRITICAL: Validates JWT before UPDATE to prevent silent failures.
        Pattern copied from batch upload (line 8243) which includes developer
        comment: "JWT expires after ~1 hour; without this check, all uploads
        silently fail"
        """
        if not self.current_user_id or self.current_user_id.startswith('anonymous_'):
            return

        try:
            client = self.supabase
            if not client:
                return

            # CRITICAL: Ensure JWT is valid before sending heartbeat
            # (JWT expires after 1 hour; without this check, updates silently fail)
            sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
            if sb_expires_at and time.time() > (sb_expires_at - 300):
                print("[HEARTBEAT] Supabase JWT expired — refreshing before update...")
                if not self._set_supabase_jwt():
                    print("[HEARTBEAT] JWT refresh failed — heartbeat skipped (will retry in 4 hours)")
                    # Log to admin panel for visibility
                    self.add_admin_log('WARN', 'Heartbeat skipped: JWT refresh failed. Re-login may be required.')
                    return  # Skip this heartbeat, don't proceed with expired JWT
            elif not sb_expires_at:
                # No expiry info stored — proactively refresh to be safe
                print("[HEARTBEAT] No JWT expiry info — refreshing proactively...")
                if not self._set_supabase_jwt():
                    print("[HEARTBEAT] Proactive JWT refresh failed — proceeding with caution")
                    # Don't return - attempt the update anyway (JWT might still be valid)

            result = client.table('users').update({
                'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
                'desktop_app_version': self.app_version,
                'desktop_logged_in': True   # Heartbeat proves the app is running; repair stale false
            }).eq('id', self.current_user_id).execute()

            # CRITICAL: Verify the update actually affected a row
            # Empty result.data means RLS blocked the write (expired JWT or wrong supabase_user_id)
            if not result.data or len(result.data) == 0:
                print(f"[WARN] Heartbeat update affected 0 rows - RLS may be blocking update")
                print(f"[WARN] User ID: {self.current_user_id}, Version: {self.app_version}")
                print(f"[WARN] This usually means JWT is expired or supabase_user_id is incorrect")
                # Force a JWT refresh and retry immediately rather than waiting 4 more hours
                if self._set_supabase_jwt():
                    retry_result = client.table('users').update({
                        'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
                        'desktop_app_version': self.app_version,
                        'desktop_logged_in': True
                    }).eq('id', self.current_user_id).execute()
                    if retry_result.data and len(retry_result.data) > 0:
                        print(f"[OK] Heartbeat retry succeeded after JWT refresh (v{self.app_version})")
                        return
                # Log to admin panel with diagnostic info
                self.add_admin_log('ERROR', 
                    f'Heartbeat failed: UPDATE affected 0 rows (version={self.app_version}). '
                    f'Re-login may be required. User ID: {self.current_user_id}'
                )
            else:
                print(f"[OK] Heartbeat sent (v{self.app_version})")

        except Exception as e:
            print(f"[WARN] Failed to send heartbeat: {e}")
            # Log exception to admin panel with full traceback
            import traceback
            error_detail = traceback.format_exc()
            self.add_admin_log('ERROR', f'Heartbeat exception: {str(e)}\n{error_detail}')

    def _associate_offline_records(self):
        """Associate any anonymous offline records with the current user"""
        if not self.current_user_id or self.current_user_id.startswith('anonymous_'):
            return
        
        # Get count of anonymous records
        anonymous_count = self.offline_manager.get_anonymous_count()
        
        if anonymous_count > 0:
            print(f"[INFO] Found {anonymous_count} anonymous screenshots to associate...")
            updated = self.offline_manager.associate_anonymous_records(
                self.current_user_id,
                self.organization_id
            )
            
            if updated > 0:
                # Trigger sync to upload the newly associated records
                print(f"[INFO] Triggering sync for {updated} newly associated screenshots...")
                threading.Thread(
                    target=lambda: self.sync_offline_data(force=True),
                    daemon=True
                ).start()

    def _ensure_organization_membership(self, user_id):
        """Ensure user has membership entry in organization_members table"""
        if not self.organization_id or not user_id:
            return

        try:
            client = self.supabase

            # Check if membership exists
            result = client.table('organization_members').select('id').eq(
                'user_id', user_id
            ).eq('organization_id', self.organization_id).execute()

            if not result.data:
                # Insert as 'member' only — the AI server handles first-user-is-owner
                # logic with service role (bypasses RLS). The RLS policy only allows
                # role='member' with all permissions false to prevent privilege escalation.
                membership_data = {
                    'user_id': user_id,
                    'organization_id': self.organization_id,
                    'role': 'member',
                    'can_manage_settings': False,
                    'can_view_team_analytics': False,
                    'can_manage_members': False,
                    'can_delete_screenshots': False,
                    'can_manage_billing': False
                }
                client.table('organization_members').insert(membership_data).execute()
                print("[OK] Created organization membership with role: member")

        except Exception as e:
            print(f"[WARN] Failed to create organization membership: {e}")
    
    def get_jira_cloud_id(self):
        """Get Jira cloud ID for API calls with automatic token refresh on 401"""
        # Non-Jira (Google SSO) users have no Jira identity — never call Atlassian.
        if self.auth_manager.auth_provider == 'google':
            return None
        if self.jira_cloud_id:
            return self.jira_cloud_id

        access_token = self.auth_manager.tokens.get('access_token')
        if not access_token:
            print("[WARN] No access token found for Jira Cloud ID fetch")
            return None

        try:
            print("[INFO] Fetching Jira Cloud ID...")
            response = requests.get(
                'https://api.atlassian.com/oauth/token/accessible-resources',
                headers={'Authorization': f'Bearer {access_token}'}
            )

            # Handle 401 - token expired
            if response.status_code == 401:
                print("[WARN] Access token expired (401), attempting refresh...")
                if self.auth_manager.refresh_access_token():
                    # Retry with new token
                    access_token = self.auth_manager.tokens.get('access_token')
                    response = requests.get(
                        'https://api.atlassian.com/oauth/token/accessible-resources',
                        headers={'Authorization': f'Bearer {access_token}'}
                    )
                else:
                    print("[ERROR] Token refresh failed, please re-authenticate")
                    return None

            if response.status_code == 200:
                resources = response.json()
                print(f"[INFO] Found {len(resources)} accessible resources")
                if resources:
                    # Store ALL accessible resources for multi-site support
                    self.all_jira_resources = resources
                    self.all_jira_cloud_ids = [r['id'] for r in resources]

                    if len(resources) > 1:
                        print(f"[MULTI-SITE] User has access to {len(resources)} Jira sites:")
                        for i, r in enumerate(resources):
                            print(f"     [{i}] {r.get('name', '?')} — {r.get('url', '?')} (id: {r['id']})")

                    # Prefer the jira_cloud_id returned by exchange-token (authoritative):
                    # it reflects which Jira instance the Forge app is installed in and
                    # which organization_id the user belongs to in our DB.
                    # Falling back to resources[0] is WRONG when the user has access to
                    # multiple Jira sites (e.g. prod + dev) because the order returned by
                    # accessible-resources is arbitrary and may not be the production site.
                    exchange_cloud_id = self.auth_manager.tokens.get('exchange_jira_cloud_id')
                    if exchange_cloud_id:
                        matched = next((r for r in resources if r['id'] == exchange_cloud_id), None)
                        if matched:
                            selected_resource = matched
                            print(f"[OK] Using jira_cloud_id from exchange-token: {exchange_cloud_id}")
                        else:
                            # exchange-token cloud_id not in accessible-resources — fall back to first
                            print(f"[WARN] exchange-token jira_cloud_id {exchange_cloud_id} not found in accessible-resources; falling back to resources[0]")
                            selected_resource = resources[0]
                    else:
                        # No cloud_id from exchange-token yet (first run before token exchange)
                        selected_resource = resources[0]

                    self.jira_cloud_id = selected_resource['id']
                    self.organization_name = selected_resource.get('name', 'Unknown Organization')
                    self.jira_instance_url = selected_resource.get('url', '')

                    secure_log("[OK] Using Jira Cloud ID", cloud_id=self.jira_cloud_id)
                    print(f"[OK] Organization: {self.organization_name}")
                    print(f"[OK] Jira URL: {self.jira_instance_url}")

                    # Register organization in database
                    self.register_organization()

                    return self.jira_cloud_id
            else:
                print(f"[ERROR] Failed to get resources: {response.status_code} - {response.text}")
        except Exception as e:
            print(f"[ERROR] Failed to get Jira cloud ID: {e}")

        return None

    def register_organization(self):
        """Register or update organization in Supabase database with retry logic.
        
        The AI server already creates/finds the organization during token exchange
        (via service_role, bypassing RLS). If organization_id was set from the
        exchange-token response, this method just verifies/updates the org info.
        """
        if not self.jira_cloud_id:
            print("[WARN] Cannot register organization: No Jira Cloud ID")
            return None

        # If organization_id was already set from exchange-token, just verify it
        if self.organization_id:
            print(f"[OK] Organization already set from exchange-token: {self.organization_id}")
            # Try to update org info (name, URL) if possible
            try:
                client = self.supabase
                if client:
                    client.table('organizations').update({
                        'org_name': self.organization_name,
                        'jira_instance_url': self.jira_instance_url
                    }).eq('id', self.organization_id).execute()
            except Exception as e:
                print(f"[WARN] Could not update organization info: {e}")
            return self.organization_id

        max_retries = 3
        retry_delay = 2  # seconds
        
        for attempt in range(max_retries):
            try:
                # Use RLS-scoped client
                client = self.supabase

                # Check if organization already exists
                # NOTE: RLS on organizations table requires user's organization_id to be set
                # in the users table. If this returns empty, it may be an RLS issue.
                print(f"[DEBUG] register_organization: querying orgs by jira_cloud_id={self.jira_cloud_id}")
                result = client.table('organizations').select('id').eq(
                    'jira_cloud_id', self.jira_cloud_id
                ).execute()
                print(f"[DEBUG] register_organization: SELECT returned {len(result.data)} rows")

                if result.data:
                    # Organization exists
                    self.organization_id = result.data[0]['id']
                    secure_log("[OK] Found existing organization", org_id=self.organization_id)

                    # Update organization info if changed
                    client.table('organizations').update({
                        'org_name': self.organization_name,
                        'jira_instance_url': self.jira_instance_url
                    }).eq('id', self.organization_id).execute()
                else:
                    # Create new organization
                    org_data = {
                        'jira_cloud_id': self.jira_cloud_id,
                        'org_name': self.organization_name,
                        'jira_instance_url': self.jira_instance_url,
                        'subscription_status': 'active',
                        'subscription_tier': 'free'
                    }
                    create_result = client.table('organizations').insert(org_data).execute()

                    if create_result.data:
                        self.organization_id = create_result.data[0]['id']
                        secure_log("[OK] Created new organization", org_id=self.organization_id)

                        # Create default organization settings
                        settings_data = {
                            'organization_id': self.organization_id,
                            'screenshot_interval': self.capture_interval,
                            'auto_worklog_enabled': True
                        }
                        client.table('organization_settings').insert(settings_data).execute()
                        print(f"[OK] Created organization settings")
                    else:
                        raise Exception("Failed to create organization")

                return self.organization_id

            except Exception as e:
                error_msg = str(e).lower()
                is_timeout = 'timeout' in error_msg or 'timed out' in error_msg
                is_connection_error = 'connection' in error_msg or 'network' in error_msg
                
                if attempt < max_retries - 1 and (is_timeout or is_connection_error):
                    wait_time = retry_delay * (2 ** attempt)  # Exponential backoff
                    print(f"[WARN] Organization registration failed (attempt {attempt + 1}/{max_retries}): {e}")
                    print(f"[INFO] Retrying in {wait_time}s... (Network issue: timeout or connection error)")
                    time.sleep(wait_time)
                else:
                    print(f"[ERROR] Failed to register organization: {e}")
                    if is_timeout:
                        print("[INFO] Timeout error - check your network connection or firewall")
                        print(f"[INFO] Supabase URL: {self.supabase_url}")
                    traceback.print_exc()
                    return None
        
        return None

    def fetch_project_settings(self, force_refresh=False):
        """Fetch project settings (tracked statuses) from Supabase
        
        Project admins can configure which statuses to track per project.
        This allows different projects to have different tracked statuses.
        Uses local SQLite cache for offline support.
        
        Returns:
            dict: {project_key: {'tracked_statuses': [...], 'project_name': '...'}, ...}
        """
        # Check in-memory cache first
        if not force_refresh and self.project_settings_cache_time is not None:
            time_since_fetch = time.time() - self.project_settings_cache_time
            if time_since_fetch < self.project_settings_cache_ttl:
                return self.project_settings

        if not self.organization_id:
            print("[WARN] Cannot fetch project settings: No organization ID")
            return self.project_settings or {}

        # Check if online
        is_online = self.offline_manager.check_connectivity()
        
        if not is_online:
            # OFFLINE: Load from local SQLite cache
            print("[INFO] Offline - loading project settings from local cache...")
            cached = self.offline_manager.load_project_settings_cache(self.organization_id)
            if cached:
                self.project_settings = cached
                self.project_settings_cache_time = time.time()
                return self.project_settings
            else:
                print("[WARN] No cached project settings available offline")
                return self.project_settings or {}

        try:
            # ONLINE: Fetch from Supabase
            client = self.supabase
            if not client:
                print("[WARN] Cannot fetch project settings: No Supabase client")
                # Try local cache as fallback
                cached = self.offline_manager.load_project_settings_cache(self.organization_id)
                if cached:
                    self.project_settings = cached
                    self.project_settings_cache_time = time.time()
                return self.project_settings or {}

            print("[INFO] Fetching project settings from Supabase...")
            result = client.table('project_settings') \
                .select('project_key, project_name, tracked_statuses') \
                .eq('organization_id', self.organization_id) \
                .execute()

            if result.data:
                # Convert to dict keyed by project_key
                self.project_settings = {}
                for row in result.data:
                    project_key = row.get('project_key')
                    if project_key:
                        self.project_settings[project_key] = {
                            'tracked_statuses': row.get('tracked_statuses', ['In Progress']),
                            'project_name': row.get('project_name', project_key)
                        }
                
                self.project_settings_cache_time = time.time()
                print(f"[OK] Loaded project settings for {len(self.project_settings)} projects")
                for pk, settings in self.project_settings.items():
                    print(f"     - {pk}: {settings['tracked_statuses']}")
                
                # Save to local cache for offline use
                if self.project_settings:
                    self.offline_manager.save_project_settings_cache(
                        self.organization_id, 
                        self.project_settings
                    )
            else:
                print("[INFO] No project settings found, will use default (In Progress)")
                self.project_settings = {}
                self.project_settings_cache_time = time.time()

            return self.project_settings

        except Exception as e:
            print(f"[ERROR] Failed to fetch project settings: {e}")
            return self.project_settings or {}

    def get_tracked_statuses_for_project(self, project_key):
        """Get tracked statuses for a specific project
        
        Args:
            project_key: Jira project key (e.g., 'PROJ', 'SCRUM')
            
        Returns:
            list: List of status names to track, defaults to ['In Progress']
        """
        # Ensure project settings are loaded
        if not self.project_settings:
            self.fetch_project_settings()
        
        # Get project-specific settings or use default
        if project_key in self.project_settings:
            return self.project_settings[project_key].get('tracked_statuses', ['In Progress'])
        
        # Default fallback
        return ['In Progress']

    def build_jql_for_tracked_statuses(self):
        """Build JQL query using project-level tracked statuses
        
        Fetches issues from ALL projects the user is assigned to.
        For projects with explicit settings, uses their configured statuses.
        For all other projects, uses statusCategory = "In Progress" as default.
        This ensures user_assigned_issues contains issues across ALL projects,
        not just the ones configured in project_settings.
        
        Returns:
            str: JQL query string
        """
        # Fetch project settings if not cached
        self.fetch_project_settings()
        
        if self.project_settings:
            # Build project-specific JQL for configured projects
            # PLUS a catch-all clause for any other projects the user is assigned to
            project_clauses = []
            configured_projects = []
            for project_key, settings in self.project_settings.items():
                statuses = settings.get('tracked_statuses', ['In Progress'])
                if statuses:
                    status_list = ', '.join([f'"{s}"' for s in statuses])
                    clause = f'(project = "{project_key}" AND status IN ({status_list}))'
                    project_clauses.append(clause)
                    configured_projects.append(project_key)
            
            if project_clauses:
                # Add a catch-all clause for projects NOT in project_settings
                # so we still fetch assigned issues from all other projects
                if configured_projects:
                    not_in_list = ', '.join([f'"{pk}"' for pk in configured_projects])
                    catch_all = f'(project NOT IN ({not_in_list}) AND statusCategory = "In Progress" AND updated >= -30d)'
                    project_clauses.append(catch_all)
                
                # Combine all project clauses with OR
                status_filter = ' OR '.join(project_clauses)
                jql = f'assignee = currentUser() AND ({status_filter})'
                print(f"[INFO] Using project-level tracked statuses JQL (with catch-all for unconfigured projects)")
                return jql

        # Fallback: Use statusCategory if no project settings
        print("[INFO] No project settings, using statusCategory = 'In Progress'")
        return 'assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d'

    def fetch_issues_from_cache(self):
        """Read user's issues from user_jira_issues_cache in Supabase.
        Returns a formatted issue list on success, or None if cache is unavailable/empty.
        The desktop app writes issues as user_assigned_issues in activity_records using
        the same format that fetch_jira_issues() produces, so both paths are compatible.
        """
        if not self.supabase or not self.current_user_id or not self.organization_id:
            return None
        try:
            result = self.supabase.table('user_jira_issues_cache') \
                .select('issue_key, issue_summary, project_key, status, description, labels, updated_at, priority') \
                .eq('user_id', self.current_user_id) \
                .eq('organization_id', self.organization_id) \
                .limit(50) \
                .execute()

            rows = result.data if result.data else []
            if not rows:
                print("[INFO] user_jira_issues_cache: empty for this user")
                return None

            formatted = []
            for row in rows:
                labels = row.get('labels') or []
                if isinstance(labels, str):
                    try:
                        labels = json.loads(labels)
                    except Exception:
                        labels = []
                formatted.append({
                    'key': row.get('issue_key', ''),
                    'summary': row.get('issue_summary', ''),
                    'status': row.get('status', ''),
                    'project': row.get('project_key', ''),
                    'description': row.get('description', ''),
                    'labels': labels,
                    'updated': row.get('updated_at', ''),
                    'priority': row.get('priority', '')
                })

            print(f"[INFO] user_jira_issues_cache: loaded {len(formatted)} issues from Supabase")
            return formatted
        except Exception as e:
            print(f"[WARN] user_jira_issues_cache read failed: {e}")
            return None

    def fetch_jira_issues(self):
        """Fetch user's assigned Jira issues across ALL projects.
        Primary path: calls Jira REST API directly for the most complete picture.
        Fallback: reads from user_jira_issues_cache in Supabase when API is
        unavailable (offline, no token, API error).
        """
        # Non-Jira (Google SSO) users have no assigned Jira issues.
        if self.auth_manager.auth_provider == 'google':
            return []
        print("[INFO] Attempting to fetch Jira issues...")

        cloud_id = self.get_jira_cloud_id()
        if not cloud_id:
            print("[WARN] Cannot fetch issues via API: No Cloud ID — trying cache")
            return self.fetch_issues_from_cache() or []

        access_token = self.auth_manager.tokens.get('access_token')
        if not access_token:
            print("[WARN] Cannot fetch issues via API: No access token — trying cache")
            return self.fetch_issues_from_cache() or []

        try:
            # Build JQL using project-level tracked statuses (admin-configured)
            # If project settings exist, uses project-specific statuses
            # plus a catch-all for unconfigured projects.
            # Otherwise, falls back to statusCategory = "In Progress"
            jql = self.build_jql_for_tracked_statuses()
            print(f"[INFO] Querying Jira with JQL (POST): {jql}")

            # Use /search/jql endpoint as requested by the 410 error message
            # Note: The error explicitly said "Please migrate to the /rest/api/3/search/jql API"
            response = requests.post(
                f'https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/search/jql',
                json={
                    'jql': jql,
                    'maxResults': 50,
                    'fields': ['summary', 'status', 'project', 'description', 'labels', 'updated', 'priority']
                },
                headers={
                    'Authorization': f'Bearer {access_token}',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            )
            print(f"!!!DEBUG!!! Main JQL query executed. Response status: {response.status_code}")

            # Handle 401 - token expired
            if response.status_code == 401:
                print("[WARN] Access token expired (401), attempting refresh...")
                if self.auth_manager.refresh_access_token():
                    # Retry with new token
                    access_token = self.auth_manager.tokens.get('access_token')
                    print("[INFO] Retrying Jira API with refreshed token...")
                    response = requests.post(
                        f'https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/search/jql',
                        json={
                            'jql': jql,
                            'maxResults': 50,
                            'fields': ['summary', 'status', 'project', 'description', 'labels', 'updated', 'priority']
                        },
                        headers={
                            'Authorization': f'Bearer {access_token}',
                            'Accept': 'application/json',
                            'Content-Type': 'application/json'
                        }
                    )
                else:
                    print("[ERROR] Token refresh failed, please re-authenticate — trying cache")
                    return self.fetch_issues_from_cache() or []

            if response.status_code == 200:
                data = response.json()
                issues = data.get('issues', [])
                print(f"!!!DEBUG!!! Main JQL response issues: {[i['key'] for i in issues]}")
                print(f"[OK] Jira API returned {len(issues)} issues")

                # If project-level JQL returned 0 issues, try broader fallback so user_assigned_issues is populated
                if not issues:
                    print("!!!DEBUG!!! Entering fallback JQL block for assigned issues.")
                    # Fallback: broad status-based query covering all project types (software, service desk, business)
                    fallback_jql_open = 'assignee = currentUser() AND statusCategory = "In Progress" AND updated >= -30d'
                    print(f"[INFO] Retrying with fallback JQL (status-based, all project types)")
                    fallback_resp_open = requests.post(
                        f'https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/search/jql',
                        json={
                            'jql': fallback_jql_open,
                            'maxResults': 50,
                            'fields': ['summary', 'status', 'project', 'description', 'labels', 'updated', 'priority']
                        },
                        headers={
                            'Authorization': f'Bearer {access_token}',
                            'Accept': 'application/json',
                            'Content-Type': 'application/json'
                        }
                    )
                    issues = []
                    if fallback_resp_open.status_code == 200:
                        fallback_data_open = fallback_resp_open.json()
                        fallback_issues = fallback_data_open.get('issues', [])
                        issues.extend(fallback_issues)
                        print(f"!!!DEBUG!!! Fallback JQL issues: {[i['key'] for i in fallback_issues]}")
                        if fallback_issues:
                            print(f"[OK] Fallback JQL returned {len(fallback_issues)} issues")
                    else:
                        print("!!!DEBUG!!! Fallback JQL query failed or returned no issues.")

                    # No-sprint fallback removed: backlog issues (Sprint is EMPTY)
                    # were polluting user_assigned_issues with items the user isn't
                    # actively working on, causing poor AI issue matching.

                    # Debug: print all combined fallback issues
                    print(f"!!!DEBUG!!! Combined fallback issues: {[i['key'] for i in issues]}")
                    print("!!!DEBUG!!! Exiting fallback JQL block.")
                    # Ensure self.user_issues is updated
                    self.user_issues = issues

                # Extract and format issue data with description and labels
                formatted_issues = []
                for issue in issues:
                    fields = issue['fields']

                    # Get description text (handle ADF format)
                    description = ''
                    if fields.get('description'):
                        # Jira uses Atlassian Document Format (ADF)
                        # Extract plain text from content recursively
                        desc_content = fields['description']
                        if isinstance(desc_content, dict) and desc_content.get('content'):
                            # Recursive text extraction from all ADF node types
                            text_parts = []

                            def extract_text_recursive(node):
                                if not isinstance(node, dict):
                                    return
                                if node.get('type') == 'text':
                                    text_parts.append(node.get('text', ''))
                                for child in node.get('content', []):
                                    extract_text_recursive(child)

                            for content_item in desc_content.get('content', []):
                                extract_text_recursive(content_item)
                            description = ' '.join(text_parts).strip()
                        elif isinstance(desc_content, str):
                            description = desc_content

                    # Get labels (array of strings)
                    labels = fields.get('labels', [])

                    formatted_issues.append({
                        'key': issue['key'],
                        'summary': fields['summary'],
                        'status': fields['status']['name'],
                        'project': fields['project']['key'],
                        'description': description,
                        'labels': labels,
                        'updated': fields.get('updated', ''),
                        'priority': fields.get('priority', {}).get('name', '')
                    })

                return formatted_issues
            else:
                print(f"[ERROR] Jira API failed: {response.status_code} - {response.text}")
                print("[INFO] Falling back to Supabase cache after API failure")
                cached = self.fetch_issues_from_cache()
                if cached is not None:
                    return cached
        except Exception as e:
            print(f"!!!DEBUG!!! Exception occurred in fetch_jira_issues: {e}")
            print(f"[ERROR] Failed to fetch Jira issues: {e}")
            print("[INFO] Falling back to Supabase cache after exception")
            cached = self.fetch_issues_from_cache()
            if cached is not None:
                return cached

        return []

    def should_refresh_issues_cache(self):
        """Check if issues cache needs to be refreshed"""
        if not self.issues_cache_time:
            return True

        return (time.time() - self.issues_cache_time) > self.issues_cache_ttl

    def fetch_jira_projects(self):
        """Fetch user's accessible Jira projects with automatic token refresh on 401

        This is used as a fallback when the user has no assigned issues.
        If they only have access to one project, we can use that as the default.

        Multi-site support: if the user has access to multiple Jira sites,
        fetches projects from ALL sites and merges them.

        Uses the paginated /project/search endpoint (recommended by Atlassian).
        Requires OAuth scope: read:jira-work
        """
        # Non-Jira (Google SSO) users have no Jira projects.
        if self.auth_manager.auth_provider == 'google':
            return []
        print("[INFO] Fetching user's accessible Jira projects...")
        cloud_id = self.get_jira_cloud_id()
        if not cloud_id:
            print("[WARN] Cannot fetch projects: No Cloud ID")
            return []

        access_token = self.auth_manager.tokens.get('access_token')
        if not access_token:
            print("[WARN] Cannot fetch projects: No access token")
            return []

        try:
            # Use /rest/api/3/project/search (paginated, recommended by Atlassian)
            # This returns projects where user has Browse Projects permission
            response = requests.get(
                f'https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/project/search',
                params={
                    'maxResults': 50,
                    'orderBy': 'name'
                },
                headers={
                    'Authorization': f'Bearer {access_token}',
                    'Accept': 'application/json'
                }
            )

            # Handle 401 - token expired
            if response.status_code == 401:
                print("[WARN] Access token expired (401), attempting refresh...")
                if self.auth_manager.refresh_access_token():
                    # Retry with new token
                    access_token = self.auth_manager.tokens.get('access_token')
                    print("[INFO] Retrying Jira API with refreshed token...")
                    response = requests.get(
                        f'https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/project/search',
                        params={
                            'maxResults': 50,
                            'orderBy': 'name'
                        },
                        headers={
                            'Authorization': f'Bearer {access_token}',
                            'Accept': 'application/json'
                        }
                    )
                else:
                    print("[ERROR] Token refresh failed, please re-authenticate")
                    return []

            if response.status_code == 200:
                data = response.json()
                projects = data.get('values', [])
                total = data.get('total', len(projects))
                is_last = data.get('isLast', None)
                print(f"[OK] User has access to {total} projects (fetched {len(projects)} in first page, isLast={is_last})")
                print(f"[DEBUG] Raw project/search response keys: {list(data.keys())}")
                for p in projects:
                    print(f"[DEBUG]   project: key={p.get('key')}, name={p.get('name')}, projectTypeKey={p.get('projectTypeKey')}")

                # Paginate to fetch ALL projects if total > maxResults
                all_projects = list(projects)
                start_at = len(projects)
                while start_at < total:
                    page_response = requests.get(
                        f'https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/project/search',
                        params={
                            'maxResults': 50,
                            'startAt': start_at,
                            'orderBy': 'name'
                        },
                        headers={
                            'Authorization': f'Bearer {access_token}',
                            'Accept': 'application/json'
                        }
                    )
                    if page_response.status_code == 200:
                        page_data = page_response.json()
                        page_projects = page_data.get('values', [])
                        if not page_projects:
                            break
                        all_projects.extend(page_projects)
                        start_at += len(page_projects)
                    else:
                        print(f"[WARN] Pagination failed at startAt={start_at}: {page_response.status_code}")
                        break

                # Format project data
                formatted_projects = []
                for project in all_projects:
                    formatted_projects.append({
                        'key': project.get('key'),
                        'name': project.get('name'),
                        'id': project.get('id'),
                        'cloud_id': cloud_id  # Track which site this project belongs to
                    })

                # Multi-site: fetch projects from additional Jira sites
                if len(self.all_jira_cloud_ids) > 1:
                    seen_keys = {p['key'] for p in formatted_projects if p.get('key')}
                    for extra_cloud_id in self.all_jira_cloud_ids[1:]:
                        try:
                            extra_projects = self._fetch_projects_for_cloud_id(extra_cloud_id, access_token)
                            for ep in extra_projects:
                                if ep.get('key') not in seen_keys:
                                    ep['cloud_id'] = extra_cloud_id
                                    formatted_projects.append(ep)
                                    seen_keys.add(ep['key'])
                            site_name = next((r.get('name', '?') for r in self.all_jira_resources if r['id'] == extra_cloud_id), '?')
                            print(f"[MULTI-SITE] Fetched {len(extra_projects)} projects from site '{site_name}' ({extra_cloud_id})")
                        except Exception as ms_err:
                            print(f"[WARN] Multi-site project fetch failed for {extra_cloud_id}: {ms_err}")

                # Debug: log all project keys for troubleshooting
                all_project_keys = [p['key'] for p in formatted_projects if p.get('key')]
                print(f"[DEBUG] All browsable project keys: {all_project_keys}")

                # Filter to only projects where the user is an actual member
                # (not just has Browse permission). Uses JQL + role checks.
                member_projects = self._filter_member_projects(
                    formatted_projects, cloud_id, access_token
                )

                if member_projects:
                    member_keys = [p['key'] for p in member_projects if p.get('key')]
                    print(f"[DEBUG] Filtered to {len(member_projects)} member projects: {member_keys}")
                    return member_projects
                else:
                    # If membership filter returned nothing (e.g., new user with
                    # no issues), fall back to the full browsable list
                    print(f"[WARN] Membership filter returned 0 projects — using full browsable list ({len(formatted_projects)} projects)")
                    return formatted_projects
            else:
                print(f"[ERROR] Jira projects API failed: {response.status_code} - {response.text}")
        except Exception as e:
            print(f"[ERROR] Failed to fetch Jira projects: {e}")

        return []

    def should_refresh_projects_cache(self):
        """Check if projects cache needs to be refreshed"""
        if not self.projects_cache_time:
            return True

        return (time.time() - self.projects_cache_time) > self.projects_cache_ttl

    def _fetch_projects_for_cloud_id(self, cloud_id, access_token):
        """Fetch all projects for a specific Jira cloud site (used for multi-site support).

        Args:
            cloud_id: Jira cloud ID for the site
            access_token: OAuth access token

        Returns:
            list: Formatted projects [{key, name, id}, ...]
        """
        all_projects = []
        start_at = 0
        while True:
            resp = requests.get(
                f'https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/project/search',
                params={'maxResults': 50, 'startAt': start_at, 'orderBy': 'name'},
                headers={'Authorization': f'Bearer {access_token}', 'Accept': 'application/json'},
                timeout=30
            )
            if resp.status_code != 200:
                print(f"[WARN] Multi-site project fetch returned {resp.status_code} for cloud_id={cloud_id}")
                break
            data = resp.json()
            page_projects = data.get('values', [])
            if not page_projects:
                break
            for p in page_projects:
                all_projects.append({
                    'key': p.get('key'),
                    'name': p.get('name'),
                    'id': p.get('id')
                })
            start_at += len(page_projects)
            if data.get('isLast', True):
                break
        return all_projects

    def _filter_member_projects(self, all_projects, cloud_id, access_token):
        """Filter projects to only those where the user is an actual member.

        The /project/search API returns ALL projects the user can browse, which
        often includes every project in the Jira instance. This method filters
        down to projects where the user has real involvement:
        1. Projects from the user's assigned/reported issues (JQL-based)
        2. Projects where the user holds a project role (role membership API)

        Args:
            all_projects: Full list of browsable projects from /project/search
            cloud_id: Primary Jira cloud ID
            access_token: OAuth access token

        Returns:
            list: Filtered projects where user is a member, or empty list if
                  the filter can't determine membership (caller should fall back)
        """
        member_keys = set()

        # Strategy 1: Find projects from user's issues (assignee or reporter)
        # This is the most reliable signal — 1 API call covers all projects
        try:
            jql = 'assignee = currentUser() OR reporter = currentUser() ORDER BY project ASC'
            resp = requests.post(
                f'https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/search/jql',
                json={
                    'jql': jql,
                    'maxResults': 100,
                    'fields': ['project']
                },
                headers={
                    'Authorization': f'Bearer {access_token}',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                timeout=30
            )
            if resp.status_code == 200:
                data = resp.json()
                issues = data.get('issues', [])
                for issue in issues:
                    proj_key = issue.get('fields', {}).get('project', {}).get('key')
                    if proj_key:
                        member_keys.add(proj_key)
                print(f"[MEMBER-FILTER] JQL found {len(member_keys)} projects from user's issues: {sorted(member_keys)}")
            else:
                print(f"[MEMBER-FILTER] JQL membership query failed: {resp.status_code}")
        except Exception as e:
            print(f"[MEMBER-FILTER] JQL membership query error: {e}")

        # Strategy 2: Check project role membership for remaining projects
        # For projects not already identified via JQL, check if the user holds
        # any project role (e.g., Developers, Administrators, Member)
        remaining_keys = [p['key'] for p in all_projects if p.get('key') and p['key'] not in member_keys]
        if remaining_keys:
            try:
                # Get the user's accountId for role membership checks
                me_resp = requests.get(
                    f'https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/myself',
                    headers={
                        'Authorization': f'Bearer {access_token}',
                        'Accept': 'application/json'
                    },
                    timeout=10
                )
                if me_resp.status_code == 200:
                    my_account_id = me_resp.json().get('accountId')
                    if my_account_id:
                        # Check role membership for each remaining project
                        # Limit to avoid excessive API calls
                        check_limit = min(len(remaining_keys), 20)
                        for proj_key in remaining_keys[:check_limit]:
                            try:
                                role_resp = requests.get(
                                    f'https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/project/{proj_key}/role',
                                    headers={
                                        'Authorization': f'Bearer {access_token}',
                                        'Accept': 'application/json'
                                    },
                                    timeout=10
                                )
                                if role_resp.status_code == 200:
                                    roles = role_resp.json()
                                    is_member = False
                                    for role_name, role_url in roles.items():
                                        try:
                                            actors_resp = requests.get(
                                                role_url,
                                                headers={
                                                    'Authorization': f'Bearer {access_token}',
                                                    'Accept': 'application/json'
                                                },
                                                timeout=10
                                            )
                                            if actors_resp.status_code == 200:
                                                actors = actors_resp.json().get('actors', [])
                                                for actor in actors:
                                                    if actor.get('actorUser', {}).get('accountId') == my_account_id:
                                                        is_member = True
                                                        break
                                            if is_member:
                                                break
                                        except Exception:
                                            continue
                                    if is_member:
                                        member_keys.add(proj_key)
                                        print(f"[MEMBER-FILTER] Role check: user IS a member of '{proj_key}'")
                            except Exception:
                                continue
                        print(f"[MEMBER-FILTER] After role checks: {len(member_keys)} total member projects")
            except Exception as e:
                print(f"[MEMBER-FILTER] Role membership check error: {e}")

        if not member_keys:
            return []

        # Filter original project list to only member projects
        return [p for p in all_projects if p.get('key') in member_keys]

    def _get_known_project_keys(self):
        """Build set of all known project keys from issues + projects.
        
        Ensures user_projects is populated so we have ALL project keys the user
        is a member of — not just the ones from assigned issues. This is critical
        for multi-project users: the AI server needs the full set to correctly
        attribute activity records to the right project.
        """
        known = set()
        if self.user_issues:
            for issue in self.user_issues:
                proj = issue.get('project')
                if proj:
                    known.add(proj)
        # Ensure user_projects is loaded (it's only fetched on-demand as a fallback
        # in get_user_project_key, so it may still be empty even when user has
        # multiple projects). Fetch once and cache for 1 hour.
        if not self.user_projects and self.should_refresh_projects_cache():
            self.user_projects = self.fetch_jira_projects()
            self.projects_cache_time = time.time()
        if self.user_projects:
            for proj in self.user_projects:
                key = proj.get('key')
                if key:
                    known.add(key)
        return known

    def _resolve_record_project_key(self, window_title, default_project_key, ocr_text=None):
        """Determine the project key for an individual activity record.

        When a user works on multiple projects simultaneously, each record
        should carry the project key most relevant to its content.

        Strategy:
        1. Extract Jira issue keys from the window title (e.g., PROJ-123 → PROJ)
        2. Extract VS Code workspace/folder name and match against known projects
        3. Extract project keys from Jira/Confluence URLs in browser window titles
        4. Extract Jira issue keys from OCR text (screen content)
        5. Use recent project affinity as tiebreaker
        6. Fall back to None — let the AI server determine the project from context
        """
        if not window_title and not ocr_text:
            print(f"[PROJECT_KEY] No window title or OCR text — returning None")
            return None

        known_projects = self._get_known_project_keys()
        title_preview = (window_title or '')[:80]
        print(f"[PROJECT_KEY] Resolving for title: '{title_preview}' | known_projects={sorted(known_projects) if known_projects else 'none'}")

        # Strategy 1: Look for Jira issue keys in window title (PROJ-123 → PROJ)
        if window_title:
            issue_matches = re.findall(r'\b([A-Z][A-Z0-9]+)-\d+\b', window_title)
            if issue_matches:
                for match in issue_matches:
                    if match in known_projects:
                        print(f"[PROJECT_KEY] Strategy 1 HIT: issue key '{match}' found in known projects")
                        return match
                # Use first extracted key even if not in known projects cache
                print(f"[PROJECT_KEY] Strategy 1 PARTIAL: using first issue key '{issue_matches[0]}' (not in known projects)")
                return issue_matches[0]

        # Strategy 2: Extract workspace/folder name from VS Code or IDE titles
        # VS Code: "filename - workspace_name - Visual Studio Code"
        # IntelliJ: "filename – project_name"
        if known_projects and window_title:
            workspace_name = None
            vscode_match = re.search(r'\s[-–—]\s(.+?)\s[-–—]\s(?:Visual Studio Code|Code - OSS|VSCodium)', window_title)
            if vscode_match:
                workspace_name = vscode_match.group(1).strip()
            else:
                # IntelliJ/PyCharm: "file – project"
                ide_match = re.search(r'\s[-–—]\s(.+?)(?:\s[-–—]\s|$)', window_title)
                if ide_match:
                    workspace_name = ide_match.group(1).strip()

            if workspace_name:
                print(f"[PROJECT_KEY] Strategy 2: extracted workspace '{workspace_name}'")
                ws_upper = workspace_name.upper().replace('-', '').replace('_', '').replace(' ', '')
                for pk in known_projects:
                    pk_normalized = pk.upper().replace('-', '').replace('_', '').replace(' ', '')
                    if pk_normalized in ws_upper or ws_upper.startswith(pk_normalized):
                        print(f"[PROJECT_KEY] Strategy 2 HIT: workspace '{workspace_name}' matched project '{pk}'")
                        return pk
                print(f"[PROJECT_KEY] Strategy 2 MISS: workspace '{workspace_name}' didn't match any known project")

        # Strategy 3: Extract project keys from Jira/Confluence URLs in browser titles
        # Patterns: /browse/PROJ-123, /projects/PROJ/board, /jira/software/projects/PROJ
        if window_title:
            url_patterns = [
                r'/browse/([A-Z][A-Z0-9]+)-\d+',           # Jira issue URL
                r'/projects/([A-Z][A-Z0-9]+)(?:/|$|\s)',     # Jira project board URL
                r'/jira/software/projects/([A-Z][A-Z0-9]+)', # Jira next-gen project URL
                r'\[([A-Z][A-Z0-9]+)-\d+\]',                # Browser tab format: [PROJ-123] Issue title - Jira
            ]
            for pattern in url_patterns:
                url_match = re.search(pattern, window_title)
                if url_match:
                    candidate = url_match.group(1)
                    if known_projects and candidate in known_projects:
                        print(f"[PROJECT_KEY] Strategy 3 HIT: URL pattern matched project '{candidate}'")
                        return candidate
                    elif not known_projects or len(candidate) >= 2:
                        print(f"[PROJECT_KEY] Strategy 3 PARTIAL: URL pattern extracted '{candidate}'")
                        return candidate

        # Strategy 4: Extract Jira issue keys from OCR text (screen content)
        if ocr_text and len(ocr_text) > 5:
            ocr_issue_matches = re.findall(r'\b([A-Z][A-Z0-9]+)-\d+\b', ocr_text)
            if ocr_issue_matches:
                # Count occurrences to find the most frequently mentioned project
                from collections import Counter
                project_counts = Counter(ocr_issue_matches)
                if known_projects:
                    # Only use keys that match known projects — OCR text is noisy
                    # and frequently produces false positives (e.g. 'IO-123' from
                    # random screen content when user has no access to IO project)
                    known_hits = {k: v for k, v in project_counts.items() if k in known_projects}
                    if known_hits:
                        best_key = max(known_hits, key=known_hits.get)
                        print(f"[PROJECT_KEY] Strategy 4 HIT: OCR text matched known project '{best_key}' ({known_hits[best_key]} mentions)")
                        return best_key
                    else:
                        ignored = project_counts.most_common(3)
                        print(f"[PROJECT_KEY] Strategy 4 SKIP: OCR keys {ignored} not in known projects {sorted(known_projects)}")
                else:
                    # No known projects to validate against — skip OCR extraction
                    # to avoid false positives
                    print(f"[PROJECT_KEY] Strategy 4 SKIP: no known projects to validate OCR keys against")

        # Strategy 5: Recent project affinity — use the most common recent project
        # as a tiebreaker when no direct evidence is found in the current record
        affinity_project = self._get_most_recent_project()
        if affinity_project and (not known_projects or affinity_project in known_projects):
            print(f"[PROJECT_KEY] Strategy 5 HIT: recent affinity suggests '{affinity_project}'")
            return affinity_project
        elif affinity_project:
            print(f"[PROJECT_KEY] Strategy 5 SKIP: affinity '{affinity_project}' not in known projects {sorted(known_projects)}")

        # No confident match — return None so the AI server determines the project
        print(f"[PROJECT_KEY] No match — returning None (AI server will resolve)")
        return None

    def _record_project_affinity(self, project_key):
        """Record a resolved project key for recent affinity tracking.
        Only records keys that are in known_projects to prevent false positives
        from propagating via the affinity mechanism."""
        if not project_key:
            return
        # Validate against known projects before recording
        known = self._get_known_project_keys()
        if known and project_key not in known:
            print(f"[PROJECT_KEY] Affinity SKIP: '{project_key}' not in known projects")
            return
        self._recent_project_keys.append(project_key)
        # Trim to max size
        if len(self._recent_project_keys) > self._recent_project_max:
            self._recent_project_keys = self._recent_project_keys[-self._recent_project_max:]

    def _get_most_recent_project(self):
        """Return the most common project key from recent resolutions, or None."""
        if not self._recent_project_keys:
            return None
        from collections import Counter
        counts = Counter(self._recent_project_keys)
        most_common_key, most_common_count = counts.most_common(1)[0]
        # Only use affinity if there's a clear pattern (at least 2 occurrences)
        if most_common_count >= 2:
            return most_common_key
        return None

    def get_user_project_key(self):
        """Get project key from user's issues or projects

        Priority:
        1. If user has assigned issues, use the project from first issue
        2. If no issues but has accessible projects, use first project
        3. Return None if no project can be determined
        """
        # Try from issues first — refresh cache if stale or never fetched
        if self.should_refresh_issues_cache():
            self.user_issues = self.fetch_jira_issues()
            self.issues_cache_time = time.time()

        if self.user_issues and len(self.user_issues) > 0:
            project_key = self.user_issues[0].get('project')
            if project_key:
                return project_key

        # Fallback to projects
        if self.should_refresh_projects_cache():
            self.user_projects = self.fetch_jira_projects()
            self.projects_cache_time = time.time()

        if self.user_projects and len(self.user_projects) > 0:
            if len(self.user_projects) == 1:
                # Unambiguous — only one project available
                project_key = self.user_projects[0].get('key')
                if project_key:
                    print(f"[INFO] User has single project: {project_key}")
                    return project_key
            else:
                # Multiple projects and no assigned issues — cannot determine
                # which project the user is working on. Return None instead
                # of guessing (previously picked first alphabetically which
                # could return irrelevant projects like "Jiraforge").
                print(f"[INFO] User has {len(self.user_projects)} projects but no assigned issues — cannot determine project key")
                return None

        return None

    # ============================================================================
    # TRACKING SETTINGS MANAGEMENT
    # ============================================================================
    
    def get_tracking_settings_for_project(self, project_key=None):
        """Get tracking settings for a specific project
        
        This method handles the project-specific settings cache and fallback.
        Priority: project-specific → organization-wide → defaults
        
        Args:
            project_key: Jira project key (e.g., 'PROJ'). If None, returns org-wide settings.
            
        Returns:
            dict: Tracking settings for the project
        """
        # Use project key or default to current
        pk = project_key if project_key is not None else self.current_project_key

        # When pk is None, fetch_tracking_settings stores results under '_org_default'.
        # We must use the same key for both the cache check and the return lookup —
        # using pk=None directly would cause a key mismatch and discard fetched results.
        cache_key_lookup = pk if pk is not None else '_org_default'

        # Check if we have cached settings for this project
        if cache_key_lookup in self.tracking_settings_cache:
            # Check if cache is still valid
            last_fetch = self.tracking_settings_last_fetch.get(cache_key_lookup)
            if last_fetch:
                time_since_fetch = time.time() - last_fetch
                if time_since_fetch < self.tracking_settings_cache_ttl:
                    return self.tracking_settings_cache[cache_key_lookup]

        # If no cache or expired, fetch fresh settings
        self.fetch_tracking_settings(pk)

        # Return cached settings or defaults
        return self.tracking_settings_cache.get(cache_key_lookup, self.default_tracking_settings.copy())
    
    @property
    def tracking_settings(self):
        """Backward compatible property - returns settings for current project"""
        return self.get_tracking_settings_for_project(self.current_project_key)
    
    def update_current_project(self):
        """Check if project has changed and reload settings if needed"""
        # Non-Jira (Google SSO) users have no Jira project context.
        if self.auth_manager.auth_provider == 'google':
            return False
        new_project_key = self.get_user_project_key()

        # When offline, Jira is unreachable so get_user_project_key() returns None
        # (empty issues/projects list). Do not treat that as a real project change —
        # retain the current project to keep tracking attribution intact.
        if new_project_key is None and not self.offline_manager.is_online:
            return False

        if new_project_key != self.current_project_key:
            old_project = self.current_project_key
            self.current_project_key = new_project_key
            
            if old_project:
                print(f"[PROJECT] Changed from {old_project} → {new_project_key}")
            else:
                print(f"[PROJECT] Set to {new_project_key}")
            
            # Fetch settings for new project
            self.fetch_tracking_settings(new_project_key)
            
            # Re-sync app classifications with all project-level overrides
            try:
                client = self.supabase
                self.classification_manager.sync_classifications(
                    client, self.organization_id, new_project_key,
                    all_project_keys=list(self._get_known_project_keys())
                )
            except Exception as e:
                print(f"[WARN] Classification sync failed on project change: {e}")
            
            # Update capture interval and idle timeout based on new settings
            settings = self.get_tracking_settings_for_project(new_project_key)
            self.capture_interval = settings.get('screenshot_interval_seconds', self.capture_interval)
            self.idle_timeout = settings.get('idle_threshold_seconds', self.idle_timeout)
            
            return True  # Project changed
        
        return False  # No change

    def fetch_tracking_settings(self, project_key=None):
        """
        Fetch tracking settings from Supabase (configured by admins in Forge app)
        
        Args:
            project_key (str, optional): Project key to fetch settings for. If None, fetches org-wide settings.
        
        Returns:
            dict: The fetched settings
        """
        try:
            # Check if we need to refresh settings for this project
            cache_key = project_key if project_key else '_org_default'
            if cache_key in self.tracking_settings_last_fetch:
                time_since_fetch = time.time() - self.tracking_settings_last_fetch[cache_key]
                if time_since_fetch < self.tracking_settings_cache_ttl:
                    return self.tracking_settings_cache.get(cache_key, self.default_tracking_settings)
            
            client = self.supabase
            settings = None
            settings_source = 'default'
            
            # 3-tier fallback: project-specific → org-wide → global defaults
            
            # Tier 1: Try project-specific settings (if project_key provided)
            if project_key and self.organization_id:
                query = client.table('tracking_settings').select('*')
                query = query.eq('organization_id', self.organization_id)
                query = query.eq('project_key', project_key)
                result = query.limit(1).execute()
                
                if result.data and len(result.data) > 0:
                    settings = result.data[0]
                    settings_source = 'project'
            
            # Tier 2: Try organization-wide settings (project_key IS NULL)
            if not settings and self.organization_id:
                query = client.table('tracking_settings').select('*')
                query = query.eq('organization_id', self.organization_id)
                query = query.is_('project_key', 'null')
                result = query.limit(1).execute()
                
                if result.data and len(result.data) > 0:
                    settings = result.data[0]
                    settings_source = 'organization'
            
            # Tier 3: Try global defaults (organization_id IS NULL, project_key IS NULL)
            if not settings:
                query = client.table('tracking_settings').select('*')
                query = query.is_('organization_id', 'null')
                query = query.is_('project_key', 'null')
                result = query.limit(1).execute()
                
                if result.data and len(result.data) > 0:
                    settings = result.data[0]
                    settings_source = 'global'

            if settings:
                # Map database columns to local settings format.
                # IMPORTANT: Supabase returns NULL columns as None in Python.
                # dict.get(key, default) only uses the default when the key is
                # MISSING — if the key exists with value None, it returns None.
                # We must explicitly coalesce None → default for every field,
                # otherwise a NULL boolean like screenshot_monitoring_enabled
                # would be treated as falsy and silently disable tracking.
                _nvl = lambda val, default: default if val is None else val
                fetched_settings = {
                    'screenshot_monitoring_enabled': _nvl(settings.get('screenshot_monitoring_enabled'), True),
                    'screenshot_interval_seconds': _nvl(settings.get('screenshot_interval_seconds'), 900),
                    'tracking_mode': _nvl(settings.get('tracking_mode'), 'interval'),
                    'event_tracking_enabled': _nvl(settings.get('event_tracking_enabled'), False),
                    'track_window_changes': _nvl(settings.get('track_window_changes'), True),
                    'track_idle_time': _nvl(settings.get('track_idle_time'), True),
                    'idle_threshold_seconds': _nvl(settings.get('idle_threshold_seconds'), 300),
                    'work_hours_start': _nvl(settings.get('work_hours_start'), '09:00:00'),
                    'work_hours_end': _nvl(settings.get('work_hours_end'), '18:00:00'),
                    'work_days': _nvl(settings.get('work_days'), [1, 2, 3, 4, 5]),
                }

                # Product decision: enforce event-based monitoring only.
                fetched_settings['tracking_mode'] = 'event'
                fetched_settings['event_tracking_enabled'] = True

                if SCREENSHOT_MONITORING_HARD_DISABLED:
                    fetched_settings['screenshot_monitoring_enabled'] = False

                # Cache the settings
                self.tracking_settings_cache[cache_key] = fetched_settings
                self.tracking_settings_last_fetch[cache_key] = time.time()
                
                # Update capture interval from settings (for backward compatibility)
                self.capture_interval = fetched_settings['screenshot_interval_seconds']
                self.idle_timeout = fetched_settings['idle_threshold_seconds']
                
                mode_str = "event-only"
                
                project_info = f" for project '{project_key}'" if project_key else ""
                total_classifications = len(self.classification_manager.process_classifications) + len(self.classification_manager.url_classifications) + len(self.classification_manager.url_wildcard_patterns)
                print(f"[OK] Tracking settings loaded{project_info} (source: {settings_source}) - mode: {mode_str}, interval: {self.capture_interval}s")
                print(f"     - App classifications loaded: {total_classifications}")
                self.add_admin_log('INFO', f'Settings loaded{project_info} (source: {settings_source}): interval={self.capture_interval}s, mode={mode_str}')
                
                return fetched_settings
            
            else:
                # No settings found, use defaults
                print(f"[INFO] No tracking settings found in Supabase, using defaults")

                self.tracking_settings_cache[cache_key] = self.default_tracking_settings.copy()
                self.tracking_settings_last_fetch[cache_key] = time.time()
                return self.default_tracking_settings

        except Exception as e:
            print(f"[WARN] Failed to fetch tracking settings: {e}")
            # Cache the defaults with a 60-second retry window so we stop hitting
            # the network on every loop iteration while offline. The TTL math sets
            # last_fetch to (TTL - 60) seconds ago, meaning the cache expires and
            # retries after 60 seconds instead of immediately on the next call.
            self.tracking_settings_cache[cache_key] = self.default_tracking_settings.copy()
            self.tracking_settings_last_fetch[cache_key] = time.time() - (self.tracking_settings_cache_ttl - 60)
            return self.default_tracking_settings

    # ============================================================================
    # PAUSE SETTINGS MANAGEMENT (Local Storage)
    # ============================================================================

    def get_pause_settings_file_path(self):
        """Get the path to the pause settings file"""
        # Store in user's app data directory
        if sys.platform == 'win32':
            app_data = os.environ.get('APPDATA', os.path.expanduser('~'))
            settings_dir = os.path.join(app_data, 'TimeTracker')
        else:
            settings_dir = os.path.join(os.path.expanduser('~'), '.timetracker')

        # Create directory if it doesn't exist
        os.makedirs(settings_dir, exist_ok=True)
        return os.path.join(settings_dir, 'pause_settings.json')

    def load_pause_settings(self):
        """Load pause settings from local file"""
        try:
            settings_file = self.get_pause_settings_file_path()
            if os.path.exists(settings_file):
                with open(settings_file, 'r') as f:
                    saved_settings = json.load(f)

                # Merge with defaults (in case new settings were added)
                for key, value in saved_settings.items():
                    if key in self.pause_settings:
                        self.pause_settings[key] = value

                print(f"[OK] Pause settings loaded from {settings_file}")
            else:
                print("[INFO] No pause settings file found, using defaults")
        except Exception as e:
            print(f"[WARN] Failed to load pause settings: {e}")

    def save_pause_settings(self):
        """Save pause settings to local file"""
        try:
            settings_file = self.get_pause_settings_file_path()
            with open(settings_file, 'w') as f:
                json.dump(self.pause_settings, f, indent=2)

            # Update runtime values
            self.pause_reminder_interval = self.pause_settings['pause_reminder_interval'] * 60
            self.pause_reminder_enabled = self.pause_settings['pause_reminder_enabled']

            print(f"[OK] Pause settings saved to {settings_file}")
            return True
        except Exception as e:
            print(f"[ERROR] Failed to save pause settings: {e}")
            return False

    # ============================================================================
    # UNASSIGNED WORK NOTIFICATION FUNCTIONS
    # ============================================================================
    
    def fetch_notification_settings(self):
        """Fetch notification settings for unassigned work reminders from Supabase"""
        try:
            # Check if we need to refresh settings
            if self.notification_settings_last_fetch is not None:
                time_since_fetch = time.time() - self.notification_settings_last_fetch
                if time_since_fetch < self.notification_settings_cache_ttl:
                    return  # Use cached settings
            
            if not self.current_user_id:
                return  # No user logged in
            
            client = self.supabase
            
            # Fetch user's settings from users table
            result = client.table('users').select('settings').eq('id', self.current_user_id).limit(1).execute()
            
            if result.data and len(result.data) > 0 and result.data[0].get('settings'):
                settings = result.data[0]['settings']
                self.notification_settings = {
                    'enabled': settings.get('unassigned_work_notifications_enabled', True),
                    'interval_hours': settings.get('notification_interval_hours', 24),
                    'min_unassigned_minutes': settings.get('min_unassigned_minutes', 30)
                }
                print(f"[OK] Notification settings loaded - enabled: {self.notification_settings['enabled']}, interval: {self.notification_settings['interval_hours']}h")
            
            self.notification_settings_last_fetch = time.time()
            
        except Exception as e:
            print(f"[WARN] Failed to fetch notification settings: {e}")
            # Continue with default settings
    
    def get_unassigned_work_summary(self):
        """Get summary of unassigned work from Supabase"""
        try:
            if not self.current_user_id or not self.organization_id:
                return None
            
            client = self.supabase
            
            # Query unassigned work groups that are not yet assigned
            result = client.table('unassigned_work_groups').select('id,total_seconds').eq(
                'user_id', self.current_user_id
            ).eq(
                'organization_id', self.organization_id
            ).eq(
                'is_assigned', False
            ).execute()
            
            if result.data:
                total_groups = len(result.data)
                total_seconds = sum(g.get('total_seconds', 0) for g in result.data)
                return {
                    'pending_groups': total_groups,
                    'total_seconds': total_seconds,
                    'total_minutes': total_seconds // 60,
                    'total_hours': round(total_seconds / 3600, 1)
                }
            
            return {'pending_groups': 0, 'total_seconds': 0, 'total_minutes': 0, 'total_hours': 0}
            
        except Exception as e:
            print(f"[WARN] Failed to get unassigned work summary: {e}")
            return None
    
    def show_unassigned_work_notification(self, summary):
        """Show desktop notification for unassigned work"""
        if not summary or summary['pending_groups'] == 0:
            return

        try:
            if summary['total_hours'] >= 1:
                time_str = f"{summary['total_hours']}h"
            else:
                time_str = f"{summary['total_minutes']}m"

            msg = (f"You have {summary['pending_groups']} work session(s) ({time_str}) "
                   f"that need to be assigned to Jira issues.")

            if not WINOTIFY_AVAILABLE:
                _linux_notify("📋 Unassigned Work Reminder", msg)
                print(f"[INFO] Notifications not available (winotify not installed)")
                return

            notification = Notification(
                app_id="Time Tracker",
                title="📋 Unassigned Work Reminder",
                msg=f"You have {summary['pending_groups']} work session(s) ({time_str}) that need to be assigned to Jira issues.",
                duration="long"
            )

            # Set notification sound
            notification.set_audio(audio.Default, loop=False)

            # Show the notification
            notification.show()

            print(f"[OK] Unassigned work notification shown - {summary['pending_groups']} groups, {time_str} total")

        except Exception as e:
            print(f"[WARN] Failed to show notification: {e}")

    def _show_reauth_notification(self, reason_code=None):
        """Show auth notification with reason-specific messaging (throttled every 15 minutes per reason)."""
        now = time.time()
        reason = str(reason_code or '').upper()
        is_temporary = reason == 'OAUTH_TEMPORARY_FAILURE'

        # For genuine session expiration (non-temporary), suppress the notification if the
        # failure is actually transient — showing "session expired" when the user is simply
        # offline or in a brief refresh-token grace period causes unnecessary alarm.
        if not is_temporary:
            # Suppress if device is offline — data is queuing locally, no user action required
            if not self.offline_manager.check_connectivity():
                print("[INFO] Auth notification suppressed — device is offline (data queuing locally)")
                return
            # Suppress while still within the 30-min refresh token grace period
            invalid_since = getattr(self.auth_manager, '_refresh_invalid_set_at', 0)
            if invalid_since and (now - invalid_since) < 1800:
                print("[INFO] Auth notification suppressed — still in 30-min refresh token grace period")
                return

        throttle_attr = '_auth_temp_notification_last_shown' if is_temporary else '_reauth_notification_last_shown'
        last_shown = getattr(self, throttle_attr, 0)
        if now - last_shown < 900:  # 15 minutes
            log_auth_diagnostic(
                'auth_notification_suppressed',
                level='INFO',
                reason=reason or 'LEGACY',
                notification_type='temporary_retry' if is_temporary else 'manual_reauth',
                throttle_seconds=900
            )
            return
        setattr(self, throttle_attr, now)

        if not WINOTIFY_AVAILABLE:
            if is_temporary:
                _linux_notify("Time Tracker", "Temporary authentication issue – sync will retry automatically.")
                print("[WARN] Temporary authentication issue (notification unavailable)")
            else:
                _linux_notify("Time Tracker", "Your session has expired. Please open Time Tracker and log in again.", urgency="critical")
                print("[WARN] Re-authentication required (notification unavailable)")
                # On Linux, notify-send is fire-and-forget with no click callbacks.
                # Proactively open the browser so the user can re-authenticate
                # immediately without hunting for the tray icon.
                try:
                    webbrowser.open(f'http://localhost:{self.web_port}/login')
                    print("[INFO] Opened browser to login page for re-authentication")
                except Exception as _e:
                    print(f"[WARN] Could not auto-open browser after reauth notification: {_e}")
            log_auth_diagnostic(
                'auth_notification_unavailable',
                level='WARNING',
                reason=reason or 'LEGACY',
                notification_type='temporary_retry' if is_temporary else 'manual_reauth'
            )
            return

        try:
            if is_temporary:
                title = "Authentication Issue"
                msg = "We could not refresh your session right now. Sync will retry automatically."
            else:
                title = "Authentication Expired"
                msg = "Your session has expired. Please open Time Tracker and log in again to continue syncing with Jira."

            notification = Notification(
                app_id="Time Tracker",
                title=title,
                msg=msg,
                duration="long"
            )
            notification.set_audio(audio.Default, loop=False)
            notification.show()
            log_auth_diagnostic(
                'auth_notification_displayed',
                level='INFO',
                reason=reason or 'LEGACY',
                notification_type='temporary_retry' if is_temporary else 'manual_reauth',
                title=title
            )
            print(f"[OK] Authentication notification shown to user (reason={reason or 'LEGACY'})")
        except Exception as e:
            log_auth_diagnostic(
                'auth_notification_failed',
                level='ERROR',
                reason=reason or 'LEGACY',
                notification_type='temporary_retry' if is_temporary else 'manual_reauth',
                message=str(e)
            )
            print(f"[WARN] Failed to show reauth notification: {e}")

    def _show_login_reminder(self):
        """Show a periodic notification reminding the user to log in (every 15 minutes)"""
        now = time.time()
        last_shown = getattr(self, '_login_reminder_last_shown', 0)
        if now - last_shown < 900:  # 15 minutes
            return
        self._login_reminder_last_shown = now

        if not WINOTIFY_AVAILABLE:
            _linux_notify("Time Tracker – Not Logged In",
                          "You are not logged in. Please open Time Tracker and log in.")
            print("[WARN] Login reminder skipped - winotify not available")
            return

        try:
            notification = Notification(
                app_id="Time Tracker",
                title="Time Tracker - Not Logged In",
                msg="You are not logged in. Please log in to start tracking your work time.",
                duration="long"
            )
            notification.set_audio(audio.Default, loop=False)
            notification.show()
            print("[OK] Login reminder notification shown to user")
        except Exception as e:
            print(f"[WARN] Failed to show login reminder: {e}")

    def show_pause_reminder_notification(self):
        """Show notification reminding user they have paused tracking"""
        if not WINOTIFY_AVAILABLE:
            _linux_notify("Tracking Paused", "You've had tracking paused for a while. Resume from the system tray.")
            print("[INFO] Pause reminder skipped - winotify not available")
            return

        if not self.pause_start_time:
            return

        try:
            pause_duration = time.time() - self.pause_start_time
            minutes = int(pause_duration // 60)

            if minutes < 60:
                time_str = f"{minutes} minute{'s' if minutes != 1 else ''}"
            else:
                hours = minutes // 60
                mins = minutes % 60
                time_str = f"{hours}h {mins}m"

            notification = Notification(
                app_id="Time Tracker",
                title="Tracking Paused",
                msg=f"You've been paused for {time_str}. If you're doing productive work, resume from the system tray.",
                duration="long"
            )

            notification.set_audio(audio.Default, loop=False)
            notification.show()

            self.last_pause_reminder_time = time.time()
            print(f"[OK] Pause reminder notification shown - paused for {time_str}")

        except Exception as e:
            print(f"[WARN] Failed to show pause reminder notification: {e}")

    def _get_jira_app_url(self, tab=None):
        """Build the URL to open the Jira Forge app (Time Tracker)

        Args:
            tab: Optional tab parameter (currently not used as Jira handles its own navigation)
        """
        # Ensure we have issues cached (fetch if empty)
        if not self.user_issues or len(self.user_issues) == 0:
            print("[INFO] Fetching Jira issues for notification URL...")
            self.user_issues = self.fetch_jira_issues()
            self.issues_cache_time = time.time()

        # Get a project key from user's cached issues
        project_key = None
        if self.user_issues and len(self.user_issues) > 0:
            # Use the project key from the first issue
            project_key = self.user_issues[0].get('project')

        # If we have Jira instance URL and a project key, build the Forge app URL
        if self.jira_instance_url and project_key:
            # URL format: {jira_url}/jira/software/projects/{PROJECT}/boards
            # This opens the project's board page where the Time Tracker tab is accessible
            return f"{self.jira_instance_url}/jira/software/projects/{project_key}/boards"
        elif self.jira_instance_url:
            # Fallback: just open the Jira homepage if no project key available
            return self.jira_instance_url
        else:
            # Final fallback: open local success page
            return f"http://localhost:{self.web_port}/success"
    
    def check_and_notify_unassigned_work(self):
        """Check for unassigned work and show notification if needed"""
        try:
            # Refresh notification settings
            self.fetch_notification_settings()
            
            # Check if notifications are enabled
            if not self.notification_settings.get('enabled', True):
                return
            
            # Check if enough time has passed since last notification
            interval_seconds = self.notification_settings.get('interval_hours', 24) * 3600
            if time.time() - self.last_notification_time < interval_seconds:
                return
            
            # Get unassigned work summary
            summary = self.get_unassigned_work_summary()
            if not summary:
                return
            
            # Check if there's enough unassigned time to warrant a notification
            min_minutes = self.notification_settings.get('min_unassigned_minutes', 30)
            if summary['total_minutes'] < min_minutes:
                return
            
            # Show the notification
            self.show_unassigned_work_notification(summary)
            self.last_notification_time = time.time()
            
        except Exception as e:
            print(f"[WARN] Error checking unassigned work: {e}")
    
    def is_app_productive(self, app_name, window_title=''):
        """Check if application is productive (database-driven classification)."""
        classification, _ = self.classification_manager.classify(app_name, window_title)
        return classification == 'productive'

    def is_app_non_productive(self, app_name, window_title=''):
        """Check if application is non-productive (database-driven classification)."""
        classification, _ = self.classification_manager.classify(app_name, window_title)
        return classification == 'non_productive'

    def is_private_app(self, app_name, window_title=''):
        """Check if application/window is private (should not be tracked/recorded)"""
        classification, _ = self.classification_manager.classify(app_name, window_title)
        return classification == 'private'
    
    def get_app_work_type(self, app_name, window_title=''):
        """Determine work type based on database-driven classification
        
        Returns:
            str: 'office' for productive apps, 'non-office' for non-productive apps,
                 'office' as default for unknown/private apps
        """
        # Use database-driven classification
        classification, match_type = self.classification_manager.classify(app_name, window_title)
        
        if classification == 'non_productive':
            return 'non-office'
        elif classification == 'productive':
            return 'office'
        elif classification == 'private':
            return 'office'  # Private apps treated as work by default to avoid tracking issues
        else:
            # Unknown apps default to 'office' (will be classified by admin later)
            return 'office'
    
    def should_skip_screenshot(self, app_name, window_title=''):
        """Check if screenshot should be skipped based on settings

        Returns:
            tuple: (should_skip: bool, reason: str or None)
        """
        # Client-level kill switch: never capture/store screenshots.
        if SCREENSHOT_MONITORING_HARD_DISABLED:
            return (True, 'screenshot_monitoring_disabled')

        # Check if screenshot monitoring is disabled
        if not self.tracking_settings.get('screenshot_monitoring_enabled', True):
            return (True, 'screenshot_monitoring_disabled')

        # Use database-driven classification to skip private/non-productive apps
        classification, _ = self.classification_manager.classify(app_name, window_title)
        if classification == 'private':
            return (True, 'private_app')
        if classification == 'non_productive':
            return (True, 'non_productive_app')

        return (False, None)

    def upload_activity_batch(self):
        """Upload accumulated activity records to Supabase as a single batch.
        Called every 5 minutes (batch_upload_interval).
        Uses custom JWT for RLS-scoped access (Atlassian OAuth → AI server JWT).
        """
        sessions = None
        records = None
        batch_timestamp = None
        try:
            print(
                f"[BATCH] Triggered at {datetime.now(timezone.utc).isoformat()} "
                f"(last upload {int(time.time() - self.last_batch_upload_time)}s ago)"
            )

            # Wait briefly for any in-flight async OCR to finish before uploading
            if self.ocr_processor and not self.ocr_processor.wait_for_ocr(timeout=5.0):
                print("[BATCH] Async OCR still running after 5s timeout — uploading without it")

            # Backfill OCR for any sessions that were throttled during rapid window switches.
            # Uses the ORIGINAL screenshot captured at throttle time, not a new one,
            # so the OCR text matches the window the user was actually viewing.
            # Capped at 3 per batch to prevent CPU lag when many windows were rapidly switched
            # (e.g. switching between chat conversations every 2 seconds generates 10+ backfill jobs,
            # each taking several seconds of OCR — that blocks the main thread).
            MAX_BACKFILL_PER_BATCH = 3
            pending_entries = self.session_manager.get_pending_ocr_entries()
            backfill_count = 0
            for (pk_title, pk_app), saved_screenshot in pending_entries.items():
                if backfill_count >= MAX_BACKFILL_PER_BATCH:
                    print(f"[BATCH] Backfill OCR cap reached ({MAX_BACKFILL_PER_BATCH}) — skipping remaining {len(pending_entries) - backfill_count} entries")
                    break
                if saved_screenshot is not None:
                    ocr_result = self.ocr_processor.ocr_from_image(saved_screenshot)
                    del saved_screenshot
                else:
                    # Fallback: no saved screenshot (shouldn't happen, but be safe)
                    print(f"[WARN] No saved screenshot for backfill: {pk_app} - {pk_title[:50]}")
                    ocr_result = self.ocr_processor.capture_and_ocr()
                if ocr_result and not ocr_result.get('throttled'):
                    self.session_manager.backfill_ocr(pk_title, pk_app, ocr_result)
                backfill_count += 1

            # Atomically harvest all sessions and clear SQLite in one locked operation.
            # This prevents the race condition where new sessions could be inserted
            # between separate get_all_sessions() and clear_all() calls.
            MIN_SESSION_DURATION_SECONDS = 5
            sessions = self.session_manager.harvest_and_clear(min_duration_seconds=MIN_SESSION_DURATION_SECONDS)
            if not sessions and not self._pending_idle_records:
                print("[BATCH] No activity records to upload")
                self.current_window_key = None  # Force re-detection so tracking resumes on next loop
                self.last_batch_upload_time = time.time()
                self.add_admin_log('DEBUG', 'Batch upload: no activity records to upload')
                return

            if not sessions:
                if self._pending_idle_records:
                    print("[BATCH] All work sessions were noise — but idle records exist, continuing")
                else:
                    print("[BATCH] All sessions were noise — nothing to upload")
                    self.current_window_key = None  # Force re-detection so tracking resumes on next loop
                    self.last_batch_upload_time = time.time()
                    return

            # Supabase client with custom JWT required for RLS-scoped batch insert
            if not self.supabase:
                print("[BATCH] No Supabase client — restoring sessions to SQLite")
                self.session_manager.restore_sessions(sessions)
                self.last_batch_upload_time = time.time()
                self.add_admin_log('ERROR', f'Batch upload failed: no Supabase client ({len(sessions)} records pending)')
                return

            if not self.current_user_id:
                print("[BATCH] No current user ID — restoring sessions to SQLite")
                self.session_manager.restore_sessions(sessions)
                self.last_batch_upload_time = time.time()
                self.add_admin_log('ERROR', f'Batch upload failed: no user ID ({len(sessions)} records pending)')
                return

            # Check connectivity
            if not self.offline_manager.check_connectivity():
                print(f"[BATCH] Offline — restoring {len(sessions)} sessions to SQLite for retry")
                self.session_manager.restore_sessions(sessions)
                self.last_batch_upload_time = time.time()
                self.add_admin_log('WARN', f'Batch upload deferred: offline ({len(sessions)} records pending)')
                return

            # Ensure Supabase JWT is valid before uploading
            # (JWT expires after ~1 hour; without this check, all uploads silently fail)
            sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
            if sb_expires_at and time.time() > (sb_expires_at - 300):
                print("[BATCH] Supabase JWT expired — refreshing before upload...")
                if not self._set_supabase_jwt():
                    print("[BATCH] JWT refresh failed — restoring sessions to SQLite for retry")
                    self.session_manager.restore_sessions(sessions)
                    self.last_batch_upload_time = time.time()
                    self.add_admin_log('ERROR', f'Batch upload failed: JWT refresh failed ({len(sessions)} records pending). Re-login may be required.')
                    return
            elif not sb_expires_at:
                # No expiry info stored — proactively refresh to be safe
                print("[BATCH] No JWT expiry info — refreshing proactively...")
                self._set_supabase_jwt()

            batch_timestamp = datetime.now(timezone.utc).isoformat()
            batch_end = datetime.now(timezone.utc)
            batch_start = self.batch_start_time

            # Build activity_records payload
            records = []
            # Per-record project key resolution extracts the project from window
            # title context (Jira keys, VS Code workspace name, etc.).
            # When detection fails, project_key is set to None — the AI server
            # will determine the correct project from OCR text, window titles,
            # and the full set of user_assigned_issues across ALL projects.
            # This prevents misattribution when users work on multiple projects.
            known_projects = self._get_known_project_keys()
            print(f"[BATCH] Known project keys: {sorted(known_projects) if known_projects else 'none'}")
            print(f"[BATCH] User assigned issues: {len(self.user_issues) if self.user_issues else 0} across {len(set(i.get('project') for i in (self.user_issues or []) if i.get('project')))} projects")

            for s in sessions:
                classification = s.get('classification', 'unknown')

                # Defense-in-depth: if a lock screen app somehow made it into
                # SQLite sessions, mark it as idle so it won't inflate totals.
                app_name_lower = (s.get('application_name') or '').lower()
                is_lock_screen = app_name_lower in LOCK_SCREEN_APPS
                if is_lock_screen:
                    classification = 'idle'

                # Determine status based on classification
                if classification in ('non_productive', 'private', 'idle'):
                    status = 'analyzed'  # No AI needed
                else:
                    status = 'pending'  # AI server will analyze

                # If no OCR was performed (throttled and not backfilled), use metadata fallback
                # so AI can still analyze based on window title
                ocr_text = s.get('ocr_text')
                ocr_method = s.get('ocr_method')
                ocr_confidence = s.get('ocr_confidence')
                ocr_error_message = s.get('ocr_error_message')
                
                if ocr_text is None and ocr_method is None:
                    # No OCR was attempted - use window title as metadata fallback
                    window_title = s.get('window_title', '')
                    app_name = s.get('application_name', '')
                    if window_title or app_name:
                        ocr_text = f"[Window: {window_title}] [App: {app_name}]"
                        ocr_method = 'metadata_title'
                        ocr_confidence = 0.0
                        ocr_error_message = 'OCR skipped (throttled, not backfilled)'

                # project_key is now derived server-side from the matched issue key
                # (e.g., PROJ-123 → PROJ). For non_productive/private records that
                # skip AI analysis, project_key stays None (shown as "unassigned").
                # For productive/unknown records, the AI server sets project_key
                # after matching the activity to a Jira issue.
                record_project_key = None

                record = {
                    'user_id': self.current_user_id,
                    'organization_id': self.organization_id,
                    'window_title': s.get('window_title', ''),
                    'application_name': s.get('application_name', ''),
                    'classification': classification,
                    'is_idle': is_lock_screen,
                    'ocr_text': ocr_text,
                    'ocr_method': ocr_method,
                    'ocr_confidence': ocr_confidence,
                    'ocr_error_message': ocr_error_message,
                    'total_time_seconds': int(s.get('total_time_seconds', 0)),
                    'visit_count': s.get('visit_count', 1),
                    'start_time': s.get('first_seen'),
                    'end_time': s.get('last_seen'),
                    'duration_seconds': int(s.get('total_time_seconds', 0)),
                    'batch_timestamp': batch_timestamp,
                    'batch_start': batch_start.isoformat(),
                    'batch_end': batch_end.isoformat(),
                    'work_date': _utc_ts_to_local_date(s.get('first_seen')),
                    'user_timezone': get_local_timezone_name(),
                    'project_key': record_project_key,
                    'user_assigned_issues': json.dumps(self.user_issues) if self.user_issues else None,
                    'status': status,
                    'request_id': str(uuid.uuid4()),  # Unique request ID for idempotency
                    'metadata': {
                        'tracking_mode': 'event_based',
                        'app_version': self.app_version,
                        'user_projects': list(self._get_known_project_keys()) or None
                    }
                }
                records.append(record)

            # Append any pending idle records (don't clear yet — clear only after confirmed upload)
            idle_records = list(self._pending_idle_records)
            for idle_rec in idle_records:
                # Add batch metadata
                idle_rec['batch_timestamp'] = batch_timestamp
                idle_rec['batch_start'] = batch_start.isoformat()
                idle_rec['batch_end'] = batch_end.isoformat()
                records.append(idle_rec)
            if idle_records:
                print(f"[BATCH] Including {len(idle_records)} idle records in batch")

            # Batch insert to Supabase using anon client with custom JWT (RLS-scoped)
            print(f"[BATCH] Inserting {len(records)} activity records...")
            print(f"[BATCH] user_id={self.current_user_id}, org_id={self.organization_id}")
            secure_log("[BATCH] Target table: activity_records", user_id=self.current_user_id)

            # Validate JWT is set before attempting insert
            try:
                token = self.auth_manager.tokens.get('supabase_token')
                if token:
                    import base64
                    # Decode JWT payload (2nd segment) to verify sub claim matches current_user_id
                    parts = token.split('.')
                    if len(parts) == 3:
                        padded = parts[1] + '=' * (4 - len(parts[1]) % 4)
                        payload = json.loads(base64.urlsafe_b64decode(padded))
                        jwt_sub = payload.get('sub')
                        jwt_role = payload.get('role')
                        jwt_exp = payload.get('exp', 0)
                        is_expired = time.time() > jwt_exp
                        print(f"[BATCH] JWT check: sub={jwt_sub}, role={jwt_role}, expired={is_expired}, exp={jwt_exp}")
                        if str(jwt_sub) != str(self.current_user_id):
                            print(f"[BATCH] WARNING: JWT sub '{jwt_sub}' != current_user_id '{self.current_user_id}' — RLS will reject insert!")
                        if is_expired:
                            print(f"[BATCH] WARNING: JWT is expired! Refreshing before insert...")
                            self._set_supabase_jwt()
                else:
                    print(f"[BATCH] WARNING: No supabase_token found in auth_manager.tokens — insert will likely fail!")
                    self._set_supabase_jwt()
            except Exception as jwt_check_err:
                print(f"[BATCH] JWT pre-check error (non-fatal): {jwt_check_err}")

            # Debug: log first record's key fields for troubleshooting
            if records:
                r0 = records[0]
                print(f"[BATCH] Sample record: user_id={r0.get('user_id')}, org_id={r0.get('organization_id')}, "
                      f"status={r0.get('status')}, start_time={r0.get('start_time')}, "
                      f"window_title='{(r0.get('window_title') or '')[:50]}'")

            # Log the exact Supabase URL for cross-referencing with Dashboard
            print(f"[BATCH] Supabase URL: {self.supabase_url}")

            result = self.supabase.table('activity_records').insert(records).execute()
            print(f"[BATCH] Insert result: data_count={len(result.data) if result.data else 0}, count={getattr(result, 'count', 'N/A')}")

            if result.data:
                productive_count = sum(1 for r in records if r['status'] == 'pending')
                analyzed_count = sum(1 for r in records if r['status'] == 'analyzed')
                inserted_ids = [r.get('id', '?') for r in result.data]
                print(f"[BATCH] Correlation ID | batch_timestamp={batch_timestamp}")
                print(f"[BATCH] Uploaded {len(records)} activity records ({productive_count} pending AI, {analyzed_count} pre-analyzed)")
                print(f"[BATCH] Inserted record IDs | ids={inserted_ids}")
                secure_log("[BATCH] Inserted record IDs", ids=inserted_ids)

                # ============================================================
                # DIAGNOSTIC: Raw HTTP verification (bypasses supabase-py)
                # This catches client-library bugs and confirms records
                # actually persist in the database.
                # ============================================================
                upload_verified = False
                try:
                    first_id = inserted_ids[0] if inserted_ids else None
                    if first_id and first_id != '?':
                        import requests as req_lib
                        raw_url = f"{self.supabase_url}/rest/v1/activity_records?id=eq.{first_id}&select=id"
                        supabase_anon_key = get_env_var('SUPABASE_ANON_KEY')
                        supabase_token = self.auth_manager.tokens.get('supabase_token')
                        raw_headers = {
                            'apikey': supabase_anon_key,
                            'Authorization': f'Bearer {supabase_token}',
                        }
                        raw_resp = req_lib.get(raw_url, headers=raw_headers, timeout=15)
                        raw_data = raw_resp.json() if raw_resp.status_code == 200 else None
                        raw_count = len(raw_data) if raw_data else 0
                        print(f"[BATCH] RAW HTTP verify: GET {raw_url}")
                        print(f"[BATCH] RAW HTTP result: status={raw_resp.status_code}, rows={raw_count}, body={raw_resp.text[:200]}")

                        if raw_count == 0 and raw_resp.status_code == 200:
                            print(f"[CRITICAL] Insert appeared to succeed but record {first_id} NOT FOUND via raw HTTP!")
                            print(f"[CRITICAL] This means the INSERT transaction was ROLLED BACK by a database trigger.")
                            print(f"[CRITICAL] Likely cause: notify_activity_webhook() AFTER INSERT trigger is failing.")
                            print(f"[CRITICAL] FIX: Disable the trigger in Supabase SQL Editor:")
                            print(f"[CRITICAL]   ALTER TABLE activity_records DISABLE TRIGGER on_activity_record_insert;")
                        elif raw_count > 0:
                            print(f"[BATCH] RAW HTTP verification PASSED — record {first_id} confirmed via independent HTTP call")
                            upload_verified = True
                    else:
                        # Fallback: supabase-py verification
                        verify = self.supabase.table('activity_records') \
                            .select('id') \
                            .eq('user_id', self.current_user_id) \
                            .eq('batch_timestamp', batch_timestamp) \
                            .execute()
                        verified_count = len(verify.data) if verify.data else 0
                        print(f"[BATCH] Verification: {verified_count}/{len(records)} records confirmed in database")
                        upload_verified = verified_count > 0

                except Exception as ve:
                    print(f"[ERROR] Verification failed: {ve}")
                    traceback.print_exc()

                if not upload_verified:
                    print(f"[ERROR] Records not persisted — restoring {len(sessions)} sessions to SQLite for retry")
                    self.session_manager.restore_sessions(sessions)
                    self.add_admin_log('ERROR', f'Batch upload failed: records not persisted. Queued for retry.')

                if upload_verified:
                    # Upload confirmed — safe to clear idle records and reset batch timer
                    self._pending_idle_records.clear()
                    self.current_window_key = None  # Force re-detection so tracking resumes on next loop
                    self.batch_start_time = datetime.now(timezone.utc)
                    print(f"[BATCH] Upload verified and committed successfully")
                    self.add_admin_log('INFO', f'Batch uploaded: {len(records)} records verified in database')
            else:
                # Log detailed response for debugging
                print(f"[WARN] Batch upload returned no data — restoring sessions to SQLite for retry")
                if hasattr(result, 'count'):
                    print(f"       result.count={result.count}")
                print(f"       result={result}")
                self.session_manager.restore_sessions(sessions)
                self.add_admin_log('ERROR', f'Batch upload returned no data ({len(records)} records). Queued for retry.')

            self.last_batch_upload_time = time.time()

        except Exception as e:
            error_str = str(e).lower()
            print(f"[BATCH] Exception during upload: {type(e).__name__}: {e}")
            # Log Supabase API error details if available
            if hasattr(e, 'message'):
                print(f"[BATCH] API error message: {e.message}")
            if hasattr(e, 'code'):
                print(f"[BATCH] API error code: {e.code}")
            if hasattr(e, 'details'):
                print(f"[BATCH] API error details: {e.details}")
            if hasattr(e, 'hint'):
                print(f"[BATCH] API error hint: {e.hint}")

            is_fk_violation = 'foreign key' in error_str or '23503' in error_str or 'fkey' in error_str
            is_auth_error = any(kw in error_str for kw in ('jwt expired', '401', 'unauthorized', 'invalid token', 'token is expired', 'not authenticated', 'apikey'))

            if is_fk_violation:
                print(f"[CRITICAL] Foreign key violation — user_id '{self.current_user_id}' or org_id '{self.organization_id}' does NOT exist in the database!")
                print(f"[CRITICAL] Records were NOT persisted. The user/org may have been deleted.")
                print(f"[CRITICAL] Clearing stale credentials — user MUST re-authenticate.")
                self.add_admin_log('ERROR', f'FK violation: user {self.current_user_id} not in DB. Clearing credentials for re-auth.')
                # Clear stale user data to force re-auth on next cycle
                self.current_user_id = None
                self.organization_id = None
                self.current_user = None
                # Clear cached user info so stale IDs aren't restored
                try:
                    self._clear_cached_user_info()
                except Exception:
                    pass
                # Restore sessions so they aren't lost
                if sessions:
                    self.session_manager.restore_sessions(sessions)
                    print(f"[BATCH] {len(sessions)} sessions restored to SQLite. Will retry after re-authentication.")
                return

            if is_auth_error and records:
                print(f"[BATCH] Auth error during upload: {e}")
                print("[BATCH] Refreshing Supabase JWT and retrying once...")
                self.add_admin_log('WARN', f'Batch upload auth error: {e}. Refreshing JWT and retrying...')
                if self._set_supabase_jwt():
                    try:
                        # Check if records were partially inserted before the error
                        # (e.g., HTTP timeout after server committed). batch_timestamp
                        # is unique per upload cycle, so we can detect duplicates.
                        if batch_timestamp:
                            existing = self.supabase.table('activity_records') \
                                .select('id') \
                                .eq('user_id', self.current_user_id) \
                                .eq('batch_timestamp', batch_timestamp) \
                                .execute()
                            if existing.data and len(existing.data) > 0:
                                print(f"[BATCH] {len(existing.data)} records already inserted before error — skipping retry to avoid duplicates")
                                self._pending_idle_records.clear()
                                self.current_window_key = None
                                self.batch_start_time = datetime.now(timezone.utc)
                                self.last_batch_upload_time = time.time()
                                return

                        result = self.supabase.table('activity_records').insert(records).execute()
                        if result.data:
                            print(f"[BATCH] Retry succeeded — {len(result.data)} records uploaded after JWT refresh")
                            self.add_admin_log('INFO', f'Batch uploaded after JWT refresh: {len(result.data)} records')
                            self._pending_idle_records.clear()
                            self.current_window_key = None
                            self.batch_start_time = datetime.now(timezone.utc)
                            self.last_batch_upload_time = time.time()
                            return
                    except Exception as retry_e:
                        print(f"[ERROR] Retry also failed: {retry_e}")
                        self.add_admin_log('ERROR', f'Batch upload retry also failed: {retry_e}')

            else:
                print(f"[ERROR] Activity batch upload failed: {e}")
                self.add_admin_log('ERROR', f'Batch upload failed: {e}')
                if hasattr(e, 'message'):
                    print(f"       Supabase error: {e.message}")
                if hasattr(e, 'code'):
                    print(f"       Error code: {e.code}")
                if hasattr(e, 'details'):
                    print(f"       Details: {e.details}")

            # Before restoring sessions, check if the insert actually succeeded
            # (e.g., server committed but response timed out — restoring would cause duplicates)
            if sessions and batch_timestamp and self.supabase:
                try:
                    existing = self.supabase.table('activity_records') \
                        .select('id') \
                        .eq('user_id', self.current_user_id) \
                        .eq('batch_timestamp', batch_timestamp) \
                        .execute()
                    if existing.data and len(existing.data) > 0:
                        print(f"[BATCH] {len(existing.data)} records already in database despite error — skipping restore to avoid duplicates")
                        self._pending_idle_records.clear()
                        self.current_window_key = None
                        self.batch_start_time = datetime.now(timezone.utc)
                        self.last_batch_upload_time = time.time()
                        return
                except Exception:
                    pass  # Can't verify — fall through to restore

            # Restore sessions to SQLite so they can be retried on next cycle
            if sessions:
                # If idle records were in the batch, retry work sessions WITHOUT idle records
                # to prevent failed idle records from poisoning all future batch uploads
                if idle_records and sessions:
                    print(f"[BATCH] Retrying {len(sessions)} work sessions WITHOUT {len(idle_records)} idle records...")
                    try:
                        work_only_records = [r for r in records if not r.get('is_idle')]
                        if work_only_records:
                            retry_result = self.supabase.table('activity_records').insert(work_only_records).execute()
                            if retry_result.data:
                                print(f"[BATCH] Work-only retry succeeded — {len(retry_result.data)} work records uploaded")
                                print(f"[BATCH] Idle records failed separately — discarding to prevent batch poisoning")
                                self._pending_idle_records.clear()  # Discard problematic idle records
                                self.current_window_key = None
                                self.batch_start_time = datetime.now(timezone.utc)
                                self.last_batch_upload_time = time.time()
                                self.add_admin_log('WARN', f'Batch uploaded {len(retry_result.data)} work records. Idle records failed — check DB constraints.')
                                return
                    except Exception as retry_e:
                        print(f"[BATCH] Work-only retry also failed: {retry_e}")

                self.session_manager.restore_sessions(sessions)
                print(f"       {len(sessions)} records restored to SQLite for retry on next cycle")
                self.add_admin_log('WARN', f'{len(sessions)} records queued for retry on next cycle')
            elif idle_records:
                # Only idle records in the batch and they failed — discard to prevent poisoning
                print(f"[BATCH] Idle-only batch failed — discarding {len(idle_records)} idle records to prevent batch poisoning")
                print(f"[BATCH] This likely means the database CHECK constraint does not allow classification='idle'")
                print(f"[BATCH] FIX: Run migration 20260325_add_idle_time_support.sql in Supabase SQL Editor")
                self._pending_idle_records.clear()
                self.add_admin_log('ERROR', f'Idle record insert failed — CHECK constraint may not allow classification=idle. Run migration 20260325.')
            self.last_batch_upload_time = time.time()

        # FIX-9 (B-12): After each batch (success or failure), drain any screenshot
        # UPDATE calls that previously failed and were saved to pending_finalizes.
        if self.supabase and self.current_user_id:
            self._drain_pending_finalizes()

    def _drain_pending_finalizes(self):
        """FIX-9: Retry failed screenshots UPDATE calls saved in pending_finalizes table.

        _finalize_active_session() stores a row here when the Supabase UPDATE fails
        (network loss, JWT expiry, timeout). This method replays up to 10 rows per
        batch cycle so records never remain stuck with end_time = NULL.
        """
        try:
            rows = self.db_manager.fetchall(
                "SELECT id, screenshot_id, end_time, duration_seconds FROM pending_finalizes ORDER BY id LIMIT 10"
            )
            if not rows:
                return
            print(f"[BATCH] FIX-9: Draining {len(rows)} pending finalize(s)...")
            for row in rows:
                row_id, screenshot_id, end_time_str, duration_seconds = row
                try:
                    result = self.supabase.table('screenshots').update({
                        'end_time': end_time_str,
                        'timestamp': end_time_str,
                        'duration_seconds': int(duration_seconds),
                    }).eq('id', screenshot_id).execute()
                    if result.data:
                        self.db_manager.execute(
                            "DELETE FROM pending_finalizes WHERE id = ?", (row_id,)
                        )
                        print(f"[BATCH] FIX-9: Pending finalize applied for {screenshot_id}")
                except Exception as _pf_err:
                    print(f"[WARN] FIX-9: Pending finalize retry failed for {screenshot_id}: {_pf_err}")
        except Exception as _e:
            print(f"[WARN] FIX-9: _drain_pending_finalizes error: {_e}")

    def process_window_event(self, window_info):
        """Core event handler for event-based activity tracking.
        Called on every window switch.

        1. Classify app (productive, non_productive, private, unknown)
        2. If productive/unknown: run OCR to capture screen text
        3. If private: redact window title
        4. If non_productive: no OCR, just metadata
        5. If unknown: async classify via AI server
        6. Update session manager with OCR result (text, method, confidence, error)
        """
        app_name = window_info.get('app', '')
        window_title = window_info.get('title', '')

        # Never track lock screen apps as active sessions
        if app_name.lower() in LOCK_SCREEN_APPS:
            print(f"[SKIP] Lock screen app detected: {app_name}")
            return

        # Classify the application
        classification, match_type = self.classification_manager.classify(app_name, window_title)

        ocr_result = None
        display_title = window_title

        # Apply PII check to window title for non-private apps
        # Window titles can contain PII (e.g., "john.doe@company.com - Outlook")
        if classification != 'private' and window_title:
            try:
                from ocr.facade import get_facade
                facade = get_facade()
                if facade._privacy_filter:
                    title_result = facade._privacy_filter.redact(window_title)
                    if title_result.get('redactions_count', 0) > 0:
                        display_title = title_result['text']
                        print(f"[PRIVACY] Window title redacted: {title_result['redactions_count']} PII item(s)")
            except Exception:
                # Non-fatal: if title PII check fails, use original title
                pass

        if classification == 'private':
            # Private app: redact window title, no OCR
            display_title = '[PRIVATE]'
            print(f"[PRIVATE] {app_name} — window title redacted")

        elif classification == 'non_productive':
            # Non-productive: no OCR, just metadata
            print(f"[NON-PROD] {app_name} — {window_title[:50]}")

        elif classification in ('productive', 'unknown'):
            # Productive or unknown: capture screenshot (fast, ~50ms) then dispatch OCR async
            issue_key_in_title = bool(re.search(r'\b[A-Z][A-Z0-9]+-\d+\b', window_title or ''))
            spreadsheet_processes = {'excel.exe', 'libreofficecalc.exe', 'soffice.bin'}
            force_ocr = (classification == 'unknown') or issue_key_in_title or (app_name.lower() in spreadsheet_processes)

            if not self.ocr_processor:
                # OCR unavailable — still create the session for time tracking, just without screenshot data
                if classification == 'productive':
                    print(f"[PROD] {app_name} — {window_title[:50]} (no OCR)")
                elif classification == 'unknown':
                    print(f"[UNKNOWN] {app_name} (no OCR)")
            else:
                capture_result = self.ocr_processor.capture_screenshot_only(force=force_ocr)
                screenshot = capture_result.get('screenshot')
                throttled = capture_result.get('throttled', False)

                if throttled and screenshot:
                    # Throttled: save screenshot for batch backfill
                    ocr_result = {
                        'text': None, 'method': None, 'confidence': 0.0,
                        'error_message': None, 'throttled': True,
                        'screenshot': screenshot
                    }
                elif not screenshot:
                    if classification == 'unknown':
                        self._maybe_classify_unknown_app(app_name, window_title, None)

                if classification == 'productive':
                    print(f"[PROD] {app_name} — {window_title[:50]}")
                elif classification == 'unknown':
                    print(f"[UNKNOWN] {app_name}")

        # CRITICAL: Create session FIRST so it exists when async OCR callback fires.
        # This fixes race condition where OCR completes before session is created.
        self.session_manager.on_window_switch(display_title, app_name, classification, ocr_result)

        # Now dispatch async OCR AFTER session exists (only for productive/unknown with valid screenshot)
        if classification in ('productive', 'unknown'):
            # Re-check if we have a non-throttled screenshot to process
            if 'capture_result' in dir() and capture_result.get('screenshot') and not capture_result.get('throttled'):
                screenshot = capture_result.get('screenshot')
                _cb_title = display_title
                _cb_app = app_name
                _cb_classification = classification
                _cb_window_title = window_title

                def _ocr_callback(ocr_res, _title=_cb_title, _app=_cb_app,
                                  _cls=_cb_classification, _wtitle=_cb_window_title):
                    # Backfill OCR text into the session (session guaranteed to exist now)
                    self.session_manager.backfill_ocr(_title, _app, ocr_res)
                    # If unknown app, trigger AI classification now that we have OCR text
                    if _cls == 'unknown':
                        ocr_text = ocr_res.get('text') if ocr_res else None
                        self._maybe_classify_unknown_app(_app, _wtitle, ocr_text)

                submitted = self.ocr_processor.submit_ocr_async(screenshot, _ocr_callback)
                if submitted:
                    print(f"[OCR-ASYNC] Dispatched async OCR for {app_name}")
                else:
                    # Queue full: save screenshot for batch backfill (same as throttled)
                    # Need to update the session we just created to add the pending screenshot
                    self.session_manager.add_pending_ocr_screenshot(display_title, app_name, screenshot)
                    print(f"[OCR-ASYNC] Queue full for {app_name}, saved for batch backfill")

    def _maybe_classify_unknown_app(self, app_name, window_title, ocr_text):
        """Check dedup key and fire async AI classification if this is a new unknown app."""
        # Skip AI call while offline — it will fail and the app_key would be locked
        # permanently in the dedup set, preventing reclassification when online.
        # By returning before adding to the set, the next window switch when online
        # will trigger a fresh classification attempt naturally.
        if not self.offline_manager.is_online:
            return

        app_lower = app_name.lower()
        if app_lower in BROWSER_PROCESSES:
            domain = self._extract_domain_from_title(window_title)
            title_key = self._extract_title_key_for_classification(window_title, domain)
            app_key = f"{app_lower}|{domain}|{title_key}" if domain else f"{app_lower}|{title_key}"
        else:
            app_key = app_lower

        if app_key not in self._unknown_apps_classified:
            self._unknown_apps_classified.add(app_key)
            print(f"[UNKNOWN] {app_name} — sending to AI server for classification (key: {app_key[:60]})")
            threading.Thread(
                target=self._classify_unknown_app_async,
                args=(app_name, window_title, ocr_text),
                daemon=True
            ).start()
        else:
            print(f"[UNKNOWN] {app_name} — already sent to AI server, skipping (key: {app_key[:60]})")

    def _classify_unknown_app_async(self, app_name, window_title, ocr_text):
        """Background thread: calls POST /api/classify-app on AI server."""
        try:
            ai_server_url = get_env_var('AI_SERVER_URL', '')
            if not ai_server_url:
                print(f"[WARN] AI server URL missing for unknown app {app_name}; keep as unknown for admin review")
                return

            response = requests.post(
                f"{ai_server_url}/api/classify-app",
                json={
                    'application_name': app_name,
                    'window_title': window_title,
                    'ocr_text': ocr_text or ''
                },
                headers=self._get_auth_headers(),
                timeout=10
            )

            if response.status_code == 200:
                data = response.json()
                new_classification = data.get('classification', 'unknown')
                reasoning = data.get('reasoning', '')

                print(f"[AI] Classification for {app_name}: {new_classification}")
                if reasoning:
                    print(f"     Reasoning: {reasoning[:80]}")

                # Update the session's classification via thread-safe method
                self.session_manager.update_classification(app_name, 'unknown', new_classification)

                # Also update already-uploaded activity_records that are still unknown
                # for this app/user/org so DB reflects the latest AI classification.
                try:
                    if self.supabase and self.current_user_id and self.organization_id:
                        new_status = 'pending' if new_classification == 'productive' else 'analyzed'
                        update_query = self.supabase.table('activity_records').update({
                            'classification': new_classification,
                            'status': new_status
                        }).eq('user_id', self.current_user_id) \
                          .eq('organization_id', self.organization_id) \
                          .eq('application_name', app_name) \
                          .eq('classification', 'unknown')

                        if self.current_project_key:
                            update_query = update_query.eq('project_key', self.current_project_key)

                        update_result = update_query.execute()
                        updated_count = len(update_result.data) if getattr(update_result, 'data', None) else 0
                        print(
                            f"[AI] Updated {updated_count} activity_records rows for "
                            f"{app_name}: unknown → {new_classification}"
                        )
                except Exception as db_err:
                    print(f"[WARN] Failed to update unknown activity_records for {app_name}: {db_err}")
            else:
                print(
                    f"[WARN] AI classify-app returned {response.status_code} for {app_name}; "
                    "keeping app as unknown for admin review"
                )
        except Exception as e:
            print(f"[WARN] Failed to classify unknown app {app_name}: {e}")
            print(f"[INFO] Keeping {app_name} as unknown for project admin classification")

    def _extract_title_key_for_classification(self, window_title, domain=''):
        """Extract a normalized title key for per-page classification deduplication.
        
        This extracts the meaningful page title (before the site name) and normalizes it
        so that the same content gets the same key, even with minor variations.
        
        Examples:
            "AI Tutorial - YouTube" (domain=youtube) -> "ai_tutorial"
            "Movie Song - YouTube" (domain=youtube) -> "movie_song"
            "GitHub - AmzurATG/JIRAForge" (domain=github) -> "amzuratg_jiraforge"
            "Stack Overflow - How to fix bug" -> "how_to_fix_bug"
            "Google Search" -> "search"
        
        Returns:
            str: Normalized title key (lowercase, alphanumeric + underscores, max 50 chars)
        """
        if not window_title:
            return 'untitled'
        
        title_lower = window_title.lower().strip()
        
        # Common separators between page title and site name
        separators = [' - ', ' | ', ' – ', ' — ', ' : ', ' · ']
        
        # Try to extract the page title (content before the site name)
        page_title = title_lower
        for sep in separators:
            if sep in title_lower:
                parts = title_lower.split(sep)
                # Site name is usually at the end (e.g., "Video - YouTube")
                # or at the beginning (e.g., "GitHub - Project")
                if domain:
                    # Find which part contains the domain and use the other part(s)
                    non_domain_parts = [p.strip() for p in parts if domain not in p]
                    if non_domain_parts:
                        page_title = ' '.join(non_domain_parts)
                        break
                else:
                    # No domain hint — use the longer part (likely the content)
                    page_title = max(parts, key=len).strip()
                    break
        
        # Normalize: keep only alphanumeric and spaces, then convert spaces to underscores
        normalized = re.sub(r'[^a-z0-9\s]', '', page_title)
        normalized = re.sub(r'\s+', '_', normalized.strip())
        
        # Truncate to reasonable length (avoid huge keys)
        if len(normalized) > 50:
            normalized = normalized[:50].rsplit('_', 1)[0]  # Don't cut mid-word
        
        return normalized if normalized else 'untitled'

    def _extract_domain_from_title(self, window_title):
        """Extract domain/site identifier from browser window title.
        
        Browser window titles typically include the site name or domain.
        Examples:
            "Anthropic | Claude" -> "anthropic"
            "YouTube - AI Tutorial" -> "youtube"
            "GitHub - AmzurATG/JIRAForge" -> "github"
            "Google Search" -> "google"
            "Stack Overflow - How to..." -> "stackoverflow"
        
        Returns:
            str: Lowercase domain/site identifier, or empty string if not found
        """
        if not window_title:
            return ''
        
        title_lower = window_title.lower()
        
        # Common site patterns to extract
        site_patterns = [
            # Direct domain mentions
            ('youtube', 'youtube'),
            ('github', 'github'),
            ('stackoverflow', 'stackoverflow'),
            ('stack overflow', 'stackoverflow'),
            ('google', 'google'),
            ('facebook', 'facebook'),
            ('twitter', 'twitter'),
            ('linkedin', 'linkedin'),
            ('reddit', 'reddit'),
            ('instagram', 'instagram'),
            ('amazon', 'amazon'),
            ('netflix', 'netflix'),
            ('spotify', 'spotify'),
            ('slack', 'slack'),
            ('discord', 'discord'),
            ('zoom', 'zoom'),
            ('teams', 'teams'),
            ('outlook', 'outlook'),
            ('gmail', 'gmail'),
            ('jira', 'jira'),
            ('atlassian', 'atlassian'),
            ('confluence', 'confluence'),
            ('bitbucket', 'bitbucket'),
            ('trello', 'trello'),
            ('notion', 'notion'),
            ('figma', 'figma'),
            ('canva', 'canva'),
            ('anthropic', 'anthropic'),
            ('openai', 'openai'),
            ('chatgpt', 'chatgpt'),
        ]
        
        for pattern, site_id in site_patterns:
            if pattern in title_lower:
                return site_id
        
        # Try to extract from URL-like patterns in title
        # e.g., "example.com - Page Title"
        import re
        url_match = re.search(r'([a-z0-9][-a-z0-9]*\.)+[a-z]{2,}', title_lower)
        if url_match:
            domain = url_match.group(0)
            # Extract main domain (e.g., "example.com" from "www.example.com")
            parts = domain.split('.')
            if len(parts) >= 2:
                return parts[-2]  # Return main domain name
        
        # Fallback: use first word of title as identifier
        # This handles cases like "Anthropic | Claude" -> "anthropic"
        words = title_lower.split()
        if words:
            # Clean first word of special characters
            first_word = re.sub(r'[^a-z0-9]', '', words[0])
            if len(first_word) >= 3:
                return first_word
        
        return ''

    def _get_auth_headers(self):
        """Get authentication headers for AI server requests.

        Jira users authenticate with their Atlassian OAuth token. Google
        (non-Jira) users have no Atlassian token, so they authenticate with their
        Supabase JWT instead — the AI server's desktop-auth middleware accepts
        either. Without this, Google sessions send no token and the server 401s
        (e.g. AI app classification on /api/classify-app would be skipped).
        """
        headers = {'Content-Type': 'application/json'}
        if hasattr(self, 'auth_manager') and self.auth_manager:
            am = self.auth_manager
            if getattr(am, 'auth_provider', 'atlassian') == 'google':
                token = am.get_valid_supabase_token()
            else:
                token = am.tokens.get('access_token')
            if token:
                headers['Authorization'] = f'Bearer {token}'
        return headers

    def capture_screenshot(self):
        """Capture screenshot and return PIL Image (focused monitor aware)"""
        try:
            screenshot = capture_focused_monitor()
            if screenshot is None:
                return None
            screenshot_bytes = screenshot.tobytes()
            current_hash = hashlib.md5(screenshot_bytes).hexdigest()
            
            # Skip if unchanged
            if current_hash == self.screenshot_hash:
                return None
            
            self.screenshot_hash = current_hash
            return screenshot
        except Exception as e:
            print(f"[ERROR] Screenshot capture failed: {e}")
            return None
    
    def _is_screen_locked(self):
        """Check if the screen is currently locked.

        Windows: inspects the foreground window's process name.
        Linux (FIX-3): tries four D-Bus / systemd methods in order so that
                 non-GNOME desktops (KDE, XFCE, i3, sway …) are also detected.
                 Results are cached for 5 s to avoid stalling the tracking loop.
        Returns True when the lock/login screen is active.
        """
        if WIN32_AVAILABLE:
            try:
                hwnd = win32gui.GetForegroundWindow()
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                process = psutil.Process(pid)
                return process.name().lower() in LOCK_SCREEN_APPS
            except Exception:
                return False

        # Linux: cache result for 5 s so repeated calls inside the tracking loop
        # don't spawn multiple subprocesses on every 2-second iteration.
        _now = time.time()
        _cached = getattr(self, '_screen_lock_cache', None)
        if _cached and (_now - _cached[0]) < 5:
            return _cached[1]

        _locked = False
        try:
            # Method 1: GNOME ScreenSaver (GNOME Shell 3+)
            result = subprocess.run(
                ['gdbus', 'call', '--session',
                 '--dest', 'org.gnome.ScreenSaver',
                 '--object-path', '/org/gnome/ScreenSaver',
                 '--method', 'org.gnome.ScreenSaver.GetActive'],
                capture_output=True, text=True, timeout=1
            )
            if result.returncode == 0:
                _locked = 'true' in result.stdout.lower()
                self._screen_lock_cache = (_now, _locked)
                return _locked
        except Exception:
            pass

        try:
            # Method 2: KDE ScreenSaver (KDE Plasma 5/6)
            result = subprocess.run(
                ['gdbus', 'call', '--session',
                 '--dest', 'org.kde.screensaver',
                 '--object-path', '/ScreenSaver',
                 '--method', 'org.kde.screensaver.GetActive'],
                capture_output=True, text=True, timeout=1
            )
            if result.returncode == 0:
                _locked = 'true' in result.stdout.lower()
                self._screen_lock_cache = (_now, _locked)
                return _locked
        except Exception:
            pass

        try:
            # Method 3: FreeDesktop ScreenSaver (XFCE, MATE, LXQt …)
            result = subprocess.run(
                ['gdbus', 'call', '--session',
                 '--dest', 'org.freedesktop.ScreenSaver',
                 '--object-path', '/org/freedesktop/ScreenSaver',
                 '--method', 'org.freedesktop.ScreenSaver.GetActive'],
                capture_output=True, text=True, timeout=1
            )
            if result.returncode == 0:
                _locked = 'true' in result.stdout.lower()
                self._screen_lock_cache = (_now, _locked)
                return _locked
        except Exception:
            pass

        try:
            # Method 4: loginctl (systemd, display-server agnostic)
            # LockedHint=yes means the session lock is active
            result = subprocess.run(
                ['loginctl', 'show-session', '--property=LockedHint', '--value'],
                capture_output=True, text=True, timeout=1
            )
            if result.returncode == 0:
                _locked = result.stdout.strip().lower() == 'yes'
                self._screen_lock_cache = (_now, _locked)
                return _locked
        except Exception:
            pass

        # All methods failed — assume not locked (preserve existing behaviour)
        self._screen_lock_cache = (_now, False)
        return False

    def _get_active_window_linux(self):
        """Get (title, app_name) for the currently focused window on Linux.

                Tries in order:
                    - Wayland session: gdbus first, then xdotool fallback
                    - X11 session: xdotool first, then gdbus fallback

                Reason: on Wayland, xdotool can return stale XWayland focus (often VS Code),
                so we prefer GNOME Shell's compositor-aware focus API.

                    1. primary method based on session type
                    2. fallback method
          3. Returns ('Unknown', 'Unknown') when both methods are unavailable.

        The method is intentionally lightweight: two short-lived subprocesses
        (or one, if the first succeeds) with 1-second timeouts each so they
        never block the 2-second tracking loop.
        """
        def _from_xdotool():
            try:
                wid_res = subprocess.run(
                    ['xdotool', 'getactivewindow'],
                    capture_output=True, text=True, timeout=1
                )
                if wid_res.returncode != 0:
                    return None
                wid = wid_res.stdout.strip()

                title = 'Unknown'
                name_res = subprocess.run(
                    ['xdotool', 'getwindowname', wid],
                    capture_output=True, text=True, timeout=1
                )
                if name_res.returncode == 0:
                    title = name_res.stdout.strip() or 'Unknown'

                app_name = 'Unknown'
                try:
                    pid_res = subprocess.run(
                        ['xdotool', 'getwindowpid', wid],
                        capture_output=True, text=True, timeout=1
                    )
                    if pid_res.returncode == 0:
                        pid = int(pid_res.stdout.strip())
                        proc = psutil.Process(pid)
                        app_name = proc.name()
                except (ValueError, psutil.NoSuchProcess, psutil.AccessDenied):
                    pass

                return title, app_name
            except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
                return None

        def _from_gdbus():
            try:
                result = subprocess.run(
                    [
                        'gdbus', 'call', '--session',
                        '--dest', 'org.gnome.Shell',
                        '--object-path', '/org/gnome/Shell',
                        '--method', 'org.gnome.Shell.Eval',
                        (
                            "let w=global.display.focus_window;"
                            "w?(w.title+'|||'+(w.gtk_application_id||w.wm_class||'Unknown'))"
                            ":'Unknown|||Unknown'"
                        )
                    ],
                    capture_output=True, text=True, timeout=2
                )
                if result.returncode != 0 or not result.stdout:
                    return None
                import re as _re
                m = _re.search(r"'([^']*)'", result.stdout)
                if not m:
                    return None
                raw = m.group(1)
                if '|||' not in raw:
                    return None
                title, app_name = raw.split('|||', 1)
                return title.strip() or 'Unknown', app_name.strip() or 'Unknown'
            except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
                return None

        def _from_gnome_introspect():
            """Fallback for GNOME 45+ where Shell.Eval is disabled by default.

            org.gnome.Shell.Introspect.GetWindows() is available on GNOME 40+
            without unsafe mode and exposes a 'has-focus' field per window,
            making it possible to identify the focused window title and app-id
            even when Shell.Eval returns (false, ...).  This correctly tracks
            browser tab switches because each tab change updates window.title.
            Returns (title, app_id) or None on failure.
            """
            try:
                result = subprocess.run(
                    [
                        'gdbus', 'call', '--session',
                        '--dest', 'org.gnome.Shell',
                        '--object-path', '/org/gnome/Shell/Introspect',
                        '--method', 'org.gnome.Shell.Introspect.GetWindows',
                    ],
                    capture_output=True, text=True, timeout=2
                )
                if result.returncode != 0 or not result.stdout:
                    return None

                import re as _re2
                stdout = result.stdout

                # gdbus renders a{ta{sv}} roughly as:
                #   ({'uint64 ID': {'title': <'Tab Title'>, 'app-id': <'org.app'>,
                #                   'has-focus': <true>, 'wm-class': <'App'>}, ...},)
                # Properties are emitted in insertion order; 'title' always appears
                # before 'has-focus' in GNOME Shell source, so scanning forward is safe.
                for title_m in _re2.finditer(r"'title':\s*<\s*'([^']*)'\s*>", stdout):
                    title = title_m.group(1)
                    # Look ahead within one window block (≤ 500 chars) for has-focus
                    ahead_start = title_m.end()
                    lookahead = stdout[ahead_start:ahead_start + 500]
                    hf_m = _re2.search(r"'has-focus':\s*<\s*(true|false)\s*>", lookahead)
                    if hf_m and hf_m.group(1) == 'true':
                        block = stdout[title_m.start():ahead_start + 500]
                        app_m = _re2.search(r"'app-id':\s*<\s*'([^']*)'\s*>", block)
                        app_id = (app_m.group(1) if app_m else '') or ''
                        # XWayland apps may have empty app-id; fall back to wm-class
                        if not app_id:
                            wm_m = _re2.search(r"'wm-class':\s*<\s*'([^']*)'\s*>", block)
                            app_id = (wm_m.group(1) if wm_m else '') or 'Unknown'
                        if title:
                            return title, app_id or 'Unknown'
                return None
            except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
                return None

        def _from_atspi():
            """AT-SPI2 fallback for native Wayland apps (Chrome, Firefox, etc.).

            On GNOME Wayland, apps like Chrome run natively (not via XWayland),
            so xdotool and xprop cannot see them.  AT-SPI2 (accessibility bus)
            is supported by Chrome, Firefox, and most modern apps and correctly
            returns the focused window title — including the current browser tab
            title — making in-browser tab switches trackable.

            Detection order:
              1. In-process gi/Atspi import (fast; works when python-gi is
                 available in the running Python, e.g. development/system mode).
              2. System python3 subprocess (works in AppImage where gi is not
                 bundled, as long as the host has python3-gi installed).

            Returns (title, app_name) for the first ACTIVE non-shell window,
            or None on failure.
            """
            def _atspi_query():
                import gi as _gi  # noqa: PLC0415
                _gi.require_version('Atspi', '2.0')
                from gi.repository import Atspi as _Atspi  # noqa: PLC0415
                _Atspi.init()
                desktop = _Atspi.get_desktop(0)
                ACTIVE = _Atspi.StateType.ACTIVE
                for i in range(desktop.get_child_count()):
                    app = desktop.get_child_at_index(i)
                    if not app or app.get_name() == 'gnome-shell':
                        continue
                    for j in range(app.get_child_count()):
                        win = app.get_child_at_index(j)
                        if not win:
                            continue
                        try:
                            if win.get_state_set().contains(ACTIVE):
                                title = win.get_name() or ''
                                if title:
                                    return title, app.get_name() or 'Unknown'
                        except Exception:
                            continue
                return None

            # Attempt 1: in-process (development / system Python with python3-gi)
            try:
                result = _atspi_query()
                if result:
                    return result
            except (ImportError, Exception):
                pass

            # Attempt 2: spawn the system python3 (AppImage where gi is not bundled)
            code = (
                "import gi, sys\n"
                "gi.require_version('Atspi','2.0')\n"
                "from gi.repository import Atspi\n"
                "Atspi.init()\n"
                "d = Atspi.get_desktop(0)\n"
                "A = Atspi.StateType.ACTIVE\n"
                "for i in range(d.get_child_count()):\n"
                " a = d.get_child_at_index(i)\n"
                " if not a or a.get_name() == 'gnome-shell': continue\n"
                " for j in range(a.get_child_count()):\n"
                "  w = a.get_child_at_index(j)\n"
                "  if not w: continue\n"
                "  try:\n"
                "   if w.get_state_set().contains(A) and w.get_name():\n"
                "    print(w.get_name() + '|||' + (a.get_name() or 'Unknown'))\n"
                "    sys.exit(0)\n"
                "  except: pass\n"
            )
            try:
                res = subprocess.run(
                    ['python3', '-c', code],
                    capture_output=True, text=True, timeout=2
                )
                if res.returncode == 0 and '|||' in (res.stdout or ''):
                    parts = res.stdout.strip().split('|||', 1)
                    title = parts[0].strip()
                    app_name = parts[1].strip() if len(parts) > 1 else 'Unknown'
                    if title:
                        return title, app_name or 'Unknown'
            except (FileNotFoundError, subprocess.TimeoutExpired, Exception):
                pass
            return None

        is_wayland = bool(
            os.environ.get('WAYLAND_DISPLAY') or
            os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
        )

        # Wayland: try Shell.Eval first (fast, GNOME < 45), then Introspect
        # (works on GNOME 40+ without unsafe mode), then xdotool (XWayland fallback).
        # X11: xdotool is most reliable; D-Bus methods are secondary.
        method_pairs = (
            [('gdbus', _from_gdbus), ('gnome_introspect', _from_gnome_introspect),
             ('xdotool', _from_xdotool), ('atspi', _from_atspi)]
            if is_wayland
            else [('xdotool', _from_xdotool), ('gdbus', _from_gdbus),
                  ('gnome_introspect', _from_gnome_introspect), ('atspi', _from_atspi)]
        )

        # FIX-6 (BL-17): Circuit-breaker — skip methods that have failed 3+ times recently.
        # Prevents stalling the 2-second tracking loop for 9+ seconds on minimal Linux
        # where all methods time out on every call.
        _CB_OPEN_AFTER  = 3    # failures before circuit opens
        _CB_RESET_AFTER = 60   # seconds before retry
        if not hasattr(self, '_win_method_failures'):
            self._win_method_failures = {}

        for method_name, resolver in method_pairs:
            # Check circuit state
            _cb = self._win_method_failures.get(method_name, {'count': 0, 'open_until': 0})
            if _cb['count'] >= _CB_OPEN_AFTER and time.time() < _cb.get('open_until', 0):
                continue  # circuit open — skip this method
            if _cb['count'] >= _CB_OPEN_AFTER and time.time() >= _cb.get('open_until', 0):
                # Grace period expired — reset and allow one retry
                self._win_method_failures[method_name] = {'count': 0, 'open_until': 0}

            try:
                resolved = resolver()
                if resolved:
                    title, app_name = resolved
                    # On Wayland, xdotool often returns stale XWayland focus (commonly VS Code).
                    if title == 'Unknown' and app_name == 'Unknown':
                        # Count as a soft failure
                        _cb2 = self._win_method_failures.setdefault(method_name, {'count': 0, 'open_until': 0})
                        _cb2['count'] += 1
                        if _cb2['count'] >= _CB_OPEN_AFTER:
                            _cb2['open_until'] = time.time() + _CB_RESET_AFTER
                        continue
                    # Success — reset failure counter for this method
                    self._win_method_failures[method_name] = {'count': 0, 'open_until': 0}
                    return title, app_name
                else:
                    _cb3 = self._win_method_failures.setdefault(method_name, {'count': 0, 'open_until': 0})
                    _cb3['count'] += 1
                    if _cb3['count'] >= _CB_OPEN_AFTER:
                        _cb3['open_until'] = time.time() + _CB_RESET_AFTER
                        print(f"[WARN] FIX-6: Window detection method '{method_name}' circuit-open for {_CB_RESET_AFTER}s")
            except Exception:
                _cb4 = self._win_method_failures.setdefault(method_name, {'count': 0, 'open_until': 0})
                _cb4['count'] += 1
                if _cb4['count'] >= _CB_OPEN_AFTER:
                    _cb4['open_until'] = time.time() + _CB_RESET_AFTER
                    print(f"[WARN] FIX-6: Window detection method '{method_name}' circuit-open (exception) for {_CB_RESET_AFTER}s")

        return 'Unknown', 'Unknown'

    def get_active_window(self):
        """Get active window information and detect window switches for event-based tracking"""
        try:
            if WIN32_AVAILABLE:
                # Windows: use Win32 API directly
                hwnd = win32gui.GetForegroundWindow()
                title = win32gui.GetWindowText(hwnd)
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                process = psutil.Process(pid)
                app_name = process.name()
            else:
                # Linux: use xdotool (X11/XWayland) or GNOME D-Bus (Wayland)
                title, app_name = self._get_active_window_linux()

            # Create unique window key (app + title) to detect window switches
            window_key = f"{app_name}|||{title}"

            # Detect window switch
            is_new_window = False
            if window_key != self.current_window_key:
                is_new_window = True
                # Window switch = user is active (reset idle timer even if pynput fails)
                self.last_activity_time = time.time()
                # Save previous window info before updating (for final screenshot with full duration)
                # ALWAYS save the previous window info so we can track time properly
                # The screenshot_id may be None if no screenshot was taken (rapid switching)
                if self.current_window_key is not None:
                    self.previous_window_key = self.current_window_key
                    self.previous_window_start_time = self.current_window_start_time
                    self.previous_window_db_start_time = self.current_window_db_start_time  # Actual DB start_time
                    self.previous_window_screenshot_id = self.current_window_screenshot_id  # May be None if no screenshot
                    # Parse previous window info from window_key format: "app|||title"
                    if '|||' in self.current_window_key:
                        prev_app, prev_title = self.current_window_key.split('|||', 1)
                    else:
                        prev_app = 'Unknown'
                        prev_title = 'Unknown'
                    self.previous_window_info = {
                        'title': prev_title,
                        'app': prev_app,
                        'window_key': self.current_window_key
                    }
                # Update current window tracking
                # IMPORTANT: Start time is set to NOW, so the next screenshot will cover from this moment
                self.current_window_key = window_key
                self.current_window_start_time = datetime.now(timezone.utc)
                self.current_window_screenshot_id = None  # Reset - will be set when screenshot is captured
                self.current_window_record_created_at = None  # Reset - will be set when screenshot is captured
                if self.current_window_key and self.current_window_key != 'Unknown|||Unknown':
                    print(f"[INFO] Window switched at {self.current_window_start_time.strftime('%H:%M:%S')}:")
                    print(f"     - App: {app_name}")
                    print(f"     - Title: {title[:50]}")
                    self.add_admin_log('INFO', f'Window switch: {app_name}', {
                        'app': app_name,
                        'title': title[:60] if title else '',
                        'time': self.current_window_start_time.strftime('%H:%M:%S')
                    })

            return {
                'title': title,
                'app': app_name,
                'window_key': window_key,
                'is_new_window': is_new_window
            }
        except Exception as e:
            print(f"[WARN] Failed to get window info: {e}")
            return {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown', 'is_new_window': False}
    
    def upload_screenshot(self, screenshot, window_info, use_previous_window=False):
        """Upload screenshot to Supabase with event-based tracking (start_time and end_time)
        Supports offline mode - saves locally when network is unavailable
        
        Args:
            screenshot: PIL Image to upload
            window_info: Dictionary with window information
            use_previous_window: If True, use previous_window_start_time for duration (final screenshot)
        """
        if not self.current_user_id:
            return

        if SCREENSHOT_MONITORING_HARD_DISABLED:
            print("[INFO] Screenshot upload/storage is disabled by client configuration")
            return None
        
        # Use RLS-scoped client for storage operations (JWT provides identity)
        storage_client = self.supabase
        
        try:
            # Convert screenshot to bytes
            img_buffer = BytesIO()
            screenshot.save(img_buffer, format='PNG')
            img_bytes = img_buffer.getvalue()
            
            # Create thumbnail
            thumbnail = screenshot.copy()
            thumbnail.thumbnail((400, 300))
            thumb_buffer = BytesIO()
            thumbnail.save(thumb_buffer, format='JPEG', quality=70)
            thumb_bytes = thumb_buffer.getvalue()
            
            # Extract text using OCR (dynamic engine selection based on OCR_PRIMARY_ENGINE)
            # Uses screenshot_mode for fast processing (skip heavy denoising/CLAHE)
            print("[OCR] Extracting text from screenshot...")
            ocr_start = time.perf_counter()
            ocr_result = extract_text_from_image(
                screenshot, 
                window_title=window_info['title'], 
                app_name=window_info['app'],
                screenshot_mode=True
            )
            ocr_elapsed_ms = (time.perf_counter() - ocr_start) * 1000.0
            
            extracted_text = ocr_result.get('text', '')
            ocr_confidence = ocr_result.get('confidence', 0.0)
            ocr_method = ocr_result.get('method', 'unknown')
            ocr_line_count = ocr_result.get('line_count', 0)
            ocr_prep_ms = ocr_result.get('prep_ms')
            ocr_infer_ms = ocr_result.get('infer_ms')
            ocr_total_ms = ocr_result.get('total_ms')
            
            if ocr_result.get('success'):
                print(
                    f"[OCR] ✓ Text extracted via {ocr_method} "
                    f"(confidence: {ocr_confidence:.2f}, lines: {ocr_line_count}, took: {ocr_elapsed_ms:.1f}ms, "
                    f"prep: {ocr_prep_ms if ocr_prep_ms is not None else 'NA'}ms, "
                    f"infer: {ocr_infer_ms if ocr_infer_ms is not None else 'NA'}ms, "
                    f"total: {ocr_total_ms if ocr_total_ms is not None else 'NA'}ms)"
                )
                if extracted_text:
                    print(f"[OCR] Preview: {extracted_text[:100]}...")
            else:
                print(
                    f"[OCR] ✗ Failed in {ocr_elapsed_ms:.1f}ms - will use metadata analysis "
                    f"(title: {window_info['title']}, app: {window_info['app']}, "
                    f"prep: {ocr_prep_ms if ocr_prep_ms is not None else 'NA'}ms, "
                    f"infer: {ocr_infer_ms if ocr_infer_ms is not None else 'NA'}ms, "
                    f"total: {ocr_total_ms if ocr_total_ms is not None else 'NA'}ms)"
                )
            
            # Generate filenames
            timestamp = datetime.now(timezone.utc)
            filename = f"screenshot_{int(timestamp.timestamp())}.png"
            thumb_filename = f"thumb_{int(timestamp.timestamp())}.jpg"
            
            storage_path = f"{self.current_user_id}/{filename}"
            thumb_path = f"{self.current_user_id}/{thumb_filename}"
            
            # Event-based tracking: Calculate start_time and end_time
            # end_time is when screenshot is taken (now)
            end_time = timestamp
            
            # start_time calculation - ENSURE NO GAPS between records
            # Priority: Use last_screenshot_end_time to ensure continuity, then fall back to other sources
            if use_previous_window:
                # This is the final screenshot of the previous window
                # Use the previous window's start time to calculate actual time spent
                start_time = self.previous_window_start_time if self.previous_window_start_time else end_time
            elif self.last_screenshot_end_time is not None:
                # IMPORTANT: Use last screenshot's end_time as this record's start_time
                # This ensures no gaps even when window switches were skipped due to min_interval
                start_time = self.last_screenshot_end_time
            elif self.current_window_start_time is not None:
                # Fall back to current window start time
                start_time = self.current_window_start_time
            else:
                # First screenshot ever - start from now (will be adjusted to 1 second)
                start_time = end_time
                self.current_window_start_time = start_time
            
            # Calculate duration in seconds
            duration_seconds = int((end_time - start_time).total_seconds())

            # Sanity check: cap duration at 2x the capture interval (or 10 min minimum)
            # This prevents inflated records if last_screenshot_end_time is stale
            max_duration = max(
                self.tracking_settings.get('screenshot_interval_seconds', self.capture_interval) * 2,
                600  # At least 10 minutes
            )
            if duration_seconds > max_duration:
                print(f"[WARN] Duration {duration_seconds}s exceeds max {max_duration}s — capping (stale start_time?)")
                duration_seconds = max_duration
                start_time = end_time - timedelta(seconds=duration_seconds)

            # Ensure minimum duration of 1 second (for database constraints)
            # IMPORTANT: Do NOT adjust start_time backwards - this causes overlaps!
            # Keep start_time unchanged to maintain continuity with previous record's end_time
            if duration_seconds < 1:
                duration_seconds = 1
                # Don't modify start_time - accept that actual duration was < 1 second
                # The database will show 1s duration but time ranges won't overlap

            # Prepare screenshot data for both online and offline storage
            work_type = window_info.get('work_type', 'office')  # Default to 'office'
            is_non_productive = window_info.get('is_non_productive', False)

            # Refresh user_assigned_issues cache before building payload so DB gets current list
            if self.should_refresh_issues_cache():
                self.user_issues = self.fetch_jira_issues()
                self.issues_cache_time = time.time()
                if self.user_issues:
                    print(f"[OK] Fetched {len(self.user_issues)} In Progress issues for screenshot payload")

            # Get project_key from user's issues or accessible projects
            # This is used as a fallback when AI fails to detect the project
            # Priority: window title issue key > assigned issues > accessible projects
            fallback_project_key = self.get_user_project_key()
            project_key = self._resolve_record_project_key(
                window_info.get('title', ''), fallback_project_key, ocr_text=extracted_text
            )
            if project_key:
                self._record_project_affinity(project_key)

            screenshot_data = {
                'user_id': self.current_user_id,
                'organization_id': self.organization_id,  # Multi-tenancy support
                'timestamp': timestamp.isoformat(),
                'storage_path': storage_path,
                'window_title': window_info['title'],
                'application_name': window_info['app'],
                'file_size_bytes': len(img_bytes),
                'start_time': start_time.isoformat(),
                'end_time': end_time.isoformat(),
                'duration_seconds': duration_seconds,
                'project_key': project_key,  # Project from user's assigned issues
                'user_assigned_issues': self.user_issues,
                # Timezone support for correct date grouping
                'user_timezone': get_local_timezone_name(),  # e.g., 'Asia/Kolkata'
                'work_date': datetime.now().date().isoformat(),   # Local date: 'YYYY-MM-DD'
                'metadata': {
                    'work_type': work_type,
                    'is_non_productive': is_non_productive,
                    'tracking_mode': self.tracking_settings.get('tracking_mode', 'interval'),
                    # OCR data stored in metadata (not separate columns on screenshots table)
                    'extracted_text': extracted_text,
                    'ocr_confidence': ocr_confidence,
                    'ocr_method': ocr_method,
                    'ocr_line_count': ocr_line_count
                }
            }
            
            # Check network connectivity
            is_online = self.offline_manager.check_connectivity()
            
            if not is_online:
                # OFFLINE MODE: Save locally
                local_id = self.offline_manager.save_screenshot_offline(
                    screenshot_data, img_bytes, thumb_bytes
                )
                
                if local_id:
                    pending_count = self.offline_manager.get_pending_count()
                    print(f"[OFFLINE] Screenshot saved locally (ID: {local_id})")
                    print(f"     - Pending sync: {pending_count} screenshots")
                    print(f"     - Window: {window_info['app']}")
                    print(f"     - Duration: {duration_seconds}s")
                    
                    # Update tracking state even when offline
                    self.last_screenshot_end_time = end_time
                    
                    return f"offline_{local_id}"
                else:
                    print("[ERROR] Failed to save screenshot offline")
                    return None
            
            # Ensure Supabase JWT is valid before uploading
            sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
            if sb_expires_at and time.time() > (sb_expires_at - 300):
                if not self._set_supabase_jwt():
                    # JWT refresh failed — save offline
                    local_id = self.offline_manager.save_screenshot_offline(
                        screenshot_data, img_bytes, thumb_bytes
                    )
                    if local_id:
                        self.last_screenshot_end_time = end_time
                        return f"offline_{local_id}"
                    return None

            # ONLINE MODE: Upload to Supabase
            screenshot_result = storage_client.storage.from_('screenshots').upload(
                storage_path, img_bytes, file_options={'content-type': 'image/png'}
            )

            # Validate upload response - Supabase SDK returns dict with 'path' or 'Key' on success
            upload_success = False
            if screenshot_result:
                # Check for success indicators in response
                if hasattr(screenshot_result, 'path') or hasattr(screenshot_result, 'Key'):
                    upload_success = True
                elif isinstance(screenshot_result, dict):
                    upload_success = 'path' in screenshot_result or 'Key' in screenshot_result or 'Id' in screenshot_result
                else:
                    # Response exists but structure unknown - verify file exists
                    try:
                        # Verify file was actually uploaded by listing it
                        path_parts = storage_path.split('/')
                        folder = path_parts[0]  # user_id folder
                        file_name = path_parts[1]  # filename
                        list_result = storage_client.storage.from_('screenshots').list(folder, {'search': file_name, 'limit': 1})
                        upload_success = list_result and len(list_result) > 0
                        if not upload_success:
                            print(f"[ERROR] Storage upload verification failed - file not found after upload: {storage_path}")
                    except Exception as verify_err:
                        print(f"[WARN] Could not verify upload: {verify_err}")
                        upload_success = True  # Assume success if we can't verify

            if not upload_success:
                print(f"[ERROR] Screenshot storage upload failed - response: {screenshot_result}")
                # Save offline as fallback
                local_id = self.offline_manager.save_screenshot_offline(
                    screenshot_data, img_bytes, thumb_bytes
                )
                if local_id:
                    self.last_screenshot_end_time = end_time
                    return f"offline_{local_id}"
                return None

            # Upload succeeded - get public URL
            screenshot_url = storage_client.storage.from_('screenshots').get_public_url(storage_path)

            # Upload thumbnail
            thumb_result = storage_client.storage.from_('screenshots').upload(
                thumb_path, thumb_bytes, file_options={'content-type': 'image/jpeg'}
            )

            thumb_url = None
            if thumb_result:
                thumb_url = storage_client.storage.from_('screenshots').get_public_url(thumb_path)
                
                # Issues cache was already refreshed before building screenshot_data

                # Update screenshot_data with URLs for database insert
                screenshot_data['storage_url'] = screenshot_url
                screenshot_data['thumbnail_url'] = thumb_url
                screenshot_data['status'] = 'pending'
                
                # Insert screenshot record via RLS-scoped client
                db_client = self.supabase
                result = db_client.table('screenshots').insert(screenshot_data).execute()
                
                if result.data:
                    screenshot_id = result.data[0]['id']
                    print(f"[OK] Screenshot uploaded and saved to database:")
                    print(f"     - File: {filename}")
                    print(f"     - Database ID: {screenshot_id}")
                    print(f"     - Storage: {storage_path}")
                    print(f"     - Size: {len(img_bytes)} bytes")
                    print(f"     - Start: {start_time.strftime('%H:%M:%S')}")
                    print(f"     - End:   {end_time.strftime('%H:%M:%S')}")
                    print(f"     - Duration: {duration_seconds}s")
                    print(f"     - App: {window_info['app']}")
                    self.add_admin_log('INFO', f"Screenshot captured: {window_info['app']} ({duration_seconds}s)", {
                        'file': filename,
                        'id': screenshot_id[:8] + '...',  # Short ID for display
                        'full_id': screenshot_id,
                        'storage': storage_path,
                        'size': len(img_bytes),
                        'start': start_time.strftime('%H:%M:%S'),
                        'end': end_time.strftime('%H:%M:%S'),
                        'duration': duration_seconds,
                        'app': window_info['app'],
                        'title': window_info.get('title', '')[:50]  # Truncate long titles
                    })
                    
                    # Store the screenshot ID so we can update end_time/duration later
                    # When user switches windows OR when interval is reached, this record will be updated
                    self.current_window_screenshot_id = screenshot_id

                    # IMPORTANT: Track the actual start_time saved to database
                    # This may differ from current_window_start_time due to gap-free continuity logic
                    self.current_window_db_start_time = start_time

                    # Track when this record was actually created (for interval safeguard)
                    # This is different from start_time which may be from last_screenshot_end_time
                    self.current_window_record_created_at = datetime.now(timezone.utc)

                    # Track end_time for continuity - next screenshot will start from here
                    # This ensures no gaps between records
                    self.last_screenshot_end_time = end_time
                    
                    # For interval captures, current_window_start_time was already updated
                    # in tracking_loop before calling upload_screenshot
                    # For window switches, it was set in get_active_window()
                    
                    return screenshot_id
                else:
                    print(f"[WARN] Screenshot uploaded to storage but database insert returned no data")
                    return None
            
        except requests.exceptions.ConnectionError:
            # Network error - save offline
            print("[WARN] Connection error - saving screenshot offline")
            self.add_admin_log('WARN', 'Connection error - saving screenshot offline')
            local_id = self.offline_manager.save_screenshot_offline(
                screenshot_data, img_bytes, thumb_bytes
            )
            if local_id:
                self.last_screenshot_end_time = end_time
                self.offline_manager.is_online = False
                return f"offline_{local_id}"
            return None
            
        except Exception as e:
            print(f"[ERROR] Screenshot upload failed: {e}")
            self.add_admin_log('ERROR', f'Screenshot upload failed: {str(e)[:100]}')
            traceback.print_exc()
            
            # Try to save offline as fallback
            try:
                print("[INFO] Attempting to save screenshot offline as fallback...")
                local_id = self.offline_manager.save_screenshot_offline(
                    screenshot_data, img_bytes, thumb_bytes
                )
                if local_id:
                    self.last_screenshot_end_time = end_time
                    return f"offline_{local_id}"
            except Exception as offline_err:
                print(f"[ERROR] Offline save also failed: {offline_err}")
        
        return None

    def _finalize_active_session(self, reason="idle"):
        """Finalize the current work session by updating its end_time in the DB.
        Called when entering idle (timeout, system sleep, or screen lock).

        FIX-9 (B-12): On Supabase network failure the UPDATE is saved to the local
        SQLite pending_finalizes table and retried on the next batch upload cycle,
        so records never remain stuck with end_time = NULL permanently.
        """
        if self.current_window_screenshot_id is None or self.current_window_db_start_time is None:
            return
        try:
            end_time = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
            duration_seconds = int((end_time - self.current_window_db_start_time).total_seconds())

            # Sanity check: cap duration to prevent inflated records
            # (e.g., if last_activity_time was updated by pynput after system wake)
            capture_interval = self.tracking_settings.get('screenshot_interval_seconds', self.capture_interval)
            max_duration = max(capture_interval * 2, 600)
            if duration_seconds > max_duration:
                print(f"[WARN] Finalize duration {duration_seconds}s exceeds max {max_duration}s — capping")
                duration_seconds = max_duration
                end_time = self.current_window_db_start_time + timedelta(seconds=duration_seconds)

            if duration_seconds < 1:
                duration_seconds = 1
                end_time = self.current_window_db_start_time + timedelta(seconds=1)

            db_client = self.supabase
            update_result = db_client.table('screenshots').update({
                'end_time': end_time.isoformat(),
                'timestamp': end_time.isoformat(),
                'duration_seconds': duration_seconds
            }).eq('id', self.current_window_screenshot_id).execute()

            if update_result.data:
                print(f"[OK] Finalized work session ({reason}):")
                print(f"     - Record ID: {self.current_window_screenshot_id}")
                print(f"     - Start: {self.current_window_db_start_time.strftime('%H:%M:%S')} (from DB)")
                print(f"     - End (last activity): {end_time.strftime('%H:%M:%S')}")
                print(f"     - Duration: {duration_seconds}s")

            self.current_window_screenshot_id = None
            self.current_window_record_created_at = None
            self.current_window_start_time = None
            self.current_window_db_start_time = None
            self.last_screenshot_end_time = end_time
        except Exception as e:
            print(f"[ERROR] Error finalizing session ({reason}): {e}")
            # FIX-9: Save to SQLite so the UPDATE is retried on the next batch cycle.
            try:
                _sid  = self.current_window_screenshot_id
                _et   = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
                _dur  = max(1, int((_et - (self.current_window_db_start_time or _et)).total_seconds()))
                self.db_manager.execute(
                    """INSERT OR IGNORE INTO pending_finalizes
                       (screenshot_id, end_time, duration_seconds)
                       VALUES (?, ?, ?)""",
                    (_sid, _et.isoformat(), _dur)
                )
                print(f"[OFFLINE] FIX-9: Pending finalize saved to SQLite for record {_sid}")
            except Exception as _sq_err:
                print(f"[ERROR] FIX-9: Could not save pending finalize to SQLite: {_sq_err}")
            # Always clear in-memory state so we don't re-attempt from stale instance vars
            self.current_window_screenshot_id = None
            self.current_window_record_created_at = None
            self.current_window_start_time = None
            self.current_window_db_start_time = None

    def enter_idle(self, reason):
        """Thread-safe transition to idle state.
        
        Called when entering idle (timeout, system sleep, or screen lock).
        Only transitions if currently in ACTIVE state.
        
        Args:
            reason: String describing why entering idle (e.g., 'system sleep', 'idle timeout')
            
        Returns:
            bool: True if transition succeeded, False if already idle/paused/stopped
        """
        # FIX-4 (BL-20): Capture state under lock, then release before making
        # any HTTP/Supabase calls so state_lock is never held during network I/O.
        was_active = False
        with self.state_lock:
            if self.state == TrackingState.IDLE:
                return False

            # FIX-2: Don't finalize session or enter idle while user has manually paused.
            if self.state == TrackingState.PAUSED:
                print(f"[IDLE] enter_idle({reason}) suppressed — tracking is paused by user")
                return False

            print(f"[STATE] {self.state.name} → IDLE (reason: {reason})")
            was_active = (self.state == TrackingState.ACTIVE)

            if was_active:
                # Record when idle started (backdate to last activity)
                self.idle_start_time = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
                # Store the project key at idle entry
                self.idle_project_key = self.current_project_key
            else:
                self.idle_start_time = datetime.now(timezone.utc)

            self.idle_reason = reason
            self.state = TrackingState.IDLE
            self.is_idle = True
            # FIX-7: record entry time for secondary resume path
            self._idle_entry_time = time.time()
        # ---- lock released ----

        # HTTP / SQLite calls outside the lock (FIX-4)
        if was_active:
            self._finalize_active_session(reason)
            self.session_manager.stop_current_timer()

        # Update UI — thread-safe wrapper (FIX-5)
        self._safe_update_tray_icon()
        self.add_admin_log('INFO', f'Entered idle state: {reason}')

        return True

    def resume_from_idle(self):
        """Thread-safe transition from idle to active state.
        
        Called when user activity is detected after idle period.
        Resets all tracking state so new session starts fresh.
        
        Returns:
            bool: True if transition succeeded, False if not idle
        """
        # FIX-4 (BL-20): Capture idle metadata under lock, then release before
        # calling _create_idle_record() or session_manager.start_new_timer().
        with self.state_lock:
            if self.state != TrackingState.IDLE:
                return False
                
            print(f"[STATE] IDLE → ACTIVE")

            # Clear idle tracking variables under lock
            self.idle_start_time = None
            self.idle_reason = None
            
            self.state = TrackingState.ACTIVE
            self.is_idle = False
            self.needs_idle_resume = False

            # Reset tracking state — new session starts fresh
            self.current_window_start_time = None
            self.current_window_db_start_time = None
            self.current_window_screenshot_id = None
            self.current_window_record_created_at = None
            self.last_screenshot_end_time = None
            self.previous_window_key = None
            self.previous_window_screenshot_id = None
            self.previous_window_start_time = None
            self.previous_window_db_start_time = None
            self.current_window_key = None
            self.current_project_key = None
            self.current_window_title = None
            self.last_interval_time = time.time()
        # ---- lock released ----

        # HTTP / SQLite calls outside the lock (FIX-4)
        self._create_idle_record("idle timeout")
        self.session_manager.start_new_timer()

        # Update UI — thread-safe wrapper (FIX-5)
        self._safe_update_tray_icon()
        self.add_admin_log('INFO', 'Resumed from idle - tracking active')

        return True

    def _is_within_work_hours(self, utc_dt):
        """Check if a UTC datetime falls within configured working hours (local time).
        Supports cross-midnight schedules (e.g. 22:00–06:00 for night shifts).
        Returns True if work hours are not configured (fail-open).
        """
        try:
            settings = self.tracking_settings or {}
            start_str = settings.get('work_hours_start', '09:00:00')
            end_str = settings.get('work_hours_end', '18:00:00')
            work_days = settings.get('work_days', [1, 2, 3, 4, 5])

            # Convert UTC datetime to local time
            local_dt = utc_dt.astimezone()
            local_time = local_dt.time()
            # Python isoweekday(): Monday=1 ... Sunday=7
            iso_weekday = local_dt.isoweekday()

            # Parse start/end as time objects (handle HH:MM and HH:MM:SS)
            start_parts = [int(p) for p in start_str.split(':')]
            end_parts = [int(p) for p in end_str.split(':')]
            from datetime import time as dt_time
            work_start = dt_time(*start_parts)
            work_end = dt_time(*end_parts)

            if work_start <= work_end:
                # Normal schedule (e.g. 09:00–18:00)
                if iso_weekday not in work_days:
                    return False
                return work_start <= local_time <= work_end
            else:
                # Cross-midnight schedule (e.g. 22:00–06:00)
                # Before midnight: check today is a work day
                if local_time >= work_start:
                    return iso_weekday in work_days
                # After midnight: the shift started the previous day
                if local_time <= work_end:
                    prev_day = iso_weekday - 1 if iso_weekday > 1 else 7
                    return prev_day in work_days
                return False
        except Exception as e:
            print(f"[WARN] Work hours check failed, allowing idle record: {e}")
            return True  # Fail-open: record idle if check fails

    def _create_idle_record(self, reason="idle timeout"):
        """Create an idle record from idle_start_time to now and queue it for upload.

        FIX-8: idle_start_time is cleared at the TOP of the function (before any
        processing) so that a concurrent call racing in from the message-pump thread
        or the loop-gap handler sees None immediately and bails out, preventing
        duplicate idle records for the same sleep/lock period.
        """
        if self.idle_start_time is None:
            return

        # Take a local snapshot and clear IMMEDIATELY — acts as an atomic taken-flag.
        # CPython's GIL makes a plain attribute assignment atomic for this purpose.
        idle_start_snapshot = self.idle_start_time
        self.idle_start_time = None   # ← cleared here (was at the end before FIX-8)

        idle_end = datetime.now(timezone.utc)
        idle_duration = int((idle_end - idle_start_snapshot).total_seconds())
        if idle_duration < 60:
            # Skip very short idle periods (< 1 minute)
            return

        # Only record idle within configured working hours
        if not self._is_within_work_hours(idle_start_snapshot):
            print(f"[IDLE] Skipping idle record outside work hours: {idle_start_snapshot.strftime('%H:%M:%S')} ({reason})")
            return

        project_key = getattr(self, 'idle_project_key', None) or self.current_project_key or self.get_user_project_key()
        record = {
            'user_id': self.current_user_id,
            'organization_id': self.organization_id,
            'window_title': f'[Idle: {reason}]',
            'application_name': 'System',
            'classification': 'idle',
            'is_idle': True,
            # idle_start_time / idle_end_time intentionally omitted:
            # they are not columns in activity_records and their presence
            # as extra keys causes PostgREST PGRST102 ("All object keys
            # must match") when mixed with work records in the same batch.
            # start_time / end_time below capture the same information.
            'ocr_text': None,
            'ocr_method': None,
            'ocr_confidence': None,
            'ocr_error_message': None,
            'total_time_seconds': idle_duration,
            'visit_count': 1,
            'start_time': idle_start_snapshot.isoformat(),
            'end_time': idle_end.isoformat(),
            'duration_seconds': idle_duration,
            'work_date': _utc_ts_to_local_date(idle_start_snapshot.isoformat()),
            'user_timezone': get_local_timezone_name(),
            'project_key': project_key,
            'user_assigned_issues': json.dumps(self.user_issues) if self.user_issues else None,  # FIX: PGRST102
            'status': 'analyzed',  # No AI analysis needed for idle records
            'request_id': str(uuid.uuid4()),  # Unique request ID for idempotency
            'metadata': {
                'tracking_mode': 'idle_detection',
                'idle_reason': reason,
                'app_version': self.app_version
            }
        }
        self._pending_idle_records.append(record)
        print(f"[IDLE] Created idle record: {idle_start_snapshot.strftime('%H:%M:%S')} → {idle_end.strftime('%H:%M:%S')} ({idle_duration}s, reason: {reason})")

    # ------------------------------------------------------------------
    # Idle-detection backend probe
    # ------------------------------------------------------------------

    def _detect_idle_backend(self) -> str:
        """Probe available idle-detection backends and return the best one.

        Priority (highest → lowest):
            'dbus_screensaver' — org.freedesktop.ScreenSaver (GNOME/KDE, Wayland-native)
            'gnome_mutter'     — org.gnome.Mutter.IdleMonitor (GNOME Wayland-native)
            'evdev'            — /dev/input/event* raw kernel input (display-server agnostic)
            'pynput'           — X11 hooks (works on X11/XWayland; may silently fail on Wayland)
            'none'             — no backend available; idle detection disabled
        """
        # Tier 1 — D-Bus ScreenSaver
        try:
            import dbus  # noqa: F401
            bus = dbus.SessionBus()
            ss = bus.get_object('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver')
            iface = dbus.Interface(ss, 'org.freedesktop.ScreenSaver')
            iface.GetSessionIdleTime()   # probe call — will raise on failure
            return 'dbus_screensaver'
        except Exception:
            pass

        # Tier 2 — GNOME Mutter IdleMonitor
        try:
            import dbus  # noqa: F401
            bus = dbus.SessionBus()
            obj = bus.get_object('org.gnome.Mutter.IdleMonitor',
                                 '/org/gnome/Mutter/IdleMonitor/Core')
            iface = dbus.Interface(obj, 'org.gnome.Mutter.IdleMonitor')
            iface.GetIdletime()          # probe call
            return 'gnome_mutter'
        except Exception:
            pass

        # Tier 3 — evdev raw input
        import glob as _glob
        evdev_devices = _glob.glob('/dev/input/event*')
        if any(os.access(d, os.R_OK) for d in evdev_devices):
            return 'evdev'

        # Tier 4 — pynput (X11/XWayland)
        try:
            import pynput  # noqa: F401
            return 'pynput'
        except ImportError:
            pass

        return 'none'

    # ------------------------------------------------------------------
    # D-Bus idle-time poll helpers
    # ------------------------------------------------------------------

    def _poll_dbus_idle_time(self):
        """Query org.freedesktop.ScreenSaver for idle milliseconds.

        Returns idle time in milliseconds, or None on any failure.
        """
        try:
            import dbus
            bus = dbus.SessionBus()
            ss = bus.get_object('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver')
            iface = dbus.Interface(ss, 'org.freedesktop.ScreenSaver')
            return int(iface.GetSessionIdleTime())
        except Exception:
            return None

    def _poll_gnome_mutter_idle(self):
        """Query org.gnome.Mutter.IdleMonitor for idle milliseconds.

        Returns idle time in milliseconds, or None on any failure.
        """
        try:
            import dbus
            bus = dbus.SessionBus()
            obj = bus.get_object('org.gnome.Mutter.IdleMonitor',
                                 '/org/gnome/Mutter/IdleMonitor/Core')
            iface = dbus.Interface(obj, 'org.gnome.Mutter.IdleMonitor')
            return int(iface.GetIdletime())
        except Exception:
            return None

    # ------------------------------------------------------------------
    # D-Bus idle poll worker (runs in its own daemon thread)
    # ------------------------------------------------------------------

    def _dbus_idle_poll_worker(self, poll_fn):
        """Poll D-Bus idle time every IDLE_POLL_INTERVAL seconds.

        Calls poll_fn() which returns idle milliseconds (int) or None.
        Drives enter_idle / resume_from_idle via self.needs_idle_resume so
        it integrates with the existing tracking_loop state machine.
        """
        IDLE_POLL_INTERVAL = int(os.environ.get('IDLE_POLL_INTERVAL', '10'))
        was_idle = False

        print(f"[OK] D-Bus idle poll worker started (poll every {IDLE_POLL_INTERVAL}s)")

        while self.running:
            try:
                idle_ms = poll_fn()
                if idle_ms is None:
                    # D-Bus call failed — sleep and retry; fall through gracefully
                    time.sleep(IDLE_POLL_INTERVAL)
                    continue

                idle_secs = idle_ms / 1000.0
                current_timeout = self.tracking_settings.get(
                    'idle_threshold_seconds', self.idle_timeout)

                if idle_secs >= current_timeout and not was_idle:
                    # FIX-2: Skip idle entry while user has manually paused tracking.
                    if self.state == TrackingState.PAUSED:
                        time.sleep(IDLE_POLL_INTERVAL)
                        continue
                    print(f"[IDLE] D-Bus: idle {idle_secs:.0f}s ≥ timeout {current_timeout}s — entering idle")
                    self.enter_idle("idle timeout")
                    was_idle = True

                elif idle_secs < current_timeout and was_idle:
                    # Activity resumed
                    self.last_activity_time = time.time() - idle_secs
                    self.needs_idle_resume = True
                    was_idle = False
                    print(f"[IDLE] D-Bus: activity detected — idle reset to {idle_secs:.0f}s")

                else:
                    # Normal active state — keep last_activity_time current
                    self.last_activity_time = time.time() - idle_secs

            except Exception as e:
                print(f"[WARN] D-Bus idle poll error: {e}")

            time.sleep(IDLE_POLL_INTERVAL)

    # ------------------------------------------------------------------
    # evdev raw-input listener (kernel level, display-server agnostic)
    # ------------------------------------------------------------------

    def _start_evdev_listener(self, on_activity_callback):
        """Open all accessible /dev/input/event* devices and call on_activity_callback
        whenever any input event is received.  Uses only stdlib (struct, select, glob).

        Returns the daemon Thread, or None if no devices are accessible.
        """
        import glob as _glob, struct, select

        INPUT_EVENT_SIZE = struct.calcsize('llHHI')   # struct input_event layout
        devices = _glob.glob('/dev/input/event*')
        fds = []
        for path in sorted(devices):
            try:
                fds.append(open(path, 'rb'))
            except (PermissionError, OSError):
                pass   # skip devices we can't read

        if not fds:
            print('[WARN] evdev: no /dev/input/event* devices accessible')
            print('[INFO] Add user to input group: sudo usermod -aG input $USER && newgrp input')
            self.add_admin_log('WARN', 'evdev: no readable /dev/input/event* devices — check input group membership')
            return None

        print(f'[OK] evdev: monitoring {len(fds)} input device(s)')
        self._activity_listener_started = True   # evdev is self-verifying

        def reader():
            try:
                while self.running:
                    try:
                        r, _, _ = select.select(fds, [], [], 1.0)
                    except (ValueError, OSError):
                        break   # an fd was closed
                    for f in r:
                        try:
                            data = f.read(INPUT_EVENT_SIZE)
                            if data and len(data) == INPUT_EVENT_SIZE:
                                on_activity_callback()
                        except (OSError, IOError):
                            pass   # device unplugged or gone
            finally:
                for f in fds:
                    try:
                        f.close()
                    except Exception:
                        pass

        t = threading.Thread(target=reader, daemon=True, name='evdev-idle-listener')
        t.start()
        return t

    # ------------------------------------------------------------------
    # Main activity monitoring entry point (multi-tier dispatcher)
    # ------------------------------------------------------------------

    def monitor_user_activity(self):
        """Monitor user input for idle detection using the best available backend.

        Backend selection priority (auto-detected at runtime):
          Tier 1 — D-Bus ScreenSaver  (Wayland-native; GNOME / KDE)
          Tier 2 — GNOME Mutter       (Wayland-native; GNOME only)
          Tier 3 — evdev              (kernel-level; display-server agnostic)
          Tier 4 — pynput             (X11/XWayland; may silently fail on bare Wayland)
        """
        # Detect display server for logging / pynput-specific warnings
        session_type = os.environ.get('XDG_SESSION_TYPE', 'unknown')
        wayland_display = os.environ.get('WAYLAND_DISPLAY')
        is_wayland = session_type == 'wayland' or bool(wayland_display)

        print(f"[INFO] Display server detected: {session_type} (Wayland={is_wayland})")

        # Shared state for all tiers
        self._activity_listener_started = False
        self._activity_listener_error = None

        # Probe which backend to use
        backend = self._detect_idle_backend()
        self._idle_backend = backend
        print(f"[INFO] Idle detection backend selected: {backend}")

        def on_activity(*args, **kwargs):
            """Common callback — update last_activity_time and signal resume."""
            if not self._activity_listener_started:
                self._activity_listener_started = True
                print("[OK] Activity listener confirmed working")
            self.last_activity_time = time.time()
            # FIX-7 (B-2): Update pynput heartbeat so the sync-thread watchdog can
            # detect when pynput listeners have silently stopped firing callbacks.
            self._pynput_last_heartbeat = time.time()
            if self.is_idle:
                self.needs_idle_resume = True

        # ---- Tier 1 & 2: D-Bus poll backends ----
        if backend in ('dbus_screensaver', 'gnome_mutter'):
            poll_fn = (self._poll_dbus_idle_time
                       if backend == 'dbus_screensaver'
                       else self._poll_gnome_mutter_idle)
            self._activity_listener_started = True   # poll-based; always "working"
            self.add_admin_log('INFO', f'Idle detection using D-Bus backend: {backend}')
            t = threading.Thread(
                target=self._dbus_idle_poll_worker,
                args=(poll_fn,),
                daemon=True,
                name=f'idle-dbus-{backend}',
            )
            t.start()
            print(f"[OK] Activity monitoring started via {backend} (5-minute idle timeout)")
            return

        # ---- Tier 3: evdev ----
        if backend == 'evdev':
            self.add_admin_log('INFO', 'Idle detection using evdev backend')
            self._start_evdev_listener(on_activity)
            print("[OK] Activity monitoring started via evdev (5-minute idle timeout)")
            return

        # ---- Tier 4: pynput (X11 / XWayland) ----
        if backend == 'pynput':
            try:
                from pynput import mouse, keyboard
            except ImportError:
                print("[ERROR] pynput not installed — idle detection DISABLED")
                print("[INFO] Install with: pip3 install pynput")
                self.add_admin_log('ERROR', 'pynput not installed — idle detection disabled')
                self._idle_backend = 'none'
                return

            try:
                mouse_listener = mouse.Listener(
                    on_move=on_activity,
                    on_click=on_activity,
                    on_scroll=on_activity,
                )
                mouse_listener.start()

                keyboard_listener = keyboard.Listener(on_press=on_activity)
                keyboard_listener.start()

                print("[OK] Activity monitoring started via pynput (5-minute idle timeout)")

                if is_wayland:
                    print("[WARN] Running on Wayland — pynput may require XWayland for global input monitoring")
                    print("[INFO] If idle detection fails, verify XWayland is running: ps aux | grep Xwayland")

                # Verify listeners actually fire after 5 seconds.
                # Silent failures are common on Wayland without XWayland.
                def verify_listener():
                    time.sleep(5)
                    if not self._activity_listener_started:
                        print("[ERROR] Activity listener NOT receiving events after 5s — idle detection may be broken")
                        if is_wayland:
                            print("[HELP] Wayland detected — D-Bus or evdev backend may be needed.")
                            print("[HELP]   • Install python-dbus for automatic Wayland support")
                            print("[HELP]   • Or add user to input group: sudo usermod -aG input $USER")
                            print("[HELP]   • Or ensure XWayland is running: ps aux | grep Xwayland")
                        self.add_admin_log(
                            'WARN',
                            'pynput not receiving events — consider installing python-dbus or adding user to input group for reliable Wayland idle detection'
                        )

                threading.Thread(target=verify_listener, daemon=True, name='pynput-verify').start()
                self.add_admin_log('INFO', 'Idle detection using pynput backend')

            except Exception as e:
                print(f"[ERROR] Failed to start pynput listeners: {e}")
                traceback.print_exc()
                self._activity_listener_error = str(e)
                self._idle_backend = 'none'
                self.add_admin_log('ERROR', f'Activity listener failed to start: {e}')
            return

        # ---- No backend available ----
        print("[ERROR] No idle detection backend available — idle detection DISABLED")
        print("[INFO] Options to enable idle detection:")
        print("[INFO]   • Install python-dbus (recommended for Wayland)")
        print("[INFO]   • Add user to input group: sudo usermod -aG input $USER")
        print("[INFO]   • Install pynput and ensure XWayland is running")
        self.add_admin_log('ERROR', 'No idle detection backend available — idle detection disabled')

    def get_activity_monitoring_status(self):
        """Return diagnostic info about activity monitoring health (for troubleshooting idle detection)"""
        import glob as _glob
        status = {
            'idle_backend': getattr(self, '_idle_backend', 'unknown'),
            'pynput_available': False,
            'listener_started': getattr(self, '_activity_listener_started', False),
            'listener_error': getattr(self, '_activity_listener_error', None),
            'last_activity_ago_seconds': int(time.time() - self.last_activity_time),
            'is_idle': self.is_idle,
            'display_server': os.environ.get('XDG_SESSION_TYPE', 'unknown'),
            'wayland_display': os.environ.get('WAYLAND_DISPLAY'),
            'xwayland_running': False,
            'dbus_available': False,
            'evdev_devices_accessible': 0,
        }
        try:
            import pynput
            status['pynput_available'] = True
            status['pynput_version'] = getattr(pynput, '__version__', 'unknown')
        except ImportError:
            pass
        try:
            result = subprocess.run(['pgrep', '-x', 'Xwayland'], capture_output=True, timeout=2)
            status['xwayland_running'] = (result.returncode == 0)
        except Exception:
            pass
        try:
            import dbus  # noqa: F401
            status['dbus_available'] = True
        except ImportError:
            pass
        evdev_devices = _glob.glob('/dev/input/event*')
        status['evdev_devices_accessible'] = sum(1 for d in evdev_devices if os.access(d, os.R_OK))
        return status

    def show_diagnostic_info(self):
        """Print and notify activity monitoring diagnostics (can be exposed via tray menu)"""
        status = self.get_activity_monitoring_status()
        lines = [
            "=== Activity Monitoring Status ===",
            f"Idle backend:    {status['idle_backend']}",
            f"Listener active: {status['listener_started']}",
            f"Listener error:  {status['listener_error'] or 'None'}",
            f"Display server:  {status['display_server']}",
            f"Wayland active:  {status['wayland_display'] or 'No'}",
            f"XWayland running:{status['xwayland_running']}",
            f"D-Bus available: {status['dbus_available']}",
            f"evdev devices:   {status['evdev_devices_accessible']} accessible",
            f"pynput installed:{status['pynput_available']}",
            "",
            f"Last activity: {status['last_activity_ago_seconds']}s ago",
            f"Currently idle: {status['is_idle']}",
            "",
            "=== Authentication ===",
            f"Authenticated: {self.auth_manager.is_authenticated()}",
            f"User: {self.current_user.get('email') if self.current_user else 'Not logged in'}",
        ]
        for line in lines:
            print(line)
        _linux_notify("TimeTracker Diagnostics", "\n".join(lines[:12]))

    def monitor_system_events(self):
        """Monitor Windows sleep/lock events to instantly detect inactivity.
        Runs on a daemon thread. Uses a message-only window to receive
        WM_POWERBROADCAST (sleep/wake) and WM_WTSSESSION_CHANGE (lock/unlock)."""
        try:
            import ctypes
            from ctypes import wintypes
        except Exception as e:
            print(f"[WARN] ctypes not available — system event monitoring disabled: {e}")
            return

        try:
            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32
            wtsapi32 = ctypes.windll.wtsapi32

            # Window message constants
            WM_POWERBROADCAST = 0x0218
            PBT_APMSUSPEND = 0x0004
            PBT_APMRESUMEAUTOMATIC = 0x0012
            WM_WTSSESSION_CHANGE = 0x02B1
            WTS_SESSION_LOCK = 0x7
            WTS_SESSION_UNLOCK = 0x8
            HWND_MESSAGE = wintypes.HWND(-3)
            NOTIFY_FOR_THIS_SESSION = 0

            # On 64-bit Windows, LRESULT/WPARAM/LPARAM are 64-bit.
            # ctypes.c_long is only 32-bit on Windows, causing overflow errors.
            LRESULT = ctypes.c_longlong

            # Set proper arg/return types for DefWindowProcW to avoid overflow
            user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            user32.DefWindowProcW.restype = LRESULT

            WNDPROC = ctypes.WINFUNCTYPE(
                LRESULT,             # LRESULT (64-bit on x64)
                wintypes.HWND,       # hWnd
                wintypes.UINT,       # uMsg
                wintypes.WPARAM,     # wParam
                wintypes.LPARAM,     # lParam
            )

            def wnd_proc(hwnd, msg, wparam, lparam):
                try:
                    if msg == WM_POWERBROADCAST:
                        if wparam == PBT_APMSUSPEND:
                            print("[INFO] System sleep detected — entering idle state")
                            self.enter_idle("system sleep")
                        elif wparam == PBT_APMRESUMEAUTOMATIC:
                            print("[INFO] System wake detected — will resume tracking on activity")
                            self._create_idle_record("system sleep")
                            self.needs_idle_resume = True
                    elif msg == WM_WTSSESSION_CHANGE:
                        if wparam == WTS_SESSION_LOCK:
                            print("[INFO] Screen lock detected — entering idle state")
                            self.enter_idle("screen lock")
                        elif wparam == WTS_SESSION_UNLOCK:
                            print("[INFO] Screen unlock detected — will resume tracking on activity")
                            self._create_idle_record("screen lock")
                            self.needs_idle_resume = True
                except Exception as e:
                    print(f"[ERROR] Error in system event handler: {e}")
                return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

            # Store callback on self to prevent garbage collection while window is alive
            self._wndproc_callback = WNDPROC(wnd_proc)

            class WNDCLASSEXW(ctypes.Structure):
                _fields_ = [
                    ("cbSize", wintypes.UINT),
                    ("style", wintypes.UINT),
                    ("lpfnWndProc", WNDPROC),
                    ("cbClsExtra", ctypes.c_int),
                    ("cbWndExtra", ctypes.c_int),
                    ("hInstance", wintypes.HINSTANCE),
                    ("hIcon", wintypes.HANDLE),
                    ("hCursor", wintypes.HANDLE),
                    ("hbrBackground", wintypes.HANDLE),
                    ("lpszMenuName", wintypes.LPCWSTR),
                    ("lpszClassName", wintypes.LPCWSTR),
                    ("hIconSm", wintypes.HANDLE),
                ]

            wc = WNDCLASSEXW()
            wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
            wc.lpfnWndProc = self._wndproc_callback
            wc.hInstance = kernel32.GetModuleHandleW(None)
            wc.lpszClassName = "JIRAForgeSysEventWnd"

            atom = user32.RegisterClassExW(ctypes.byref(wc))
            if not atom:
                print("[ERROR] Failed to register window class for system event monitoring")
                return

            hwnd = user32.CreateWindowExW(
                0, wc.lpszClassName, "JIRAForge System Event Monitor",
                0, 0, 0, 0, 0,
                HWND_MESSAGE, None, wc.hInstance, None
            )
            if not hwnd:
                print("[ERROR] Failed to create message-only window for system event monitoring")
                return

            # Store hwnd for potential cleanup
            self._system_event_hwnd = hwnd

            # Register for session notifications (lock/unlock)
            try:
                if not wtsapi32.WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION):
                    print("[WARN] WTSRegisterSessionNotification failed — lock/unlock detection disabled")
                    print("[INFO] Sleep/wake detection is still active")
            except Exception as e:
                print(f"[WARN] Could not register for session notifications: {e}")
                print("[INFO] Sleep/wake detection is still active")

            print("[OK] System event monitoring started (sleep/wake, lock/unlock)")

            # Message pump
            msg = wintypes.MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))

        except Exception as e:
            print(f"[WARN] System event monitoring failed to start: {e}")
            print("[INFO] Idle detection will still work via activity timeout")

    def sync_offline_data(self, force=False):
        """Sync offline data to Supabase when online
        
        Args:
            force: If True, sync immediately regardless of interval
        
        Returns:
            tuple: (synced_count, failed_count) or None if not syncing
        """
        current_time = time.time()
        
        # Check sync interval (unless forced)
        if not force and (current_time - self._last_sync_time) < self._sync_interval:
            return None
        
        # Check connectivity
        if not self.offline_manager.check_connectivity():
            return None

        # Ensure Supabase JWT is valid before flushing offline queue
        # (laptop may have been asleep for days — JWT could be expired)
        sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
        if sb_expires_at and time.time() > (sb_expires_at - 300):
            print("[INFO] Supabase JWT expired — refreshing before offline sync...")
            if not self._set_supabase_jwt():
                print("[WARN] Cannot sync offline data: Supabase JWT refresh failed")
                return None

        # Check if there's anything to sync
        pending_count = self.offline_manager.get_pending_count()
        if pending_count == 0:
            return None

        print(f"[INFO] Network online - syncing {pending_count} offline screenshots...")
        self.add_admin_log('INFO', f'Syncing {pending_count} offline screenshots...')

        # Get the client (uses anon key + custom JWT, RLS enforced)
        db_client = self.supabase
        storage_client = self.supabase

        # Perform sync
        result = self.offline_manager.sync_all(db_client, storage_client)

        self._last_sync_time = current_time

        if result:
            synced, failed = result
            if synced > 0 or failed > 0:
                self.add_admin_log('INFO', f'Sync complete: {synced} synced, {failed} failed')

        return result

    def start_sync_thread(self):
        """Start background thread for periodic offline sync, heartbeat, and token refresh"""
        def sync_worker():
            heartbeat_counter = 0
            heartbeat_interval = 480  # Send heartbeat every 480 iterations (4 hours at 30s interval)
            token_refresh_counter = 0
            token_refresh_interval = 10  # Check token expiry every 10 iterations (~5 min at 30s interval)
            supabase_reinit_counter = 0
            supabase_reinit_interval = 60  # Retry Supabase init every 30 min (60 × 30s) if it failed at startup
            thread_check_counter = 0   # FIX-10: tracking-thread watchdog counter
            pynput_check_counter = 0   # FIX-7 (B-2): pynput heartbeat watchdog counter

            # Send initial heartbeat immediately on thread start
            if self.current_user_id and not self.current_user_id.startswith('anonymous_'):
                try:
                    self._send_heartbeat()
                except Exception as e:
                    print(f"[WARN] Initial heartbeat failed: {e}")

            while self.running:
                try:
                    # Background Supabase re-initialization: if initialize_supabase() failed at
                    # startup (e.g. AI server was briefly unavailable), retry every 30 minutes
                    # so the session can self-heal without requiring a manual re-login or reboot.
                    if not self.supabase_initialized and self.auth_manager.is_authenticated():
                        supabase_reinit_counter += 1
                        if supabase_reinit_counter >= supabase_reinit_interval:
                            supabase_reinit_counter = 0
                            print("[INFO] Supabase not initialized — attempting background re-initialization...")
                            try:
                                if self.initialize_supabase():
                                    print("[OK] Supabase re-initialized successfully in background")
                                    # Push version + logged-in status now that DB is reachable
                                    if self.current_user_id and not self.current_user_id.startswith('anonymous_'):
                                        try:
                                            self._update_desktop_status(logged_in=True)
                                            # Reset the heartbeat counter so the next regular heartbeat
                                            # fires 4h from NOW (the reinit recovery point), not 4h from
                                            # thread start. Without this, the DB looks stale again within
                                            # 1h of the recovery (heartbeat_counter already at ~60).
                                            heartbeat_counter = 0
                                        except Exception as ds_err:
                                            print(f"[WARN] Could not update desktop status after re-init: {ds_err}")
                            except Exception as ri_err:
                                print(f"[WARN] Background Supabase re-init failed: {ri_err}")
                    else:
                        supabase_reinit_counter = 0  # Reset counter once initialized

                    # Sync offline data only when tracking is active
                    if self.tracking_active and self.current_user_id:
                        self.sync_offline_data()

                    # Heartbeat should always be sent when user is logged in,
                    # regardless of tracking state (app is still running even if paused)
                    if self.current_user_id and not self.current_user_id.startswith('anonymous_'):
                        heartbeat_counter += 1
                        if heartbeat_counter >= heartbeat_interval:
                            self._send_heartbeat()
                            heartbeat_counter = 0

                    # Proactive token refresh: check if access token is near expiry
                    # and refresh it BEFORE it expires, so API calls never hit a 401.
                    if self.auth_manager.is_authenticated():
                        token_refresh_counter += 1
                        if token_refresh_counter >= token_refresh_interval:
                            token_refresh_counter = 0
                            expires_at = self.auth_manager.tokens.get('expires_at', 0)
                            # Refresh Atlassian token if near expiry (5-minute buffer)
                            if expires_at and time.time() > (expires_at - 300):
                                print("[INFO] Access token nearing expiry, refreshing proactively...")
                                if self.auth_manager.refresh_access_token():
                                    print("[OK] Proactive token refresh successful")
                                else:
                                    print("[WARN] Proactive token refresh failed — will retry on next cycle")
                                    last_error_code = getattr(self.auth_manager, '_last_refresh_error_code', '')
                                    if str(last_error_code).upper() == 'OAUTH_TEMPORARY_FAILURE':
                                        self._show_reauth_notification(last_error_code)

                            # Refresh Supabase JWT if near expiry (5-minute buffer)
                            # Uses the (possibly freshly refreshed) Atlassian token to get a new JWT
                            sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
                            if sb_expires_at and time.time() > (sb_expires_at - 300):
                                print("[INFO] Supabase JWT nearing expiry, refreshing proactively...")
                                if self._set_supabase_jwt():
                                    print("[OK] Supabase JWT refresh successful")
                                else:
                                    print("[WARN] Supabase JWT refresh failed — will retry on next cycle")

                    elif getattr(self.auth_manager, '_refresh_token_invalid', False):
                        # Refresh token is marked invalid — check if grace period allows retry
                        grace_period = 1800  # 30 minutes
                        invalid_since = getattr(self.auth_manager, '_refresh_invalid_set_at', 0)
                        if invalid_since and (time.time() - invalid_since) >= grace_period:
                            print("[INFO] Sync thread: invalid flag grace period expired — attempting recovery refresh")
                            self.auth_manager._refresh_token_invalid = False
                            self.auth_manager._refresh_fail_count = 0
                            self.auth_manager._refresh_invalid_set_at = 0
                            if self.auth_manager.refresh_access_token():
                                print("[OK] Session recovered automatically after grace period")
                            else:
                                print("[WARN] Recovery refresh failed — will show re-auth notification")
                                self._show_reauth_notification(getattr(self.auth_manager, '_last_refresh_error_code', None))
                        else:
                            self._show_reauth_notification(getattr(self.auth_manager, '_last_refresh_error_code', None))

                except Exception as e:
                    print(f"[ERROR] Sync thread error: {e}")

                # ── FIX-10 (B-14): Tracking thread watchdog ──────────────────────────
                # Check every 60 s (every 2 iterations at 30s sleep).
                # Only restart if self.running AND tracking_active are both True —
                # a legitimate stop_tracking() sets running=False first so this guard
                # will NOT fire during normal shutdown.
                thread_check_counter += 1
                if thread_check_counter >= 2:
                    thread_check_counter = 0
                    if (self.running and
                            self.tracking_active and
                            self._tracking_thread is not None and
                            not self._tracking_thread.is_alive()):
                        print("[WARN] FIX-10: Tracking thread died unexpectedly — restarting")
                        self.add_admin_log('WARNING', 'Tracking thread restarted by watchdog (FIX-10)')
                        try:
                            self._tracking_thread = threading.Thread(
                                target=self.tracking_loop, daemon=True, name='tracking-loop-watchdog'
                            )
                            self._tracking_thread.start()
                        except Exception as _wdog_err:
                            print(f"[ERROR] FIX-10: Watchdog failed to restart tracking thread: {_wdog_err}")
                # ── end FIX-10 ────────────────────────────────────────────────────────

                # ── FIX-7 (B-2): pynput heartbeat watchdog ───────────────────────────
                # If pynput is the idle-detection backend but its listeners have silently
                # stopped firing (common after UAC / RDP switch / display driver change),
                # restart the activity monitor thread every 2 minutes of stale heartbeat.
                pynput_check_counter += 1
                if pynput_check_counter >= 4:   # every ~2 min (4 × 30s)
                    pynput_check_counter = 0
                    _backend = getattr(self, '_idle_backend', 'none')
                    if _backend == 'pynput' and self.tracking_active and not self.is_idle:
                        _last_hb = getattr(self, '_pynput_last_heartbeat', 0)
                        if _last_hb and (time.time() - _last_hb) > 300:  # 5 min no events
                            print("[WARN] FIX-7: pynput heartbeat stale — restarting activity monitor thread")
                            self.add_admin_log('WARN', 'pynput heartbeat stale — activity monitor restarted (FIX-7)')
                            try:
                                if not self._activity_monitor_thread or not self._activity_monitor_thread.is_alive():
                                    self._activity_monitor_thread = threading.Thread(
                                        target=self.monitor_user_activity, daemon=True, name='activity-monitor-watchdog'
                                    )
                                    self._activity_monitor_thread.start()
                            except Exception as _pw_err:
                                print(f"[ERROR] FIX-7: Could not restart activity monitor: {_pw_err}")
                # ── end FIX-7 ────────────────────────────────────────────────────────

                # Check every 30 seconds
                time.sleep(30)

        self._sync_thread = threading.Thread(target=sync_worker, daemon=True)
        self._sync_thread.start()
        print("[OK] Offline sync and heartbeat background thread started")

    def tracking_loop(self):
        """Main tracking loop with idle detection and event-based window switch capture"""
        # Detect current project and fetch initial tracking settings from Supabase
        self.update_current_project()
        project_key = self.current_project_key
        self.fetch_tracking_settings(project_key=project_key)
        
        # Tracking mode is enforced as event-only.
        print("[OK] Tracking started (event-only mode)")
        
        # Track last screenshot time to prevent too frequent captures (for window switches)
        last_screenshot_time = 0
        min_screenshot_interval = 10  # Minimum 10 seconds between window switch screenshots
        
        # Track time for refreshing settings
        last_settings_refresh = time.time()
        settings_refresh_interval = 300  # Refresh settings every 5 minutes

        # Track time for classification sync
        last_classification_sync = time.time()
        classification_sync_interval = 1800  # Sync classifications every 30 minutes

        # Track time for notification checks
        last_notification_check = 0
        notification_check_interval = 1800  # Check every 30 minutes
        
        # Initialize interval timer on first run
        # The interval timer is FIXED - only resets on interval captures, not window switches
        if self.last_interval_time is None:
            self.last_interval_time = time.time()

        # Track loop timing for suspension detection
        last_loop_time = time.time()

        while self.running:
            try:
                current_loop_time = time.time()

                # === Detect system suspension/resume ===
                # If the loop iteration took much longer than expected (we sleep 2-5s),
                # the system was likely suspended (sleep/hibernate).
                time_since_last_loop = current_loop_time - last_loop_time
                if time_since_last_loop > 30:  # 30s threshold (loop normally runs every 2-5s)
                    print(f"[INFO] Large time gap detected: {int(time_since_last_loop)}s — system was likely suspended")
                    # Finalize current session using last known activity time
                    self._finalize_active_session("system suspension detected")
                    self.session_manager.stop_current_timer()  # Stop SQLite activity timer so suspension time isn't counted in activity_records

                    # If we were idle when suspension happened, create the idle record NOW
                    # before resetting state — otherwise the idle period is silently lost.
                    # The system event monitor (PBT_APMRESUMEAUTOMATIC) may also create one,
                    # but if it hasn't fired yet, this ensures we don't lose the idle period.
                    if self.is_idle and self.idle_start_time:
                        self._create_idle_record("system suspension detected")

                    # Upload accumulated data before resetting state to prevent data loss
                    try:
                        self.upload_activity_batch()
                    except Exception as e:
                        print(f"[WARN] Suspension batch upload failed: {e} — data remains in SQLite for next cycle")
                    # Check if screen is still locked before resuming tracking.
                    # When a PC briefly wakes from sleep (Windows Update, network, etc.)
                    # but the screen is still locked, we must stay in idle mode to avoid
                    # tracking LockApp.exe as active work time.
                    if self._is_screen_locked():
                        print(f"[INFO] Screen still locked after suspension — entering idle state")
                        self.enter_idle("screen still locked after suspension")
                        self.needs_idle_resume = False
                        self.current_window_key = None
                        last_loop_time = current_loop_time
                        continue

                    # Reset ALL tracking state — new session starts fresh
                    if self.resume_from_idle():
                        print(f"[INFO] Resumed from suspension — tracking state reset")
                    self.needs_idle_resume = False
                    self.last_interval_time = current_loop_time
                    self.last_activity_time = current_loop_time
                    last_loop_time = current_loop_time
                    self.add_admin_log('INFO', f'System suspension detected ({int(time_since_last_loop)}s gap) — session finalized and uploaded')
                    continue
                last_loop_time = current_loop_time
                # === END suspension detection ===

                # Check for shutdown signal (for graceful update/exit)
                if check_for_shutdown_signal():
                    print("[INFO] Shutdown signal received - closing for update...")
                    self.running = False
                    self.quit_app()
                    break

                self._enforce_mandatory_update_pause()

                if not self.tracking_active:
                    # Check for auto-resume (timed pause expired)
                    if self.pause_end_time and time.time() >= self.pause_end_time:
                        print("[INFO] Timed pause expired - auto-resuming")
                        self.resume_tracking(show_notification=True)
                        self.add_admin_log('INFO', 'Tracking auto-resumed after timed pause')
                        continue

                    # Check if it's time to show popup again (periodic reappearance)
                    current_time = time.time()
                    if self.next_popup_show_time and current_time >= self.next_popup_show_time:
                        # Only show if popup is not already open
                        if not self.pause_popup or not (self.pause_popup.running and self.pause_popup.window):
                            print(f"[INFO] Showing pause popup again (interval {self.popup_show_count + 1}/4)")
                            self._show_pause_popup()
                            # Reset next show time (will be recalculated when popup is closed)
                            self.next_popup_show_time = None

                    # Check for pause reminder while paused
                    if self.pause_start_time and self.pause_reminder_enabled:
                        time_since_last_reminder = time.time() - self.last_pause_reminder_time

                        # Send reminder every pause_reminder_interval (30 min) while paused
                        if time_since_last_reminder >= self.pause_reminder_interval:
                            self.show_pause_reminder_notification()

                    time.sleep(1)
                    continue

                # Skip periodic checks while idle — no need to hit APIs when user is away
                if not self.is_idle:
                    # Periodically refresh tracking settings from Supabase
                    # Also check if user switched projects (e.g., from issue reassignment)
                    if time.time() - last_settings_refresh > settings_refresh_interval:
                        # Check if project changed (automatically reloads settings if it did)
                        project_changed = self.update_current_project()
                        
                        # Refresh settings even if project didn't change (settings might have been updated)
                        if not project_changed:
                            self.fetch_tracking_settings(project_key=self.current_project_key)
                        
                        last_settings_refresh = time.time()

                    # Periodically sync app classifications from Supabase
                    if time.time() - last_classification_sync > classification_sync_interval:
                        try:
                            client = self.supabase
                            self.classification_manager.sync_classifications(
                                client, self.organization_id, self.current_project_key,
                                all_project_keys=list(self._get_known_project_keys())
                            )
                        except Exception as e:
                            print(f"[WARN] Periodic classification sync failed: {e}")
                        last_classification_sync = time.time()

                    # Periodically check for unassigned work and send notifications
                    if time.time() - last_notification_check > notification_check_interval:
                        self.check_and_notify_unassigned_work()
                        last_notification_check = time.time()

                    # Periodically upload activity batch (event-based tracking)
                    if time.time() - self.last_batch_upload_time >= self.batch_upload_interval:
                        self.upload_activity_batch()
                
                # Check for app updates OUTSIDE idle block (every 4 hours by default, or 30 min if last download failed)
                # Update check and download happen in background, installation waits for user to be active
                should_check_normal = time.time() - self.last_version_check_time > self.version_check_interval
                should_retry_download = self.update_manager and self.update_manager.should_retry_download()
                
                if should_check_normal:
                    self.check_for_app_updates(show_notification=True)
                elif should_retry_download:
                    # force=True is required here — without it, check_for_app_updates returns
                    # cached info early because the 4-hour cooldown hasn't elapsed yet (only 30 min has)
                    print("[INFO] Retrying failed update download (30-minute retry interval)...")
                    self.check_for_app_updates(show_notification=True, force=True)
                
                # Check for idle timeout (use configurable threshold)
                idle_duration = time.time() - self.last_activity_time
                current_idle_timeout = self.tracking_settings.get('idle_threshold_seconds', self.idle_timeout)
                if idle_duration > current_idle_timeout:
                    if self.state == TrackingState.ACTIVE:
                        # Verify idle before entering: if a screenshot was taken recently (within the
                        # idle window), the user was likely active but pynput failed to register it.
                        # This is the primary symptom of broken input monitoring on Wayland.
                        time_since_last_shot = time.time() - last_screenshot_time
                        if time_since_last_shot < current_idle_timeout:
                            print(f"[INFO] Idle timeout ({int(idle_duration)}s) suppressed — screenshot {int(time_since_last_shot)}s ago suggests pynput may not be detecting activity")
                            self.last_activity_time = time.time()  # Reset to prevent immediate re-check
                        else:
                            idle_start_time = datetime.now(timezone.utc)
                            last_activity = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
                            print(f"[INFO] Idle timeout ({int(idle_duration)}s) — entering idle state")

                            # Use state machine instead of direct assignment
                            self.enter_idle("idle timeout")

                            # Upload accumulated data before entering idle
                            try:
                                self.upload_activity_batch()
                            except Exception as e:
                                print(f"[WARN] Pre-idle batch upload failed: {e}")

                    # While idle, check every 5 seconds for activity
                    # Don't skip if needs_idle_resume is set - we need to process the resume
                    # FIX-7 (B-1): Secondary resume path — if last_activity_time advanced since
                    # we entered idle (e.g. a window switch updated it while pynput was silent),
                    # treat that as user activity even if pynput never set needs_idle_resume.
                    if not self.needs_idle_resume:
                        _idle_entry = getattr(self, '_idle_entry_time', self.last_activity_time)
                        if self.last_activity_time > _idle_entry + 1:
                            print("[INFO] Idle fallback: last_activity_time advanced since idle entry — resuming (pynput fallback)")
                            self.needs_idle_resume = True
                        else:
                            time.sleep(5)
                            continue

                # Resume from idle if activity was detected by pynput
                if self.needs_idle_resume:
                    resume_time = datetime.now(timezone.utc)
                    print(f"[INFO] Activity detected — resuming from idle")
                    
                    # Use state machine instead of direct assignment
                    if self.resume_from_idle():
                        # Immediately flush idle records to database
                        if self._pending_idle_records:
                            try:
                                print(f"[IDLE] Flushing {len(self._pending_idle_records)} idle record(s)...")
                                self.upload_activity_batch()
                            except Exception as e:
                                print(f"[WARN] Idle record flush failed: {e}")
                    
                    # Clear the resume flag regardless of whether resume succeeded
                    self.needs_idle_resume = False

                # Guard: if screen is locked (e.g., PC woke briefly from sleep but user
                # hasn't unlocked), re-enter idle mode instead of tracking LockApp.exe.
                if self._is_screen_locked():
                    if self.state == TrackingState.ACTIVE:
                        print(f"[INFO] Screen locked — entering idle state")
                        self.enter_idle("screen still locked")
                    time.sleep(5)
                    continue

                # Check for window switches more frequently (every 2 seconds)
                # This allows us to capture screenshots immediately on window switch
                window_info = self.get_active_window()
                current_time = time.time()
                
                # Get current capture interval from settings
                current_capture_interval = self.tracking_settings.get('screenshot_interval_seconds', self.capture_interval)
                
                # Check if current app should be tracked for screenshots
                app_name = window_info.get('app', '')
                window_title = window_info.get('title', '')
                should_skip, skip_reason = self.should_skip_screenshot(app_name, window_title)
                
                if should_skip:
                    if skip_reason in ('private_app', 'non_productive_app'):
                        if not hasattr(self, '_last_skip_log') or time.time() - self._last_skip_log > 60:
                            print(f"[SKIP] {skip_reason}: {app_name}")
                            self._last_skip_log = time.time()
                
                # Determine work type based on productive/non-productive classification
                work_type = self.get_app_work_type(app_name, window_title)
                window_info['work_type'] = work_type
                window_info['is_non_productive'] = self.is_app_non_productive(app_name, window_title)
                
                # Check if window switched
                window_switched = window_info.get('is_new_window', False)
                time_since_last_screenshot = current_time - last_screenshot_time

                # IMPORTANT: Always update the previous window record when switching, regardless of interval
                # The interval check only applies to creating NEW screenshots, not updating existing ones
                if window_switched:
                    # Update last_activity_time as a fallback when pynput fails (e.g., on Wayland).
                    # A window switch is definitive proof the user is active at the keyboard.
                    self.last_activity_time = time.time()
                    if self.is_idle:
                        print("[INFO] Window switch detected while idle — triggering resume (pynput fallback)")
                        self.needs_idle_resume = True

                    # ALWAYS process window events for activity tracking (creates sessions in active_sessions table)
                    # Activity records (session-based tracking) should work regardless of screenshot capture mode
                    # The tracking_mode/event_tracking_enabled settings control SCREENSHOT capture timing,
                    # not activity record creation. Activity records are batched and uploaded every 5 minutes.
                    self.process_window_event(window_info)
                    
                    # Update existing record of previous window with actual time spent
                    # This ensures we update the screenshot record with the actual duration
                    # Only update if there's actually a screenshot ID to update
                    if (self.previous_window_key is not None and
                        self.previous_window_db_start_time is not None and
                        self.previous_window_screenshot_id is not None):  # Only update if screenshot exists
                        # IMPORTANT: Capture timestamp BEFORE any operations
                        # This exact timestamp will be used for both:
                        # 1. Previous record's end_time
                        # 2. Next record's start_time (via last_screenshot_end_time)
                        # This ensures PERFECT continuity with NO gaps or overlaps
                        end_time = datetime.now(timezone.utc)

                        # Set last_screenshot_end_time IMMEDIATELY so upload_screenshot uses this exact value
                        self.last_screenshot_end_time = end_time

                        # Use the ACTUAL start_time from database for accurate duration calculation
                        # This ensures log output matches what's stored in the database
                        duration_seconds = int((end_time - self.previous_window_db_start_time).total_seconds())

                        # Sanity check: cap duration to prevent inflated records after suspension
                        max_duration = max(current_capture_interval * 2, 600)
                        if duration_seconds > max_duration:
                            print(f"[WARN] Record duration {duration_seconds}s exceeds max {max_duration}s — capping")
                            duration_seconds = max_duration
                            end_time = self.previous_window_db_start_time + timedelta(seconds=duration_seconds)
                            self.last_screenshot_end_time = end_time

                        # Ensure minimum duration of 1 second
                        if duration_seconds < 1:
                            duration_seconds = 1
                            end_time = self.previous_window_db_start_time + timedelta(seconds=1)
                            self.last_screenshot_end_time = end_time  # Update with adjusted time

                        try:
                            # Update the existing record in database
                            # IMPORTANT: Only update end_time, timestamp, and duration
                            # Do NOT update start_time - it should remain as originally set
                            db_client = self.supabase
                            update_result = db_client.table('screenshots').update({
                                'end_time': end_time.isoformat(),
                                'timestamp': end_time.isoformat(),
                                'duration_seconds': duration_seconds
                            }).eq('id', self.previous_window_screenshot_id).execute()

                            if update_result.data:
                                print(f"[OK] Updated previous window record (window switch):")
                                print(f"     - Record ID: {self.previous_window_screenshot_id}")
                                print(f"     - Start: {self.previous_window_db_start_time.strftime('%H:%M:%S')} (from DB)")
                                print(f"     - End:   {end_time.strftime('%H:%M:%S')}")
                                print(f"     - Duration: {duration_seconds}s")
                            else:
                                print(f"[WARN] Failed to update previous window record")
                        except Exception as e:
                            print(f"[ERROR] Error updating previous window record: {e}")

                        # Reset previous window info after updating
                        self.previous_window_info = None
                        self.previous_window_screenshot_id = None
                        self.previous_window_db_start_time = None
                    else:
                        # No previous screenshot to update
                        # IMPORTANT: Only set last_screenshot_end_time if it's not already set
                        # This maintains continuity from the last actual screenshot's end_time
                        # If we always reset to now(), we'd create gaps when window switches are
                        # skipped due to min_screenshot_interval cooldown
                        if self.last_screenshot_end_time is None:
                            self.last_screenshot_end_time = datetime.now(timezone.utc)

                # Decide whether to capture a new screenshot
                should_capture = False
                capture_reason = "window_switch"
                
                # Event mode: capture only on window switch (no interval-based capture).
                event_tracking_enabled = self.tracking_settings.get('event_tracking_enabled', False)
                tracking_mode = self.tracking_settings.get('tracking_mode', 'interval')
                
                if window_switched and time_since_last_screenshot >= min_screenshot_interval:
                    if event_tracking_enabled or tracking_mode == 'event':
                        should_capture = True
                
                if should_capture and not self.is_idle:
                    if not should_skip:
                        screenshot = self.capture_screenshot()
                        if screenshot:
                            self.upload_screenshot(screenshot, window_info)

                            last_screenshot_time = time.time()
                            print(f"[OK] Screenshot captured ({capture_reason})")
                
                # Sleep for shorter interval to check for window switches more frequently
                # But still respect the minimum screenshot interval
                sleep_time = min(2, min_screenshot_interval)  # Check every 2 seconds
                time.sleep(sleep_time)

            except Exception as e:
                print(f"[ERROR] Tracking loop error: {e}")
                traceback.print_exc()
                time.sleep(5)
    
    def start_tracking(self):
        """Start screenshot tracking with idle detection"""
        if self.running:
            return

        if not self.current_user_id:
            print("[WARN] Cannot start tracking - no user ID (authenticated or anonymous)")
            return

        # GDPR compliance: Verify consent before starting (defensive check)
        # Skip consent check for anonymous users (they'll provide consent on login)
        if self.current_user and not self.current_user_id.startswith('anonymous_'):
            user_account_id = self.current_user.get('account_id')
            if not self.consent_manager.has_valid_consent(user_account_id):
                print("[WARN] Cannot start tracking - user has not given consent for screenshot capture")
                print("[INFO] User must visit /consent page to provide consent")
                return
        
        # Log if we're in anonymous mode
        if self.current_user_id.startswith('anonymous_'):
            print("[INFO] Starting tracking in ANONYMOUS mode")
            print("[INFO] Screenshots will be saved locally and associated when you login")

        self.running = True
        self.tracking_active = True
        self.state = TrackingState.ACTIVE
        self.is_idle = False  # Keep boolean flag in sync
        self.last_activity_time = time.time()  # Reset activity time
        
        # Initialize window tracking for event-based tracking
        self.current_window_key = None
        self.current_window_start_time = None
        self.current_window_db_start_time = None
        self.current_window_record_created_at = None
        self.current_window_screenshot_id = None
        self.last_interval_time = None  # Will be set on first screenshot
        self.last_screenshot_end_time = None  # Tracks last record's end_time for continuity
        self.previous_window_key = None
        self.previous_window_start_time = None
        self.previous_window_db_start_time = None
        self.previous_window_info = None
        self.previous_window_screenshot_id = None

        # Start tracking thread
        self._tracking_thread = threading.Thread(target=self.tracking_loop, daemon=True)
        self._tracking_thread.start()

        # Start activity monitoring thread (for idle detection)
        if not self._activity_monitor_thread or not self._activity_monitor_thread.is_alive():
            self._activity_monitor_thread = threading.Thread(
                target=self.monitor_user_activity, daemon=True
            )
            self._activity_monitor_thread.start()

        # Start system event monitoring thread (sleep/lock detection)
        if WIN32_AVAILABLE and (not self._system_event_thread or not self._system_event_thread.is_alive()):
            self._system_event_thread = threading.Thread(
                target=self.monitor_system_events, daemon=True
            )
            self._system_event_thread.start()

        # Start offline sync thread
        if not self._sync_thread or not self._sync_thread.is_alive():
            self.start_sync_thread()

        # Check for any pending offline data and sync immediately
        pending_count = self.offline_manager.get_pending_count()
        if pending_count > 0:
            print(f"[INFO] Found {pending_count} offline screenshots to sync")
            # Trigger immediate sync in background
            threading.Thread(
                target=lambda: self.sync_offline_data(force=True),
                daemon=True
            ).start()

        # Update tray icon to green and menu to show Pause option
        self.update_tray_icon()
        self.update_tray_menu()

        print("[OK] Tracking started with idle detection")
        self.add_admin_log('INFO', f'Tracking started (interval: {self.capture_interval}s)')
    
    def stop_tracking(self):
        """Stop screenshot tracking"""
        self.running = False
        self.tracking_active = False
        self.pause_start_time = None  # Clear pause state when fully stopping

        # Update tray icon to blue
        self.update_tray_icon()
        self.update_tray_menu()  # Update menu

        print("[OK] Tracking stopped")
        self.add_admin_log('INFO', 'Tracking stopped')
    
    def pause_tracking(self, duration_minutes=None):
        """Pause screenshot tracking (can be resumed)

        Args:
            duration_minutes: If provided, tracking will auto-resume after this many minutes.
                            If None, tracking stays paused until manually resumed.
        """
        if self.tracking_active:
            self.tracking_active = False
            self.pause_start_time = time.time()  # Record when paused
            self.last_pause_reminder_time = 0  # Reset reminder timer

            # FIX-2: Set PAUSED state so enter_idle() / D-Bus idle worker don't
            # prematurely finalize the open Supabase record while user is only paused.
            with self.state_lock:
                if self.state == TrackingState.ACTIVE:
                    self.state = TrackingState.PAUSED

            # Set auto-resume time if duration specified
            if duration_minutes:
                self.pause_end_time = self.pause_start_time + (duration_minutes * 60)
                print(f"[OK] Tracking paused for {duration_minutes} minutes")
            else:
                self.pause_end_time = None
                print("[OK] Tracking paused (manual resume)")

            self.update_tray_icon()
            self.update_tray_menu()  # Update menu to show Resume option

            # Show the floating pause popup
            self._show_pause_popup()
    
    def resume_tracking(self, show_notification=False):
        """Resume screenshot tracking

        Args:
            show_notification: If True, show a notification that tracking resumed (for auto-resume)
        """
        if not self.tracking_active and self.running:
            # Log how long user was paused
            if self.pause_start_time:
                pause_duration = time.time() - self.pause_start_time
                minutes = int(pause_duration // 60)
                print(f"[INFO] Resuming after {minutes} minute(s) paused")

            self.tracking_active = True
            self.pause_start_time = None  # Clear pause time
            self.pause_end_time = None  # Clear auto-resume time
            self.next_popup_show_time = None  # Clear next popup show time
            self.popup_show_count = 0  # Reset popup show count
            self.state = TrackingState.ACTIVE
            self.is_idle = False  # Keep boolean flag in sync
            self.last_activity_time = time.time()
            self.update_tray_icon()
            self.update_tray_menu()  # Update menu to show Pause option

            # Close the pause popup
            self._close_pause_popup()

            # Show notification if requested (for auto-resume)
            if show_notification and self.pause_settings.get('show_resume_notification', True):
                self._show_resume_notification()

            print("[OK] Tracking resumed")

    def _show_pause_popup(self):
        """Show the floating pause popup window"""
        try:
            # Close any existing popup
            self._close_pause_popup()

            # Create callback for when user clicks Resume in popup
            def on_popup_resume():
                # Resume tracking (this is called from popup thread)
                self.resume_tracking()
                self.add_admin_log('INFO', 'Tracking resumed from popup')

            # Create callback for when user sets a timer from popup
            def on_set_timer(minutes):
                # Update main app's pause_end_time for auto-resume
                self.pause_end_time = time.time() + (minutes * 60)
                # Reset popup show tracking when timer is set
                self.popup_show_count = 0
                self.next_popup_show_time = None
                self._calculate_next_popup_time()
                self.add_admin_log('INFO', f'Auto-resume timer set for {minutes} minutes from popup')

            # Create callback for when popup is closed (not resumed)
            def on_popup_close():
                # Calculate when to show popup again (at 1/4 intervals)
                self._calculate_next_popup_time()

            # Create and show popup
            self.pause_popup = PausePopupWindow(
                on_resume_callback=on_popup_resume,
                on_set_timer_callback=on_set_timer,
                on_close_callback=on_popup_close
            )
            self.pause_popup.show(self.pause_start_time, self.pause_end_time)
            # If this is the initial show (not a periodic reappearance), reset count
            if self.next_popup_show_time is None:
                self.popup_show_count = 0
            print("[OK] Pause popup shown")

        except Exception as e:
            print(f"[WARN] Failed to show pause popup: {e}")

    def _close_pause_popup(self):
        """Close the pause popup window if it's open"""
        try:
            if self.pause_popup:
                # Check if popup is still running before trying to close
                if self.pause_popup.running and self.pause_popup.window:
                    self.pause_popup.close()
                self.pause_popup = None
        except Exception as e:
            self.pause_popup = None
            print(f"[WARN] Error closing pause popup: {e}")

    def show_pause_selection_popup(self):
        """Show popup for selecting pause duration BEFORE pausing (tray menu flow)"""
        try:
            # Close any existing popup
            self._close_pause_popup()

            # Create callback for when user selects duration and clicks "Pause Tracking"
            def on_duration_selected(minutes):
                # NOW actually pause tracking with the selected duration
                self.pause_tracking(duration_minutes=minutes)
                self.add_admin_log('INFO', f'Tracking paused for {minutes} minutes from selection popup')

            # Create callback for when popup is closed without selecting (Cancel)
            def on_popup_cancelled():
                # User cancelled - don't pause, just log it
                print("[INFO] Pause selection cancelled by user")

            # Create and show popup in selection mode
            self.pause_popup = PausePopupWindow(
                on_resume_callback=None,  # Not used in selection mode
                on_set_timer_callback=on_duration_selected,
                on_close_callback=on_popup_cancelled,
                selection_mode=True  # Enable selection mode
            )
            self.pause_popup.show()  # No pause times needed for selection mode
            print("[OK] Pause selection popup shown")

        except Exception as e:
            print(f"[WARN] Failed to show pause selection popup: {e}")

    def _calculate_next_popup_time(self):
        """Calculate when to show the popup again (at 1/4 intervals of remaining pause time)"""
        if not self.pause_end_time or not self.pause_start_time:
            # No timed pause, don't schedule reappearance
            self.next_popup_show_time = None
            return

        current_time = time.time()
        remaining_time = self.pause_end_time - current_time
        
        if remaining_time <= 0:
            # Pause is about to end, don't schedule
            self.next_popup_show_time = None
            return

        # Calculate 1/4 intervals
        # For 10 min pause: show at 7.5 min remaining (1/4), 5 min remaining (2/4), 2.5 min remaining (3/4)
        # popup_show_count tracks how many times we've shown: 0=initial, 1=shown once, 2=shown twice, 3=shown three times
        # After showing 3 times, we don't show again (next is auto-resume)
        
        if self.popup_show_count >= 3:
            # Already shown 3 times, next is auto-resume (don't show popup)
            self.next_popup_show_time = None
            return

        # Increment count for next show
        self.popup_show_count += 1
        
        # Calculate time until next 1/4 mark
        # If remaining is 10 min and count is 0 (just closed first time):
        #   next_show_remaining = 10 * (4 - 1) / 4 = 10 * 3/4 = 7.5 min remaining
        #   time_until_show = 10 - 7.5 = 2.5 min from now
        # If remaining is 7.5 min and count is 1 (just closed second time):
        #   next_show_remaining = 7.5 * (4 - 2) / 4 = 7.5 * 2/4 = 3.75 min remaining
        #   But wait, we need to use original remaining time, not current
        # Actually, let's recalculate from pause_end_time to be accurate
        
        # Calculate what fraction of total pause time remains
        total_pause_duration = self.pause_end_time - self.pause_start_time
        elapsed = current_time - self.pause_start_time
        remaining_fraction = remaining_time / total_pause_duration if total_pause_duration > 0 else 0
        
        # Next show should be at (4 - popup_show_count) / 4 of remaining time
        # For 10 min total: show at 7.5 min (3/4), 5 min (2/4), 2.5 min (1/4) remaining
        target_fraction = (4 - self.popup_show_count) / 4.0
        target_remaining = total_pause_duration * target_fraction
        time_until_show = remaining_time - target_remaining
        
        if time_until_show <= 0:
            # Too close to end, don't schedule
            self.next_popup_show_time = None
            return
            
        self.next_popup_show_time = current_time + time_until_show
        
        minutes_until = time_until_show / 60
        print(f"[INFO] Popup will reappear in {minutes_until:.1f} minutes (interval {self.popup_show_count}/4, when {target_remaining/60:.1f} min remaining)")

    def _show_resume_notification(self):
        """Show a notification that tracking has auto-resumed"""
        if not WINOTIFY_AVAILABLE:
            return

        try:
            from winotify import Notification, audio

            notification = Notification(
                app_id="Time Tracker",
                title="Tracking Resumed",
                msg="Your timed pause has ended. Time tracking is now active.",
                duration="short"
            )
            notification.set_audio(audio.Default, loop=False)
            notification.show()
            print("[OK] Resume notification shown")
        except Exception as e:
            print(f"[WARN] Failed to show resume notification: {e}")
    
    def create_tray_icon(self, state='blue', show_update_badge=False):
        """
        Create a system tray icon image with color based on state
        Args:
            state: 'red' (not logged in), 'blue' (logged in, not tracking), 'green' (logged in, tracking)
            show_update_badge: If True, adds a small notification dot indicating an update is available
        """
        # Use 22x22 — GNOME panel standard (16px is too small and sometimes invisible
        # on HiDPI displays or Wayland compositors).
        size = 22
        icon = PILImage.new('RGBA', (size, size), (0, 0, 0, 0))  # Transparent background
        
        # Draw using PIL ImageDraw
        draw = ImageDraw.Draw(icon)
        
        # Color mapping based on state
        color_map = {
            'red': (220, 53, 69, 255),      # Red - not logged in
            'blue': (0, 82, 204, 255),      # Atlassian blue - logged in, not tracking
            'green': (40, 167, 69, 255),    # Green - logged in and actively tracking
            'orange': (255, 152, 0, 255),   # Orange - logged in, tracking, but idle
            'yellow': (251, 191, 36, 255)   # Yellow/Amber - tracking paused by user
        }
        
        icon_color = color_map.get(state, color_map['blue'])
        
        # Draw a circle (clock face) with state-based color
        center = size // 2
        radius = size // 2 - 2
        draw.ellipse(
            [center - radius, center - radius, center + radius, center + radius],
            fill=icon_color,
            outline=(255, 255, 255, 255),
            width=1
        )
        
        # Draw clock hands (simple lines)
        hand_color = (255, 255, 255, 255)
        # Hour hand
        draw.line(
            [center, center, center, center - radius + 4],
            fill=hand_color,
            width=2
        )
        # Minute hand
        draw.line(
            [center, center, center + radius - 3, center],
            fill=hand_color,
            width=2
        )
        
        # Draw update badge (small dot in top-right corner) if update is available
        if show_update_badge:
            badge_color = (33, 150, 243, 255)  # Blue badge color (#2196F3)
            badge_outline = (255, 255, 255, 255)  # White outline for visibility
            badge_radius = 4
            badge_x = size - badge_radius - 1  # Top-right corner
            badge_y = badge_radius + 1
            
            # Draw white outline first (slightly larger)
            draw.ellipse(
                [badge_x - badge_radius - 1, badge_y - badge_radius - 1, 
                 badge_x + badge_radius + 1, badge_y + badge_radius + 1],
                fill=badge_outline
            )
            # Draw the badge dot
            draw.ellipse(
                [badge_x - badge_radius, badge_y - badge_radius, 
                 badge_x + badge_radius, badge_y + badge_radius],
                fill=badge_color
            )
        
        return icon
    
    def get_tray_icon_state(self):
        """Determine the current state for tray icon color
        
        This method evaluates multiple state conditions in priority order:
        1. Not logged in → RED
        2. Anonymous mode → ORANGE (tracking) or RED (not tracking)
        3. Manually paused → YELLOW
        4. System idle → ORANGE
        5. Tracking active → Check auth:
           - Auth valid → GREEN (syncing normally)
           - Auth failed → ORANGE (queuing locally)
        6. Logged in but not tracking → BLUE
        
        Color meanings:
        - 🔴 RED: Not logged in / Not tracking
        - 🔵 BLUE: Logged in but tracking not started
        - 🟢 GREEN: Tracking AND authenticated AND syncing normally
        - 🟠 ORANGE: Tracking locally but cannot sync to server
          (due to: auth failure, offline mode, idle state, or anonymous mode)
        - 🟡 YELLOW: Manually paused by user
        
        Returns:
            str: Color state ('red', 'blue', 'green', 'orange', or 'yellow')
        
        Note:
            - GREEN now guarantees both tracking AND sync capability
            - ORANGE indicates data is being queued locally for later upload
            - Auth check may trigger automatic token refresh (< 6s in worst case)
        """
        if not self.current_user and not (self.current_user_id and self.current_user_id.startswith('anonymous_')):
            return 'red'  # Not logged in and not in anonymous mode
        elif self.current_user_id and self.current_user_id.startswith('anonymous_'):
            if self.tracking_active:
                return 'orange'  # Anonymous mode, tracking active (use orange to indicate not logged in)
            else:
                return 'red'  # Anonymous mode but not tracking
        elif self.pause_start_time is not None:
            return 'yellow'  # User manually paused tracking
        elif self.is_idle:
            return 'orange'  # Logged in, tracking enabled, but idle (no activity)
        elif self.tracking_active:
            # Check authentication health before showing green
            if not self.auth_manager.is_authenticated():
                return 'orange'  # Tracking locally but cannot sync (auth issue)
            return 'green'  # Logged in and actively tracking
        else:
            return 'blue'  # Logged in but tracking not started
    
    def _safe_update_tray_icon(self):
        """FIX-5: Thread-safe wrapper for update_tray_icon().

        On Linux pystray uses AppIndicator3 / AyatanaAppIndicator3, both GObject
        wrappers over GTK. GTK is NOT thread-safe — all mutations must run on the
        GLib main-loop thread. When enter_idle() or resume_from_idle() is triggered
        by the D-Bus idle-poll worker (a background daemon thread), calling
        update_tray_icon() directly causes GLib-GObject-WARNING assertions and can
        produce a frozen or invisible tray icon.

        This helper marshals the call via GLib.idle_add() when invoked from a
        non-main-loop thread. On Windows (pystray xwin32 backend) direct calls
        are always safe, so no marshalling is applied there.
        """
        if not sys.platform.startswith('linux'):
            self.update_tray_icon()
            return
        try:
            from gi.repository import GLib as _GLib  # noqa: PLC0415
            if _GLib.MainContext.default().is_owner():
                self.update_tray_icon()          # already on main loop thread
            else:
                _GLib.idle_add(self.update_tray_icon)   # marshal to main loop
        except Exception:
            # gi unavailable or pystray using non-GLib backend — fall back to direct call
            self.update_tray_icon()

    def update_tray_icon(self):
        """Update the tray icon based on current state"""
        if self.tray:
            try:
                state = self.get_tray_icon_state()
                # Show update badge if an update is available
                show_badge = getattr(self, 'update_available', False)
                new_icon = self.create_tray_icon(state, show_update_badge=show_badge)
                self.tray.icon = new_icon

                # Set an informative tooltip so users understand the orange/red states
                if state == 'green':
                    self.tray.title = "TimeTracker - Tracking & Syncing"
                elif state == 'orange':
                    if self.is_idle:
                        self.tray.title = "TimeTracker - Idle (No Activity Detected)"
                    elif self.current_user_id and self.current_user_id.startswith('anonymous_'):
                        self.tray.title = "TimeTracker - Anonymous Mode (Tracking Locally)"
                    else:
                        self.tray.title = "TimeTracker - Tracking Locally (Sync Paused)"
                elif state == 'yellow':
                    self.tray.title = "TimeTracker - Paused"
                elif state == 'blue':
                    self.tray.title = "TimeTracker - Ready (Not Tracking)"
                elif state == 'red':
                    self.tray.title = "TimeTracker - Not Logged In"
                else:
                    self.tray.title = "TimeTracker"

            except Exception as e:
                print(f"[WARN] Failed to update tray icon: {e}")

    def _manual_update_trigger(self):
        """Handle manual update trigger from tray menu"""
        try:
            if not self.update_manager:
                print("[WARN] Update manager not available")
                return
            
            status = self.update_manager.get_status()
            state = status.get('state', 'idle')
            
            # If update is ready, install it immediately
            if state in ('ready', 'mandatory_ready'):
                latest = (status.get('update_info') or {}).get('latest_version', 'unknown')
                print(f"[UPDATE] Manually triggering update installation for v{latest}")
                self.add_admin_log('INFO', f'User manually triggered update v{latest}')
                
                # Show notification
                if WINOTIFY_AVAILABLE:
                    try:
                        notification = Notification(
                            app_id="Time Tracker",
                            title="Installing Update",
                            msg=f"Installing v{latest}. The app will restart shortly.",
                            duration="short"
                        )
                        notification.set_audio(audio.Default, loop=False)
                        notification.show()
                    except Exception:
                        pass
                
                self.update_manager.apply_update()
            else:
                # Otherwise, force a new update check
                print("[UPDATE] User manually checking for updates")
                self.add_admin_log('INFO', 'User manually triggered update check')
                
                # Show checking notification
                if WINOTIFY_AVAILABLE:
                    try:
                        notification = Notification(
                            app_id="Time Tracker",
                            title="Checking for Updates",
                            msg="Checking for available updates...",
                            duration="short"
                        )
                        notification.set_audio(audio.Default, loop=False)
                        notification.show()
                    except Exception:
                        pass
                else:
                    _linux_notify("Checking for Updates", "Checking for available updates...")
                
                # Force update check in background thread to avoid blocking tray UI
                def check_in_background():
                    result = self.check_for_app_updates(show_notification=True, force=True)
                    # Show result notification — without this the user only ever sees
                    # the "Checking for Updates" toast and gets no feedback on outcome.
                    if WINOTIFY_AVAILABLE:
                        try:
                            update_state = self.update_manager.get_status().get('state', 'idle') if self.update_manager else 'idle'
                            # Only show "up to date" if no download/install is already in progress
                            if update_state not in ('downloading', 'ready', 'mandatory_ready', 'installing'):
                                if result is None:
                                    msg = "Could not reach the update server. Please check your network connection and try again."
                                    title = "Update Check Failed"
                                elif not (result or {}).get('update_available', False):
                                    msg = f"You're running the latest version (v{self.app_version})."
                                    title = "App is Up to Date"
                                else:
                                    # Update was found and download kicked off — download notification
                                    # is handled by _on_update_manager_state_changed; no extra toast needed.
                                    return
                                notification = Notification(
                                    app_id="Time Tracker",
                                    title=title,
                                    msg=msg,
                                    duration="short"
                                )
                                notification.set_audio(audio.Default, loop=False)
                                notification.show()
                        except Exception:
                            pass
                    else:
                        try:
                            update_state = self.update_manager.get_status().get('state', 'idle') if self.update_manager else 'idle'
                            if update_state not in ('downloading', 'ready', 'mandatory_ready', 'installing'):
                                if result is None:
                                    _linux_notify(
                                        "Update Check Failed",
                                        "Could not reach the update server. Check network and try again.",
                                        urgency="normal"
                                    )
                                elif not (result or {}).get('update_available', False):
                                    _linux_notify(
                                        "App is Up to Date",
                                        f"You are running the latest version (v{self.app_version}).",
                                        urgency="normal"
                                    )
                                # If update is available, _on_update_manager_state_changed
                                # sends the downloading/ready notifications.
                        except Exception:
                            pass

                threading.Thread(target=check_in_background, daemon=True).start()
        
        except Exception as e:
            print(f"[ERROR] Manual update trigger failed: {e}")

    def _tray_backend_name(self):
        """Return the active pystray backend module name."""
        return getattr(pystray.Icon, '__module__', 'pystray.unknown').rsplit('.', 1)[-1]

    def _tray_supports_menu(self):
        """Return whether the active tray backend supports popup menus."""
        return bool(getattr(pystray.Icon, 'HAS_MENU', True))

    def _open_tray_fallback(self, icon=None, menu_item=None):
        """Fallback action for tray backends that do not support popup menus."""
        # A logged-in user with an invalid refresh token needs /login, not /success.
        if not self._is_session_valid():
            target = '/login'
        else:
            target = '/'
        webbrowser.open(f'http://localhost:{self.web_port}{target}')

    def _get_tray_fallback_label(self):
        """Label for menu-less tray backends where only default click is supported."""
        if not self.current_user:
            return 'Open Login'
        return 'Open Time Tracker'

    def _build_tray_menu(self):
        """Build the tray menu with current state"""
        print("[DEBUG] _build_tray_menu() called")

        if not self._tray_supports_menu():
            backend_name = self._tray_backend_name()
            print(
                f"[WARN] Tray backend '{backend_name}' does not support popup menus. "
                "Right-click actions are unavailable; left-click will open the web UI instead."
            )
            return pystray.Menu(
                item(
                    lambda text: self._get_tray_fallback_label(),
                    self._open_tray_fallback,
                    default=True,
                )
            )
        
        def get_menu_label():
            if self.current_user:
                return f"Logged in as: {self.current_user.get('email', 'User')}"
            elif self.current_user_id and self.current_user_id.startswith('anonymous_'):
                return "Anonymous (Click to Login)"
            else:
                return "Login"

        def users_action(icon, item):  # Fixed: Added parameters
            # Only open login page if not logged in
            if not self.current_user:
                webbrowser.open(f'http://localhost:{self.web_port}/login')

        # Build menu items list dynamically based on current state
        menu_items = []
        
        try:
            menu_items.append(
                item(
                    lambda text: get_menu_label(),
                    users_action
                )
            )
            print(f"[DEBUG] Added user status item")
        except Exception as e:
            print(f"[ERROR] Failed to add user status item: {e}")
            import traceback
            traceback.print_exc()

        # ── Current-window badge + "View All App Rules…" link ────────────────
        # Only shown when a user is logged in and tracking is active.
        if self.current_user and getattr(self, 'tracking_active', False):
            def _get_window_label():
                try:
                    cursor = self.db_manager.get_connection().cursor()
                    cursor.execute(
                        'SELECT application_name, classification '
                        'FROM active_sessions ORDER BY last_seen DESC LIMIT 1'
                    )
                    row = cursor.fetchone()
                    if row:
                        app_name, classification = row
                        emoji = {
                            'productive': '\U0001f7e2',       # 🟢
                            'non_productive': '\U0001f534',   # 🔴
                            'private': '\u26ab',              # ⚫
                        }.get(classification, '\u26aa')       # ⚪
                        return f"{emoji} {(app_name or 'Unknown')[:25]}"
                except Exception:
                    pass
                return '\u26aa No active window'

            def _open_classifications(icon=None, it=None):
                webbrowser.open(f'http://localhost:{self.web_port}/classifications')

            menu_items.append(pystray.Menu.SEPARATOR)
            menu_items.append(item(
                lambda text: _get_window_label(),
                lambda icon, it: None,
                enabled=False,
            ))
            menu_items.append(item(
                '  View All App Rules\u2026',
                _open_classifications,
            ))

        # Add separator and update-related menu items
        menu_items.append(pystray.Menu.SEPARATOR)

        status = self.update_manager.get_status() if self.update_manager else {'state': 'idle'}
        state = status.get('state', 'idle')
        info = status.get('update_info') or {}
        latest = info.get('latest_version', '')
        progress = int((status.get('progress', 0) or 0) * 100)

        if state == 'downloading':
            menu_items.append(item(lambda text: f"⬇️ Downloading v{latest} ({progress}%)", lambda: None, enabled=False))
        elif state in ('ready', 'mandatory_ready'):
            # Make this clickable so users can manually trigger installation
            menu_items.append(item(lambda text: f"✨ Update Ready v{latest} - Click to Install", self._manual_update_trigger, enabled=True))
        elif state == 'installing':
            menu_items.append(item(lambda text: f"🔄 Installing v{latest}...", lambda: None, enabled=False))
        elif state == 'failed':
            # Allow retry on failure
            menu_items.append(item(lambda text: f"❌ Update Failed - Click to Retry", self._manual_update_trigger, enabled=True))
        else:
            # Show "Check for Updates" button when no update activity
            menu_items.append(item(lambda text: f"✓ Up to Date (v{self.app_version}) - Click to Check", self._manual_update_trigger, enabled=True))

        print(f"[DEBUG] Menu built with {len(menu_items)} items")
        menu = pystray.Menu(*menu_items)
        print(f"[DEBUG] Menu object created: {menu}")
        return menu

    def _shutdown_cleanup(self):
        """Gracefully shut down OCR worker, flush sessions, and close DB connections."""
        if getattr(self, '_shutdown_done', False):
            return
        self._shutdown_done = True
        try:
            print("[SHUTDOWN] Stopping OCR worker thread...")
            if self.ocr_processor:
                self.ocr_processor.shutdown()
        except Exception as e:
            print(f"[SHUTDOWN] OCR worker shutdown error: {e}")
        try:
            print("[SHUTDOWN] Flushing remaining activity sessions...")
            self.upload_activity_batch()
        except Exception as e:
            print(f"[SHUTDOWN] Final batch upload error: {e}")
        try:
            if hasattr(self, 'db_manager'):
                self.db_manager.close_all()
                print("[SHUTDOWN] Database connections closed")
        except Exception as e:
            print(f"[SHUTDOWN] DB connection cleanup error: {e}")

    def _exit_app(self):
        """Exit the application from tray menu"""
        print("[INFO] Exit requested from tray menu")
        self._close_pause_popup()  # Close popup if open
        self._shutdown_cleanup()
        self.stop()
        if self.tray:
            self.tray.stop()

    def update_tray_menu(self):
        """Force update the tray menu (call after login/logout)"""
        if self.tray:
            try:
                self.tray.menu = self._build_tray_menu()
            except Exception as e:
                print(f"[WARN] Failed to update tray menu: {e}")
    
    def setup_system_tray(self):
        """Setup system tray icon"""
        print("[DEBUG] setup_system_tray() called")
        try:
            # Create initial icon based on current state
            initial_state = self.get_tray_icon_state()
            show_badge = getattr(self, 'update_available', False)
            icon_image = self.create_tray_icon(initial_state, show_update_badge=show_badge)
            print(f"[DEBUG] Icon image created: {icon_image}")

            # Create menu using helper method
            menu = self._build_tray_menu()
            print(f"[DEBUG] Menu created in setup_system_tray: {menu}")

            self.tray = pystray.Icon("timetracker", icon_image, menu=menu)
            print(f"[DEBUG] pystray.Icon created with menu: {self.tray.menu}", flush=True)
            
            self.tray.title = "TimeTracker"
            if not self._tray_supports_menu():
                backend_name = self._tray_backend_name()
                print(
                    f"[WARN] Running on pystray backend '{backend_name}' without menu support. "
                    "Login, app rules, update controls, tracking controls, and exit are not available via right-click. "
                    "Use left-click to open the local web UI, or install AppIndicator/Ayatana support to restore menus."
                )

            # Use pystray's setup callback to start periodic icon updates
            # AFTER the tray is visible. Without this, the update thread exits
            # immediately because self.tray.visible is False before .run() starts.
            def on_tray_ready(icon):
                print("[DEBUG] on_tray_ready() CALLED — setting icon visible", flush=True)
                icon.visible = True
                print("[DEBUG] icon.visible set to True", flush=True)
                # On Linux/GNOME the tray icon is invisible without the AppIndicator
                # GNOME Shell extension.  Send a desktop notification so the user
                # always gets visual confirmation that the app started, regardless of
                # whether their GNOME shell shows the tray icon or not.
                if sys.platform.startswith('linux'):
                    try:
                        import subprocess as _sub_notify
                        _sub_notify.Popen(
                            [
                                'notify-send',
                                '--app-name=TimeTracker',
                                '--icon=timetracker',
                                '--urgency=normal',
                                '--expire-time=8000',
                                'TimeTracker is running',
                                'Tracking your JIRA time in the background.\n'
                                'If you don\'t see a tray icon, open a browser and go to:\n'
                                'http://localhost:51777',
                            ],
                            stdout=_sub_notify.DEVNULL,
                            stderr=_sub_notify.DEVNULL,
                        )
                    except Exception:
                        pass  # notify-send not available — silently skip

                # Start periodic icon update in a separate daemon thread
                def update_icon_periodically():
                    while self.tray and self.tray.visible:
                        try:
                            self.update_tray_icon()
                            # Remind user to log in every 15 minutes if not logged in
                            # (skip for anonymous/offline users — they can't log in)
                            if not self.current_user and not (self.current_user_id and self.current_user_id.startswith('anonymous_')):
                                self._show_login_reminder()
                        except Exception as e:
                            print(f"[WARN] Periodic icon update error: {e}")
                        time.sleep(2)

                update_thread = threading.Thread(target=update_icon_periodically, daemon=True)
                update_thread.start()

            print(f"[DEBUG] About to call tray.run() with menu: {self.tray.menu}", flush=True)
            self.tray.run(setup=on_tray_ready)
            print("[DEBUG] tray.run() returned (app closing)", flush=True)
        except Exception as e:
            print(f"[WARN] System tray setup failed: {e}")
            import traceback
            traceback.print_exc()
            # Fallback to simple colored icon
            try:
                state = self.get_tray_icon_state()
                color_map = {
                    'red': '#DC3545',
                    'blue': '#0052CC',
                    'green': '#28A745',
                    'orange': '#FF9800',
                    'yellow': '#FBBF24'
                }
                icon_image = PILImage.new('RGB', (16, 16), color=color_map.get(state, '#0052CC'))

                # Use the same menu helper for fallback
                menu = self._build_tray_menu()

                self.tray = pystray.Icon("timetracker", icon_image, menu=menu)
                self.tray.run()
            except Exception as e2:
                print(f"[ERROR] System tray fallback also failed: {e2}")
    
    def quit_app(self):
        """Quit application"""
        # Update desktop status to logged out before quitting
        self._update_desktop_status(logged_in=False)

        self._shutdown_cleanup()
        self.stop_tracking()
        if self.tray:
            self.tray.stop()
        sys.exit(0)
    
    def run_web_server(self):
        """Run Flask web server"""
        self.app.run(host='127.0.0.1', port=self.web_port, debug=False)
    
    def run(self):
        """Main application entry point"""
        print("[DEBUG-RUN] run() method called", flush=True)
        print("[OK] Starting Time Tracker...", flush=True)

        print("[DEBUG-RUN] Checking self-install...", flush=True)
        # Self-install on first run (copies exe to %LOCALAPPDATA%\TimeTracker\)
        if not install_application():
            # Installation happened - this instance should exit
            # The installed version has been started
            print("[INFO] Exiting installer instance...")
            sys.exit(0)
        print("[DEBUG-RUN] Self-install check complete", flush=True)

        print("[DEBUG-RUN] Clearing shutdown signals...", flush=True)
        # Clean up any stale shutdown signals from previous failed updates
        # This ensures we don't immediately shut down due to an old signal
        clear_shutdown_signal()
        print("[DEBUG-RUN] Shutdown signals cleared", flush=True)

        print("[DEBUG-RUN] Acquiring single instance lock...", flush=True)
        # Acquire single instance lock - prevent multiple instances
        if not acquire_single_instance_lock():
            print("[ERROR] Another instance is already running. Exiting...")
            print("[INFO] Check your system tray for the existing instance.")
            # Give user time to see the message if running from console
            time.sleep(3)
            sys.exit(1)

        # ── FIX-1: SIGTERM handler (Linux graceful shutdown) ──────────────────────
        # On Linux, systemd stop / pkill / session logout send SIGTERM.
        # Python's default handler terminates immediately without calling atexit,
        # leaving open Supabase records (end_time = NULL) and losing in-memory
        # idle records.  Register a handler so _shutdown_cleanup() always runs.
        if sys.platform != 'win32':
            import signal as _signal

            def _handle_sigterm(signum, frame):
                """Graceful shutdown on SIGTERM (systemd stop, pkill, logout)."""
                print("[INFO] SIGTERM received — running shutdown cleanup before exit")
                try:
                    self._shutdown_cleanup()
                except Exception as _se:
                    print(f"[WARN] SIGTERM cleanup error (non-fatal): {_se}")
                sys.exit(0)

            _signal.signal(_signal.SIGTERM, _handle_sigterm)
            print("[INFO] SIGTERM handler registered (Linux graceful shutdown enabled)")
        # ── end FIX-1 ─────────────────────────────────────────────────────────────

        # Add to startup (runs on system boot) - ONLY when running as built exe
        # Windows: registry HKCU Run entry.
        # Linux: XDG autostart ~/.config/autostart/timetracker.desktop.
        if getattr(sys, 'frozen', False):
            if sys.platform.startswith('linux'):
                add_to_linux_autostart()
            else:
                add_to_startup()
        else:
            # Development mode: do not modify startup configuration.
            print("[INFO] Running in development mode - auto-start is only configured for the built exe.")

        # BUGFIX: Load cached user info EARLY to restore organization_id immediately
        # This ensures admin panel and tracking work even before server verification completes.
        # Without this, routes are initialized with organization_id=None, causing admin panel
        # to show "locked" message even when user has valid cached credentials.
        # NOTE: Use a lightweight token-existence check instead of is_authenticated() here.
        # is_authenticated() triggers a network refresh call if the access token is expired,
        # but the network may not be ready yet (WiFi reconnecting after sleep/restart).
        # The full auth verification happens later after the connectivity check.
        has_stored_tokens = (self.auth_manager.tokens.get('access_token') or
                             self.auth_manager.tokens.get('refresh_token'))
        if has_stored_tokens:
            try:
                cached_user = self._load_cached_user_info()
                if cached_user and cached_user.get('organization_id'):
                    self.organization_id = cached_user.get('organization_id')
                    self.current_user_id = cached_user.get('user_id')
                    self.current_user = cached_user
                    print(f"[OK] Restored organization_id from cache: {self.organization_id}")
                    # Early Supabase init: only proceed if local config cache exists (FIX-6).
                    # Without the cache, initialize_supabase() requires a live network call —
                    # risky before check_connectivity() runs (network may not be ready on boot,
                    # after sleep/wake, or immediately after an auto-update restart).
                    has_supabase_cache = bool(self.auth_manager.tokens.get('cached_supabase_url'))
                    if has_supabase_cache:
                        try:
                            if self.initialize_supabase():
                                print("[OK] Supabase initialized successfully from cache")
                        except Exception as e:
                            print(f"[WARN] Could not initialize Supabase from cache: {e}")
                    else:
                        print("[INFO] Skipping early Supabase init — no local config cache. "
                              "Will initialize after connectivity check.")
            except Exception as e:
                print(f"[WARN] Could not load cached user info early: {e}")

        # Check network connectivity first
        is_online = self.offline_manager.check_connectivity(force=True)
        
        # Check authentication
        if self.auth_manager.is_authenticated():
            if is_online:
                # Online: try to get user info from Atlassian (with retries)
                user_info = None
                for attempt in range(3):
                    user_info = self.auth_manager.get_user_info()
                    if user_info:
                        break
                    if attempt < 2:
                        wait_secs = (attempt + 1) * 3
                        print(f"[WARN] get_user_info attempt {attempt + 1} failed, retrying in {wait_secs}s...")
                        time.sleep(wait_secs)

                if user_info:
                    self.current_user = user_info
                    try:
                        # Initialize Supabase clients (fetches config from AI server)
                        if not self.initialize_supabase():
                            print("[WARN] Could not initialize Supabase, using cached user ID")
                            self.current_user_id = self._load_cached_user_id()
                        else:
                            self.current_user_id = self.ensure_user_exists(user_info)
                            # Validate user actually exists in DB (detect stale/phantom IDs)
                            if self.current_user_id and self.supabase:
                                try:
                                    check = self.supabase.table('users').select('id').eq('id', self.current_user_id).execute()
                                    if not check.data:
                                        print(f"[CRITICAL] User {self.current_user_id} not found in DB! Clearing stale credentials.")
                                        self.current_user_id = None
                                        self.organization_id = None
                                        self._clear_cached_user_info()
                                    else:
                                        print(f"[OK] User {self.current_user_id} verified in database")
                                        self._update_desktop_status(logged_in=True)
                                except Exception as ve:
                                    print(f"[WARN] Could not verify user in DB: {ve}")
                            # Sync app classifications from Supabase (all projects)
                            try:
                                client = self.supabase
                                self.classification_manager.sync_classifications(
                                    client, self.organization_id, self.current_project_key,
                                    all_project_keys=list(self._get_known_project_keys())
                                )
                            except Exception as e:
                                print(f"[WARN] Classification sync failed during startup: {e}")
                            # Associate any anonymous offline records with this user
                            self._associate_offline_records()
                    except Exception as e:
                        print(f"[WARN] Could not sync user to database: {e}")
                        # Try to load cached user_id from local storage
                        self.current_user_id = self._load_cached_user_id()
                    print(f"[OK] Welcome back, {user_info.get('email', 'User')}!")
                    self.add_admin_log('INFO', f"User logged in: {user_info.get('email', 'User')}")
                else:
                    # All retries failed — fall back to cached user info instead of destroying tokens.
                    # Only logout if the server explicitly rejected the refresh token (handled inside refresh).
                    # Network glitches, timeouts, and temporary server issues should NOT force re-login.
                    print("[WARN] Could not verify user info after 3 attempts — falling back to cached data")
                    cached_user = self._load_cached_user_info()
                    if cached_user:
                        self.current_user = cached_user
                        self.current_user_id = cached_user.get('user_id')
                        print(f"[OK] Using cached credentials for {cached_user.get('email', 'User')}")
                        print("[INFO] Will retry authentication in the background")
                        # If Supabase was already initialized via early init, push the new version
                        # now rather than waiting for the background reinit cycle.
                        if self.supabase_initialized and self.current_user_id:
                            try:
                                self._update_desktop_status(logged_in=True)
                                print("[OK] Desktop status updated from cached-fallback path")
                            except Exception as ds_err:
                                print(f"[WARN] Could not update desktop status in fallback path: {ds_err}")
                    else:
                        # No cache AND no server response — only NOW force re-auth
                        print("[WARN] No cached credentials available, please re-authenticate")
                        self.auth_manager.logout()
            else:
                # Offline: try to use cached credentials
                print("[INFO] Starting in OFFLINE MODE...")
                cached_user = self._load_cached_user_info()
                if cached_user:
                    self.current_user = cached_user
                    self.current_user_id = cached_user.get('user_id')
                    print(f"[OK] Offline mode - Welcome back, {cached_user.get('email', 'User')}!")
                    print("[INFO] Screenshots will be saved locally until online")
                else:
                    # No cached user - will use anonymous tracking
                    print("[INFO] Offline mode - Starting anonymous tracking")
                    print("[INFO] Screenshots will be associated with your account when you login")
                    self.current_user_id = f"anonymous_{secrets.token_hex(8)}"
        else:
            # Not authenticated
            if not is_online:
                # Offline and not authenticated - start anonymous tracking
                print("[INFO] Starting in OFFLINE MODE (not authenticated)...")
                print("[INFO] Screenshots will be saved locally and associated when you login")
                self.current_user_id = f"anonymous_{secrets.token_hex(8)}"
        
        print("[DEBUG] About to start web server...")
        # Start web server
        web_thread = threading.Thread(target=self.run_web_server, daemon=True)
        web_thread.start()
        time.sleep(2)
        print("[DEBUG] Web server thread started")

        print("[DEBUG] Checking for staged updates...")
        if self.update_manager and self.update_manager.load_staged_update_if_exists():
            print("[INFO] Found staged update from previous session")
        print("[DEBUG] Update check complete")
        print("[DEBUG] Update check complete")
        
        print("[DEBUG] Checking connectivity for updates...")
        # Check for updates on startup (only if online)
        # Re-check connectivity here (don't trust the is_online from startup - it may be stale after auth)
        if self.offline_manager.check_connectivity(force=True):
            print("[INFO] Checking for app updates...")
            print("[DEBUG] About to call check_for_app_updates...")
            self.check_for_app_updates(show_notification=True, force=True)
            print("[DEBUG] check_for_app_updates returned")
        else:
            print("[INFO] Offline after authentication - will check for updates when network is available")
        
        print("[DEBUG] Starting tracking checks...")
        # Determine if we should start tracking
        should_track = self.current_user is not None or self.current_user_id is not None

        # Check consent status for authenticated users
        has_consent = False
        if self.current_user:
            user_account_id = self.current_user.get('account_id')
            has_consent = self.consent_manager.has_valid_consent(user_account_id)
            if not has_consent:
                secure_log("[INFO] User has not provided consent for screenshot capture", email=self.current_user.get('email'))
        elif self.current_user_id and self.current_user_id.startswith('anonymous_'):
            # Anonymous users don't need consent yet (they'll provide it on login)
            has_consent = True

        # Open browser if not authenticated (only if online) or if consent needed
        if not self.current_user:
            if is_online:
                print("[INFO] Opening browser for authentication...")
                webbrowser.open(f'http://localhost:{self.web_port}/login')
            else:
                print(f"[INFO] Dashboard available at http://localhost:{self.web_port}")
                print("[INFO] Login when online to sync your data")
        elif not has_consent:
            # User is authenticated but hasn't given consent - open consent page
            print("[INFO] Opening browser for consent...")
            webbrowser.open(f'http://localhost:{self.web_port}/consent')

        # Start tracking only if user has consent (or is anonymous)
        if should_track and has_consent:
            print("[DEBUG] Starting tracking...")
            self.start_tracking()
            print("[DEBUG] Tracking started")
        elif should_track and not has_consent:
            print("[INFO] Waiting for user consent before starting screenshot capture")
        
        print("[DEBUG] Preparing final status messages...")
        print(f"[OK] Application running at http://localhost:{self.web_port}")
        if not is_online:
            print("[INFO] OFFLINE MODE - Screenshots will be synced when online")
        if self.current_user_id and self.current_user_id.startswith('anonymous_'):
            print("[INFO] ANONYMOUS MODE - Login to associate screenshots with your account")
        print("[OK] Check system tray for application icon")
        
        print("[DEBUG] About to setup system tray...")
        # Setup system tray (blocking)
        try:
            self.setup_system_tray()
        except KeyboardInterrupt:
            print("\n[INFO] Shutting down...")
            self.stop_tracking()
    
    # ============================================================================
    # HTML TEMPLATES
    # ============================================================================
    
    def render_login_page(self, session_expired=False):
        expired_banner = ''
        if session_expired:
            expired_banner = (
                '<div style="display:flex;align-items:center;gap:10px;'
                'background:#FFF7D6;border:1px solid #F4C842;border-radius:8px;'
                'padding:12px 16px;margin-bottom:20px;text-align:left;'
                'font-size:13px;color:#594300;">'
                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"'
                ' stroke="#F4C842" stroke-width="2" stroke-linecap="round"'
                ' stroke-linejoin="round">'
                '<circle cx="12" cy="12" r="10"/>'
                '<line x1="12" y1="8" x2="12" y2="12"/>'
                '<line x1="12" y1="16" x2="12.01" y2="16"/>'
                '</svg>'
                '<span>Your session has expired. Please sign in again to continue.</span>'
                '</div>'
            )
        html = '''<!DOCTYPE html>
<html>
<head>
    <title>Amzur Timesheet Tracker</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #FAFBFC 0%, #DFE1E6 100%);
        }
        .login-card {
            background: white;
            border-radius: 12px;
            box-shadow: 0 8px 30px rgba(9, 30, 66, 0.12), 0 0 1px rgba(9, 30, 66, 0.2);
            padding: 40px 36px;
            width: 100%;
            max-width: 420px;
            text-align: center;
        }
        .app-logo {
            width: 56px;
            height: 56px;
            background: linear-gradient(135deg, #0052CC 0%, #2684FF 100%);
            border-radius: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 20px;
            box-shadow: 0 4px 12px rgba(0, 82, 204, 0.3);
        }
        .app-logo svg {
            width: 30px;
            height: 30px;
        }
        h1 {
            font-size: 22px;
            font-weight: 700;
            color: #172B4D;
            margin-bottom: 6px;
        }
        .subtitle {
            color: #6B778C;
            font-size: 14px;
            line-height: 1.5;
            margin-bottom: 28px;
        }
        .divider {
            height: 1px;
            background: #EBECF0;
            margin-bottom: 28px;
        }
        .login-btn {
            width: 100%;
            height: 48px;
            background: #0052CC;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            transition: background 0.2s, box-shadow 0.2s;
            letter-spacing: 0.2px;
        }
        .login-btn:hover {
            background: #0065FF;
            box-shadow: 0 4px 12px rgba(0, 82, 204, 0.35);
        }
        .login-btn:active {
            background: #0747A6;
            box-shadow: none;
        }
        .login-btn svg {
            flex-shrink: 0;
        }
        .info-text {
            margin-top: 20px;
            font-size: 12px;
            color: #97A0AF;
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <div class="login-card">
        <div class="app-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
            </svg>
        </div>
        <h1>Amzur Timesheet Tracker</h1>
        <p class="subtitle">Sign in with your Atlassian account to start tracking time on this computer.</p>

        <div class="divider"></div>

        <button class="login-btn" onclick="window.location.href='/auth/atlassian'">
            <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
                <path d="M10.68 19.76c-.27-.36-.7-.35-.94.1L4.75 28.67c-.18.35.02.71.4.71h7.79c.2 0 .37-.11.47-.29 1.07-2.14.64-5.37-2.67-10.35l-.06.02z" fill="white" fill-opacity="0.65"/>
                <path d="M15.58 4.67c-2.07 3.53-1.97 7.52.28 11.93.08.16.21.33.4.51l5.42 10.36c.1.18.27.29.47.29h7.79c.38 0 .58-.36.4-.71L17.54 4.67c-.18-.35-.6-.55-.96-.55-.36 0-.78.2-.96.55z" fill="white"/>
            </svg>
            Sign in with Atlassian
        </button>

        <button class="login-btn" style="margin-top:12px;background:#ffffff;color:#3c4043;border:1px solid #dadce0;" onclick="window.location.href='/auth/google'">
            <svg width="20" height="20" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google (no Jira account)
        </button>

        <p class="info-text">Use Atlassian if you have a Jira account. If you don't, sign in with your company Google account to track your time.</p>
    </div>
</body>
</html>'''
        if expired_banner:
            html = html.replace(
                '<div class="login-card">',
                f'<div class="login-card">\n        {expired_banner}',
                1
            )
        return html

    def render_classifications_page(self):
        """Render the App Classification Viewer page.

        Fetches all 3 tiers from /api/classifications and displays them in a
        filterable table.  Effective rules (the one that wins the in-memory
        merge) are computed in JS by buildEffectiveMap().
        """
        port = self.web_port
        html = f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>App Classification Rules</title>
    <style>
        *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
            background: #0f1117;
            color: #e2e8f0;
            min-height: 100vh;
        }}
        /* ── Nav ── */
        nav {{
            background: #1a1d27;
            border-bottom: 1px solid #2d3149;
            padding: 0 24px;
            display: flex;
            align-items: center;
            gap: 16px;
            height: 56px;
        }}
        nav a {{ color: #94a3b8; text-decoration: none; font-size: 14px; padding: 4px 8px; border-radius: 4px; }}
        nav a:hover {{ background: #2d3149; color: #e2e8f0; }}
        nav .brand {{ font-weight: 700; font-size: 16px; color: #6366f1; margin-right: auto; }}
        /* ── Header ── */
        .page-header {{
            background: #1a1d27;
            border-bottom: 1px solid #2d3149;
            padding: 20px 24px;
        }}
        .page-header h1 {{ font-size: 22px; font-weight: 700; color: #f1f5f9; }}
        .page-header .subtitle {{ font-size: 13px; color: #64748b; margin-top: 4px; }}
        /* ── Current window banner ── */
        #current-banner {{
            margin: 16px 24px 0;
            background: #1e2233;
            border: 1px solid #2d3149;
            border-radius: 8px;
            padding: 12px 16px;
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 14px;
        }}
        #current-banner .label {{ color: #64748b; min-width: 100px; }}
        #current-app-name {{ font-weight: 600; color: #f1f5f9; }}
        #current-app-cls  {{ font-weight: 600; }}
        .cls-productive   {{ color: #22c55e; }}
        .cls-non_productive {{ color: #ef4444; }}
        .cls-private      {{ color: #94a3b8; }}
        /* ── Summary cards ── */
        .summary-bar {{
            display: flex;
            gap: 12px;
            margin: 16px 24px;
            flex-wrap: wrap;
        }}
        .summary-card {{
            background: #1e2233;
            border: 1px solid #2d3149;
            border-radius: 8px;
            padding: 12px 20px;
            flex: 1;
            min-width: 120px;
            text-align: center;
        }}
        .summary-card .num {{ font-size: 24px; font-weight: 700; color: #6366f1; }}
        .summary-card .lbl {{ font-size: 12px; color: #64748b; margin-top: 2px; }}
        /* ── Controls ── */
        .controls {{
            display: flex;
            gap: 10px;
            padding: 0 24px 16px;
            flex-wrap: wrap;
            align-items: center;
        }}
        .controls input[type=text] {{
            background: #1e2233;
            border: 1px solid #2d3149;
            border-radius: 6px;
            color: #e2e8f0;
            font-size: 13px;
            padding: 7px 12px;
            flex: 1;
            min-width: 200px;
        }}
        .controls select {{
            background: #1e2233;
            border: 1px solid #2d3149;
            border-radius: 6px;
            color: #e2e8f0;
            font-size: 13px;
            padding: 7px 12px;
            min-width: 160px;
        }}
        .btn {{
            background: #6366f1;
            color: #fff;
            border: none;
            border-radius: 6px;
            padding: 7px 14px;
            font-size: 13px;
            cursor: pointer;
            white-space: nowrap;
        }}
        .btn:hover  {{ background: #4f46e5; }}
        .btn:active {{ background: #4338ca; }}
        .btn-secondary {{
            background: #2d3149;
            color: #e2e8f0;
        }}
        .btn-secondary:hover {{ background: #374151; }}
        /* ── Tab strip ── */
        .tabs {{
            display: flex;
            gap: 4px;
            padding: 0 24px 12px;
            border-bottom: 1px solid #2d3149;
            margin-bottom: 0;
        }}
        .tab {{
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 13px;
            cursor: pointer;
            color: #64748b;
            border: 1px solid transparent;
        }}
        .tab.active {{ background: #2d3149; color: #f1f5f9; border-color: #3d4566; }}
        .tab:hover:not(.active) {{ color: #94a3b8; background: #1e2233; }}
        /* ── Table ── */
        .table-wrap {{
            padding: 16px 24px 40px;
            overflow-x: auto;
        }}
        table {{
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }}
        th {{
            background: #1e2233;
            color: #64748b;
            font-weight: 600;
            text-align: left;
            padding: 10px 12px;
            border-bottom: 1px solid #2d3149;
            white-space: nowrap;
        }}
        td {{
            padding: 9px 12px;
            border-bottom: 1px solid #1a1d27;
            vertical-align: middle;
        }}
        tr:hover td {{ background: #1e2233; }}
        .mono {{ font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; }}
        /* ── Badges ── */
        .badge {{
            display: inline-block;
            border-radius: 4px;
            padding: 2px 8px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }}
        .badge-productive  {{ background: #14532d; color: #22c55e; }}
        .badge-non_productive {{ background: #450a0a; color: #ef4444; }}
        .badge-private     {{ background: #1e293b; color: #94a3b8; }}
        .badge-global      {{ background: transparent; color: #94a3b8; border: 1px solid #374151; }}
        .badge-organization {{ background: #1e1b4b; color: #a5b4fc; }}
        .badge-project     {{ background: #431407; color: #fb923c; }}
        .badge-effective   {{ background: #14532d; color: #22c55e; }}
        .badge-overridden  {{ background: #1e293b; color: #64748b; font-style: italic; }}
        /* ── Empty state ── */
        .empty-state {{
            text-align: center;
            padding: 60px 20px;
            color: #64748b;
        }}
        .empty-state h3 {{ font-size: 18px; margin-bottom: 8px; color: #94a3b8; }}
        /* ── Loading ── */
        #loading {{
            text-align: center;
            padding: 60px;
            color: #64748b;
        }}
    </style>
</head>
<body>
<nav>
    <span class="brand">&#x23F1; TimeTracker</span>
    <a href="/">Dashboard</a>
    <a href="/admin">Admin</a>
    <a href="/classifications" style="color:#6366f1">App Rules</a>
</nav>

<div class="page-header">
    <h1>App Classification Rules</h1>
    <p class="subtitle">Rules are applied in priority order: Project &gt; Organization &gt; Global</p>
</div>

<div id="current-banner">
    <span class="label">Current window:</span>
    <span id="current-app-name">&#x2014;</span>
    <span id="current-app-cls"></span>
    <span style="margin-left:auto;font-size:12px;color:#475569" id="sync-info"></span>
    <button class="btn btn-secondary" id="refresh-btn" onclick="refreshRules()">&#x21bb; Refresh Rules</button>
</div>

<div class="summary-bar" id="summary-bar">
    <div class="summary-card"><div class="num" id="s-total">&#x2026;</div><div class="lbl">Total Effective</div></div>
    <div class="summary-card"><div class="num" style="color:#22c55e" id="s-prod">&#x2026;</div><div class="lbl">Productive</div></div>
    <div class="summary-card"><div class="num" style="color:#ef4444" id="s-nonprod">&#x2026;</div><div class="lbl">Non-Productive</div></div>
    <div class="summary-card"><div class="num" style="color:#94a3b8" id="s-proc">&#x2026;</div><div class="lbl">Process Rules</div></div>
    <div class="summary-card"><div class="num" style="color:#94a3b8" id="s-url">&#x2026;</div><div class="lbl">URL Rules</div></div>
</div>

<div class="controls">
    <input type="text" id="search-input" placeholder="Search by app name or URL pattern&#x2026;"
           oninput="renderTable()">
    <select id="filter-cls" onchange="renderTable()">
        <option value="">All Classifications</option>
        <option value="productive">Productive</option>
        <option value="non_productive">Non-Productive</option>
        <option value="private">Private</option>
    </select>
    <select id="filter-source" onchange="renderTable()">
        <option value="">All Sources</option>
        <option value="global">Global</option>
        <option value="organization">Organization</option>
        <option value="project">Project</option>
    </select>
    <select id="filter-project" onchange="renderTable()" style="display:none">
        <option value="">All Projects</option>
    </select>
    <select id="filter-type" onchange="renderTable()">
        <option value="">All Types</option>
        <option value="process">Process</option>
        <option value="url">URL</option>
    </select>
</div>

<div class="tabs">
    <span class="tab active" data-tab="all" onclick="switchTab('all')">All Rules</span>
    <span class="tab" data-tab="productive" onclick="switchTab('productive')">Productive</span>
    <span class="tab" data-tab="non_productive" onclick="switchTab('non_productive')">Non-Productive</span>
    <span class="tab" data-tab="private" onclick="switchTab('private')">Private</span>
</div>

<div class="table-wrap">
    <div id="loading">Loading classification rules&#x2026;</div>
    <table id="rules-table" style="display:none">
        <thead>
            <tr>
                <th>App / URL Pattern</th>
                <th>Display Name</th>
                <th>Type</th>
                <th>Classification</th>
                <th>Source</th>
                <th>Project</th>
                <th>Status</th>
            </tr>
        </thead>
        <tbody id="table-body"></tbody>
    </table>
    <div id="empty-state" class="empty-state" style="display:none">
        <h3>No rules found</h3>
        <p>Try adjusting your filters or refreshing the rules.</p>
    </div>
</div>

<script>
/* ── State ───────────────────────────────────────────────── */
let allRows = [];   // flat array of rule objects with .source, .source_project_key etc.
let effectiveMap = {{}};  // key -> true if this row is the "winning" rule
let currentTab = 'all';

/* ── Boot ────────────────────────────────────────────────── */
async function loadData() {{
    try {{
        const resp = await fetch('/api/classifications');
        if (!resp.ok) throw new Error(await resp.text());
        const json = await resp.json();

        // Populate project filter
        const proj = json.known_projects || [];
        const projSel = document.getElementById('filter-project');
        proj.forEach(pk => {{
            const o = document.createElement('option');
            o.value = pk; o.textContent = pk;
            projSel.appendChild(o);
        }});
        if (proj.length > 0) projSel.style.display = '';

        // Flatten all tiers into allRows
        const data = json.data || {{}};
        allRows = [];
        (data.global || []).forEach(r => allRows.push(r));
        (data.organization || []).forEach(r => allRows.push(r));
        Object.entries(data.project || {{}}).forEach(([pk, rows]) => rows.forEach(r => allRows.push(r)));

        // Build effective map — project wins over org wins over global
        effectiveMap = buildEffectiveMap(allRows);

        // Summary
        const s = json.summary || {{}};
        document.getElementById('s-total').textContent = s.total_effective ?? '-';
        document.getElementById('s-prod').textContent = s.productive ?? '-';
        document.getElementById('s-nonprod').textContent = s.non_productive ?? '-';
        document.getElementById('s-proc').textContent = s.process_rules ?? '-';
        document.getElementById('s-url').textContent = s.url_rules ?? '-';

        // Current window
        const cw = json.current_window || {{}};
        updateCurrentWindow(cw.app, cw.classification);

        // Sync timestamp
        if (json.last_synced) {{
            const d = new Date(json.last_synced * 1000);
            document.getElementById('sync-info').textContent = 'Last synced: ' + d.toLocaleTimeString();
        }}

        document.getElementById('loading').style.display = 'none';
        renderTable();

    }} catch(e) {{
        document.getElementById('loading').textContent = 'Failed to load: ' + e.message;
    }}
}}

/* Build a map of rule unique-key -> true for the winning (highest-priority) entry.
   Priority: project (2) > organization (1) > global (0).
   Within a tier, last-writer-wins is acceptable; ties are resolved alphabetically. */
function buildEffectiveMap(rows) {{
    const PRIORITY = {{ global: 0, organization: 1, project: 2 }};
    const best = {{}};  // canonical_key -> {{ priority, row_ref }}
    rows.forEach(r => {{
        const ck = (r.identifier || '').toLowerCase() + '|' + r.match_by;
        const p = PRIORITY[r.source] ?? 0;
        if (best[ck] === undefined || p > best[ck].priority) {{
            best[ck] = {{ priority: p, row: r }};
        }}
    }});
    const map = {{}};
    Object.values(best).forEach(b => {{
        const rk = rowKey(b.row);
        map[rk] = true;
    }});
    return map;
}}

function rowKey(r) {{
    return (r.identifier || '') + '|' + r.match_by + '|' + r.source + '|' + (r.source_project_key || '');
}}

/* ── Render table ────────────────────────────────────────── */
function renderTable() {{
    const search  = (document.getElementById('search-input').value || '').toLowerCase();
    const fCls    = document.getElementById('filter-cls').value;
    const fSrc    = document.getElementById('filter-source').value;
    const fProj   = document.getElementById('filter-project').value;
    const fType   = document.getElementById('filter-type').value;

    const filtered = allRows.filter(r => {{
        if (currentTab !== 'all' && r.classification !== currentTab) return false;
        if (fCls    && r.classification !== fCls) return false;
        if (fSrc    && r.source !== fSrc) return false;
        if (fProj   && r.source_project_key !== fProj) return false;
        if (fType   && r.match_by !== fType) return false;
        if (search) {{
            const hay = ((r.identifier || '') + ' ' + (r.display_name || '')).toLowerCase();
            if (!hay.includes(search)) return false;
        }}
        return true;
    }});

    const tbody = document.getElementById('table-body');
    tbody.innerHTML = '';

    if (filtered.length === 0) {{
        document.getElementById('rules-table').style.display = 'none';
        document.getElementById('empty-state').style.display = '';
        return;
    }}
    document.getElementById('rules-table').style.display = '';
    document.getElementById('empty-state').style.display = 'none';

    filtered.forEach(r => {{
        const isEffective = effectiveMap[rowKey(r)];
        const clsBadge = `<span class="badge badge-${{r.classification}}">${{clsLabel(r.classification)}}</span>`;
        const srcBadge = `<span class="badge badge-${{r.source}}">${{r.source}}</span>`;
        const statusBadge = isEffective
            ? '<span class="badge badge-effective">&#x2713; Effective</span>'
            : '<span class="badge badge-overridden">Overridden</span>';

        const tr = document.createElement('tr');
        if (!isEffective) tr.style.opacity = '0.55';
        tr.innerHTML = `
            <td class="mono">${{esc(r.identifier)}}</td>
            <td>${{esc(r.display_name || r.identifier)}}</td>
            <td><span style="color:#94a3b8;font-size:12px">${{r.match_by}}</span></td>
            <td>${{clsBadge}}</td>
            <td>${{srcBadge}}</td>
            <td style="color:#94a3b8;font-size:12px">${{esc(r.source_project_key || '—')}}</td>
            <td>${{statusBadge}}</td>
        `;
        tbody.appendChild(tr);
    }});
}}

/* ── Helpers ─────────────────────────────────────────────── */
function clsLabel(c) {{
    return {{ productive: 'Productive', non_productive: 'Non-Productive', private: 'Private' }}[c] || c;
}}

function esc(s) {{
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}}

function switchTab(tab) {{
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    renderTable();
}}

function updateCurrentWindow(app, cls) {{
    const nameEl = document.getElementById('current-app-name');
    const clsEl  = document.getElementById('current-app-cls');
    if (app) {{
        nameEl.textContent = app;
        clsEl.textContent  = clsLabel(cls);
        clsEl.className = 'cls-' + (cls || 'private');
    }} else {{
        nameEl.textContent = 'No active window';
        clsEl.textContent  = '';
    }}
}}

async function refreshRules() {{
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Refreshing\u2026';
    try {{
        await fetch('/api/classifications/refresh', {{ method: 'POST' }});
        await loadData();
        btn.textContent = '\u2713 Refreshed';
        setTimeout(() => {{ btn.disabled = false; btn.textContent = '\u21bb Refresh Rules'; }}, 2000);
    }} catch(e) {{
        btn.textContent = 'Error';
        setTimeout(() => {{ btn.disabled = false; btn.textContent = '\u21bb Refresh Rules'; }}, 3000);
    }}
}}

/* Auto-refresh current window every 30s */
setInterval(async () => {{
    try {{
        const r = await fetch('/api/classifications');
        const j = await r.json();
        if (j.current_window) updateCurrentWindow(j.current_window.app, j.current_window.classification);
    }} catch (_) {{}}
}}, 30000);

loadData();
</script>
</body>
</html>'''
        return html

    def render_success_page(self):
        html = '''<!DOCTYPE html>
<html>
<head>
    <title>Login Successful</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
        }
        .success-card {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            width: 100%;
            max-width: 400px;
            padding: 50px 40px;
            text-align: center;
        }
        .success-icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
            box-shadow: 0 8px 25px rgba(40, 167, 69, 0.4);
        }
        .success-icon svg {
            width: 40px;
            height: 40px;
            color: white;
        }
        h1 {
            color: #172B4D;
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 12px;
        }
        p {
            color: #6B778C;
            font-size: 15px;
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <div class="success-card">
        <div class="success-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        </div>
        <h1>Login Successful!</h1>
        <p>You're all set. Time tracking will start automatically in the background.</p>
    </div>
</body>
</html>'''
        return html

    def render_consent_page(self):
        """Render the consent page for screenshot capture"""
        user_email = self.current_user.get('email', 'User') if self.current_user else 'User'
        html = f'''<!DOCTYPE html>
<html>
<head>
    <title>Time Tracker - Consent Required</title>
    <style>
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
        }}
        .consent-card {{
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            width: 100%;
            max-width: 600px;
            padding: 40px;
        }}
        .header {{
            text-align: center;
            margin-bottom: 30px;
        }}
        .header-icon {{
            width: 60px;
            height: 60px;
            background: linear-gradient(135deg, #0052CC 0%, #0065FF 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 16px;
        }}
        .header-icon svg {{
            width: 30px;
            height: 30px;
            color: white;
        }}
        h1 {{
            color: #172B4D;
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 8px;
        }}
        .subtitle {{
            color: #6B778C;
            font-size: 14px;
        }}
        .section {{
            background: #F4F5F7;
            border-radius: 10px;
            padding: 20px;
            margin-bottom: 20px;
        }}
        .section-title {{
            color: #172B4D;
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }}
        .section-title svg {{
            width: 20px;
            height: 20px;
            color: #0052CC;
        }}
        .data-item {{
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 8px 0;
            border-bottom: 1px solid #DFE1E6;
        }}
        .data-item:last-child {{
            border-bottom: none;
        }}
        .data-icon {{
            font-size: 18px;
            width: 24px;
            text-align: center;
        }}
        .data-text {{
            flex: 1;
        }}
        .data-text strong {{
            color: #172B4D;
            display: block;
            font-size: 14px;
        }}
        .data-text span {{
            color: #6B778C;
            font-size: 13px;
        }}
        .third-party {{
            background: #FFF7E6;
            border: 1px solid #FFE4B5;
        }}
        .third-party .section-title svg {{
            color: #FF8B00;
        }}
        .retention {{
            background: #E6FCFF;
            border: 1px solid #B3F5FF;
        }}
        .retention .section-title svg {{
            color: #00B8D9;
        }}
        .buttons {{
            display: flex;
            gap: 12px;
            margin-top: 24px;
        }}
        .btn {{
            flex: 1;
            padding: 14px 24px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }}
        .btn-primary {{
            background: linear-gradient(135deg, #0052CC 0%, #0065FF 100%);
            color: white;
        }}
        .btn-primary:hover {{
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(0, 82, 204, 0.4);
        }}
        .btn-secondary {{
            background: #DFE1E6;
            color: #172B4D;
        }}
        .btn-secondary:hover {{
            background: #C1C7D0;
        }}
        .privacy-link {{
            text-align: center;
            margin-top: 16px;
        }}
        .privacy-link a {{
            color: #0052CC;
            text-decoration: none;
            font-size: 14px;
        }}
        .privacy-link a:hover {{
            text-decoration: underline;
        }}
        .user-info {{
            text-align: center;
            color: #6B778C;
            font-size: 13px;
            margin-bottom: 20px;
        }}
    </style>
</head>
<body>
    <div class="consent-card">
        <div class="header">
            <div class="header-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
            </div>
            <h1>Screenshot Capture Consent</h1>
            <p class="subtitle">Please review what data we collect before starting</p>
        </div>

        <p class="user-info">Logged in as: <strong>{user_email}</strong></p>

        <div class="section">
            <div class="section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                Data We Collect
            </div>
            <div class="data-item">
                <span class="data-icon">📸</span>
                <div class="data-text">
                    <strong>Screenshots</strong>
                    <span>Captured at regular intervals while tracking is active</span>
                </div>
            </div>
            <div class="data-item">
                <span class="data-icon">🪟</span>
                <div class="data-text">
                    <strong>Window Titles</strong>
                    <span>The title of your active application window</span>
                </div>
            </div>
            <div class="data-item">
                <span class="data-icon">📱</span>
                <div class="data-text">
                    <strong>Application Names</strong>
                    <span>Which application is currently in focus</span>
                </div>
            </div>
            <div class="data-item">
                <span class="data-icon">⏱️</span>
                <div class="data-text">
                    <strong>Timestamps</strong>
                    <span>When each screenshot was captured</span>
                </div>
            </div>
            <div class="data-item">
                <span class="data-icon">📋</span>
                <div class="data-text">
                    <strong>Jira Issue Data</strong>
                    <span>Your assigned issues for task matching</span>
                </div>
            </div>
        </div>

        <div class="section third-party">
            <div class="section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                Third-Party Processing
            </div>
            <div class="data-item">
                <span class="data-icon">🤖</span>
                <div class="data-text">
                    <strong>OpenAI</strong>
                    <span>Screenshots are analyzed by AI to identify which Jira task you're working on. OpenAI may retain data for up to 30 days (not used for training).</span>
                </div>
            </div>
            <div class="data-item">
                <span class="data-icon">🗄️</span>
                <div class="data-text">
                    <strong>Supabase</strong>
                    <span>Screenshots and analysis data are stored securely with encryption at rest.</span>
                </div>
            </div>
        </div>

        <div class="section retention">
            <div class="section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                Data Retention & Your Rights
            </div>
            <div class="data-item">
                <span class="data-icon">🗑️</span>
                <div class="data-text">
                    <strong>Retention Period</strong>
                    <span>Screenshots are retained for 90 days, then automatically deleted</span>
                </div>
            </div>
        </div>

        <form action="/consent/submit" method="POST">
            <div class="buttons">
                <button type="submit" name="consent" value="decline" class="btn btn-secondary">
                    I Do Not Agree
                </button>
                <button type="submit" name="consent" value="agree" class="btn btn-primary">
                    I Agree - Start Tracking
                </button>
            </div>
        </form>

        <div class="privacy-link">
            <a href="#" onclick="alert('Privacy policy will be available at your organization\\'s privacy policy URL')">Read Full Privacy Policy</a>
        </div>
    </div>
</body>
</html>'''
        return html

    def render_consent_denied_page(self):
        """Render page when user denies consent"""
        html = '''<!DOCTYPE html>
<html>
<head>
    <title>Time Tracker - Consent Required</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
        }
        .card {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            width: 100%;
            max-width: 450px;
            padding: 50px 40px;
            text-align: center;
        }
        .icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #FF8B00 0%, #FFAB00 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
        }
        .icon svg {
            width: 40px;
            height: 40px;
            color: white;
        }
        h1 {
            color: #172B4D;
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 12px;
        }
        p {
            color: #6B778C;
            font-size: 15px;
            line-height: 1.6;
            margin-bottom: 24px;
        }
        .btn {
            display: inline-block;
            padding: 14px 32px;
            background: linear-gradient(135deg, #0052CC 0%, #0065FF 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            text-decoration: none;
            transition: transform 0.2s, box-shadow 0.2s;
            margin: 8px;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(0, 82, 204, 0.4);
        }
        .btn-secondary {
            background: #DFE1E6;
            color: #172B4D;
        }
        .btn-secondary:hover {
            background: #C1C7D0;
            box-shadow: none;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
        </div>
        <h1>Consent Required</h1>
        <p>
            Screenshot tracking requires your consent to operate. Without consent, we cannot capture screenshots or track your work time.
        </p>
        <p>
            If you change your mind, you can grant consent at any time by clicking the button below.
        </p>
        <a href="/consent" class="btn">Review & Grant Consent</a>
        <button class="btn btn-secondary" onclick="window.close()">Close</button>
    </div>
</body>
</html>'''
        return html

    def _fetch_admin_password(self):
        """Fetch the current admin password directly from Supabase (no cache).
        Returns the password string, or None if the fetch fails."""
        try:
            result = self.supabase.table('tracking_settings') \
                .select('desktop_admin_password') \
                .eq('organization_id', self.organization_id) \
                .is_('project_key', 'null') \
                .limit(1) \
                .execute()
            if result.data and len(result.data) > 0:
                return result.data[0].get('desktop_admin_password')
            return None
        except Exception as e:
            print(f"[ERROR] [Admin] Failed to fetch admin password from server: {e}")
            return None

    def render_admin_locked_page(self):
        html = '''<!DOCTYPE html>
<html>
<head>
    <title>Admin Panel Locked - Time Tracker</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .card {
            background: white;
            border-radius: 12px;
            padding: 40px;
            max-width: 420px;
            width: 90%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        .lock-icon { font-size: 48px; margin-bottom: 16px; }
        h1 { font-size: 22px; color: #333; margin-bottom: 12px; }
        p { color: #666; font-size: 14px; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="card">
        <div class="lock-icon">&#128274;</div>
        <h1>Admin Panel Locked</h1>
        <p>The admin panel is not available until the desktop app has authenticated with the server.
           Please log in via the system tray icon first.</p>
    </div>
</body>
</html>'''
        return html

    def render_admin_login_page(self, error=None):
        error_html = f'<div class="error">{error}</div>' if error else ''
        html = f'''<!DOCTYPE html>
<html>
<head>
    <title>Admin Login - Time Tracker</title>
    <style>
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            padding: 20px;
        }}
        .login-card {{
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
            width: 100%;
            max-width: 400px;
            overflow: hidden;
        }}
        .card-header {{
            background: linear-gradient(135deg, #e94560 0%, #ff6b6b 100%);
            padding: 30px;
            text-align: center;
        }}
        .card-header h1 {{
            color: white;
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 8px;
        }}
        .card-header p {{
            color: rgba(255, 255, 255, 0.85);
            font-size: 14px;
        }}
        .shield-icon {{
            width: 60px;
            height: 60px;
            background: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 16px;
            font-size: 28px;
        }}
        .card-body {{
            padding: 30px;
        }}
        .form-group {{
            margin-bottom: 20px;
        }}
        .form-group label {{
            display: block;
            color: #172B4D;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
        }}
        .form-group input {{
            width: 100%;
            padding: 14px 16px;
            border: 2px solid #e9ecef;
            border-radius: 10px;
            font-size: 16px;
            transition: border-color 0.2s;
        }}
        .form-group input:focus {{
            outline: none;
            border-color: #e94560;
        }}
        .login-btn {{
            width: 100%;
            padding: 14px 24px;
            background: linear-gradient(135deg, #e94560 0%, #ff6b6b 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }}
        .login-btn:hover {{
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(233, 69, 96, 0.4);
        }}
        .error {{
            background: #f8d7da;
            color: #721c24;
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
        }}
        .back-link {{
            display: block;
            text-align: center;
            margin-top: 20px;
            color: #6B778C;
            text-decoration: none;
            font-size: 14px;
        }}
        .back-link:hover {{
            color: #172B4D;
        }}
    </style>
</head>
<body>
    <div class="login-card">
        <div class="card-header">
            <div class="shield-icon">&#128272;</div>
            <h1>Admin Access</h1>
            <p>Enter password to access admin panel</p>
        </div>
        <div class="card-body">
            {error_html}
            <form method="POST" action="/admin/login">
                <div class="form-group">
                    <label for="password">Admin Password</label>
                    <input type="password" id="password" name="password" placeholder="Enter admin password" required autofocus>
                </div>
                <button type="submit" class="login-btn">Access Admin Panel</button>
            </form>
            <a href="/" class="back-link">Back to Application</a>
        </div>
    </div>
</body>
</html>'''
        return html

    def render_settings_page(self):
        """Render the user settings page (accessible to all users)"""
        html = '''<!DOCTYPE html>
<html>
<head>
    <title>Settings - Time Tracker</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            min-height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 40px 20px;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        .card {
            background: white;
            border-radius: 16px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            overflow: hidden;
        }
        .card-header {
            background: linear-gradient(135deg, #0052CC 0%, #2684FF 100%);
            color: white;
            padding: 24px;
            text-align: center;
        }
        .card-header h1 {
            font-size: 24px;
            margin-bottom: 8px;
        }
        .card-header p {
            opacity: 0.9;
            font-size: 14px;
        }
        .card-body {
            padding: 32px;
        }
        .setting-section {
            margin-bottom: 28px;
            padding-bottom: 28px;
            border-bottom: 1px solid #e5e7eb;
        }
        .setting-section:last-child {
            margin-bottom: 0;
            padding-bottom: 0;
            border-bottom: none;
        }
        .setting-section h3 {
            font-size: 16px;
            color: #1f2937;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .setting-row {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            margin-bottom: 16px;
        }
        .setting-row:last-child {
            margin-bottom: 0;
        }
        .setting-info {
            flex: 1;
            padding-right: 16px;
        }
        .setting-label {
            font-weight: 500;
            color: #374151;
            margin-bottom: 4px;
        }
        .setting-description {
            font-size: 13px;
            color: #6b7280;
        }
        .toggle-switch {
            position: relative;
            width: 48px;
            height: 26px;
            flex-shrink: 0;
        }
        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #d1d5db;
            border-radius: 26px;
            transition: 0.3s;
        }
        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 20px;
            width: 20px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            border-radius: 50%;
            transition: 0.3s;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        input:checked + .toggle-slider {
            background-color: #0052CC;
        }
        input:checked + .toggle-slider:before {
            transform: translateX(22px);
        }
        .duration-chips {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 12px;
        }
        .duration-chip {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 14px;
            background: #f3f4f6;
            border-radius: 20px;
            cursor: pointer;
            transition: all 0.2s;
            border: 2px solid transparent;
        }
        .duration-chip:hover {
            background: #e5e7eb;
        }
        .duration-chip.selected {
            background: #dbeafe;
            border-color: #0052CC;
        }
        .duration-chip input {
            display: none;
        }
        .duration-chip span {
            font-size: 14px;
            color: #374151;
            font-weight: 500;
        }
        .number-input {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-top: 8px;
        }
        .number-input input {
            width: 80px;
            padding: 10px 12px;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            font-size: 16px;
            text-align: center;
        }
        .number-input input:focus {
            outline: none;
            border-color: #0052CC;
        }
        .number-input span {
            color: #6b7280;
            font-size: 14px;
        }
        .status-message {
            margin-top: 20px;
            padding: 12px 16px;
            border-radius: 8px;
            text-align: center;
            font-weight: 500;
            display: none;
        }
        .status-message.success {
            display: block;
            background: #d1fae5;
            color: #065f46;
        }
        .status-message.error {
            display: block;
            background: #fee2e2;
            color: #991b1b;
        }
        .back-link {
            display: block;
            text-align: center;
            margin-top: 20px;
            color: white;
            text-decoration: none;
            font-size: 14px;
            opacity: 0.9;
        }
        .back-link:hover {
            opacity: 1;
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="card">
            <div class="card-header">
                <h1>&#9881; Settings</h1>
                <p>Configure your Time Tracker preferences</p>
            </div>
            <div class="card-body">
                <!-- NOTE: Pause feature is disabled (not a confirmed feature yet)
                <div class="setting-section">
                    <h3>&#9208; Pause Options</h3>

                    <div class="setting-row">
                        <div class="setting-info">
                            <div class="setting-label">Enable timed pause</div>
                            <div class="setting-description">Show duration options when you pause tracking</div>
                        </div>
                        <label class="toggle-switch">
                            <input type="checkbox" id="timed-pause-enabled" onchange="saveSettings()">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <div class="setting-info" style="margin-top: 16px;">
                        <div class="setting-label">Quick preset durations</div>
                        <div class="setting-description">Select which preset durations to show as quick buttons. You can always enter any custom duration in the pause popup.</div>
                    </div>
                    <div class="duration-chips" id="pause-durations">
                        <label class="duration-chip" onclick="toggleDuration(this)">
                            <input type="checkbox" value="5">
                            <span>5 min</span>
                        </label>
                        <label class="duration-chip" onclick="toggleDuration(this)">
                            <input type="checkbox" value="10">
                            <span>10 min</span>
                        </label>
                        <label class="duration-chip" onclick="toggleDuration(this)">
                            <input type="checkbox" value="15">
                            <span>15 min</span>
                        </label>
                        <label class="duration-chip" onclick="toggleDuration(this)">
                            <input type="checkbox" value="30">
                            <span>30 min</span>
                        </label>
                        <label class="duration-chip" onclick="toggleDuration(this)">
                            <input type="checkbox" value="60">
                            <span>60 min</span>
                        </label>
                    </div>
                </div>

                <div class="setting-section">
                    <h3>&#128276; Notifications</h3>

                    <div class="setting-row">
                        <div class="setting-info">
                            <div class="setting-label">Resume notification</div>
                            <div class="setting-description">Show a notification when tracking auto-resumes</div>
                        </div>
                        <label class="toggle-switch">
                            <input type="checkbox" id="show-resume-notification" onchange="saveSettings()">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <div class="setting-row">
                        <div class="setting-info">
                            <div class="setting-label">Pause reminders</div>
                            <div class="setting-description">Remind you when you've been paused for a while</div>
                        </div>
                        <label class="toggle-switch">
                            <input type="checkbox" id="pause-reminder-enabled" onchange="saveSettings()">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>

                    <div class="setting-info" style="margin-top: 16px;">
                        <div class="setting-label">Reminder interval</div>
                        <div class="setting-description">How often to remind you while paused</div>
                    </div>
                    <div class="number-input">
                        <input type="number" id="pause-reminder-interval" min="5" max="120" value="30" onchange="saveSettings()">
                        <span>minutes</span>
                    </div>
                </div>
                -->

                <div id="status-message" class="status-message"></div>
            </div>
        </div>
        <a href="/" class="back-link">&#8592; Back to Time Tracker</a>
    </div>

    <script>
        // Load settings on page load
        function loadSettings() {
            fetch('/api/pause-settings')
                .then(r => r.json())
                .then(data => {
                    if (data.success && data.settings) {
                        const s = data.settings;

                        document.getElementById('timed-pause-enabled').checked = s.timed_pause_enabled;
                        document.getElementById('show-resume-notification').checked = s.show_resume_notification;
                        document.getElementById('pause-reminder-enabled').checked = s.pause_reminder_enabled;
                        document.getElementById('pause-reminder-interval').value = s.pause_reminder_interval;

                        // Set duration chips
                        const durations = s.pause_durations || [];
                        document.querySelectorAll('#pause-durations .duration-chip').forEach(chip => {
                            const val = parseInt(chip.querySelector('input').value);
                            const isSelected = durations.includes(val);
                            chip.querySelector('input').checked = isSelected;
                            chip.classList.toggle('selected', isSelected);
                        });
                    }
                })
                .catch(err => console.error('Error loading settings:', err));
        }

        // Toggle duration chip selection
        function toggleDuration(chip) {
            const input = chip.querySelector('input');
            input.checked = !input.checked;
            chip.classList.toggle('selected', input.checked);
            saveSettings();
        }

        // Save settings
        function saveSettings() {
            const settings = {
                timed_pause_enabled: document.getElementById('timed-pause-enabled').checked,
                show_resume_notification: document.getElementById('show-resume-notification').checked,
                pause_reminder_enabled: document.getElementById('pause-reminder-enabled').checked,
                pause_reminder_interval: parseInt(document.getElementById('pause-reminder-interval').value) || 30
            };

            // Collect selected durations
            const durations = [];
            document.querySelectorAll('#pause-durations .duration-chip input:checked').forEach(cb => {
                durations.push(parseInt(cb.value));
            });
            settings.pause_durations = durations.length > 0 ? durations : [5, 10, 15, 30, 60];

            fetch('/api/pause-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            })
            .then(r => r.json())
            .then(data => {
                const statusEl = document.getElementById('status-message');
                if (data.success) {
                    statusEl.textContent = '\\u2713 Settings saved!';
                    statusEl.className = 'status-message success';
                } else {
                    statusEl.textContent = 'Failed to save: ' + (data.error || 'Unknown error');
                    statusEl.className = 'status-message error';
                }
                setTimeout(() => { statusEl.className = 'status-message'; }, 3000);
            })
            .catch(err => {
                const statusEl = document.getElementById('status-message');
                statusEl.textContent = 'Failed to save settings';
                statusEl.className = 'status-message error';
            });
        }

        // Initialize
        loadSettings();
    </script>
</body>
</html>'''
        return html

    def render_admin_dashboard(self):
        html = '''<!DOCTYPE html>
<html>
<head>
    <title>Admin Dashboard - Time Tracker</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            min-height: 100vh;
            background: #1a1a2e;
            color: #fff;
        }
        .navbar {
            background: linear-gradient(135deg, #e94560 0%, #ff6b6b 100%);
            padding: 16px 24px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .navbar h1 {
            font-size: 20px;
            font-weight: 600;
        }
        .navbar-actions {
            display: flex;
            gap: 12px;
        }
        .nav-btn {
            background: rgba(255, 255, 255, 0.2);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            text-decoration: none;
        }
        .nav-btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 24px;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 24px;
            margin-bottom: 24px;
        }
        @media (max-width: 1200px) {
            .grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }
        @media (max-width: 768px) {
            .grid {
                grid-template-columns: 1fr;
            }
        }
        .card {
            background: #16213e;
            border-radius: 12px;
            overflow: hidden;
        }
        .card-header {
            background: rgba(255, 255, 255, 0.05);
            padding: 16px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .card-header h2 {
            font-size: 16px;
            font-weight: 600;
        }
        .card-body {
            padding: 20px;
        }
        .status-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
        }
        .status-item {
            background: rgba(255, 255, 255, 0.05);
            padding: 16px;
            border-radius: 8px;
        }
        .status-label {
            font-size: 12px;
            color: #8b8fa3;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 6px;
        }
        .status-value {
            font-size: 18px;
            font-weight: 600;
        }
        .status-value.active { color: #4ade80; }
        .status-value.inactive { color: #f87171; }
        .status-value.warning { color: #fbbf24; }
        /* Update badge styles */
        .update-badge {
            display: inline-block;
            margin-left: 10px;
            padding: 3px 8px;
            background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%);
            border-radius: 12px;
            font-size: 11px;
            font-weight: 500;
            animation: pulse-badge 2s infinite;
        }
        .update-badge a {
            color: white;
            text-decoration: none;
        }
        .update-badge a:hover {
            text-decoration: underline;
        }
        .update-badge.mandatory {
            background: linear-gradient(135deg, #FF5722 0%, #E64A19 100%);
        }
        @keyframes pulse-badge {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }
        .control-btn {
            width: 100%;
            padding: 12px 16px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            margin-bottom: 10px;
            transition: transform 0.2s, opacity 0.2s;
        }
        .control-btn:hover {
            transform: translateY(-1px);
            opacity: 0.9;
        }
        .control-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        .control-btn.primary {
            background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
            color: #000;
        }
        .control-btn.danger {
            background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
            color: #fff;
        }
        .control-btn.warning {
            background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
            color: #000;
        }
        .control-btn.success {
            background: linear-gradient(135deg, #34d399 0%, #10b981 100%);
            color: #000;
        }
        .control-btn.secondary {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }
        .logs-container {
            background: #0f0f1a;
            border-radius: 8px;
            height: 450px;
            overflow-y: auto;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 13px;
        }
        .log-entry {
            padding: 10px 14px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
            gap: 12px;
            transition: background 0.15s;
        }
        .log-entry:hover {
            background: rgba(255, 255, 255, 0.04);
        }
        .log-entry.screenshot { background: rgba(74, 222, 128, 0.05); border-left: 3px solid #4ade80; }
        .log-entry.window-switch { background: rgba(96, 165, 250, 0.05); border-left: 3px solid #60a5fa; }
        .log-entry.settings { background: rgba(251, 191, 36, 0.05); border-left: 3px solid #fbbf24; }
        .log-entry.tracking { background: rgba(167, 139, 250, 0.05); border-left: 3px solid #a78bfa; }
        .log-entry.user { background: rgba(236, 72, 153, 0.05); border-left: 3px solid #ec4899; }
        .log-entry.error { background: rgba(248, 113, 113, 0.08); border-left: 3px solid #f87171; }
        .log-entry.warning { background: rgba(251, 191, 36, 0.08); border-left: 3px solid #fbbf24; }
        .log-icon {
            font-size: 16px;
            width: 24px;
            text-align: center;
            flex-shrink: 0;
        }
        .log-time {
            color: #6b7280;
            flex-shrink: 0;
            font-size: 11px;
            min-width: 70px;
        }
        .log-level {
            font-weight: 600;
            flex-shrink: 0;
            width: 50px;
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 4px;
            text-align: center;
        }
        .log-level.INFO { color: #4ade80; background: rgba(74, 222, 128, 0.15); }
        .log-level.WARN { color: #fbbf24; background: rgba(251, 191, 36, 0.15); }
        .log-level.ERROR { color: #f87171; background: rgba(248, 113, 113, 0.15); }
        .log-message {
            color: #e5e7eb;
            word-break: break-word;
            flex: 1;
        }
        .log-message .app-name { color: #60a5fa; font-weight: 500; }
        .log-message .duration { color: #4ade80; font-weight: 500; }
        .log-message .user-email { color: #ec4899; }
        .log-message .setting-value { color: #fbbf24; font-weight: 500; }
        .log-details {
            display: none;
            margin-top: 8px;
            padding: 10px 12px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 6px;
            font-size: 11px;
            line-height: 1.6;
            border-left: 2px solid rgba(255, 255, 255, 0.1);
        }
        .log-entry.expanded .log-details {
            display: block;
        }
        .log-details-row {
            display: flex;
            gap: 8px;
            padding: 2px 0;
        }
        .log-details-label {
            color: #6b7280;
            min-width: 70px;
            flex-shrink: 0;
        }
        .log-details-value {
            color: #e5e7eb;
            word-break: break-all;
        }
        .log-details-value.file { color: #fbbf24; }
        .log-details-value.id { color: #a78bfa; font-family: monospace; }
        .log-details-value.storage { color: #6b7280; font-family: monospace; font-size: 10px; }
        .log-details-value.size { color: #60a5fa; }
        .log-details-value.time { color: #4ade80; }
        .log-details-value.app { color: #60a5fa; font-weight: 500; }
        .log-details-value.title { color: #9ca3af; font-style: italic; }
        .log-expand-btn {
            background: none;
            border: none;
            color: #6b7280;
            cursor: pointer;
            font-size: 10px;
            padding: 2px 6px;
            margin-left: 8px;
            border-radius: 3px;
            transition: all 0.15s;
        }
        .log-expand-btn:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }
        .log-entry.expanded .log-expand-btn {
            color: #4ade80;
        }
        .log-content-wrapper {
            flex: 1;
            min-width: 0;
        }
        .logs-toolbar {
            display: flex;
            gap: 12px;
            margin-bottom: 12px;
            flex-wrap: wrap;
        }
        .filter-btn {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .filter-btn:hover, .filter-btn.active {
            background: rgba(255, 255, 255, 0.2);
        }
        .empty-logs {
            color: #6b7280;
            text-align: center;
            padding: 40px;
        }
        .full-width { grid-column: 1 / -1; }
    </style>
</head>
<body>
    <nav class="navbar">
        <h1>&#128272; Admin Dashboard</h1>
        <div class="navbar-actions">
            <a href="/admin-dashboard" class="nav-btn">Status Report</a>
            <a href="/" class="nav-btn">View App</a>
            <a href="/admin/logout" class="nav-btn">Logout</a>
        </div>
    </nav>

    <div class="container">
        <div class="grid">
            <!-- Status Card -->
            <div class="card">
                <div class="card-header">
                    <h2>&#128202; System Status</h2>
                </div>
                <div class="card-body">
                    <div class="status-grid">
                        <div class="status-item">
                            <div class="status-label">Tracking</div>
                            <div id="tracking-status" class="status-value">Loading...</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">User</div>
                            <div id="user-status" class="status-value">Loading...</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">Network</div>
                            <div id="network-status" class="status-value">Loading...</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">Pending Sync</div>
                            <div id="pending-status" class="status-value">Loading...</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Controls Card -->
            <div class="card">
                <div class="card-header">
                    <h2>&#9881; Controls</h2>
                </div>
                <div class="card-body">
                    <button id="btn-start" class="control-btn primary" onclick="controlAction('start_tracking')">
                        &#9654; Start Tracking
                    </button>
                    <button id="btn-stop" class="control-btn danger" onclick="controlAction('stop_tracking')">
                        &#9632; Stop Tracking
                    </button>
                    <!-- NOTE: Pause feature is disabled (not a confirmed feature yet)
                    <button id="btn-pause" class="control-btn warning" onclick="controlAction('pause_tracking')">
                        &#9208; Pause Tracking
                    </button>
                    <button id="btn-resume" class="control-btn success" onclick="controlAction('resume_tracking')">
                        &#9654; Resume Tracking
                    </button>
                    -->
                    <button class="control-btn secondary" onclick="controlAction('force_sync')">
                        &#128259; Force Sync
                    </button>
                    <button class="control-btn secondary" onclick="controlAction('refresh_settings')">
                        &#128260; Refresh Settings
                    </button>
                    <button class="control-btn secondary" onclick="controlAction('clear_logs')">
                        &#128465; Clear Logs
                    </button>
                    <button class="control-btn danger" onclick="clearUserCredentials()">
                        &#128274; Clear User Credentials
                    </button>
                </div>
            </div>

            <!-- Session Info Card -->
            <div class="card">
                <div class="card-header">
                    <h2>&#128337; Session Info</h2>
                </div>
                <div class="card-body">
                    <div class="status-grid">
                        <div class="status-item">
                            <div class="status-label">App Version</div>
                            <div id="version-status" class="status-value">
                                <span id="current-version">Loading...</span>
                                <span id="update-badge" class="update-badge" style="display: none;">
                                    <a href="#" id="update-link" target="_blank">Update Available</a>
                                </span>
                            </div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">Screenshot Interval</div>
                            <div id="interval-status" class="status-value">Loading...</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">Session Start</div>
                            <div id="session-start" class="status-value">Loading...</div>
                        </div>
                        <div class="status-item">
                            <div class="status-label">Screenshots Today</div>
                            <div id="screenshots-today" class="status-value">Loading...</div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Logs Card -->
            <div class="card full-width">
                <div class="card-header">
                    <h2>&#128196; Application Logs</h2>
                </div>
                <div class="card-body">
                    <div class="logs-toolbar">
                        <button class="filter-btn active" onclick="filterLogs('all')">All</button>
                        <button class="filter-btn" onclick="filterLogs('INFO')">Info</button>
                        <button class="filter-btn" onclick="filterLogs('WARN')">Warning</button>
                        <button class="filter-btn" onclick="filterLogs('ERROR')">Error</button>
                        <button class="filter-btn" onclick="loadLogs()" style="margin-left: auto;">&#128260; Refresh</button>
                    </div>
                    <div id="logs-container" class="logs-container">
                        <div class="empty-logs">Loading logs...</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentFilter = 'all';

        function formatLogMessage(message, level) {
            let icon = '📋';
            let category = '';
            let formattedMsg = message;

            // Determine icon and category based on message content
            if (message.includes('Screenshot captured:')) {
                icon = '📸';
                category = 'screenshot';
                // Format: "Screenshot captured: chrome.exe (10s)"
                const match = message.match(/Screenshot captured: (.+?) \\((\\d+)s\\)/);
                if (match) {
                    formattedMsg = `Screenshot captured: <span class="app-name">${match[1]}</span> <span class="duration">(${match[2]}s)</span>`;
                }
            } else if (message.includes('Window switch:')) {
                icon = '🔄';
                category = 'window-switch';
                const match = message.match(/Window switch: (.+)/);
                if (match) {
                    formattedMsg = `Switched to <span class="app-name">${match[1]}</span>`;
                }
            } else if (message.includes('Settings loaded:')) {
                icon = '⚙️';
                category = 'settings';
                const match = message.match(/Settings loaded: interval=(\\d+)s/);
                if (match) {
                    formattedMsg = `Settings loaded: interval = <span class="setting-value">${match[1]}s</span>`;
                }
            } else if (message.includes('Tracking started')) {
                icon = '▶️';
                category = 'tracking';
                const match = message.match(/Tracking started \\(interval: (\\d+)s\\)/);
                if (match) {
                    formattedMsg = `Tracking started (interval: <span class="setting-value">${match[1]}s</span>)`;
                }
            } else if (message.includes('Tracking stopped')) {
                icon = '⏹️';
                category = 'tracking';
            } else if (message.includes('User idle')) {
                icon = '💤';
                category = 'tracking';
                const match = message.match(/User idle \\(no activity for (\\d+)s\\)/);
                if (match) {
                    formattedMsg = `User idle (no activity for <span class="duration">${match[1]}s</span>)`;
                }
            } else if (message.includes('User active')) {
                icon = '✨';
                category = 'tracking';
            } else if (message.includes('granted consent') || message.includes('logged in:')) {
                icon = '👤';
                category = 'user';
                const match = message.match(/User (.+?) granted consent/);
                if (match) {
                    formattedMsg = `<span class="user-email">${match[1]}</span> granted consent`;
                }
            } else if (message.includes('Admin logged in')) {
                icon = '🔐';
                category = 'user';
            } else if (message.includes('Application started')) {
                icon = '🚀';
                category = 'tracking';
            } else if (message.includes('Sync') || message.includes('sync')) {
                icon = '☁️';
                category = 'settings';
            } else if (level === 'ERROR') {
                icon = '❌';
                category = 'error';
            } else if (level === 'WARN') {
                icon = '⚠️';
                category = 'warning';
            }

            return { icon, category, formattedMsg };
        }

        function formatBytes(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        }

        function formatDetails(details, category) {
            if (!details) return '';

            let html = '<div class="log-details">';

            if (category === 'screenshot') {
                // Screenshot details
                if (details.file) html += `<div class="log-details-row"><span class="log-details-label">File:</span><span class="log-details-value file">${details.file}</span></div>`;
                if (details.id) html += `<div class="log-details-row"><span class="log-details-label">ID:</span><span class="log-details-value id">${details.id}</span></div>`;
                if (details.storage) html += `<div class="log-details-row"><span class="log-details-label">Storage:</span><span class="log-details-value storage">${details.storage}</span></div>`;
                if (details.size) html += `<div class="log-details-row"><span class="log-details-label">Size:</span><span class="log-details-value size">${formatBytes(details.size)}</span></div>`;
                if (details.start && details.end) html += `<div class="log-details-row"><span class="log-details-label">Time:</span><span class="log-details-value time">${details.start} → ${details.end}</span></div>`;
                if (details.duration) html += `<div class="log-details-row"><span class="log-details-label">Duration:</span><span class="log-details-value time">${details.duration}s</span></div>`;
                if (details.title) html += `<div class="log-details-row"><span class="log-details-label">Title:</span><span class="log-details-value title">${details.title}</span></div>`;
            } else if (category === 'window-switch') {
                // Window switch details
                if (details.app) html += `<div class="log-details-row"><span class="log-details-label">App:</span><span class="log-details-value app">${details.app}</span></div>`;
                if (details.title) html += `<div class="log-details-row"><span class="log-details-label">Title:</span><span class="log-details-value title">${details.title}</span></div>`;
                if (details.time) html += `<div class="log-details-row"><span class="log-details-label">Time:</span><span class="log-details-value time">${details.time}</span></div>`;
            } else {
                // Generic details
                for (const [key, value] of Object.entries(details)) {
                    html += `<div class="log-details-row"><span class="log-details-label">${key}:</span><span class="log-details-value">${value}</span></div>`;
                }
            }

            html += '</div>';
            return html;
        }

        function toggleLogDetails(btn) {
            const entry = btn.closest('.log-entry');
            entry.classList.toggle('expanded');
            btn.textContent = entry.classList.contains('expanded') ? '▼ Hide' : '▶ Details';
        }

        function loadStatus() {
            fetch('/api/admin/status')
                .then(r => r.json())
                .then(data => {
                    // Tracking status
                    const trackingEl = document.getElementById('tracking-status');
                    // NOTE: Pause feature is disabled (not a confirmed feature yet)
                    // if (data.is_paused) {
                    //     const pauseMins = Math.floor(data.pause_duration_seconds / 60);
                    //     const pauseText = pauseMins > 0 ? ` (${pauseMins}m)` : '';
                    //     trackingEl.textContent = 'Paused' + pauseText;
                    //     trackingEl.className = 'status-value warning';
                    // } else
                    if (data.is_idle) {
                        trackingEl.textContent = 'Idle';
                        trackingEl.className = 'status-value warning';
                    } else if (data.tracking_active) {
                        trackingEl.textContent = 'Active';
                        trackingEl.className = 'status-value active';
                    } else {
                        trackingEl.textContent = 'Stopped';
                        trackingEl.className = 'status-value inactive';
                    }

                    // User status
                    const userEl = document.getElementById('user-status');
                    userEl.textContent = data.current_user || 'Not logged in';
                    userEl.className = data.current_user ? 'status-value active' : 'status-value inactive';

                    // Network status
                    const networkEl = document.getElementById('network-status');
                    networkEl.textContent = data.online ? 'Online' : 'Offline';
                    networkEl.className = data.online ? 'status-value active' : 'status-value warning';

                    // Pending status
                    const pendingEl = document.getElementById('pending-status');
                    pendingEl.textContent = data.offline_pending || '0';
                    pendingEl.className = data.offline_pending > 0 ? 'status-value warning' : 'status-value active';

                    // Session Info card
                    const intervalEl = document.getElementById('interval-status');
                    if (intervalEl) {
                        intervalEl.textContent = (data.screenshot_interval || 30) + 's';
                        intervalEl.className = 'status-value active';
                    }

                    const sessionStartEl = document.getElementById('session-start');
                    if (sessionStartEl && data.session_start) {
                        const startTime = new Date(data.session_start).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
                        sessionStartEl.textContent = startTime;
                        sessionStartEl.className = 'status-value active';
                    } else if (sessionStartEl) {
                        sessionStartEl.textContent = 'N/A';
                        sessionStartEl.className = 'status-value inactive';
                    }

                    const screenshotsTodayEl = document.getElementById('screenshots-today');
                    if (screenshotsTodayEl) {
                        screenshotsTodayEl.textContent = data.screenshots_today || '0';
                        screenshotsTodayEl.className = 'status-value active';
                    }

                    // Version info
                    const currentVersionEl = document.getElementById('current-version');
                    if (currentVersionEl) {
                        currentVersionEl.textContent = 'v' + (data.app_version || '1.0.0');
                    }
                    
                    // Update available badge
                    const updateBadgeEl = document.getElementById('update-badge');
                    const updateLinkEl = document.getElementById('update-link');
                    if (updateBadgeEl && updateLinkEl) {
                        if (data.update_available && data.latest_version) {
                            updateBadgeEl.style.display = 'inline-block';
                            updateLinkEl.textContent = data.is_mandatory_update ? 'Required: v' + data.latest_version : 'v' + data.latest_version + ' Available';
                            updateLinkEl.href = data.download_url || '#';
                            updateLinkEl.title = data.release_notes || 'Click to download update';
                            if (data.is_mandatory_update) {
                                updateBadgeEl.classList.add('mandatory');
                            } else {
                                updateBadgeEl.classList.remove('mandatory');
                            }
                        } else {
                            updateBadgeEl.style.display = 'none';
                        }
                    }

                    // Update buttons visibility and state
                    document.getElementById('btn-start').disabled = data.running;
                    document.getElementById('btn-stop').disabled = !data.running;

                    // NOTE: Pause feature is disabled (not a confirmed feature yet)
                    // const btnPause = document.getElementById('btn-pause');
                    // const btnResume = document.getElementById('btn-resume');
                    // if (btnPause && btnResume) {
                    //     btnPause.style.display = data.tracking_active ? 'inline-block' : 'none';
                    //     btnResume.style.display = (data.is_paused && data.running) ? 'inline-block' : 'none';
                    // }
                })
                .catch(err => console.error('Error loading status:', err));
        }

        function loadLogs() {
            const url = currentFilter === 'all' ? '/api/admin/logs?limit=200' : `/api/admin/logs?level=${currentFilter}&limit=200`;
            fetch(url)
                .then(r => r.json())
                .then(data => {
                    const container = document.getElementById('logs-container');
                    if (!data.logs || data.logs.length === 0) {
                        container.innerHTML = '<div class="empty-logs">No logs available</div>';
                        return;
                    }

                    container.innerHTML = data.logs.reverse().map(log => {
                        const time = new Date(log.timestamp).toLocaleTimeString();
                        const { icon, category, formattedMsg } = formatLogMessage(log.message, log.level);
                        const hasDetails = log.details && Object.keys(log.details).length > 0;
                        const detailsHtml = hasDetails ? formatDetails(log.details, category) : '';
                        const expandBtn = hasDetails ? `<button class="log-expand-btn" onclick="toggleLogDetails(this)">▶ Details</button>` : '';

                        return `
                            <div class="log-entry ${category}">
                                <span class="log-icon">${icon}</span>
                                <span class="log-time">${time}</span>
                                <span class="log-level ${log.level}">${log.level}</span>
                                <div class="log-content-wrapper">
                                    <span class="log-message">${formattedMsg}${expandBtn}</span>
                                    ${detailsHtml}
                                </div>
                            </div>
                        `;
                    }).join('');
                })
                .catch(err => {
                    console.error('Error loading logs:', err);
                    document.getElementById('logs-container').innerHTML = '<div class="empty-logs">Error loading logs</div>';
                });
        }

        function filterLogs(level) {
            currentFilter = level;
            document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
            loadLogs();
        }

        function controlAction(action) {
            fetch('/api/admin/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action })
            })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    loadStatus();
                    loadLogs();
                } else {
                    alert(data.error || 'Action failed');
                }
            })
            .catch(err => {
                console.error('Control action error:', err);
                alert('Failed to execute action');
            });
        }

        function clearUserCredentials() {
            if (!confirm('Are you sure you want to clear user credentials?\\n\\nThis will:\\n- Log out the current user\\n- Clear all stored tokens\\n- Stop tracking\\n\\nThe user will need to login again.')) {
                return;
            }

            fetch('/api/admin/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'clear_user_credentials' })
            })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    alert(data.message || 'User credentials cleared successfully');
                    loadStatus();
                    loadLogs();
                } else {
                    alert(data.error || 'Failed to clear credentials');
                }
            })
            .catch(err => {
                console.error('Clear credentials error:', err);
                alert('Failed to clear credentials');
            });
        }

        // Initial load
        loadStatus();
        loadLogs();

        // Auto-refresh
        setInterval(loadStatus, 5000);
        setInterval(loadLogs, 10000);
    </script>
</body>
</html>'''
        return html

# ============================================================================
# MAIN ENTRY POINT
# ============================================================================

def main():
    """Main entry point"""
    # Setup logging FIRST before anything else
    if APP_LOGGER_AVAILABLE:
        try:
            setup_logging(log_level=logging.INFO)
            logger = get_logger(__name__, 'MAIN')
            logger.info("=" * 70)
            logger.info(f"TimeTracker v{APP_VERSION} starting...")
            logger.info(f"OS: {platform.system()} {platform.release()} {platform.version()}")
            logger.info(f"Python: {sys.version}")
            logger.info(f"Process ID: {os.getpid()}")
            logger.info(f"Executable: {sys.executable}")
            logger.info(f"Log file: {get_log_file_path()}")
            logger.info(f"Screenshot monitoring: {'DISABLED' if SCREENSHOT_MONITORING_HARD_DISABLED else 'ENABLED'}")
            logger.info("=" * 70)
        except Exception as log_error:
            print(f"[WARN] Failed to setup logging: {log_error}")
            traceback.print_exc()
    else:
        print("[WARN] Application logging disabled - app_logger module not available")
    
    try:
        print("[DEBUG-MAIN] Starting TimeTracker initialization...")
        if APP_LOGGER_AVAILABLE:
            logger.info("Initializing TimeTracker application...")
        
        # Log display/monitor environment at startup (P1-6, P1-7 diagnostics)
        log_display_environment()
        
        print("[DEBUG-MAIN] Creating TimeTracker instance...")
        app = TimeTracker()
        print("[DEBUG-MAIN] TimeTracker instance created")
        
        if APP_LOGGER_AVAILABLE:
            logger.info("TimeTracker initialized successfully")
            logger.info("Starting main application loop...")
        
        print("[DEBUG-MAIN] Calling app.run()...")
        app.run()
        print("[DEBUG-MAIN] app.run() returned")
        
    except KeyboardInterrupt:
        if APP_LOGGER_AVAILABLE:
            logger = get_logger(__name__, 'MAIN')
            logger.info("Application stopped by user (KeyboardInterrupt)")
        print("\n[INFO] Application stopped by user")
    except Exception as e:
        if APP_LOGGER_AVAILABLE:
            logger = get_logger(__name__, 'MAIN')
            logger.error(f"Fatal application error: {e}", exc_info=True)
            logger.error("=" * 70)
            logger.error("Application crashed - see traceback above")
            logger.error("=" * 70)
        print(f"[ERROR] Application error: {e}")
        traceback.print_exc()
        input("Press Enter to exit...")
    finally:
        if APP_LOGGER_AVAILABLE:
            logger = get_logger(__name__, 'MAIN')
            logger.info("TimeTracker shutting down...")
            logger.info("=" * 70)

if __name__ == '__main__':
    main()

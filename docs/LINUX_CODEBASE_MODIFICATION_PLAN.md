# JIRAForge — Linux Codebase Modification Plan

> **Date:** March 23, 2026  
> **Scope:** Step-by-step guide to modify the existing Windows-centric codebase for full Linux OS compatibility.  
> **Reference:** [LINUX_OS_ADAPTATION_GUIDE.md](../LINUX_OS_ADAPTATION_GUIDE.md)

---

## Table of Contents

1. [Current State Assessment](#1-current-state-assessment)
2. [Gap Analysis Summary](#2-gap-analysis-summary)
3. [Implementation Phases](#3-implementation-phases)
   - Phase 1: Platform Detection & Conditional Loading
   - Phase 2: Core Linux Module (`desktop_app_linux.py`)
   - Phase 3: Wayland Screenshot Capture
   - Phase 4: OCR — Linux Fallback Engine & AI Server Config
   - Phase 5: Local Storage (SQLite Module)
   - Phase 6: Dependencies & Installation
   - Phase 7: Build & Packaging
4. [File-by-File Modification List](#4-file-by-file-modification-list)
5. [New Files to Create](#5-new-files-to-create)
6. [Dependency Changes](#6-dependency-changes)
7. [Testing Strategy](#7-testing-strategy)
8. [Risk & Mitigation](#8-risk--mitigation)

---

## 1. Current State Assessment

### What Exists Today

| Component | Current State | Linux-Ready? |
|-----------|--------------|-------------|
| **Screenshot Capture** | `PIL.ImageGrab.grab()` — Windows-only on Wayland | ❌ No |
| **Idle Detection** | `pynput` mouse/keyboard listeners | ⚠️ Partial — works on X11, fails on Wayland |
| **Active Window Tracking** | `win32gui.GetForegroundWindow()` + `win32process` | ❌ No |
| **Desktop Notifications** | `winotify` (Windows toast) | ❌ No |
| **Auto-Start** | Windows Registry `HKCU\...\Run` via `winreg` | ❌ No |
| **Single-Instance Lock** | `win32event.CreateMutex()` with lock-file fallback | ⚠️ Partial — lock-file fallback exists but uses `psutil` polling instead of `fcntl.flock()` |
| **Data Directory** | `%LOCALAPPDATA%\TimeTracker` with `~/.local/share` fallback | ⚠️ Partial — hardcodes `TimeTracker` (not lowercase), doesn't use `$XDG_DATA_HOME` |
| **OCR Primary** | WinRT OCR (Windows-native, fast) — config fetched from AI server env | ❌ Windows-only — but `is_available()` auto-skips on Linux; fallbacks take over |
| **OCR Fallback 1** | RapidOCR (ONNX Runtime) — config fetched from AI server env | ✅ Cross-platform — becomes effective primary on Linux |
| **OCR Fallback 2** | EasyOCR (PyTorch) — to be added in AI server env | ✅ Cross-platform — provides fallback on both OS |
| **OCR Engine Framework** | Dynamic factory + facade + auto-installer; config from AI server at runtime | ✅ Ready — plug-in architecture with auto-install exists |
| **OCR Config Source** | AI server `.env` → fetched via `POST /api/auth/ocr-config` after login → pushed into `os.environ` | ✅ Already dynamic — no hardcoded local defaults used in production |
| **Privacy Filter** | `privacy/filter.py` with Presidio + custom patterns | ✅ Cross-platform |
| **Config Manager** | `os.name == 'nt'` check, falls back to `~/.config/` | ⚠️ Partial — doesn't use `$XDG_CONFIG_HOME` |
| **System Event Monitoring** | `ctypes.windll` for sleep/lock detection | ❌ No |
| **Platform Checks** | `WIN32_AVAILABLE` flag, some `sys.platform == 'win32'` guards | ⚠️ Partial — no Linux-specific imports or routing |

### Key Architectural Observations

1. **`desktop_app.py` is ~9,200+ lines** — a monolithic file with Windows-specific code throughout. The adaptation guide wisely recommends a separate `desktop_app_linux.py` module rather than inline Linux code.

2. **OCR engine framework is fully dynamic** — `ocr/engine_factory.py` + `ocr/facade.py` + `ocr/engines/dynamic_engine.py` already support creating engines dynamically from AI server env config. The `auto_installer.py` auto-installs missing pip packages at runtime. **No new OCR engine adapter files are needed** — the dynamic system handles any engine configured in the AI server `.env`.

3. **Privacy filter is already cross-platform** — `privacy/filter.py` uses regex patterns and Presidio (Python-native). No OS-specific code.

4. **Lock-file fallback exists but is weak** — Current `_acquire_lock_file()` polls process names via `psutil`, which is racey. Linux adaptation should use `fcntl.flock()` (kernel-level atomic lock).

5. **No `local_storage/` module exists** — The SQLite-based session tracker and batch uploader described in the guide are entirely absent from the codebase.

---

## 2. Gap Analysis Summary

### Files That Need MODIFICATION

| File | What Changes |
|------|-------------|
| `python-desktop-app/desktop_app.py` | Add `IS_LINUX` detection, conditional imports from `desktop_app_linux`, route 6 functions to Linux implementations |
| `python-desktop-app/requirements.txt` | Add Linux-specific packages with `sys_platform == 'linux'` markers |
| `python-desktop-app/config_manager.py` | Use `$XDG_CONFIG_HOME` and `$XDG_DATA_HOME` environment variables |
| `python-desktop-app/ocr/config.py` | **No changes needed** — config comes from AI server env at runtime, not local defaults |

### Files That Need CREATION

| File | Purpose |
|------|---------|
| `python-desktop-app/desktop_app_linux.py` | All Linux-specific function implementations |
| `python-desktop-app/wayland_screenshot.py` | Wayland ScreenCast Portal + PipeWire + GStreamer + daemon |
| ~~`python-desktop-app/ocr/engines/paddle_engine.py`~~ | ~~NOT NEEDED~~ — RapidOCR already uses PaddleOCR PP-OCRv4 via ONNX Runtime and works cross-platform |
| ~~`python-desktop-app/ocr/engines/tesseract_engine.py`~~ | ~~NOT NEEDED~~ — not in AI server env config; dynamic engine system would handle it if ever added |
| ~~`python-desktop-app/ocr/engines/metadata_engine.py`~~ | ~~NOT NEEDED~~ — not in AI server env config |
| `python-desktop-app/local_storage/__init__.py` | Package init |
| `python-desktop-app/local_storage/sqlite_manager.py` | SQLite DB + schema + CRUD |
| `python-desktop-app/local_storage/session_tracker.py` | Active window session accumulator |
| `python-desktop-app/local_storage/batch_uploader.py` | Batched upload to Supabase |
| `python-desktop-app/install_linux.sh` | Multi-distro dependency installer |

---

## 3. Implementation Phases

### Phase 1: Platform Detection & Conditional Loading

**Goal:** Establish the routing layer so Linux functions are called when running on Linux, while preserving 100% existing Windows functionality.

#### 1.1 — `desktop_app.py`: Add Platform Constants (top of file, after imports)

**Location:** After the existing `WIN32_AVAILABLE` block (~line 199)

```python
# Platform detection
IS_LINUX = sys.platform.startswith('linux')
IS_WINDOWS = sys.platform == 'win32'

# Linux-specific imports
LINUX_FUNCTIONS_AVAILABLE = False
if IS_LINUX:
    try:
        from desktop_app_linux import (
            capture_screenshot_linux,
            get_active_window_linux,
            get_idle_time_linux,
            show_notification_linux,
            acquire_single_instance_lock_linux,
            release_single_instance_lock_linux,
            add_to_startup_linux,
            remove_from_startup_linux,
            is_in_startup_linux,
            get_app_data_dir_linux,
        )
        LINUX_FUNCTIONS_AVAILABLE = True
        print("[OK] Linux platform functions loaded")
    except ImportError as e:
        print(f"[WARN] Linux functions not available: {e}")
```

#### 1.2 — `desktop_app.py`: Route Functions to Linux Implementations

Each Windows-specific function needs a Linux branch. Below are the six core functions that need routing:

**a) `get_app_data_dir()` (~line 683)**

Current code already has a `sys.platform == 'win32'` branch. Modify:

```python
def get_app_data_dir():
    if IS_LINUX and LINUX_FUNCTIONS_AVAILABLE:
        return get_app_data_dir_linux()
    # existing Windows code...
```

**b) `acquire_single_instance_lock()` (~line 218)**

Current code checks `WIN32_AVAILABLE`. Update to use Linux fcntl lock:

```python
def acquire_single_instance_lock():
    global _instance_mutex
    if IS_LINUX and LINUX_FUNCTIONS_AVAILABLE:
        lock_path = os.path.join(get_app_data_dir(), '.lock')
        return acquire_single_instance_lock_linux(lock_path)
    if not WIN32_AVAILABLE:
        return _acquire_lock_file()
    # existing Windows mutex code...
```

**c) `release_single_instance_lock()` (~line 285)**

```python
def release_single_instance_lock():
    global _instance_mutex
    if IS_LINUX and LINUX_FUNCTIONS_AVAILABLE:
        release_single_instance_lock_linux()
        return
    # existing Windows code...
```

**d) `add_to_startup()` / `remove_from_startup()` / `is_in_startup()` (~lines 1141–1230)**

Replace the early `sys.platform != 'win32'` returns with Linux routing:

```python
def add_to_startup():
    if IS_LINUX and LINUX_FUNCTIONS_AVAILABLE:
        exe_path = get_app_executable_path()
        return add_to_startup_linux(APP_NAME, exe_path)
    if sys.platform != 'win32':
        print("[INFO] Auto-start only supported on Windows and Linux")
        return False
    # existing Windows registry code...
```

**e) `get_active_window()` method (TimeTracker class, ~line 7425)**

```python
def get_active_window(self):
    if IS_LINUX and LINUX_FUNCTIONS_AVAILABLE:
        return get_active_window_linux()
    if not WIN32_AVAILABLE:
        return {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown', 'is_new_window': False}
    # existing win32gui code...
```

**f) Screenshot capture**

The screenshot capture in the tracking loop uses `ImageGrab.grab()`. Add routing:

```python
# Inside the tracking loop where screenshot is captured:
if IS_LINUX and LINUX_FUNCTIONS_AVAILABLE:
    screenshot = capture_screenshot_linux()
else:
    screenshot = ImageGrab.grab()
```

**g) Notification function (`show_update_notification` ~line 590)**

```python
def show_update_notification(update_info, callback=None):
    if IS_LINUX and LINUX_FUNCTIONS_AVAILABLE:
        msg = f"v{update_info.get('latest_version')} available"
        return show_notification_linux("Update Available", msg)
    if not WINOTIFY_AVAILABLE:
        # existing fallback...
```

**h) Idle detection (`monitor_user_activity` ~line 7875)**

Idle detection currently uses `pynput`. On Linux/Wayland, add D-Bus idle check before falling back to pynput:

```python
def monitor_user_activity(self):
    if IS_LINUX and LINUX_FUNCTIONS_AVAILABLE:
        # Use D-Bus idle monitoring (Wayland-compatible)
        # get_idle_time_linux() is polled in the tracking loop
        print("[OK] Linux idle detection via D-Bus enabled")
        return
    # existing pynput code...
```

And in the tracking loop idle check, replace the `time.time() - self.last_activity_time` calculation:

```python
if IS_LINUX and LINUX_FUNCTIONS_AVAILABLE:
    idle_duration = get_idle_time_linux()
else:
    idle_duration = time.time() - self.last_activity_time
```

#### 1.3 — `desktop_app.py`: Guard Windows-Only Imports

The `ImageGrab` import at line 25 fails on some Linux setups. Guard it:

```python
try:
    from PIL import Image, ImageGrab, ImageDraw
except ImportError:
    from PIL import Image, ImageDraw
    ImageGrab = None  # Not available on Linux/Wayland
```

#### 1.4 — `desktop_app.py`: Platform-Aware Version Check

Line 498 hardcodes `platform=windows`. Update:

```python
platform_name = 'linux' if IS_LINUX else 'windows'
url = f"{server_url}/api/app-version/check?platform={platform_name}&current={APP_VERSION}"
```

---

### Phase 2: Core Linux Module (`desktop_app_linux.py`)

**Create:** `python-desktop-app/desktop_app_linux.py`

This module implements all Linux-specific functions that `desktop_app.py` conditionally calls.

#### 2.1 — Function Implementations Required

| Function | Implementation | Libraries |
|----------|---------------|-----------|
| `capture_screenshot_linux()` | Delegates to `wayland_screenshot.py` daemon, subprocess fallback | `subprocess`, PIL |
| `get_active_window_linux()` | EWMH via `python-xlib`, `xdotool`/`xprop` fallback | `ewmh`, `python-xlib`, `psutil` |
| `get_idle_time_linux()` | D-Bus call to `org.gnome.Mutter.IdleMonitor.GetIdletime()` | `dbus-python` |
| `show_notification_linux()` | `subprocess.run(['notify-send', ...])` | `libnotify-bin` (system) |
| `acquire_single_instance_lock_linux()` | `fcntl.flock(fd, LOCK_EX \| LOCK_NB)` | `fcntl` (stdlib) |
| `release_single_instance_lock_linux()` | `fcntl.flock(fd, LOCK_UN)` | `fcntl` (stdlib) |
| `add_to_startup_linux()` | Write `.desktop` file to `~/.config/autostart/` | `os` (stdlib) |
| `remove_from_startup_linux()` | Delete `.desktop` file from `~/.config/autostart/` | `os` (stdlib) |
| `is_in_startup_linux()` | Check `.desktop` file existence | `os` (stdlib) |
| `get_app_data_dir_linux()` | `$XDG_DATA_HOME/timetracker`, default `~/.local/share/timetracker` | `os` (stdlib) |

#### 2.2 — Key Implementation Details

**Active Window Tracking — EWMH (primary):**
```python
from ewmh import EWMH
import Xlib.display

def get_active_window_linux():
    try:
        wm = EWMH()
        active = wm.getActiveWindow()
        title = wm.getWmName(active) or ""
        pid = wm.getWmPid(active)
        app_name = psutil.Process(pid).name() if pid else ""
        window_key = f"{app_name}|||{title}"
        return {'title': title, 'app': app_name, 'window_key': window_key, 'is_new_window': True}
    except Exception:
        return _get_active_window_fallback()  # xdotool
```

**Idle Detection — D-Bus:**
```python
import dbus

def get_idle_time_linux():
    bus = dbus.SessionBus()
    proxy = bus.get_object('org.gnome.Mutter.IdleMonitor',
                           '/org/gnome/Mutter/IdleMonitor/Core')
    iface = dbus.Interface(proxy, 'org.gnome.Mutter.IdleMonitor')
    return iface.GetIdletime() / 1000.0  # ms → seconds
```

**Single Instance Lock — fcntl:**
```python
import fcntl

_linux_lock_file = None

def acquire_single_instance_lock_linux(lock_file_path):
    global _linux_lock_file
    _linux_lock_file = open(lock_file_path, 'w')
    try:
        fcntl.flock(_linux_lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        _linux_lock_file.write(str(os.getpid()))
        _linux_lock_file.flush()
        return True
    except (IOError, OSError):
        return False
```

**Auto-Start — XDG Autostart Spec:**
```python
def add_to_startup_linux(app_name, exe_path):
    autostart_dir = os.path.expanduser("~/.config/autostart")
    os.makedirs(autostart_dir, exist_ok=True)
    desktop_entry = f"""[Desktop Entry]
Type=Application
Name={app_name}
Exec={exe_path}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=10
"""
    path = os.path.join(autostart_dir, "timetracker.desktop")
    with open(path, 'w') as f:
        f.write(desktop_entry)
    return True
```

---

### Phase 3: Wayland Screenshot Capture

**Create:** `python-desktop-app/wayland_screenshot.py` (~720 lines)

This is the most complex new module. It implements the XDG ScreenCast Portal protocol with PipeWire and GStreamer.

#### 3.1 — Architecture

```
Desktop App ──[Unix Socket]──→ Screenshot Daemon
                                    │
                                    ├── XDG ScreenCast Portal (D-Bus)
                                    ├── PipeWire stream (file descriptor)
                                    └── GStreamer pipeline:
                                        pipewiresrc → videoconvert → pngenc → filesink
```

#### 3.2 — Implementation Components

| Component | Purpose | Libraries |
|-----------|---------|-----------|
| `_init_screencast_session()` | 4-step D-Bus protocol (CreateSession → SelectSources → Start → OpenPipeWireRemote) | `gi.repository.Gio`, `gi.repository.GLib` |
| `capture_frame()` | GStreamer pipeline to grab single frame from PipeWire stream | `gi.repository.Gst` |
| `ScreenshotDaemon` | Unix socket server keeping PipeWire session alive | `socket`, `threading` |
| `_capture_via_daemon()` | Client sending CAPTURE command to daemon | `socket` |
| `_capture_subprocess()` | Per-capture subprocess fallback | `subprocess` |
| Restore token management | Save/load `~/.local/share/timetracker/.screencast_token` | `os` (stdlib) |

#### 3.3 — Daemon Protocol

| Command | Response | Purpose |
|---------|----------|---------|
| `CAPTURE:/path` | `OK` / `ERROR:msg` | Capture screenshot |
| `PING` | `PONG` | Health check |
| `STATUS` | `STATUS:initialized=True,...` | Session info |
| `RESTART` | `OK:restarted` | Re-initialize session |
| `QUIT` | `OK:stopping` | Graceful shutdown |

#### 3.4 — Required System Packages

```
python3-gi python3-gi-cairo gir1.2-gstreamer-1.0
gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good
```

#### 3.5 — Integration with desktop_app_linux.py

```python
def capture_screenshot_linux():
    """Try daemon first, fall back to subprocess."""
    img = _capture_via_daemon()
    if img:
        return img
    return _capture_subprocess()
```

---

### Phase 4: OCR — Linux Fallback Engine & AI Server Config

#### 4.0 — Key Principle: OCR Config Comes From the AI Server, Not Local Defaults

The codebase already has a **fully dynamic OCR engine system** that:

1. **Fetches OCR config from the AI server** at runtime (`POST /api/auth/ocr-config`)
2. **Pushes config into `os.environ`** so `OCRConfig.from_env()` picks it up
3. **Auto-installs missing pip packages** via `ocr/auto_installer.py` → `check_and_install_dependencies()`
4. **Dynamically creates engine adapters** via `ocr/engines/dynamic_engine.py` for any engine not pre-registered
5. **Resets the OCR facade** to reinitialize with the new config

This flow is already implemented in `desktop_app.py` → `set_runtime_ocr_config()` (lines ~377–440).

**Therefore:**
- ❌ **Do NOT add PaddleOCR or Tesseract engines** — they are not configured in the AI server `.env` file
- ❌ **Do NOT modify `ocr/config.py`** with platform-aware defaults — production config comes from the AI server
- ❌ **Do NOT create `paddle_engine.py`, `tesseract_engine.py`, or `metadata_engine.py`** — the dynamic engine system handles everything
- ✅ **RapidOCR** (`rapidocr_onnxruntime`) is the primary engine and **already works on Linux** (it's ONNX-based, uses PaddleOCR's PP-OCRv4 model via ONNX Runtime, no OS-specific code)
- ✅ If the AI server admin ever changes engines, the desktop app will **automatically adapt** — install the package, create the adapter, and use it

#### 4.1 — The WinRT OCR Problem on Linux

The current desktop app `.env.example` configures:
```
OCR_PRIMARY_ENGINE=rapidocr
OCR_FALLBACK_ENGINES=winrtocr
```

The plan is to switch to **WinRT OCR as primary** (fastest on Windows) with **RapidOCR + EasyOCR as fallbacks**. However, **WinRT OCR** (`winrtocr` pip package, `winrtocr_engine.py`) uses the Windows Runtime OCR API (`winsdk.windows.media.ocr`) and **cannot work on Linux**.

When `auto_installer.py` runs on Linux, it already detects this:
```python
# In get_engine_dependencies():
elif engine_name in ('winrtocr', 'winrt'):
    if os_type != 'windows':
        logger.warning("WinRTocr is only available on Windows")
        return []
```

The `winrtocr_engine.py` also fails gracefully — `is_available()` returns `False` when `winsdk` isn't importable.

But the fallback chain currently has **no Linux-compatible alternative**, leaving the system with only the primary engine and no fallback if it fails.

#### 4.2 — Solution: WinRT Primary + RapidOCR and EasyOCR as Fallbacks

The OCR facade already has a built-in **auto-switch mechanism** for Linux — no code changes needed:

1. `_initialize_engines()` in `ocr/facade.py` calls `is_available()` on the primary engine
2. If WinRT OCR's `is_available()` returns `False` (which it does on Linux because `winsdk` cannot be imported), the primary is set to `None`
3. The facade then iterates through the **fallback list in order**, skipping any that also return `is_available()=False`
4. The first available fallback engine becomes the **effective primary** at execution time

This means a **single AI server `.env` configuration** serves both Windows and Linux — the OCR engines **automatically switch** based on what's available on the system.

**Recommended config — WinRT primary, RapidOCR + EasyOCR fallbacks:**

| Engine | Role | Windows | Linux |
|--------|------|---------|-------|
| **WinRT OCR** | Primary | ✅ Used as primary (fast, native) | ❌ `is_available()=False` → auto-skipped |
| **RapidOCR** | Fallback 1 | ✅ Available (used if WinRT fails) | ✅ **Becomes effective primary** |
| **EasyOCR** | Fallback 2 | ✅ Available (used if both above fail) | ✅ Available (used if RapidOCR fails) |

**Engine comparison:**

| Aspect | WinRT OCR | RapidOCR | EasyOCR |
|--------|-----------|----------|---------|
| **Platform** | ❌ Windows only | ✅ Cross-platform | ✅ Cross-platform |
| **Engine file** | `winrtocr_engine.py` | `rapidocr_engine.py` | `easyocr_engine.py` |
| **Accuracy** | 85–92% | 95–98% (PP-OCRv4) | 88–94% |
| **Speed** | 500–1500ms | 500–1500ms | 1000–3000ms |
| **GPU** | No | No (ONNX CPU) | Yes (PyTorch CUDA/MPS) |
| **Languages** | Windows lang packs | en, ch | 80+ languages |
| **Install size** | ~0 (OS-level API) | ~30MB (ONNX models) | ~200MB (PyTorch + models) |
| **pip package** | `winrtocr` | `rapidocr_onnxruntime` | `easyocr` |
| **Auto-install** | ✅ | ✅ | ✅ |

**Other Linux-compatible OCR options (for reference):**

| Engine | Pros | Cons | Verdict |
|--------|------|------|---------|
| **PaddleOCR (native)** | Very high accuracy (95-98%) | Large install, redundant with RapidOCR (which uses PaddleOCR via ONNX) | ❌ Unnecessary |
| **Tesseract** | Lightweight, fast | Requires system binary, lower accuracy (85-90%) | ⚠️ Possible via dynamic engine |
| **DocTR** | Good accuracy, cross-platform | No existing engine file, heavy deps | ⚠️ Possible but extra work |
| **SuryaOCR** | State-of-the-art accuracy | Heavy deps, no existing engine file | ⚠️ Possible via dynamic engine |
| **GOT-OCR2** | Cutting edge | Very heavy, requires transformers + GPU | ❌ Too heavy |

All of the above can be added later by simply updating the AI server `.env` — the dynamic engine system will auto-create adapters and auto-install packages.

#### 4.3 — Required Change: AI Server `.env` Configuration

Update the AI server `.env` to keep WinRT as primary and add RapidOCR + EasyOCR as fallbacks:

```env
# =============================================================================
# OCR ENGINE CONFIGURATION
# =============================================================================
# WinRT OCR is primary (fastest on Windows, native API).
# On Linux, WinRT is automatically skipped (is_available()=False) and
# the first available fallback (RapidOCR) becomes the effective primary.
# EasyOCR is the second fallback for both platforms.
# =============================================================================

OCR_PRIMARY_ENGINE=winrtocr
OCR_FALLBACK_ENGINES=rapidocr,easyocr

# WinRT OCR settings (Windows only — auto-skipped on Linux)
OCR_WINRTOCR_MIN_CONFIDENCE=0.6

# RapidOCR settings (cross-platform, ONNX-based PaddleOCR PP-OCRv4)
OCR_RAPIDOCR_MIN_CONFIDENCE=0.6
OCR_RAPIDOCR_PACKAGE=rapidocr_onnxruntime
OCR_RAPIDOCR_CLASS=RapidOCR
OCR_RAPIDOCR_METHOD=__call__

# EasyOCR settings (cross-platform, PyTorch-based, 80+ languages)
OCR_EASYOCR_MIN_CONFIDENCE=0.7
OCR_EASYOCR_LANGUAGES=en
OCR_EASYOCR_GPU=false
```

**This single config works for both Windows and Linux:** the facade's `is_available()` check automatically adjusts the effective engine chain per platform.

#### 4.4 — How the Auto-Switch Works (No Code Changes Needed)

The OCR facade in `ocr/facade.py` → `_initialize_engines()` already implements auto-switching:

```python
# From facade.py — this is EXISTING CODE, not new:
if self._primary_engine.is_available():
    logger.info(f"Primary OCR engine: {self.config.primary_engine}")
else:
    self._primary_engine = None  # ← Primary becomes None, fallbacks take over
```

And in `extract_text()`, also existing:

```python
engines_to_try = []
if self._primary_engine and self._primary_engine.is_available():
    engines_to_try.append(self._primary_engine)
engines_to_try.extend([e for e in self._fallback_engines if e.is_available()])

for engine in engines_to_try:  # ← Tries each in order, skips unavailable
    ...
```

**On Windows:**
```
Config from AI server: primary=winrtocr, fallbacks=[rapidocr, easyocr]

_initialize_engines():
  winrtocr.is_available() → True (winsdk installed)
  → primary = winrtocr ✅
  rapidocr.is_available() → True
  → fallback[0] = rapidocr ✅
  easyocr.is_available() → True (auto-installed)
  → fallback[1] = easyocr ✅

extract_text() order: winrtocr → rapidocr → easyocr
```

**On Linux (automatic switch — zero code changes):**
```
Config from AI server: primary=winrtocr, fallbacks=[rapidocr, easyocr]

_initialize_engines():
  winrtocr.is_available() → False (winsdk not installed on Linux)
  → primary = None ⬇️ (auto-skipped)
  rapidocr.is_available() → True (cross-platform ONNX)
  → fallback[0] = rapidocr ✅ ← becomes effective primary
  easyocr.is_available() → True (auto-installed by auto_installer.py)
  → fallback[1] = easyocr ✅

extract_text() order: rapidocr → easyocr
```

**Full startup flow on Linux:**
```
1. User logs in with Atlassian OAuth
2. desktop_app.py calls POST /api/auth/ocr-config
3. AI server reads .env → returns:
     {primary_engine: 'winrtocr', fallback_engines: ['rapidocr', 'easyocr'], ...}
4. set_runtime_ocr_config() pushes into os.environ:
     OCR_PRIMARY_ENGINE=winrtocr
     OCR_FALLBACK_ENGINES=rapidocr,easyocr
     OCR_EASYOCR_MIN_CONFIDENCE=0.7
     ...
5. auto_installer.check_and_install_dependencies() runs:
     [WINRTOCR] ⚠️ WinRTocr is only available on Windows (skipped)
     [RAPIDOCR] ✅ All Python dependencies installed
     [EASYOCR]  ⚠️ Missing: torch, torchvision, easyocr
               🔧 Installing... ✅ Successfully installed
6. OCR facade reset → reinitializes:
     winrtocr: is_available()=False → primary=None
     rapidocr: is_available()=True → fallback[0] (effective primary)
     easyocr:  is_available()=True → fallback[1]
7. On screenshot capture:
     → Try RapidOCR → success → done
     → If RapidOCR fails → Try EasyOCR → success → done
```

**No new engine adapter files, no platform detection in OCR code, no manual pip installs.**

#### 4.5 — Files That Need NO Changes for OCR

| File | Why No Changes Needed |
|------|----------------------|
| `ocr/config.py` | Config comes from AI server, not local defaults |
| `ocr/facade.py` | Fallback chain already skips unavailable engines |
| `ocr/engine_factory.py` | Dynamic engine creation already works |
| `ocr/engines/dynamic_engine.py` | Handles any engine from env config |
| `ocr/auto_installer.py` | Already has OS detection and auto-install |
| `ocr/engines/rapidocr_engine.py` | Already cross-platform |
| `ocr/engines/easyocr_engine.py` | Already exists and cross-platform |
| `ocr/engines/winrtocr_engine.py` | Gracefully returns `is_available()=False` on Linux |

#### 4.6 — Summary: OCR Changes Required

| Change | Where | What |
|--------|-------|------|
| Keep WinRT as primary | `ai-server/.env` | `OCR_PRIMARY_ENGINE=winrtocr` (already set) |
| Add RapidOCR + EasyOCR as fallbacks | `ai-server/.env` | Change `OCR_FALLBACK_ENGINES=winrtocr` → `OCR_FALLBACK_ENGINES=rapidocr,easyocr` |
| Add EasyOCR config | `ai-server/.env` | Add `OCR_EASYOCR_MIN_CONFIDENCE=0.7`, `OCR_EASYOCR_LANGUAGES=en`, `OCR_EASYOCR_GPU=false` |
| **No code changes** | — | The facade's `is_available()` auto-switching handles Linux automatically |

---

### Phase 5: Local Storage (SQLite Module)

**Create:** `python-desktop-app/local_storage/` directory

This module stores OCR-extracted text and activity records locally before batch uploading to Supabase.

#### 5.1 — `local_storage/sqlite_manager.py`

| Setting | Value |
|---------|-------|
| DB Path | `~/.local/share/timetracker/hybrid_ocr_storage.db` |
| Journal Mode | WAL |
| Busy Timeout | 30s |
| Connections | Thread-local (one per thread) |

**Tables to create:**

1. **`active_sessions`** — Tracks accumulated time per window during the tracking period
   - Columns: `window_title`, `application_name`, `classification`, `ocr_text`, `ocr_method`, `ocr_confidence`, `total_time_seconds`, `visit_count`, `first_seen`, `last_seen`
   - Unique constraint: `(window_title, application_name)`

2. **`pending_activity_records`** — Queue of records awaiting batch upload
   - Columns: `user_id`, `organization_id`, `window_title`, `application_name`, `ocr_text`, `ocr_method`, `ocr_confidence`, `classification`, `start_time`, `end_time`, `duration_seconds`, `work_date`, `synced`, `retry_count`, `batch_id`

3. **`app_classifications_cache`** — Server-synced classification rules
   - Columns: `organization_id`, `project_key`, `identifier`, `display_name`, `classification`, `match_by`, `cached_at`

#### 5.2 — `local_storage/session_tracker.py`

Monitors window changes and accumulates time:
- `on_window_change(title, app, ocr_text, method, confidence)` — calculate elapsed, accumulate in SQLite
- `get_sessions_for_upload()` — return sessions with accumulated time
- `reset_after_upload()` — reset timers after successful upload
- Config: `idle_threshold=120s`, `min_session_duration=3s`

#### 5.3 — `local_storage/batch_uploader.py`

Periodically uploads to Supabase:
- Upload interval: 300 seconds (configurable)
- Max batch size: 100 records
- Max retry: 3 attempts with 60s backoff
- After upload, triggers `analyze-activity-batch` Edge Function
- Auto-cleanup of synced records older than 7 days

---

### Phase 6: Dependencies & Installation

#### 6.1 — `requirements.txt` Additions

Add the following with platform markers:

```
# Linux-specific: Window Tracking
ewmh==0.1.6; sys_platform == 'linux'
python-xlib==0.33; sys_platform == 'linux'

# Linux-specific: D-Bus Integration
dbus-python>=1.3.2; sys_platform == 'linux'

# NO Linux-specific OCR packages needed here!
# OCR engine dependencies are auto-installed at runtime by ocr/auto_installer.py
# based on whatever engines the AI server configures in its .env file.
# This includes easyocr, torch, torchvision, etc.
```

> **Note:** `PyGObject` (gi) and GStreamer bindings are **system packages** (installed via apt/dnf/pacman), not pip packages. They must be installed separately.
> 
> **Note on OCR:** OCR pip packages are **NOT** in `requirements.txt`. They are auto-installed at runtime when the desktop app fetches OCR config from the AI server. The `auto_installer.py` handles this transparently.

#### 6.2 — `install_linux.sh`: Multi-Distribution Installer

Create a shell script (~210 lines) that:

1. Detects package manager (`apt` / `dnf` / `pacman`)
2. Installs Wayland/PipeWire system packages
3. Installs `libnotify-bin` for notifications
4. Runs `pip install -r requirements.txt`
5. Runs verification checks for all dependencies:
   - PyGObject (`gi.repository.GLib`)
   - GStreamer 1.0 (`gi.repository.Gst`)
   - PipeWire GStreamer plugin (`pipewiresrc`)
   - RapidOCR importability (`rapidocr_onnxruntime`)
   - notify-send availability

> **Note:** OCR fallback engines (like EasyOCR) are **not** installed by this script. They are auto-installed at runtime by `auto_installer.py` when the desktop app fetches OCR config from the AI server.

**System packages by distro:**

| Package (Ubuntu) | Fedora | Arch | Purpose |
|---|---|---|---|
| `python3-gi` | `python3-gobject` | `python-gobject` | PyGObject |
| `python3-gi-cairo` | `python3-cairo` | `python-cairo` | Cairo bindings |
| `gir1.2-gstreamer-1.0` | `gstreamer1-plugins-base` | `gst-plugins-base` | GStreamer introspection |
| `gstreamer1.0-pipewire` | `pipewire-gstreamer` | `gst-plugin-pipewire` | PipeWire source element |
| `gstreamer1.0-plugins-base` | — | — | videoconvert element |
| `gstreamer1.0-plugins-good` | — | `gst-plugins-good` | pngenc element |
| `libnotify-bin` | `libnotify` | `libnotify` | notify-send |

> **Note:** Tesseract system packages are **not needed** — the system uses RapidOCR (ONNX-based) as primary and EasyOCR (pip-only) as fallback. Neither requires system-level OCR binaries.

---

### Phase 7: Build & Packaging

#### 7.1 — PyInstaller Spec Updates

The existing `desktop_app.spec` / `build.bat` need a Linux counterpart:

**Create:** `build_linux.sh`

```bash
#!/bin/bash
pyinstaller --onefile \
    --name timetracker \
    --add-data "ocr:ocr" \
    --add-data "privacy:privacy" \
    --add-data "local_storage:local_storage" \
    --add-data "wayland_screenshot.py:." \
    --add-data "desktop_app_linux.py:." \
    --hidden-import ewmh \
    --hidden-import Xlib \
    --hidden-import dbus \
    --hidden-import gi \
    desktop_app.py
```

#### 7.2 — `.desktop` File for Distribution

For packaging/distribution, create a standard `.desktop` launcher:

```ini
[Desktop Entry]
Type=Application
Name=JIRAForge TimeTracker
Exec=/opt/jiraforge/timetracker
Icon=/opt/jiraforge/icon.png
Categories=Office;Utility;
```

---

## 4. File-by-File Modification List

### Existing Files to Modify

| # | File | Changes Required | Effort |
|---|------|-----------------|--------|
| 1 | `desktop_app.py` | Add `IS_LINUX`/`IS_WINDOWS` constants, conditional Linux imports, route 8+ functions to Linux implementations, guard `ImageGrab` import, platform-aware version check | Medium |
| 2 | `requirements.txt` | Add `ewmh`, `python-xlib`, `dbus-python` with `sys_platform == 'linux'` markers. **No PaddleOCR/Tesseract** — OCR engines are auto-installed from AI server config | Small |
| 3 | `config_manager.py` | Use `$XDG_CONFIG_HOME` env var (line 24), use `$XDG_DATA_HOME` for data storage | Small |
| 4 | `ocr/config.py` | **No changes needed** — OCR config comes from AI server at runtime, not local defaults | None |
| 5 | `ocr/facade.py` | No changes needed — fallback chain already skips unavailable engines | None |
| 6 | `ocr/image_processor.py` | No changes needed — preprocessing works cross-platform | None |

### Detailed Change Descriptions for `desktop_app.py`

| Location | Current Code | Modification |
|----------|-------------|--------------|
| Line ~25 | `from PIL import Image, ImageGrab, ImageDraw` | Wrap in try/except, set `ImageGrab = None` on failure |
| After line ~199 | (end of WIN32_AVAILABLE block) | Add `IS_LINUX`, `IS_WINDOWS` constants + conditional `desktop_app_linux` imports |
| Line ~218 | `acquire_single_instance_lock()` | Add `IS_LINUX` branch to use `fcntl.flock()` |
| Line ~285 | `release_single_instance_lock()` | Add `IS_LINUX` branch |
| Line ~303–309 | `winotify` import | Add Linux notification fallback |
| Line ~498 | `platform=windows` hardcoded | Use dynamic `platform_name` based on `IS_LINUX` |
| Line ~590 | `show_update_notification()` | Add `IS_LINUX` branch calling `show_notification_linux()` |
| Line ~683 | `get_app_data_dir()` | Add `IS_LINUX` branch calling `get_app_data_dir_linux()` |
| Lines ~1141–1230 | `add_to_startup()`, `remove_from_startup()`, `is_in_startup()` | Add `IS_LINUX` branches using XDG autostart |
| Line ~7425 | `get_active_window()` | Add `IS_LINUX` branch using EWMH |
| Line ~7875 | `monitor_user_activity()` | Add `IS_LINUX` D-Bus idle detection path |
| Line ~8290 | Idle duration calculation | Add Linux idle time via `get_idle_time_linux()` |
| Screenshot capture in tracking loop | `ImageGrab.grab()` | Add `IS_LINUX` branch calling `capture_screenshot_linux()` |
| Line ~7910+ | `monitor_system_events()` (ctypes.windll) | Skip on Linux or implement D-Bus sleep/lock monitoring |

---

## 5. New Files to Create

| # | File Path | Size Estimate | Description |
|---|-----------|--------------|-------------|
| 1 | `python-desktop-app/desktop_app_linux.py` | ~400 lines | All Linux function implementations (window tracking, idle, notifications, auto-start, lock, data dir, screenshot routing) |
| 2 | `python-desktop-app/wayland_screenshot.py` | ~720 lines | XDG ScreenCast Portal + PipeWire + GStreamer pipeline + daemon mode + subprocess fallback |
| ~~3~~ | ~~`python-desktop-app/ocr/engines/paddle_engine.py`~~ | — | ~~NOT NEEDED~~ — RapidOCR already uses PaddleOCR via ONNX Runtime |
| ~~4~~ | ~~`python-desktop-app/ocr/engines/tesseract_engine.py`~~ | — | ~~NOT NEEDED~~ — not in AI server env config |
| ~~5~~ | ~~`python-desktop-app/ocr/engines/metadata_engine.py`~~ | — | ~~NOT NEEDED~~ — not in AI server env config |
| 6 | `python-desktop-app/local_storage/__init__.py` | ~5 lines | Package init |
| 7 | `python-desktop-app/local_storage/sqlite_manager.py` | ~350 lines | SQLite DB manager with WAL mode, thread-local connections, schema creation |
| 8 | `python-desktop-app/local_storage/session_tracker.py` | ~200 lines | Active window session time accumulator |
| 9 | `python-desktop-app/local_storage/batch_uploader.py` | ~250 lines | Periodic batch upload to Supabase + retry logic |
| 10 | `python-desktop-app/install_linux.sh` | ~210 lines | Multi-distro dependency installer + verification |
| 11 | `python-desktop-app/build_linux.sh` | ~30 lines | PyInstaller build script for Linux |

**Total new code:** ~2,170 lines across 8 files (3 OCR engine files removed — dynamic system handles them)

---

## 6. Dependency Changes

### New pip Dependencies (Linux-only)

| Package | Version | `requirements.txt` Marker | Purpose |
|---------|---------|--------------------------|---------|
| `ewmh` | 0.1.6 | `sys_platform == 'linux'` | EWMH window manager queries |
| `python-xlib` | 0.33 | `sys_platform == 'linux'` | X11 protocol bindings (required by ewmh) |
| `dbus-python` | ≥1.3.2 | `sys_platform == 'linux'` | D-Bus integration (idle detection) |
| ~~`paddlepaddle`~~ | — | — | ~~NOT NEEDED~~ — RapidOCR uses ONNX Runtime, not native PaddlePaddle |
| ~~`paddleocr`~~ | — | — | ~~NOT NEEDED~~ — RapidOCR (`rapidocr_onnxruntime`) is already cross-platform |
| ~~`pytesseract`~~ | — | — | ~~NOT NEEDED~~ — not configured in AI server env |

> **Note on OCR dependencies:** OCR engine packages (like `easyocr`, `torch`, `torchvision`) are **NOT listed in `requirements.txt`**. They are **automatically installed at runtime** by `ocr/auto_installer.py` based on whatever engines the AI server configures. This keeps the base install lightweight and allows the AI server admin to change engines without touching the desktop app code.

### New System Packages (via apt/dnf/pacman, not pip)

| Purpose | Ubuntu/Debian | Fedora/RHEL | Arch |
|---------|--------------|-------------|------|
| PyGObject | `python3-gi python3-gi-cairo` | `python3-gobject python3-cairo` | `python-gobject python-cairo` |
| GStreamer + PipeWire | `gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good` | `gstreamer1-plugins-base pipewire-gstreamer` | `gst-plugins-base gst-plugin-pipewire gst-plugins-good` |

| Notifications | `libnotify-bin` | `libnotify` | `libnotify` |
| Build tools | `python3-dev build-essential` | — | — |

### Existing Dependencies That Already Work on Linux

| Package | Notes |
|---------|-------|
| `flask`, `flask-cors` | Cross-platform |
| `supabase` | Cross-platform |
| `pystray` | Works on X11 and some Wayland compositors via AppIndicator |
| `Pillow` | Cross-platform (but `ImageGrab.grab()` is Windows/macOS-only) |
| `psutil` | Cross-platform |
| `requests` | Cross-platform |
| `python-dotenv` | Cross-platform |
| `cryptography` | Cross-platform |
| `keyring` | Cross-platform (uses SecretService on Linux) |
| `pynput` | Works on X11, limited on Wayland |
| `rapidocr_onnxruntime` | Cross-platform |
| `numpy`, `opencv-python` | Cross-platform |
| `presidio-analyzer/anonymizer` | Cross-platform |

---

## 7. Testing Strategy

### 7.1 — Unit Tests

| Test Area | Test File | What to Test |
|-----------|-----------|-------------|
| Platform detection | `tests/test_platform.py` | `IS_LINUX`, `IS_WINDOWS` flags, conditional imports |
| Linux functions | `tests/test_linux_functions.py` | Lock acquire/release, XDG paths, autostart file creation |
| OCR engines | `tests/test_ocr_engines.py` (extend existing) | RapidOCR on Linux, EasyOCR fallback, WinRT OCR graceful skip, dynamic engine auto-install |
| SQLite manager | `tests/test_sqlite_manager.py` | Schema creation, CRUD operations, WAL mode |
| Session tracker | `tests/test_session_tracker.py` | Window change tracking, time accumulation |
| Batch uploader | `tests/test_batch_uploader.py` | Batch creation, retry logic, sync marking |
| Privacy filter | (already exists) | Verify cross-platform compatibility |

### 7.2 — Integration Tests (Require Linux Desktop)

| Test | Description |
|------|-------------|
| Screenshot capture | Verify Wayland ScreenCast → PipeWire → GStreamer pipeline produces valid PNG |
| Daemon lifecycle | Start daemon → PING → CAPTURE → QUIT |
| Active window | Switch windows, verify EWMH returns correct title/app |
| Idle detection | D-Bus GetIdletime() returns reasonable values |
| Notifications | `notify-send` displays toast on GNOME/KDE/etc. |
| Auto-start | `.desktop` file written to correct path with valid format |

### 7.3 — Verification Checklist

```
□ Desktop app launches on Ubuntu 22.04+ (GNOME/Wayland)
□ Desktop app launches on Fedora 38+ (GNOME/Wayland)
□ Screenshot capture works (user prompted for permission once)
□ Subsequent screenshots skip permission dialog (restore token works)
□ Active window title + app name detected correctly
□ Idle detection pauses tracking after threshold
□ Notifications display correctly
□ Auto-start persists after reboot
□ Single-instance lock prevents duplicate app
□ OCR extracts text from screenshots locally
□ Privacy filter redacts sensitive data
□ Batch upload sends records to Supabase
□ Existing Windows functionality unaffected
```

---

## 8. Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Wayland ScreenCast API varies by compositor** | Screenshot may fail on non-GNOME desktops | Test on KDE Plasma and Sway; implement `gnome-screenshot` / `grim` fallbacks |
| **PipeWire not running on older distros** | GStreamer pipeline fails | Detect PipeWire availability; fall back to X11 screenshot tools if X11 session |
| **EasyOCR model download** (~100MB) | First OCR fallback call is slow | Auto-downloaded on first use; RapidOCR (primary) has models bundled in pip package |
| **GNOME Mutter idle detection** is GNOME-specific | Idle detection fails on KDE/XFCE | Implement fallback: `xprintidle` command or `pynput` (X11) |
| **EWMH requires X11/XWayland** | Pure Wayland apps invisible to window tracker | Most compositors run XWayland by default; document limitation |
| **pystray may not work on all Wayland compositors** | No system tray icon | Use AppIndicator as alternative; or StatusNotifierItem D-Bus protocol |
| **PyInstaller bundling with GI bindings** | GObject introspection may not bundle correctly | Use `--collect-typelibs gi` flag; test thoroughly |
| **Large fallback engine size** | EasyOCR + PyTorch adds ~200MB if installed | EasyOCR is auto-installed only when configured as fallback; bundle only includes RapidOCR (~30MB) |

---

## Appendix: Recommended Implementation Order

```
Week 1:  Phase 1 (Platform Detection) + Phase 6.1 (requirements.txt)
         → App launches on Linux without crashing, gracefully degrades

Week 2:  Phase 2 (desktop_app_linux.py) — everything except screenshots
         → Window tracking, idle, notifications, auto-start, lock all work

Week 3:  Phase 3 (wayland_screenshot.py)
         → Screenshot capture works on Wayland via daemon

Week 4:  Phase 4 (OCR Linux Fallback)
         → AI server .env updated with EasyOCR fallback; verified on Linux

Week 5:  Phase 5 (Local Storage)
         → SQLite session tracker + batch uploader operational

Week 6:  Phase 7 (Build & Packaging) + Testing
         → PyInstaller Linux build + full integration testing
```

---

## Appendix: Environment Variables (Linux-Specific)

| Variable | Default | Purpose |
|----------|---------|---------|
| `XDG_DATA_HOME` | `~/.local/share` | App data directory base |
| `XDG_CONFIG_HOME` | `~/.config` | Configuration directory base |
| `XDG_SESSION_TYPE` | (system) | Detect `wayland` vs `x11` |
| `XDG_CURRENT_DESKTOP` | (system) | Detect desktop environment |
| `OCR_PRIMARY_ENGINE` | `winrtocr` | Primary OCR engine (from AI server; auto-skipped on Linux) |
| `OCR_FALLBACK_ENGINES` | `rapidocr,easyocr` | Fallback chain (from AI server; RapidOCR becomes effective primary on Linux) |
| `OCR_RAPIDOCR_MIN_CONFIDENCE` | `0.6` | RapidOCR minimum confidence (from AI server) |
| `OCR_EASYOCR_MIN_CONFIDENCE` | `0.7` | EasyOCR minimum confidence (from AI server) |
| `OCR_EASYOCR_GPU` | `false` | EasyOCR GPU setting (from AI server) |

---

## Appendix: Quick Reference — Files Touched

```
MODIFIED (4 files):
  python-desktop-app/desktop_app.py          ← Platform routing (8+ function changes)
  python-desktop-app/requirements.txt        ← Add 3 Linux-only packages (ewmh, python-xlib, dbus-python)
  python-desktop-app/config_manager.py       ← XDG compliance (2 lines)
  ai-server/.env                             ← WinRT primary + rapidocr,easyocr fallbacks

CREATED (11 files):
  python-desktop-app/desktop_app_linux.py    ← Core Linux implementations (~400 LOC)
  python-desktop-app/wayland_screenshot.py   ← Wayland screenshot daemon (~720 LOC)
  (NO new OCR engine files — dynamic system handles everything from AI server config)
  python-desktop-app/local_storage/__init__.py        ← Package init
  python-desktop-app/local_storage/sqlite_manager.py  ← SQLite DB (~350 LOC)
  python-desktop-app/local_storage/session_tracker.py  ← Session tracking (~200 LOC)
  python-desktop-app/local_storage/batch_uploader.py   ← Batch upload (~250 LOC)
  python-desktop-app/install_linux.sh                  ← Installer (~210 LOC)
  python-desktop-app/build_linux.sh                    ← Build script (~30 LOC)
```

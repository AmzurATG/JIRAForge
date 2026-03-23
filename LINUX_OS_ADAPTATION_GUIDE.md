# JIRAForge — Linux OS Adaptation: Complete Technical Reference

> **Document Version:** 1.0  
> **Date:** March 23, 2026  
> **Scope:** All modifications, libraries, and architectural decisions made to adapt JIRAForge's desktop time-tracking application to run on the Linux operating system, with focus on Wayland display server support.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview: Windows vs Linux](#2-architecture-overview-windows-vs-linux)
3. [Platform Detection & Conditional Loading](#3-platform-detection--conditional-loading)
4. [Screenshot Capture on Linux](#4-screenshot-capture-on-linux)
   - 4.1 [Wayland Display Server Challenges](#41-wayland-display-server-challenges)
   - 4.2 [XDG ScreenCast Portal + PipeWire Architecture](#42-xdg-screencast-portal--pipewire-architecture)
   - 4.3 [GStreamer Pipeline for Frame Capture](#43-gstreamer-pipeline-for-frame-capture)
   - 4.4 [Persistent Permission with Restore Tokens](#44-persistent-permission-with-restore-tokens)
   - 4.5 [Screenshot Daemon (Unix Socket IPC)](#45-screenshot-daemon-unix-socket-ipc)
   - 4.6 [Fallback: Subprocess Mode](#46-fallback-subprocess-mode)
5. [Idle Detection on Linux](#5-idle-detection-on-linux)
6. [Active Window Tracking](#6-active-window-tracking)
7. [Desktop Notifications](#7-desktop-notifications)
8. [Auto-Start (Login Startup)](#8-auto-start-login-startup)
9. [Single-Instance Lock](#9-single-instance-lock)
10. [Application Data Directory (XDG Compliance)](#10-application-data-directory-xdg-compliance)
11. [Hybrid OCR System (On-Device Text Extraction)](#11-hybrid-ocr-system-on-device-text-extraction)
    - 11.1 [OCR Architecture & Fallback Chain](#111-ocr-architecture--fallback-chain)
    - 11.2 [PaddleOCR Engine (Primary)](#112-paddleocr-engine-primary)
    - 11.3 [Tesseract Engine (Fallback)](#113-tesseract-engine-fallback)
    - 11.4 [Metadata Engine (Last Resort)](#114-metadata-engine-last-resort)
    - 11.5 [Image Preprocessing Pipeline](#115-image-preprocessing-pipeline)
    - 11.6 [Privacy Filter](#116-privacy-filter)
12. [Local Storage (SQLite)](#12-local-storage-sqlite)
    - 12.1 [Database Schema](#121-database-schema)
    - 12.2 [Session Tracker](#122-session-tracker)
    - 12.3 [Batch Uploader](#123-batch-uploader)
13. [AI Server — Linux Container Configuration](#13-ai-server--linux-container-configuration)
14. [Complete Library & Dependency Reference](#14-complete-library--dependency-reference)
    - 14.1 [Python Packages (pip)](#141-python-packages-pip)
    - 14.2 [System Packages by Distribution](#142-system-packages-by-distribution)
15. [Installation Script (install_linux.sh)](#15-installation-script-install_linuxsh)
16. [Environment Variables](#16-environment-variables)
17. [File Structure: Linux-Specific Files](#17-file-structure-linux-specific-files)
18. [End-to-End Data Flow on Linux](#18-end-to-end-data-flow-on-linux)
19. [Troubleshooting Guide](#19-troubleshooting-guide)

---

## 1. Executive Summary

JIRAForge is a Jira-integrated time-tracking system with a desktop agent that captures screenshots, performs OCR, tracks active windows, and reports work activity. The application was originally designed for Windows, relying on Win32 APIs (`pywin32`, `winotify`, Windows Registry, `win32gui`).

Adapting it to Linux required replacing every Windows-specific subsystem with Linux-native equivalents, most critically the **screenshot capture pipeline**. Modern Linux desktops run under the **Wayland** display protocol, which deliberately blocks direct screen capture for security reasons. This necessitated a fundamentally different architecture using:

- **XDG ScreenCast Portal** for permission-granted screen sharing
- **PipeWire** for media streaming
- **GStreamer** for frame extraction from PipeWire streams
- **D-Bus** for inter-process communication and idle detection
- **EWMH / python-xlib** for window tracking (X11/XWayland)
- **PaddleOCR + Tesseract** for on-device Hybrid OCR
- **SQLite with WAL mode** for local activity storage

The result is a fully functional Linux desktop agent that works on Ubuntu/Debian, Fedora/RHEL, and Arch Linux, under both Wayland and X11 sessions.

---

## 2. Architecture Overview: Windows vs Linux

| Feature | Windows Implementation | Linux Implementation |
|---------|----------------------|---------------------|
| **Screenshot Capture** | `PIL.ImageGrab.grab()` | XDG ScreenCast Portal → PipeWire → GStreamer pipeline |
| **Idle Detection** | `win32api.GetLastInputInfo()` | D-Bus GNOME Mutter `IdleMonitor.GetIdletime()` |
| **Window Tracking** | `win32gui.GetForegroundWindow()` + `win32process` | EWMH (`python-xlib`) / `xdotool` + `xprop` fallback |
| **Notifications** | `winotify` (Windows toast) | `notify-send` (libnotify) |
| **Auto-Start** | Windows Registry `HKCU\...\Run` | `~/.config/autostart/*.desktop` (XDG Autostart spec) |
| **Single Instance** | `win32event.CreateMutex()` | `fcntl.flock()` on lock file |
| **Data Directory** | `%LOCALAPPDATA%\TimeTracker` | `$XDG_DATA_HOME/timetracker` (default: `~/.local/share/timetracker`) |
| **System Tray** | `pystray` (Win32) | `pystray` (AppIndicator/X11) |
| **OCR** | Server-side (AI Server) | Hybrid: On-device PaddleOCR/Tesseract + server fallback |

**Key Architectural Change:** On Linux, a **Hybrid OCR** approach was adopted. Instead of uploading full screenshots to the AI server for analysis, OCR is performed locally on the device. Only the extracted text is uploaded, reducing bandwidth by **96–99%** and AI processing costs by **85–96%**.

---

## 3. Platform Detection & Conditional Loading

**File:** `python-desktop-app/desktop_app.py`

The main application uses `sys.platform` to detect the operating system and conditionally imports the appropriate platform-specific module:

```python
IS_LINUX = sys.platform.startswith('linux')
IS_WINDOWS = sys.platform == 'win32'

if IS_LINUX:
    try:
        from desktop_app_linux import (
            capture_screenshot_linux,
            get_active_window_linux,
            show_notification_linux,
            acquire_single_instance_lock_linux,
            release_single_instance_lock_linux,
            add_to_startup_linux,
            remove_from_startup_linux,
            is_in_startup_linux,
            get_app_data_dir_linux,
        )
        LINUX_FUNCTIONS_AVAILABLE = True
    except ImportError as e:
        LINUX_FUNCTIONS_AVAILABLE = False
```

When a Linux-specific function is available, the method dispatcher routes to it:

```python
def capture_screenshot(self):
    if IS_LINUX and LINUX_FUNCTIONS_AVAILABLE:
        return capture_screenshot_linux()
    else:
        return ImageGrab.grab()
```

The Hybrid OCR module is also conditionally loaded on Linux:

```python
if IS_LINUX:
    from ocr.facade import OCRFacade
    from local_storage.sqlite_manager import SQLiteManager
    from local_storage.session_tracker import ActiveSessionTracker
    from local_storage.batch_uploader import BatchUploader
```

**Requirements.txt** uses platform markers to ensure only relevant packages are installed:

```
pywin32==306; sys_platform == 'win32'
winotify==1.1.0; sys_platform == 'win32'
ewmh==0.1.6; sys_platform == 'linux'
python-xlib==0.33; sys_platform == 'linux'
```

---

## 4. Screenshot Capture on Linux

### 4.1 Wayland Display Server Challenges

Wayland, the modern display protocol replacing X11 on most Linux distributions, was designed with **security isolation** as a core principle. Key restrictions:

| X11 Behavior | Wayland Restriction |
|---|---|
| Any app can read any window's pixels | Applications cannot access other windows' buffers |
| `xdotool`, `scrot`, `import` work freely | These tools do not function under Wayland |
| Screenshot libraries (PIL, mss, pyautogui) work | These libraries fail silently or capture blank screens |
| No permission system for screen access | Explicit user consent required via portal |

This means **none of the traditional screenshot approaches work on Wayland**. The solution is the **XDG Desktop Portal** system — a D-Bus-based API where the compositor (GNOME Shell, KDE Plasma, Sway, etc.) mediates screen access.

### 4.2 XDG ScreenCast Portal + PipeWire Architecture

**File:** `python-desktop-app/wayland_screenshot.py` (~720 lines)

The screenshot system uses a four-stage initialization protocol:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    XDG ScreenCast Portal Flow                       │
│                                                                     │
│  1. CreateSession()                                                 │
│     └─ D-Bus: org.freedesktop.portal.ScreenCast.CreateSession       │
│     └─ Returns: session_handle (e.g., /org/freedesktop/portal/...)  │
│                                                                     │
│  2. SelectSources()                                                 │
│     └─ D-Bus: org.freedesktop.portal.ScreenCast.SelectSources       │
│     └─ Parameters:                                                  │
│         types = 1 (MONITOR)                                         │
│         multiple = False                                            │
│         persist_mode = 2 (PERSIST_PERMANENT)                        │
│         restore_token = <saved_token> (if available)                │
│     └─ User sees permission dialog (first time only)                │
│                                                                     │
│  3. Start()                                                         │
│     └─ D-Bus: org.freedesktop.portal.ScreenCast.Start               │
│     └─ Returns: streams = [(node_id, {properties})]                 │
│     └─ Also returns: restore_token (saved for future use)           │
│                                                                     │
│  4. OpenPipeWireRemote()                                            │
│     └─ D-Bus: org.freedesktop.portal.ScreenCast.OpenPipeWireRemote  │
│     └─ Returns: PipeWire file descriptor (pw_fd)                    │
│                                                                     │
│  Result: Active PipeWire stream accessible via GStreamer             │
└─────────────────────────────────────────────────────────────────────┘
```

**Global session state** is maintained in-memory:

```python
TOKEN_FILE = os.path.expanduser("~/.local/share/timetracker/.screencast_token")

_session_state = {
    'session_handle': None,   # D-Bus session path
    'node_id': None,          # PipeWire stream node ID
    'pw_fd': None,            # PipeWire file descriptor
    'bus': None,              # D-Bus session bus
    'initialized': False,     # Session initialization flag
    'lock': threading.Lock(), # Thread safety
    'Gst': None,              # GStreamer module ref
    'GLib': None,             # GLib module ref
    'Gio': None               # Gio module ref
}
```

**D-Bus Libraries Used:**

| Library | Package | Purpose |
|---------|---------|---------|
| `gi.repository.Gio` | `python3-gi` (PyGObject) | D-Bus method calls to XDG Portal |
| `gi.repository.GLib` | `python3-gi` (PyGObject) | GLib main loop integration |
| `gi.repository.Gst` | `gir1.2-gstreamer-1.0` | GStreamer pipeline control |

### 4.3 GStreamer Pipeline for Frame Capture

Once a PipeWire session is established, individual frames (screenshots) are captured using a **GStreamer pipeline**:

```
pipewiresrc fd={dup_fd} path={node_id}
    → videoconvert
    → pngenc snapshot=true
    → filesink location={output_path}
```

**Pipeline Components:**

| Element | Package | Function |
|---------|---------|----------|
| `pipewiresrc` | `gstreamer1.0-pipewire` | Reads video frames from PipeWire stream |
| `videoconvert` | `gstreamer1.0-plugins-base` | Converts pixel format to a format pngenc accepts |
| `pngenc` | `gstreamer1.0-plugins-good` | Encodes frame as PNG image |
| `filesink` | `gstreamer1.0` (core) | Writes encoded image to file |

**Key Detail — File Descriptor Duplication:**

The PipeWire file descriptor (`pw_fd`) is duplicated using `os.dup()` before each GStreamer pipeline invocation. This prevents GStreamer from closing the original file descriptor when the pipeline finishes:

```python
dup_fd = os.dup(_session_state['pw_fd'])
pipeline_str = f"pipewiresrc fd={dup_fd} path={node_id} ! videoconvert ! pngenc snapshot=true ! filesink location={output_path}"
```

The `snapshot=true` property on `pngenc` ensures only a single frame is captured and encoded rather than a continuous stream.

### 4.4 Persistent Permission with Restore Tokens

Wayland's security model requires user consent for screen sharing. Without persistence, the user would see a permission dialog **every time the app starts**.

The solution uses `persist_mode=2` (permanent persistence):

| persist_mode | Behavior |
|---|---|
| 0 | No persistence — dialog shown every time |
| 1 | Application session persistence — until app closes |
| **2** | **Permanent persistence — survives reboots** |

On first permission grant, the portal returns a `restore_token`. This token is:

1. **Saved** to `~/.local/share/timetracker/.screencast_token`
2. **Loaded** on subsequent app starts and passed in the `SelectSources()` call
3. The compositor recognizes the token and **skips the permission dialog**

```python
def get_saved_token() -> Optional[str]:
    """Load saved restore token from disk."""
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, 'r') as f:
            return f.read().strip()
    return None

def save_token(token: str) -> None:
    """Save restore token for persistent permission."""
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    with open(TOKEN_FILE, 'w') as f:
        f.write(token)
```

### 4.5 Screenshot Daemon (Unix Socket IPC)

Establishing a PipeWire session has non-trivial overhead (~1-3 seconds). To avoid this on every screenshot, a **persistent daemon** keeps the session alive:

```
┌─────────────────────────────────────────────────────┐
│               Screenshot Daemon Architecture         │
│                                                      │
│  ┌─────────────┐     Unix Socket     ┌────────────┐ │
│  │  Desktop App │ ──────────────────→ │   Daemon   │ │
│  │  (Client)    │ ←────────────────── │  Process   │ │
│  └─────────────┘                      └────────────┘ │
│       Sends:                           Maintains:    │
│       CAPTURE:/path                    PipeWire fd   │
│       PING                             GStreamer     │
│       STATUS                           Session state │
│       RESTART                                        │
│       QUIT                                           │
└─────────────────────────────────────────────────────┘
```

**Socket Path:** `~/.local/share/timetracker/.screenshot_socket`

**Protocol Commands:**

| Command | Request | Response | Purpose |
|---------|---------|----------|---------|
| `CAPTURE` | `CAPTURE:/tmp/screenshot.png` | `OK` or `ERROR:message` | Capture screenshot to path |
| `PING` | `PING` | `PONG` | Health check |
| `STATUS` | `STATUS` | `STATUS:initialized=True,...` | Session state info |
| `RESTART` | `RESTART` | `OK:restarted` | Re-initialize session (re-prompt permission) |
| `QUIT` | `QUIT` | `OK:stopping` | Graceful shutdown |

**Daemon Lifecycle:**

1. The main desktop app calls `_start_screenshot_daemon()`, which spawns a subprocess:
   ```python
   subprocess.Popen([sys.executable, 'wayland_screenshot.py', '--daemon'])
   ```
2. The daemon initializes the ScreenCast session once
3. It listens on the Unix socket for capture requests
4. Each `CAPTURE` command triggers a GStreamer pipeline using the persistent PipeWire fd
5. The desktop app monitors daemon health via `PING` commands
6. After 3 consecutive failures, the daemon is automatically restarted

### 4.6 Fallback: Subprocess Mode

If the daemon cannot be started or is unresponsive, a fallback mode captures screenshots using a fresh subprocess per capture:

```python
def _capture_screenshot_subprocess() -> Optional[Image.Image]:
    """Fallback: One subprocess per screenshot (slower but reliable)."""
    output_path = tempfile.mktemp(suffix='.png')
    result = subprocess.run(
        [sys.executable, 'wayland_screenshot.py', 'capture', output_path],
        timeout=15
    )
    if result.returncode == 0 and os.path.exists(output_path):
        return Image.open(output_path)
```

This is slower (~2-5 seconds per capture) because it re-establishes the PipeWire session each time. It's used only when the daemon approach fails.

---

## 5. Idle Detection on Linux

**File:** `python-desktop-app/desktop_app_linux.py`

**Problem:** Windows uses `GetLastInputInfo()` to get the time since last keyboard/mouse input. On Linux under Wayland, `pynput` and `Xlib` cannot monitor global input events (security restriction).

**Solution:** D-Bus call to GNOME Mutter's `IdleMonitor`:

```python
def get_idle_time_linux() -> float:
    """Get system idle time in seconds via D-Bus GNOME Mutter IdleMonitor."""
    bus = dbus.SessionBus()
    idle_proxy = bus.get_object(
        'org.gnome.Mutter.IdleMonitor',
        '/org/gnome/Mutter/IdleMonitor/Core'
    )
    idle_iface = dbus.Interface(idle_proxy, 'org.gnome.Mutter.IdleMonitor')
    idle_ms = idle_iface.GetIdletime()
    return idle_ms / 1000.0
```

| Aspect | Detail |
|--------|--------|
| D-Bus Service | `org.gnome.Mutter.IdleMonitor` |
| D-Bus Path | `/org/gnome/Mutter/IdleMonitor/Core` |
| Method | `GetIdletime()` |
| Returns | Milliseconds since last input event |
| Compatibility | GNOME Shell (Wayland & X11) |
| Fallback | `pynput` if Mutter unavailable (X11 sessions) |

---

## 6. Active Window Tracking

**File:** `python-desktop-app/desktop_app_linux.py`

### Primary: EWMH (Extended Window Manager Hints)

Uses the `ewmh` Python library with `python-xlib` to query the X11/XWayland window manager:

```python
from ewmh import EWMH
import Xlib.display

def get_active_window_linux() -> Dict:
    wm = EWMH()
    active_window = wm.getActiveWindow()
    title = wm.getWmName(active_window) or ""
    pid = wm.getWmPid(active_window)
    app_name = psutil.Process(pid).name() if pid else ""
    return {
        'title': title,
        'app': app_name,
        'window_key': f"{app_name}|{title}",
        'is_new_window': True
    }
```

| Library | Version | PyPI Package | Purpose |
|---------|---------|-------------|---------|
| `ewmh` | 0.1.6 | `ewmh` | Query EWMH-compliant window managers |
| `python-xlib` | 0.33 | `python-xlib` | Low-level X11 protocol bindings |
| `psutil` | 5.9.6 | `psutil` | Resolve PID → process name |

### Fallback: xdotool + xprop

If EWMH libraries are unavailable:

```python
def _get_active_window_fallback() -> Dict:
    # Get active window ID
    window_id = subprocess.check_output(['xdotool', 'getactivewindow']).strip()
    # Get window title
    title = subprocess.check_output(['xdotool', 'getactivewindow', 'getwindowname']).strip()
    # Get PID
    pid = subprocess.check_output(['xdotool', 'getactivewindow', 'getwindowpid']).strip()
    # Get WM_CLASS via xprop
    xprop = subprocess.check_output(['xprop', '-id', window_id, 'WM_CLASS']).strip()
```

> **Note:** Under pure Wayland (no XWayland), window tracking capabilities are limited. EWMH requires an X11 connection. Most Wayland compositors run XWayland for compatibility, providing access through EWMH. Native Wayland window tracking is not yet standardized.

---

## 7. Desktop Notifications

**File:** `python-desktop-app/desktop_app_linux.py`

```python
def show_notification_linux(title: str, message: str, duration: int = 5000) -> bool:
    """Show desktop notification using notify-send (libnotify)."""
    try:
        subprocess.run(
            ['notify-send', title, message, '-t', str(duration)],
            check=True, timeout=5
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False
```

| Aspect | Detail |
|--------|--------|
| Command | `notify-send` |
| Package | `libnotify-bin` (Debian/Ubuntu), `libnotify` (Fedora/Arch) |
| Protocol | D-Bus `org.freedesktop.Notifications` |
| Compatibility | GNOME, KDE, XFCE, Sway, any FreeDesktop-compliant DE |
| Duration | Default 5000ms, configurable |

---

## 8. Auto-Start (Login Startup)

**File:** `python-desktop-app/desktop_app_linux.py`

Follows the **XDG Autostart Specification**:

```python
def add_to_startup_linux(app_name: str, exe_path: str) -> bool:
    """Create .desktop file in ~/.config/autostart/ for login auto-start."""
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
Comment=Time tracking desktop agent
Categories=Utility;
"""
    desktop_file = os.path.join(autostart_dir, "timetracker.desktop")
    with open(desktop_file, 'w') as f:
        f.write(desktop_entry)
    return True
```

| Aspect | Detail |
|--------|--------|
| Location | `~/.config/autostart/timetracker.desktop` |
| Spec | XDG Autostart (freedesktop.org) |
| Delay | 10 seconds (`X-GNOME-Autostart-Delay=10`) |
| Removal | Delete the `.desktop` file |

---

## 9. Single-Instance Lock

**File:** `python-desktop-app/desktop_app_linux.py`

Uses POSIX file locking to ensure only one instance of the app runs:

```python
import fcntl

def acquire_single_instance_lock_linux(lock_file_path: str) -> bool:
    """Acquire exclusive file lock using fcntl (non-blocking)."""
    global _linux_lock_file
    _linux_lock_file = open(lock_file_path, 'w')
    try:
        fcntl.flock(_linux_lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        _linux_lock_file.write(str(os.getpid()))
        _linux_lock_file.flush()
        return True
    except (IOError, OSError):
        return False  # Another instance holds the lock

def release_single_instance_lock_linux() -> None:
    """Release the fcntl lock."""
    global _linux_lock_file
    if _linux_lock_file:
        fcntl.flock(_linux_lock_file.fileno(), fcntl.LOCK_UN)
        _linux_lock_file.close()
        _linux_lock_file = None
```

| Aspect | Detail |
|--------|--------|
| Mechanism | `fcntl.flock()` with `LOCK_EX | LOCK_NB` (exclusive, non-blocking) |
| Lock File | Configurable path (typically in app data directory) |
| PID Written | For debugging — identifies which process holds the lock |
| Auto-Release | Lock is released on process termination by the kernel |

---

## 10. Application Data Directory (XDG Compliance)

**File:** `python-desktop-app/desktop_app_linux.py` and `python-desktop-app/local_storage/sqlite_manager.py`

All application data follows the **XDG Base Directory Specification**:

```python
def get_app_data_dir_linux() -> str:
    """Get XDG-compliant application data directory."""
    xdg_data = os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share'))
    app_dir = os.path.join(xdg_data, 'timetracker')
    os.makedirs(app_dir, exist_ok=True)
    return app_dir
```

**Directory Layout:**

```
~/.local/share/timetracker/
├── hybrid_ocr_storage.db          # SQLite database (activity records, sessions, cache)
├── .screencast_token              # Wayland ScreenCast restore token
├── .screenshot_socket             # Unix socket for daemon IPC
├── logs/                          # Application logs
└── screenshots/                   # Temporary screenshot files
```

| XDG Variable | Default | Usage |
|---|---|---|
| `$XDG_DATA_HOME` | `~/.local/share` | Database, tokens, persistent data |
| `$XDG_CONFIG_HOME` | `~/.config` | Autostart `.desktop` file |
| `$XDG_RUNTIME_DIR` | `/run/user/$UID` | Ephemeral sockets (alternative) |

---

## 11. Hybrid OCR System (On-Device Text Extraction)

### 11.1 OCR Architecture & Fallback Chain

**Directory:** `python-desktop-app/ocr/`

The Hybrid OCR system extracts text from screenshots **locally on the device** before uploading to the server. This is a major Linux-specific enhancement that dramatically reduces bandwidth and AI costs.

```
┌──────────────────────────────────────────────────────────────────┐
│              Hybrid OCR Fallback Chain                            │
│                                                                  │
│  Screenshot (PIL Image)                                          │
│       │                                                          │
│       ▼                                                          │
│  preprocess_screenshot()   ─── Resize, RGB, engine-specific      │
│       │                                                          │
│       ▼                                                          │
│  ┌─── OCRFacade.extract_text() ───┐                              │
│  │                                │                              │
│  │  1. PaddleOCR (Primary)        │  Accuracy: 95-98%            │
│  │     ├─ Success → return result │  Speed: 500-1500ms           │
│  │     └─ Failure → try next      │                              │
│  │                                │                              │
│  │  2. Tesseract (Fallback 1)     │  Accuracy: 85-90%            │
│  │     ├─ Success → return result │  Speed: 2000-4000ms          │
│  │     └─ Failure → try next      │                              │
│  │                                │                              │
│  │  3. Metadata (Fallback 2)      │  Accuracy: N/A (metadata)    │
│  │     └─ Always returns result   │  Speed: <1ms                 │
│  └────────────────────────────────┘                              │
│       │                                                          │
│       ▼                                                          │
│  PrivacyFilter.filter_text()  ─── Redact sensitive data          │
│       │                                                          │
│       ▼                                                          │
│  OCRResult {text, confidence, method, processing_time_ms}        │
│       │                                                          │
│       ▼                                                          │
│  Store in SQLite → Batch Upload to Supabase                      │
└──────────────────────────────────────────────────────────────────┘
```

**Singleton Pattern:** The `OCRFacade` uses a thread-safe singleton:

```python
class OCRFacade:
    _instance = None
    _lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> 'OCRFacade':
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance
```

**Engine Backoff:** When an engine fails, it enters a **300-second backoff period** to avoid repeated initialization attempts:

```python
def _is_engine_in_backoff(self, engine_name: str) -> bool:
    last_fail = self._engine_failures.get(engine_name)
    if last_fail and (datetime.now() - last_fail) < timedelta(seconds=300):
        return True
    return False
```

### 11.2 PaddleOCR Engine (Primary)

**File:** `python-desktop-app/ocr/engines/paddle_engine.py`

| Aspect | Detail |
|--------|--------|
| Library | `paddleocr` 2.8.0+ with `paddlepaddle` 2.5.0+ |
| Accuracy | 95–98% |
| Speed | 500–1500ms per screenshot |
| GPU | Disabled by default (`use_gpu=False`) |
| Model | Auto-downloaded on first use (~150MB) |
| Thread Safety | Singleton pattern with lock |

**Initialization Parameters:**

```python
from paddleocr import PaddleOCR

self._ocr = PaddleOCR(
    use_angle_cls=True,     # Detect rotated text
    lang='en',              # English text recognition
    use_gpu=False,          # CPU mode (typical Linux desktop)
    show_log=False,         # Suppress verbose logging
    det_db_thresh=0.3,      # Text detection sensitivity
    rec_batch_num=6         # Batch size for recognition
)
```

**Extraction Process:**

1. PIL Image → NumPy array (RGB)
2. `self._ocr.ocr(img_array, cls=True)` → per-line results
3. Parse: `[[bounding_box], [text_string, confidence_float]]`
4. Aggregate text, calculate average confidence
5. Return `OCRResult`

### 11.3 Tesseract Engine (Fallback)

**File:** `python-desktop-app/ocr/engines/tesseract_engine.py`

| Aspect | Detail |
|--------|--------|
| Library | `pytesseract` 0.3.10+ wrapping Tesseract OCR binary |
| System Binary | `tesseract-ocr` (typically at `/usr/bin/tesseract`) |
| Accuracy | 85–90% |
| Speed | 2000–4000ms per screenshot |
| Config | `--oem 3 --psm 3` (LSTM engine + auto page segmentation) |

**Initialization:**

```python
import pytesseract
import shutil

def initialize(self) -> bool:
    tesseract_path = shutil.which('tesseract') or '/usr/bin/tesseract'
    pytesseract.pytesseract.tesseract_cmd = tesseract_path
    pytesseract.get_tesseract_version()  # Verify installation
```

**Extraction:**

```python
data = pytesseract.image_to_data(
    image,
    lang='eng',
    config='--oem 3 --psm 3',
    output_type=pytesseract.Output.DICT
)
# Parse data['text'], data['conf'], data['line_num']
# Group words by line, join, calculate confidence
```

**Tesseract Config Explained:**

| Flag | Value | Meaning |
|------|-------|---------|
| `--oem` | 3 | Use LSTM neural network engine (best accuracy) |
| `--psm` | 3 | Fully automatic page segmentation |

### 11.4 Metadata Engine (Last Resort)

**File:** `python-desktop-app/ocr/engines/metadata_engine.py`

When both OCR engines fail, the metadata engine returns the window title and application name as the "extracted text":

```python
def extract_text(self, image=None) -> OCRResult:
    text = f"{self._app_name} - {self._window_title}"
    return OCRResult(
        text=text,
        confidence=0.5,
        method='metadata',
        line_count=1,
        word_count=len(text.split()),
        processing_time_ms=0.0
    )
```

This ensures the AI server always has **some context** for activity classification, even without OCR.

### 11.5 Image Preprocessing Pipeline

**File:** `python-desktop-app/ocr/image_processor.py`

Before OCR extraction, screenshots are preprocessed:

```python
def preprocess_screenshot(image: Image.Image, engine_hint: str = 'paddle') -> Image.Image:
    # 1. Convert to RGB (handles RGBA screenshots)
    image = image.convert('RGB')

    # 2. Resize if larger than 1920x1080
    if image.width > 1920 or image.height > 1080:
        image.thumbnail((1920, 1080), Image.LANCZOS)

    # 3. Engine-specific preprocessing
    if engine_hint == 'tesseract':
        image = _preprocess_for_tesseract(image)

    return image
```

**Tesseract-specific preprocessing:**

```python
def _preprocess_for_tesseract(image: Image.Image) -> Image.Image:
    # Convert to grayscale (Tesseract works better)
    image = image.convert('L')
    # Enhance contrast (1.5x)
    enhancer = ImageEnhance.Contrast(image)
    image = enhancer.enhance(1.5)
    # Apply sharpening filter
    image = image.filter(ImageFilter.SHARPEN)
    return image
```

**Duplicate Detection:**

```python
def calculate_image_hash(image: Image.Image) -> str:
    """Perceptual hash — detect duplicate/similar screenshots."""
    small = image.resize((8, 8), Image.LANCZOS).convert('L')
    pixels = list(small.getdata())
    avg = sum(pixels) / len(pixels)
    return ''.join('1' if p > avg else '0' for p in pixels)
```

### 11.6 Privacy Filter

**File:** `python-desktop-app/ocr/privacy_filter.py`

All OCR output passes through a privacy filter that redacts sensitive data using compiled regex patterns:

| Pattern | Match Example | Replacement |
|---------|---|---|
| Credit Card | `4111 1111 1111 1111` | `[CARD_REDACTED]` |
| SSN | `123-45-6789` | `[SSN_REDACTED]` |
| Phone Numbers | `(555) 123-4567` | `[PHONE_REDACTED]` |
| Email Addresses | `user@example.com` | `[EMAIL_REDACTED]` |
| API Keys/Tokens | 32+ character alphanumeric strings | `[TOKEN_REDACTED]` |
| AWS Keys | `AKIA...` (20 chars) | `[AWS_KEY_REDACTED]` |
| Passwords | `password=secret123` | `[PASSWORD_REDACTED]` |
| Bearer Tokens | `Bearer eyJ...` | `[BEARER_REDACTED]` |
| Internal IPs | `192.168.1.100` | `[INTERNAL_IP_REDACTED]` |

**Context-Based Blocking:** OCR is skipped entirely when the active window belongs to sensitive applications:

```python
SENSITIVE_APPS = [
    'keepass', 'lastpass', '1password', 'bitwarden',
    'bank', 'chase', 'payroll', 'medical', 'tax'
]

def should_skip_ocr(window_title: str, app_name: str) -> Tuple[bool, str]:
    """Return (True, reason) if OCR should be skipped entirely."""
    lower_app = app_name.lower()
    for sensitive in SENSITIVE_APPS:
        if sensitive in lower_app:
            return True, f"Sensitive application: {sensitive}"
    return False, ""
```

---

## 12. Local Storage (SQLite)

### 12.1 Database Schema

**File:** `python-desktop-app/local_storage/sqlite_manager.py`

**Database Path:** `~/.local/share/timetracker/hybrid_ocr_storage.db`

**SQLite Configuration:**

| Setting | Value | Purpose |
|---------|-------|---------|
| Journal Mode | WAL (Write-Ahead Logging) | Better read concurrency |
| Busy Timeout | 30 seconds | Wait rather than fail on lock contention |
| Connection Scope | Thread-local | Each thread gets its own connection |
| Singleton | Yes (with threading lock) | Single manager instance |

**Tables:**

#### `active_sessions`

Tracks accumulated time per window during the current tracking period:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `window_title` | TEXT | Window title bar text |
| `application_name` | TEXT | Process/application name |
| `classification` | TEXT | AI classification (productive/unproductive/neutral) |
| `ocr_text` | TEXT | Last OCR extraction for this window |
| `ocr_method` | TEXT | `paddle` / `tesseract` / `metadata` |
| `ocr_confidence` | REAL | 0.0–1.0 |
| `total_time_seconds` | REAL | Accumulated active time |
| `visit_count` | INTEGER | Number of times window was active |
| `first_seen` | TEXT | ISO timestamp |
| `last_seen` | TEXT | ISO timestamp |
| `timer_started_at` | TEXT | Current timer start |
| **UNIQUE** | | `(window_title, application_name)` |

#### `pending_activity_records`

Queue of activity records waiting for batch upload to Supabase:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `user_id` | TEXT | Authenticated user ID |
| `organization_id` | TEXT | Organization scope |
| `window_title` | TEXT | Window title |
| `application_name` | TEXT | Application name |
| `ocr_text` | TEXT | OCR-extracted text |
| `ocr_method` | TEXT | Engine used |
| `ocr_confidence` | REAL | Extraction confidence |
| `classification` | TEXT | AI classification |
| `start_time` | TEXT | Activity start (ISO) |
| `end_time` | TEXT | Activity end (ISO) |
| `duration_seconds` | REAL | Duration |
| `work_date` | TEXT | YYYY-MM-DD |
| `user_timezone` | TEXT | User timezone string |
| `user_assigned_issues` | TEXT | JSON array of Jira issue keys |
| `project_key` | TEXT | Jira project key |
| `metadata` | TEXT | JSON additional metadata |
| `batch_id` | TEXT | Upload batch identifier |
| `synced` | INTEGER | 0=pending, 1=synced |
| `sync_error` | TEXT | Last error message |
| `retry_count` | INTEGER | Number of retry attempts |
| `created_at` | TEXT | Record creation time |

#### `app_classifications_cache`

Server-synced classification lookup:

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `organization_id` | TEXT | Org scope |
| `project_key` | TEXT | Project key |
| `identifier` | TEXT | App/URL identifier |
| `display_name` | TEXT | Human-readable name |
| `classification` | TEXT | productive/unproductive/neutral |
| `match_by` | TEXT | `process` |
| `cached_at` | TEXT | Cache timestamp |

**Indices:**
- `idx_sessions_synced(synced)` — fast lookup of unsynced sessions
- `idx_pending_synced(synced)` — fast lookup of pending records
- `idx_pending_batch(batch_id)` — batch identification
- `idx_pending_user(user_id)` — per-user queries
- `idx_cache_identifier(identifier)` — cache lookups

### 12.2 Session Tracker

**File:** `python-desktop-app/local_storage/session_tracker.py`

The `ActiveSessionTracker` monitors window changes and accumulates time:

```python
@dataclass
class ActiveWindow:
    window_title: str
    application_name: str
    session_id: Optional[int]       # SQLite session ID
    ocr_text: Optional[str]
    ocr_method: Optional[str]
    ocr_confidence: float
    started_at: float               # time.time()
```

**Configuration:**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| `idle_threshold` | 120 seconds | Window idle time before session pause |
| `min_session_duration` | 3 seconds | Ignore windows active for < 3 seconds |

**Key Operations:**

- `on_window_change(title, app, ocr_text, ocr_method, confidence)` — Called on every window switch. Calculates elapsed time for previous window, accumulates in SQLite.
- `get_sessions_for_upload()` — Returns sessions with accumulated time for batch upload.
- `reset_after_upload()` — Resets all session timers after successful upload.

### 12.3 Batch Uploader

**File:** `python-desktop-app/local_storage/batch_uploader.py`

Periodically uploads accumulated activity records to Supabase:

```python
@dataclass
class BatchUploadConfig:
    batch_interval_seconds: int = 300    # Upload every 5 minutes
    max_batch_size: int = 100            # Max records per batch
    max_retry_count: int = 3             # Retry failed uploads
    retry_backoff_seconds: int = 60      # Wait between retries
```

**Upload Flow:**

1. Timer fires every 300 seconds (configurable)
2. `get_pending_records(limit=100)` fetches unsynced records from SQLite
3. Records are uploaded to Supabase via the client library
4. On success: `mark_records_synced(record_ids, batch_id)`
5. On failure: `mark_record_failed(record_id, error)` increments retry count
6. After upload: `_trigger_ai_analysis(batch_id)` calls Supabase Edge Function `analyze-activity-batch`
7. Old synced records (>7 days) are cleaned up automatically

---

## 13. AI Server — Linux Container Configuration

**File:** `ai-server/Dockerfile`

The AI server runs in a Docker container based on Debian Linux:

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY eng.traineddata /usr/share/tesseract-ocr/5/tessdata/
COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
```

| Package | Purpose |
|---------|---------|
| `tesseract-ocr` | Server-side OCR fallback engine |
| `tesseract-ocr-eng` | English language data for Tesseract |
| `libvips-dev` | High-performance image processing (sharp/libvips) |
| `eng.traineddata` | Custom-trained Tesseract model for improved accuracy |

---

## 14. Complete Library & Dependency Reference

### 14.1 Python Packages (pip)

**Core (Cross-Platform):**

| Package | Version | Purpose |
|---------|---------|---------|
| `flask` | 3.0.0 | Local OAuth callback web server |
| `flask-cors` | 4.0.0 | CORS for local server |
| `supabase` | 2.0.0 | Supabase client (database, auth, edge functions) |
| `pystray` | 0.19.5 | System tray icon |
| `Pillow` | ≥11.0.0 | Image processing (screenshots, OCR preprocessing) |
| `psutil` | 5.9.6 | Process management, PID → process name |
| `requests` | 2.31.0 | HTTP client (API calls) |
| `python-dotenv` | 1.0.0 | Load `.env` configuration |
| `cryptography` | 41.0.7 | Token encryption |
| `pynput` | ≥1.8.1 | Keyboard/mouse monitoring (X11 fallback) |
| `keyring` | 25.2.1 | Secure credential storage |
| `tzlocal` | ≥5.0 | Local timezone detection |
| `pyinstaller` | ≥6.16.0 | Application bundling |

**Linux-Only (Window Tracking):**

| Package | Version | Platform Marker | Purpose |
|---------|---------|-----------------|---------|
| `ewmh` | 0.1.6 | `sys_platform == 'linux'` | EWMH window manager queries |
| `python-xlib` | 0.33 | `sys_platform == 'linux'` | X11 protocol bindings |

**Linux-Only (OCR):**

| Package | Version | Purpose |
|---------|---------|---------|
| `paddlepaddle` | ≥2.5.0 | PaddlePaddle deep learning framework |
| `paddleocr` | ≥2.8.0 | PaddleOCR text recognition engine |
| `pytesseract` | ≥0.3.10 | Python wrapper for Tesseract OCR |
| `opencv-python-headless` | ≥4.8.0 | Image processing for OCR (no GUI) |
| `numpy` | ≥1.24.0 | Array operations for image/OCR data |

**Windows-Only (not installed on Linux):**

| Package | Version | Purpose |
|---------|---------|---------|
| `pywin32` | 306 | Win32 API access |
| `winotify` | 1.1.0 | Windows toast notifications |

### 14.2 System Packages by Distribution

#### Ubuntu / Debian (`apt`)

```bash
# Wayland Screenshot (GStreamer + PipeWire + PyGObject)
sudo apt install -y \
    python3-gi \
    python3-gi-cairo \
    gir1.2-gstreamer-1.0 \
    gstreamer1.0-pipewire \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good

# OCR
sudo apt install -y \
    tesseract-ocr \
    tesseract-ocr-eng

# Desktop Integration
sudo apt install -y \
    libnotify-bin

# Build Dependencies (for pip packages)
sudo apt install -y \
    python3-dev \
    build-essential
```

#### Fedora / RHEL (`dnf`)

```bash
# Wayland Screenshot
sudo dnf install -y \
    python3-gobject \
    python3-cairo \
    gstreamer1-plugins-base \
    pipewire-gstreamer

# OCR
sudo dnf install -y \
    tesseract \
    tesseract-langpack-eng

# Desktop Integration
sudo dnf install -y \
    libnotify
```

#### Arch Linux (`pacman`)

```bash
# Wayland Screenshot
sudo pacman -S --noconfirm \
    python-gobject \
    python-cairo \
    gst-plugins-base \
    gst-plugin-pipewire

# OCR
sudo pacman -S --noconfirm \
    tesseract \
    tesseract-data-eng

# Desktop Integration
sudo pacman -S --noconfirm \
    libnotify
```

**System Package Purpose Reference:**

| Package (Ubuntu) | Provides | Used By |
|---|---|---|
| `python3-gi` | PyGObject (GObject Introspection for Python) | D-Bus calls, GStreamer, GLib |
| `python3-gi-cairo` | Cairo bindings for PyGObject | Rendering support |
| `gir1.2-gstreamer-1.0` | GStreamer introspection typelib | `gi.repository.Gst` import |
| `gstreamer1.0-pipewire` | PipeWire source element for GStreamer | `pipewiresrc` element in pipeline |
| `gstreamer1.0-plugins-base` | Base GStreamer plugins (videoconvert) | `videoconvert` element |
| `gstreamer1.0-plugins-good` | Good-quality plugins (pngenc) | `pngenc` for PNG encoding |
| `tesseract-ocr` | Tesseract OCR binary | `/usr/bin/tesseract` |
| `tesseract-ocr-eng` | English language data | Tesseract text recognition |
| `libnotify-bin` | `notify-send` command | Desktop notifications |

---

## 15. Installation Script (install_linux.sh)

**File:** `python-desktop-app/install_linux.sh` (~210 lines)

The installation script automates the full Linux setup:

```bash
#!/bin/bash
set -e

# Step 1: Detect package manager
if command -v apt &>/dev/null; then
    PKG_MANAGER="apt"
    INSTALL_CMD="sudo apt install -y"
elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
    INSTALL_CMD="sudo dnf install -y"
elif command -v pacman &>/dev/null; then
    PKG_MANAGER="pacman"
    INSTALL_CMD="sudo pacman -S --noconfirm"
fi

# Step 2: Install Wayland/PipeWire system packages
# Step 3: Install OCR system packages (Tesseract)
# Step 4: Install Python dependencies via pip
# Step 5: Pre-download PaddleOCR models
# Step 6: Verify all dependencies
```

**Verification Checks Performed:**

1. PyGObject (`gi.repository.GLib`)
2. GStreamer 1.0 (`gi.repository.Gst`)
3. PipeWire GStreamer plugin (`pipewiresrc`)
4. Pillow, pynput, notify-send
5. Tesseract binary and version
6. PaddleOCR importability
7. pytesseract importability
8. OpenCV importability

---

## 16. Environment Variables

| Variable | Default | File | Purpose |
|----------|---------|------|---------|
| `XDG_DATA_HOME` | `~/.local/share` | `sqlite_manager.py` | App data directory base |
| `XDG_SESSION_TYPE` | (system) | `desktop_app_linux.py` | Detect `wayland` vs `x11` |
| `XDG_CURRENT_DESKTOP` | (system) | `desktop_app_linux.py` | Detect desktop environment |
| `DESKTOP_SESSION` | (system) | `desktop_app_linux.py` | Desktop session type |
| `DISPLAY` | (system) | EWMH usage | X11 display server connection |
| `OCR_PRIMARY_ENGINE` | `paddle` | `ocr/config.py` | Primary OCR engine selection |
| `OCR_USE_GPU` | `false` | `ocr/config.py` | Enable/disable GPU for PaddleOCR |
| `OCR_LANGUAGE` | `en` | `ocr/config.py` | OCR language |
| `OCR_MIN_CONFIDENCE` | `0.5` | `ocr/config.py` | Minimum confidence threshold |
| `OCR_MIN_TEXT_LENGTH` | `10` | `ocr/config.py` | Minimum text characters for valid OCR |
| `OCR_PRIVACY_FILTER` | `true` | `ocr/config.py` | Enable/disable privacy redaction |
| `OCR_FALLBACK_ENABLED` | `true` | `ocr/config.py` | Enable fallback engine chain |
| `TESSERACT_CMD` | `/usr/bin/tesseract` | `ocr/config.py` | Tesseract binary path |
| `TESSERACT_LANG` | `eng` | `ocr/config.py` | Tesseract language |
| `NODE_ENV` | `production` | `ai-server/Dockerfile` | Node.js environment |
| `PORT` | `8080` | `ai-server/Dockerfile` | AI server port |

---

## 17. File Structure: Linux-Specific Files

```
python-desktop-app/
├── desktop_app.py                      # Main app — platform detection + Linux routing
├── desktop_app_linux.py                # Linux implementations (idle, window, notification, startup)
├── wayland_screenshot.py               # Wayland ScreenCast + PipeWire + GStreamer + Daemon
├── requirements.txt                    # Dependencies with platform markers
├── install_linux.sh                    # Multi-distro installation script
├── LINUX_MIGRATION_PLAN.md             # Migration planning document
├── LINUX_INTEGRATION_GUIDE.md          # Integration instructions
├── LINUX_QUICKREF.md                   # Quick reference card
├── IDLE_DETECTION_GUIDE.md             # D-Bus idle detection details
│
├── ocr/                                # Hybrid OCR module (Linux-primary)
│   ├── __init__.py
│   ├── config.py                       # OCR configuration + environment variables
│   ├── facade.py                       # OCR facade with fallback chain
│   ├── image_processor.py              # Screenshot preprocessing
│   ├── privacy_filter.py              # Sensitive data redaction
│   └── engines/
│       ├── __init__.py
│       ├── base.py                     # OCRResult dataclass + BaseOCREngine ABC
│       ├── paddle_engine.py            # PaddleOCR engine (primary)
│       ├── tesseract_engine.py         # Tesseract engine (fallback)
│       └── metadata_engine.py          # Window metadata engine (last resort)
│
└── local_storage/                      # SQLite local storage (Linux-primary)
    ├── __init__.py
    ├── sqlite_manager.py               # SQLite database + schema + CRUD
    ├── session_tracker.py              # Active window session tracker
    └── batch_uploader.py               # Batched upload to Supabase
```

---

## 18. End-to-End Data Flow on Linux

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    COMPLETE LINUX DATA FLOW                                   │
│                                                                              │
│  ┌──────────────────┐                                                        │
│  │  Timer (30s loop) │                                                        │
│  └────────┬─────────┘                                                        │
│           │                                                                   │
│           ▼                                                                   │
│  ┌──────────────────┐    D-Bus (GNOME Mutter)                                │
│  │ get_idle_time()   │────────────────────────→ Return idle_ms               │
│  └────────┬─────────┘                                                        │
│           │ (if not idle)                                                     │
│           ▼                                                                   │
│  ┌──────────────────┐    EWMH/X11 (python-xlib)                             │
│  │ get_active_window │────────────────────────→ {title, app, pid}            │
│  └────────┬─────────┘                                                        │
│           │                                                                   │
│           ▼                                                                   │
│  ┌──────────────────┐    Unix Socket (daemon)                                │
│  │ capture_screenshot│────CAPTURE:/tmp/ss.png──→ Screenshot Daemon           │
│  │ _screencast_     │                            │                           │
│  │ portal()         │                            ├─ GStreamer pipeline        │
│  │                  │←───OK────────────────────← ├─ pipewiresrc → pngenc     │
│  └────────┬─────────┘                            └─ filesink → /tmp/ss.png   │
│           │                                                                   │
│           ▼                                                                   │
│  ┌──────────────────┐                                                        │
│  │ privacy_filter.   │─── Check: should_skip_ocr(app, title)?                │
│  │ should_skip_ocr() │                                                        │
│  └────────┬─────────┘    (if sensitive app → skip OCR, use metadata only)    │
│           │                                                                   │
│           ▼                                                                   │
│  ┌──────────────────┐                                                        │
│  │ preprocess_       │─── Convert to RGB, resize ≤1920x1080                  │
│  │ screenshot()      │─── (Tesseract: grayscale + contrast + sharpen)         │
│  └────────┬─────────┘                                                        │
│           │                                                                   │
│           ▼                                                                   │
│  ┌──────────────────┐                                                        │
│  │ OCRFacade.        │─── Try PaddleOCR → Try Tesseract → Use Metadata       │
│  │ extract_text()    │                                                        │
│  └────────┬─────────┘                                                        │
│           │                                                                   │
│           ▼                                                                   │
│  ┌──────────────────┐                                                        │
│  │ PrivacyFilter.    │─── Regex: redact cards, SSNs, emails, tokens, IPs     │
│  │ filter_text()     │                                                        │
│  └────────┬─────────┘                                                        │
│           │                                                                   │
│           ▼                                                                   │
│  ┌──────────────────┐    OCRResult {text, confidence, method}                │
│  │ SessionTracker.   │─── Accumulate time for this window in SQLite          │
│  │ on_window_change()│                                                        │
│  └────────┬─────────┘                                                        │
│           │                                                                   │
│           ▼                                                                   │
│  ┌──────────────────────────────────────────────┐                            │
│  │           SQLite (hybrid_ocr_storage.db)      │                            │
│  │  ┌─────────────────┐  ┌────────────────────┐ │                            │
│  │  │ active_sessions  │  │ pending_activity   │ │                            │
│  │  │ (in-progress)    │  │ _records (queue)   │ │                            │
│  │  └─────────────────┘  └────────────────────┘ │                            │
│  └──────────────────┬───────────────────────────┘                            │
│                     │                                                         │
│                     │ (every 300 seconds)                                     │
│                     ▼                                                         │
│  ┌──────────────────┐                                                        │
│  │ BatchUploader.    │────  Upload text + metadata to Supabase               │
│  │ upload_batch()    │────  Trigger: analyze-activity-batch Edge Function     │
│  └──────────────────┘                                                        │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key Metrics:**

| Metric | Screenshot Upload (Old) | Hybrid OCR (Linux) | Improvement |
|--------|---|---|---|
| Data per capture | ~500KB–2MB (PNG image) | ~1–10KB (text + metadata) | **96–99% reduction** |
| AI processing cost | Vision API per image | Text-only analysis | **85–96% reduction** |
| Latency | Upload + server OCR + analysis | Local OCR + text upload | **~50% faster** |
| Privacy | Full screenshot sent to server | Redacted text only | **Significantly improved** |

---

## 19. Troubleshooting Guide

### Screenshot Issues

| Symptom | Cause | Solution |
|---------|-------|---------|
| Blank/black screenshots | Missing PipeWire GStreamer plugin | `sudo apt install gstreamer1.0-pipewire` |
| Permission dialog every time | `persist_mode` not 2, or token not saved | Check `~/.local/share/timetracker/.screencast_token` exists |
| "No module named gi" | Missing PyGObject | `sudo apt install python3-gi python3-gi-cairo` |
| "No element pipewiresrc" | PipeWire plugin not in GStreamer registry | `sudo apt install gstreamer1.0-pipewire` then `gst-inspect-1.0 pipewiresrc` |
| Daemon socket not responding | Daemon crashed | Delete `~/.local/share/timetracker/.screenshot_socket` and restart app |
| Screenshot capture timeout | GStreamer pipeline stalled | Restart daemon: send `RESTART` command or restart app |

### OCR Issues

| Symptom | Cause | Solution |
|---------|-------|---------|
| "ModuleNotFoundError: paddleocr" | PaddleOCR not installed | `pip install paddlepaddle paddleocr` |
| PaddleOCR slow first run | Downloading models (~150MB) | Run `install_linux.sh` to pre-download or wait for first-time initialization |
| Tesseract "command not found" | Tesseract not installed | `sudo apt install tesseract-ocr tesseract-ocr-eng` |
| Low OCR confidence | Poor image quality | Check screenshot resolution and preprocessing |
| All engines in backoff | Multiple failures within 5 minutes | Wait 300 seconds or restart application |

### Window Tracking Issues

| Symptom | Cause | Solution |
|---------|-------|---------|
| "ImportError: ewmh" | EWMH library missing | `pip install ewmh python-xlib` |
| Empty window titles | Pure Wayland app (no XWayland) | Fallback to metadata engine; EWMH requires X11 |
| Window PID not found | Process already exited | Expected for transient windows |

### Desktop Integration Issues

| Symptom | Cause | Solution |
|---------|-------|---------|
| No notifications | `notify-send` not installed | `sudo apt install libnotify-bin` |
| App not auto-starting | `.desktop` file permissions | `chmod 644 ~/.config/autostart/timetracker.desktop` |
| Multiple instances running | Lock file stale | Delete lock file and restart |
| Idle detection not working | Not running GNOME Shell | Idle detection requires Mutter (GNOME); falls back to pynput on other DEs |

### General

| Symptom | Cause | Solution |
|---------|-------|---------|
| `install_linux.sh` fails | Unknown package manager | Manually install packages from Section 14.2 |
| SQLite "database is locked" | Concurrent access issue | WAL mode should handle this; check for zombie processes |
| High CPU from PaddleOCR | Large screenshots or many captures | Set `MAX_IMAGE_SIZE` smaller or increase capture interval |

---

> **Related Documentation:**
> - `docs/LINUX_HYBRID_OCR_IMPLEMENTATION_GUIDE.md` — Phased implementation roadmap
> - `docs/LINUX_SCREENSHOT_AI_WORKFLOW.md` — Step-by-step screenshot workflow with diagrams
> - `docs/HYBRID_OCR_WORKFLOW_DETAILED.md` — Full OCR workflow deep dive
> - `docs/SCREENSHOT_ANALYSIS_PIPELINE.md` — AI analysis pipeline details
> - `python-desktop-app/LINUX_MIGRATION_PLAN.md` — Original Windows → Linux migration plan
> - `python-desktop-app/LINUX_QUICKREF.md` — Quick reference card

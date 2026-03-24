# Wayland Screenshot Capture — Detailed Technical Guide

This document explains **how screenshot capturing works** on Linux/Wayland in the JIRAForge Time Tracker, step by step. It covers what Wayland is, which tools and libraries are used, why each one is needed, and exactly where they appear in the codebase.

---

## Table of Contents

1. [What Is Wayland?](#1-what-is-wayland)
2. [Why Is Screenshot Capture Harder on Wayland?](#2-why-is-screenshot-capture-harder-on-wayland)
3. [High-Level Architecture](#3-high-level-architecture)
4. [Libraries and Tools — What, Why, and Where](#4-libraries-and-tools--what-why-and-where)
   - [4.1 D-Bus (python-dbus)](#41-d-bus-python-dbus)
   - [4.2 XDG Desktop Portal](#42-xdg-desktop-portal)
   - [4.3 PipeWire](#43-pipewire)
   - [4.4 GStreamer](#44-gstreamer)
   - [4.5 GObject Introspection (PyGObject / gi)](#45-gobject-introspection-pygobject--gi)
   - [4.6 Pillow (PIL)](#46-pillow-pil)
   - [4.7 gnome-screenshot](#47-gnome-screenshot)
   - [4.8 grim](#48-grim)
   - [4.9 scrot](#49-scrot)
5. [Step-by-Step Screenshot Capture Flow](#5-step-by-step-screenshot-capture-flow)
   - [5.1 Portal Session Initialization (One-Time)](#51-portal-session-initialization-one-time)
   - [5.2 Frame Capture (Every Screenshot)](#52-frame-capture-every-screenshot)
   - [5.3 Fallback Chain](#53-fallback-chain)
6. [Key Design Decisions](#6-key-design-decisions)
7. [System Packages Required](#7-system-packages-required)
8. [File Reference](#8-file-reference)

---

## 1. What Is Wayland?

**Wayland** is the modern display protocol for Linux, replacing the legacy **X11** (X Window System) that was used for decades. It's the communication layer between applications and the **compositor** (the program that draws windows on your screen — e.g., GNOME Shell uses Mutter as its Wayland compositor).

### Key Differences from X11

| Feature          | X11 (Legacy)                           | Wayland (Modern)                        |
|------------------|----------------------------------------|----------------------------------------|
| Security         | Any app can read any window's pixels   | Apps are **isolated** from each other  |
| Screenshots      | Any app can screenshot the whole screen| Must go through a **portal** (with user permission) |
| Window info      | `xdotool`/`xprop` work freely         | Needs accessibility APIs or compositor support |
| Adoption         | Ubuntu < 22.04, older distros          | Ubuntu 22.04+, Fedora 25+, GNOME 41+  |

The crucial difference for us: **Wayland blocks direct screen access for security**. Applications cannot simply grab pixels from the screen like they could on X11. Instead, they must request permission through the **XDG Desktop Portal** system.

---

## 2. Why Is Screenshot Capture Harder on Wayland?

On **X11**, capturing a screenshot was trivial:
```python
# X11: one line, no permissions needed
import subprocess
subprocess.run(['scrot', 'screenshot.png'])
```

On **Wayland**, this same `scrot` command captures a **blank/black screen** because the compositor blocks direct framebuffer access. Instead, we need to:

1. **Ask the compositor for permission** via D-Bus (XDG Desktop Portal)
2. **Receive a PipeWire video stream** of the screen content
3. **Capture a single frame** from that stream using GStreamer
4. **Convert the raw pixels** to an image format (PIL/Pillow)

This requires a chain of 4–5 different technologies working together, which is why our implementation has multiple fallback levels.

---

## 3. High-Level Architecture

```
User's Screen (GNOME Shell / Mutter compositor)
       │
       │  ① D-Bus request via XDG Desktop Portal
       ▼
┌─────────────────────────────────┐
│  xdg-desktop-portal-gnome       │  (System service)
│  Handles permission dialog      │
│  Creates PipeWire stream        │
└──────────────┬──────────────────┘
               │  ② PipeWire video stream (file descriptor)
               ▼
┌─────────────────────────────────┐
│  PipeWire                       │  (Multimedia server)
│  Routes screen content as       │
│  a video stream to our app      │
└──────────────┬──────────────────┘
               │  ③ GStreamer reads from PipeWire
               ▼
┌─────────────────────────────────┐
│  GStreamer Pipeline             │  (Multimedia framework)
│  pipewiresrc → videoconvert     │
│  → appsink (raw RGB frames)    │
└──────────────┬──────────────────┘
               │  ④ Raw pixel data
               ▼
┌─────────────────────────────────┐
│  PIL / Pillow                   │  (Python image library)
│  Converts raw bytes to image    │
│  Returns PIL.Image object       │
└─────────────────────────────────┘
```

---

## 4. Libraries and Tools — What, Why, and Where

### 4.1 D-Bus (python-dbus)

**What it is:** D-Bus is the inter-process communication (IPC) system used on Linux desktops. It lets applications send messages to system services and other apps over a shared message bus.

**Why we use it:** To communicate with the XDG Desktop Portal service (`org.freedesktop.portal.Desktop`) which controls screen sharing/capture permissions on Wayland.

**Where in the codebase:**

| File | Usage |
|------|-------|
| `wayland_screenshot.py` → `_init_screencast_session()` | Calls `dbus.SessionBus()` to connect, then invokes `CreateSession`, `SelectSources`, `Start`, and `OpenPipeWireRemote` on the ScreenCast portal interface |
| `wayland_screenshot.py` → `_wait_for_response()` | Listens for the portal's `Response` signal via `bus.add_signal_receiver()` |
| `desktop_app_linux.py` → `_capture_gnome_dbus_screenshot()` | Uses D-Bus to call `org.gnome.Shell.Screenshot.Screenshot()` as a fallback |

**System package:** `python3-dbus` (apt) / `python3-dbus` (dnf) / `python-dbus` (pacman)

---

### 4.2 XDG Desktop Portal

**What it is:** The XDG Desktop Portal is a standardized system service that acts as a **permission gatekeeper** between sandboxed/Wayland applications and desktop features like screen capture, file access, and notifications. It provides the `org.freedesktop.portal.ScreenCast` D-Bus interface.

**Why we use it:** It's the **official and only supported way** to capture the screen on Wayland. The portal handles:
- Showing a permission dialog to the user (first time only)
- Creating a PipeWire stream of the screen content
- Providing a **restore token** so subsequent captures skip the dialog

**Where in the codebase:**

| File | Function | Portal Method Called |
|------|----------|-------------------|
| `wayland_screenshot.py` | `_init_screencast_session()` | `ScreenCast.CreateSession()` |
| `wayland_screenshot.py` | `_init_screencast_session()` | `ScreenCast.SelectSources()` |
| `wayland_screenshot.py` | `_init_screencast_session()` | `ScreenCast.Start()` |
| `wayland_screenshot.py` | `_init_screencast_session()` | `ScreenCast.OpenPipeWireRemote()` |

**How the 4-step portal protocol works:**

```
Step 1: CreateSession
   → Creates a session handle for this capture session

Step 2: SelectSources(session, options)
   → options include: types=1 (MONITOR), persist_mode=2, restore_token (if saved)
   → Tells the portal we want to capture a monitor

Step 3: Start(session, "")
   → If first time: shows user a permission dialog ("Share your screen?")
   → If restore token present: skips the dialog automatically
   → Returns: stream info (PipeWire node_id) and a new restore_token

Step 4: OpenPipeWireRemote(session)
   → Returns a file descriptor (fd) that connects to the PipeWire stream
```

**System package:** `xdg-desktop-portal` + `xdg-desktop-portal-gnome` (pre-installed on GNOME desktops)

---

### 4.3 PipeWire

**What it is:** PipeWire is Linux's modern multimedia server that handles both audio and video streams. On Wayland, it replaced PulseAudio (for audio) and also handles video streams for screen sharing.

**Why we use it:** When the XDG Desktop Portal grants us permission to capture the screen, it creates a **PipeWire node** — a video stream of the monitor content. PipeWire manages the routing of this stream from the compositor to our application.

**Where in the codebase:**

| File | Usage |
|------|-------|
| `wayland_screenshot.py` → `_session['pipewire_fd']` | Stores the PipeWire file descriptor obtained from `OpenPipeWireRemote()` |
| `wayland_screenshot.py` → `_session['pipewire_node_id']` | Stores the PipeWire node ID (identifies which stream to capture) |
| `wayland_screenshot.py` → `_capture_frame()` | **`os.dup(fd)`** — duplicates the fd before each capture because GStreamer's `pipewiresrc` takes ownership of the fd and closes it when the pipeline stops |
| `wayland_screenshot.py` → `_close_pipewire_fd()` | Properly closes the original PipeWire fd on session reset |

**Key concept — File Descriptor (fd):** The portal gives us an `fd` (a Unix file descriptor) which is like a "handle" to the PipeWire stream. We pass this fd to GStreamer's `pipewiresrc` element so it knows which stream to read from.

**System package:** `gstreamer1.0-pipewire` (apt) / `pipewire-gstreamer` (dnf) / `gst-plugin-pipewire` (pacman) — this installs the GStreamer plugin that can read from PipeWire streams.

---

### 4.4 GStreamer

**What it is:** GStreamer is a multimedia framework for building media processing pipelines. It works like a chain of elements: a **source** produces data, **filters** process it, and a **sink** consumes the result.

**Why we use it:** GStreamer provides the `pipewiresrc` element that can read from PipeWire streams. We build a pipeline that captures a single video frame from the screen stream and delivers it as raw RGB pixel data.

**Where in the codebase:**

| File | Function | Usage |
|------|----------|-------|
| `wayland_screenshot.py` → `_ensure_gi()` | Initializes GStreamer: `Gst.init(None)` |
| `wayland_screenshot.py` → `_capture_frame()` | Builds and runs the GStreamer pipeline |

**The GStreamer pipeline string:**
```
pipewiresrc fd={dup_fd} path={node_id} do-timestamp=true always-copy=true
   ! videoconvert
   ! video/x-raw,format=RGB
   ! appsink name=sink emit-signals=true max-buffers=1 drop=true sync=false
```

**Breaking it down element by element:**

| Element | What It Does |
|---------|-------------|
| `pipewiresrc` | **Source** — reads video frames from the PipeWire stream using the file descriptor (`fd`) and node ID (`path`) |
| `fd={dup_fd}` | The duplicated PipeWire file descriptor |
| `path={node_id}` | The PipeWire node to capture (obtained from portal's Start response) |
| `do-timestamp=true` | Adds timestamps to frames for proper timing |
| `always-copy=true` | Ensures we get our own copy of each frame |
| `videoconvert` | **Filter** — converts the video format from whatever the compositor provides to our desired format |
| `video/x-raw,format=RGB` | **Caps filter** — specifies we want raw RGB pixel data |
| `appsink` | **Sink** — makes frames available to our Python code (instead of displaying them) |
| `max-buffers=1` | Only keep the latest frame in memory |
| `drop=true` | Drop old frames if we're not reading fast enough |
| `sync=false` | Don't sync to clock — we want frames as fast as possible |

**Pipeline lifecycle:**
- **PLAYING** → pipeline is active, frames flow through
- **PAUSED** → pipeline holds the PipeWire connection but stops frame flow (used between captures to prevent session teardown)
- **NULL** → pipeline is fully torn down (used on error/reset)

**System packages:** `gir1.2-gstreamer-1.0` (GStreamer GI bindings), `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`

---

### 4.5 GObject Introspection (PyGObject / gi)

**What it is:** GObject Introspection (GI) is a bridge that lets Python call C libraries (like GStreamer and GLib) without writing manual bindings. The `gi` Python module dynamically generates Python wrappers from `.typelib` files.

**Why we use it:** GStreamer, GLib, and Gio are all C libraries. Instead of requiring separate Python bindings for each, we use `gi` to access them all through a single, auto-generated interface.

**Where in the codebase:**

```python
# wayland_screenshot.py → _ensure_gi()
import gi
gi.require_version('Gst', '1.0')       # GStreamer 1.0
gi.require_version('Gio', '2.0')       # GIO (file I/O, D-Bus helpers)
from gi.repository import Gst, GLib, Gio
Gst.init(None)                          # Initialize GStreamer subsystem
```

**What each GI module provides:**

| Module | What It Provides | Used For |
|--------|-----------------|----------|
| `Gst` (GStreamer) | Pipeline creation, element factory, state management | Building and running the capture pipeline |
| `GLib` | Main loop, timeout functions | `_wait_for_response()` uses `GLib.MainLoop` to wait for D-Bus signals synchronously |
| `Gio` | Async I/O, D-Bus helpers | Available but primarily used for portal interaction support |

**System package:** `python3-gi` (apt) / `python3-gobject` (dnf) / `python-gobject` (pacman)

---

### 4.6 Pillow (PIL)

**What it is:** Pillow is Python's standard image processing library. It can create, open, manipulate, and save image files.

**Why we use it:** We convert raw RGB pixel bytes from GStreamer into a `PIL.Image` object that the rest of the application can use for OCR processing.

**Where in the codebase:**

| File | Function | Usage |
|------|----------|-------|
| `wayland_screenshot.py` → `_sample_to_image()` | `Image.frombytes('RGB', (width, height), bytes(mapinfo.data))` — converts raw GStreamer buffer to PIL Image |
| `desktop_app_linux.py` → `_capture_gnome_dbus_screenshot()` | `Image.open(saved_path).copy()` — opens the PNG saved by GNOME D-Bus |
| `desktop_app_linux.py` → `_capture_subprocess()` | `Image.open(tmp_path).copy()` — opens the PNG saved by CLI tools |

**Python package:** `Pillow` (installed via pip in `requirements.txt`)

---

### 4.7 gnome-screenshot

**What it is:** A command-line tool that comes with GNOME. It captures a screenshot of the entire screen, a specific window, or a selected area and saves it to a file.

**Why we use it:** As **fallback level 3** — if PipeWire/GStreamer capture fails AND the GNOME D-Bus Screenshot interface is unavailable, we try `gnome-screenshot` as a subprocess.

**Where in the codebase:**
```python
# desktop_app_linux.py → capture_screenshot_linux()
img = _capture_subprocess(['gnome-screenshot', '-f'])
```

**System package:** `gnome-screenshot` (apt)

---

### 4.8 grim

**What it is:** A Wayland screenshot tool for **wlroots-based compositors** (Sway, Hyprland, etc.). It captures the screen via the wlr-screencopy protocol.

**Why we use it:** As **fallback level 4** — for users running Sway or other non-GNOME Wayland compositors.

**Where in the codebase:**
```python
# desktop_app_linux.py → capture_screenshot_linux()
img = _capture_subprocess(['grim'])
```

**Note:** Not installed by default; only useful on wlroots compositors.

---

### 4.9 scrot

**What it is:** A simple X11 screenshot tool. It uses the X11 protocol to capture the screen.

**Why we use it:** As **fallback level 5 (last resort)** — for X11 sessions or XWayland apps. On pure Wayland, `scrot` captures a blank screen because it can't access the Wayland compositor's framebuffer.

**Where in the codebase:**
```python
# desktop_app_linux.py → capture_screenshot_linux()
img = _capture_subprocess(['scrot', '--overwrite'])
```

**System package:** `scrot` (apt/pacman)

---

## 5. Step-by-Step Screenshot Capture Flow

### 5.1 Portal Session Initialization (One-Time)

This happens **once** when the first screenshot is requested. If a restore token exists from a previous run, the permission dialog is skipped.

```
1.  capture_screenshot_linux() is called
2.  → calls wayland_screenshot.capture_screenshot()
3.  → _session['initialized'] is False, so calls _init_screencast_session()
4.  → _ensure_gi() loads GStreamer, GLib, Gio
5.  → Connects to D-Bus session bus: dbus.SessionBus()
6.  → Gets portal proxy: bus.get_object('org.freedesktop.portal.Desktop', ...)
7.  → CreateSession: creates a session handle
8.  → SelectSources: configures capture (monitor, persist, restore token)
9.  → Start: starts the portal session
         └─ First time ever: shows "Share your screen?" dialog to user
         └─ With restore token: silently proceeds (no dialog)
10. → Receives stream info: PipeWire node_id (e.g., 78)
11. → Saves new restore_token to ~/.local/share/timetracker/.screencast_token
12. → OpenPipeWireRemote: gets PipeWire file descriptor (e.g., fd=7)
13. → _session['initialized'] = True
```

### 5.2 Frame Capture (Every Screenshot)

This runs **every time** a screenshot is needed (on window switches, interval captures, etc.).

```
1.  capture_screenshot() acquires _session['lock']
2.  → Validates PipeWire fd is still open (os.fstat)
3.  → Calls _capture_frame()
4.  → If no pipeline exists:
        a. os.dup(fd) — duplicate the PipeWire fd
        b. Build GStreamer pipeline string:
           "pipewiresrc fd=8 path=78 ... ! videoconvert ! ... ! appsink ..."
        c. Gst.parse_launch(pipeline_str)
        d. Store pipeline in _session['pipeline']
5.  → pipeline.set_state(PLAYING)
6.  → appsink.emit('try-pull-sample', 3 seconds timeout)
        └─ Success: got a video frame!
        └─ Timeout: retry with 5 seconds timeout
7.  → _sample_to_image(sample):
        a. Extract buffer from sample
        b. Get width, height from caps
        c. Map buffer memory for reading
        d. Image.frombytes('RGB', (width, height), raw_bytes)
8.  → pipeline.set_state(PAUSED)  ← keeps PipeWire stream alive
9.  → Returns PIL.Image (e.g., 1920×1080 image)
```

### 5.3 Fallback Chain

If the primary PipeWire method fails (or isn't available), the system falls through 5 levels:

```
Level 1: PipeWire/GStreamer Portal [wayland_screenshot.py]
   ✓ Best quality, fastest (35–50ms after first capture)
   ✓ Works with all Wayland apps
   ✗ Requires PipeWire + GStreamer + portal support
   On failure: logs warning, tries Level 2

Level 2: GNOME Shell D-Bus Screenshot [desktop_app_linux.py]
   ✓ No GStreamer dependency
   ✓ Works on GNOME Wayland
   ✗ Only available on GNOME desktops
   ✗ May be blocked by security policies
   On failure: tries Level 3

Level 3: gnome-screenshot subprocess [desktop_app_linux.py]
   ✓ Simple, reliable on GNOME
   ✗ Requires gnome-screenshot installed
   ✗ Slower (subprocess overhead + disk I/O)
   On failure: tries Level 4

Level 4: grim subprocess [desktop_app_linux.py]
   ✓ Works on wlroots compositors (Sway, Hyprland)
   ✗ Not available on GNOME
   On failure: tries Level 5

Level 5: scrot subprocess [desktop_app_linux.py]
   ✓ Works on X11 sessions
   ✗ Captures blank on Wayland (security restriction)
   On failure: raises RuntimeError
```

---

## 6. Key Design Decisions

### Why Keep the Pipeline in PAUSED State?

If we tear the pipeline down (set to NULL) after each capture, the PipeWire stream disconnects. GNOME Shell sees the consumer leave and tears down the ScreenCast portal session. The next capture attempt finds the PipeWire node gone → **"stream error: target not found"**.

By parking the pipeline in PAUSED, the PipeWire connection stays alive, and the portal session remains valid. This also makes subsequent captures much faster (35ms vs 200ms+).

### Why `os.dup(fd)` Before Each Pipeline?

GStreamer's `pipewiresrc` element internally calls `pw_context_connect_fd(fd)` which **takes ownership** of the file descriptor. When the pipeline is destroyed, PipeWire closes that fd. If we passed the original fd, it would be closed after the first capture and unusable for future captures.

By duplicating the fd with `os.dup()`, we give GStreamer its own copy while keeping the original open.

### Why a Restore Token?

The first time the ScreenCast portal is used, the user sees a "Share your screen?" permission dialog. The portal returns a **restore token** which we save to disk (`~/.local/share/timetracker/.screencast_token`). On subsequent runs, we pass this token to `SelectSources`, and the portal silently proceeds without showing the dialog again.

### Why 5 Fallback Levels?

Linux has many desktop environments and display protocols. Not every system has PipeWire, and not every system runs GNOME. The fallback chain ensures screenshots work on:
- GNOME + Wayland (Levels 1, 2, 3)
- Sway/wlroots + Wayland (Levels 1, 4)
- X11 sessions (Level 5)
- Minimal installs without GStreamer (Levels 2–5)

---

## 7. System Packages Required

### Ubuntu / Debian (`apt`)

```bash
sudo apt-get install -y \
    python3-gi              # PyGObject (GObject Introspection)
    python3-gi-cairo        # Cairo bindings for PyGObject
    python3-dbus            # D-Bus Python bindings
    gir1.2-gstreamer-1.0   # GStreamer GI typelib
    gir1.2-atspi-2.0       # AT-SPI accessibility (for window detection)
    gstreamer1.0-pipewire   # PipeWire GStreamer plugin (pipewiresrc)
    gstreamer1.0-plugins-base  # Base GStreamer plugins
    gstreamer1.0-plugins-good  # Good plugins (videoconvert, etc.)
    gnome-screenshot        # GNOME screenshot tool (fallback)
    scrot                   # X11 screenshot tool (fallback)
```

### Fedora / RHEL (`dnf`)

```bash
sudo dnf install -y \
    python3-gobject         # PyGObject
    python3-dbus            # D-Bus bindings
    gstreamer1-plugins-base # Base GStreamer plugins
    pipewire-gstreamer      # PipeWire GStreamer plugin
```

### Arch Linux (`pacman`)

```bash
sudo pacman -S --noconfirm \
    python-gobject          # PyGObject
    python-dbus             # D-Bus bindings
    gst-plugins-base        # Base GStreamer plugins
    gst-plugin-pipewire     # PipeWire GStreamer plugin
    gst-plugins-good        # Good plugins
    scrot                   # X11 screenshot fallback
```

### Python Packages (pip)

```
Pillow                      # Image processing (PIL.Image)
```

---

## 8. File Reference

| File | Role |
|------|------|
| `wayland_screenshot.py` | Core Wayland/PipeWire screenshot capture via XDG ScreenCast Portal + GStreamer |
| `desktop_app_linux.py` → `capture_screenshot_linux()` | Orchestrator — calls `wayland_screenshot` first, falls through to GNOME D-Bus, gnome-screenshot, grim, and scrot |
| `desktop_app_linux.py` → `_capture_gnome_dbus_screenshot()` | Fallback level 2 — uses `org.gnome.Shell.Screenshot` D-Bus interface |
| `desktop_app_linux.py` → `_capture_subprocess()` | Fallback levels 3–5 — runs CLI tools (gnome-screenshot, grim, scrot) via subprocess |
| `install_linux.sh` | Installs all required system packages for screenshot support |
| `~/.local/share/timetracker/.screencast_token` | Saved restore token (skips permission dialog on repeat runs) |

### Key Functions and Their Line Numbers

| Function | File | Line |
|----------|------|------|
| `capture_screenshot()` | `wayland_screenshot.py` | L313 |
| `_init_screencast_session()` | `wayland_screenshot.py` | L105 |
| `_capture_frame()` | `wayland_screenshot.py` | L234 |
| `_sample_to_image()` | `wayland_screenshot.py` | L297 |
| `_destroy_pipeline()` | `wayland_screenshot.py` | L289 |
| `_close_pipewire_fd()` | `wayland_screenshot.py` | L356 |
| `reset_session()` | `wayland_screenshot.py` | L366 |
| `capture_screenshot_linux()` | `desktop_app_linux.py` | L569 |
| `_capture_gnome_dbus_screenshot()` | `desktop_app_linux.py` | L615 |
| `_capture_subprocess()` | `desktop_app_linux.py` | L650 |

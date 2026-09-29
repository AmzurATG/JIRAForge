# Linux Screen Capture: Why It Fails, and How to Build It Properly

**Date:** 2026-09-29
**Component:** `python-desktop-app/` (capture only; no AI server change)
**Status:** Spec / plan. No code has been changed.
**Related:** `docs/LINUX_DESKTOP_APP_PORT_GUIDE.md` (full Linux port; this document goes deeper on capture only)

---

## Part 1: Why screenshot capture fails on Linux, in plain words

### 1.1 The one-sentence version

Windows lets any app look at the screen whenever it wants. Modern Linux does not. Our app still asks the Windows way, so on Linux it gets refused, gets a black picture, or gets a picture with a white flash.

### 1.2 The longer version

**How Windows works.** On Windows the screen is like a whiteboard in an open office. Any program can walk up and take a photo of it. No one is asked, and nothing is shown to the user. Our app does exactly that: every time the user switches window, it quietly photographs the monitor they are working on, reads the text with OCR, and throws the photo away.

**How Linux used to work (X11).** Older Linux desktops used a system called **X11**. X11 worked like Windows: any program could read the screen. If Linux had stayed on X11, our app would mostly just work.

**How Linux works now (Wayland).** Linux desktops have moved to a new system called **Wayland**. Wayland was designed on purpose so that **one app cannot see another app's window**. The screen is now a whiteboard in a locked room. Only the desktop itself (GNOME, KDE, and so on) holds the key. If an app wants a picture, it must ask the desktop, and the desktop decides:

- whether to ask the user first (a dialog),
- whether to show that a picture was taken (a **white flash**, sometimes a camera sound),
- or whether to show a "your screen is being shared" icon.

**Each desktop has its own door.** GNOME, KDE, and the smaller desktops all offer different ways to ask, with different rules. There is no single Linux screenshot command that works everywhere.

**The doors keep moving.** The big desktops change their rules every release. Ubuntu freezes one version for two years and then jumps ahead. So every two years, something that used to work stops working:

| Ubuntu | What changed for screenshots |
|---|---|
| **22.04** (2022) | Users could still choose the old X11 mode at login, where screenshots are easy. On the new Wayland mode, GNOME asks or refuses. |
| **24.04** (2024) | Wayland is the default for nearly everyone. The `gnome-screenshot` tool is no longer installed by default. |
| **26.04** (2026) | **The old X11 mode is gone completely.** The `gnome-screenshot` tool is blocked by GNOME ("Screenshot is not allowed"). Only Wayland rules apply. |

KDE follows in October 2026 (Plasma 6.8 is Wayland-only). Fedora and Red Hat Enterprise Linux 10 have already removed X11.

### 1.3 What our app does on Linux today, and what goes wrong

The capture code (`monitor_capture.py`) only knows the Windows way. On anything that is not Windows, it calls one generic function, `ImageGrab.grab()` from the Pillow library (version 10.1.0). What happens next depends on the machine:

| Situation | What happens | Why |
|---|---|---|
| Old X11 desktop (Linux Mint, Ubuntu 22.04 "Xorg" mode) | It works, but captures **all monitors at once** | The generic function does not know which monitor the user is on. That breaks our own privacy rule: capture only the monitor being used. |
| Ubuntu 24.04 / 26.04 (Wayland) | **Black or half-empty image**, and no error | Wayland still runs a small X11 "compatibility room" (XWayland) for old apps. The generic function looks into that room, sees only old-style windows, and returns black everywhere else. Because it did not fail, it never tries anything else. |
| Ubuntu 24.04 with `gnome-screenshot` installed | Works, but the **screen flashes white** on every capture | GNOME flashes the screen to tell the user a screenshot was taken. We capture on every window switch, so the user would see flashes all day. |
| Ubuntu 26.04 / GNOME 49+ with `gnome-screenshot` | **Refused** | GNOME removed that tool's permission. |
| KDE or Sway / Hyprland | Usually **fails or black** | Pillow 10.1.0 does not know these desktops' tools. |

On top of the picture itself:

- **Wrong monitor or cropped wrong.** On Wayland an app cannot ask where another app's window is, so the Windows trick of "find the focused window, then find its monitor" is not available.
- **Blurry or mis-sized images.** Linux laptops often use 125% or 150% scaling. Coordinates and pixel sizes differ, so crops can land in the wrong place, and OCR reads less text.
- **The app keeps capturing while the screen is locked**, because the Windows lock check (looking for `lockapp.exe`) never matches on Linux.

**Summary:** capture fails on Linux because we use a Windows-style "just read the screen" approach on desktops that no longer allow it. Every "easy" Linux workaround either captures black, captures everything, flashes the screen, or stops working at the next Ubuntu release.

---

## Part 2: The goal

### 2.1 What "properly" means

On every supported Linux desktop, capture must:

1. **Never flash the screen and never play a sound.**
2. **Never hand a black, blank, or partial image to OCR.** Bad frames are detected and dropped.
3. **Ask the user at most once** (at first setup), not on every capture and not after every update or reboot.
4. **Capture only the monitor with the focused window.** Never all monitors. If we cannot tell which monitor, skip.
5. **Skip while locked, asleep, idle, or when nothing is focused.**
6. **Stay fast and light:** under about 300 ms per capture and no noticeable CPU cost between captures.
7. **Keep the image in memory only**, as today. It is used for OCR and discarded. Screenshots are never uploaded (`SCREENSHOT_MONITORING_HARD_DISABLED = True`).
8. **Fail visibly.** If capture cannot work, tracking continues with title and time only, and the reason is logged and shown in the app. It never quietly uploads rubbish.

### 2.2 What does not change

- The AI server, Supabase, and the Forge app.
- The shape of `activity_records` (title, app, redacted OCR text, timings).
- The OCR pipeline (`ocr/`) and privacy filter (`privacy/`). They receive a normal PIL image, as today.
- The Windows capture code. It moves behind the new interface unchanged.

---

## Part 3: Which capture method to use on each desktop

Each method below was chosen because it is **silent** (no flash, no sound) on that desktop. The ones that flash are not used.

| Desktop family | Examples | Method we use | Flash? | Prompt? | Why this one |
|---|---|---|---|---|---|
| **X11 session** | Linux Mint Cinnamon, Xfce, MATE, Ubuntu 22.04 on Xorg | Read the monitor directly (XShm via `mss`), crop with XRandR monitor geometry | No | No | X11 still allows it. Fast (~10–30 ms). |
| **GNOME on Wayland** | Ubuntu 22.04/24.04/26.04, Fedora, RHEL 10, Debian | **Our own GNOME Shell extension** calls GNOME's internal `Shell.Screenshot` API from inside the desktop | No | No (one log-out/log-in at install) | Code running inside GNOME is not subject to the "ask the user" rule. The flash and sound are added only by GNOME's public screenshot service, which we do not call. |
| **KDE Plasma on Wayland** | Kubuntu, Fedora KDE, openSUSE, KDE neon | **KWin's `org.kde.KWin.ScreenShot2`** D-Bus interface, `CaptureActiveScreen` | No | No | KDE allows it for apps whose installed `.desktop` file declares permission. This is how KDE's own Spectacle tool works. `CaptureActiveScreen` returns exactly the monitor with the focused window. |
| **wlroots desktops** | Sway, Hyprland, labwc, river, Wayfire | `grim -o <focused output>` | No | No | These desktops allow capture through the screencopy protocol. |
| **Fallback on any Wayland desktop** | GNOME with extensions blocked by IT policy; COSMIC; others | **XDG portal ScreenCast** (PipeWire stream) with a saved restore token | No | Once (user picks monitors, ticks "remember") | Standard and supported everywhere. The desktop shows a small "screen is being shared" icon while active. That is honest, not a flash. |
| **Nothing works** | Unknown desktop, user refused permission | No capture; title + time only | – | – | Matches today's Windows "Tier 3 skip" behavior. |

**Methods we deliberately do not use:**

| Method | Why not |
|---|---|
| Portal **Screenshot** API | GNOME flashes the screen on every call. On GNOME 42 it asks every time. |
| `gnome-screenshot` | Flash + sound; blocked since GNOME 49. |
| Pillow's automatic Linux fallback | Returns black on Wayland without an error; picks tools that flash. |
| X11 capture on a Wayland session | Always black or partial (only sees XWayland windows). |
| GNOME "unsafe mode" tricks | Opens the screen to every app on the machine. A security hole. |
| Asking users to switch to X11 | Impossible on Ubuntu 26.04, Fedora 43+, RHEL 10, Plasma 6.8+. |
| Reading `/dev/input` or the GPU directly | Needs root or special groups; effectively spyware. |

---

## Part 4: Architecture

### 4.1 One entry point, many backends

The rest of `desktop_app.py` keeps calling `capture_focused_monitor()` exactly as today (from `LocalOCRProcessor.capture_screenshot_only`, `capture_and_ocr`, and `TimeTracker.capture_screenshot`). Behind it:

```
monitor_capture.capture_focused_monitor()
        │
        ▼
CaptureManager  (chooses a backend at startup; re-checks after repeated failures)
        │
        ├── Win32Backend            ← today's code, moved unchanged
        ├── X11Backend              ← mss + XRandR + EWMH
        ├── GnomeExtensionBackend   ← D-Bus to our shell extension
        ├── KWinBackend             ← org.kde.KWin.ScreenShot2
        ├── WlrootsBackend          ← grim
        ├── PortalScreenCastBackend ← PipeWire + restore token
        └── NullBackend             ← returns None, records the reason
        │
        ▼
FrameValidator  (rejects black / blank / wrong-size frames)
        │
        ▼
PIL.Image  → existing OCR → privacy filter → activity record
```

Proposed files (new package, nothing removed):

```
python-desktop-app/capture/
    __init__.py            # exports capture_focused_monitor(), get_capture_status()
    manager.py             # backend selection, fallback, telemetry
    environment.py         # detects session type, desktop, versions
    validator.py           # black / blank frame detection
    result.py              # CaptureResult dataclass
    backends/
        win32.py           # current monitor_capture.py logic
        x11.py
        gnome_extension.py
        kwin.py
        wlroots.py
        portal_screencast.py
        null.py
linux/gnome-extension/timetracker@amzur.com/   # GJS extension source (two builds, §5.3)
linux/kwin/                                     # nothing to build; only .desktop keys
linux/packaging/                                # .desktop files, postinst, etc.
```

`monitor_capture.py` stays as a thin wrapper, so existing imports and `tests/test_monitor_capture.py` keep working.

### 4.2 A result object instead of "image or None"

Today the function returns an image or `None`, so nobody can tell *why* there was no image. Each backend returns:

```
CaptureResult
    image:        PIL.Image | None
    status:       OK | SKIPPED_LOCKED | SKIPPED_NO_FOCUS | SKIPPED_MINIMIZED
                  | SKIPPED_UNKNOWN_MONITOR | DENIED | BLACK_FRAME
                  | BACKEND_UNAVAILABLE | ERROR
    backend:      "gnome_extension" | "kwin" | ...
    monitor:      name + geometry (logical and physical)
    scale:        monitor scale factor (1.0, 1.25, 1.5, 2.0 …)
    elapsed_ms:   capture time
    detail:       short text for logs
```

`capture_focused_monitor()` still returns only `result.image`, so callers do not change. `get_capture_status()` exposes the last result and counters for the admin log, settings page, and diagnostics. The existing `get_capture_stats()` keeps working.

### 4.3 Choosing the backend (environment detection)

`environment.py` gathers facts once at startup:

| Fact | Source |
|---|---|
| Session type | `XDG_SESSION_TYPE` (`x11` / `wayland`), confirmed by `WAYLAND_DISPLAY`; if missing, logind `Session.Type` over D-Bus |
| Desktop | `XDG_CURRENT_DESKTOP` (e.g. `ubuntu:GNOME`, `KDE`, `sway`, `Hyprland`), `DESKTOP_SESSION` |
| GNOME version | `org.gnome.Shell` `ShellVersion` D-Bus property |
| KDE version | `org.kde.KWin` D-Bus / `plasmashell --version` |
| Portal ScreenCast version | `org.freedesktop.portal.ScreenCast` `version` property (need ≥ 4 for restore tokens) |
| Distribution | `/etc/os-release` |

Selection order:

1. Windows → `Win32Backend`.
2. `x11` session → `X11Backend`.
   **Never** choose X11 just because `DISPLAY` is set. Under Wayland, XWayland sets `DISPLAY` too, and that is exactly how black images happen today.
3. Wayland + GNOME → `GnomeExtensionBackend` if the extension answers `GetVersion()` with a compatible protocol → else `PortalScreenCastBackend` → else `NullBackend`.
4. Wayland + KDE → `KWinBackend` if authorized → else `PortalScreenCastBackend` → else `NullBackend`.
5. Wayland + sway / Hyprland / labwc / river / Wayfire → `WlrootsBackend` if `grim` exists → else `PortalScreenCastBackend` → else `NullBackend`.
6. Anything else → `PortalScreenCastBackend` → `NullBackend`.

**Fallback while running.** If the active backend fails 5 times in a row, or produces 5 black frames in a row, the manager moves to the next backend in the list and logs it. It retries the preferred backend every 30 minutes (for example, the user logged out and in, and the extension is now loaded).

**Logging at startup** (extends the existing `log_display_environment()`):

```
[CAPTURE] OS=Ubuntu 26.04 LTS session=wayland desktop=ubuntu:GNOME gnome=50.1
[CAPTURE] portal.ScreenCast v5, extension=timetracker@amzur.com proto=1 state=ENABLED
[CAPTURE] monitors: eDP-1 2880x1800 @1.5 (primary), HDMI-1 1920x1080 @1.0
[CAPTURE] selected backend: gnome_extension (fallbacks: portal_screencast, null)
```

The same summary is added to the existing login diagnostics payload (`send_login_diagnostics`). That is a free-form JSON field today, so there is no server change.

---

## Part 5: Implementing each backend

### 5.1 X11Backend (Mint, Xfce, 22.04 Xorg)

**Libraries:** `mss` (pure Python over XShm/XGetImage), `python-xlib` (EWMH + XRandR). Both are pip-installable and have no system build requirement.

**Steps per capture:**

1. Focused window: read `_NET_ACTIVE_WINDOW` on the root window. If it is 0 → `SKIPPED_NO_FOCUS`.
2. If `_NET_WM_STATE` contains `_NET_WM_STATE_HIDDEN` → `SKIPPED_MINIMIZED`.
3. Window rectangle: `XTranslateCoordinates` to root plus `XGetGeometry`. Include `_NET_FRAME_EXTENTS` so the decorated frame is used.
4. Monitors: XRandR `GetMonitors` (active outputs with x, y, width, height). Re-read each capture; monitors hot-plug.
5. Pick the monitor with the **largest overlap** with the window rectangle. This is the same rule as `_resolve_monitor_for_hwnd` on Windows.
6. `mss.grab(monitor_rect)` → convert BGRA to a PIL RGB image.
7. Validate (§6).

**Black-image risk on X11:** low. It happens mainly when the X11 backend is wrongly used on a Wayland session, which §4.3 prevents.

**Performance:** 10–30 ms at 1080p; 40–80 ms at 4K.

### 5.2 GnomeExtensionBackend (GNOME on Wayland) — the main work item

#### What the extension is

A small GNOME Shell extension (GJS/JavaScript, a few hundred lines), shipped inside our `.deb`. It runs **inside GNOME Shell**, which is the only process allowed to see the whole screen. It offers a private D-Bus service to our app only.

#### Why it has no flash or sound

GNOME's flash (`Flashspot`) and shutter sound are added by GNOME's **public screenshot D-Bus service** (`org.gnome.Shell.Screenshot`) after it takes the picture. The extension does not use that service. It calls the underlying `Shell.Screenshot` object directly (`screenshot_area`), which only renders pixels into a stream. **To verify in the phase 1 spike on GNOME 42, 46, and 50.** If a future version adds a flash inside `Shell.Screenshot` itself, the extension would render the monitor's stage into an offscreen buffer instead (`screenshot_stage_to_content`).

#### D-Bus interface (private, versioned)

Bus name on the session bus: owned by GNOME Shell. Object path `/com/amzur/TimeTracker/Shell`, interface `com.amzur.TimeTracker.Shell1`:

| Member | Type | Purpose |
|---|---|---|
| `GetVersion() → (u protocol, s extension_version, s shell_version)` | method | Compatibility check; the app requires `protocol == 1` |
| `GetFocusedWindow() → a{sv}` | method | `title`, `wm_class`, `app_id`, `pid`, `monitor_index`, `frame_rect`, `minimized`, `fullscreen`, `is_locked`. (Also solves the window-title problem; see the port guide §6.) |
| `CaptureFocusedMonitor(h fd, a{sv} options) → a{sv}` | method | Writes a PNG of the focused window's monitor into the file descriptor we pass; returns `status`, `width`, `height`, `scale`, `monitor_index`, `monitor_rect` |
| `FocusChanged(a{sv} window)` | signal | Sent when focus or title changes, so the app does not need to poll |

**Passing the image through a file descriptor.** The app creates an anonymous in-memory file (`os.memfd_create`) or a pipe, sends the FD with the D-Bus call (D-Bus type `h`), and the extension writes the PNG into it. The image never touches disk. This keeps the "in memory only" promise.

#### What the extension does inside `CaptureFocusedMonitor`

1. If `Main.sessionMode.isLocked` or the screen shield is active → return `status=locked`. Never capture the lock screen.
2. `win = global.display.focus_window`. If `null` (desktop focused, overview open) → `status=no_focus`.
3. If `win.minimized` → `status=minimized`.
4. `m = win.get_monitor()`; `rect = global.display.get_monitor_geometry(m)`; `scale = global.display.get_monitor_scale(m)`.
5. `Shell.Screenshot.screenshot_area(rect.x, rect.y, rect.width, rect.height, stream)` with the cursor excluded. `stream` wraps the passed FD (`Gio.UnixOutputStream`).
6. Return metadata.

#### Security (required, not optional)

A silent screenshot service inside GNOME is powerful. If any program could call it, we would re-open the hole Wayland closed. The extension must:

1. **Authenticate the caller.** On each call, take the D-Bus sender, ask the bus daemon for its PID (`org.freedesktop.DBus.GetConnectionUnixProcessID`), read `/proc/<pid>/exe`, and accept only our installed binary (for example `/opt/timetracker/TimeTracker`). Reject everything else with `AccessDenied`. Note: a malicious program running as the same user could still inject into our process, but it can already do many things as that user. This check stops *casual* reuse of the service by other apps.
2. **Return only the focused monitor.** No arbitrary-rectangle method.
3. **Rate-limit** in the extension (for example one capture per 5 s), independent of the app's own 10 s throttle.
4. **Refuse while locked.**
5. **Stay visible.** The extension appears in GNOME's Extensions app with a clear name and description ("TimeTracker: lets TimeTracker read the active window and capture the active monitor for on-device OCR"). The consent page mentions it.

#### Two builds for GNOME versions

GNOME changed the extension module system in GNOME 45. One source tree produces two packages:

| Build | GNOME versions | Ubuntu | Module style |
|---|---|---|---|
| `legacy` | 42, 43, 44 | 22.04 | `imports.gi.*`, `init()/enable()/disable()` |
| `esm` | 45 → 50 (+ new ones after testing) | 24.04, 26.04, Fedora 39+ | `import … from 'gi://…'`, `export default class extends Extension` |

`metadata.json` lists exact `shell-version` values. The postinst script installs the right build for the detected GNOME version.

#### Installing and enabling

1. `.deb` installs to `/usr/share/gnome-shell/extensions/timetracker@amzur.com/`.
2. On first run, the app enables it for the user:
   - if GNOME Shell is running: `org.gnome.Shell.Extensions.EnableExtension("timetracker@amzur.com")` over D-Bus;
   - also add it to the `org.gnome.shell enabled-extensions` gsettings key, so it survives resets.
3. **On Wayland, GNOME cannot load a newly installed extension until the user logs out and in once.** The app detects state `INITIALIZED`/not found, shows a one-time notification ("Log out and back in to finish TimeTracker setup"), and uses the Portal ScreenCast fallback until then.
4. Detect IT policy blocks: `org.gnome.shell disable-user-extensions = true` or a locked `enabled-extensions` key. In that case, stay on the ScreenCast fallback and say so in settings. Document the policy key for IT admins.

#### Updating the extension

After a `.deb` update, GNOME keeps running the **old** extension code until the next login. So the D-Bus protocol must stay **backward-compatible**: a new app must work with the previous extension version. Only add methods and optional fields; bump `protocol` only for breaking changes, and keep the old protocol supported for at least one release.

#### Timing

`screenshot_area` for one 1080p–1440p monitor: roughly 30–120 ms including PNG encoding (to measure in the spike). PNG encoding is the main cost. If it is too slow on 4K, add an option that returns raw pixels (the app then builds the image with `Image.frombuffer`).

### 5.3 KWinBackend (KDE Plasma on Wayland)

**Permission:** our system-installed `.desktop` file (`/usr/share/applications/com.amzur.timetracker.desktop`) contains:

```
X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2
```

KWin checks the **calling process's executable path** against installed `.desktop` files. The `Exec=` line must therefore point at the real binary (`/opt/timetracker/TimeTracker`), not a shell wrapper script, or the check fails. This is a common trap.

**Steps per capture:**

1. If the session is locked (logind `LockedHint`, or `org.freedesktop.ScreenSaver.GetActive`) → skip.
2. Create a pipe. Call `org.kde.KWin.ScreenShot2.CaptureActiveScreen(options, pipe_write_fd)` with options `include-cursor=false`, `native-resolution=true`.
3. The reply gives `width`, `height`, `stride`, `format`. Read exactly `stride × height` bytes from the pipe **in a separate thread**, with a timeout. If you read after the call returns, a large image can fill the pipe and deadlock.
4. Build the image with `Image.frombuffer` using the reported format (usually ARGB32 premultiplied, converted to RGB).
5. Validate (§6).

"Active screen" in KWin means the monitor with the focused window, which is exactly our rule, so we do not need window geometry for cropping.

**Plasma versions:** ScreenShot2 exists since Plasma 5.22; `CaptureActiveScreen` was added later. Check the interface `version` property at startup; if `CaptureActiveScreen` is missing, use `CaptureScreen(name, …)` with the focused output from a KWin script, or fall back to ScreenCast.

**No flash:** KWin's D-Bus service does not flash. Spectacle draws its own effects in its UI, which we do not use.

### 5.4 WlrootsBackend (Sway, Hyprland, labwc, river, Wayfire)

1. Find the focused output:
   - Sway: `swaymsg -t get_outputs -r` → entry with `focused: true`.
   - Hyprland: `hyprctl monitors -j` → `focused: true`.
   - Others: fall back to ScreenCast (no standard way to find the focused output).
2. `grim -t ppm -o <output> -` (PPM to stdout is fastest; no PNG encode) → `Image.open(BytesIO(stdout))`.
3. Timeout 3 s; non-zero exit → `ERROR` with stderr in the log.
4. Validate (§6).

`grim` is a `.deb` "Recommends" dependency (not installed on GNOME/KDE machines that don't need it). Newer `grim` supports the newer `ext-image-copy-capture` protocol as compositors adopt it; keep `grim` current in the support notes.

### 5.5 PortalScreenCastBackend (universal Wayland fallback)

This is the standard, sandbox-friendly way. It is more complex, but it is the only method that works on every Wayland desktop.

**Dependencies:** a D-Bus library (`dbus-next` or `jeepney`), GStreamer with the PipeWire plugin (`gstreamer1.0-pipewire` on Ubuntu, `gstreamer1-plugin-pipewire` on Fedora), and PyGObject for `Gst`. Declare these as `.deb` dependencies. Do not bundle GStreamer inside PyInstaller; version mismatches with the system PipeWire cause black frames.

**First-time setup (one prompt):**

1. `CreateSession()`.
2. `SelectSources()` with:
   - `types = MONITOR` (1) — whole monitors, not windows;
   - `multiple = true` — the user selects all the monitors they work on;
   - `cursor_mode = HIDDEN` (1);
   - `persist_mode = 2` — "remember until revoked";
   - `restore_token` = the saved token, if any.
3. `Start()`. The desktop shows its dialog **only if there is no valid token**. The user selects monitors and ticks "Remember" (wording differs per desktop).
4. The response contains `streams` (one per monitor, each with a PipeWire `node_id`, `position`, and `size`) and a **new `restore_token`**.
5. **Save the new token every time.** Tokens are single-use: each successful `Start` returns a fresh token, and the old one stops working. Store it in the keyring through the existing `SecureTokenStorage` (add it to the sensitive key list).
6. `OpenPipeWireRemote()` → a file descriptor for PipeWire.

**Getting frames without a flash and without black images:**

- Build one GStreamer pipeline per selected monitor:
  `pipewiresrc fd=<fd> path=<node_id> always-copy=true do-timestamp=true ! videoconvert ! video/x-raw,format=RGB ! appsink max-buffers=1 drop=true sync=false`
- **`always-copy=true`** forces a copy into normal memory. Without it, some GPUs (notably NVIDIA and some Mesa setups) hand over GPU-only DMA-BUF frames that arrive empty, which is the classic "black screencast" bug.
- **Keep the pipeline running while tracking is active.** PipeWire only sends a new frame when the screen changes, so an idle screen costs almost nothing. The appsink always holds the latest frame.
- **Do not take the first frame after start.** The first buffers after `Start` can be empty or black. Wait until a frame arrives that passes the validator (§6), up to 2 s.
- **Capture = copy the latest frame from the focused monitor's appsink.** No new portal call, so no prompt, no flash, and no per-capture indicator blinking.
- **Stop the stream when idle, locked, paused, or asleep** (hooks into the existing `enter_idle` / `resume_from_idle` / pause code). The "screen sharing" indicator is then shown only while the user is actually being tracked. Resume with the saved token, which requires no prompt.

**Choosing the focused monitor:** match the focused window's monitor (from the window-info source) to the stream whose `position`/`size` match that monitor. If the user did not select that monitor in the dialog → `SKIPPED_UNKNOWN_MONITOR` (never substitute another monitor).

**When the token stops working** (monitors changed, permission revoked in Settings, portal upgraded): `Start` shows the dialog again. The app must not trigger this on its own in the middle of work. It sets status `DENIED`, continues with title + time only, and shows one notification: "Screen access needs to be re-allowed" with a button that starts the flow. Not more than once per day.

**Desktop-specific notes:**

| Desktop | Behavior |
|---|---|
| GNOME 46+ | "Remember" supported; orange/red sharing indicator in the top bar while streaming |
| GNOME 42 (Ubuntu 22.04) | Restore support is **uncertain** — verify in the spike. If it prompts on every start, use the X11 session or the extension on 22.04 |
| KDE Plasma 6 | Supported; the tray shows a sharing indicator |
| wlroots (`xdg-desktop-portal-wlr`) | Output chooser is a config setting, not a dialog; configure `chooser_type=none` + `output_name` if needed |
| Hyprland (`xdg-desktop-portal-hyprland`) | Supported; restore tokens work |

### 5.6 NullBackend

Returns `CaptureResult(image=None, status=BACKEND_UNAVAILABLE, detail=<why>)`. The tracking loop already continues without OCR when the image is `None`. The settings page and the tray tooltip show "Screen text capture unavailable on this desktop" instead of failing silently.

---

## Part 6: Stopping black, blank, and wrong images (`FrameValidator`)

Every image from every Linux backend passes through the validator before OCR.

### 6.1 Checks

| Check | How | Threshold (initial; tune in testing) |
|---|---|---|
| Size sanity | Width/height match the expected monitor size (physical or logical) within 2 px | Otherwise `ERROR` ("size mismatch") |
| All-black | Downscale to 64×36, compute max channel value | max < 16 → `BLACK_FRAME` |
| Flat / blank | Standard deviation of the 64×36 grayscale | stddev < 3 → `BLACK_FRAME` (catches solid gray/white failed frames too) |
| Mostly black | Fraction of pixels with luminance < 8 | > 97% → `BLACK_FRAME` |
| Transparent | If RGBA, fraction of alpha = 0 | > 50% → `BLACK_FRAME` |
| Stale (ScreenCast only) | Frame timestamp vs "screen changed" is fine; just record frame age | Informational only |

Cost: under 2 ms (on the small thumbnail).

**Legitimately dark screens.** A dark-theme IDE is dark but not flat; the standard-deviation check lets it through. A black full-screen video or DRM-protected content (Netflix in a browser) is legitimately black. That just yields an empty OCR, which is correct. The validator marks it `BLACK_FRAME`, and the record is saved with no OCR text, same as today when OCR finds nothing.

### 6.2 What happens with a bad frame

1. The image is discarded (never sent to OCR).
2. The counter for that backend increases.
3. One retry after 300 ms for ScreenCast (the next frame is often fine).
4. After 5 bad frames in a row → the manager switches to the next backend (§4.3) and logs why.
5. The record for that window is still saved with title and time, and `ocr_text` empty.

### 6.3 Known causes of black images, and the fix for each

| Cause | Fix in this plan |
|---|---|
| X11 capture used on a Wayland session (XWayland) | Session detection from `XDG_SESSION_TYPE`, never `DISPLAY` (§4.3) |
| Pillow fallback returning black without an error | Pillow's Linux auto-fallback is not used at all |
| PipeWire DMA-BUF frames empty (NVIDIA, some Mesa) | `always-copy=true`; system GStreamer, not bundled |
| First frames of a new stream empty | Wait for the first valid frame (§5.5) |
| Screen locked, blanked, or display off | Skip on lock (logind `LockedHint`, extension `isLocked`) and on idle |
| Wrong crop because of scaling (crop outside the image) | Crops done by the compositor (extension, KWin, grim) in its own coordinates; X11 crops in X11 pixels (§7) |
| Capturing during a monitor hot-plug | Re-read monitors each capture; one retry |
| VM without GPU acceleration | Not a production case; documented for testers |
| Protected / DRM content | Legitimate; empty OCR |

---

## Part 7: Scaling, multiple monitors, and OCR quality

- **Let the compositor crop.** The extension, KWin, and grim all capture one named monitor. We never compute pixel rectangles across mixed-scale monitors ourselves on Wayland. This removes the most common wrong-crop bug.
- **Report the scale.** Each result includes the monitor scale (1.0, 1.25, 1.5, 2.0). On a 150% monitor, text is 1.5× larger in pixels than on Windows at 100%.
- **Normalize before OCR.** `ocr/image_processor.py` already limits the maximum dimension. Add: if `scale > 1`, downscale by `1/scale` to a "100%-equivalent" size before the max-dimension step. RapidOCR is tuned for normal text sizes, and 4K images at 200% are slow to OCR with no accuracy gain. Measure on the test page at each scale before choosing the final rule.
- **Physical resolution.** Request native/physical resolution (`native-resolution=true` on KWin; the extension captures at the framebuffer scale — verify). Blurry, logical-resolution captures reduce OCR accuracy.
- **Hide the cursor** on all backends (cursor over text breaks OCR words).
- **Our own popups.** The pause popup and DQ nudge popup can be on screen during a capture. That is the same as on Windows today; no change.

---

## Part 8: Permission and first-run experience

### 8.1 What each user sees, once

| Desktop | First run | After reboots and app updates |
|---|---|---|
| X11 | Nothing | Nothing |
| GNOME (extension) | Notification: "Log out and back in once to finish setup." Until then, the portal dialog is used once (see below). | Nothing (an extension *update* is picked up at the next login, silently) |
| GNOME (policy blocks extensions) | Portal dialog: select monitors, tick "Remember" | Nothing, unless monitors change or permission is revoked |
| KDE | Nothing (permission comes from the `.desktop` file) | Nothing |
| Sway / Hyprland | Nothing | Nothing |

### 8.2 Consent page wording (Linux only)

The consent page (`render_consent_page`) gets a Linux paragraph explaining in plain words:

- TimeTracker reads the text on the monitor you are using to match your work to Jira issues.
- The picture is processed on your computer and never uploaded.
- On some Linux desktops you will be asked once to allow screen access. Select the monitors you work on and choose "Remember".
- You may see a "screen sharing" icon while tracking is active. It disappears when tracking is paused or you are idle.

### 8.3 Stable identity, so permission sticks

Permissions on Linux are remembered **per application id**, which comes from the installed `.desktop` file. So:

- Install to a **fixed path** (`/opt/timetracker/`) via `.deb`.
- Install `com.amzur.timetracker.desktop` system-wide, with `Exec=/opt/timetracker/TimeTracker` (real binary, no wrapper) and `StartupWMClass` set.
- The app registers its id with the portal's host registry (`org.freedesktop.host.portal.Registry.Register("com.amzur.timetracker")`, available in newer portal versions). This makes the portal attribute calls to our `.desktop` file even for a non-sandboxed app.
- An AppImage in `~/Downloads` does **not** give a stable id. Permission may be asked again after every update. This is one more reason `.deb` is the primary package.

---

## Part 9: Changes to existing code (described only; no code written yet)

| Where | Change |
|---|---|
| `monitor_capture.py` | Becomes a thin wrapper over `capture/`. The Win32 logic moves to `capture/backends/win32.py` unchanged. **Remove the bare `ImageGrab.grab()` non-Windows passthrough** (it captures all monitors). |
| `LocalOCRProcessor.capture_screenshot_only`, `capture_and_ocr`; `TimeTracker.capture_screenshot` | No signature change. They get `None` for skips, as today. Log `get_capture_status().status` when `None`. |
| `TimeTracker._is_screen_locked` | On Linux: logind `LockedHint` (or the extension's `is_locked`). Used before capture and after resume. |
| `enter_idle`, `resume_from_idle`, `pause_tracking`, `resume_tracking` | Call `CaptureManager.suspend()` / `.resume()` so the ScreenCast stream stops when not tracking. |
| `log_display_environment` | Linux environment summary (§4.3). |
| `send_login_diagnostics` payload | Add capture backend, status counters, session/desktop/version. Free-form JSON; no server change. |
| Settings page and tray tooltip | Show "Screen text capture: active (GNOME extension)" or the reason it is unavailable, with a "Fix" action where one exists (re-allow ScreenCast, log out to load extension). |
| `auth/secure_storage.py` `SENSITIVE_TOKEN_KEYS` and `desktop_app.py` copy | Add `screencast_restore_token` (both lists must stay in sync; `tests/test_secure_storage_key_sync.py` enforces it). |
| `ocr/image_processor.py` | Optional scale normalization (§7). |
| `requirements.txt` | Linux-only: `mss`, `python-xlib`, `dbus-next` (or `jeepney`), `PyGObject` (for GStreamer; may come from the system package instead). Upgrading Pillow is **not** required, because we no longer use Pillow's Linux grab. |
| Packaging (new) | `.deb`: `/opt/timetracker`, `.desktop` file with the KWin key, GNOME extension (two builds), postinst to pick the build; Depends/Recommends: `gstreamer1.0-pipewire`, `gir1.2-gst-plugins-base-1.0`, `xdg-desktop-portal`, `grim` (Recommends). |

---

## Part 10: Acceptance criteria

Each criterion maps to a test (automated where marked [auto], otherwise on the manual matrix in Part 11).

1. [auto] On a Wayland session, the X11 backend is never selected, even when `DISPLAY` is set.
2. [auto] On non-Windows platforms, no code path calls `ImageGrab.grab()` without an explicit single-monitor target.
3. [auto] The validator rejects all-black, flat-gray, flat-white, and >50%-transparent images, and accepts a dark-theme IDE screenshot fixture.
4. [auto] After 5 consecutive failures or black frames, the manager switches to the next backend and logs the reason.
5. [auto] When the focused monitor cannot be determined, the result is `SKIPPED_UNKNOWN_MONITOR` and no image is returned.
6. [auto] The GNOME extension rejects `CaptureFocusedMonitor` from a process whose executable is not the installed TimeTracker binary.
7. [auto] The extension returns `locked` while the session is locked (headless GNOME test).
8. On Ubuntu 24.04 and 26.04 GNOME Wayland with the extension: 200 captures over a working hour produce **zero flashes, zero sounds, zero prompts**, and ≥ 99% valid frames of the focused monitor only.
9. On Ubuntu 24.04 GNOME with extensions disabled by policy: one prompt at first run; none after reboot or app update; the sharing indicator is visible only while tracking; ≥ 99% valid frames.
10. On Kubuntu (Plasma 6, Wayland): no prompt, no flash, ≥ 99% valid frames of the active monitor.
11. On Linux Mint 22 (X11) and Ubuntu 22.04 Xorg: no prompt, no flash, focused monitor only with two monitors attached.
12. On Sway: no prompt, no flash, focused output only.
13. Two monitors at different scales (e.g. 150% laptop + 100% external): the focused monitor is captured, not cropped wrongly, on every Tier 1 desktop.
14. While locked or suspended, no capture is attempted, and after unlock capture resumes without a prompt.
15. Median capture time ≤ 300 ms on a 1440p monitor on each backend; no measurable CPU use between captures with the ScreenCast stream on a static screen (< 1% average).
16. OCR text length and confidence on the standard test page at 100/125/150/200% scale are within 10% of the Windows 100% baseline.
17. When no backend works, records still upload with title and times and empty OCR, and the settings page shows the reason.
18. No captured image is written to disk (verified with `inotifywait` on `$HOME`, `/tmp`, and `$XDG_RUNTIME_DIR` during a capture session).

---

## Part 11: Implementation plan and timeline

Estimates are for one developer; rough ranges for planning.

### Phase 0: Spike — prove each method on real machines (1 week)

Before writing production code, confirm the four "verify" items with throwaway scripts on real hardware:

- GNOME 42, 46, 50: extension `screenshot_area` produces **no flash and no sound**; measure time at 1080p, 1440p, 4K; confirm capture resolution vs. monitor scale.
- GNOME 42: does ScreenCast `persist_mode=2` restore without a dialog?
- Plasma 6: `CaptureActiveScreen` availability and the `.desktop` authorization with a PyInstaller binary in `/opt`.
- NVIDIA + GNOME 46: ScreenCast with `always-copy=true` gives valid frames.

Output: a short results table added to this document. Decisions in later phases depend on it.

### Phase 1: Framework + X11 (1.5 weeks)

- `capture/` package, `CaptureResult`, `environment.py`, `manager.py`, `validator.py`, `NullBackend`.
- Move Win32 code into `win32.py` without behavior change; full Windows test suite green.
- `X11Backend`.
- Remove the all-monitor passthrough.
- Tests: criteria 1–5, 11, 17.

### Phase 2: GNOME extension (2.5–3 weeks)

- Extension (ESM build first, then legacy 42 build), D-Bus interface, FD passing, caller authentication, lock/focus checks, rate limit, `FocusChanged` signal.
- `GnomeExtensionBackend`, enable/detect/log-out flow, IT-policy detection.
- Headless GNOME CI test (`gnome-shell --headless` / `mutter --headless --virtual-monitor`).
- Tests: criteria 6–8, 13, 14.

### Phase 3: Portal ScreenCast fallback (2 weeks)

- Session handling, restore-token storage, GStreamer appsink pipeline, first-valid-frame wait, suspend/resume on idle and pause, re-allow flow.
- Tests: criterion 9, parts of 13–15.

### Phase 4: KDE + wlroots (1.5 weeks)

- `KWinBackend` (pipe reader thread, format conversion), `.desktop` key.
- `WlrootsBackend` (sway + Hyprland).
- Tests: criteria 10, 12.

### Phase 5: Packaging, UX, and scale tuning (1.5 weeks)

- `.deb` pieces for capture: extension install, `.desktop`, dependencies, postinst build selection.
- Consent text, settings status, tray tooltip, notifications.
- OCR scale normalization and measurement.
- Tests: criteria 15, 16, 18.

### Phase 6: Full matrix run (1 week)

Manual run of every acceptance criterion on:

| Machine | Desktop | Session |
|---|---|---|
| Ubuntu 26.04 laptop, Intel | GNOME 50 | Wayland |
| Ubuntu 24.04 laptop, NVIDIA | GNOME 46 | Wayland |
| Ubuntu 22.04 | GNOME 42 | Xorg and Wayland |
| Kubuntu 24.04/26.04 | Plasma 6 | Wayland |
| Linux Mint 22 | Cinnamon | X11 |
| Fedora 43 | GNOME 49 (no AppIndicator, stricter defaults) | Wayland |
| Any distro | Sway | Wayland |

Each Tier 1 machine gets two monitors with different scales for at least one run.

**Total: about 10–11 weeks** for all backends, or about **6 weeks** for a first release with X11 + GNOME extension + ScreenCast fallback (phases 0, 1, 2, 3, and the GNOME rows of 5–6).

### Ongoing maintenance

- **Every GNOME release (March, September):** add the new version to `shell-version` after running the headless test against it. Fedora gets new GNOME about six months before Ubuntu LTS does, which gives early warning.
- **Every Ubuntu interim and LTS release:** rerun Part 10 on the new release.
- **Watch:** GNOME extension porting guides, xdg-desktop-portal releases, KWin ScreenShot2 changes, wlroots `ext-image-copy-capture` adoption.

---

## Part 12: Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A future GNOME adds a flash or permission check inside `Shell.Screenshot` | Low | High on GNOME | Offscreen stage render alternative; ScreenCast fallback already built; early testing on Fedora |
| IT departments block user extensions | Medium | Medium | ScreenCast fallback; admin documentation for allowing the extension |
| ScreenCast restore tokens unreliable on some version | Medium | Medium (extra prompts) | Rate-limited re-allow flow; extension preferred on GNOME |
| Users uncomfortable with the sharing indicator | Medium | Low | Stream off when idle/paused; consent text explains it |
| NVIDIA black frames despite `always-copy` | Low–medium | Medium | Validator + backend fallback; documented driver minimum |
| Extension security misunderstood by customers | Low | Medium | Caller authentication, focused-monitor only, source available on request, privacy policy entry |
| KWin authorization fails for the packaged binary | Medium | Medium on KDE | `Exec=` real binary; ScreenCast fallback |

---

## Out of scope

- Window title / app detection beyond what the GNOME extension already returns (covered in `docs/LINUX_DESKTOP_APP_PORT_GUIDE.md` §6).
- Idle detection, tray, notifications, auto-update (port guide).
- Uploading screenshots (remains hard-disabled).
- Flatpak, Snap, and ARM64 builds.
- Desktops without Wayland portal support and without X11.
- Any change to the AI server, Supabase, or Forge app.

---

## Sources

- Wayland/X11 changes: [GNOME 50 removes X11 session (gHacks)](https://www.ghacks.net/2026/03/20/gnome-50-releases-with-x11-session-support-removed-and-wayland/), [What breaks in Ubuntu 26.04 (Aliteq)](https://aliteq.com/gnome-50-removes-x11-ubuntu-26-04-wayland), [KDE: Going all-in on a Wayland future](https://blogs.kde.org/2025/11/26/going-all-in-on-a-wayland-future/), [RHEL 10 removed features](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/10.0_release_notes/removed-features)
- `gnome-screenshot` blocked in GNOME 49: [Arch Linux forums](https://bbs.archlinux.org/viewtopic.php?id=308445)
- Pillow on Linux: [ImageGrab docs](https://pillow.readthedocs.io/en/stable/reference/ImageGrab.html), [Issue #6312](https://github.com/python-pillow/Pillow/issues/6312), [Issue #6392](https://github.com/python-pillow/Pillow/issues/6392)
- GNOME Shell API: [Shell.Screenshot reference](https://gnome.pages.gitlab.gnome.org/gnome-shell/shell/class.Screenshot.html), [Porting extensions to GNOME 45](https://gjs.guide/extensions/upgrading/gnome-shell-45.html), [window-calls extension](https://github.com/ickyicky/window-calls)
- Portal: [Screenshot portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Screenshot.html), [ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.impl.portal.ScreenCast.html), [Screencast restore PR #638](https://github.com/flatpak/xdg-desktop-portal/pull/638), [GNOME stream restoration MR !14](https://gitlab.gnome.org/GNOME/xdg-desktop-portal-gnome/-/merge_requests/14), [Persist mode monitor selection issue #1371](https://github.com/flatpak/xdg-desktop-portal/issues/1371), [Screenshot permission PR #851](https://github.com/flatpak/xdg-desktop-portal/pull/851), [gnome-shell #4895](https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4895)
- KWin ScreenShot2: [CaptureActiveScreen MR !1594](https://invent.kde.org/plasma/kwin/-/merge_requests/1594), [ScreenShot2 version 2 MR !759](https://invent.kde.org/plasma/kwin/-/merge_requests/759), [kwin-mcp feasibility notes](https://github.com/isac322/kwin-mcp/pull/21)
- PipeWire black frames: [doubletake PR #48](https://github.com/omarroth/doubletake/pull/48), [fluxcast #147 (always-copy)](https://github.com/IlyaP358/fluxcast/issues/147), [COSMIC portal black frames #367](https://github.com/pop-os/xdg-desktop-portal-cosmic/issues/367)
- Industry precedent: [Hubstaff Wayland screenshot support](https://support.hubstaff.com/screenshot-capture-support-wayland-linux/)

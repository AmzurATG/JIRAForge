# Linux Desktop App: Challenges, Solutions, and the Screenshot Problem

**Date:** 2026-09-29
**Component:** `python-desktop-app/`
**Status:** Analysis and plan. No code has been changed.
**Supersedes:** `plan/LINUX_DESKTOP_APP_CHALLENGES.md` (kept for history; corrections in §19)

---

## 1. Summary

The AI server does not change. It never touches the user's screen. It receives `activity_records` rows (window title, app name, redacted OCR text, timestamps, classification) and analyzes them. A Linux build only has to produce those same rows.

Almost everything between "we have an image" and "the row is in Supabase" already runs on Linux: RapidOCR, the Presidio privacy filter, SQLite, Supabase, Flask, the OAuth callback. What does not run is everything that asks the operating system about the user's desktop:

1. **Taking a screenshot** of the monitor the user is working on. This is the hardest problem (§5).
2. **Knowing which window is focused**, and its title and application. On Wayland there is no standard way to ask. This is the second hardest problem, and it matters even more than the screenshot, because the whole session model is driven by window switches (§6).
3. **Knowing whether the user is idle, the screen is locked, or the machine is going to sleep** (§7).
4. The desktop plumbing: tray icon, notifications, popups, autostart, install, update, secure credential storage, and packaging (§8–§14).

Linux desktops break the first three about every two years. Ubuntu 22.04 still let a user pick an X11 session. Ubuntu 24.04 made Wayland the norm and removed `gnome-screenshot` from the default install. Ubuntu 26.04 (GNOME 50) removed the X11 session completely. KDE Plasma 6.8 (October 2026) goes Wayland-only as well. The old shortcut of reading the X11 framebuffer has now gone on every major desktop.

The answer is not one Linux screenshot API, because there isn't one. The answer is a **small set of capture and window-info backends behind the existing `capture_focused_monitor()` / `get_active_window()` functions**, one per desktop family, chosen at startup. It also needs a **retest cycle tied to each Ubuntu LTS**.

---

## 2. What must stay the same (the contract with the server)

The Linux app must write the same data the Windows app writes. The server side (ai-server, Supabase edge functions, Forge app) needs no change.

| Field sent in `activity_records` | Windows source today | Linux must provide |
|---|---|---|
| `window_title` | `win32gui.GetWindowText` | Focused-window title (§6) |
| `application_name` | `psutil.Process(pid).name()` e.g. `chrome.exe` | Process or app id, normalized (§12) |
| `ocr_text` | Screenshot → RapidOCR → privacy filter | Same pipeline; only the capture changes (§5) |
| `start_time`, `end_time`, durations | Window-switch events + idle detection | Same logic; needs idle/lock events (§7) |
| `classification`, `project_key` | Local classification cache | Unchanged |
| Idle records (`[Idle: reason]`) | `GetLastInputInfo`, WTS lock, power broadcast | logind / compositor idle (§7) |

**Important fact that shapes the whole design:** screenshots are **not uploaded**. `SCREENSHOT_MONITORING_HARD_DISABLED = True` ([desktop_app.py:398](../python-desktop-app/desktop_app.py#L398)). The image is captured in memory, OCR runs locally, and the image is discarded ([desktop_app.py:5980-6020](../python-desktop-app/desktop_app.py#L5980-L6020)). So on Linux:

- The screenshot never leaves the machine. We need it only for local OCR. The privacy story for users and admins stays the same.
- A capture happens on **every window switch** (throttled to one every 10 s) plus interval captures ([desktop_app.py:11022](../python-desktop-app/desktop_app.py#L11022), [desktop_app.py:12722](../python-desktop-app/desktop_app.py#L12722)). That is dozens to hundreds of captures a day. Any capture method that flashes the screen, plays a sound, or shows a dialog per capture is not acceptable. This rules out several "easy" Linux methods (§5.6).
- If capture fails, the record is still useful. It has a title, app, and timings, and `ocr_text` is simply empty. The Windows code already has this "Tier 3: skip" behavior. **A missing window title is much worse than a missing screenshot.**

---

## 3. How the Windows app works today

| Concern | Windows mechanism | Location |
|---|---|---|
| Screenshot of focused monitor | `GetForegroundWindow` → `MonitorFromWindow` → `ImageGrab.grab(bbox, all_screens=True)`; DPI awareness; skip minimized/cloaked | [monitor_capture.py](../python-desktop-app/monitor_capture.py) |
| Focused window title + app | `win32gui.GetForegroundWindow`, `GetWindowText`, `GetWindowThreadProcessId` + `psutil` | [desktop_app.py:11357](../python-desktop-app/desktop_app.py#L11357) |
| Idle time | `GetLastInputInfo` via `ctypes.windll`, fallback `pynput` hooks | [desktop_app.py:12155-12280](../python-desktop-app/desktop_app.py#L12155-L12280) |
| Lock / sleep / shutdown | Hidden message window: `WM_WTSSESSION_CHANGE`, `WM_POWERBROADCAST`, `WM_ENDSESSION` | [desktop_app.py:12281](../python-desktop-app/desktop_app.py#L12281) |
| Screen locked check | Foreground process is `lockapp.exe` / `logonui.exe` | [desktop_app.py:5026](../python-desktop-app/desktop_app.py#L5026), [11344](../python-desktop-app/desktop_app.py#L11344) |
| OCR | RapidOCR (ONNX) primary, WinRT OCR fallback | [ocr/](../python-desktop-app/ocr/) |
| OCR worker priority | `SetThreadPriority(THREAD_MODE_BACKGROUND_BEGIN)` | [desktop_app.py:6019](../python-desktop-app/desktop_app.py#L6019) |
| Tray icon | `pystray` (Win32 backend) | [desktop_app.py:13940](../python-desktop-app/desktop_app.py#L13940) |
| Notifications | `winotify` toast | many call sites, e.g. [desktop_app.py:6823](../python-desktop-app/desktop_app.py#L6823) |
| Popups | Tk / CustomTkinter, `-topmost`, positioned on focused monitor | `PausePopupWindow`, [dq_nudge/popup.py](../python-desktop-app/dq_nudge/popup.py) |
| Single instance | Named mutex `CreateMutex` | [desktop_app.py:283](../python-desktop-app/desktop_app.py#L283) |
| Autostart | `HKCU\...\Run` registry key | [desktop_app.py:1834](../python-desktop-app/desktop_app.py#L1834) |
| Install / uninstall | Self-copy to `%LOCALAPPDATA%`, Inno Setup (`installer/TimeTracker.iss`), generated `.bat` uninstaller | [desktop_app.py:1102](../python-desktop-app/desktop_app.py#L1102), [1728](../python-desktop-app/desktop_app.py#L1728) |
| Auto-update | SYSTEM scheduled task + `update_service.ps1`; legacy `cmd.exe` batch swap | [desktop_app.py:1350](../python-desktop-app/desktop_app.py#L1350), [1631](../python-desktop-app/desktop_app.py#L1631) |
| Credentials | `keyring` → Windows Credential Manager, encrypted-file fallback | [auth/secure_storage.py](../python-desktop-app/auth/secure_storage.py) |
| Local DB | SQLCipher (`sqlcipher3-wheels`, **Windows-only marker**) | [db_connection.py](../python-desktop-app/db_connection.py), [requirements.txt](../python-desktop-app/requirements.txt) |
| Location | `netsh wlan`, `winsdk` Geolocator, ipinfo.io | [desktop_app.py:5122](../python-desktop-app/desktop_app.py#L5122) |
| App metadata | `win32api.GetFileVersionInfo` on the `.exe` | [desktop_app.py:8489](../python-desktop-app/desktop_app.py#L8489) |
| Build | PyInstaller one-file `.exe` (`desktop_app.spec`, `build.bat`) | spec bundles `pywin32`, `winsdk`, VC runtime DLLs |

When `win32gui` fails to import, the current code does not fail loudly. It degrades quietly:

- `get_active_window()` returns `{'title': 'Unknown', 'app': 'Unknown'}` forever. No window switches are ever detected.
- `capture_focused_monitor()` calls a bare `ImageGrab.grab()`. That captures **all monitors** if it works at all (§5.4).
- `get_system_idle_seconds()` hits `ctypes.windll` → exception → `None`, so it falls back to `pynput`.
- `monitor_system_events()` fails on `ctypes.windll`, so there is no lock or sleep detection.
- Notifications are silently disabled (`WINOTIFY_AVAILABLE = False`).

A naive "just run it on Linux" build would therefore **start, log in, and upload plausible-looking but useless data**: one "Unknown" session all day, with wrong idle time. That is worse than crashing. The port must make these failures visible.

---

## 4. The Linux landscape, and why "every two years" matters

### 4.1 Display server timeline (verified September 2026)

| Release | Date | Desktop | X11 session? | What it means for us |
|---|---|---|---|---|
| Ubuntu 22.04 LTS | Apr 2022 | GNOME 42 | Yes ("Ubuntu on Xorg" at login). Wayland default except on NVIDIA. | Many users are still effectively on X11. `gnome-screenshot` installed. The portal screenshot permission store does not exist yet. |
| Ubuntu 24.04 LTS | Apr 2024 | GNOME 46 | Yes, but Wayland is default for almost everyone, including NVIDIA. | X11 capture only works if the user switches session. `gnome-screenshot` is not in the default install. |
| Ubuntu 25.10 | Oct 2025 | GNOME 49 | **No** | GNOME 49 removed X11 session code and **revoked `gnome-screenshot`'s access** to the private Shell screenshot API ("Screenshot is not allowed"). |
| Fedora 43 | Oct 2025 | GNOME 49 | **No** | GNOME X11 packages removed. |
| RHEL 10 | 2025 | GNOME 47 | **No** (Xorg server removed; XWayland only) | Enterprise desktops are Wayland-only. |
| Ubuntu 26.04 LTS | Apr 2026 | GNOME 50 | **No** | First Ubuntu LTS with no X11 session. Only XWayland for legacy apps. |
| KDE Plasma 6.8 | Oct 2026 | Plasma | **No** | KDE's X11 session ends. Plasma 6.7 keeps X11 until early 2027. |
| Linux Mint 22.x | 2024–2026 | Cinnamon | Yes (Wayland experimental) | Still an X11 desktop in practice. |
| Ubuntu 28.04 LTS | Apr 2028 | GNOME ~54 | No | Next forced retest. Portal and extension APIs will have moved again. |

Why this breaks screen-capture code every cycle:

- **GNOME releases every six months** and treats Shell internals as private. Extensions and any "private API" trick can break at each release. For example, GNOME 45 switched extensions to ES modules and every extension had to be rewritten. GNOME 49 removed `gnome-screenshot`'s access.
- **Ubuntu LTS freezes one GNOME version for two years.** We can target a fixed GNOME per LTS. Each new LTS jumps two to four GNOME versions at once, so several breaking changes land at once.
- **The escape hatch keeps shrinking.** On 22.04 you could say "log in with Xorg". On 24.04 that was still possible but unusual. On 26.04 it is impossible for GNOME users.

### 4.2 What "all Linux systems" can realistically mean

There are hundreds of distributions, but they reduce to a small number of **desktop families**. Capture and window info depend on the desktop, not on the distribution:

| Family | Examples | Protocol | Market relevance for us |
|---|---|---|---|
| GNOME (Mutter) | Ubuntu, Fedora Workstation, RHEL, Debian default, Pop!_OS < 24.04 | Wayland only (from GNOME 49) | **Most users.** Must be first-class. |
| KDE Plasma (KWin) | Kubuntu, Fedora KDE, openSUSE, KDE neon, SteamOS | Wayland (X11 until Plasma 6.7) | Second priority. |
| X11 desktops | Linux Mint Cinnamon, Xfce, MATE, older installs, anything where the user chose Xorg | X11 | Easy and silent. Must support. |
| wlroots and other compositors | Sway, Hyprland, labwc, river, Wayfire, niri, COSMIC | Wayland | Small, technical user base. Best effort. |

"Works on all Linux systems" should be defined as **works on these four families, with a named, tested support matrix** (§16). Anything else falls back to metadata-only tracking with a clear log line.

---

## 5. Screenshot capture: the major challenge

### 5.1 Why Windows is easy

On Windows, any process in the user's session can read the screen with GDI (`BitBlt`), which is what `ImageGrab` does. There is no prompt, no indicator, and no flash. The OS has no concept of "this app is not allowed to see other apps' pixels". The existing code only has to pick the right rectangle.

### 5.2 Why Linux is hard: Wayland's security model

**X11** (the old Linux display system) worked like Windows. Any client could read the root window and see everything. Screen capture was trivial and silent.

**Wayland** was designed specifically so that **one application cannot see another application's pixels, cannot read global keyboard or mouse input, and cannot ask which window is focused**. These are the three things a time tracker needs. On Wayland, the compositor (GNOME Shell, KWin, Sway…) is the only process that can see the whole screen. Every other app must ask it, and the compositor decides whether and how to allow it.

Each compositor exposes capture differently:

| Mechanism | Who implements it | User experience |
|---|---|---|
| **XDG Desktop Portal – Screenshot** (`org.freedesktop.portal.Screenshot`) | All major desktops via `xdg-desktop-portal-{gnome,kde,wlr,hyprland}` | First use: a dialog. Later: depends on portal version and permission store. On GNOME: a **screen flash on every capture**. |
| **XDG Desktop Portal – ScreenCast** (PipeWire video stream) | All major desktops | A "share your screen" dialog. With `persist_mode=2` + `restore_token` (ScreenCast v4), later sessions restore without a dialog. A **"screen is being shared" indicator** shows in the top bar while the stream is open. |
| **GNOME Shell private D-Bus** (`org.gnome.Shell.Screenshot`) | GNOME only | Since GNOME 41 it only allows callers on an allow-list (GNOME's own tools). GNOME 49 removed `gnome-screenshot` from that list. **Not usable.** |
| **GNOME Shell extension** | GNOME only, runs *inside* the compositor | Full access, no prompt, no flash unless drawn. Must be installed and enabled; breaks across GNOME versions. |
| **KWin ScreenShot2 D-Bus** (`org.kde.KWin.ScreenShot2`) | KDE only | Restricted to apps whose installed `.desktop` file declares `X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2`. This is how Spectacle gets access. Silent. |
| **wlr-screencopy / ext-image-copy-capture** (used by `grim`) | wlroots compositors, Hyprland, some others | Silent. Not available on GNOME or KDE. |
| **X11 `XGetImage` / XShm** (used by `mss`, Pillow's X11 path) | X11 sessions | Silent and fast. On a Wayland session it only sees **XWayland** windows; native Wayland windows come out **black or missing**. |

### 5.3 What changes across Ubuntu LTS releases (capture only)

| Capability | 22.04 (GNOME 42) | 24.04 (GNOME 46) | 26.04 (GNOME 50) |
|---|---|---|---|
| X11 session available | Yes | Yes (rarely used) | **No** |
| X11 root-window capture | Works on Xorg; black/partial on Wayland | Same | Only XWayland windows |
| `gnome-screenshot` CLI | Installed; works | Not installed by default; works if installed | Blocked ("Screenshot is not allowed") |
| Portal Screenshot, non-interactive | Portal shows a dialog / is denied; no permission store | Permission store exists in `xdg-desktop-portal`; GNOME's handling had known bugs in 46 (first non-interactive capture rejected) | Works after one grant tied to app id; flash on each capture |
| Portal ScreenCast with restore token | Early support; must verify | Supported | Supported |
| Shell extension API | Legacy imports (GNOME ≤ 44) | ES modules (GNOME ≥ 45) — full rewrite from 42 | ES modules; APIs moved again |
| Fractional scaling | Experimental | Common | Common; XWayland apps can be blurry |

The practical meaning: **a capture method that works on one LTS does not work on the next.** The code has to detect what it is running on, and the team has to retest at each LTS.

### 5.4 Why the current code fails on Linux

1. **`monitor_capture.py` has no Linux path.** When `win32gui` is missing, `capture_focused_monitor()` calls a bare `ImageGrab.grab()` ([monitor_capture.py:352-356](../python-desktop-app/monitor_capture.py#L352-L356)).
2. **That violates the privacy rule the module was built for.** The module promises "Under NO automatic fallback does this function capture more monitors than the originally targeted one" (P0-2). On Linux X11, `ImageGrab.grab()` returns the whole virtual screen, **all monitors**. The OCR text from the user's second monitor (chat, personal browser) would then flow into the record. This must be fixed before any Linux release, not treated as a nice-to-have.
3. **Pinned Pillow 10.1.0 has the wrong fallbacks.** On Linux, `ImageGrab.grab()` tries X11 first, then falls back to `gnome-screenshot`. Later Pillow versions added `grim` and `spectacle`. On Ubuntu 26.04:
   - the X11 attempt hits XWayland and returns black or partial content without raising an error, so the fallback never runs;
   - `gnome-screenshot` is not installed, and if it is, GNOME 49+ refuses it;
   - `grim` does not work on GNOME or KDE.

   The result is empty images, or images that OCR to garbage, with **no error logged**.
4. **Focused-monitor logic is impossible without window geometry.** The Windows path uses `MonitorFromWindow(hwnd)`. On Wayland, a normal app cannot learn where another app's window is, so it cannot know which monitor to crop.
5. **Minimized / cloaked / lock-screen checks** (`IsIconic`, `DwmGetWindowAttribute`, `lockapp.exe`) have no equivalent without compositor help.
6. **`ImageGrab.grab(all_screens=True)`** is a Windows-only argument. It is ignored elsewhere.

### 5.5 The frequency problem

This is where Linux is harder for us than for a screenshot tool. The app captures on **every window switch** (minimum 10 s apart) plus on interval ticks. On GNOME:

- **Portal Screenshot**: each call triggers GNOME's white **screen flash** (and on some versions a shutter sound). Flashing the user's screen every time they Alt-Tab is unusable. The flash is compositor policy. The app cannot disable it.
- **Portal ScreenCast**: no flash. If the stream is opened per capture, the "screen sharing" indicator flickers on and off every switch. If the stream is kept open, the indicator stays on permanently, which is honest but may alarm users, and a live stream costs some CPU and GPU.
- **Extension**: no flash, no indicator, no prompt.

This is why the recommendation below puts a GNOME Shell extension first on GNOME, even though extensions are fragile.

### 5.6 All options compared

| Option | Desktops | Silent? | One-time setup | Breaks when | Verdict |
|---|---|---|---|---|---|
| **A. X11 direct** (`mss` / XShm + XRandR crop) | X11 sessions only | Yes | None | Session becomes Wayland | **Use** on X11. Must detect session type correctly (not just `$DISPLAY`, which also exists under XWayland). |
| **B. GNOME Shell extension** (our own, captures inside the shell and returns focused monitor + window info over private D-Bus) | GNOME 42–50+ | Yes | Install + enable extension; **log out and in once** on Wayland | Every GNOME major version (shell-version metadata, API moves) | **Primary on GNOME.** We need an extension for window titles anyway (§6), so capture is a small addition. |
| **C. Portal ScreenCast + `persist_mode=2` restore token** (PipeWire, one frame per capture) | GNOME, KDE, wlroots, Hyprland, COSMIC | No prompt after first grant; shows sharing indicator | User picks monitor(s) once | Monitor layout changes invalidate the token; portal version differences | **Fallback on all Wayland desktops**, and primary where no extension is allowed. |
| **D. Portal Screenshot** (non-interactive after one grant) | All Wayland desktops | GNOME: **flash every time** | One interactive grant; persistence needs a stable app id (`.desktop` file) | GNOME 42 cannot remember grants; varies by portal version | **Last-resort fallback** at a reduced rate (interval only, not per switch). |
| **E. KWin ScreenShot2** via restricted-interface declaration in our `.desktop` | KDE Plasma 5.23+/6 | Yes | Package must install the `.desktop` file system-wide | KDE changes the interface version | **Primary on KDE.** Pillow ≥ 11 can also shell out to `spectacle -b -n -o` as a simpler fallback. |
| **F. `grim -o <output>`** (wlr-screencopy) | Sway, Hyprland, labwc, river, Wayfire | Yes | `grim` installed (package dependency) | Rarely | **Primary on wlroots.** |
| **G. `gnome-screenshot`** | GNOME ≤ 48 | Flash | Package installed | **Already broken** in GNOME 49 | **Do not use.** Hubstaff's Linux support shows why: it relied on this for GNOME 42+, and GNOME 49 removed it. |
| **H. "Unsafe mode" / looking-glass hacks** | GNOME | Yes | Manual | Every login | **Reject.** It opens the screen to every app on the machine. |
| **I. Tell users to log in with Xorg** | GNOME ≤ 48, KDE ≤ 6.7 | Yes | User action | Ubuntu 26.04, Fedora 43, RHEL 10, Plasma 6.8 | **Not a strategy.** Acceptable only as a temporary workaround on 22.04. |
| **J. Flatpak / Snap packaging to get portal identity** | All | – | – | – | Gives a clean app id, but the sandbox **hides other processes** from `psutil`, which breaks app detection. **Do not use** (§14.3). |

### 5.7 Recommended capture design

Keep **`capture_focused_monitor()` as the single entry point** that the rest of `desktop_app.py` calls. Behind it, add a backend layer.

```
capture_focused_monitor()
   └── CaptureBackendSelector  (runs once at startup, re-checks on failure)
         ├── Win32Backend           (today's code, unchanged)
         ├── X11Backend             (XShm/mss + EWMH + XRandR)
         ├── GnomeExtensionBackend  (D-Bus → our shell extension)
         ├── KWinBackend            (org.kde.KWin.ScreenShot2)
         ├── WlrootsBackend         (grim -o <output>)
         ├── PortalScreenCastBackend (PipeWire frame, restore token in keyring)
         ├── PortalScreenshotBackend (interval-only, rate-limited)
         └── NullBackend            (returns None → metadata-only; logs why)
```

**Selection logic.** Decide from facts, not guesses:

1. `sys.platform == 'win32'` → Win32Backend.
2. Read `XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, and `/etc/os-release`.
3. `x11` session → X11Backend. Never pick X11 just because `DISPLAY` is set; under Wayland, XWayland sets `DISPLAY` too.
4. `wayland` + GNOME → GnomeExtensionBackend if the extension answers on D-Bus with a compatible protocol version. Otherwise PortalScreenCast, then PortalScreenshot.
5. `wayland` + KDE → KWinBackend, then PortalScreenCast.
6. `wayland` + sway / Hyprland / labwc / river / wayfire → WlrootsBackend, then PortalScreenCast.
7. Anything else → PortalScreenCast → NullBackend.

Log the chosen backend, session type, desktop, GNOME/Plasma version, portal version, and monitor count once at startup. The existing `log_display_environment()` is the natural place. Also send it in login diagnostics (`send_login_diagnostics`) so support can see which Linux users are on the Null backend. This uses fields already sent. It does not change the server.

**Keep the Windows privacy rules on every backend:**

- **Focused monitor only.** Each backend must return one monitor's image. If a backend can only produce a full-desktop image (portal screenshot, X11 root), crop to the focused monitor using geometry from the window-info source (§6). **If the focused monitor cannot be determined, skip (Tier 3). Do not fall back to all screens.** This is stricter than today's Windows Tier 2 (primary monitor), because on Linux "primary" is often not meaningful.
- **Skip when locked, minimized, or on the lock screen** (§7).
- **Never persist the image.** The in-memory-only rule stays.
- **Validate the image.** Reject all-black or near-uniform frames, which is what XWayland capture of a Wayland desktop and a denied portal produce. Count them as failures, not as "no text".

**Scaling and OCR quality.** Wayland backends return **physical pixels**. With 125–200% fractional scaling, text is larger than on Windows at 100%. `ocr/image_processor.py` already resizes to a maximum dimension, but check OCR accuracy at 100%, 125%, 150%, and 200% on 24.04 and 26.04. XWayland apps rendered at fractional scale can be blurry, which lowers RapidOCR confidence.

**Security of the GNOME extension.** The extension runs inside GNOME Shell. If it exposes a D-Bus method "give me a screenshot", **any** program in the session could call it and get silent screenshots. That recreates exactly the hole Wayland closed, and would be a real vulnerability. Mitigations, all required:

- Check the D-Bus caller. Get its PID with `GetConnectionUnixProcessID`, resolve `/proc/<pid>/exe`, and allow only our installed binary path (for example `/opt/timetracker/TimeTracker`).
- Return only the focused monitor, downscaled. Never offer arbitrary regions.
- Rate-limit on the extension side, for example one capture every 5 s.
- Make the method refuse while the session is locked.
- Document the extension in the consent page and privacy policy, because it is a privileged component.

**Transparency.** On Wayland the OS makes capture visible (dialog, indicator, or extension in the Extensions app). The consent flow ([desktop_app.py:15203](../python-desktop-app/desktop_app.py#L15203)) should explain on Linux what the user is about to see: "You will be asked once to allow screen access. Select the monitor(s) you work on."

### 5.8 First-run experience per desktop

| Desktop | What the user sees once | What happens after |
|---|---|---|
| X11 (Mint, Xfce, 22.04 Xorg) | Nothing | Silent capture |
| GNOME with our extension | "Log out and log back in to finish setup" (Wayland cannot hot-load a new extension) | Silent capture |
| GNOME without extension (policy blocks extensions) | Portal dialog: pick monitors, "Remember" | Sharing indicator while capturing; re-prompt if monitors change |
| KDE | Nothing if the `.desktop` restriction works; otherwise the portal dialog | Silent capture |
| Sway / Hyprland | Nothing (`grim` is a package dependency) | Silent capture |

GNOME Shell's "disable-user-extensions" or enterprise policies (`org.gnome.shell disable-user-extensions=true`, locked `enabled-extensions`) can block our extension. Detect this and fall back to ScreenCast, and tell IT admins in the deployment guide which key to allow.

---

## 6. Focused window, title, and application: the second major challenge

The session model is **event-based**. A new session starts when `window_key = app|||title` changes ([desktop_app.py:11371](../python-desktop-app/desktop_app.py#L11371)). The AI server matches Jira issues mostly from titles (issue keys in browser tabs and IDE titles). Without a title source, Linux data is nearly worthless, even with perfect screenshots.

Wayland deliberately provides **no protocol for "which window is focused"**. Options per desktop:

| Desktop | Method | Gives | Notes |
|---|---|---|---|
| X11 | `_NET_ACTIVE_WINDOW` (EWMH) → `_NET_WM_NAME`, `_NET_WM_PID`, `WM_CLASS`; geometry via `XGetGeometry` + XRandR | title, pid, class, monitor, minimized (`_NET_WM_STATE_HIDDEN`) | Stable for 20 years. Use `python-xlib` or `ewmh`. |
| GNOME | **Our shell extension** exposes `GetFocusedWindow()` over D-Bus: `global.display.focus_window` → `get_title()`, `get_pid()`, `get_wm_class()`, `get_gtk_application_id()`, `get_monitor()`, `get_frame_rect()`, `minimized` | Everything, including the monitor for cropping | The same extension as capture (§5.7). Existing open-source examples: "Focused Window D-Bus", "Window Calls". Write our own for security and version control. |
| KDE | KWin script (JavaScript, `workspace.activeWindow` in Plasma 6, `workspace.activeClient` in Plasma 5) that sends changes to our D-Bus service | title, pid, resourceClass, output | Install with the package; load via `org.kde.KWin /Scripting`. The API name changed between Plasma 5 and 6, which is an example of the churn. |
| Sway | `swaymsg -t get_tree` (focused node), or subscribe to IPC window events | title, pid, app_id, output | Stable IPC. |
| Hyprland | `hyprctl activewindow -j`, or event socket | title, pid, class, monitor | Stable IPC. |
| Other wlroots (labwc, river, Wayfire) | `wlr-foreign-toplevel-management` (title + app_id, **no pid**), via `pywayland` or a small helper | title, app_id | No pid, so map app_id to classification directly. |
| Fallback | AT-SPI accessibility bus (`pyatspi`): the focused-state object's top-level frame | title, app name | Slow; Chrome/Electron only expose titles when accessibility is enabled. Last resort. |
| XWayland-only apps on a Wayland session | EWMH works **only between X clients** | Partial | Never treat as authoritative on Wayland. |

**Polling vs events.** The tracking loop polls every 2–5 s. A D-Bus call per loop is cheap, a few milliseconds. Better: the extension or KWin script sends a `FocusChanged` signal, and the loop uses the cached value. That gives accurate session boundaries without polling latency.

**Lock screen.** Today, `LOCK_SCREEN_APPS` checks whether the foreground process is `lockapp.exe`. On Linux the lock screen is part of the compositor and is never a "foreground window". Use logind's `LockedHint` or the desktop's ScreenSaver interface instead (§7). The Windows-only list can stay for Windows.

**Minimized / nothing focused.** On GNOME, `focus_window` is `null` when the desktop is focused or when in the overview. Map that to the existing "skip capture" path.

---

## 7. Idle, lock, sleep, and shutdown

### 7.1 Idle time

The current code prefers `GetLastInputInfo` and falls back to `pynput` hooks ([desktop_app.py:12184](../python-desktop-app/desktop_app.py#L12184)). On Linux:

- `ctypes.windll` does not exist, so the OS idle clock returns `None` and the app relies only on `pynput`.
- **`pynput` on Linux uses the X11 backend.** On a Wayland session it receives input only while an **XWayland** window has focus. When the user types in native Wayland apps (Firefox, GNOME Terminal, Files, most GTK4/Qt6 apps), no events arrive. **The user is marked idle after 5 minutes while actively working**, and tracked time is lost. This is a silent data-quality bug.
- The only way to read global input on Wayland without the compositor is `/dev/input` (evdev), which needs the `input` group. That is effectively a keylogger. **Do not use it.**

Use the compositor's idle clock instead:

| Desktop | Idle source |
|---|---|
| X11 | `XScreenSaverQueryInfo` (`libXss`) → `idle` ms |
| GNOME (X11 or Wayland) | `org.gnome.Mutter.IdleMonitor.GetIdletime` on `/org/gnome/Mutter/IdleMonitor/Core`. Stable across GNOME 3.x–50. |
| KDE | `org.freedesktop.ScreenSaver.GetSessionIdleTime`, or KDE's `org.kde.KIdleTime`-based services |
| wlroots / Hyprland | `ext-idle-notify-v1` Wayland protocol (event-based: "idle after N s" / "resumed"), via `pywayland` or `swayidle` |
| Fallback | logind `IdleHint` / `IdleSinceHint` (coarse; depends on desktop setting it) |

Keep `pynput` **only** on X11 sessions, where it still works, as the backup it is today. The existing mouse-jitter filter (`MOUSE_MOVE_MIN_PX = 8`) still applies there.

### 7.2 Lock, sleep, wake, shutdown

Replace the Win32 message window ([desktop_app.py:12281](../python-desktop-app/desktop_app.py#L12281)) with **systemd-logind D-Bus signals**. They exist on every systemd distribution, which covers Ubuntu, Debian, Fedora, RHEL, openSUSE, Arch, and Mint.

| Windows event | Linux equivalent |
|---|---|
| `WTS_SESSION_LOCK` / `UNLOCK` | logind `Session.Lock` / `Unlock` signals and the `LockedHint` property on `/org/freedesktop/login1/session/auto`; also `org.gnome.ScreenSaver.ActiveChanged` on GNOME, `org.freedesktop.ScreenSaver.ActiveChanged` on KDE |
| `PBT_APMSUSPEND` / `PBT_APMRESUMEAUTOMATIC` | logind `Manager.PrepareForSleep(true/false)` |
| `WM_ENDSESSION` (shutdown save) | logind `Manager.PrepareForShutdown(true)`, plus a **delay inhibitor lock** (`Inhibit("shutdown:sleep", …, "delay")`) so the app gets a few seconds to save and upload before the system goes down. Release it when done. |

The existing "large loop gap = suspension" fallback in `tracking_loop` ([desktop_app.py:12745](../python-desktop-app/desktop_app.py#L12745)) is platform-neutral and stays as the backup.

Note: `_is_screen_locked()` is also called right after resume ([desktop_app.py:12783](../python-desktop-app/desktop_app.py#L12783)). On Linux it must read `LockedHint`, or the app will resume tracking the lock screen as work.

Non-systemd distributions (Devuan, Alpine, Void with runit): elogind provides the same API. Without it, use gap detection only. Put these outside the support matrix.

---

## 8. Tray icon, notifications, and popups

### 8.1 Tray icon (`pystray`)

`pystray` on Linux has three backends: `appindicator`, `gtk`, and `xorg`.

- **Vanilla GNOME (Fedora, RHEL, Debian GNOME) has no tray at all.** Icons never appear unless the user installs the AppIndicator extension.
- **Ubuntu enables its "Ubuntu AppIndicators" extension by default**, so the `appindicator` backend works there.
- KDE, Cinnamon, Xfce, and MATE support StatusNotifierItem/AppIndicator natively.
- The `xorg` backend (XEmbed) does not work on Wayland.

Consequences and fixes:

- Force `PYSTRAY_BACKEND=appindicator` on Linux, and bundle PyGObject plus `AyatanaAppIndicator3` typelibs (or declare `gir1.2-ayatanaappindicator3-0.1` as a `.deb` dependency).
- The AppIndicator backend **does not support a left-click default action**, and menus must be rebuilt to change. The existing `update_tray_menu()` rebuild approach works, but test every menu item.
- The icon updates every 2 s ([desktop_app.py:13961](../python-desktop-app/desktop_app.py#L13961)). With AppIndicator, each change writes a temp PNG and sends a D-Bus update. Change the icon only when the state actually changes.
- **Plan for no tray.** On vanilla GNOME (Fedora/RHEL), provide a way to reach the app: a launcher `.desktop` entry that opens the local web UI (`http://127.0.0.1:<port>`) and a notification on start. Our GNOME extension can optionally draw its own panel indicator, which removes the dependency on the AppIndicator extension.

### 8.2 Notifications (`winotify`)

`winotify` is Windows-only, and every notification path is gated on `WINOTIFY_AVAILABLE`. On Linux, **all notifications silently disappear**: login reminders, re-auth prompts, pause reminders, update notices, and OCR setup status.

Add a small `notify(title, message, actions=None)` abstraction:

- Windows → `winotify` (unchanged).
- Linux → `org.freedesktop.Notifications.Notify` over D-Bus (via `jeepney`/`dbus-next`, or `desktop-notifier`). This works on GNOME, KDE, Cinnamon, Xfce, and wlroots with `mako`/`dunst`. Action buttons are supported on GNOME and KDE; listen for `ActionInvoked` to open URLs.

### 8.3 Tk popups (pause popup, DQ nudge popup, OCR setup)

The Tk / CustomTkinter windows run through **XWayland** on a Wayland session. Known problems:

- **`-topmost` only works among X11 windows.** It is not above native Wayland windows.
- **Window placement is ignored or relative to XWayland's coordinate space.** `get_focused_monitor_work_rect()` returns `fallback` on Linux, so popups center on the XWayland screen, which may be the wrong monitor.
- **Focus-stealing prevention.** GNOME often will not raise a new window. It shows "TimeTracker is ready" instead. The DQ nudge popup may appear behind the user's work and go unseen.
- **Fractional scaling.** Tk under XWayland at 125% or 150% is either tiny or blurry. CustomTkinter's own scaling must be set from the real scale factor.
- **Tcl/Tk must be bundled** with the right fonts (Xft). Missing fonts cause ugly fallback rendering.

Solutions: keep Tk for now (it works), but use **notification + action button** as the primary nudge on Linux, with the popup opened when the user clicks. Get the scale factor from the window-info backend and set `ctk.set_widget_scaling`. Test on 100/125/150/200%. A later option is to move popups into the existing Flask web UI, opened in the browser, which avoids toolkit issues on all platforms.

---

## 9. Credentials and the encrypted local database

### 9.1 Keyring on Linux

`keyring` on Linux uses the **Secret Service** API (`gnome-keyring` or KWallet 6 via its Secret Service bridge) through `SecretStorage` + `jeepney`. Issues:

- **PyInstaller must bundle the backend.** `collect_submodules('keyring')` does not pull in `secretstorage`/`jeepney` unless they are installed in the build environment. Without them, keyring silently becomes the `fail` backend.
- **Locked keyring.** With auto-login, or when the login password differs from the keyring password, the keyring is locked at startup and the first access **pops an unlock dialog**, or blocks the autostart process. Load tokens lazily with a timeout and fall back to the encrypted file.
- **No keyring daemon** on minimal desktops (Sway, Hyprland, some Xfce setups). The existing encrypted-file fallback covers this.
- The 2560-byte chunking for Windows Credential Manager is harmless on Linux and can stay.

### 9.2 Encryption-key derivation bugs that will appear on Linux

Both [db_connection.py:110-125](../python-desktop-app/db_connection.py#L110-L125) and the secure-storage fallback derive a machine key from `os.getlogin()` + `platform.node()`:

- **`os.getlogin()` raises `OSError` on Linux when there is no controlling terminal**, which is exactly the case for an autostart `.desktop` launch or a systemd user service. The code then reads `USERNAME`, which **is not set on Linux** (Linux uses `USER`), and uses `'default'`. A database created when the app was started from a terminal (key uses the real username) **cannot be opened** when the app autostarts at login (key uses `'default'`), and the reverse. Use `pwd.getpwuid(os.getuid()).pw_name` on Linux.
- **The hostname is not stable on many Linux laptops.** DHCP or NetworkManager can change it, and some distributions set it from the network. A hostname change makes the DB undecryptable. On Linux, use `/etc/machine-id` (stable for the life of the install) instead of `platform.node()`.
- Because these keys are used only when the keyring fails, the bug hits exactly the users who are already on the fallback path. Existing Windows derivation must not change. Branch by platform.

### 9.3 SQLCipher

`sqlcipher3-wheels>=0.5.0; sys_platform == 'win32'` in `requirements.txt` means Linux gets **no SQLCipher**. `db_connection.py` then either stores the offline DB **unencrypted** or refuses to open an encrypted one. `sqlcipher3-wheels` publishes manylinux wheels. Remove the platform marker and verify the wheel loads on the oldest supported glibc (§14.1).

Also set file permissions `0600` on the DB and token files. `~/.local/share/TimeTracker` is created with the default umask, often `0755` for directories.

---

## 10. OCR

- **RapidOCR (primary) works on Linux** via `onnxruntime` manylinux wheels (x86_64 and aarch64). The ONNX models should be bundled, not downloaded at first run.
- **WinRT OCR (default fallback) does not exist on Linux.** `OCR_FALLBACK_ENGINES` defaults to `winrtocr` in several places ([desktop_app.py:5998](../python-desktop-app/desktop_app.py#L5998), `desktop_app.spec`). On Linux, set the default to a Linux-available engine: Tesseract (`tesseract-ocr` as a `.deb` dependency, via `pytesseract`) or none. A fallback that can never load just produces a log error on every OCR call.
- **Runtime `pip install` must be disabled on Linux.** `ocr/auto_installer.py` and `ocr/runtime_installer.py` install packages at runtime. In a frozen build there is no pip. From source on Ubuntu 23.04+ and Debian 12+, system Python is marked "externally managed" (PEP 668), so `pip install` fails. Bundle everything; treat missing engines as a build error.
- **Thread priority.** `SetThreadPriority` is Windows-only ([desktop_app.py:6019](../python-desktop-app/desktop_app.py#L6019)). On Linux, lower the OCR thread with `os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)` (Linux applies nice per thread) and optionally `ioprio_set` to idle class. This matters on laptops, because RapidOCR can use several cores.
- **CPU architecture.** Decide whether to support ARM64 (for example Snapdragon laptops and Raspberry Pi). RapidOCR and onnxruntime support it, but it doubles the build and test matrix. Recommendation: x86_64 only for version 1.
- **Scaling.** See §5.7. OCR accuracy must be measured at the common Linux scale factors.

---

## 11. Location detection

[desktop_app.py:5122](../python-desktop-app/desktop_app.py#L5122):

- **Office Wi-Fi (Tier 1a)** uses `netsh wlan show interfaces`. On Linux, use NetworkManager: `nmcli -t -f ACTIVE,SSID dev wifi` or the NM D-Bus API (`org.freedesktop.NetworkManager` → active connection → `802-11-wireless.ssid`). Systems without NetworkManager (some server-style or minimal installs) fall through to the next tier.
- **Office subnet (Tier 1b) has a real bug on Linux.** `socket.gethostbyname(socket.gethostname())` returns **`127.0.1.1`** on Debian and Ubuntu, because `/etc/hosts` maps the hostname there. Subnet matching would never work. Use `psutil.net_if_addrs()` (already a dependency), or the UDP-connect trick, to get the real interface address.
- **Precise geolocation (Tier 2)** uses Windows `winsdk`. Linux has GeoClue2 (`org.freedesktop.GeoClue2`), gated by the desktop's location privacy switch. It is optional; IP geolocation (Tier 3) already works on Linux. Recommendation: skip Tier 2 on Linux in version 1.

---

## 12. Application identity and classification data

Admins classify apps by Windows process names (`chrome.exe`, `outlook.exe`). The normalizer strips `.exe`, and `PROCESS_IDENTIFIER_ALIASES` maps variants ([desktop_app.py:5062](../python-desktop-app/desktop_app.py#L5062)). Linux adds new problems:

| Problem | Example | Fix |
|---|---|---|
| Different binary names | `google-chrome`, `chrome`, `chromium`, `chromium-browser`, `firefox`, `firefox-esr`, `firefox-bin`, `microsoft-edge`, `msedge`, `brave`, `code`, `code-insiders`, `teams-for-linux`, `slack`, `zoom`, `soffice.bin` | Extend `PROCESS_IDENTIFIER_ALIASES` and `BROWSER_PROCESSES` with Linux names. `BROWSER_PROCESSES` only has `.exe` names today, so **browser URL-based classification would not work** on Linux. |
| **Runtime-hosted apps show the runtime's name** | All JetBrains IDEs → `java`; many tools → `python3`, `node`, `electron` | On Linux, identify apps by the **window's app id / WM_CLASS** (e.g. `jetbrains-idea`, `org.gnome.Nautilus`, `code`), not the process name. The window-info backends (§6) provide it. Use `app_id` as `application_name` when the process name is a generic runtime. |
| Snap / Flatpak apps | Snap Firefox runs from `/snap/firefox/...`; Flatpak apps run inside `bwrap` and report sandbox PIDs; app ids like `org.mozilla.firefox`, `com.slack.Slack` | Prefer the app id; add aliases for common reverse-DNS ids. |
| 15-character process names | Linux truncates `comm` to 15 chars; `psutil` expands from cmdline where it can | Prefer app id; fall back to `psutil.Process.exe()` basename. |
| **Email/chat body redaction** | `REDACTED_BODY_PROCESSES` has only `outlook.exe`, `hxoutlook.exe`, `olk.exe` | **Privacy requirement:** add `thunderbird`, `evolution`, `geary`, `kmail`, `mailspring`, `betterbird`, and chat clients if policy covers them (`slack`, `teams-for-linux`, `discord`, `signal-desktop`, `telegram-desktop`, `element`). Without this, email bodies from Linux mail clients are OCR'd and uploaded. The web-mail title markers already work. |
| Lock screen detection by name | `lockapp.exe`, `logonui.exe` | Not applicable. Use logind (§7). |
| Running-app search for the classification UI | `search_running_app` filters a Windows system-process denylist ([desktop_app.py:8279](../python-desktop-app/desktop_app.py#L8279)) | Linux has hundreds of daemons (`systemd*`, `kworker`, `pipewire`, `gnome-shell`, `Xwayland`, `gvfsd*`, `ibus*`…). Better: list apps that **have windows** (from the window-info backend), or apps with `.desktop` files. |
| App display names | `win32api.GetFileVersionInfo` reads `ProductName` from the `.exe` ([desktop_app.py:8489](../python-desktop-app/desktop_app.py#L8489)) | Read `Name=` and `Icon=` from the matching `.desktop` file in `/usr/share/applications`, `~/.local/share/applications`, `/var/lib/flatpak/exports/share/applications`, and `/var/lib/snapd/desktop/applications`, matched by `StartupWMClass` or app id. |

Server-side classification data does not change. Only the client-side alias table grows. If admins want to classify Linux apps explicitly, they already can add entries by name.

---

## 13. Single instance, autostart, install, uninstall

- **Single instance.** The lock-file fallback ([desktop_app.py:319](../python-desktop-app/desktop_app.py#L319)) is racy. It checks for a PID file and then writes it, has no locking, and accepts any process named `python` as "another instance". PID reuse after a crash can block startup. On Linux use `fcntl.flock(LOCK_EX | LOCK_NB)` on a file in `$XDG_RUNTIME_DIR` (per-user tmpfs, cleaned at logout). The kernel releases the lock automatically if the process dies.
- **Autostart.** Replace the `HKCU\...\Run` key with `~/.config/autostart/timetracker.desktop` (XDG Autostart; honored by GNOME, KDE, Cinnamon, Xfce, MATE) with `X-GNOME-Autostart-enabled=true`. For system-wide deployment, the `.deb` can install `/etc/xdg/autostart/timetracker.desktop`. On wlroots compositors, XDG autostart is not always processed; document `exec` lines for Sway/Hyprland, or ship a systemd user unit tied to `graphical-session.target`.
- **Self-install.** `install_application()` copies the executable to `%LOCALAPPDATA%` and restarts. On Linux this must be a no-op; the package manager owns the files. The function already returns early when not frozen on Windows, but check every `sys.platform != 'win32'` early-return. Several functions are written as "if not Windows, do nothing", which is correct, but `get_installed_exe_path()` hardcodes `TimeTracker.exe`.
- **Uninstall.** The generated `.bat` uninstaller and `installer/clear_credentials.ps1` have no Linux equivalent. For `.deb`: a `prerm`/`postrm` script can stop the app and remove system files. It **cannot** remove per-user data (`~/.local/share/TimeTracker`, the keyring entries) for every user. Provide an in-app "Remove my data and sign out" action and document `rm -rf ~/.local/share/TimeTracker` plus `secret-tool clear service TimeTracker`. This matters for the GDPR / account-deletion flows already in the product.
- **Paths.** Use XDG base directories: data in `$XDG_DATA_HOME` (default `~/.local/share/TimeTracker`, already used), config in `$XDG_CONFIG_HOME`, logs in `$XDG_STATE_HOME` (`~/.local/state/TimeTracker`). `get_pause_settings_file_path()` uses `APPDATA` on Windows. Check that its non-Windows branch is sane.

---

## 14. Packaging, build, and auto-update

### 14.1 Build: glibc and the "oldest supported distro" rule

A PyInstaller Linux binary links against the **glibc of the build machine**. It runs on that glibc and newer, never older. Therefore:

- **Build on the oldest supported distro.** Ubuntu 22.04 (glibc 2.35) is the floor if 22.04 is in the matrix. That covers 24.04, 26.04, Debian 12+, Fedora 36+, and RHEL 10. RHEL 9 (glibc 2.34) would need a build on RHEL 9 / AlmaLinux 9, or a manylinux_2_28 container.
- Build in a **container** (for example `ubuntu:22.04` in GitHub Actions) so builds are reproducible. Current builds are manual on Windows (`build.bat`).
- Write a **separate `desktop_app_linux.spec`**. The current spec collects `winsdk`, `winrtocr`, `pywin32`, and VC runtime DLLs, and its hidden imports list `pystray._win32` and `win32*`. It needs `pystray._appindicator`, `gi` + typelibs, `secretstorage`/`jeepney`, `Xlib`, the chosen D-Bus library, `onnxruntime` `.so` files, Tcl/Tk data, and the spaCy model.
- **One-file mode extracts to `/tmp` on every launch.** Some hardened systems mount `/tmp` with `noexec`, and the app will fail to start. Prefer **one-dir** mode inside the package (faster start and no extraction), or set `runtime_tmpdir` to a user directory.
- Don't bundle `libstdc++`, `libGL`, `libdbus`, or `libX11` from the build machine if they conflict with the host. PyInstaller's defaults are mostly correct, but test on 26.04.
- `requirements.txt` already pins `pyinstaller==6.2.0` (Nov 2023). Newer PyInstaller versions have better hooks for GI/GTK and keyring. Plan to upgrade the build toolchain for Linux; this does not require changing Windows builds at the same time.

### 14.2 Package format: recommendation

| Format | Pros | Cons | Use? |
|---|---|---|---|
| **`.deb`** (Ubuntu/Debian/Mint/Pop) | Fixed install path (`/opt/timetracker`), system `.desktop` files (needed for portal app id and KWin restricted interface), declares dependencies (`gir1.2-ayatanaappindicator3-0.1`, `tesseract-ocr`, `grim` as Recommends), installs the GNOME extension system-wide, `postinst`/`prerm` hooks | Debian family only | **Yes, primary.** Matches `plan/LINUX_DOWNLOAD_BUTTON_IMPLEMENTATION_PLAN_DEB.md`. |
| **`.rpm`** (Fedora/RHEL/openSUSE) | Same benefits for the Red Hat family | Second pipeline (can be generated from the same tree with `fpm` or `nfpm`) | Phase 2, if there is demand. |
| **AppImage** | One file, any distro | **Ubuntu 22.04+ does not ship `libfuse.so.2`** (on 24.04 the package is `libfuse2t64`), so the AppImage fails to start; no stable path → portal permission and app id don't persist; cannot install the GNOME extension or system `.desktop` files without extra steps | Only as a "best effort, other distros" download, with the FUSE note. |
| **Flatpak / Snap** | Clean portal identity and sandboxed updates | **The sandbox hides other processes and windows.** `psutil` cannot see the user's apps, `/proc` is isolated, and app detection breaks. Snap `classic` confinement would work but requires Snap Store approval | **No.** |

### 14.3 Auto-update

The Windows design is a SYSTEM scheduled task (`installer/update_service.ps1`) that silently installs a verified download, plus a legacy user-level `cmd.exe` swap. The Linux equivalent that keeps the same "silent, no password prompt" property:

- **Option 1 (recommended): an APT repository.** Publish the `.deb` to a signed APT repo (a static bucket can host it). `apt`/`unattended-upgrades` or the Software Updater then installs updates like any system package. It is the standard Linux mechanism, handles GPG signatures, and admins can manage it centrally. The in-app update check (`/api/app-version/latest?platform=linux`, which the server already accepts) is used only to notify.
- **Option 2: a root systemd timer** (`timetracker-updater.timer` + `.service`) installed by the `.deb`, mirroring the Windows SYSTEM task. It downloads the `.deb` listed in `app_releases`, verifies the SHA-256 (and ideally a detached signature), runs `apt install ./file.deb`, and restarts the user instances. This means writing and maintaining our own privileged updater, which is security-sensitive code.
- **Not recommended:** having the user-level app call `pkexec dpkg -i`. It prompts for an admin password on every update, and most users can't answer it.

After an update, the running app must be restarted. The `.deb` `postinst` cannot safely restart per-user processes. Signal them, for example by touching a file the app watches (the existing `.shutdown_signal` mechanism), and let autostart relaunch them, or relaunch through `systemd --user`. Note that after an update of the **GNOME extension**, GNOME requires the user to **log out and back in** before the new version loads. Keep the extension's D-Bus protocol backward-compatible so an old extension still works with a new app until the next login.

The download button work (`plan/LINUX_DOWNLOAD_BUTTON_IMPLEMENTATION_PLAN_DEB.md`) is independent of all of this and can happen at any time.

---

## 15. Other smaller items

| Item | Detail |
|---|---|
| `platform` field in diagnostics | Sends `platform.system()` = `Linux`. Also send distribution (`/etc/os-release` `PRETTY_NAME`), session type, desktop, and backend. These fit in the existing diagnostics JSON; no schema change. |
| DPI awareness | `SetProcessDpiAwarenessContext` is Windows-only and already guarded. Linux scale comes from the window backend. |
| `subprocess` flags | `CREATE_NO_WINDOW` and `CREATE_NEW_PROCESS_GROUP` are Windows-only; they are used only in Windows update paths. Guard them if code is shared. |
| Hard-coded `.exe` strings | `TimeTracker.exe`, `TimeTracker_v{version}.exe` in update code; `.replace('.exe','')` in display names. Harmless on Linux if the update path is separate. |
| Browser open | `webbrowser.open` uses `xdg-open` on Linux. Works. Under the frozen app, `LD_LIBRARY_PATH` set by PyInstaller can leak into child processes and break the browser. Restore the original environment for child processes (PyInstaller documents this as `LD_LIBRARY_PATH_ORIG`). |
| OAuth callback | Flask on `127.0.0.1:51777/51778` works on Linux. No change. |
| Time zones | `tzlocal` works on Linux (reads `/etc/localtime`). No change. |
| CA certificates | `certifi` is bundled. Some corporate Linux machines use a custom CA in `/etc/ssl/certs`. Consider honoring `REQUESTS_CA_BUNDLE` / system trust (`truststore`). |
| Presidio / spaCy | Pure Python + model wheel. Works; about 140 MB. |
| Multi-user machines | Each Linux user session runs its own instance; `$XDG_RUNTIME_DIR` locks are per user. Remote sessions (xrdp, GNOME Remote Desktop) behave like Wayland sessions for capture. Test once. |
| Hardware/driver differences | NVIDIA proprietary drivers had Wayland problems until about driver 555; screen capture via PipeWire needs working DMA-BUF. Include one NVIDIA machine in testing. |

---

## 16. Support matrix

**Tier 1: release-gating, tested every release:**

| Distribution | Desktop | Session | Capture backend | Window info | Idle |
|---|---|---|---|---|---|
| Ubuntu 24.04 LTS | GNOME 46 | Wayland | GNOME extension → ScreenCast | GNOME extension | Mutter IdleMonitor |
| Ubuntu 26.04 LTS | GNOME 50 | Wayland | GNOME extension → ScreenCast | GNOME extension | Mutter IdleMonitor |
| Ubuntu 22.04 LTS | GNOME 42 | Xorg **and** Wayland | X11 / GNOME extension (legacy-import build) | EWMH / extension | XSS / Mutter |
| Linux Mint 22 | Cinnamon | X11 | X11 | EWMH | XSS |

**Tier 2: tested before major releases, bugs fixed but not release-blocking:** Kubuntu / Fedora KDE (Plasma 6, Wayland), Fedora Workstation (GNOME, no AppIndicator by default), Debian 12/13 GNOME, Xubuntu (X11).

**Tier 3: best effort:** Sway, Hyprland, other wlroots, Pop!_OS COSMIC, RHEL 10 (needs RPM).

**Unsupported:** non-systemd distributions without elogind, Flatpak/Snap installs, ARM64 (until requested), and any session where the user refuses the screen-capture grant. In that last case the app still tracks titles and time, with no OCR text, and says so in the tray menu and settings page.

Ubuntu 22.04 standard support ends in April 2027. Plan to drop it then, which also removes the legacy GNOME 42 extension build.

---

## 17. Testing strategy

- **Unit tests** for each backend with a fake D-Bus or fake subprocess, in the style of the existing `tests/test_monitor_capture.py`. Test backend selection from environment variables and `/etc/os-release` fixtures.
- **Headless integration in CI:**
  - X11: `Xvfb` + a window manager; open a window with a known title; assert EWMH detection and a non-black crop.
  - GNOME: `mutter --headless --virtual-monitor 1920x1080` (or `gnome-shell --headless` with the extension enabled) inside a D-Bus session. Assert the extension's `GetFocusedWindow` and capture methods.
  - wlroots: `sway` with the headless backend (`WLR_BACKENDS=headless`) + `grim`.
  - Portal ScreenCast cannot be fully automated (it needs a user grant). Keep it in manual testing.
- **Manual matrix** (VMs plus at least one real laptop per Tier 1 row): first-run consent and grant; capture after reboot; multi-monitor with the focused window on the second monitor; 100/125/150/200% scaling; lock/unlock; suspend/resume; shutdown save; autostart after login; update install; tray visible; notifications with actions; OCR accuracy on a known test page. VMs often lack GPU acceleration, which changes Wayland behavior, so the real laptop matters.
- **A "Linux health" section in the admin log** ([desktop_app.py:8391](../python-desktop-app/desktop_app.py#L8391)) showing the backend in use, capture success rate (`get_capture_stats()` already counts tiers), black-frame rejections, and idle source.

---

## 18. Maintenance: living with the two-year cycle

This is an ongoing obligation, not a one-time port.

1. **Every six months (GNOME release, March and September):** update the extension's `shell-version` metadata and run the headless GNOME test against the new GNOME in Fedora or a GNOME OS image. Fix API breaks **before** they reach an Ubuntu LTS.
2. **Every Ubuntu interim release (October / April):** smoke-test the full matrix. Interim releases preview the next LTS (for example, 25.10 revealed the GNOME 49 and X11 removal a full six months before 26.04).
3. **Every Ubuntu LTS (April of even years):** full Tier 1 regression in the release month; add the new LTS to Tier 1 and drop the one leaving standard support.
4. **Watch list:** xdg-desktop-portal releases (Screenshot/ScreenCast permission changes), GNOME Shell extension porting guides, KDE Plasma release notes (KWin scripting and ScreenShot2), Pillow's ImageGrab changes, and the wlroots `ext-image-copy-capture` protocol, which is replacing `wlr-screencopy`.
5. **Keep a changelog entry per backend** with the versions it was verified on. Support needs to answer "does it work on X?" without guessing.

---

## 19. Corrections to the earlier plan (`plan/LINUX_DESKTOP_APP_CHALLENGES.md`)

| Earlier statement | Correction |
|---|---|
| "The server receives a PNG … a Linux app still uploads a PNG, thumbnail…" | Screenshots are **not uploaded**; `SCREENSHOT_MONITORING_HARD_DISABLED = True`. Only title, app, redacted OCR text, and timings are sent. The image is local-only for OCR. |
| "`pynput` … the idle clock would stay at zero and work time would run through lunch" | The opposite. With no events arriving, `last_activity_time` never updates, so the **user is marked idle while working** in native Wayland apps. Both are data-quality bugs; the fix is the same (compositor idle clock). |
| "KDE's spectacle fallback was added to Pillow in 2025, after 10.1.0" | Direction is correct; verify the exact version before relying on it. 10.1.0 documents only `gnome-screenshot`. Our own backend should not depend on Pillow's fallbacks anyway. |
| Plain `ImageGrab.grab()` fallback treated only as "fails closed" | On X11 it **succeeds with all monitors**, which violates the focused-monitor privacy rule (P0-2). It is a privacy bug, not only a reliability bug. |
| Not covered | `os.getlogin()` / hostname key derivation (§9.2); `127.0.1.1` subnet bug (§11); Linux mail clients missing from body redaction (§12); `java`/`electron` app identity (§12); extension D-Bus caller authentication (§5.7); logind shutdown inhibitor (§7.2); PEP 668 runtime pip (§10). |

---

## 20. Phased plan and rough effort

Estimates are for one experienced Python developer familiar with the codebase. They are rough ranges for planning, not commitments.

| Phase | Work | Exit criteria | Estimate |
|---|---|---|---|
| **0. Platform seams** | Introduce `platform/` interfaces: `CaptureBackend`, `WindowInfoBackend`, `IdleBackend`, `SessionEventsBackend`, `Notifier`, `Autostart`, `SingleInstance`. Move Win32 code behind them **without behavior change**. Run the full Windows test suite. | Windows build identical; tests green | 1.5–2 weeks |
| **1. X11 path end to end** | X11 capture + EWMH window info + XSS idle + logind events + notifications + fcntl lock + XDG autostart + key-derivation fix + `127.0.1.1` fix + Linux aliases and redaction lists. Linux spec, one-dir build on 22.04 container. | Mint 22 and Ubuntu 22.04 Xorg produce correct records for a full day | 2–3 weeks |
| **2. GNOME Wayland** | Shell extension (window info, focused-monitor capture, caller auth, focus signal) for GNOME 46 and 50, plus a GNOME 42 build; Mutter idle; tray via AppIndicator; consent text; `.deb` that installs and enables the extension. | Ubuntu 24.04 and 26.04 Wayland produce records equal in quality to Windows | 3–4 weeks |
| **3. Portal ScreenCast fallback** | PipeWire frame grab via GStreamer (`pipewiresrc`) or a small helper; restore token stored in keyring; monitor re-selection flow. | Works on GNOME with extensions disabled and on KDE | 1.5–2 weeks |
| **4. KDE + wlroots** | KWin script + ScreenShot2; `grim` + `swaymsg`/`hyprctl`; `ext-idle-notify`. | Tier 2/3 rows pass | 2–3 weeks |
| **5. Packaging and updates** | `.deb` with postinst/prerm, signed APT repo or root updater timer, `app_releases` row for `linux`, download button (existing plan). | Silent update from version N to N+1 on 24.04 | 1.5–2 weeks |
| **6. Test matrix and hardening** | CI headless tests, manual matrix, OCR scale calibration, support docs, admin/IT deployment guide. | Tier 1 green | 2 weeks, then ongoing (§18) |

Rough total: **about 14–18 weeks** to Tier 1 + Tier 2, or **8–10 weeks** for a GNOME-plus-X11-only first release (phases 0, 1, 2, 5, and a reduced 6). Ongoing cost: about **1 week per six-month GNOME release** plus **1–2 weeks per Ubuntu LTS**.

---

## 21. Risks and decisions needed

| # | Decision / risk | Recommendation |
|---|---|---|
| 1 | Is a GNOME Shell extension acceptable to customers and IT? It is a privileged component in the compositor. | Yes, with caller authentication, source published to customers on request, and clear consent text. Portal ScreenCast is the no-extension alternative. |
| 2 | Is a visible "screen is being shared" indicator acceptable when the ScreenCast fallback is used? | Yes. It is honest and matches the product's consent model. Document it. |
| 3 | What happens when a user refuses capture? | Track title + time only; show "OCR disabled: screen access not granted" in settings; do not nag more than once a day. |
| 4 | Which distros are promised to customers? | Publish §16 exactly. Avoid the phrase "all Linux". |
| 5 | Update mechanism: APT repo vs our own root updater. | APT repo, unless there is a need for forced/mandatory updates on the Windows schedule, in which case the root timer. |
| 6 | Should `desktop_app.py` (17,000 lines) be split first? | Only the seams in phase 0. A full refactor is not needed for Linux and would delay it. |
| 7 | Risk: GNOME changes extension APIs in a way that blocks window info entirely. | Low for window titles (used widely by extensions). Mitigated by the AT-SPI fallback and by testing each GNOME release six months before the LTS. |
| 8 | Risk: a Linux build silently uploads "Unknown" sessions or all-monitor OCR. | Phase 0 must make the Null backend explicit and visible; never ship with the current passthrough fallbacks. |

---

## 22. Appendix: Windows-only code inventory

Every call site that needs a Linux path. Line numbers are as of 2026-09-29.

| File:line | Windows API | Linux replacement |
|---|---|---|
| [monitor_capture.py:37-90](../python-desktop-app/monitor_capture.py#L37-L90) | `win32gui/win32api`, `SetProcessDpiAwarenessContext` | Backend layer (§5.7) |
| [monitor_capture.py:130-265](../python-desktop-app/monitor_capture.py#L130-L265) | `GetForegroundWindow`, `IsIconic`, `DwmGetWindowAttribute`, `MonitorFromWindow`, `EnumDisplayMonitors` | Window-info backend geometry + minimized state (§6) |
| [monitor_capture.py:352-356](../python-desktop-app/monitor_capture.py#L352-L356) | Bare `ImageGrab.grab()` on non-Windows (**all monitors**) | Remove; use backends; skip if focused monitor unknown |
| [monitor_capture.py:420-432](../python-desktop-app/monitor_capture.py#L420-L432) | `GetSystemMetrics(SM_REMOTESESSION)` | `XDG_SESSION_TYPE`/logind `Remote` property |
| [desktop_app.py:256-267](../python-desktop-app/desktop_app.py#L256-L267) | `import win32*` | Platform module |
| [desktop_app.py:283-360](../python-desktop-app/desktop_app.py#L283-L360) | `CreateMutex`; racy lock-file fallback | `fcntl.flock` in `$XDG_RUNTIME_DIR` |
| [desktop_app.py:370-376](../python-desktop-app/desktop_app.py#L370-L376) | `winotify` | `org.freedesktop.Notifications` |
| [desktop_app.py:872-910](../python-desktop-app/desktop_app.py#L872-L910) | `LOCALAPPDATA`, `TimeTracker.exe` | XDG dirs (partly done) |
| [desktop_app.py:1078-1350](../python-desktop-app/desktop_app.py#L1078-L1350) | Program Files detection, self-install, `tasklist`/`taskkill` batch updater | Package-managed install; no self-install |
| [desktop_app.py:1350-1375](../python-desktop-app/desktop_app.py#L1350-L1375) | `schtasks /Run` SYSTEM updater | APT repo or root systemd timer |
| [desktop_app.py:1631-1720](../python-desktop-app/desktop_app.py#L1631-L1720) | `cmd.exe` updater with `CREATE_NO_WINDOW` | Same as above |
| [desktop_app.py:1728-1830](../python-desktop-app/desktop_app.py#L1728-L1830) | `.bat` uninstaller, `reg delete` | `.deb` prerm/postrm + in-app data removal |
| [desktop_app.py:1834-1935](../python-desktop-app/desktop_app.py#L1834-L1935) | `winreg` Run key | XDG autostart `.desktop` |
| [desktop_app.py:1953-2070](../python-desktop-app/desktop_app.py#L1953-L2070), [auth/secure_storage.py](../python-desktop-app/auth/secure_storage.py) | Credential Manager via `keyring` | Secret Service via `keyring` (bundle `secretstorage`/`jeepney`); lazy unlock |
| [desktop_app.py:5026-5060](../python-desktop-app/desktop_app.py#L5026-L5060) | `LOCK_SCREEN_APPS`, `BROWSER_PROCESSES`, `REDACTED_BODY_PROCESSES` (`.exe` names) | Linux names + app ids (§12) |
| [desktop_app.py:5107-5320](../python-desktop-app/desktop_app.py#L5107-L5320) | `winsdk` Geolocator, `netsh wlan` | `nmcli`/NM D-Bus; skip Geo tier; fix local IP |
| [desktop_app.py:5218-5224](../python-desktop-app/desktop_app.py#L5218-L5224) | `gethostbyname(gethostname())` → `127.0.1.1` on Debian/Ubuntu | `psutil.net_if_addrs()` |
| [desktop_app.py:6019-6030](../python-desktop-app/desktop_app.py#L6019-L6030) | `SetThreadPriority` | `os.setpriority` per TID + ioprio |
| [desktop_app.py:6823](../python-desktop-app/desktop_app.py#L6823), [10187-10311](../python-desktop-app/desktop_app.py#L10187-L10311), [13505-13520](../python-desktop-app/desktop_app.py#L13505-L13520) | `winotify` call sites | `notify()` abstraction |
| [desktop_app.py:8279-8290](../python-desktop-app/desktop_app.py#L8279-L8290) | Windows system-process denylist | Windowed-apps / `.desktop` listing |
| [desktop_app.py:8489-8530](../python-desktop-app/desktop_app.py#L8489-L8530) | `GetFileVersionInfo` | `.desktop` file `Name=`/`Icon=` |
| [desktop_app.py:10069-10075](../python-desktop-app/desktop_app.py#L10069-L10075) | `APPDATA` for pause settings | `$XDG_CONFIG_HOME` |
| [desktop_app.py:11344-11355](../python-desktop-app/desktop_app.py#L11344-L11355) | `_is_screen_locked` via foreground process | logind `LockedHint` |
| [desktop_app.py:11357-11427](../python-desktop-app/desktop_app.py#L11357-L11427) | `get_active_window` via `win32gui` | Window-info backends (§6) |
| [desktop_app.py:12155-12182](../python-desktop-app/desktop_app.py#L12155-L12182) | `GetLastInputInfo` | Compositor idle (§7.1) |
| [desktop_app.py:12221-12280](../python-desktop-app/desktop_app.py#L12221-L12280) | `pynput` hooks | X11 only on Linux |
| [desktop_app.py:12281-12458](../python-desktop-app/desktop_app.py#L12281-L12458) | Message-only window, WTS, power broadcast, `WM_ENDSESSION` | logind signals + delay inhibitor (§7.2) |
| [desktop_app.py:13940-13997](../python-desktop-app/desktop_app.py#L13940-L13997) | `pystray` Win32 backend | AppIndicator backend + no-tray fallback |
| [desktop_app.py:14176-14215](../python-desktop-app/desktop_app.py#L14176-L14215) | Self-install + registry autostart at run | Skip on Linux |
| [db_connection.py:83-125](../python-desktop-app/db_connection.py#L83-L125), [587-605](../python-desktop-app/db_connection.py#L587-L605) | `LOCALAPPDATA`; key from `os.getlogin()`/`USERNAME`/hostname | XDG path; `pwd` + `/etc/machine-id` |
| [dq_nudge/popup.py:79-112](../python-desktop-app/dq_nudge/popup.py#L79-L112) | Tk `-topmost` + screen geometry | Notification-first; scaling-aware Tk |
| [ocr/engines/winrtocr_engine.py](../python-desktop-app/ocr/engines/winrtocr_engine.py) | Windows OCR | Tesseract or none |
| [ocr/auto_installer.py](../python-desktop-app/ocr/auto_installer.py), [ocr/runtime_installer.py](../python-desktop-app/ocr/runtime_installer.py) | Runtime `pip install` | Disabled; bundle at build |
| [requirements.txt](../python-desktop-app/requirements.txt) | `sqlcipher3-wheels` marked win32-only; `pywin32`, `winotify`, `winrtocr` | Remove marker; add Linux deps (`python-xlib`, `jeepney`/`dbus-next`, `PyGObject`, `secretstorage`) under `sys_platform == 'linux'` |
| [desktop_app.spec](../python-desktop-app/desktop_app.spec), [build.bat](../python-desktop-app/build.bat) | Windows one-file build | `desktop_app_linux.spec` + `build_linux.sh` in a 22.04 container, one-dir, `.deb` via `nfpm`/`dpkg-deb` |

---

## 23. Sources

- Ubuntu 26.04 / GNOME 50 X11 session removal: [gHacks: GNOME 50 releases with X11 session removed](https://www.ghacks.net/2026/03/20/gnome-50-releases-with-x11-session-support-removed-and-wayland/), [Aliteq: What breaks in Ubuntu 26.04](https://aliteq.com/gnome-50-removes-x11-ubuntu-26-04-wayland), [linuxconfig: Disable Wayland on Ubuntu 26.04](https://linuxconfig.org/how-to-disable-wayland-on-ubuntu-26-04)
- Fedora 43 / Ubuntu 25.10 dropping GNOME X11: [The Register](https://www.theregister.com/2025/06/12/ubuntu_2510_to_drop_x11/), [Phoronix](https://www.phoronix.com/news/F43-Change-Wayland-Only-GNOME), [GNOME blog: X11 Session Removal FAQ](https://blogs.gnome.org/alatiera/2025/06/23/x11-session-removal-faq/)
- RHEL 10 removing Xorg: [Red Hat blog](https://www.redhat.com/en/blog/rhel-10-plans-wayland-and-xorg-server), [RHEL 10 release notes: removed features](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/10.0_release_notes/removed-features)
- KDE Plasma 6.8 Wayland-only: [KDE Blogs: Going all-in on a Wayland future](https://blogs.kde.org/2025/11/26/going-all-in-on-a-wayland-future/), [Phoronix](https://www.phoronix.com/news/KDE-Plasma-68-Wayland-Exclusive)
- `gnome-screenshot` blocked in GNOME 49: [Arch Linux forums](https://bbs.archlinux.org/viewtopic.php?id=308445)
- Pillow ImageGrab Linux behavior: [Pillow ImageGrab docs (stable)](https://pillow.readthedocs.io/en/stable/reference/ImageGrab.html), [Pillow 10.1.0 docs](https://hugovk-pillow.readthedocs.io/en/stable/reference/ImageGrab.html), [Issue #6312: not possible on Wayland](https://github.com/python-pillow/Pillow/issues/6312), [Issue #6392: use xdg-desktop-portal](https://github.com/python-pillow/Pillow/issues/6392)
- Portal Screenshot and permissions: [XDG Desktop Portal: Screenshot](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Screenshot.html), [PR #851: Screenshot permission](https://github.com/flatpak/xdg-desktop-portal/pull/851), [Issue #649: Screenshot portal without prompt](https://github.com/flatpak/xdg-desktop-portal/issues/649), [gnome-shell #4895: remember screenshot permission](https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4895), [kiri #49: GNOME 46 rejects first non-interactive capture](https://github.com/yuxino/kiri/issues/49)
- Portal ScreenCast restore tokens: [XDG ScreenCast docs](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.impl.portal.ScreenCast.html), [PR #638: Screencast restore](https://github.com/flatpak/xdg-desktop-portal/pull/638), [xdg-desktop-portal-gnome !14: stream restoration](https://gitlab.gnome.org/GNOME/xdg-desktop-portal-gnome/-/merge_requests/14), [Issue #1371: persist mode monitor selection](https://github.com/flatpak/xdg-desktop-portal/issues/1371)
- Active window on GNOME Wayland: [window-calls extension](https://github.com/ickyicky/window-calls), [Gist: WM_CLASS/title under GNOME Wayland](https://gist.github.com/rbreaves/257c3edfa301786e66e964d7ac036269), [lnxlink discussion](https://github.com/bkbilly/lnxlink/discussions/126)
- Idle time on Wayland: [idle_time (Mutter IdleMonitor)](https://github.com/escaped/idle_time/blob/master/idle_time/__init__.py), [dbus-idle](https://pypi.org/project/dbus-idle), [ext-idle-notify-v1](https://wayland.app/protocols/ext-idle-notify-v1)
- Tray on GNOME: [pystray FAQ](https://pystray.readthedocs.io/en/latest/faq.html), [pystray usage](https://pystray.readthedocs.io/en/latest/usage.html), [AppIndicator GNOME extension](https://github.com/Finii/gnome-shell-extension-appindicator)
- AppImage and FUSE on Ubuntu 24.04: [AppImage docs: FUSE](https://docs.appimage.org/user-guide/troubleshooting/fuse.html), [AppImageKit #1337: libfuse2t64](https://github.com/AppImage/AppImageKit/issues/1337)
- Industry precedent: [Hubstaff: Screenshot capture support for Wayland](https://support.hubstaff.com/screenshot-capture-support-wayland-linux/) (GNOME ≤ 41 only; GNOME 42+ requires `gnome-screenshot`; recommends switching to Xorg)

Items marked "verify" in the text (GNOME 42 restore-token behavior, KWin ScreenShot2 restriction details, exact Pillow version adding `spectacle`, flash behavior when capturing from inside an extension) are based on documented behavior but must be confirmed on real machines in phase 0/1 before design decisions depend on them.

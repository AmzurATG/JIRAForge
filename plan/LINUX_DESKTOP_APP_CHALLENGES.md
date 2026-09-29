# Linux Desktop App — Challenges and How to Solve Them

The Linux desktop app has to be a new client. The AI server can stay as it is, because it never captures the screen. It only analyzes the screenshot record the desktop app already uploads. Today that client is a Windows program, and the hard part of a Linux port is getting a usable screenshot, and the window title that goes with it, on desktops that change every two years.

## What exists today

The desktop app lives in `JIRAForge/python-desktop-app`. It is a Python program packaged with PyInstaller (`desktop_app.spec`, `build.bat`). There is no `build.sh` and no AppImage in this tree. The Linux download plan under `JIRAForge/plan/` assumes an AppImage that has not been built.

On each tracking tick the app does four Windows-only things, then uploads a normal screenshot record:

| Step | Windows mechanism | Where |
|---|---|---|
| Screenshot of the monitor that holds the focused window | `win32gui` / `win32api` plus Pillow `ImageGrab.grab(bbox=..., all_screens=True)` | `monitor_capture.py` |
| Foreground app and window title | `GetForegroundWindow`, `GetWindowText`, process name | `desktop_app.py` `get_active_window` |
| Idle time | `GetLastInputInfo`, with `pynput` as fallback | `get_system_idle_seconds` |
| Lock screen | Foreground process is `lockapp.exe` or `logonui.exe` | `LOCK_SCREEN_APPS` |

`monitor_capture.py` says this directly: multi-monitor capture is Windows-only, and every other platform falls through to a plain `ImageGrab.grab()`. That fallback is what breaks on current Linux desktops.

Everything after the image exists is already cross-platform: OCR (`rapidocr` via ONNX Runtime), privacy redaction, SQLite, Supabase upload, and the webhook that calls the AI server. The server receives a PNG, a window title, an app name, OCR text, and timestamps. A Linux build has to produce that same record. It does not need a new analysis API.

## Why Linux screenshot capture is the major challenge

Windows gives any process the screen. `ImageGrab` on Windows reads the framebuffer. Linux desktops no longer do that, and the replacement is different on every desktop and every Ubuntu LTS.

Ubuntu ships a new desktop stack every two years and then freezes it:

| Release | Desktop | What capture code can rely on |
|---|---|---|
| 22.04 LTS (April 2022, GNOME 42) | Wayland by default. "Ubuntu on Xorg" still exists at login. | X11 capture works only if the user picked Xorg. On Wayland, the screenshot portal often asks permission on every shot. GNOME 42 never received the later "remember this app" fix (that landed in GNOME 43, which 22.04 did not get). `gnome-screenshot` is still installed. |
| 24.04 LTS (April 2024, GNOME 46) | Wayland by default. Xorg session still selectable. PipeWire 1.0. | Portal can remember a one-time "allow screenshots" grant. `gnome-screenshot` is no longer part of the default install. Fractional scaling is common, so captured pixels and OCR quality change. |
| 26.04 LTS (April 2026, GNOME 50) | GNOME on Xorg is gone. The session is Wayland only. X11 apps still run under XWayland. | Reading the X11 root window does not show native Wayland windows. You get a black image or only the XWayland windows. Capture has to go through the desktop portal or a compositor protocol. |

A method that works on 22.04 fails on 24.04, and a method that works on 24.04 fails on 26.04. The same binary also has to run on Mint (often still X11), KDE, and wlroots desktops (Sway, Hyprland, Ubuntu Budgie 26.04 on labwc). There is no single Linux screenshot API.

Wayland was built so that one application cannot read another application's pixels. GNOME's position, stated by its developers, is that a silent background capture is something the compositor will not offer. Any capture is either approved by the user or announced (a flash and sometimes a sound). That is the opposite of the Windows tracker, which takes a shot on a timer with no dialog.

The pinned library makes this worse. `requirements.txt` pins Pillow 10.1.0. On Linux, `ImageGrab.grab()` tries an X11 screenshot and, if that fails, shells out to `gnome-screenshot` or `grim`. KDE's `spectacle -b` fallback was added to Pillow in 2025, after 10.1.0. On Ubuntu 26.04 GNOME that means:

- The X11 attempt talks to XWayland and does not see the real desktop.
- `gnome-screenshot` is often not installed.
- `grim` only works on wlroots compositors, not on GNOME or KDE.

So the current passthrough in `capture_focused_monitor()` fails closed on the desktop most of the company will actually run. The function already returns `None` and the tracker continues without an image. On Linux that `None` would be the common case, and the AI server would have nothing to analyze.

Three more capture problems sit on top of the API split.

**Permission does not stick to an AppImage.** The portal remembers grants by application id, which comes from a `.desktop` file. An AppImage launched from `~/Downloads` gets a new identity every time the path or version changes, so the user is prompted again after every update. A stable install path and a fixed desktop file are required before "allow once" means anything.

**GNOME flashes the screen on every capture.** Even after permission is granted, GNOME plays the screenshot effect. A tracker that captures every few minutes will flash the display all day. That behavior is compositor policy. The app cannot turn it off. KDE and wlroots are quieter once permission exists.

**Focused-monitor capture has no Win32 equivalent.** `monitor_capture.py` finds the foreground window, rejects minimized and cloaked windows, and crops to the monitor with the largest overlap. On Wayland the portal often returns one combined image, or only the monitor the user picked in a share dialog. Per-monitor geometry has to be asked from the portal's screencast source list, from XRandR on X11, or from the compositor (`grim -o` on wlroots). Mixed DPI (a 4K display at 150% next to a 1080p display at 100%) changes buffer sizes between LTS releases, and a blurry capture produces bad OCR.

## How to solve screenshot capture

Own the capture path. Do not call Pillow's automatic Linux fallback. Keep `capture_focused_monitor()` as the only function the rest of the app calls, and put a small set of backends behind it. Pick the backend at startup from `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, and `/etc/os-release`.

**1. X11 session (Ubuntu 22.04 and 24.04 when the user chose Xorg, Mint, Xfce, MATE).** Read the framebuffer with XCB or `mss`, find the focused window with EWMH (`_NET_ACTIVE_WINDOW`), and crop to that output with XRandR. This is silent and matches today's focused-monitor behavior, including the rule that a locked or missing window skips the shot.

**2. GNOME on Wayland (Ubuntu 22.04, 24.04, and 26.04 default).** Call the XDG desktop portal screenshot interface (`org.freedesktop.portal.Screenshot`) over the session bus, with `interactive` set so the first call can store a persistent grant. Ship a real `timetracker.desktop` file with a fixed application id so the grant survives updates. On 22.04, test whether that grant is actually remembered. GNOME 42 is known to prompt every time. If it still prompts, the supported choice on 22.04 is the Xorg session, which still exists there. On 24.04 and 26.04, expect one prompt at first run and a flash on later shots. If a single screenshot call is too slow or too noisy for a timer, open one PipeWire screencast after the user picks the monitors, and sample frames from that stream. The screencast permission model also changes between portal versions, so it has to be retested on each LTS. It is not a different product design.

**3. KDE Plasma.** Use the same portal, or Plasma's background spectacle mode (`spectacle -n -b -o`). Spectacle support is why Pillow should be raised above 10.1.0 if spectacle is used as a library fallback. Prefer calling it from our own backend so a missing binary is a clear log line.

**4. wlroots (Sway, Hyprland, labwc, Ubuntu Budgie 26.04).** Use `grim -o <output>`. This path is silent when the compositor allows screencopy. It does nothing on GNOME.

**5. Nothing matched.** Return `None` and keep metadata-only tracking, which the Windows code already does. Log the session type, desktop, and portal version so support can see why.

Build and test on a matrix, not on one machine. The oldest glibc you support should be the build machine (Ubuntu 22.04), so the same binary runs on 22.04, 24.04, and 26.04. Retest capture, permission memory, multi-monitor, 125% and 150% scaling, and OCR readability in the month each new LTS is released. The next break is Ubuntu 28.04. Also keep one KDE machine and one X11 flavor (Mint or Xubuntu) in that matrix. "All Linux" in practice means this set. Tiling-window users outside wlroots stay on the skip path until a backend exists.

Install the app so the portal can name it. A `.deb` for Ubuntu and Debian does this cleanly: fixed path, desktop file, and no FUSE. An AppImage still helps other distros, but Ubuntu 24.04 does not ship `libfuse.so.2`, so a stock AppImage fails to start until `libfuse2t64` is installed, or the image is built with a FUSE-free runtime. The desktop file has to be extracted and installed even when the payload is an AppImage, or screenshot permission will not persist.

## The other challenges, and how to handle them

Screenshot pixels are only half of a useful record. The AI server matches work using the window title and the process name. On Wayland there is no standard "what window is focused?" call. `get_active_window()` returns `Unknown` as soon as `win32gui` is missing, so every Linux session would upload as one unknown window.

| Need | What works | What to ship |
|---|---|---|
| Focused window on X11 | EWMH / `_NET_ACTIVE_WINDOW` | Use this whenever `XDG_SESSION_TYPE=x11`. |
| Focused window on GNOME | No public API. Shell extensions break every GNOME major version, which is exactly the 2-year Ubuntu cycle (42, 46, 50). | A small, versioned GNOME Shell extension that exposes title and process over D-Bus. Rebuild it for each LTS. |
| Focused window on KDE | KWin script or KWin D-Bus | A KWin script installed with the package. |
| Focused window on wlroots | `swaymsg`, `hyprctl` | Read the compositor socket. |
| Cross-desktop fallback | AT-SPI accessibility bus | Use it when the compositor helper is not installed. Chrome only exposes a useful title when accessibility is on, so treat this as fallback. |

Process names need a Linux alias pass. Classification already strips `.exe`, so `chrome.exe` in the admin database can match a process named `chrome`. Real Linux names are often `google-chrome`, `microsoft-edge`, and `code`. `googlechrome` and `code` → `vscode` are already in `PROCESS_IDENTIFIER_ALIASES`. Add the names you see on Ubuntu (`google-chrome-stable`, `msedge`, `code`). URL rules and email-body redaction (`gmail`, `outlook` in the title) only work if the title lookup above succeeds. Without a title, those screenshots must be treated as title-unknown and OCR skipped for anything you cannot classify, so message bodies are not uploaded by accident.

**Idle and lock.** `GetLastInputInfo` does not exist. `pynput` starts on Wayland and then never sees global keyboard or mouse events, because the compositor blocks them. The idle clock would stay at zero and work time would run through lunch and overnight. Replace it the same way as capture: X11 idle via the XScreenSaver info, GNOME via Mutter `IdleMonitor.GetIdletime` (this D-Bus call has stayed stable across the last three LTS releases), KDE via `org.freedesktop.ScreenSaver.GetSessionIdleTime`. Lock state comes from logind `LockedHint` (`loginctl show-session`), not from `lockapp.exe`.

**Tray, notifications, autostart.** `pystray` needs an AppIndicator. GNOME does not provide one unless an extension is installed, so the icon never appears. Keep the existing window, and send notifications through the FreeDesktop notification bus. Autostart is a second `.desktop` file in `~/.config/autostart`, not the Windows Run key. The single-instance lock file in `get_app_data_dir()` already exists for non-Windows (`~/.local/share/TimeTracker`).

**OCR.** Primary engine `rapidocr` runs on Linux through ONNX Runtime. The default fallback `winrtocr` is Windows Runtime OCR and will not load. Set the Linux fallback to Tesseract from the distro package, or to a second ONNX model you bundle. Ship the ONNX files inside the package. Do not depend on the user having `tesseract-ocr` installed unless that package is a hard dependency of the `.deb`.

**Local database.** `sqlcipher3-wheels` is marked Windows-only in `requirements.txt`. The Linux build needs a Linux SQLCipher wheel, or the app falls through to plain SQLite in `db_connection.py`. Tokens already have a keyring path plus an encrypted-file fallback in `auth/secure_storage.py`. On Linux the keyring is the Secret Service (`gnome-keyring` or KWallet). The Windows 2560-byte chunking can stay. It is harmless. The encrypted file remains the fallback when no keyring daemon is running.

**Location.** Office Wi-Fi detection runs `netsh wlan show interfaces`. On Linux that is `nmcli -t -f active,ssid dev wifi`. Windows geolocation (`winsdk`) will not load. The existing IP geolocation tier already covers the fallback, so office SSID and subnet can work once `nmcli` replaces `netsh`. Precise GPS can stay absent on Linux.

**Updates.** The Windows updater is a PowerShell helper (`installer/update_service.ps1`) that replaces an `.exe`. A Linux updater has to download the new `.deb` or AppImage, replace the file while the app is stopped, and restart. The version check can keep using the existing `/api/app-version/latest?platform=linux` endpoint. That endpoint already accepts `linux`. No AI server change.

**GUI.** CustomTkinter works on Linux if Tcl/Tk is bundled. Wayland fractional scaling often paints Tk blurry or double-scaled. Check the main window, the pause popup, and the tray-less flow on 125% and 150% on 24.04 and 26.04.

**Packaging.** `desktop_app.spec` collects `winsdk` and Windows OCR libraries and is written for a single-file Windows exe. The Linux spec should exclude `win32`, `winsdk`, and `winotify`, include ONNX Runtime's Linux `.so` files, and be built on 22.04. A `.deb` is the Ubuntu deliverable. An AppImage is the "other distros" deliverable, with the FUSE issue above called out in the install note.

## What stays the same

The AI server, the Supabase screenshot webhook, and the upload payload stay as they are. The Linux app still uploads a PNG, thumbnail, window title, app name, OCR text, start and end time, and the same classification fields. If capture fails, it uploads nothing for that tick and keeps the session metadata, which is already the Windows Tier-3 behavior.

Admin classification data can stay in Windows `.exe` form. The normalizer already strips `.exe`. Linux-only process names are added as aliases on the client.

## A support line that is honest

Supported, and retested at each Ubuntu LTS:

- Ubuntu GNOME 22.04, 24.04, and 26.04, x86_64
- One X11 desktop (Linux Mint Cinnamon or Xubuntu) for the silent framebuffer path
- One KDE Plasma session

Best effort, same backends, not a release gate: Debian GNOME, Fedora GNOME, Kubuntu.

Out of scope until a backend is written: a desktop with no portal and no X11, and any environment where the user refuses the screenshot grant. On those machines the app can still track time only if a window-title source exists. It cannot invent a screenshot the compositor will not give.

## Order of work

1. Capture backends and a startup log of session type, desktop, and which backend was chosen. Prove a real PNG on 22.04 Xorg, 24.04 Wayland, and 26.04 Wayland before anything else.
2. Window title and process name for those same three sessions, plus the GNOME extension rebuilt per GNOME version.
3. Idle and lock via Mutter, KDE, and logind, so time does not run while the user is away.
4. Package a `.deb` from an Ubuntu 22.04 build, with a stable desktop file, autostart, Secret Service, RapidOCR, and a Linux SQLCipher build.
5. Point the existing Linux version endpoint at that package. The download button plan can follow. It is not the capture problem.

The two-year LTS cycle is a test obligation, not a one-time port. Each April release can remove the previous capture shortcut. The backend split above is what keeps the same app working across that break without changing the AI server.

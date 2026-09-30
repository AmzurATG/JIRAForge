# TimeTracker Linux Desktop App: How It Is Built

**Date:** 2026-09-29
**App version at time of writing:** 1.0.3 (`APP_VERSION` in `desktop_app.py:734`)
**Scope:** How the Linux build of `python-desktop-app/` is structured, which libraries and system components each feature uses, and how the app is packaged and installed.

Related: [SCREEN_CAPTURE_AND_OCR_FAILURE_ANALYSIS.md](SCREEN_CAPTURE_AND_OCR_FAILURE_ANALYSIS.md) covers the known capture and OCR problems.

---

## 1. Overview

The Linux app is the same Python codebase as the Windows app. `desktop_app.py` (~18.7k lines) plus supporting modules branch on `sys.platform` to use Linux-specific mechanisms. It runs as a **background system-tray application** that:

1. detects the active window (app name and title),
2. tracks idle and locked time,
3. captures the screen when the user switches to a productive or unknown app,
4. extracts text locally with OCR and redacts PII,
5. stores sessions locally, then uploads them in batches to Supabase and the AI server,
6. shows a local web UI (login, settings, diagnostics) at `http://localhost:51777`.

Distribution is **one `.deb` file**. It contains an **AppImage**, and the AppImage contains a **PyInstaller one-file binary**, so users need no Python installation.

```
TimeTracker_<ver>_amd64.deb
 └─ /opt/timetracker/TimeTracker.AppImage
      └─ AppRun  (sets LD_LIBRARY_PATH, GI_TYPELIB_PATH, GST_PLUGIN_SYSTEM_PATH, GDK_BACKEND)
           └─ usr/bin/TimeTracker   (PyInstaller onefile: Python + all pip deps + OCR models + spaCy model)
           └─ usr/lib/gstreamer-1.0/*.so  (bundled GStreamer plugins for screen capture)
```

---

## 2. Runtime architecture

```
                         ┌───────────────────────── TimeTracker process ─────────────────────────┐
 Main thread             │ pystray tray icon (AppIndicator/Ayatana via PyGObject → GTK main loop)│
                         │                                                                       │
 Flask thread            │ Local web UI + REST API  (Flask, flask-cors)  :51777                  │
                         │                                                                       │
 Tracking thread         │ tracking_loop() every 2 s                                             │
                         │   ├─ active window  → gdbus / AT-SPI / xdotool                        │
                         │   ├─ lock check     → gdbus ScreenSaver / loginctl                    │
                         │   ├─ classify app   → productive / non_productive / private / unknown │
                         │   └─ screen capture → monitor_capture.py (PipeWire/GStreamer, portals)│
 OCR-Worker thread       │ RapidOCR (ONNX Runtime + OpenCV) → Presidio/spaCy privacy filter      │
 Idle poll thread        │ D-Bus ScreenSaver / Mutter IdleMonitor / evdev / pynput               │
 Batch upload (5 min)    │ SQLite sessions → Supabase (supabase-py) + AI server (requests)       │
 Updater                 │ check → download .deb → extract AppImage → detached bash updater      │
                         └───────────────────────────────────────────────────────────────────────┘
```

At startup, the **capability router** (`capability_router.py`) runs `os_diagnostics.collect_os_diagnostics()`. That call probes the desktop environment, the session type (X11 or Wayland), D-Bus services, GStreamer and PipeWire, and which OCR engines are present. The router then chooses a **runtime profile** such as `linux_wayland_screencast_portal_gnome_introspect`, which fixes the capture method, the window-tracking method and the OCR engine for the whole session.

---

## 3. Features and the libraries or components behind them

### 3.1 System-tray icon

| Item | Detail |
|---|---|
| Library | **pystray 0.19.5**. Backends used: `_appindicator` (preferred) and `_xorg` (fallback) |
| System bindings | **PyGObject (`gi`)** + **AyatanaAppIndicator3** (StatusNotifierItem over D-Bus). `AppIndicator3` is the fallback |
| Image | **Pillow**, which draws the coloured status icons (`ImageDraw`) |
| Code | `_bootstrap_linux_tray_backend()` at the top of `desktop_app.py` (lines ~32-200). It adds the distro's `dist-packages` to `sys.path` so the system `gi` can be imported, and chooses `PYSTRAY_BACKEND`. There is a Wayland safety net at `desktop_app.py:296-335` |
| PyInstaller hook | `pyinstaller_hooks/pyi_rth_pystray_wayland.py` puts system `gi` on `sys.path` and forces the `appindicator` backend before `import pystray` |
| GNOME requirement | GNOME needs the **AppIndicator shell extension** (`gnome-shell-extension-appindicator`) to show tray icons. `_try_enable_gnome_appindicator_extension()` (`desktop_app.py:1457`) enables it at first launch with `gnome-extensions` / `org.gnome.Shell.Extensions.EnableExtension` |
| Thread safety | `_safe_update_tray_icon()` routes icon updates to the GLib main loop with `GLib.idle_add` |

`python3-gi` and `gir1.2-ayatanaappindicator3-0.1` are **not** bundled in the binary. They are hard `Depends:` of the `.deb` and are loaded from the system at runtime.

### 3.2 Active-window detection (app name and window title)

Implemented in `_get_active_window_linux()` (`desktop_app.py:11964`). Several methods are tried in an order that depends on the session. A circuit breaker skips methods that have failed 3 or more times.

| Method | Mechanism | Used for |
|---|---|---|
| `gnome_introspect` / `gnome_introspect_v2` | `gdbus call` → `org.gnome.Shell.Introspect.GetWindows`, then the window with `has-focus: true` is picked. v2 has longer timeouts and parsing for GNOME 45–49 | **Primary on GNOME Wayland** |
| `atspi` / `atspi_v2` | AT-SPI2 accessibility bus (`org.a11y.Bus`). It runs a **system `python3` subprocess** with `gi.repository.Atspi`, because in-process AT-SPI from a background thread crashed the GTK loop | Wayland fallback and non-GNOME desktops |
| `gdbus` | `org.gnome.Shell.Eval`. It only works when GNOME development tools / unsafe mode are enabled, so it is disabled by default on GNOME 45+ | Legacy GNOME |
| `xdotool` | `xdotool getactivewindow getwindowname` + `getwindowpid`, with the process name taken from **psutil** | **Primary on X11**. On Wayland it only sees XWayland apps |

Libraries and tools: **subprocess** + `gdbus` (glib2 tools), **xdotool** (a system package, not bundled), **psutil 5.9.6**, and the system **PyGObject/AT-SPI** through `python3`.

### 3.3 Idle detection

`_detect_idle_backend()` (`desktop_app.py:13415`) picks the first backend that works:

| Tier | Backend | Mechanism |
|---|---|---|
| 1 | `dbus_screensaver` | `org.freedesktop.ScreenSaver.GetSessionIdleTime` over **dbus-python** |
| 2 | `gnome_mutter` | `org.gnome.Mutter.IdleMonitor.GetIdletime` (Wayland-native on GNOME) |
| 3 | `evdev` | Reads `/dev/input/event*` directly (only when the user can read those devices) |
| 4 | `pynput` | **pynput 1.7.6** keyboard and mouse hooks (X11/XWayland; unreliable on Wayland) |

Idle periods create "idle records" (`_create_idle_record`), and the app resumes on activity (`resume_from_idle`). `IDLE_DETECTION_GUIDE.md` has more detail.

### 3.4 Screen-lock detection

`_is_screen_locked()` (`desktop_app.py:11872`), cached for 5 s. It tries these in order: `org.gnome.ScreenSaver.GetActive` → `org.kde.screensaver.GetActive` → `org.freedesktop.ScreenSaver.GetActive` → `loginctl show-session --property=LockedHint`. Tracking and capture are skipped while the screen is locked.

### 3.5 Screen capture

Module: `monitor_capture.py`. On Linux, `capture_focused_monitor()` delegates to `_capture_linux()`, which walks this chain (the capability router picks the first entry):

| Order | Method | Libraries / system components |
|---|---|---|
| 1 | **ScreenCast portal** (no flash, one-time consent) | **PyGObject** `Gio` D-Bus → `org.freedesktop.portal.ScreenCast` (CreateSession → SelectSources → Start → OpenPipeWireRemote). One frame is taken via **GStreamer** (`Gst`): `pipewiresrc ! videoconvert ! pngenc ! filesink`. Needs **PipeWire**, **WirePlumber**, **xdg-desktop-portal(-gnome)** and **gstreamer1.0-pipewire** |
| 2 | Screenshot portal | `org.freedesktop.portal.Screenshot` via `Gio` |
| 3 | GNOME Shell D-Bus | `gdbus` → `org.gnome.Shell.Screenshot` with `flash=false` |
| 4 | `gnome-screenshot` CLI | Shutter sound is muted by temporarily setting `gsettings org.gnome.desktop.sound event-sounds false` |
| 5 | `scrot` | X11 |
| 6 | Pillow `ImageGrab` (XCB) | X11 |

Supporting pieces:

- The ScreenCast **restore token** is stored in `~/.config/timetracker/screencast_restore_token.json`.
- Permission onboarding (`_onboard_screencast_permission`) and a **"Fix Screen Capture"** web page (`/screencast-fix`, `/api/screencast-check`, `/api/grant-screencast-permission`).
- `scripts/fix-screenshot-capture.sh` installs the PipeWire/GStreamer packages on Ubuntu/Debian, Fedora and Arch.
- A small GNOME Shell extension, `disable-screenshot-flash@timetracker`, is shipped in the `.deb` to suppress the capture flash on GNOME Wayland.
- `diagnose_screencast.py`, `os_diagnostics.py` and `system_check.py` are diagnostics.

The app captures only screens for apps classified as `productive` or `unknown`. Screens for `private` and `non_productive` apps are never captured.

### 3.6 OCR (text extraction)

Package: `ocr/` (facade pattern, `ocr/facade.py`).

| Item | Detail |
|---|---|
| Primary engine on Linux | **RapidOCR** (`rapidocr_onnxruntime`): PaddleOCR PP-OCR models running on **ONNX Runtime** (CPU) |
| Image processing | **OpenCV** (`opencv-python-headless 4.10.0.84`), **NumPy 1.26.4**, **Pillow** |
| Fallbacks | `winrtocr` is filtered out on Linux (`ocr/config.py`), and `easyocr` (**EasyOCR** + **PyTorch**) and `tesseract` are injected. These are only used when installed; the Linux build normally excludes torch |
| Engine discovery | `ocr/engine_factory.py` scans `ocr/engines/*_engine.py`. `ocr/engines/dynamic_engine.py` allows extra engines configured through `OCR_*` env vars |
| Configuration | `OCR_PRIMARY_ENGINE`, `OCR_FALLBACK_ENGINES`, `OCR_<ENGINE>_MIN_CONFIDENCE`. The AI server can override these at runtime (`set_runtime_ocr_config`) |
| Threading | A single `OCR-Worker` thread (`LocalOCRProcessor`) with a 1-slot queue and a 10 s throttle. Throttled screenshots are backfilled at batch time |
| Packaging | `pyinstaller_hooks/hook-cv2.py`, `pyi_rth_cv2.py` and `pyi_rth_onnxruntime.py` make cv2 and onnxruntime load correctly inside the onefile bundle. The `.spec` includes or excludes engines based on the configured engines |

### 3.7 Privacy / PII redaction

Package: `privacy/`. All OCR text and window titles pass through it before leaving the machine.

- **Microsoft Presidio** (`presidio-analyzer`, `presidio-anonymizer`) detects PII.
- **spaCy** + **thinc** with the **`en_core_web_sm`** model provide name and address recognition. The model is bundled into the binary by the `.spec`.
- Regex detectors cover secrets (API keys, passwords in URLs, private keys).
- `ocr/tabular_enricher.py` adds column context for spreadsheets.

### 3.8 Local storage (offline-first)

| Item | Detail |
|---|---|
| Module | `db_connection.py` |
| Library | Python **`sqlite3`**. If **`sqlcipher3`** is importable, the DB is encrypted with `PRAGMA key`, and plaintext DBs are migrated with `sqlcipher_export` |
| Linux note | `sqlcipher3-wheels` is declared only for `win32` in `requirements.txt`, so **Linux builds normally use plain SQLite** unless sqlcipher3 is installed in the build environment |
| Contents | `active_sessions`, pending uploads, and offline screenshots that sync when the network returns |

### 3.9 Credentials and secure token storage

| Item | Detail |
|---|---|
| Module | `auth/secure_storage.py`; helpers `_keyring_set/_get/_delete` in `desktop_app.py:3120-3230` |
| Primary | **keyring 25.2.1** → **Secret Service** API (GNOME Keyring / KWallet over D-Bus). Tokens are base64-encoded and chunked (≤2000 bytes per entry) |
| Fallback | An encrypted file using **cryptography 41.0.7** `Fernet`, with the key derived by PBKDF2-HMAC-SHA256 (600k iterations) from machine and user identifiers. It is used automatically when no keyring backend is available (headless or minimal desktops) |
| Stored | `access_token`, `refresh_token`, `supabase_token`, `google_refresh_token` |

### 3.10 Authentication and backend communication

- **Atlassian OAuth**: `AtlassianAuthManager` opens `http://localhost:51777/login` in the default browser (`webbrowser`). The OAuth callback returns to the local Flask server.
- **requests 2.31.0** is used for calls to the AI server (`AI_SERVER_URL`, production `forgesync.amzur.com`). That covers config fetch, activity upload, update checks and OCR diagnostics.
- **supabase 2.0.0** (`supabase-py`) is used for DB and storage writes with a custom JWT (RLS-scoped).
- **python-dotenv** loads `.env` in dev builds. Release builds embed their configuration (see `build.sh` step 2/5).
- **tzlocal** is used for local timezone handling.

### 3.11 Local web UI

- **Flask 3.0.0** + **flask-cors 4.0.0**, created at `desktop_app.py:7084` and served on port **51777** (`WEB_PORT`).
- It provides login, settings, the app-classification page, captured screenshots, diagnostics (`/api/capture-health`), and the screencast fix page.

### 3.12 Notifications and pop-ups

- **Desktop notifications**: `_linux_notify()` (`desktop_app.py:708`) calls **`notify-send`** (`libnotify-bin`, a Recommends of the `.deb`).
- **Pause / resume pop-up**: **tkinter** (`ttk`), when available.
- **Update prompt**: `show_update_notification()`, via notification plus the web UI.

### 3.13 Autostart on login

`add_to_linux_autostart()` (`desktop_app.py:3047`) writes an **XDG autostart** entry at `~/.config/autostart/timetracker.desktop` that points to the installed AppImage. No systemd unit is used.

### 3.14 Single-instance guard and shutdown

- **Single instance**: a PID lock file `.lock` in the app data dir. Stale locks are detected with **psutil** (`acquire_single_instance_lock`, `desktop_app.py:589`).
- **Graceful shutdown**: a **`SIGTERM` handler** (`signal`) runs `_shutdown_cleanup()` on logout, `systemctl` stop or `pkill`, so open sessions and idle records are flushed.

### 3.15 Auto-update

1. `check_for_updates()` (`desktop_app.py:943`) asks the AI server for the latest version, download URL and SHA-256 checksum.
2. The app downloads the `.deb` and verifies the checksum.
3. `_extract_appimage_from_deb()` (`desktop_app.py:2064`) parses the `ar` archive in **pure Python** and decompresses `data.tar.{xz,gz,zst}`. It uses **zstandard** for Ubuntu 24.04+ zstd-compressed debs. No root and no `dpkg` are needed.
4. `apply_update()` writes a bash updater script and launches it detached (`start_new_session=True`). The script waits for the app to exit, replaces `~/.local/share/TimeTracker/TimeTracker.AppImage`, and restarts it.

Because the update lands in the **user's home directory**, updates never need `sudo`. The `/usr/local/bin/timetracker` wrapper always prefers that copy.

### 3.16 Logging and diagnostics

- `app_logger.py` / `secure_logger.py` write a rotating log file with PII redaction, under `~/.local/share/TimeTracker/logs/`.
- `send_ocr_diagnostics()` sends OCR engine health to the AI server.
- `check_platform_compatibility.py`, `os_diagnostics.py`, `system_check.py` and `diagnose_wayland()` are support tools.

---

## 4. Library reference

### 4.1 Python packages (bundled in the binary)

| Package | Version | Used for |
|---|---|---|
| flask | 3.0.0 | Local web UI / API |
| flask-cors | 4.0.0 | CORS for the local UI |
| supabase | 2.0.0 | Database and storage uploads |
| requests | 2.31.0 | AI-server HTTP calls, update download |
| pystray | 0.19.5 | System-tray icon |
| Pillow | 10.1.0 | Image handling, tray icons, `ImageGrab` fallback |
| psutil | 5.9.6 | Process names, single-instance check |
| pynput | 1.7.6 | Idle detection fallback (X11) |
| keyring | 25.2.1 | Secret Service token storage |
| cryptography | 41.0.7 | Encrypted-file token fallback (Fernet/PBKDF2) |
| python-dotenv | 1.0.0 | `.env` loading (dev) |
| tzlocal | ≥5.0 | Local timezone |
| jaraco.text / .functools / .context | ≥4 / ≥4 / ≥6 | keyring runtime deps (pinned for PyInstaller) |
| zstandard | ≥0.21.0 (Linux only) | Decompress zstd `.deb` during auto-update |
| rapidocr_onnxruntime | latest | OCR engine (PP-OCR models) |
| onnxruntime | (dep of rapidocr) | Model inference |
| opencv-python-headless | 4.10.0.84 | Image ops for OCR |
| numpy | 1.26.4 | Image arrays |
| presidio-analyzer / presidio-anonymizer | ≥2.2.0 | PII detection and masking |
| spacy / thinc + `en_core_web_sm` | ≥3.0 / ≥8.1 | NER for Presidio |
| easyocr (+ torch) | ≥1.7.0 | Optional OCR fallback (normally excluded from Linux builds) |
| pyinstaller | 6.2.0 | Build only |

Standard library modules with a Linux-specific role: `subprocess` (gdbus/xdotool/loginctl/notify-send), `signal`, `sqlite3`, `tkinter`, `webbrowser`, `tarfile`/`struct` (deb parsing).

### 4.2 System libraries used at runtime (from the OS, not pip)

| Component | Package (Ubuntu) | Used for | `.deb` relation |
|---|---|---|---|
| PyGObject | `python3-gi` | GTK/GLib, Gio D-Bus, GStreamer, AT-SPI bindings | **Depends** |
| Ayatana AppIndicator | `gir1.2-ayatanaappindicator3-0.1` (or `gir1.2-appindicator3-0.1`) | Tray icon | **Depends** |
| AppIndicator GNOME extension | `gnome-shell-extension-appindicator` | Show tray on GNOME | Recommends |
| libnotify | `libnotify-bin` | `notify-send` | Recommends |
| PipeWire + WirePlumber | `pipewire`, `wireplumber` | ScreenCast stream | Recommends + postinst auto-install |
| GStreamer | `gstreamer1.0-plugins-base/-good`, `gstreamer1.0-tools`, **`gstreamer1.0-pipewire`** | Grab a frame from PipeWire | Recommends + postinst auto-install (some plugins are also bundled in the AppImage) |
| XDG Desktop Portal | `xdg-desktop-portal`, `xdg-desktop-portal-gnome` / `-gtk` | ScreenCast and Screenshot portals | Recommends + postinst auto-install |
| xdotool | `xdotool` | X11 window detection | Not declared |
| gnome-screenshot / scrot | same | Capture fallbacks | Not declared |
| AT-SPI2 | `at-spi2-core`, `gir1.2-atspi-2.0` | Window detection fallback | Not declared |
| dbus-python | `python3-dbus` | Idle detection over D-Bus | Not declared |
| tkinter | `python3-tk` (bundled by PyInstaller if present at build) | Pause pop-up | — |

### 4.3 D-Bus interfaces the app talks to

| Interface | Purpose |
|---|---|
| `org.gnome.Shell.Introspect` | Focused window (GNOME Wayland) |
| `org.gnome.Shell` (`Eval`, `Screenshot`, `Extensions`) | Legacy window query, screenshot, enable extensions |
| `org.a11y.Bus` | AT-SPI2 accessibility bus address |
| `org.freedesktop.portal.ScreenCast` / `.Screenshot` / `.Request` | Wayland screen capture |
| `org.gnome.Mutter.IdleMonitor` | Idle time (GNOME) |
| `org.freedesktop.ScreenSaver`, `org.gnome.ScreenSaver`, `org.kde.screensaver` | Idle time and lock state |
| `org.freedesktop.secrets` (through keyring) | Token storage |
| `org.kde.StatusNotifierWatcher` (through AyatanaAppIndicator) | Tray icon |

---

## 5. Build and packaging pipeline

Entry point: **`build.sh`**, run from `python-desktop-app/` on an Ubuntu build machine.

| Step | What happens |
|---|---|
| Pre-checks | Detects `python3`, activates `.venv`/`venv`, installs PyInstaller if missing, and makes sure `platformdirs`, `tzlocal` and a *real* `cv2` extension (swapping to `opencv-python-headless`) are present. Downloads `en_core_web_sm` if missing |
| **[0/5]** Tray validation | Checks that system `gi` + AppIndicator typelibs work (using the system `dist-packages`) |
| **[1/5]** Clean | Removes previous `build/` and `dist/` |
| **[2/5]** Config validation | Verifies the embedded runtime configuration in `desktop_app.py` (release builds need no `.env`) |
| **[3/5]** PyInstaller | `pyinstaller --clean desktop_app.spec` → `dist/TimeTracker` (onefile). The `.spec` (723 lines) chooses OCR engines from `.env`, collects `rapidocr_onnxruntime`/`onnxruntime` data and shared libs, NumPy libs, Presidio/spaCy data and the `en_core_web_sm` model, and hidden imports (`ocr`, `privacy`, `supabase`, `keyring`, `pynput`, all `pystray` backends). It adds runtime hooks `pyi_rth_cv2.py`, `pyi_rth_pystray_wayland.py` and `pyi_rth_onnxruntime.py`, and excludes `paddle`, `torch` and `winrtocr`. Output is logged to `build_log.txt` |
| **[4/5]** AppImage | Builds an `AppDir` (`AppRun`, `.desktop`, 256 px icon, `usr/bin/TimeTracker`). It **bundles GStreamer plugins** (`libgstpipewiresrc`, `videoconvert`, `pngenc`, `coreelements`, `app`, …) and core libs (`libgstreamer`, `libgstbase`, `libgstvideo`, `libgstapp`). It then downloads `appimagetool` if needed → `dist/TimeTracker-v<ver>-<arch>.AppImage` |
| **[5/5]** .deb | Creates the package tree, writes `DEBIAN/control` (Depends/Recommends above), `postinst` and `prerm`, and runs `dpkg-deb -Zxz --build --root-owner-group` → `dist/<pkg>.deb` (amd64 / arm64 / armhf) |

### 5.1 What `AppRun` sets up

- `LD_LIBRARY_PATH`: bundled `usr/lib` first.
- `GI_TYPELIB_PATH`: the Ayatana typelib dir first, so the SNI tray is chosen over XEmbed.
- `GST_PLUGIN_SYSTEM_PATH`: bundled plugins, then system plugins (where `pipewiresrc` usually lives).
- `GDK_BACKEND=x11` on Wayland, for libappindicator3 compatibility.
- Then `exec usr/bin/TimeTracker`.

### 5.2 What the `.deb` installs and does

| Path | Content |
|---|---|
| `/opt/timetracker/TimeTracker.AppImage` | The app |
| `/usr/local/bin/timetracker` | Wrapper: runs `~/.local/share/TimeTracker/TimeTracker.AppImage` if present (auto-updated copy), else `/opt/…`; sets `APPIMAGE_EXTRACT_AND_RUN=1` so **FUSE is not required** |
| `/usr/share/applications/…desktop`, `/usr/share/icons/hicolor/256x256/apps/timetracker.png` | Launcher and icon |
| `/usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/` | Flash-suppression extension, copied per user by postinst |

`postinst`:

1. Auto-installs missing capture packages (PipeWire, WirePlumber, GStreamer base/good/pipewire, xdg-desktop-portal(-gnome)) using `pkexec`, falling back to `sudo`. Graphical installers skip Recommends, which is why this step exists.
2. For every user, copies the AppImage to `~/.local/share/TimeTracker/`, creates the `logs/` and `updates/` dirs, and writes a per-user `.desktop` entry with the absolute path.
3. Installs the flash extension per user, with an autostart entry that enables it at the next GNOME login.
4. Sets **GDebi** as the default `.deb` handler, so later upgrades show an *Upgrade* button.
5. Refreshes desktop and icon caches (`update-desktop-database`).

The AppIndicator extension is **not** enabled in postinst, because there is no GNOME Shell D-Bus session during `dpkg`. The app enables it on first launch.

`prerm` stops running instances (SIGTERM first) before files are replaced, to avoid "text file busy" or FUSE lock errors.

### 5.3 Files on a user's machine

| Path | Purpose |
|---|---|
| `~/.local/share/TimeTracker/TimeTracker.AppImage` | Canonical (auto-updatable) binary |
| `~/.local/share/TimeTracker/logs/` | Log files |
| `~/.local/share/TimeTracker/updates/` | Downloaded updates, `update_launcher.log` |
| `~/.local/share/TimeTracker/…` (app data dir) | Local SQLite DB, `.lock`, encrypted token fallback |
| `~/.config/timetracker/screencast_restore_token.json` | ScreenCast permission token |
| `~/.config/autostart/timetracker.desktop` | Launch on login |
| GNOME Keyring (`TimeTracker` service) | OAuth / Supabase tokens |

---

## 6. Development workflow

```bash
cd python-desktop-app
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python -m spacy download en_core_web_sm
sudo apt install python3-gi gir1.2-ayatanaappindicator3-0.1 xdotool libnotify-bin \
     gstreamer1.0-pipewire gstreamer1.0-plugins-good xdg-desktop-portal-gnome
cp .env.example .env
python desktop_app.py          # run from source
./run_tests.sh                 # tests (pytest under tests/)
./build.sh                     # produce AppImage + .deb in dist/
```

Useful diagnostics: `python capability_router.py` (prints the capability signature and the selected runtime profile), `python diagnose_screencast.py`, and `python system_check.py`.

---

## 7. Notes and caveats for maintainers

- **Build machine dependence.** The flash extension is copied from the builder's `~/.local/share/gnome-shell/extensions/…`, and a minimal one is generated inline if it is missing (`build.sh:471`). GStreamer plugins are copied from the build machine's system dirs. Builds are therefore only reproducible on a similar Ubuntu setup.
- **System `gi` is required at runtime.** The tray, portal capture, GStreamer and AT-SPI all rely on the distro's PyGObject rather than a bundled copy. Distros without `python3-gi` fall back to the `xorg` tray backend and lose Wayland capture.
- **Declared dependencies are incomplete.** `xdotool`, `python3-dbus`, AT-SPI bindings and `gnome-screenshot` are used but not declared in the `.deb`.
- **Linux DB encryption.** SQLCipher is Windows-only in `requirements.txt`, so the local DB on Linux is usually unencrypted.
- **Desktop coverage.** The best-supported setup is GNOME on Wayland/X11 (Ubuntu 22.04/24.04). KDE, XFCE and wlroots compositors work through the portal, AT-SPI and freedesktop fallbacks with reduced fidelity.
- Known capture and OCR issues are documented in [SCREEN_CAPTURE_AND_OCR_FAILURE_ANALYSIS.md](SCREEN_CAPTURE_AND_OCR_FAILURE_ANALYSIS.md).

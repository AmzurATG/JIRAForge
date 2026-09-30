# Linux Desktop App: Implementation Plan

**Date:** 2026-09-29
**Component:** `linux-desktop-app/` (new), with small seams in `python-desktop-app/`
**Status:** Spec / plan. No code written yet. Per the spec-driven workflow, this must be agreed before tests and code.
**No change to:** `ai-server/`, `supabase/`, `forge-app/`. Only a new `app_releases` row with `platform = 'linux'`, which the version endpoint already accepts.

**Inputs reviewed for this plan:**

| Document | What it contributed |
|---|---|
| `docs/LINUX_DESKTOP_APP_ARCHITECTURE.md` | How the **old** Linux build worked (AppImage inside `.deb`, portal-first capture, system `gi`, AT-SPI, pystray AppIndicator) |
| `docs/SCREEN_CAPTURE_AND_OCR_FAILURE_ANALYSIS.md` | Why the old build failed: 8 capture root causes (C-1…C-8), 6 OCR root causes (O-1…O-6) |
| `plan/LINUX_DESKTOP_APP_CHALLENGES.md` | First challenges write-up (partly superseded) |
| `docs/LINUX_DESKTOP_APP_PORT_GUIDE.md` | Full port analysis: Windows-only code inventory, LTS timeline, support matrix |
| `plan/2026-09-29_python-desktop-app_linux-screen-capture.md` | Detailed capture design (backends, validator, GNOME extension, KWin, portal) |
| `python-desktop-app/` source | Current seams: `monitor_capture.py`, `desktop_app.py` (17k lines), `ocr/`, `auth/`, `db_connection.py` |

This plan does not repeat every detail of those documents. It turns them into one buildable design, adds the lessons from the old app's failures, and fixes the decisions that were left open.

---

## Implementation status (updated 2026-09-29)

All phases are implemented. The table separates what was verified on real software from what still needs the manual matrix (§11), because this work was done on one Ubuntu 24.04 GNOME 46 Wayland machine with no container runtime.

| Phase | Spec | Verified here | Still needs real-machine checks |
|---|---|---|---|
| 1a Foundation | [phase1-foundation](2026-09-29_linux-desktop-app_phase1-foundation.md) | Unit tests; `--doctor` live on GNOME 46 | — |
| 1b Core seams + services | [phase1b](2026-09-29_linux-desktop-app_phase1b-core-seams-and-services.md) | Core suite before/after identical (352 pass / 51 fail both); live Mutter idle, logind lock, notification caps; tray marshalling on the real session bus | X11 desktops (Mint, Xfce): EWMH and XShm, used only through fixtures here |
| 2 X11 + build | this plan §6.14 | Local PyInstaller one-dir build; frozen `--self-test` (RapidOCR, spaCy/Presidio, SQLCipher) passes; frozen `--doctor`; `.deb`/`.rpm` built with nfpm; tarball `--user` install/self-test/uninstall | glibc 2.28 container build and the multi-distro smoke tests (need Docker/Podman: CI job `packages`) |
| 3 GNOME extension | §7 | Real headless GNOME Shell 46: 19/19 checks (focus, pid, monitor capture, non-black frame, rate limit, caller rejection, lock/unlock) | GNOME 42 legacy build, GNOME 49/50, the "no flash / no sound" check on a visible screen |
| 4 Helper + portal + AT-SPI | §6.4.5 | Helper on system Python + GStreamer test source; fake-portal protocol test (C-1/C-2 regressions); frozen app → helper → AT-SPI returned the focused app | Real portal dialog + restore token on GNOME/KDE; NVIDIA DMA-BUF |
| 5 KDE + wlroots | §6.3, §6.4.3–4, §6.6 | Unit tests incl. an 8 MB pipe frame; Wayland wire client against the real compositor (registry) and a fake ext-idle-notify compositor | Plasma 5/6 (KWin script, ScreenShot2 authorization), Sway/Hyprland |
| 6 Updates, UI, hardening | §6.11–6.15, §8.2 | Update notice; Settings status card; consent paragraph; "Remove my data" (Origin-guarded); CI workflow | Signed APT/YUM repo hosting; upgrade relaunch in postinst |
| Shared OCR fixes | [python-desktop-app/plan/…ocr-pipeline-reliability](../../python-desktop-app/plan/2026-09-29_python-desktop-app_ocr-pipeline-reliability.md) | 15 tests; core suite unchanged | Measure OCR loss rate on a real day of logs |

### Decisions changed during implementation

| Plan said | Built instead | Why |
|---|---|---|
| Tray via the session helper (system `gi` + AppIndicator) | Pure-Python StatusNotifierItem + dbusmenu in the main process (`compat/tray_sni.py`), registered as `pystray.Icon` | No GTK or system `gi` needed for the tray; the core tray code is unchanged; tested on the real bus. The helper now only does ScreenCast and AT-SPI. |
| `ext-idle-notify` via `pywayland` | A ~150-line pure-Python Wayland wire client (`wayland_idle.py`) | pywayland needs compiling against Wayland headers; the protocol subset needed is tiny. |
| Notifications via a `notify()` helper at 29 call sites | A `winotify`-compatible module over `org.freedesktop.Notifications`, registered by the launcher | No change to any call site. |
| O-1: re-queue skipped backfill screenshots | A 20 s time budget, newest first | The sessions are harvested right after the backfill, so re-queued results would have no row to land in. |
| §6.4.7 scale normalization | Not built | Per-monitor capture plus the core's 1920 px cap already gives 100%-equivalent text at 150% and 200%. Revisit after the AC 20 measurement. |
| GNOME extension rate limit 5 s | 2 s | 5 s dropped legitimate captures on quick switches. Caller authentication is the real guard. |
| Focus signal broadcast | Unicast to the authenticated client (`Subscribe`) | Broadcasting would expose window titles to every process on the session bus. |

### Finding outside this scope

The local web server enables CORS for every origin (`CORS(self.app)` in `desktop_app.py`), on Windows too. Any website open in the user's browser can call the local API and read its responses. The new Linux endpoints are protected by an `Origin` check; the existing endpoints need a separate security review.

---

## 1. Problem

The product needs a Linux desktop client that produces the same `activity_records` rows as the Windows client (window title, app name, redacted OCR text, timings, idle records, classification). Today:

1. **The current app does not run properly on Linux.** When `win32gui` is missing, it quietly degrades instead of failing:
   - `get_active_window()` returns `Unknown` forever ([desktop_app.py:11357-11360](../../python-desktop-app/desktop_app.py#L11357-L11360)), so no window switch is ever detected.
   - `capture_focused_monitor()` calls a bare `ImageGrab.grab()` ([monitor_capture.py:349-354](../../python-desktop-app/monitor_capture.py#L349-L354)). On X11 that captures **all monitors**, which breaks the P0-2 privacy rule. On Wayland it returns a black image without an error.
   - Idle uses `ctypes.windll`, which does not exist, so it falls back to `pynput`. On Wayland `pynput` sees no input from native apps, and **working users are marked idle**.
   - Lock, sleep and shutdown detection use a Win32 message window, so none of them work.
   - Notifications use `winotify`, so every notification is silently dropped.
   - The fallback DB/token key uses `os.getlogin()` + `USERNAME` + hostname ([db_connection.py:116-119](../../python-desktop-app/db_connection.py#L116-L119), [auth/secure_storage.py:616-633](../../python-desktop-app/auth/secure_storage.py#L616-L633)). On a Linux autostart launch there is no terminal and no `USERNAME`, so the key changes between launches and the database can become unreadable.
2. **The old Linux build (v1.0.3) was released and did not work reliably.** Screen capture hung, prompted on every start, leaked file descriptors, sent black frames to OCR, and captured the wrong monitor. OCR results were then lost in the pipeline. The details are in §3.
3. **"Linux" is not one platform.** Capture, focused-window lookup and idle time work differently on X11, GNOME Wayland, KDE Wayland and wlroots. Each Ubuntu LTS (22.04 → 24.04 → 26.04) removed another shortcut. Ubuntu 26.04 and Fedora 43 have no X11 session at all, and KDE Plasma 6.8 is Wayland-only.

## 2. Goal and what "works on all Linux systems" means

There is no single Linux screenshot, window or idle API. "Works on all Linux systems" therefore means the following, and this is the promise the team makes to customers:

1. **Every desktop family has a working, silent path.** GNOME, KDE Plasma, X11 desktops (Cinnamon, Xfce, MATE, …) and wlroots compositors (Sway, Hyprland, labwc, …) each get their own backend for capture, window info and idle.
2. **Every other desktop uses a standard fallback.** The XDG portal (ScreenCast), AT-SPI and logind are available on almost every modern distribution.
3. **When nothing works, the app says so and still tracks correctly.** It records title and time with empty OCR, shows the reason in Settings and the tray, and sends it in diagnostics. It never uploads "Unknown" sessions, black-frame OCR, or all-monitor OCR.
4. **One binary runs on every mainstream distribution from about 2020 onward.** It is built against glibc 2.28 (§8.14): Ubuntu 20.04+, Debian 11+, Linux Mint 20+, Pop!_OS, Fedora 36+, RHEL/Alma/Rocky 8+, openSUSE Leap 15.4+/Tumbleweed, Arch/Manjaro.
5. **Native packages for the three package families**, plus a tarball for the rest: `.deb`, `.rpm`, and `.tar.gz` with `install.sh`.
6. **Capabilities are detected at runtime, never assumed from the distribution name.** Detection is repeated when something fails (fixes old C-6).
7. **A named, tested support matrix** (§11) and a retest at every GNOME release and every Ubuntu LTS. "All Linux" is kept true by testing, not by a one-time port.

---

## 3. Lessons from the old Linux app, turned into design rules

Each failure in the old build becomes a rule this implementation must follow. Tests in §10 check these rules.

### 3.1 Capture failures (from `SCREEN_CAPTURE_AND_OCR_FAILURE_ANALYSIS.md`)

| Old issue | What went wrong | Rule for the new app |
|---|---|---|
| **C-1** GLib context misuse | Portal callbacks were attached to the global default GLib context, but the waiting loop ran on a private context. Capture only worked while the tray happened to run the default loop, and otherwise hung the tracking thread forever. | **No GLib in the main process.** Everything that needs a GLib main loop (GStreamer/PipeWire, AT-SPI, AppIndicator tray) runs in a separate **session helper process** whose main thread owns its main loop (§5.3). The main process talks D-Bus with pure-Python `jeepney`. Signal subscriptions happen **before** the method call (compute the request path from `handle_token`), and cleanup happens in `finally`. |
| **C-2** Consent dialog on every start | `persist_mode` and `restore_token` were sent to `CreateSession` instead of `SelectSources`, so no token was ever issued. | `persist_mode=2` and `restore_token` go into **`SelectSources`**. The new token from **every** `Start` is saved (tokens are single-use). `session_handle` is never persisted, because it dies with the D-Bus connection. A unit test asserts the option placement. |
| **C-3** 3 s per capture, fd leak | A new PipeWire fd and pipeline per capture, a fixed 3 s recording, and the fd was never closed. Capture broke after hours with "Too many open files". | **One long-lived stream** per session with `appsink max-buffers=1 drop=true`. A capture copies the latest frame (< 50 ms). The fd is owned by the helper and closed exactly once. A soak test checks that the fd count is flat after 2,000 captures. |
| **C-4** Black frames reach OCR | The black check was fooled by RGBA alpha and by one bright pixel. The XCB fallback had no check at all. | **One `FrameValidator` on every backend** (§6.5). It uses grayscale statistics, ignores alpha, and counts bad frames as failures. |
| **C-5** Wrong monitor, text too small | Whole desktop or a fixed monitor was captured, then downscaled to 1920 px. | Capture **only the monitor with the focused window**, cropped by the compositor. Downscale by the monitor scale factor, never below 100%-equivalent text size. If the focused monitor is unknown, **skip**. |
| **C-6** Capabilities frozen at first use | Autostart ran before the portal and PipeWire were ready, and capture stayed disabled until restart. A router exception disabled capture permanently. | Capabilities are re-probed after N failures and every 30 min, and on the logind `Unlock` / resume signals. An exception in selection falls back to the next backend, never to "disabled for the session". |
| **C-7** Capture blocks tracking, text from wrong window | Capture ran synchronously for 3–80 s in the tracking thread. | Capture runs in a dedicated **capture service thread** with a hard **1.5 s budget** per request. Each frame carries the focused window's id and title **at capture time**. If that does not match the session it is meant for, the frame is discarded. |
| **C-8** Alerting broken | The health check was dead code. The notification fired on every failure. | One de-duplicated "screen text capture unavailable: <reason>" notification, at most once per day, plus a status line in Settings, the tray and diagnostics. |

### 3.2 OCR failures (these exist in the **current** shared code too)

| Old issue | Current code | Fix (shared core, so Windows benefits too) |
|---|---|---|
| **O-1** Backfill silently drops all but 3 throttled screenshots | `MAX_BACKFILL_PER_BATCH = 3` at [desktop_app.py:10490](../../python-desktop-app/desktop_app.py#L10490) | Re-queue unprocessed entries instead of clearing them, with a cap on memory (for example the newest 20, where each image is already downscaled). |
| **O-2** Async OCR results lost | One `_ocr_done_event` shared by all jobs ([desktop_app.py:6006-6126](../../python-desktop-app/desktop_app.py#L6006-L6126)). Write-once guard `if row and not row[1]` ([desktop_app.py:5637](../../python-desktop-app/desktop_app.py#L5637)). Matching by `(title, app)`. | Track in-flight jobs with a counter or `queue.join()`. Key results by session **row id** captured at dispatch. Let a successful OCR overwrite a failed one. |
| **O-3** Engine errors shown as "confidence too low" | RapidOCR drops each low line and returns `_create_error_result` on exceptions ([ocr/engines/rapidocr_engine.py:68-99](../../python-desktop-app/ocr/engines/rapidocr_engine.py#L68-L99)) | Separate the outcomes `no_text`, `low_confidence` and `engine_error`. Errors count towards the circuit breaker and keep their message. Keep partially passing text. |
| **O-4** Facade rebuilt without a lock | `get_facade(config)` / `reset_facade()` ([ocr/facade.py:767-781](../../python-desktop-app/ocr/facade.py#L767-L781)) | Lock the facade. Run all OCR, including backfill, on the single OCR worker thread. |
| **O-5** Format/preprocess issues | Images are passed as RGB/RGBA | Convert to 3-channel BGR once before inference. |
| Linux fallback engine can never load | `fallback_engines` defaults to `['winrtocr']` ([ocr/config.py:46](../../python-desktop-app/ocr/config.py#L46)). WinRT is skipped on Linux because `is_available()` is false, so Linux runs RapidOCR only. | **Decided 2026-09-29:** one shared OCR config (AI-server runtime config, `.env` in dev) for both platforms, with RapidOCR as primary everywhere. Engines that cannot run on the current OS are dropped once with a log line. If the resulting list is empty, `rapidocr` is appended as a guaranteed last engine. No Linux fallback engine in v1. |

### 3.3 Architecture mistakes in the old build

| Old approach | Problem | New approach |
|---|---|---|
| System `python3-gi` imported into the PyInstaller Python by adding distro `dist-packages` to `sys.path` | The distro binding is compiled for the **distro's** Python ABI (3.10 on 22.04, 3.12 on 24.04). It only works by luck when the versions match. | `gi` is used **only** in the session helper, which runs on the distro's own `/usr/bin/python3` (§5.3). |
| GStreamer plugins copied from the build machine into the AppImage | Version mismatch with the system PipeWire gives black frames. Builds only worked on a similar Ubuntu machine. | Never bundle GStreamer or PipeWire. The helper uses the system's GStreamer, declared as a package dependency. |
| AppImage inside a `.deb`, then self-update into `~/.local/share` | No stable executable path, so portal and KWin permissions do not stick. FUSE issues. Two copies of the app. | Native packages installing to **`/opt/timetracker`** with a fixed `.desktop` id `com.amzur.timetracker`. Updates go through the package manager (§8.13). |
| `org.gnome.Shell.Introspect` / `Shell.Eval` for the focused window | Both are restricted to allow-listed callers on current GNOME (Eval since 41). They only work in unsafe or dev mode. | Our own GNOME Shell extension (§7). |
| `gnome-screenshot` with muted sound, and a separate "flash suppression" extension | Blocked since GNOME 49. Changing the user's sound settings is a side effect. | Not used. The extension captures without a flash. |
| `evdev` idle backend reading `/dev/input` | Effectively a keylogger, and needs the `input` group | Not used. Compositor idle clocks only (§6.6). |
| `postinst` running `pkexec`/`sudo` installs of PipeWire and portals | Hidden privilege escalation. It breaks unattended installs. | Proper `Depends:` / `Recommends:` in the package metadata. |
| `GDK_BACKEND=x11` forced globally | Pushes everything through XWayland | Not needed. No GTK in the main process. |
| Undeclared runtime tools (`xdotool`, `python3-dbus`, AT-SPI) | Silent missing features | Every runtime tool is declared in the package, or its absence is detected and reported by the capability probe. |

---

## 4. Key decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Shared core, separate Linux folder.** `linux-desktop-app/` holds all Linux platform code, the GNOME extension, KWin scripts, packaging and build. The business logic (auth, sessions, upload, Flask UI, OCR, privacy, DB) stays in `python-desktop-app/` and is imported, not copied. | `desktop_app.py` is 17k lines of business logic that changes weekly. A fork would drift within a month and every fix would be made twice. The core gets **small, behavior-neutral seams** (§5.2). The Windows code path does not change. |
| D2 | **PyInstaller one-dir build** in an **AlmaLinux 8 container** (glibc 2.28, Python 3.11 with Tk from AppStream). | One binary runs on every distribution listed in §2. One-dir means no extraction to `/tmp` (which fails on `noexec` mounts) and faster start. A real ELF binary at `/opt/timetracker/TimeTracker` is also what KWin's restricted-interface check and the GNOME extension's caller check need. |
| D3 | **Pure-Python D-Bus (`jeepney`) in the main process.** | It is already a dependency of `keyring`/`secretstorage` on Linux. No compiled bindings, no GLib, and it supports Unix FD passing. |
| D4 | **Session helper process on system Python** for GLib-bound work: portal ScreenCast via GStreamer, AT-SPI window fallback, AppIndicator tray. | Fixes C-1 by construction. A hang or crash in GStreamer or GTK can be killed and restarted without touching tracking. The ABI always matches because the distro ships `python3`, `python3-gi` and GStreamer together. |
| D5 | **Own GNOME Shell extension** as the primary GNOME path for focused window **and** capture. | It is the only silent, prompt-free option on GNOME Wayland (Ubuntu's default desktop), and window titles need it anyway. The portal ScreenCast is the fallback. |
| D6 | **Never use Pillow's `ImageGrab` on Linux.** | It returns black on Wayland without an error, and on X11 it captures all monitors. |
| D7 | **Packages: `.deb` + `.rpm` (both from one `nfpm` config) + `.tar.gz`.** No AppImage, Flatpak or Snap. | Stable path and system `.desktop` file are required for permissions. The Flatpak/Snap sandbox hides other processes and windows, which breaks tracking. |
| D8 | **Updates via signed APT/YUM repositories.** The in-app update check only notifies. | This is the standard Linux mechanism and needs no privileged updater of our own. A root systemd-timer updater is the documented alternative (§8.13). |
| D9 | **x86_64 first, aarch64 in a later phase.** | RapidOCR and onnxruntime support aarch64, but it doubles the build and test matrix. |

---

## 5. Structure

### 5.1 Folder layout

```
JIRAForge/
├── python-desktop-app/                 # shared core (unchanged behavior on Windows)
│   ├── desktop_app.py                  #  + small platform seams (§5.2)
│   ├── platform_hooks.py               #  NEW: provider registry, ~60 lines
│   ├── monitor_capture.py              #  + delegates to provider when registered
│   ├── ocr/  privacy/  auth/  dq_nudge/  db_connection.py
│
└── linux-desktop-app/                  # NEW – everything Linux-specific
    ├── README.md
    ├── plan/                           # this document and follow-up specs
    ├── timetracker_linux/              # Python package bundled into the binary
    │   ├── __main__.py                 # entry: register provider → desktop_app.main()
    │   ├── provider.py                 # LinuxPlatformProvider (implements the seams)
    │   ├── environment.py              # session/desktop/version/capability probe
    │   ├── dbus_util.py                # jeepney helpers: calls, signals, fd passing, timeouts
    │   ├── paths.py                    # XDG dirs, 0700/0600 permissions
    │   ├── machine_key.py              # pwd + /etc/machine-id key derivation
    │   ├── capture/
    │   │   ├── service.py              # capture thread, budget, fallback, re-probe
    │   │   ├── result.py               # CaptureResult / CaptureStatus
    │   │   ├── validator.py            # FrameValidator
    │   │   ├── scale.py                # scale normalisation for OCR
    │   │   └── backends/
    │   │       ├── x11.py              # python-xlib + XShm (mss) + XRandR
    │   │       ├── gnome_extension.py  # D-Bus to our extension, memfd
    │   │       ├── kwin.py             # org.kde.KWin.ScreenShot2, pipe reader
    │   │       ├── wlroots.py          # grim -o <output>
    │   │       ├── portal_screencast.py# client of the session helper
    │   │       └── null.py
    │   ├── window/
    │   │   ├── service.py              # focus cache + FocusChanged events
    │   │   └── backends/  x11_ewmh.py  gnome_extension.py  kwin_script.py
    │   │                  sway.py  hyprland.py  atspi.py (via helper)  null.py
    │   ├── idle/
    │   │   └── backends/  xss.py  mutter.py  freedesktop_screensaver.py
    │   │                  wayland_idle_notify.py  logind_idlehint.py  pynput_x11.py
    │   ├── session_events.py           # logind Lock/Unlock/PrepareForSleep/Shutdown + inhibitor
    │   ├── notify.py                   # org.freedesktop.Notifications + ActionInvoked
    │   ├── tray.py                     # client of helper tray; no-tray fallback
    │   ├── single_instance.py          # fcntl.flock in $XDG_RUNTIME_DIR
    │   ├── autostart.py                # ~/.config/autostart/com.amzur.timetracker.desktop
    │   ├── location.py                 # NetworkManager SSID, real interface IP
    │   ├── app_identity.py             # app_id/WM_CLASS, .desktop Name=, aliases
    │   ├── helper_client.py            # spawn/supervise helper, clean env, socket protocol
    │   └── diagnostics.py              # capability report for logs/admin/diagnostics
    ├── session-helper/                 # runs on SYSTEM python3 (>= 3.6), never frozen
    │   ├── tt_session_helper.py        # GLib main loop owner; Unix-socket server
    │   ├── screencast.py               # portal ScreenCast + GStreamer appsink
    │   ├── atspi_focus.py
    │   └── tray_indicator.py           # AyatanaAppIndicator3 / AppIndicator3
    ├── gnome-extension/
    │   ├── src/                        # one source tree
    │   ├── build.sh                    # emits esm/ (GNOME 45+) and legacy/ (GNOME 42–44)
    │   └── tests/                      # headless mutter/gnome-shell tests
    ├── kwin-script/
    │   └── timetracker-focus/          # Plasma 5 + 6 compatible focus reporter
    ├── packaging/
    │   ├── nfpm.yaml                   # .deb + .rpm from one definition
    │   ├── com.amzur.timetracker.desktop
    │   ├── scripts/ postinst.sh  prerm.sh  postrm.sh
    │   ├── tarball/install.sh          # --system (/opt) or --user (~/.local)
    │   └── repo/                       # APT/YUM repo publishing + signing scripts
    ├── build/
    │   ├── Dockerfile.almalinux8       # reproducible build image
    │   ├── timetracker_linux.spec      # PyInstaller one-dir spec
    │   └── build_linux.sh              # container build → dist/*.deb *.rpm *.tar.gz
    ├── tools/
    │   └── tt-doctor                   # user-runnable capability check (same probe as the app)
    └── tests/                          # pytest: unit + headless integration
```

### 5.2 Seams in the shared core

The Linux package must not patch `desktop_app.py` at runtime. Instead, the core gets a small registry. On Windows nothing is registered, so every existing code path runs unchanged.

`python-desktop-app/platform_hooks.py`:

```python
_provider = None
def register(provider): ...
def get():  # returns provider or None
```

Each Windows-only site gets a two-line guard, for example:

```python
def get_active_window(self):
    p = platform_hooks.get()
    if p is not None:
        return self._apply_window_switch(p.get_focused_window())   # shared switch logic
    ... existing Win32 code unchanged ...
```

| Seam (provider method) | Call site today | Notes |
|---|---|---|
| `get_focused_window() → {title, app, app_id, pid, monitor, minimized}` | `get_active_window` ([desktop_app.py:11357](../../python-desktop-app/desktop_app.py#L11357)) | The window-switch bookkeeping (lines 11374-11420) is moved into a shared helper, so Windows and Linux use the same logic. |
| `is_screen_locked()` | `_is_screen_locked` ([11344](../../python-desktop-app/desktop_app.py#L11344)) | logind `LockedHint` / extension |
| `get_system_idle_seconds()` | [12155](../../python-desktop-app/desktop_app.py#L12155) | Compositor idle clock |
| `start_input_monitor(on_activity)` | `monitor_user_activity` ([12221](../../python-desktop-app/desktop_app.py#L12221)) | `pynput` only on X11 |
| `start_session_events(on_lock, on_unlock, on_sleep, on_wake, on_shutdown)` | `monitor_system_events` ([12281](../../python-desktop-app/desktop_app.py#L12281)) | logind |
| `capture_focused_monitor() → PIL.Image or None`, `get_capture_status()` | `monitor_capture.capture_focused_monitor` | `monitor_capture.py` delegates first. The Windows branch is untouched. |
| `notify(title, message, actions)` | every `WINOTIFY_AVAILABLE` site | A `notify()` helper in the core picks winotify or the provider. |
| `create_tray(...)` | `setup_system_tray` ([13940](../../python-desktop-app/desktop_app.py#L13940)) | Linux tray via the helper, with a no-tray fallback |
| `single_instance_acquire()/release()` | [283](../../python-desktop-app/desktop_app.py#L283) | `fcntl.flock` |
| `autostart_add/remove/is_enabled()` | [1834-1935](../../python-desktop-app/desktop_app.py#L1834-L1935) | XDG autostart |
| `install_application()` / update apply | [1102](../../python-desktop-app/desktop_app.py#L1102), `UpdateManager.apply_update` | Linux: no self-install. The update notice points to the package manager. |
| `get_wifi_ssid()`, `get_local_ip()` | `LocationDetector` ([5197-5226](../../python-desktop-app/desktop_app.py#L5197-L5226)) | `nmcli` / NM D-Bus; `psutil.net_if_addrs` (fixes the `127.0.1.1` bug) |
| `get_app_display_info(app)` | `_get_file_version_info` ([8489](../../python-desktop-app/desktop_app.py#L8489)) | `.desktop` `Name=`/`Icon=` |
| `lower_current_thread_priority()` | OCR worker ([6019](../../python-desktop-app/desktop_app.py#L6019)) | `os.setpriority(PRIO_PROCESS, native_tid, 10)` + idle I/O class |
| `machine_key_material()` | `db_connection.py:110-125, 587-605`, `auth/secure_storage.py:610-635` | `pwd.getpwuid(os.getuid())` + `/etc/machine-id`. Windows derivation unchanged. |
| `process_aliases`, `browser_processes`, `redacted_body_processes`, `system_process_denylist` | [desktop_app.py:5026-5100](../../python-desktop-app/desktop_app.py#L5026-L5100) | The provider **adds** Linux names. It does not replace the Windows sets. |

**Rule:** each seam lands with a test proving the Windows path is unchanged when no provider is registered. The full Windows suite must stay green.

### 5.3 Process model

```
┌──────────────────────── TimeTracker (PyInstaller, /opt/timetracker/TimeTracker) ────────────────────────┐
│ main thread        : Tk/customtkinter root when available, otherwise waits on the stop event            │
│ tracking thread    : tracking_loop (shared core) → provider.get_focused_window() (cached, <5 ms)        │
│ capture thread     : CaptureService — owns backends, 1.5 s budget, validator, re-probe                  │
│ window thread      : WindowService — subscribes to FocusChanged (extension/KWin/sway/hypr) or polls X11 │
│ dbus thread        : jeepney connection, logind + ScreenSaver + Notifications signals                   │
│ OCR worker         : shared core (nice 10, idle I/O)                                                    │
│ Flask thread       : shared core web UI                                                                  │
│ helper supervisor  : spawns/restarts session helper with a clean environment                           │
└──────────────────────────────────────┬──────────────────────────────────────────────────────────────────┘
                                       │ Unix socket $XDG_RUNTIME_DIR/timetracker/helper.sock (0600)
                                       │ length-prefixed JSON + raw frame bytes
┌──────────────────────────────────────▼───────────────────────────┐
│ tt-session-helper  (/usr/bin/python3, system gi + GStreamer)     │
│ main thread = GLib main loop: ScreenCast stream(s), AT-SPI, tray │
└──────────────────────────────────────────────────────────────────┘
```

Helper rules:

- It is started **only if needed**: for the ScreenCast fallback, the AT-SPI fallback, or the tray when an SNI host exists. On X11 with no tray host, it is never started.
- It is spawned with the **original environment**. PyInstaller sets `LD_LIBRARY_PATH` to its bundled libraries, so `LD_LIBRARY_PATH_ORIG` must be restored (or `LD_LIBRARY_PATH` removed) for the helper, `xdg-open`, `nmcli`, `grim` and every other child. Otherwise the system `python3` loads our bundled `libssl`/`libstdc++` and crashes.
- It is written for Python 3.6+ (RHEL 8 system Python) and uses only the standard library, `gi`, `Gst`, `Atspi` and the AppIndicator typelibs.
- Its health is checked with a ping every 30 s. It is restarted up to 3 times per 10 min with backoff, and then the features it serves are marked unavailable with a reason.
- Frames are sent as raw RGB bytes over the socket. A 1440p frame is about 11 MB, which is about 10 ms locally. No temporary files.

---

## 6. Subsystem design

### 6.1 Environment and capability probe (`environment.py`)

The probe runs at startup, after a failure threshold, every 30 min, and on unlock/resume. The results are logged, shown in the admin log, and added to `send_login_diagnostics` (free-form JSON, no server change).

| Fact | Source (in order) |
|---|---|
| Session type | `XDG_SESSION_TYPE`; `WAYLAND_DISPLAY` present; logind `Session.Type` |
| Desktop | `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, and the owner of `org.gnome.Shell` / `org.kde.KWin` on the bus; `SWAYSOCK`; `HYPRLAND_INSTANCE_SIGNATURE` |
| GNOME version | `org.gnome.Shell.ShellVersion` property |
| Plasma/KWin version | `org.kde.KWin` properties / `plasmashell --version` |
| Extension state | `org.gnome.Shell.Extensions.GetExtensionInfo('timetracker@amzur.com')`; `disable-user-extensions`, locked `enabled-extensions` |
| Portal | `org.freedesktop.portal.ScreenCast.version` (≥ 4 for restore), `AvailableSourceTypes`; Registry availability (xdg-desktop-portal ≥ 1.19) |
| Tools | `grim`, `swaymsg`, `hyprctl`, `nmcli` on `PATH` (with the clean env) |
| Helper deps | Helper `--probe` reports `gi`, `Gst` + `pipewiresrc`, `Atspi`, AppIndicator typelib |
| Tray host | `org.kde.StatusNotifierWatcher` present and `IsStatusNotifierHostRegistered` |
| Notifications | `org.freedesktop.Notifications.GetCapabilities` (actions?) |
| Keyring | Secret Service reachable and collection unlocked (with a timeout) |
| Distro | `/etc/os-release` `ID`, `VERSION_ID`, `PRETTY_NAME` |
| Monitors | From the active window/capture backend (names, geometry, scale) |

**X11 is chosen only when `XDG_SESSION_TYPE=x11`.** It is never chosen because `DISPLAY` is set, since XWayland sets `DISPLAY` too. This one rule prevents the most common black-image bug.

Example startup log:

```
[LINUX] Ubuntu 26.04 LTS | session=wayland desktop=ubuntu:GNOME gnome=50.1 | build=1.5.0 glibc-floor=2.28
[LINUX] window=gnome_extension(proto 1) capture=gnome_extension→portal_screencast→null idle=mutter
[LINUX] session_events=logind tray=helper/ayatana notify=freedesktop(actions) keyring=secret_service(unlocked)
[LINUX] monitors: eDP-1 2880x1800 @1.50 (primary), HDMI-1 1920x1080 @1.00
```

### 6.2 Backend selection table

| Session / desktop | Window info | Capture | Idle | Tray |
|---|---|---|---|---|
| **X11** (any WM: Cinnamon, Xfce, MATE, i3, GNOME/KDE on Xorg) | EWMH `_NET_ACTIVE_WINDOW` (python-xlib) | X11: XShm grab of the focused monitor (XRandR) | XScreenSaver ext (python-xlib) → pynput | Helper AppIndicator (SNI) → none |
| **GNOME Wayland** | Extension → AT-SPI (helper) | Extension → Portal ScreenCast (helper) → Null | Mutter `IdleMonitor` | Helper AppIndicator if the AppIndicator extension is on → none |
| **KDE Plasma Wayland** | KWin script → AT-SPI | KWin `ScreenShot2.CaptureActiveScreen` → Portal ScreenCast → Null | `ext-idle-notify-v1` → `org.freedesktop.ScreenSaver.GetSessionIdleTime` | Helper AppIndicator (native SNI) |
| **Sway** | Sway IPC (`GET_TREE` + window event subscription) | `grim -o <focused output>` → Portal → Null | `ext-idle-notify-v1` | Helper if an SNI host (waybar) exists → none |
| **Hyprland** | Hyprland event socket + `j/activewindow` | `grim -o` → Portal (`xdg-desktop-portal-hyprland`) → Null | `ext-idle-notify-v1` | same as Sway |
| **Other Wayland** (labwc, river, Wayfire, niri, COSMIC, …) | AT-SPI → Null | `grim` if screencopy is supported → Portal → Null | `ext-idle-notify-v1` → logind `IdleHint` | if SNI host → none |
| **Unknown / nothing works** | Null (tracking **paused** with a visible reason; see below) | Null | logind `IdleHint` → tracking loop gap detection | none |

**If no window-info backend works, the app does not upload sessions.** It shows "Tracking unavailable on this desktop: <reason>" and sends the diagnostic. A day-long "Unknown" session is worse than no data (port guide §3).

### 6.3 Focused window (`window/`)

- **Output:** `{title, app, app_id, wm_class, pid, monitor_name, monitor_rect, scale, minimized, fullscreen, window_id}`.
- **App name rule:** use `psutil.Process(pid).name()` when the pid is known and the name is not a generic runtime. For `java`, `python3`, `node`, `electron`, `bwrap`, `flatpak-bwrap`, `snap` and similar, use `app_id`/`wm_class` (for example `jetbrains-idea`, `com.slack.Slack`) or the `.desktop` `StartupWMClass` match. The result is normalized through the extended alias table (§6.12).
- **Events, not only polling.** The extension, KWin script, Sway and Hyprland push `FocusChanged` (focus or title change). `WindowService` caches the latest value, and `tracking_loop` reads the cache. X11 uses a `PropertyNotify` subscription on the root window for `_NET_ACTIVE_WINDOW` and on the active window for `_NET_WM_NAME`, plus a 2 s poll as a safety net.
- **Transient windows are debounced** (300 ms, as on Windows): notifications, the overview, the app switcher, polkit dialogs, and our own popups.
- **`focus_window == null`** (desktop, overview) maps to the existing "no focus / skip capture" path, not to a new "Unknown" session.
- **KWin script:** it is installed to `/usr/share/kwin/scripts/timetracker-focus/` and loaded at runtime via `org.kde.KWin /Scripting loadScript` + `run`. It supports Plasma 5 (`workspace.activeClient`, `clientActivated`) and Plasma 6 (`workspace.activeWindow`, `windowActivated`) in one file. It calls `callDBus` to our service `com.amzur.TimeTracker.Focus` on the session bus, which is owned by the main process through jeepney.
- **AT-SPI fallback (helper):** the frame with focused state on the accessibility bus. It is slow and depends on toolkit accessibility, so it is used only when no compositor source exists. It is marked `quality=degraded` in diagnostics.

### 6.4 Screen capture (`capture/`)

`capture_focused_monitor()` in the core stays the only entry point. On Linux it calls `CaptureService.request(expected_window_id, budget_ms=1500)`.

**Per request:**

1. If locked, idle, paused, or `minimized` / no focus → return `None` with the reason (no backend call).
2. The active backend captures **the monitor of the focused window only**.
3. `FrameValidator` (§6.5) runs.
4. **Window-match check:** the backend reports the window id/title that was focused when the frame was taken (the extension returns it with the frame. Other backends read `WindowService` immediately before and after). If it is not `expected_window_id`, the frame is discarded as `STALE_WINDOW` (fixes C-7).
5. `ScaleNormalizer` (§6.4.7).
6. Return the `PIL.Image` to the unchanged OCR pipeline. **The image is never written to disk.**

**Fallback and recovery:** 5 consecutive failures or bad frames → switch to the next backend in the chain and log why. The preferred backend is retried every 30 min and on unlock/resume, for example after the user logged out and in so the extension is now loaded. A budget timeout counts as a failure, and the late result is dropped.

**Capture is only requested when OCR will run.** The throttled branch in `capture_screenshot_only` ([desktop_app.py:6135-6137](../../python-desktop-app/desktop_app.py#L6135-L6137)) keeps its behavior on Windows. On Linux, the provider returns the cached latest valid frame for the same window when it is less than 10 s old, and does not capture again. The duplicate `capture_screenshot()` for the same switch in event mode is removed after verifying it in `tracking_loop`.

#### 6.4.1 X11 backend

- `python-xlib`: `_NET_ACTIVE_WINDOW` → frame rect (with `_NET_FRAME_EXTENTS`) → `_NET_WM_STATE_HIDDEN` check.
- Monitors come from XRandR `GetMonitors`, re-read on every capture (hot-plug). Pick the largest overlap, which is the same rule as `_resolve_monitor_for_hwnd`.
- Grab with XShm (`mss`) for that monitor rect only → BGRA → RGB.
- Silent, 10–30 ms at 1080p.

#### 6.4.2 GNOME extension backend

The main path on Ubuntu/Fedora/Debian/RHEL GNOME. See §7 for the extension itself.

- `os.memfd_create('tt-frame', MFD_CLOEXEC)` → send the fd (D-Bus type `h`) with `CaptureFocusedMonitor(fd, {format: 'raw'|'png'})`.
- The reply includes `status`, `width`, `height`, `stride`, `format`, `scale`, `monitor`, `window_id`, `title`. Read from the memfd, build the image with `Image.frombuffer`, and close the fd in `finally`.
- The status values `locked`, `no_focus`, `minimized` and `rate_limited` map to skip statuses, not failures.

#### 6.4.3 KWin backend

- The system `.desktop` file declares `X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2`, and `Exec=` points at the **real binary** `/opt/timetracker/TimeTracker`, not a wrapper script.
- Create a pipe and call `CaptureActiveScreen({include-cursor: false, native-resolution: true}, write_fd)`. **Read the pipe in a separate thread while the call is in flight**, with a timeout, to avoid a pipe-full deadlock. Build the image from `width/height/stride/format` (ARGB32 premultiplied → RGB).
- If the interface is missing or older than required, use `CaptureScreen(<focused output from KWin script>)`, then the portal.

#### 6.4.4 wlroots backend

- Focused output: Sway `GET_OUTPUTS` (`focused: true`) or Hyprland `j/monitors` (`focused: true`).
- `grim -t ppm -o <output> -` with the clean environment and a 3 s timeout. Parse from stdout. Nothing touches disk.
- `grim` is a `Recommends`, and its absence is reported by the probe.

#### 6.4.5 Portal ScreenCast backend (runs in the helper)

This is the universal Wayland fallback, done correctly:

1. `CreateSession({handle_token, session_handle_token})`. Subscribe to `Request.Response` on the precomputed request path **before** the call.
2. `SelectSources({types: MONITOR, multiple: true, cursor_mode: HIDDEN, persist_mode: 2, restore_token: <saved>})`.
3. `Start()`. The dialog appears only without a valid token. **Save the returned `restore_token` every time** in the keyring (`screencast_restore_token` added to `SENSITIVE_TOKEN_KEYS` in both lists; `tests/test_secure_storage_key_sync.py` enforces this).
4. `OpenPipeWireRemote()` → one fd, owned and closed by the helper.
5. One pipeline per selected monitor: `pipewiresrc fd=… path=<node> always-copy=true do-timestamp=true ! videoconvert ! video/x-raw,format=RGB ! appsink max-buffers=1 drop=true sync=false emit-signals=false`. `always-copy=true` prevents the DMA-BUF black-frame bug (NVIDIA, some Mesa).
6. Discard frames until the first frame that passes validation (up to 2 s).
7. **Capture = pull the latest sample** from the focused monitor's appsink (match by stream `position`/`size` to the window backend's monitor). If the user did not share that monitor → `SKIPPED_UNKNOWN_MONITOR`. Never substitute another monitor.
8. **Stop the stream when idle, locked, paused or asleep**, and restart it with the token on resume. The "screen is being shared" indicator is then only shown while the user is actually tracked.
9. If the token is rejected (monitors changed, permission revoked): **no dialog in the middle of work.** Set status `DENIED`, continue title+time only, and show one actionable notification per day ("Allow screen access again") that starts the flow when clicked.
10. Register the app id through `org.freedesktop.host.portal.Registry.Register('com.amzur.timetracker')` where it exists (xdg-desktop-portal ≥ 1.19). Otherwise rely on launch through the `.desktop` file (systemd scope `app-com.amzur.timetracker-*.scope`) so permissions attach to the stable id.

**Not used:** the portal Screenshot API (it flashes on GNOME), `gnome-screenshot`, the GNOME Shell private screenshot D-Bus, and X11 capture on Wayland.

#### 6.4.6 Null backend

Returns `None` with a reason. The status appears in Settings ("Screen text capture: unavailable – <reason> – [Fix]") and in the tray tooltip, and is counted in diagnostics.

#### 6.4.7 Scale and OCR quality

- Every backend reports the monitor scale. The compositor crops (extension, KWin, grim, portal stream per monitor), so we never compute pixel rectangles across mixed-DPI monitors on Wayland.
- Before the existing `preprocess_screenshot` max-dimension step: if `scale > 1`, downscale by `1/scale` to 100%-equivalent text size. Never downscale a single-monitor frame so far that text falls below about 100%-equivalent size. Tune on the test page at 100/125/150/200% (AC 16).
- The cursor is hidden on every backend.

### 6.5 FrameValidator

This runs on every Linux frame before OCR. It costs under 2 ms (on a 64×36 thumbnail, grayscale, **alpha ignored**).

| Check | Reject when |
|---|---|
| Size sanity | Differs from the backend-reported monitor size by > 2 px |
| All black | Max luminance < 16 |
| Flat | Luminance stddev < 3 (catches solid black, gray and white failures) |
| Mostly black | > 97% of pixels with luminance < 8 |
| Transparent | RGBA with > 50% alpha = 0 |

A rejected frame → `BLACK_FRAME` → no OCR, counted as a backend failure. For ScreenCast, retry once after 300 ms. A dark-theme IDE passes (it is dark but not flat). DRM video legitimately fails, and the session keeps title and time with empty OCR.

### 6.6 Idle (`idle/`)

| Backend | Where | Notes |
|---|---|---|
| XScreenSaver `QueryInfo` (python-xlib `screensaver` ext) | X11 | ms since last input |
| `org.gnome.Mutter.IdleMonitor.GetIdletime` | GNOME (X11 + Wayland) | Stable across GNOME 3.x–50 |
| `ext-idle-notify-v1` (pywayland) | KWin 6, Sway, Hyprland, labwc, river, COSMIC | Event-based. Register a notification at 1 s and track `idled`/`resumed` to derive idle seconds. |
| `org.freedesktop.ScreenSaver.GetSessionIdleTime` | KDE, Xfce, others that implement it | Verify on Plasma 6 Wayland |
| logind `IdleHint`/`IdleSinceHint` | any systemd/elogind | Coarse, last resort |
| pynput | **X11 only**, as a backup | Never on Wayland (it marks working users as idle) |

**Never** `/dev/input` (evdev). The existing idle policy code (`_compute_idle_duration`, work hours, idle records) is unchanged. It only gets a working clock.

### 6.7 Lock, sleep, wake, shutdown (`session_events.py`)

| Windows event | Linux source |
|---|---|
| Lock / unlock | logind `Session.Lock`/`Unlock` signals and the `LockedHint` property; also `org.gnome.ScreenSaver.ActiveChanged` (GNOME) and `org.freedesktop.ScreenSaver.ActiveChanged` (KDE/others) |
| Suspend / resume | logind `Manager.PrepareForSleep(true/false)` |
| Shutdown / logout save | logind `PrepareForShutdown(true)` + a **delay inhibitor** `Inhibit('shutdown:sleep', 'TimeTracker', 'Saving session', 'delay')`, released after `_shutdown_cleanup()`; `SIGTERM` handler as backup |

- **Session path:** `GetSessionByPID(os.getpid())`, then `XDG_SESSION_ID`, then `ListSessions` filtered by our uid + active graphical seat. `session/auto` fails when the app is started from a systemd user unit.
- `_is_screen_locked()` on Linux = cached `LockedHint` / ScreenSaver `GetActive`, also used right after resume ([desktop_app.py:12783](../../python-desktop-app/desktop_app.py#L12783) area).
- Non-systemd distributions: elogind provides the same D-Bus API. Without it, only the existing tracking-loop gap detection is used.

### 6.8 OCR on Linux

- **RapidOCR** (onnxruntime manylinux wheel), with models bundled at build time. This is the same engine and the same PP-OCR models as the Windows primary, so the same screen gives nearly the same text on both platforms.
- **One shared OCR config** (decided 2026-09-29). Windows-only engines in the list (`winrtocr`) are filtered out on Linux, and `rapidocr` is guaranteed as the last engine (§3.2).
- **No fallback engine in v1.** Most Linux OCR failures come from bad input (black frame, wrong monitor, small text), which a second engine would not fix. Tesseract is reconsidered only if diagnostics show real RapidOCR engine errors. If per-platform engines are ever needed, add an optional `platform_overrides.linux` key to the server config, with the shared config as the default.
- **Expected gap until O-3 is fixed:** on Windows, WinRT's hard-coded confidence of 1.0 quietly rescues screens where RapidOCR scores below the threshold. Linux has no such rescue, so its OCR failure rate will look higher with the same config. O-3 (keep lines that pass the threshold) is therefore a Linux release dependency.
- **Runtime `pip install` is disabled on Linux** (`ocr/auto_installer.py`, `ocr/runtime_installer.py`). A frozen app has no pip, and distro Python is PEP 668 "externally managed". A missing engine is a **build** error.
- The OCR worker runs at `nice 10` with the idle I/O class (`ioprio_set` via `ctypes`, best effort).
- The shared-core O-1…O-5 fixes (§3.2) are a separate spec in `python-desktop-app/plan/`, because they change Windows behavior too. The Linux release depends on them.

### 6.9 Tray, notifications, popups

- **Tray:** the helper provides an AppIndicator (StatusNotifierItem) using `AyatanaAppIndicator3`, falling back to `AppIndicator3`. The menu is built from a JSON description sent by the main process, and clicks are sent back over the socket. The icon changes only on a real state change, not every 2 s.
- **No tray host** (vanilla GNOME on Fedora/RHEL/Debian without the AppIndicator extension, or a bare Sway): the app still works. It shows a start notification with an "Open TimeTracker" action, installs an app-menu launcher that opens the local web UI (`http://127.0.0.1:<WEB_PORT>`), and puts the status in the web UI. The app **never** enables third-party GNOME extensions on its own. It can suggest the AppIndicator extension in Settings.
- **Notifications:** `org.freedesktop.Notifications.Notify` via jeepney, with actions when `GetCapabilities` contains `actions`, and `ActionInvoked` handled to open URLs. This replaces every `winotify` site through the core `notify()` helper.
- **Popups (pause, DQ nudge):** notification-first on Linux (a notification with actions, and the popup opens when clicked). Tk popups run through XWayland when `DISPLAY` is available, with scaling set from the real monitor scale (`ctk.set_widget_scaling`). If Tk cannot open a display, the popup opens as a page in the local web UI. `-topmost` and positioning are best effort on Wayland.

### 6.10 Credentials and local database

- `keyring` → Secret Service (gnome-keyring / KWallet / KeePassXC). `secretstorage` + `jeepney` are **explicitly bundled** (hidden imports), otherwise keyring silently becomes the `fail` backend.
- **Locked keyring at autostart:** access tokens lazily, with a 5 s timeout, off the main thread. On timeout, use the encrypted-file fallback for this run and retry the keyring later. Never block startup on an unlock dialog.
- **Key derivation on Linux** (`machine_key.py`): `pwd.getpwuid(os.getuid()).pw_name` + `/etc/machine-id` (falling back to `/var/lib/dbus/machine-id`). This is stable across terminal and autostart launches and across hostname changes. Existing Windows derivation is unchanged. A migration path tries the old derivation once and re-encrypts, so dev/beta users do not lose data.
- **SQLCipher:** remove the `win32` marker from `sqlcipher3-wheels` (manylinux wheels exist) and verify it loads on the glibc 2.28 floor. If it fails, the build fails. The Linux DB must not silently be plaintext.
- **Permissions:** data dirs `0700`, DB/token/log files `0600`.

### 6.11 Single instance, autostart, paths, install/uninstall

- **Single instance:** `fcntl.flock(LOCK_EX|LOCK_NB)` on `$XDG_RUNTIME_DIR/timetracker/instance.lock`. The kernel releases it on crash, so there is no PID-reuse bug. A second launch asks the running instance (over the same socket) to open the web UI, then exits.
- **Autostart:** on first run, `~/.config/autostart/com.amzur.timetracker.desktop` (`Exec=/opt/timetracker/TimeTracker --autostart`, `X-GNOME-Autostart-enabled=true`). Admins can deploy `/etc/xdg/autostart/` instead. For Sway/Hyprland, which do not always process XDG autostart, document `exec` lines or the optional systemd user unit bound to `graphical-session.target`.
- **Paths (XDG):** data `$XDG_DATA_HOME/TimeTracker` (already `~/.local/share/TimeTracker`), config `$XDG_CONFIG_HOME/timetracker`, logs `$XDG_STATE_HOME/TimeTracker/logs`, runtime `$XDG_RUNTIME_DIR/timetracker`. Pause settings move from `APPDATA` to config ([desktop_app.py:10069](../../python-desktop-app/desktop_app.py#L10069)).
- **Self-install and the Windows uninstaller generator are no-ops on Linux.** The package manager owns `/opt`.
- **Uninstall:** `prerm` stops running instances (touch the `.shutdown_signal`, then `SIGTERM` after 10 s). Per-user data cannot be removed by `postrm` for every user, so Settings gets **"Remove my data and sign out"** (deletes the data dir and keyring entries, and disables autostart). The admin guide documents `rm -rf ~/.local/share/TimeTracker ~/.config/timetracker` + `secret-tool clear service TimeTracker`. This matters for the GDPR/account-deletion flows.

### 6.12 Location, app identity, privacy lists

- **Wi-Fi SSID:** NetworkManager D-Bus (active connection → `802-11-wireless.ssid`), then `nmcli -t -f ACTIVE,SSID dev wifi`. None of these → next tier.
- **Local IP:** `psutil.net_if_addrs()` on the default-route interface. `gethostbyname(gethostname())` returns `127.0.1.1` on Debian/Ubuntu.
- **Precise geolocation:** skipped on Linux in v1. IP geolocation (already present) covers it.
- **Aliases (added, not replacing):** `google-chrome(-stable)`, `chrome`, `chromium(-browser)`, `firefox(-esr|-bin)`, `org.mozilla.firefox`, `microsoft-edge(-stable)`, `msedge`, `brave(-browser)`, `code`, `code-insiders`, `codium`, `jetbrains-*`, `teams-for-linux`, `slack`/`com.slack.Slack`, `zoom`, `soffice.bin`/`libreoffice-*`.
- **`BROWSER_PROCESSES`** gets the Linux browser names, otherwise URL-based classification does not work.
- **`REDACTED_BODY_PROCESSES` (privacy requirement)** adds `thunderbird`, `betterbird`, `evolution`, `geary`, `kmail`, `mailspring`, and the chat clients covered by policy (`slack`, `teams-for-linux`, `discord`, `signal-desktop`, `telegram-desktop`, `element`). Without this, Linux mail bodies would be OCR'd and uploaded.
- **Running-app search for the classification UI:** list apps that have windows (from the window backend) plus `.desktop` entries, not raw processes (Linux has hundreds of daemons).
- **Display name/icon:** `.desktop` `Name=`/`Icon=` from `/usr/share/applications`, `~/.local/share/applications`, `/var/lib/flatpak/exports/share/applications` and `/var/lib/snapd/desktop/applications`, matched by `StartupWMClass` or app id.
- **Diagnostics `platform`:** add distro, session type, desktop, and the chosen backends. These are free-form JSON fields.

### 6.13 Updates (D8)

- **Primary:** signed APT and YUM repositories (static hosting). `postinst` adds the repo file and key, as Chrome and VS Code do, so `unattended-upgrades` / `dnf-automatic` / the Software Updater install updates silently. The in-app check (`/api/app-version/latest?platform=linux`) shows "Update available – installed by your system updater", and for mandatory updates it pauses tracking with a notice, as on Windows.
- **Alternative (if forced updates on the Windows schedule are required):** a root `timetracker-updater.timer` + `.service` that downloads the package listed in `app_releases`, verifies SHA-256 **and** a detached signature, installs it with `apt`/`dnf`, and signals user instances. This is security-sensitive code, so it is only built if D8 is overruled.
- **Never** `pkexec dpkg -i` from the user app, and never self-replace files under `/opt`.
- **After an update:** `postinst` touches the shutdown signal. The running instance saves and exits, and a systemd-run relaunch (or the next login) starts the new version. The GNOME extension update is picked up at the next login, so the extension D-Bus protocol stays backward-compatible (§7.4).
- **Tarball / `--user` installs** have no auto-update. They get a notification with the download link.

### 6.14 Packaging and build (D2, D7)

**Build (`build/build_linux.sh`, run in CI and locally with Docker/Podman):**

1. Image `almalinux:8` + `python3.11`, `python3.11-tkinter`, `python3.11-devel`, and the build tools. The glibc floor is 2.28.
2. `pip install -r python-desktop-app/requirements.txt -r linux-desktop-app/requirements-linux.txt` with hashes. Linux-only packages: `python-xlib`, `mss`, `jeepney`, `secretstorage`, `pywayland`, `sqlcipher3-wheels`. PyInstaller is upgraded to a current 6.x for the Linux build only.
3. `pyinstaller build/timetracker_linux.spec` → **one-dir** `dist/TimeTracker/`. `pathex` includes `../python-desktop-app`. Hidden imports: `timetracker_linux.*`, `keyring.backends.SecretService`, `secretstorage`, `jeepney`, `Xlib.ext.*`. It collects onnxruntime `.so` files, RapidOCR models, the spaCy `en_core_web_sm` model, and Tcl/Tk data. It excludes `win32*`, `winotify`, `winrtocr`, `winsdk`, `pystray._win32`, `gi`, `torch` and `paddle`. It does **not** bundle `libGL`, `libdbus`, `libX11`, `libwayland-*` or GStreamer.
4. Build the GNOME extension (`esm/` and `legacy/`) and pack it with `gnome-extensions pack`.
5. `nfpm` → `.deb` and `.rpm`. `tar` → `.tar.gz` with `install.sh`.
6. Smoke test each artifact in clean containers (`ubuntu:22.04/24.04/26.04`, `debian:12`, `fedora:latest`, `almalinux:9`, `opensuse/tumbleweed`, `archlinux`): install, `TimeTracker --self-test` (imports, OCR on a fixture, privacy filter, SQLCipher open), and uninstall.
7. Produce SHA-256 sums, sign the packages and repo metadata, and output an `app_releases` row proposal (SQL for the user to review; never applied automatically, per CLAUDE.md).

**Installed layout:**

| Path | Content |
|---|---|
| `/opt/timetracker/TimeTracker` + `/opt/timetracker/_internal/` | App (one-dir) |
| `/opt/timetracker/session-helper/` | Helper scripts (system Python) |
| `/opt/timetracker/gnome-extension/{esm,legacy}/` | Both extension builds |
| `/usr/share/gnome-shell/extensions/timetracker@amzur.com/` | The build that matches the installed GNOME, selected by `postinst` from `gnome-shell --version` and re-checked by the app at startup (for example after a distro upgrade from 22.04 to 24.04) |
| `/usr/share/kwin/scripts/timetracker-focus/` | KWin script |
| `/usr/share/applications/com.amzur.timetracker.desktop` | `Exec=/opt/timetracker/TimeTracker`, `StartupWMClass`, `X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2` |
| `/usr/share/icons/hicolor/*/apps/com.amzur.timetracker.png` | Icons |
| `/usr/bin/timetracker` | Symlink (for the terminal only; the `.desktop` file uses the real path) |

**Dependencies (names per family):**

| Purpose | `.deb` | `.rpm` (Fedora/RHEL / openSUSE) | Relation |
|---|---|---|---|
| Helper runtime | `python3`, `python3-gi` | `python3`, `python3-gobject` / `python3-gobject` | Depends |
| ScreenCast | `gstreamer1.0-pipewire`, `gir1.2-gstreamer-1.0`, `gir1.2-gst-plugins-base-1.0`, `xdg-desktop-portal` | `pipewire-gstreamer`, `gstreamer1-plugins-base`, `xdg-desktop-portal` / `gstreamer-plugin-pipewire` | Recommends |
| Tray | `gir1.2-ayatanaappindicator3-0.1` | `libayatana-appindicator-gtk3` | Recommends |
| AT-SPI | `gir1.2-atspi-2.0`, `at-spi2-core` | `at-spi2-core` | Recommends |
| wlroots capture | `grim` | `grim` | Suggests |
| Location | `network-manager` | `NetworkManager` | Suggests |

`postinst` does **not** install other packages, does not use `pkexec`, and does not touch other users' home directories. It installs system files, selects the extension build, adds the update repository, and refreshes the desktop and icon caches.

**Tarball `install.sh`:** `--system` uses the same layout as the packages (needs root). `--user` installs to `~/.local/opt/timetracker`, `~/.local/share/applications`, and `~/.local/share/gnome-shell/extensions`. This mode is for immutable distros (Silverblue, SteamOS) and users without root, and has no auto-update. Whether KWin honors a per-user `.desktop` for the restricted interface is to be verified; the portal fallback covers it if not.

### 6.15 Diagnostics and support

- A **"Linux health" panel** in the admin log/Settings: session, desktop, versions, backend per subsystem, capture success rate, black-frame rejections, last failure reason, helper status, keyring state, and extension state.
- **`tt-doctor`** (and `TimeTracker --doctor`): prints the same probe as text for support tickets, with fix hints ("log out and in to load the extension", "install gstreamer1.0-pipewire", "extensions disabled by policy: ask IT to allow timetracker@amzur.com").
- The login diagnostics payload gets the capability summary (no server change).
- **Logging rule:** window titles, OCR text and tokens are logged only at `debug` (per CLAUDE.md security notes).

---

## 7. GNOME Shell extension (`gnome-extension/`)

### 7.1 Purpose

The extension runs inside GNOME Shell, which is the only process that can see windows and pixels on GNOME Wayland. It gives our app two things through a private D-Bus interface: the focused window, and a capture of the focused window's monitor.

### 7.2 D-Bus interface

Exported on GNOME Shell's session-bus connection at object path `/com/amzur/TimeTracker/Shell`, interface `com.amzur.TimeTracker.Shell1`.

| Member | Signature | Behavior |
|---|---|---|
| `GetVersion` | `() → (u protocol, s ext_version, s shell_version)` | The app requires `protocol == 1`. |
| `GetFocusedWindow` | `() → a{sv}` | `title`, `wm_class`, `app_id` (`get_gtk_application_id` / `Shell.WindowTracker` app id), `pid`, `window_id` (stable `get_id()`), `monitor_index`, `monitor_rect`, `scale`, `minimized`, `fullscreen`, `is_locked` |
| `CaptureFocusedMonitor` | `(h fd, a{sv} options) → a{sv}` | Writes the frame into the passed fd. Returns `status`, `width`, `height`, `stride`, `format`, `scale`, `monitor_index`, `window_id`, `title` |
| `FocusChanged` | signal `(a{sv})` | On focus change and on title change of the focused window (`notify::title`) |

### 7.3 Behavior and security (all required)

1. **Caller authentication:** for each call, `GetConnectionUnixProcessID(sender)` → `readlink /proc/<pid>/exe`. Accept only `/opt/timetracker/TimeTracker`, or the `--user` install path recorded at install time. Anything else gets `AccessDenied`. This stops casual reuse of a silent screenshot service by other programs.
2. **Focused monitor only.** No arbitrary-rectangle method.
3. **Rate limit** in the extension: 1 capture per 5 s.
4. **Refuse while locked** (`Main.sessionMode.isLocked` / screen shield active) → `status=locked`.
5. `focus_window == null` → `no_focus`. Minimized → `minimized`.
6. Capture via `Shell.Screenshot.screenshot_area(monitor rect, stream)` with the cursor excluded, written into a `Gio.UnixOutputStream` on the passed fd. No flash and no sound, because those are added only by GNOME's public screenshot D-Bus service, which we do not call. **To be proven in phase 0 on GNOME 42, 46, 49 and 50.** If a future GNOME changes this, the plan B is `screenshot_stage_to_content` / an offscreen paint of the monitor.
7. **Visible and honest:** it is listed in the Extensions app as "TimeTracker Integration – lets TimeTracker read the active window and the active monitor for on-device OCR". It is mentioned on the consent page and in the privacy policy.

### 7.4 Versions, install, updates

| Build | GNOME | Module style | Distros |
|---|---|---|---|
| `legacy` | 42–44 | `imports.gi`, `init/enable/disable` | Ubuntu 22.04, Debian 12 (GNOME 43) |
| `esm` | 45–50 (each new version added after the headless test passes) | ES modules, `export default class extends Extension` | Ubuntu 24.04/26.04, Fedora 39+, RHEL 10, Debian 13 |

- One source tree, and `build.sh` emits both builds. `metadata.json` lists the exact `shell-version` values.
- **Enabling:** on first run the app calls `org.gnome.Shell.Extensions.EnableExtension` and also adds the id to `org.gnome.shell enabled-extensions`. The package manager cannot do this, because there is no user session during install.
- **Wayland requires one logout/login** before a newly installed extension loads. Until then the app uses the portal ScreenCast fallback and shows one notification: "Log out and back in once to finish TimeTracker setup".
- **Policy blocks** (`disable-user-extensions=true`, locked `enabled-extensions`) are detected. The app stays on the portal fallback, says so in Settings, and the IT guide documents how to allow `timetracker@amzur.com`.
- **Backward compatibility:** after a package update, GNOME runs the old extension until the next login. New app versions must work with the previous protocol. Methods and optional fields may only be added. `protocol` is bumped only for breaking changes, and the old protocol stays supported for at least one release.

---

## 8. Permissions and first-run experience

| Desktop | First run | After reboot / app update |
|---|---|---|
| X11 | Nothing | Nothing |
| GNOME with extension | "Log out and back in once" notification. Portal dialog until then (select monitors, "Remember"). | Nothing |
| GNOME with extensions blocked | Portal dialog once | Nothing, unless monitors change or permission is revoked |
| KDE | Nothing (the `.desktop` file grants ScreenShot2) | Nothing |
| Sway / Hyprland | Nothing | Nothing |
| Anything with no capture | Settings shows "Screen text capture unavailable: <reason>" | Tracking of title + time continues |

**Consent page Linux paragraph** (`render_consent_page`): TimeTracker reads the text on the monitor you are using, the picture stays on your computer and is never uploaded, some desktops ask once for screen access (select the monitors you work on and choose "Remember"), and a "screen sharing" icon may show while tracking is active and disappears when paused or idle.

---

## 9. Acceptance criteria

[auto] = automated test in CI. Others run on the manual matrix (§11).

**Platform seams and safety**

1. [auto] With no provider registered, every seam uses the existing Windows code path; the full Windows test suite passes unchanged.
2. [auto] On Linux no code path calls `PIL.ImageGrab`.
3. [auto] With `XDG_SESSION_TYPE=wayland` and `DISPLAY` set, the X11 capture and window backends are never selected.
4. [auto] If no window-info backend works, no activity sessions are uploaded, and the status reason is exposed in Settings and diagnostics.
5. [auto] Child processes (helper, `xdg-open`, `grim`, `nmcli`) are started without PyInstaller's `LD_LIBRARY_PATH`.

**Capture**

6. [auto] `FrameValidator` rejects all-black, flat gray, flat white, one-bright-pixel-on-black, black-RGBA-with-opaque-alpha, and > 50%-transparent frames, and accepts the dark-IDE and document fixtures.
7. [auto] After 5 consecutive failures or rejected frames, the service switches to the next backend and logs the reason. The preferred backend is retried after 30 min or on unlock.
8. [auto] A capture that exceeds the 1.5 s budget returns `None` to the tracking loop in ≤ 1.6 s, and its late result is dropped.
9. [auto] A frame whose capture-time window id differs from the expected window is discarded (`STALE_WINDOW`).
10. [auto] Unknown focused monitor → `SKIPPED_UNKNOWN_MONITOR`, and no image is returned. No backend ever returns more than one monitor.
11. [auto] Portal client: `persist_mode` and `restore_token` are sent in `SelectSources` (not `CreateSession`). Each `Start` token is saved. The `Response` subscription is made before the method call.
12. [auto] Portal soak (mocked PipeWire): 2,000 captures leave the helper's open-fd count unchanged.
13. [auto] GNOME extension: a call from an executable other than the installed binary gets `AccessDenied`. Locked session → `locked`. Headless `gnome-shell --headless --virtual-monitor` test for the esm and legacy builds.
14. On Ubuntu 24.04 and 26.04 GNOME Wayland with the extension: 200 captures in one working hour give **zero flashes, zero sounds, zero prompts**, and ≥ 99% valid frames, focused monitor only.
15. On GNOME with extensions blocked: one prompt at first run, none after reboot or app update. The sharing indicator is shown only while tracking. ≥ 99% valid frames.
16. On Kubuntu (Plasma 6 Wayland): no prompt, no flash, ≥ 99% valid frames of the active screen.
17. On Linux Mint 22 (X11) and Ubuntu 22.04 Xorg: silent, focused monitor only, with two monitors attached.
18. On Sway and Hyprland: silent, focused output only.
19. Two monitors at different scales (150% + 100%): the focused monitor is captured correctly on every Tier 1 desktop.
20. OCR text length and confidence on the standard test page at 100/125/150/200% are within 10% of the Windows 100% baseline.
21. Median capture ≤ 300 ms on a 1440p monitor for every backend. < 1% average CPU between captures with the ScreenCast stream running on a static screen.
22. No captured image is written to disk (`inotifywait` on `$HOME`, `/tmp`, `$XDG_RUNTIME_DIR` during a capture session).

**Window info, idle, events**

23. [auto] Window-service unit tests for every backend with fake D-Bus/IPC: title, app, app_id, pid, monitor; generic runtimes (`java`, `electron`) resolve to the app id.
24. [auto] X11 integration (Xvfb + WM): the focused-window title and a non-black crop of the correct monitor.
25. [auto] Sway headless (`WLR_BACKENDS=headless`): focus events and `grim` capture.
26. On every Tier 1 desktop, window switches create sessions with the correct title and app for a full working day. There are no "Unknown" sessions except for true no-focus periods.
27. On GNOME Wayland and KDE Wayland, typing only in native Wayland apps for 30 min produces **no** idle record. 10 min without input produces one idle record, as on Windows.
28. Lock → capture and tracking stop within 5 s. Unlock → they resume without a prompt. Suspend/resume → an idle record for the sleep period. Shutdown → the open session is saved (delay inhibitor observed with `systemd-inhibit --list`).

**Platform plumbing**

29. [auto] The DB/token key is identical whether the app starts from a terminal or from autostart, and after a hostname change. The old derivation is migrated once.
30. [auto] A second launch does not start a second instance, and a crash leaves no stale lock.
31. [auto] Linux mail/chat clients in `REDACTED_BODY_PROCESSES` have their OCR body redacted, same as Outlook on Windows.
32. [auto] Office subnet detection uses a real interface address, never `127.0.1.1`.
33. Notifications appear on GNOME, KDE, Cinnamon, Xfce and Sway (mako), and action buttons open the right page where supported.
34. On a GNOME without a tray host, the app is reachable via the app launcher and the start notification, and the status is visible in the web UI.
35. A locked keyring at autostart does not block startup for more than 5 s.

**Packaging and update**

36. [auto] The `.deb` and `.rpm` install, run `--self-test`, and uninstall cleanly in clean containers of every distro in §2 item 4.
37. [auto] The build fails if RapidOCR models, the spaCy model, SQLCipher, or `secretstorage` are missing from the bundle.
38. An update from N to N+1 through the APT/YUM repo on Ubuntu 24.04 and Fedora needs no password prompt and restarts the app into N+1 with the session saved.
39. The installed extension build matches the GNOME version. After a distro upgrade that changes the build (22.04 → 24.04), the app detects the mismatch and tells the user.
40. "Remove my data and sign out" deletes the data dir and keyring entries and disables autostart.

---

## 10. Testing strategy

| Level | What | Where |
|---|---|---|
| Unit | Every backend with fake jeepney connections / fake subprocess / fake IPC sockets; validator fixtures; selection table driven by env + `/etc/os-release` fixtures; key derivation; aliases and redaction lists | `linux-desktop-app/tests/`, pytest, runs on any Linux CI runner |
| Core seam | Windows paths unchanged without a provider | `python-desktop-app/tests/test_platform_hooks.py` |
| Headless integration | Xvfb + openbox (X11); `gnome-shell --headless --virtual-monitor` + extension (both builds, in Ubuntu 22.04 and 26.04 images); Sway headless + grim; dbus-run-session with a mock portal and a mock logind (`python-dbusmock`) | CI containers |
| Package | Install / self-test / uninstall matrix (§6.14 step 6) | CI containers |
| Soak | 8 h run on GNOME Wayland (fd count, RSS, CPU, capture success rate) | Nightly on a lab VM with GPU passthrough |
| Manual matrix | All non-[auto] criteria, 100/125/150/200% scaling, two monitors, NVIDIA + Intel, lock/suspend/shutdown, first-run, update | §11 machines |

---

## 11. Support matrix

**Tier 1 (release-gating, every release):**

| Distribution | Desktop | Session | Window | Capture | Idle |
|---|---|---|---|---|---|
| Ubuntu 26.04 LTS | GNOME 50 | Wayland | Extension (esm) | Extension → Portal | Mutter |
| Ubuntu 24.04 LTS | GNOME 46 | Wayland | Extension (esm) | Extension → Portal | Mutter |
| Ubuntu 22.04 LTS | GNOME 42 | Xorg and Wayland | EWMH / Extension (legacy) | X11 / Extension → Portal | XSS / Mutter |
| Linux Mint 22 | Cinnamon | X11 | EWMH | X11 | XSS |
| Fedora (current) | GNOME 49/50, no tray by default | Wayland | Extension | Extension → Portal | Mutter |

**Tier 2 (tested before major releases; bugs fixed but not release-blocking):** Kubuntu / Fedora KDE (Plasma 6 Wayland), Debian 12/13 GNOME, RHEL/Alma 9 and 10 GNOME, openSUSE Tumbleweed (KDE), Xubuntu (X11), Pop!_OS.

**Tier 3 (best effort):** Sway, Hyprland, labwc, other wlroots, COSMIC, Arch/Manjaro (tarball), immutable distros (`--user` tarball).

**Unsupported:** Flatpak/Snap packaging, non-systemd distributions without elogind, sessions where the user refuses capture (title + time still tracked; OCR off with a visible reason), and ARM64 until phase 7.

Ubuntu 22.04 standard support ends in April 2027. Plan to drop the legacy extension build then.

---

## 12. Phases

Estimates are for one developer who knows the codebase. Each phase gets its own short spec in `linux-desktop-app/plan/` and failing tests before code, per the workflow.

| Phase | Work | Exit criteria | Estimate |
|---|---|---|---|
| **0. Spikes** | Throwaway scripts on real machines: (a) extension `screenshot_area` has no flash or sound on GNOME 42/46/49/50, plus timing and resolution vs scale; (b) portal restore token on GNOME 42 and 46; (c) KWin `CaptureActiveScreen` authorization with a PyInstaller binary in `/opt`; (d) ScreenCast `always-copy` on NVIDIA; (e) `ext-idle-notify` via pywayland on KWin 6 and Sway; (f) PyInstaller one-dir build on AlmaLinux 8 starting on Ubuntu 26.04 and Fedora | A results table appended to this plan. Design adjusted where a spike fails. | 1–1.5 weeks |
| **1. Seams + shared-core fixes** | `platform_hooks.py`, the guards in §5.2, shared window-switch helper, `notify()` helper; OCR fixes O-1…O-5 and platform-aware OCR fallback (separate `python-desktop-app` spec) | AC 1, Windows suite green, OCR fixes tested | 2 weeks |
| **2. Linux skeleton + X11 end to end** | `timetracker_linux` package, probe, diagnostics, X11 window/capture/idle, logind events, notifications, flock, autostart, XDG paths, key derivation, location, aliases and redaction lists, Linux spec and container build, `.deb`/`.rpm`/tarball | AC 2–10, 17, 22–24, 29–33, 36–37; a full day of correct records on Mint 22 and 22.04 Xorg | 3 weeks |
| **3. GNOME Wayland** | Extension (esm + legacy), GNOME window + capture backends, Mutter idle, enable/logout flow, policy detection, consent text | AC 13, 14, 19, 26–28 on Ubuntu 24.04/26.04 and Fedora | 3–4 weeks |
| **4. Session helper + portal ScreenCast + tray** | Helper process and supervisor, ScreenCast done right, AT-SPI fallback, AppIndicator tray, no-tray fallback, re-allow flow | AC 11, 12, 15, 34 | 2.5 weeks |
| **5. KDE + wlroots** | KWin script + ScreenShot2, Sway/Hyprland IPC, grim, ext-idle-notify | AC 16, 18, 25 | 2 weeks |
| **6. Updates, hardening, matrix** | Signed APT/YUM repos, update flow, "Remove my data", scale calibration, soak test, IT/admin deployment guide, `tt-doctor`, full manual matrix | AC 20, 21, 35, 38–40; Tier 1 green | 2.5 weeks |
| **7. (Optional) aarch64** | Second build and matrix | Tier 1 on aarch64 | 1.5 weeks |

**Total:** about **16–18 weeks** for Tier 1 + Tier 2. A **first release covering X11 + GNOME** (phases 0–4 and the GNOME/X11 parts of 6) is about **11–12 weeks**.

**Ongoing:** about 1 week per GNOME release (March and September; test on Fedora six months before the Ubuntu LTS), and 1–2 weeks per Ubuntu LTS. The watch list: GNOME extension porting guides, xdg-desktop-portal releases, KWin ScreenShot2/scripting changes, wlroots `ext-image-copy-capture`, and PyInstaller/onnxruntime glibc floors.

---

## 13. Risks and open decisions

| # | Risk / decision | Likelihood | Mitigation / recommendation |
|---|---|---|---|
| R1 | A future GNOME adds a flash or permission check inside `Shell.Screenshot` | Low | Offscreen stage paint as plan B; portal fallback already built; test on Fedora first |
| R2 | IT departments block user extensions | Medium | Portal fallback; IT guide with the allow-list key |
| R3 | Portal restore tokens unreliable on GNOME 42 | Medium | Extension preferred on GNOME; 22.04 users on Xorg use X11; rate-limited re-allow |
| R4 | KWin refuses ScreenShot2 for our binary | Medium | `Exec=` real binary; phase 0 spike; portal fallback |
| R5 | System `python3-gi` missing on minimal installs | Low | Declared dependency; probe reports it; core tracking works without the helper |
| R6 | glibc 2.28 build breaks a dependency (spaCy, onnxruntime, SQLCipher wheels) | Low–Medium | Phase 0 (f); raise the floor to 2.31 (Debian 11/Ubuntu 20.04) if required and document it |
| R7 | Users uneasy about the sharing indicator | Medium | Stream only while tracking; consent text |
| R8 | Shared-core seams accidentally change Windows behavior | Low | AC 1; seams are guards around unchanged code |
| D-A | **Confirm D1** (shared core + seams, not a fork) | – | Recommended. A fork doubles every future fix. |
| D-B | **Confirm D8** (repo-based updates vs root updater timer) | – | Repo, unless mandatory silent updates on the Windows schedule are a hard requirement |
| D-C | **Confirm the support promise** in §11 | – | Publish §11 exactly instead of "all Linux" wording |
| D-D | Should the extension also draw a panel indicator (a tray on vanilla GNOME without the AppIndicator extension)? | – | Nice to have, in phase 6 if time allows |

---

## 14. Out of scope

- Any change to `ai-server/`, `supabase/` (other than a reviewed `app_releases` row) or `forge-app/`.
- Uploading screenshots (stays hard-disabled: `SCREENSHOT_MONITORING_HARD_DISABLED = True`).
- Flatpak, Snap and AppImage distribution.
- Desktops with neither a Wayland portal nor X11.
- Non-systemd distributions without elogind.
- macOS.
- A full refactor of `desktop_app.py` beyond the seams in §5.2.
- Precise (GPS/GeoClue) location on Linux.
- The Linux download button in the Forge app (existing plan `plan/LINUX_DOWNLOAD_BUTTON_IMPLEMENTATION_PLAN_DEB.md`; independent of this work).

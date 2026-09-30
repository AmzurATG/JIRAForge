# Phase 1a: Linux Foundation (seams, capture framework, platform basics)

**Date:** 2026-09-29
**Parent plan:** [2026-09-29_linux-desktop-app_implementation-plan.md](2026-09-29_linux-desktop-app_implementation-plan.md) (phases 1 and 2)
**Components:** `python-desktop-app/` (seams only), `linux-desktop-app/` (new package)

## Problem

Nothing Linux-specific exists yet. Before any desktop backend (X11, GNOME, KDE) can be written, the shared core needs a way to hand platform work to a Linux provider. The Linux side needs the pieces every backend relies on:

- environment detection,
- a capture framework that never blocks tracking and never passes a bad frame to OCR,
- single-instance locking, stable key material, XDG paths, and a clean child-process environment.

Two current behaviors are also wrong on Linux and must be fixed first:

1. `monitor_capture.capture_focused_monitor()` calls a bare `ImageGrab.grab()` on non-Windows ([monitor_capture.py:349-354](../../python-desktop-app/monitor_capture.py#L349-L354)). That captures all monitors on X11 (breaking the P0-2 privacy rule) and returns black frames on Wayland.
2. The OCR engine list is the same on every OS. A config such as `primary=winrtocr, fallback=[]` would leave Linux with no OCR at all.

## Root cause / context

- `desktop_app.py` and `monitor_capture.py` branch on `win32gui` imports. There is no extension point for another platform.
- The plan decided (D1) that Linux code lives in `linux-desktop-app/` and the core gets small registry-based seams. With nothing registered, the Windows code path must be unchanged.
- The OCR decision (plan §3.2 and §6.8, 2026-09-29): one shared config, with Windows-only engines filtered out on Linux and `rapidocr` guaranteed.

## Proposed solution

### Shared core (`python-desktop-app/`)

1. **`platform_hooks.py`**: `register(provider)`, `get()`, `clear()`. A process-wide registry with no dependencies.
2. **`monitor_capture.capture_focused_monitor()`**:
   - If a provider is registered, return `provider.capture_focused_monitor()`. Exceptions become `None`.
   - Otherwise, on non-Windows, return `None` and count the call as Tier 3. The bare `ImageGrab.grab()` passthrough is removed.
   - The Windows branch is unchanged.
3. **`monitor_capture.get_capture_status()`**: returns the provider's last status, or `None`.
4. **`ocr/config.py` → `resolve_engines_for_platform(primary, fallbacks, platform=sys.platform)`**:
   - On Windows it returns the input unchanged.
   - Elsewhere it drops engines in `WINDOWS_ONLY_ENGINES = {'winrtocr', 'winrt'}`.
   - If the primary was dropped, the first remaining fallback is promoted.
   - If nothing is left, `rapidocr` becomes the primary.
   - Used by `OCRConfig.from_env()` and `OCRConfig.from_dict()`.

### Linux package (`linux-desktop-app/timetracker_linux/`)

5. **`environment.py`**:
   - `detect(environ, os_release_text) → Environment`, a pure function with fields `session_type`, `desktop` (`gnome`, `kde`, `sway`, `hyprland`, `wlroots`, `cinnamon`, `xfce`, `mate`, `other`), `desktop_raw`, `distro_id`, `distro_version`, `distro_pretty`.
   - `session_type` is `x11` **only** when `XDG_SESSION_TYPE == 'x11'`. When `XDG_SESSION_TYPE` is missing, `WAYLAND_DISPLAY` means `wayland`, and `DISPLAY` alone means `x11`.
   - `probe_dbus(env)` adds live facts through jeepney (GNOME Shell version, KWin presence, portal ScreenCast version, extension state). Every call has a timeout, and a failure only leaves that fact empty.
6. **`capture/result.py`**: `CaptureStatus` enum and a `CaptureResult` dataclass (plan §6.4).
7. **`capture/validator.py`**: `FrameValidator.check(image, expected_size=None) → CaptureStatus`, using the rules in plan §6.5.
8. **`capture/service.py`**: `CaptureService(backends, budget_s=1.5, failure_threshold=5, retry_preferred_after_s=1800, clock)`:
   - Runs backends on a worker thread and enforces the budget.
   - Validates frames.
   - Discards frames whose `window_id` differs from the expected id (`STALE_WINDOW`).
   - After `failure_threshold` consecutive failures, moves to the next backend.
   - Retries the preferred backend after `retry_preferred_after_s` or when `reprobe()` is called.
   - Skip statuses (`SKIPPED_*`) are not failures.
9. **`capture/backends/base.py`** (`CaptureBackend` protocol) and **`capture/backends/null.py`**.
10. **`single_instance.py`**: `fcntl.flock(LOCK_EX | LOCK_NB)` on `$XDG_RUNTIME_DIR/timetracker/instance.lock`. It falls back to the data dir when `XDG_RUNTIME_DIR` is unset.
11. **`machine_key.py`**: `username()` via `pwd.getpwuid(os.getuid())`, and `machine_id()` from `/etc/machine-id`, then `/var/lib/dbus/machine-id`, then `None`.
12. **`paths.py`**: XDG data/config/state/runtime dirs for TimeTracker, created with mode `0700`.
13. **`childenv.py`**: `clean_env(environ)` restores `LD_LIBRARY_PATH_ORIG` (or removes `LD_LIBRARY_PATH`), and does the same for the other PyInstaller-modified variables.
14. **`provider.py`**: a `LinuxPlatformProvider` that implements `capture_focused_monitor()` / `get_capture_status()` with `CaptureService`. At this stage the only backend is Null. Later phases add the window, idle and session-event methods.
15. **`__main__.py`** + **`doctor.py`**: `python -m timetracker_linux --doctor` prints the detected environment and probe. Starting the app (registering the provider, then calling `desktop_app.main()`) comes in phase 1b, when the window/idle seams exist.

## Acceptance criteria

1. With no provider registered, `platform_hooks.get()` returns `None`. After `register(p)` it returns `p`, and `clear()` resets it.
2. With a provider registered, `capture_focused_monitor()` returns exactly what the provider returns, and returns `None` if the provider raises.
3. On non-Windows with no provider, `capture_focused_monitor()` returns `None`, **never calls `ImageGrab`**, and increments `tier3_skipped`.
4. On Windows the engine list is unchanged, including `winrtocr`.
5. On Linux `winrtocr` is removed from primary and fallbacks. A removed primary is replaced by the first remaining fallback. An empty result gives `rapidocr` as the primary. `rapidocr` is never duplicated.
6. `OCRConfig.from_env()` and `OCRConfig.from_dict()` apply rule 5 on Linux.
7. `detect()` never returns `x11` when `XDG_SESSION_TYPE=wayland`, even with `DISPLAY` set.
8. `detect()` classifies the desktop family correctly for these `XDG_CURRENT_DESKTOP` values: `ubuntu:GNOME`, `GNOME`, `KDE`, `sway`, `Hyprland`, `labwc:wlroots`, `X-Cinnamon`, `XFCE`, `MATE`, `Pop:COSMIC`. It parses `/etc/os-release`.
9. `probe_dbus()` returns partial results without raising when the bus or a service is missing.
10. `FrameValidator` rejects: all-black RGB; all-black RGBA with alpha 255; black with one white pixel; flat gray; flat white; RGBA more than 50% transparent; a size mismatch over 2 px. It accepts a synthetic dark-theme text image and a light document image.
11. `CaptureService` returns within budget + 0.1 s when a backend hangs, and the late result is not used.
12. After 5 consecutive failures (errors or rejected frames), the next backend is used. Skip statuses do not count.
13. The preferred backend is retried after `retry_preferred_after_s` (with an injected clock) and after `reprobe()`.
14. A frame whose `window_id` differs from the expected id is discarded as `STALE_WINDOW`.
15. The second `acquire()` of the instance lock in another process fails. After that process dies, the lock is free again.
16. `machine_key.username()` works without a controlling terminal or `USER`/`USERNAME`. `machine_id()` reads the first existing file.
17. `paths` creates directories with mode `0700` and respects the `XDG_*` overrides.
18. `clean_env()` restores `LD_LIBRARY_PATH_ORIG`, removes `LD_LIBRARY_PATH` when there is no original, and leaves other variables untouched.

## Tests

- `python-desktop-app/tests/test_platform_hooks.py`: AC 1–3
- `python-desktop-app/tests/test_ocr_platform_engines.py`: AC 4–6
- `linux-desktop-app/tests/test_environment.py`: AC 7–9
- `linux-desktop-app/tests/test_frame_validator.py`: AC 10
- `linux-desktop-app/tests/test_capture_service.py`: AC 11–14
- `linux-desktop-app/tests/test_platform_basics.py`: AC 15–18

## Out of scope (next phases)

- Window-info, idle, lock and session-event seams in `desktop_app.py`, and the app launcher (phase 1b).
- X11, GNOME extension, KWin, wlroots and portal backends.
- Packaging and build.
- Key-derivation changes in `db_connection.py` and `auth/secure_storage.py`. This phase adds the Linux key material only. Wiring it in with the migration is phase 1b.
- OCR pipeline fixes O-1 to O-5 (separate `python-desktop-app` spec).

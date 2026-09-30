# Phase 1b: Core seams, launcher and Linux desktop services

**Date:** 2026-09-29
**Parent plan:** [2026-09-29_linux-desktop-app_implementation-plan.md](2026-09-29_linux-desktop-app_implementation-plan.md), §5.2, §6.3, §6.6, §6.7, §6.9–§6.13 (phases 1 and 2)
**Builds on:** [phase 1a](2026-09-29_linux-desktop-app_phase1-foundation.md)

## Problem

The shared core still calls Win32 for the focused window, idle time, lock state, lock/sleep/shutdown events, single instance, autostart, self-install, updates, location, app metadata, tray and notifications. Without a registered provider, a Linux run tracks one "Unknown" window, marks working users idle on Wayland, never sees lock or sleep, drops every notification, and loses the final session on logout (SIGTERM skips `atexit`).

## Root cause / context

The call sites and their Windows mechanisms are listed in plan §22. Two findings from reading the code shape the design:

- **Tray.** The tray code uses the `pystray` API throughout (`Icon`, `Menu`, `MenuItem`, `icon.menu = …`, `run(setup=…)`). pystray selects its backend from `PYSTRAY_BACKEND`, which names a module `pystray._<name>`. A Linux backend module registered under that name gives a working tray with **no change to the core tray code**.
- **Notifications.** The core uses `winotify` at 29 sites, three of which import it locally. It only uses `Notification(app_id, title, msg, duration)`, `set_audio()`, `add_actions(label, launch)` and `show()`. A Linux module with that API, registered as `winotify` by the launcher, delivers every notification over `org.freedesktop.Notifications` with **no change to the call sites**.

## Proposed solution

### A. Core seams (`python-desktop-app/`)

Each seam is a guard `p = platform_hooks.get(); if p is not None: …` around unchanged Windows code. Provider methods are optional: a missing method falls through to the existing code.

| Seam | Provider method | Core site |
|---|---|---|
| Focused window | `get_focused_window() → dict or None` | `get_active_window()`: only the three lines that read title and process are branched; the switch bookkeeping is shared |
| Lock state | `is_screen_locked() → bool` | `_is_screen_locked()` |
| Idle clock | `get_system_idle_seconds() → float or None` | `get_system_idle_seconds()` |
| Input hooks | `use_input_hooks() → bool` | `monitor_user_activity()`: when False, keep the heartbeat loop without pynput |
| Session events | `start_session_events(app) → bool` | `start_tracking()` starts the Win32 monitor or the provider |
| Event actions | — | The Win32 `wnd_proc` bodies move into `_on_system_sleep/_on_system_wake/_on_screen_lock/_on_screen_unlock/_on_system_shutdown`, called by both sources |
| Single instance | `acquire_single_instance()` / `release_single_instance()` | module functions |
| Autostart | `autostart_enable()` / `autostart_disable()` / `autostart_is_enabled()` | `add_to_startup` / `remove_from_startup` / `is_in_startup` |
| Self-install | `install_application() → bool` | `install_application()` (Linux: package manager owns files → True) |
| Update platform | `update_platform → 'linux'` | `check_for_updates()` query string |
| Update handling | `handle_update_available(app, info) → bool` | `check_for_app_updates()`: when handled, the Windows downloader is not used |
| Location | `get_wifi_ssid()`, `get_local_ip()` | `LocationDetector._get_current_ssid/_get_local_ip` |
| Process tables | `process_tables() → dict of sets/dict` | merged into `BROWSER_PROCESSES`, `REDACTED_BODY_PROCESSES`, `PROCESS_IDENTIFIER_ALIASES`, `BROWSER_PROCESS_NORMALIZED_KEYS` at import |
| Running-app search | `search_running_apps(term) → list` | `/api/search-running-app` |
| OCR worker priority | `lower_current_thread_priority()` | `LocalOCRProcessor._ocr_worker` |
| Key material | `machine_key_material() → str` | `db_connection._derive_machine_key`, `open_diagnostic_connection`, `auth/secure_storage._get_machine_salt/_get_machine_password` |
| Settings dir | `config_dir() → str` | `get_pause_settings_file_path()` |
| Display log | `log_display_environment()` | `monitor_capture.log_display_environment()` |
| Diagnostics | `diagnostics() → dict` | `send_login_diagnostics()` adds `system_info.linux` |

Also: the crash handler in `main()` only calls `input()` when stdin is a terminal (on Linux autostart it raised `EOFError`).

### B. Linux services (`linux-desktop-app/timetracker_linux/`)

1. **`dbus_bus.py`**: one shared jeepney threading router (`jeepney.io.threading`) for signals, method calls from any thread, and serving objects (tray, KWin callback). A reconnect is attempted when the bus drops.
2. **`session_events.py`**: logind `PrepareForSleep`, `PrepareForShutdown`, `Session.Lock/Unlock`, `LockedHint` changes, and `org.gnome.ScreenSaver` / `org.freedesktop.ScreenSaver` `ActiveChanged`. A delay inhibitor (`shutdown:sleep`) is held and released after the app's handler finishes (max 5 s). Duplicate lock signals from several sources are collapsed. `is_locked()` is cached from these sources and also polled from `LockedHint`.
3. **`idle.py`**: an `IdleService` over the backend chain from `selection.plan_for`. Implemented now: `mutter` (GNOME), `freedesktop_screensaver` (KDE, Xfce, …), `xss` (X11, python-xlib), `logind_idlehint`. A backend that errors 3 times is skipped. `None` when nothing works.
4. **`window/`**: a `WindowService` over the backend chain. Implemented now: `x11_ewmh` (python-xlib), `sway` (IPC socket), `hyprland` (IPC socket), `null`. Output keys: `title, app, app_id, wm_class, pid, window_id, monitor_name, monitor_rect, scale, minimized`. The app name uses the process name, except for generic runtimes (`java`, `python3`, `node`, `electron`, `bwrap`, …), where `app_id`/`wm_class` is used.
5. **`capture/backends/`**: `x11` (XRandR monitor with the largest overlap of the focused window; XShm/XGetImage of that monitor only) and `wlroots` (`grim -o <focused output>`, PPM on stdout, 3 s timeout, clean env).
6. **`compat/winotify.py`**: the `winotify` API over `org.freedesktop.Notifications`. Actions are supported when the server advertises them; `ActionInvoked` opens the `launch` URL with `xdg-open` (clean env).
7. **`compat/pystray_sni.py`**: a pystray backend implementing StatusNotifierItem + `com.canonical.dbusmenu` over jeepney. It registers with `org.kde.StatusNotifierWatcher` and re-registers when the watcher appears later. The launcher picks `PYSTRAY_BACKEND`: `sni` when a session bus exists, else `xorg` on X11, else `dummy`.
8. **`autostart.py`**: `~/.config/autostart/com.amzur.timetracker.desktop` (`Exec` = installed binary or the dev command).
9. **`location.py`**: SSID via NetworkManager D-Bus, then `nmcli`. Local IP from the default-route interface (`/proc/net/route` + `psutil.net_if_addrs`), never `127.x`.
10. **`app_identity.py`**: Linux process tables (browsers, mail/chat redaction, aliases) and `.desktop` lookup (`Name=`, `Icon=`, `StartupWMClass`) for the running-app search.
11. **`updates.py`**: `handle_update_available` shows one notification per version: "installed by your system updater". For mandatory updates it sets `app.update_required = True`, so the existing mandatory pause applies.
12. **`launcher.py`** (`python -m timetracker_linux`, and the frozen entry point): acquire nothing itself. It sets `PYSTRAY_BACKEND` and registers `winotify`, builds and installs the provider, installs a SIGTERM/SIGHUP handler (raise `SystemExit` in the main thread so `atexit` flushes), prepares XDG dirs, then calls `desktop_app.main()`. **If no window-info backend works, it does not start tracking.** It shows a notification and serves only the local web UI with the reason.

## Acceptance criteria

1. [core] With no provider, each seam runs the existing code: tested by patching Windows helpers and asserting they are called.
2. [core] With a provider, `get_active_window()` returns the provider's title and app and sets `is_new_window` only when `app|||title` changes. A `None` window returns the `unknown` dict without a switch.
3. [core] `_is_screen_locked()` and `get_system_idle_seconds()` return the provider values.
4. [core] With `use_input_hooks() == False`, `monitor_user_activity()` never imports pynput and keeps the heartbeat fresh.
5. [core] The Win32 handlers and the provider call the same `_on_*` methods; `_on_screen_lock` calls `enter_idle('screen lock')`, and `_on_screen_unlock` creates the idle record and sets the resume event (identical to the old `wnd_proc`).
6. [core] `check_for_updates()` uses `platform=linux` with a provider. `check_for_app_updates()` does not call the Windows downloader when the provider handles the update.
7. [core] Provider process tables are merged, and existing Windows entries remain.
8. [core] `_derive_machine_key` and the secure-storage salt/password use `machine_key_material()` when a provider exists, and the Windows derivation is unchanged otherwise.
9. `SessionEvents` maps logind/ScreenSaver signals to the app's `_on_*` methods, collapses duplicate lock/unlock, and holds and releases a delay inhibitor around shutdown and sleep.
10. `IdleService` returns the first working backend's value, skips a backend after 3 errors, and returns `None` when nothing works. The Mutter reply is converted from ms to s.
11. `WindowService` (EWMH, sway, hyprland) parses fixtures into the common dict; generic runtimes resolve to `app_id`.
12. The X11 capture backend picks the monitor with the largest overlap and never grabs a rect larger than that monitor. `wlroots` passes `-o <focused output>` and the clean env.
13. The `winotify` adapter sends `Notify` with the right fields, maps `duration` to a timeout, adds the actions only when supported, and opens the launch URL on `ActionInvoked`.
14. The SNI tray serves `GetLayout` from a pystray `Menu` (labels, enabled, separators), invokes the menu item on `Event('clicked')`, and emits `LayoutUpdated` when the menu is replaced.
15. Autostart writes, detects and removes the `.desktop` file with the right `Exec`.
16. `get_local_ip()` never returns a loopback address. The SSID is parsed from NetworkManager and `nmcli` output.
17. The launcher installs a SIGTERM handler, registers the provider and adapters before importing `desktop_app`, and refuses to track when no window backend is available.
18. On this machine (GNOME 46 Wayland): the doctor shows the Mutter idle clock returning a number, logind `LockedHint` = false, and the notification server capabilities (read-only checks, nothing shown on screen).

## Out of scope

- GNOME extension, KWin script, portal ScreenCast and AT-SPI helper (phases 3–5). Until then, GNOME Wayland has **no window backend**, so the launcher refuses to track there (AC 17). This is the intended behavior.
- Packaging and build (phase 6).
- Tk popup changes (they keep working through XWayland where available).

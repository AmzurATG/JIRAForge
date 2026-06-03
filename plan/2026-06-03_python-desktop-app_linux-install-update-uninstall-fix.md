# Linux Install / Auto-Update / Uninstall — Root Cause Analysis & Fix Plan

**Date:** 2026-06-03
**Component:** `python-desktop-app` — `desktop_app.py`
**Status:** ✅ All fixes implemented

---

## Problem Statement

Three separate but related defects were reported for the Linux desktop app:

1. **Manual upgrade**: When a user downloads a new AppImage (v2) and double-clicks it, the old installed version (v1) is not removed — v2 runs alongside v1, or v2 is blocked by v1's lock file.
2. **Auto-update**: The auto-update mechanism replaces the binary, but does it really remove the old version? Does the autostart `.desktop` entry stay correct after an update?
3. **Uninstall script**: When a user opens `~/.local/share/TimeTracker/` and tries to run an uninstall script manually, nothing happens — because no `uninstall.sh` existed there at all.

---

## Bug 1 — Manual AppImage Double-Click Does Not Replace Old Version

### Root Cause

`install_application()` (line 1428) had this guard at the top:

```python
if IS_APPIMAGE:
    print("[INFO] Running as AppImage - skipping self-installation")
    return True   # ← bails out immediately, zero install logic
```

When the user double-clicked the new v2 AppImage, `IS_APPIMAGE=True` (because `$APPIMAGE` env var is set by the AppImage FUSE runtime), so the function exited with `return True` before doing anything. Consequences:

| Outcome | Why |
|---|---|
| v2 runs from `~/Downloads/TimeTracker-v2.AppImage` | No copy to canonical location happened |
| v1 process still running in background | Nothing terminated it |
| v2 often fails to start at all | `acquire_single_instance_lock()` finds v1 holding `.lock` file → returns `False` → `run()` exits |
| After reboot, v1 launches from autostart | XDG autostart entry still points to old v1 canonical path |

The core insight: `sys.executable` for an AppImage points inside a FUSE mount (`/tmp/.mount_*/usr/bin/TimeTracker`) and cannot be `shutil.copy2`'d, so the Windows-style "copy the EXE" approach had been skipped entirely. But the fix is to copy the `.AppImage` **file on disk** (`os.environ['APPIMAGE']`), which is a plain regular file.

### Fix: `_install_appimage()` (line 1321)

A new function called by `install_application()` whenever `IS_APPIMAGE=True`. It:

1. **Reads `$APPIMAGE`** — the path to the actual `.AppImage` file on disk (e.g. `~/Downloads/TimeTracker-v2-x86_64.AppImage`).
2. **Compares to canonical path** (`~/.local/share/TimeTracker/TimeTracker.AppImage`). If they match, the app is already running from the right place → return `True`, continue normally.
3. If they differ (new version downloaded to Downloads, or first-run):
   - **Terminates existing old instance** via `find_running_timetracker_processes()` + `request_graceful_shutdown()` + `terminate_old_version()`.
   - **Copies new AppImage atomically**: `shutil.copy2` to a `.new` temp file, `chmod 755`, then `os.replace()` (atomic rename) to the canonical path — no partial state is ever visible.
   - **Generates `uninstall.sh`** at `~/.local/share/TimeTracker/uninstall.sh`.
   - **Relaunches** from the canonical path (`subprocess.Popen` with `start_new_session=True`, detached).
   - **Returns `False`** so `run()` calls `sys.exit(0)` on this "installer instance".

```python
# install_application() — before fix
if IS_APPIMAGE:
    return True   # ← bug: no-op

# install_application() — after fix
if IS_APPIMAGE:
    return _install_appimage()   # ← calls full install/upgrade logic
```

### Result After Fix

| Scenario | Behaviour |
|---|---|
| User double-clicks v2 AppImage for first time | v2 is installed to `~/.local/share/TimeTracker/`; v2 launches from canonical path; autostart entry created |
| User double-clicks v2 AppImage when v1 already running | v1 terminated gracefully (SIGTERM) then force-killed; v2 atomically replaces AppImage file; v2 relaunches from canonical |
| User double-clicks from canonical location (already installed) | Detected immediately, no re-install; startup continues normally |

---

## Bug 2 — Auto-Update Replaces Binary But Autostart Breaks

### Root Cause A — Non-Canonical `installed_binary` Path

`get_linux_installed_appimage_path()` (line 1122) previously returned `$APPIMAGE` (wherever the AppImage was first run from):

```python
# Before fix
def get_linux_installed_appimage_path():
    appimage_path = os.environ.get('APPIMAGE', '')
    if appimage_path and os.path.exists(appimage_path):
        return appimage_path  # ← returns ~/Downloads/TimeTracker-v1.AppImage
    return os.path.join(get_app_data_dir(), 'TimeTracker.AppImage')
```

The auto-updater (`UpdateManager`) called this to get `installed_binary`, then `create_linux_update_script()` overwrote that file with the new version. This meant:

- If the user first ran from `~/Downloads/TimeTracker-v1.AppImage`, the auto-update replaced that Downloads file **in place with the new version**.
- The canonical path `~/.local/share/TimeTracker/TimeTracker.AppImage` was **never touched**.
- The autostart `.desktop` entry (which the auto-updater also rewrote) pointed to the Downloads path.
- If the user later deleted the Downloads file, the autostart entry broke and the app stopped launching on boot.

### Root Cause B — Autostart Entry Not Refreshed After Update

Even in cases where the path was correct, `create_linux_update_script()` (line 1671) had no phase to update the XDG autostart `.desktop` entry after a successful binary replacement. If the entry ever pointed to a stale path, it stayed stale forever.

### Fix A: `get_linux_installed_appimage_path()` Always Returns Canonical Path (line 1122)

```python
def get_linux_installed_appimage_path():
    """Return the canonical install path of the AppImage.

    Always returns ~/.local/share/TimeTracker/TimeTracker.AppImage regardless
    of where the app was launched from ($APPIMAGE).
    """
    return os.path.join(get_app_data_dir(), 'TimeTracker.AppImage')
```

Now both the auto-updater and `_install_appimage()` operate on the same stable canonical path.

### Fix B: `create_linux_update_script()` — Phase 4: Update XDG Autostart (line 1671)

The update shell script now includes a Phase 4 after the binary is successfully replaced:

```bash
# === Phase 4: Update XDG autostart entry ===
mkdir -p "$AUTOSTART_DIR" 2>/dev/null || true
printf '[Desktop Entry]\nType=Application\nName=TimeTracker\n...\nExec=%s\n...' \
    "$INSTALLED" > "$AUTOSTART_FILE" \
    && log "Autostart entry updated: $INSTALLED" \
    || log "WARN: could not update autostart entry"
```

This ensures the `.desktop` entry always points to the canonical binary, even if the user previously ran the app from a Downloads path.

### Result After Fix

| Scenario | Behaviour |
|---|---|
| Auto-update fires | New AppImage downloaded to `~/.local/share/TimeTracker/updates/`; applied to `~/.local/share/TimeTracker/TimeTracker.AppImage`; autostart entry refreshed to same canonical path |
| Old version after update | `TimeTracker.AppImage.bak` backup cleaned up by update script; no stale file in Downloads |
| System reboot after update | XDG autostart launches `~/.local/share/TimeTracker/TimeTracker.AppImage` — always correct |

---

## Bug 3 — Uninstall Script Missing / Not Working

### Root Cause A — No Linux Uninstall Function Existed

`_generate_uninstaller_at_path()` (line 2239) only generated a **Windows `.bat`** file. There was no `_generate_linux_uninstaller_at_path()` function.

### Root Cause B — Install Path Never Called the Generator

Because `install_application()` returned early for AppImages (`return True`) before reaching the Windows code path that calls `_generate_uninstaller_at_path()`, the file was never generated. So `~/.local/share/TimeTracker/` had no uninstall script at all on Linux.

### Root Cause C — Even If a Script Existed, What Would It Do?

Without `_generate_linux_uninstaller_at_path()`, there was no specification of:
- Which binary to delete (`TimeTracker.AppImage`)
- Which XDG autostart file to remove (`~/.config/autostart/timetracker.desktop`)
- Which data files to remove (auth JSON, offline DB, consent, user cache, screenshots, logs)
- How to kill the running process
- How to self-delete the script and the install directory

### Fix: `_generate_linux_uninstaller_at_path()` (line 2144)

A new function generates a complete `uninstall.sh` bash script at `~/.local/share/TimeTracker/uninstall.sh`. The script:

```
[STEP 1/4] Stopping application if running
           pkill -f TimeTracker

[STEP 2/4] Removing autostart entry
           rm -f ~/.config/autostart/timetracker.desktop

[STEP 3/4] Waiting for app to fully close (2s)

[STEP 4/4] Removing application files
           TimeTracker.AppImage
           TimeTracker (legacy binary name)
           time_tracker_auth.json
           time_tracker_offline.db
           time_tracker_consent.json
           time_tracker_user_cache.json
           auth_metadata.json
           .lock
           .shutdown_signal
           updates/  screenshots/  logs/  (directories)

           Self-deletes uninstall.sh and rmdir the install dir
```

Features:
- **Confirmation prompt** before any action (`read -r -p "Are you sure? (y/N)"`) — prevents accidental data loss.
- **Runs without root** — everything lives in `~/.local/share/TimeTracker/` and `~/.config/autostart/`, no system-level paths.
- **Script made executable** (`chmod 755`) so double-click in a file manager works.
- **Self-deletes** — leaves no trace after uninstall (fires in background subprocess with 1s delay so the script can finish its last `echo`).

### How to Use the Uninstall Script

The script is created at install time (via `_install_appimage()` → `_generate_linux_uninstaller_at_path()`). To uninstall:

```bash
~/.local/share/TimeTracker/uninstall.sh
```

Or from a file manager: navigate to `~/.local/share/TimeTracker/`, right-click `uninstall.sh` → "Run as Program" (file manager must support executable scripts).

---

## Complete Change Summary

| Location | Change | Purpose |
|---|---|---|
| `get_linux_installed_appimage_path()` line 1122 | Always return canonical path | Ensure auto-update and autostart never drift to Downloads path |
| `_install_appimage()` line 1321 | **New function** — full install/upgrade flow for AppImages | Fix manual upgrade: terminate old, copy atomically, generate uninstaller, relaunch |
| `install_application()` line 1447 | `return _install_appimage()` instead of `return True` | Route AppImage startups through the new install logic |
| `_generate_linux_uninstaller_at_path()` line 2144 | **New function** — generates `uninstall.sh` | Create a working Linux uninstaller script |
| `create_linux_update_script()` line 1671 | Phase 4 added: refresh XDG autostart entry | Ensure autostart points to canonical path after every update |

---

## Sequence Diagrams

### Manual Upgrade (User Double-Clicks New AppImage)

```
User double-clicks ~/Downloads/TimeTracker-v2.AppImage
    │
    ▼
AppImage FUSE mount sets $APPIMAGE = ~/Downloads/TimeTracker-v2.AppImage
    │
    ▼
run() → install_application() → _install_appimage()
    │
    ├── current_norm != canonical_norm? YES → upgrade flow
    │
    ├── find_running_timetracker_processes() → [PID 1234 (v1)]
    │       request_graceful_shutdown() → writes .shutdown_signal
    │       time.sleep(1)
    │       terminate_old_version([PID 1234], timeout=10)
    │           SIGTERM → wait → SIGKILL if needed
    │       clear_shutdown_signal()
    │
    ├── shutil.copy2(~/Downloads/TimeTracker-v2.AppImage, ~/.../TimeTracker.AppImage.new)
    │   chmod(755)
    │   os.replace(.new → TimeTracker.AppImage)   ← atomic
    │
    ├── _generate_linux_uninstaller_at_path(~/.../uninstall.sh)
    │
    ├── subprocess.Popen([~/.../TimeTracker.AppImage], start_new_session=True)
    │       → v2 starts from canonical location
    │
    └── return False → run() → sys.exit(0)   ← installer instance exits
```

### Auto-Update Flow

```
UpdateManager detects new version available
    │
    ▼
Background download to ~/.local/share/TimeTracker/updates/TimeTracker-v2.AppImage
    │
    ▼
SHA256 checksum verified
    │
    ▼
User clicks "Update Now" (or mandatory update enforced)
    │
    ▼
create_linux_update_script(
    app_data_dir,
    current_pid,
    staged  = ~/.../updates/TimeTracker-v2.AppImage,
    installed = ~/.../TimeTracker.AppImage        ← canonical (fixed)
)
    │
    ▼
apply_update.sh launched detached
    │
    ├── Phase 1: wait for PID to exit (up to 5s) then SIGKILL
    ├── Phase 2: verify staged file exists
    ├── Phase 3: mv installed → installed.bak; cp staged → installed; chmod +x   (15 retries)
    ├── Phase 4: write ~/.config/autostart/timetracker.desktop with Exec=~/.../TimeTracker.AppImage
    ├── Phase 5: nohup ~/.../TimeTracker.AppImage &    ← v2 starts
    └── Phase 6: rm staged, rm backup, rm $0
```

### Uninstall Flow

```
User runs: ~/.local/share/TimeTracker/uninstall.sh
    │
    ▼
Confirmation prompt → user enters 'y'
    │
    ├── pkill -f TimeTracker
    ├── rm -f ~/.config/autostart/timetracker.desktop
    ├── sleep 2
    ├── rm -f TimeTracker.AppImage, time_tracker_auth.json, *.db, *.json, .lock, .shutdown_signal
    ├── rm -rf updates/ screenshots/ logs/
    │
    └── (sleep 1 && rm -f uninstall.sh && rmdir install_dir) &
        → self-deletes after 1s
```

---

## Testing Checklist

### Bug 1 — Manual Upgrade

- [ ] Run v1 AppImage from `~/Downloads/TimeTracker-v1.AppImage` → confirm it installs to `~/.local/share/TimeTracker/` and relaunches
- [ ] With v1 running from canonical path, double-click `~/Downloads/TimeTracker-v2.AppImage`
  - [ ] v1 process terminates (check `ps aux | grep TimeTracker`)
  - [ ] `~/.local/share/TimeTracker/TimeTracker.AppImage` is now v2 (check version in tray)
  - [ ] v2 launches from canonical path (log shows `[INFO] Running from canonical AppImage location`)
  - [ ] `~/Downloads/TimeTracker-v2.AppImage` untouched (not deleted)
- [ ] Double-clicking the same already-installed AppImage (same version) does nothing — app continues normally

### Bug 2 — Auto-Update Canonical Path

- [ ] Force an auto-update; after restart, check tray shows new version
- [ ] Check `cat ~/.config/autostart/timetracker.desktop` → `Exec=` points to `~/.local/share/TimeTracker/TimeTracker.AppImage`
- [ ] Delete `~/Downloads/TimeTracker-v*.AppImage` if present; reboot; confirm app still starts from autostart
- [ ] Check `ls ~/.local/share/TimeTracker/updates/` — staged `.AppImage` and `.bak` should be gone after clean update

### Bug 3 — Uninstall Script

- [ ] After first install, confirm `~/.local/share/TimeTracker/uninstall.sh` exists and is executable (`ls -la`)
- [ ] Run `~/.local/share/TimeTracker/uninstall.sh`, enter 'N' at prompt → no files deleted
- [ ] Run again, enter 'y' at prompt:
  - [ ] App process stops
  - [ ] `~/.config/autostart/timetracker.desktop` removed
  - [ ] `~/.local/share/TimeTracker/` no longer exists (or is empty)
  - [ ] `uninstall.sh` self-deleted
- [ ] After auto-update, re-run uninstall — confirm it still works (script is regenerated by `_install_appimage()` on each install)

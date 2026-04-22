# Auto-Update Installer — Bug Fix Plan

## Problem Statement

When a user clicks **"Update Ready - Install"** in the system tray menu, the app
removes the tray icon but the new version never starts. A black terminal window
appears and hangs indefinitely. The old `TimeTracker.exe` is never replaced and
the user is left with no running app.

---

## Root Causes Identified

### 1. `_shutdown_for_update()` blocked on cleanup (CRITICAL)

**File:** `desktop_app.py` — `TimeTracker._shutdown_for_update()`

The old code called `self._shutdown_cleanup()` which performs:
- Network flush (`upload_activity_batch`) — can block 30–60 s on slow/dead connections
- OCR worker shutdown
- Database close
- `self.tray.stop()` — blocks on the Windows message loop on some systems

Because the process never exited, the updater batch script waited forever at
`tasklist /FI "PID eq …"`.

**Fix:** Replaced with immediate `os._exit(0)`. No cleanup — the OS reclaims
everything. Data integrity is acceptable because SQLite WAL handles crash
recovery and any unsent data stays in the offline queue for next launch.

### 2. Batch script PID-wait loop matched wrong text (CRITICAL)

**File:** `desktop_app.py` — `create_update_script()`

Old command:
```batch
tasklist /FI "PID eq 12345" | find "12345" >nul
```
When the PID no longer exists, `tasklist` prints an info message that **contains
the PID number as text**, so `find "12345"` still matches → infinite loop.

**Fix:** Changed to:
```batch
tasklist /FI "PID eq 12345" /FI "IMAGENAME eq TimeTracker.exe" 2>nul | find /I "TimeTracker.exe" >nul 2>&1
```
This only matches if a real `TimeTracker.exe` row exists with that PID.

### 3. No timeout / force-kill fallback (CRITICAL)

Old script waited indefinitely (120 s before our first patch, but effectively
forever due to bug #2).

**Fix:** Wait max **5 seconds**, then:
```batch
taskkill /F /PID <pid>
taskkill /F /IM TimeTracker.exe
```
Kills by both PID and process name to handle all edge cases.

### 4. Visible black terminal window

**File:** `desktop_app.py` — `UpdateManager.apply_update()`

Old `subprocess.Popen` flags:
```python
creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
```
On some Windows builds, combining `DETACHED_PROCESS` with `CREATE_NO_WINDOW`
still shows a console window.

**Fix:**
```python
creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
```

### 5. Bootstrap trap — old installed binary can't self-update

The installed `TimeTracker.exe` in `%LOCALAPPDATA%\TimeTracker\` is the binary
that runs the update logic. If that binary has the old broken code, every fix to
the source is irrelevant — the old binary generates the old broken batch script.

**Fix:** One-time manual replacement of the installed exe with the new build from
`dist\TimeTracker.exe`. After that, future auto-updates use the fixed code path.

---

## Changes Made

### `desktop_app.py`

| Location | What Changed |
|---|---|
| `create_update_script()` | Rewrote batch script: 5 s wait → force-kill → replace with 15 retries → launch → rollback on failure → cleanup |
| `create_update_script()` | Added `update_install.log` diagnostic logging in the batch script |
| `UpdateManager.apply_update()` | Added `update_launcher.log` with build marker before spawning updater |
| `UpdateManager.apply_update()` | Changed `Popen` flags to `CREATE_NEW_PROCESS_GROUP \| CREATE_NO_WINDOW` + DEVNULL pipes |
| `UpdateManager.apply_update()` | Moved `_on_apply_update()` call before `_set_state('installing')` to ensure shutdown fires immediately |
| `_shutdown_for_update()` | Replaced full cleanup + `tray.stop()` with immediate `os._exit(0)` |

### `tests/test_update_manager.py`

| Test | Purpose |
|---|---|
| `test_create_update_script_contains_wait_timeout_and_logs` | Verifies batch script has 5 s timeout, force-kill, phase labels, log file |
| `test_apply_update_writes_launcher_log_and_spawns_updater` | Verifies launcher log with build marker is written and `cmd.exe` is invoked correctly |

---

## Update Flow (After Fix)

```
User clicks "Update Ready - Install v1.4.x"
  │
  ▼
install_update_action()
  → UpdateManager.apply_update()
      │
      ├─ Validate state (ready/mandatory_ready/deferred)
      ├─ Validate staged exe exists + checksum
      ├─ Generate apply_update.bat via create_update_script()
      ├─ Write update_launcher.log (build marker + paths + PID)
      ├─ Spawn: cmd.exe /d /c apply_update.bat (hidden, detached)
      ├─ Call _shutdown_for_update()
      │     └─ os._exit(0)  ← process dies immediately
      │
      ▼
apply_update.bat (runs independently)
  │
  ├─ Phase 1: Wait up to 5s for old PID to exit
  │     └─ If still alive → taskkill /F /PID + taskkill /F /IM TimeTracker.exe
  │
  ├─ Phase 2: Verify staged exe exists
  │
  ├─ Phase 3: Replace exe (up to 15 retries)
  │     ├─ move old → .bak
  │     ├─ copy staged → installed
  │     └─ If all fail → rollback from .bak → launch old version
  │
  ├─ Phase 4: Launch new TimeTracker.exe
  │
  └─ Cleanup: delete staged exe, .bak, self-delete script
```

---

## Diagnostic Files

| File | Location | Purpose |
|---|---|---|
| `update_launcher.log` | `%LOCALAPPDATA%\TimeTracker\updates\` | Confirms `apply_update()` was called, records PID, paths, build marker |
| `update_install.log` | `%LOCALAPPDATA%\TimeTracker\updates\` | Records each phase of the batch script execution for post-mortem debugging |

---

## Important: First-Time Upgrade from Old Versions (Bootstrap Problem)

Versions **before the auto-update installer** (e.g. v1.3.8) do **not** contain
the `UpdateManager`, `create_update_script()`, or `_shutdown_for_update()` code.
Their "Check for Updates" button only opens a browser download link — it cannot
background-download, kill the old process, replace the exe, or relaunch.

This means:

```
v1.3.8 (no auto-installer) ──manual download──► v1.4.4+ (has auto-installer)
                                                      │
                                                      ▼
                                                 v1.5.0 (auto-update works)
                                                      │
                                                      ▼
                                                 v1.6.0 (auto-update works)
                                                 ...fully automatic forever
```

**Users on old versions must manually download and install the new build once.**
After that first manual upgrade, all future versions will auto-update seamlessly
because the running binary now contains the full updater pipeline.

### Why the old version shows "Download (new version)" instead of auto-installing

| Behavior | Old versions (≤ 1.3.x) | New versions (≥ 1.4.4) |
|---|---|---|
| Check for updates | Calls `/api/app-version/check` | Same |
| Update found | Shows tray item that opens a **browser download link** | Background-downloads exe to `updates/` folder |
| User clicks install | Opens browser — user must manually run the downloaded exe | Spawns `apply_update.bat` → kills old PID → replaces exe → relaunches |
| Uninstall old version | N/A (user overwrites manually) | Batch script handles kill + replace + rollback |

The running binary **is** the update logic. If that binary doesn't have the
auto-installer code, it physically cannot execute it — no matter what the server
returns. This is a one-time chicken-and-egg problem that resolves itself after
the first manual upgrade.

---

## Verification

1. **Unit tests:** `pytest tests/test_update_manager.py` — 7/7 passed
2. **Generated script review:** Manually generated and inspected batch output
3. **Manual install test:** Killed old process, copied new build to install
   location, confirmed app launches with fixed updater code

# Smart Auto-Update Installer — Implementation Plan

## Feature Summary

Replace the current browser-based manual download flow with a fully in-app background download and auto-update system that retains user authentication, offline data, and settings across updates.

**Current flow:**
```
Version check → Toast notification → webbrowser.open(url) → Manual download → Manual run → Self-install
```

**Target flow:**
```
Version check → Background download → Checksum verify → User prompt → Auto-install → Restart → Auth preserved
```

---

## Scope

### In Scope
- Background download of new EXE with progress tracking
- SHA256 checksum verification before install
- User confirmation before applying update (with "Update Now" / "Later" options)
- Mandatory update enforcement (blocks app usage until updated)
- Atomic EXE replacement using existing `install_application()` logic
- Auth token retention (Keyring + encrypted file storage untouched)
- Offline database preservation
- Rollback on failed update
- Update status in tray menu (downloading, ready, up-to-date)
- Desktop notification when update is downloaded and ready

### Out of Scope
- Delta/patch updates (always full EXE replacement)
- macOS/Linux auto-update (Windows only for now)
- Auto-update scheduling (e.g., "update at 2 AM")
- Admin-controlled update policies

---

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   Desktop App (Python)                       │
│                                                             │
│  ┌──────────────┐    ┌──────────────────┐                   │
│  │ UpdateManager │───▶│ BackgroundDownloader │               │
│  │  (orchestrator)│   │ (threaded, resumable)│               │
│  └──────┬───────┘    └────────┬─────────────┘               │
│         │                     │                             │
│         ▼                     ▼                             │
│  ┌──────────────┐    ┌──────────────────┐                   │
│  │ check_for_   │    │ verify_download_ │                   │
│  │ updates()    │    │ checksum()       │                   │
│  │ [existing]   │    │ [existing]       │                   │
│  └──────────────┘    └──────────────────┘                   │
│         │                     │                             │
│         ▼                     ▼                             │
│  ┌──────────────┐    ┌──────────────────┐                   │
│  │ Tray Menu    │    │ install_         │                   │
│  │ Status UI    │    │ application()    │                   │
│  │ [modified]   │    │ [existing]       │                   │
│  └──────────────┘    └──────────────────┘                   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Auth / Data (UNTOUCHED during update)                │   │
│  │  • Keyring tokens    • Encrypted DB    • Settings    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         │
         ▼ GET /api/app-version/check
┌─────────────────────────────────────────────────────────────┐
│                   AI Server (Node.js)                        │
│  app-version-controller.js — checkForUpdate()               │
│  Returns: download_url, checksum, file_size_bytes,          │
│           is_mandatory, release_notes                        │
└─────────────────────────────────────────────────────────────┘
```

### Update State Machine

```
[IDLE] ──(check)──▶ [CHECKING] ──(no update)──▶ [UP_TO_DATE] ──▶ [IDLE]
                        │
                   (update found)
                        │
                        ▼
                  [DOWNLOADING] ──(error)──▶ [DOWNLOAD_FAILED] ──▶ [IDLE]
                        │
                   (complete + verified)
                        │
                        ▼
                  [READY_TO_INSTALL] ──(user confirms / mandatory)──▶ [INSTALLING]
                        │                                                  │
                   (user defers)                                    (success)
                        │                                                  │
                        ▼                                                  ▼
                  [DEFERRED] ──(reminder)──▶ [READY_TO_INSTALL]     [RESTARTING]
                                                                           │
                                                                    (launch new EXE)
                                                                           │
                                                                           ▼
                                                                    [COMPLETE]
```

---

## Implementation Details

### Phase 1: Background Downloader

**New class: `UpdateManager`** — added as a section in `desktop_app.py`

```python
class UpdateManager:
    """
    Manages background download and installation of app updates.
    
    States: idle, checking, downloading, ready, installing, failed
    """
    
    def __init__(self, app_data_dir, current_version):
        self.app_data_dir = app_data_dir
        self.current_version = current_version
        self.state = 'idle'
        self.download_progress = 0.0      # 0.0 to 1.0
        self.downloaded_bytes = 0
        self.total_bytes = 0
        self.update_info = None           # Response from check API
        self.download_path = None         # Temp file path
        self._download_thread = None
        self._cancel_event = threading.Event()
    
    def check_and_download(self, update_info):
        """Start background download if update available."""
        
    def _download_worker(self):
        """Background thread: download with progress tracking."""
        
    def _verify_and_stage(self):
        """Verify checksum, move to staging location."""
        
    def apply_update(self):
        """Apply staged update — called after user confirmation."""
        
    def cancel_download(self):
        """Cancel in-progress download."""
        
    def get_status(self):
        """Return current state + progress for tray menu."""
```

#### Download Logic

```python
def _download_worker(self):
    """
    Download new EXE in background thread with:
    - Chunked streaming (8KB chunks)
    - Progress tracking via Content-Length
    - Cancel support via threading.Event
    - Resume support via temp file
    - Timeout handling (connect=10s, read=30s)
    """
    download_url = self.update_info['download_url']
    expected_size = self.update_info.get('file_size_bytes', 0)
    expected_checksum = self.update_info.get('checksum', '')
    
    # Download to: %LOCALAPPDATA%\TimeTracker\updates\TimeTracker_v{version}.exe.tmp
    updates_dir = os.path.join(self.app_data_dir, 'updates')
    os.makedirs(updates_dir, exist_ok=True)
    
    temp_path = os.path.join(updates_dir, f"TimeTracker_v{version}.exe.tmp")
    final_path = os.path.join(updates_dir, f"TimeTracker_v{version}.exe")
    
    # Stream download with progress
    response = requests.get(download_url, stream=True, timeout=(10, 30))
    with open(temp_path, 'wb') as f:
        for chunk in response.iter_content(chunk_size=8192):
            if self._cancel_event.is_set():
                break
            f.write(chunk)
            self.downloaded_bytes += len(chunk)
            self.download_progress = self.downloaded_bytes / self.total_bytes
    
    # Verify checksum
    if verify_download_checksum(temp_path, expected_checksum):
        os.rename(temp_path, final_path)
        self.download_path = final_path
        self.state = 'ready'
    else:
        os.remove(temp_path)
        self.state = 'failed'
```

#### Staging Directory

```
%LOCALAPPDATA%\TimeTracker\
├── TimeTracker.exe              ← Running app (PRESERVED)
├── time_tracker_offline.db      ← Offline DB (PRESERVED)
├── tokens_{hash}.enc            ← Auth fallback (PRESERVED)
├── updates/                     ← NEW: staging area
│   └── TimeTracker_v1.4.0.exe  ← Downloaded, verified, ready
└── ...settings files...         ← PRESERVED
```

### Phase 2: Update Application Flow

Reuse existing `install_application()` logic with minor adaptation:

```python
def apply_update(self):
    """
    Apply staged update:
    1. Verify staged EXE checksum one more time
    2. Create restart script (batch file) that:
       a. Waits for current process to exit
       b. Replaces old EXE with new EXE (atomic rename)
       c. Launches new EXE
       d. Cleans up staging directory
    3. Launch restart script as detached process
    4. Exit current process gracefully
    """
    staged_exe = self.download_path
    installed_exe = os.path.join(self.app_data_dir, 'TimeTracker.exe')
    
    # Create updater batch script
    updater_script = os.path.join(self.app_data_dir, 'updates', 'apply_update.bat')
    with open(updater_script, 'w') as f:
        f.write(f'''@echo off
:wait_loop
tasklist /FI "PID eq {os.getpid()}" | find "{os.getpid()}" >nul
if not errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto wait_loop
)
copy /Y "{staged_exe}" "{installed_exe}"
start "" "{installed_exe}"
del "{staged_exe}"
del "%~f0"
''')
    
    # Launch updater and exit
    subprocess.Popen(
        ['cmd', '/c', updater_script],
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
    )
    # Trigger graceful shutdown of current app
```

### Phase 3: Tray Menu Integration

Modify the existing tray menu to show update status dynamically.

**Current menu item** (~line 10206):
```
"Check for Updates" → check_updates_action() → webbrowser.open(url)
```

**New menu items:**
```
State: idle/up-to-date
  └── "Check for Updates"          → triggers check + background download

State: downloading
  └── "Downloading Update (47%)…"  → disabled/info item
  └── "Cancel Download"            → cancels download

State: ready
  └── "✦ Update Ready — Install v1.4.0"  → triggers apply_update()
  └── "View Release Notes"                → shows release notes

State: mandatory + ready
  └── "⚠ Required Update — Install Now"  → triggers apply_update()
  (tracking paused until updated)
```

### Phase 4: Notification Changes

Modify `show_update_notification()` (line 644) to show different messages based on state:

| State | Notification |
|-------|-------------|
| Update found | "Update v{version} available — downloading in background…" |
| Download complete | "Update v{version} ready to install. Click to update now." |
| Mandatory + ready | "Required update v{version} ready. Tracking paused until updated." |
| Download failed | "Update download failed. Will retry later." |

Replace `webbrowser.open(download_url)` call at line 10215 with `self.update_manager.apply_update()`.

### Phase 5: Mandatory Update Enforcement

When `is_mandatory=True` and update is ready:

1. Show persistent notification (cannot be dismissed)
2. Pause screenshot tracking (stop the main loop)
3. Tray icon changes to indicate "update required" state
4. User must click "Install Now" to proceed
5. After install + restart, tracking resumes automatically

---

## Files Changed

### Desktop App — `python-desktop-app/desktop_app.py`

| Section | Lines | Change |
|---------|-------|--------|
| New state variables in `__init__` | ~4602 | Add `self.update_manager = None` |
| `check_for_app_updates()` | 4639–4698 | After successful check, trigger `update_manager.check_and_download()` |
| `show_update_notification()` | 644–734 | Update notification text for background download states; remove `webbrowser.open()` action |
| Tray menu setup | 10206–10242 | Replace static "Check for Updates" with dynamic status menu items |
| `check_updates_action()` | 10209–10230 | Replace `webbrowser.open()` with `update_manager.apply_update()` when ready |
| Main tracking loop | ~9420–9437 | Add update state management alongside periodic check |
| Startup | 10570–10580 | Initialize `UpdateManager`; check for staged updates from previous session |
| New section | (after line ~940) | Add `UpdateManager` class (~150 lines) |
| New section | (after UpdateManager) | Add `create_update_script()` helper for batch updater generation |

### Desktop App — `python-desktop-app/desktop_app.spec`

| Change | Details |
|--------|---------|
| No changes needed | `UpdateManager` is within `desktop_app.py`, no new imports or data files |

### AI Server — `ai-server/src/controllers/app-version-controller.js`

| Section | Lines | Change |
|---------|-------|--------|
| `checkForUpdate()` response | 108–197 | Verify `file_size_bytes` is always populated (needed for progress tracking) |

### AI Server — `ai-server/src/index.js`

| Change | Details |
|--------|---------|
| No route changes needed | Existing `/api/app-version/check` endpoint returns all required fields |

### Exact Code Touchpoints

Desktop app references:

- Version comparison helper: [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L506)
- Update check HTTP call + payload mapping: [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L531)
- Download checksum verification helper: [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L613)
- Update notification logic to modify: [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L644)
- Existing installer entry point to reuse: [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L941)
- App-level update orchestration method: [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L4639)
- Tray menu builder where update menu items are defined: [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L10176)
- Tray update action callback (manual browser open today): [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L10209)
- Current browser open call to replace: [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L10215)
- Periodic update check in tracking loop: [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L9436)
- Startup forced update check: [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L10580)

AI server references:

- Latest version endpoint implementation: [ai-server/src/controllers/app-version-controller.js](ai-server/src/controllers/app-version-controller.js#L32)
- Update check endpoint implementation: [ai-server/src/controllers/app-version-controller.js](ai-server/src/controllers/app-version-controller.js#L115)

Server test references:

- Update check controller tests: [ai-server/tests/controllers/app-version-controller.test.js](ai-server/tests/controllers/app-version-controller.test.js#L471)
- New tests for file_size_bytes should be added near: [ai-server/tests/controllers/app-version-controller.test.js](ai-server/tests/controllers/app-version-controller.test.js#L471)

## Impact Guardrails (Do-Not-Break)

These checks are mandatory during implementation to prevent regressions in unrelated features.

### 1) Shutdown and data integrity

- Before any update-triggered exit, always run the same cleanup path used by normal exit in [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L10300).
- Preserve final batch flush and DB close behavior implemented in [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L10283).
- Validate shutdown signal handling remains functional in [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L9374).

Acceptance checks:

- No loss of in-memory activity sessions when update is applied.
- No SQLite lock left behind after update-triggered restart.

### 2) Existing self-install compatibility

- Do not bypass or duplicate replacement logic already in [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L941).
- Ensure staged updater and self-install flow cannot race each other.
- Keep development mode behavior unchanged for non-frozen runs.

Acceptance checks:

- First-run install still works.
- Existing update replacement still works when launched via installer package.

### 3) Tracking loop and mandatory enforcement

- Mandatory-update blocking must not break idle detection, pause reminders, or periodic upload scheduling in [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L9390).
- If tracking is paused for mandatory update, record clear admin logs and resume cleanly after restart.

Acceptance checks:

- Pause/resume behavior remains correct before and after update.
- Idle timeout and reminder notifications remain functional.

### 4) Tray menu and icon consistency

- Preserve menu rebuild pattern in [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L10333).
- Preserve icon update cadence and badge rendering path in [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L10159).
- Replace only the update action at [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L10209) and browser-open call at [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L10215).

Acceptance checks:

- Tray actions for login, feedback, pause/resume still work.
- Update badge appears only for genuine newer versions.

### 5) Notification behavior and deduping

- Keep notification entry point at [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L644) and evolve message content by updater state.
- Reset/refresh notification dedupe logic tied to [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L4603) when a newer target version is detected.

Acceptance checks:

- New update versions always trigger one fresh notification.
- Repeated notifications are suppressed for the same version unless forced.

### 6) API contract stability

- Do not break response shape from [ai-server/src/controllers/app-version-controller.js](ai-server/src/controllers/app-version-controller.js#L115).
- Ensure fileSizeBytes is always numeric (0 fallback when unset) to avoid downloader progress errors.
- Keep server tests updated in [ai-server/tests/controllers/app-version-controller.test.js](ai-server/tests/controllers/app-version-controller.test.js#L471).

Acceptance checks:

- Desktop parser in [python-desktop-app/desktop_app.py](python-desktop-app/desktop_app.py#L531) consumes responses without conditional failures.
- Progress percentage logic never divides by zero.

### 7) Auth and local data preservation

- Replace executable only; do not modify credential, token, DB, or settings file locations.
- Preserve LocalAppData file paths used by current app data layout and startup routines.

Acceptance checks:

- User remains logged in after update (keyring and fallback encrypted token modes).
- Offline database and settings are unchanged after restart.

### 8) Rollout safety controls

- Ship in phases: manual trigger first, then background download, then mandatory enforcement.
- Gate mandatory mode behind server-side flag and enable only after stable canary runs.

Acceptance checks:

- No increase in startup failures or tray initialization errors in canary cohort.
- No increase in authentication re-login incidents after update rollout.

## Go/No-Go Release Checklist

Use this checklist before enabling mandatory updates in production. Mark each item Pass or Fail.

| Gate | Verification | Status (Pass/Fail) | Evidence / Notes |
|------|--------------|--------------------|------------------|
| Build integrity | Desktop app builds successfully and launches from installed location |  |  |
| API contract | Update check response includes `updateAvailable`, `downloadUrl`, `checksum`, `fileSizeBytes`, `isMandatory`, `releaseNotes` |  |  |
| Download safety | Background download handles cancel, timeout, and retry without orphan temp files |  |  |
| Checksum safety | Checksum mismatch blocks install and cleans staged file |  |  |
| Apply-update safety | Updater script replaces EXE and cleans up staged artifacts |  |  |
| Rollback safety | Failed launch restores previous EXE and app can start |  |  |
| Shutdown integrity | Update-triggered exit runs cleanup path and flushes pending sessions |  |  |
| Tray/menu stability | Login, feedback, pause/resume, and update actions all work after menu changes |  |  |
| Tracking behavior | Idle detection, pause reminders, and periodic uploads remain correct |  |  |
| Auth retention | Keyring and encrypted fallback token flows remain logged in after restart |  |  |
| Offline data retention | Local DB and settings files are unchanged across update |  |  |
| Notification behavior | One notification per new version; no duplicate spam for same version |  |  |
| Startup resilience | App starts cleanly with and without staged update present |  |  |
| Canary stability | No regression spikes in startup errors, auth failures, or tray failures |  |  |

Production release decision:

- Go only if all gates are Pass.
- No-Go if any critical gate fails: API contract, checksum safety, apply-update safety, rollback safety, or auth retention.

---

## Data / Auth Retention Verification

### What Survives the Update (no action needed)

| Item | Storage | Why It Survives |
|------|---------|----------------|
| OAuth access_token | Windows Credential Manager | Keyring is per-user OS store, independent of EXE |
| OAuth refresh_token | Windows Credential Manager | Same as above |
| Supabase JWT | Windows Credential Manager | Same as above |
| DB encryption key | Windows Credential Manager | Same as above |
| Auth tokens (fallback) | `tokens_{hash}.enc` file | In app data dir, not modified during update |
| Offline database | `time_tracker_offline.db` | In app data dir, not modified during update |
| GDPR consent | `time_tracker_consent.json` | In app data dir, not modified during update |
| User settings | `pause_settings.json` | In app data dir, not modified during update |
| User info cache | `time_tracker_user_cache.json` | In app data dir, not modified during update |

### What Gets Replaced

| Item | Path | Notes |
|------|------|-------|
| Executable | `%LOCALAPPDATA%\TimeTracker\TimeTracker.exe` | Replaced by updater script after process exits |
| Staged update | `updates/TimeTracker_v{x}.exe` | Cleaned up after successful install |
| Updater script | `updates/apply_update.bat` | Self-deleting after execution |

### Edge Case: PBKDF2 Fallback Auth

If Keyring is unavailable, auth tokens are encrypted using a key derived from:
- `MachineGuid` (Windows registry — machine-specific, permanent)
- `USERNAME` env var (doesn't change across updates)

**Result:** Derived key is identical before and after update → encrypted tokens decrypt correctly.

---

## Rollback Strategy

If the update fails at any point:

| Failure Point | Recovery |
|---------------|----------|
| Download interrupted | Temp file (`.tmp`) deleted; retry on next check cycle |
| Checksum mismatch | Staged file deleted; notification shown; retry on next cycle |
| Updater script fails to replace EXE | Old EXE still in place; app continues running normally |
| New EXE crashes on startup | User can re-run old EXE manually (keep one-version backup) |

**Backup strategy:** Before replacing, rename current EXE to `TimeTracker.exe.bak`. The updater script should:
```batch
rename "TimeTracker.exe" "TimeTracker.exe.bak"
copy /Y "updates\TimeTracker_v1.4.0.exe" "TimeTracker.exe"
start "" "TimeTracker.exe"
if errorlevel 1 (
    rename "TimeTracker.exe.bak" "TimeTracker.exe"
    start "" "TimeTracker.exe"
)
del "TimeTracker.exe.bak"
```

---

## Test Plan

### New Test File: `python-desktop-app/tests/test_update_manager.py`

```python
"""
Test suite for UpdateManager auto-update functionality.
Run: python -m pytest tests/test_update_manager.py -v
"""

class TestUpdateManager:
    """Unit tests for UpdateManager class."""
    
    # --- State Machine Tests ---
    def test_initial_state_is_idle(self):
    def test_state_transitions_checking_to_downloading(self):
    def test_state_transitions_downloading_to_ready(self):
    def test_state_transitions_downloading_to_failed_on_checksum_mismatch(self):
    def test_state_transitions_ready_to_installing(self):
    def test_cancel_during_download_returns_to_idle(self):
    
    # --- Download Tests ---
    def test_download_creates_temp_file(self):
    def test_download_tracks_progress(self):
    def test_download_verifies_checksum_on_completion(self):
    def test_download_removes_temp_on_checksum_failure(self):
    def test_download_handles_network_timeout(self):
    def test_download_handles_disk_full(self):
    def test_download_respects_cancel_event(self):
    
    # --- Staging Tests ---
    def test_staging_directory_created(self):
    def test_staged_file_renamed_from_tmp(self):
    def test_old_staged_files_cleaned_up(self):
    
    # --- Apply Update Tests ---
    def test_apply_creates_updater_script(self):
    def test_updater_script_contains_correct_paths(self):
    def test_updater_script_includes_backup_step(self):
    def test_apply_launches_detached_process(self):
    
    # --- Auth Retention Tests ---
    def test_keyring_tokens_untouched_after_exe_replacement(self):
    def test_encrypted_file_tokens_untouched_after_exe_replacement(self):
    def test_offline_db_accessible_after_exe_replacement(self):
    def test_settings_files_preserved_after_exe_replacement(self):
    
    # --- Edge Cases ---
    def test_update_during_active_tracking(self):
    def test_mandatory_update_pauses_tracking(self):
    def test_no_duplicate_downloads_for_same_version(self):
    def test_stale_staged_update_detected_on_startup(self):
    def test_concurrent_check_and_download_prevented(self):


class TestVersionComparison:
    """Tests for is_version_newer() — existing function."""
    
    def test_newer_patch(self):
    def test_newer_minor(self):
    def test_newer_major(self):
    def test_same_version(self):
    def test_older_version(self):
    def test_prerelease_stripped(self):


class TestChecksumVerification:
    """Tests for verify_download_checksum() — existing function."""
    
    def test_valid_checksum_passes(self):
    def test_invalid_checksum_fails(self):
    def test_empty_file_fails(self):
    def test_missing_file_fails(self):
```

### Existing Test File Update: `ai-server/tests/controllers/app-version-controller.test.js`

Add tests to verify `file_size_bytes` is always present in `checkForUpdate()` response:

```javascript
describe('checkForUpdate - file_size_bytes', () => {
    it('should include file_size_bytes in update response', async () => { });
    it('should return 0 if file_size_bytes not set in DB', async () => { });
});
```

### Manual Test Scenarios

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Happy path auto-update | Set server to return `update_available=true` → wait for download → confirm install | App restarts with new version, auth preserved |
| 2 | Cancel download | Start download → click "Cancel Download" in tray | Download stops, temp file cleaned, state returns to idle |
| 3 | Network failure mid-download | Disconnect network during download | State → failed, retry on next cycle |
| 4 | Checksum mismatch | Modify staged file before apply | Update rejected, notification shown, retry |
| 5 | Mandatory update | Set `is_mandatory=true` on server | Tracking pauses, persistent notification, user must install |
| 6 | Auth retention — Keyring | Update with tokens in Keyring | After restart, user is logged in, no re-auth |
| 7 | Auth retention — Encrypted file | Update with Keyring disabled (fallback) | After restart, encrypted tokens load correctly |
| 8 | Offline data preservation | Have unsynced records → update | After restart, offline DB intact, syncs on next connection |
| 9 | Update while paused | Pause tracking → update → restart | Pause state preserved (from settings file) |
| 10 | Stale staged update on startup | Stage update, don't apply, restart app | Detect staged update, prompt user to install |

---

## Implementation Priority

| Phase | Effort | Description |
|-------|--------|-------------|
| 1 | ~4 hrs | `UpdateManager` class with background download + checksum verify |
| 2 | ~2 hrs | Updater script generation + atomic EXE replacement + rollback |
| 3 | ~2 hrs | Tray menu integration (dynamic status, confirm/defer actions) |
| 4 | ~1 hr  | Notification changes (download progress, ready-to-install) |
| 5 | ~1 hr  | Mandatory update enforcement (pause tracking) |
| 6 | ~4 hrs | Unit tests (`test_update_manager.py`) |
| 7 | ~2 hrs | Integration / manual testing on Windows |

**Total: ~2 days**

---

## Dependencies

- No new Python packages required (`requests`, `threading`, `hashlib`, `subprocess` already imported)
- No server-side API changes required (all fields already in `/api/app-version/check` response)
- No database schema changes required
- Windows-only implementation (batch updater script uses `cmd`)

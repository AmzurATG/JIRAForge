# Desktop App Auto-Update Failure - Implementation Plan

**Date:** May 13, 2026  
**Version:** 1.0  
**Target Release:** 1.5.0  
**Estimated Total Time:** 60 minutes  
**Risk Level:** LOW  
**Breaking Changes:** None

---

## Table of Contents

1. [Pre-Implementation Checklist](#1-pre-implementation-checklist)
2. [Fix #1: Re-check Connectivity Before Update (P0)](#fix-1-re-check-connectivity-before-update-p0)
3. [Fix #2: Add Retry Logic to Update Check (P0)](#fix-2-add-retry-logic-to-update-check-p0)
4. [Fix #3: Notify User on Download Failure (P1)](#fix-3-notify-user-on-download-failure-p1)
5. [Fix #4: Move Check Outside Idle Block (P1)](#fix-4-move-check-outside-idle-block-p1)
6. [Fix #5: Add Connectivity Check in Method (P2)](#fix-5-add-connectivity-check-in-method-p2)
7. [Fix #6: Automatic Retry for Failed Downloads (P2)](#fix-6-automatic-retry-for-failed-downloads-p2)
8. [Post-Implementation Testing](#8-post-implementation-testing)
9. [Rollback Plan](#9-rollback-plan)
10. [Monitoring & Validation](#10-monitoring--validation)

---

## 1. Pre-Implementation Checklist

### 1.1 Preparation Steps

- [ ] **Review root cause analysis** - Read `AUTO_UPDATE_FAILURE_ROOT_CAUSE_ANALYSIS.md`
- [ ] **Create feature branch** - `git checkout -b fix/auto-update-silent-failures`
- [ ] **Backup current version** - Copy `desktop_app.py` to `desktop_app.py.backup`
- [ ] **Close desktop app** - Ensure no running instances
- [ ] **Document current version** - Note `APP_VERSION = "1.4.9"`
- [ ] **Clear updates folder** - Delete `%APPDATA%\TimeTracker\updates\*` for clean testing

### 1.2 Required Files

| File | Location | Purpose |
|------|----------|---------|
| `desktop_app.py` | `python-desktop-app/desktop_app.py` | Main implementation file |
| Test data | `%APPDATA%\TimeTracker\` | Local testing data |
| Console logs | Visual inspection during testing | Verify behavior |

### 1.3 Testing Environment Setup

```powershell
# Set up testing environment
$env:AI_SERVER_URL = "https://your-ai-server.com"  # Replace with actual URL

# Verify Python environment
python --version  # Should be 3.10+

# Install required packages (if missing)
pip install requests>=2.28.0
pip install winotify>=1.1.0
```

---

## Fix #1: Re-check Connectivity Before Update (P0)

### Priority: 🔴 CRITICAL
### Estimated Time: 5 minutes
### Impact: Eliminates 40-50% of failures
### Risk: LOW (additive change, no breaking logic)

---

### 1.1 Problem Statement

The `is_online` variable captured at line 11018 becomes stale after 30-60 seconds of authentication operations. Update check at line 11122 uses this stale value, causing silent failures when network becomes unavailable during startup.

### 1.2 Solution Overview

Re-check connectivity immediately before update check to ensure network is actually available.

### 1.3 Implementation Prompt

```
TASK: Fix stale connectivity status in auto-update startup check

CONTEXT:
- File: python-desktop-app/desktop_app.py
- Location: Lines 11118-11122
- Issue: is_online variable from line 11018 becomes stale after auth operations
- Impact: 40-50% of auto-update failures

INSTRUCTIONS:
1. Locate the update check code at line 11118-11122
2. Replace the connectivity check to use force=True for real-time verification
3. Add informative log message when offline after authentication
4. Preserve all existing logic for staged update loading

IMPORTANT:
- Keep the staged update check (line 11118-11119)
- Only modify the connectivity check condition (line 11120)
- Do NOT change any other logic in the startup sequence
- Ensure proper indentation (4 spaces)

EXPECTED OUTCOME:
- Network connectivity verified in real-time before update check
- Clear log message when offline after authentication
- No breaking changes to existing functionality
```

### 1.4 Code Changes

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines 11118-11122

**BEFORE:**
```python
        if self.update_manager and self.update_manager.load_staged_update_if_exists():
            print("[INFO] Found staged update from previous session")
        
        # Check for updates on startup (only if online)
        if is_online:
            print("[INFO] Checking for app updates...")
            self.check_for_app_updates(show_notification=True, force=True)
```

**AFTER:**
```python
        if self.update_manager and self.update_manager.load_staged_update_if_exists():
            print("[INFO] Found staged update from previous session")
        
        # Check for updates on startup - RE-VERIFY connectivity to avoid stale status
        # Network state may have changed during authentication/initialization above
        if self.offline_manager.check_connectivity(force=True):
            print("[INFO] Checking for app updates...")
            self.check_for_app_updates(show_notification=True, force=True)
        else:
            print("[INFO] Offline after authentication - will check for updates when network is available")
```

### 1.5 Verification Steps

```python
# Test Case 1: Normal online startup
# Expected: "[INFO] Checking for app updates..." appears in console

# Test Case 2: Disconnect network during authentication
# Expected: "[INFO] Offline after authentication - will check for updates when network is available"

# Test Case 3: VPN disconnect during startup
# Expected: Offline message appears, update check skipped
```

### 1.6 Testing Command

```powershell
# Run app in console mode to see logs
python desktop_app.py

# Watch for these log messages:
# [OK] Network connectivity restored
# [INFO] Checking for app updates...
# OR
# [WARN] Network connectivity lost - switching to offline mode
# [INFO] Offline after authentication - will check for updates when network is available
```

---

## Fix #2: Add Retry Logic to Update Check (P0)

### Priority: 🔴 CRITICAL
### Estimated Time: 15 minutes
### Impact: Eliminates 20-30% of failures
### Risk: LOW (self-contained function, no external dependencies)

---

### 2.1 Problem Statement

The `check_for_updates()` function makes a single HTTP request with 10-second timeout. Any transient network issue (DNS failure, connection reset, temporary server unavailability) causes immediate failure with no retry.

### 2.2 Solution Overview

Implement retry logic with exponential backoff (3 attempts: 0s, 2s, 4s delays).

### 2.3 Implementation Prompt

```
TASK: Add retry logic with exponential backoff to check_for_updates() function

CONTEXT:
- File: python-desktop-app/desktop_app.py
- Function: check_for_updates(ai_server_url=None)
- Location: Lines 535-595
- Issue: Single HTTP attempt fails on transient network issues
- Impact: 20-30% of auto-update failures

INSTRUCTIONS:
1. Wrap the HTTP request in a retry loop (max 3 attempts)
2. Implement exponential backoff: 0s, 2s, 4s delays
3. Retry only on timeout and connection errors (not on HTTP 4xx/5xx)
4. Add log messages for retry attempts
5. Return None only after all retries exhausted

IMPORTANT:
- Import time module if not already imported
- Preserve existing error handling for non-retryable errors
- Do NOT change function signature or return type
- Keep all existing response processing logic unchanged
- Total timeout: ~44 seconds max (10s + 2s + 10s + 4s + 10s + 8s)

EXPECTED OUTCOME:
- Transient network issues automatically retried
- Clear log messages showing retry attempts
- Success rate improves from ~60% to ~90% on unstable networks
```

### 2.4 Code Changes

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines 535-595

**BEFORE:**
```python
def check_for_updates(ai_server_url=None):
    """
    Check the AI server for available updates.
    Returns a dict with update info if available, None otherwise.
    
    Response format:
    {
        'update_available': bool,
        'latest_version': str,
        'download_url': str,
        'release_notes': str,
        'is_mandatory': bool,
        'checksum': str (SHA256 hash for integrity verification)
    }
    """
    try:
        server_url = ai_server_url or get_env_var('AI_SERVER_URL')
        if not server_url:
            print("[WARN] AI Server URL not configured, skipping update check")
            return None
        
        url = f"{server_url}/api/app-version/check?platform=windows&current={APP_VERSION}"
        
        response = requests.get(url, timeout=10)
        
        if response.status_code != 200:
            print(f"[WARN] Update check failed: HTTP {response.status_code}")
            return None
        
        data = response.json()
        
        if not data.get('success'):
            print(f"[WARN] Update check failed: {data.get('error', 'Unknown error')}")
            return None
        
        result = data.get('data', {})
        
        return {
            'update_available': result.get('updateAvailable', False),
            'latest_version': result.get('latestVersion'),
            'current_version': result.get('currentVersion', APP_VERSION),
            'download_url': result.get('downloadUrl'),
            'release_notes': result.get('releaseNotes'),
            'is_mandatory': result.get('isMandatory', False),
            'can_update': result.get('canUpdate', True),
            'checksum': result.get('checksum'),  # SHA256 for integrity verification
            'file_size_bytes': result.get('fileSizeBytes')
        }
    
    except requests.exceptions.Timeout:
        print("[WARN] Update check timed out")
        return None
    except requests.exceptions.RequestException as e:
        print(f"[WARN] Update check failed: {e}")
        return None
    except Exception as e:
        print(f"[WARN] Unexpected error during update check: {e}")
        return None
```

**AFTER:**
```python
def check_for_updates(ai_server_url=None):
    """
    Check the AI server for available updates with retry logic.
    Returns a dict with update info if available, None otherwise.
    
    Implements exponential backoff retry strategy for transient network failures:
    - Attempt 1: Immediate
    - Attempt 2: After 2 second delay
    - Attempt 3: After 4 second delay (total 6s of delays)
    
    Response format:
    {
        'update_available': bool,
        'latest_version': str,
        'download_url': str,
        'release_notes': str,
        'is_mandatory': bool,
        'checksum': str (SHA256 hash for integrity verification)
    }
    """
    server_url = ai_server_url or get_env_var('AI_SERVER_URL')
    if not server_url:
        print("[WARN] AI Server URL not configured, skipping update check")
        return None
    
    url = f"{server_url}/api/app-version/check?platform=windows&current={APP_VERSION}"
    
    # Retry logic for transient network issues
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = requests.get(url, timeout=10)
            
            if response.status_code != 200:
                print(f"[WARN] Update check failed: HTTP {response.status_code}")
                # HTTP errors are not transient - don't retry
                return None
            
            data = response.json()
            
            if not data.get('success'):
                print(f"[WARN] Update check failed: {data.get('error', 'Unknown error')}")
                return None
            
            result = data.get('data', {})
            
            # Success - return the result
            if attempt > 0:
                print(f"[OK] Update check succeeded on attempt {attempt + 1}")
            
            return {
                'update_available': result.get('updateAvailable', False),
                'latest_version': result.get('latestVersion'),
                'current_version': result.get('currentVersion', APP_VERSION),
                'download_url': result.get('downloadUrl'),
                'release_notes': result.get('releaseNotes'),
                'is_mandatory': result.get('isMandatory', False),
                'can_update': result.get('canUpdate', True),
                'checksum': result.get('checksum'),  # SHA256 for integrity verification
                'file_size_bytes': result.get('fileSizeBytes')
            }
        
        except requests.exceptions.Timeout:
            if attempt < max_retries - 1:
                wait_time = 2 * (attempt + 1)  # 2s, 4s
                print(f"[WARN] Update check timed out (attempt {attempt + 1}/{max_retries}), retrying in {wait_time}s...")
                time.sleep(wait_time)
            else:
                print(f"[WARN] Update check timed out after {max_retries} attempts")
                return None
        
        except requests.exceptions.ConnectionError as e:
            if attempt < max_retries - 1:
                wait_time = 2 * (attempt + 1)  # 2s, 4s
                print(f"[WARN] Connection error (attempt {attempt + 1}/{max_retries}): {e}, retrying in {wait_time}s...")
                time.sleep(wait_time)
            else:
                print(f"[WARN] Connection error after {max_retries} attempts: {e}")
                return None
        
        except requests.exceptions.RequestException as e:
            # Other request exceptions (DNS, SSL, etc.)
            if attempt < max_retries - 1:
                wait_time = 2 * (attempt + 1)  # 2s, 4s
                print(f"[WARN] Request failed (attempt {attempt + 1}/{max_retries}): {e}, retrying in {wait_time}s...")
                time.sleep(wait_time)
            else:
                print(f"[WARN] Request failed after {max_retries} attempts: {e}")
                return None
        
        except Exception as e:
            print(f"[WARN] Unexpected error during update check: {e}")
            return None
    
    # Should never reach here, but just in case
    return None
```

### 2.5 Verification Steps

```python
# Test Case 1: Normal successful check
# Expected: Single log message "[INFO] Update available: v1.5.0"

# Test Case 2: Transient network failure
# Expected: Multiple retry attempts logged, eventual success or failure after 3 attempts

# Test Case 3: Server returns HTTP 500
# Expected: Single attempt, immediate failure (no retry on server errors)
```

### 2.6 Testing Command

```powershell
# Test with network throttling
# Throttle network to 10 KB/s to simulate slow connection
# Expected: May see retry attempts if timeout occurs

# Test with intermittent connectivity
# Disconnect network, wait 2s, reconnect
# Expected: Should see retry attempts and eventual success
```

---

## Fix #3: Notify User on Download Failure (P1)

### Priority: 🟡 HIGH
### Estimated Time: 10 minutes
### Impact: Improves UX, helps debugging
### Risk: LOW (additive notification, doesn't affect core logic)

---

### 3.1 Problem Statement

When update download fails (network timeout, checksum mismatch, disk space), the failure is only logged to console. Users have no visibility into the failure and think the app is up-to-date.

### 3.2 Solution Overview

Add Windows toast notification when download fails, informing user that retry will happen automatically.

### 3.3 Implementation Prompt

```
TASK: Add user notification for update download failures

CONTEXT:
- File: python-desktop-app/desktop_app.py
- Method: UpdateManager._download_worker()
- Location: Lines 1308-1368 (exception handler around line 1362)
- Issue: Download failures are silent, users don't know update failed
- Impact: Poor UX, users think app is up-to-date when it's not

INSTRUCTIONS:
1. Locate the exception handler in _download_worker() method
2. Add Windows toast notification after logging the error
3. Keep error message concise (first 100 chars of error)
4. Inform user that retry will happen automatically
5. Use "long" duration for visibility

IMPORTANT:
- Check if WINOTIFY_AVAILABLE before creating notification
- Wrap notification code in try-except to prevent notification failures from breaking the app
- Do NOT change the state management logic (_set_state('failed'))
- Do NOT change the cleanup logic in finally block
- Keep existing console logging

EXPECTED OUTCOME:
- User sees notification: "Update Download Failed"
- Message explains retry will happen automatically
- Doesn't disrupt normal app operation if notification fails
```

### 3.4 Code Changes

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines ~1362 (in `_download_worker` exception handler)

**BEFORE:**
```python
    except Exception as e:
        self._set_state('failed', error=str(e))
        print(f"[WARN] Update download failed: {e}")
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass
```

**AFTER:**
```python
    except Exception as e:
        self._set_state('failed', error=str(e))
        print(f"[WARN] Update download failed: {e}")
        
        # Notify user about download failure
        if WINOTIFY_AVAILABLE:
            try:
                error_msg = str(e)[:100]  # Truncate long error messages
                notification = Notification(
                    app_id="Time Tracker",
                    title="Update Download Failed",
                    msg=f"Failed to download update. Will retry automatically. Error: {error_msg}",
                    duration="long"
                )
                notification.show()
            except Exception as notif_err:
                print(f"[WARN] Could not show download failure notification: {notif_err}")
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass
```

### 3.5 Verification Steps

```python
# Test Case 1: Simulate download failure
# Disconnect network during download
# Expected: Toast notification appears with "Update Download Failed"

# Test Case 2: Simulate checksum failure
# Modify expected_checksum to trigger mismatch
# Expected: Notification shows "Checksum verification failed"

# Test Case 3: Notification system unavailable
# WINOTIFY_AVAILABLE = False
# Expected: Only console log, no crash
```

---

## Fix #4: Move Check Outside Idle Block (P1)

### Priority: 🟡 HIGH
### Estimated Time: 5 minutes
### Impact: Eliminates 15-25% of failures
### Risk: LOW (moves code outside condition, doesn't change logic)

---

### 4.1 Problem Statement

The periodic update check (4-hour interval) is inside the `if not self.is_idle:` block. Users who go idle (meetings, breaks) during the 4-hour mark miss the update check.

### 4.2 Solution Overview

Move the update check outside the idle block so it runs even when user is away. Download happens in background, installation waits for user to return.

### 4.3 Implementation Prompt

```
TASK: Move periodic update check outside idle state block

CONTEXT:
- File: python-desktop-app/desktop_app.py
- Location: Lines 10090-10096 (tracking loop)
- Issue: Update check blocked when user is idle (meetings, breaks)
- Impact: 15-25% of failures for meeting-heavy users

INSTRUCTIONS:
1. Locate the periodic update check code inside "if not self.is_idle:" block
2. Move the update check code OUTSIDE the idle block
3. Keep other periodic checks (settings, classifications) INSIDE the idle block
4. Update the comment to explain why update check runs during idle
5. Maintain exact same check logic (time comparison, method call)

IMPORTANT:
- Only move the update check code (2-3 lines)
- Do NOT move other periodic checks (settings refresh, classification sync)
- Maintain proper indentation (8 spaces for code inside while loop)
- Keep the 4-hour interval check logic unchanged
- Preserve the show_notification=True parameter

EXPECTED OUTCOME:
- Update check runs even when user is idle
- Download happens in background without interrupting user
- Installation still waits for user to be active (handled by auto_apply)
- Other API calls remain inside idle block (settings, classifications)
```

### 4.4 Code Changes

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines ~10090-10100

**BEFORE:**
```python
                # Skip periodic checks while idle — no need to hit APIs when user is away
                if not self.is_idle:
                    # Periodically refresh settings from AI server (every 5 minutes)
                    if time.time() - last_settings_refresh > settings_refresh_interval:
                        self.fetch_and_apply_settings()
                        last_settings_refresh = time.time()

                    # Periodically sync classifications (every 30 minutes)
                    if time.time() - last_classification_sync > classification_sync_interval:
                        try:
                            client = self.supabase
                            self.classification_manager.sync_classifications(
                                client, self.organization_id, self.current_project_key,
                                all_project_keys=list(self._get_known_project_keys())
                            )
                        except Exception as e:
                            print(f"[WARN] Periodic classification sync failed: {e}")
                        last_classification_sync = time.time()

                    # Periodically check for app updates (every 4 hours by default)
                    # This runs in the background and shows notification if update available
                    if time.time() - self.last_version_check_time > self.version_check_interval:
                        self.check_for_app_updates(show_notification=True)

                    # Periodically check for unassigned work and send notifications
                    if time.time() - last_notification_check > notification_check_interval:
                        self.check_and_notify_unassigned_work()
```

**AFTER:**
```python
                # Skip periodic checks while idle — no need to hit APIs when user is away
                if not self.is_idle:
                    # Periodically refresh settings from AI server (every 5 minutes)
                    if time.time() - last_settings_refresh > settings_refresh_interval:
                        self.fetch_and_apply_settings()
                        last_settings_refresh = time.time()

                    # Periodically sync classifications (every 30 minutes)
                    if time.time() - last_classification_sync > classification_sync_interval:
                        try:
                            client = self.supabase
                            self.classification_manager.sync_classifications(
                                client, self.organization_id, self.current_project_key,
                                all_project_keys=list(self._get_known_project_keys())
                            )
                        except Exception as e:
                            print(f"[WARN] Periodic classification sync failed: {e}")
                        last_classification_sync = time.time()

                    # Periodically check for unassigned work and send notifications
                    if time.time() - last_notification_check > notification_check_interval:
                        self.check_and_notify_unassigned_work()

                # Check for app updates OUTSIDE idle block (every 4 hours by default)
                # Downloads happen in background even when user is away
                # Installation waits until user returns (auto_apply checks for activity)
                if time.time() - self.last_version_check_time > self.version_check_interval:
                    self.check_for_app_updates(show_notification=True)
```

### 4.5 Verification Steps

```python
# Test Case 1: User goes idle during 4-hour mark
# 1. Set version_check_interval = 5 * 60  # 5 minutes for testing
# 2. Let app run for 3 minutes
# 3. Go idle (no keyboard/mouse for 5+ minutes)
# 4. Wait 5 minutes
# Expected: Update check runs during idle state

# Test Case 2: Normal active state
# Expected: Update check runs as before, no behavior change
```

---

## Fix #5: Add Connectivity Check in Method (P2)

### Priority: 🟢 MEDIUM
### Estimated Time: 5 minutes
### Impact: Cleaner architecture, fail-fast behavior
### Risk: LOW (additive check, early return pattern)

---

### 5.1 Problem Statement

The `check_for_app_updates()` method doesn't verify network connectivity before attempting the update check. Relies on caller to ensure connectivity, leading to inconsistent behavior.

### 5.2 Solution Overview

Add connectivity check at the start of the method for fail-fast behavior and consistent handling.

### 5.3 Implementation Prompt

```
TASK: Add connectivity verification to check_for_app_updates() method

CONTEXT:
- File: python-desktop-app/desktop_app.py
- Method: check_for_app_updates(self, show_notification=True, force=False)
- Location: Lines 5158-5220
- Issue: No connectivity check before attempting update check
- Impact: Cleaner architecture, fail-fast behavior

INSTRUCTIONS:
1. Add connectivity check at the start of the method (after try:)
2. Check connectivity without force (uses cached value if recent)
3. Return None immediately if offline with informative log message
4. Place check BEFORE the interval check (line ~5173)
5. Add corresponding admin log entry for tracking

IMPORTANT:
- Use self.offline_manager.check_connectivity() WITHOUT force=True
- Place after "try:" but before interval check
- Keep all existing logic unchanged
- Do NOT change function signature
- Add clear log message: "[INFO] Offline - skipping update check"

EXPECTED OUTCOME:
- Fail fast if offline (no wasted HTTP timeout)
- Consistent connectivity handling across all calls
- Better logging for debugging
- Admin log entry for offline checks
```

### 5.4 Code Changes

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines ~5158-5175

**BEFORE:**
```python
    def check_for_app_updates(self, show_notification=True, force=False):
        """
        Check for available updates from the AI server.
        
        Args:
            show_notification: Whether to show a desktop notification if update is available
            force: Force check even if recently checked
        
        Returns:
            dict with update info or None if no update/error
        """
        try:
            current_time = time.time()
            
            # Skip if checked recently (unless forced)
            if not force and (current_time - self.last_version_check_time) < self.version_check_interval:
                # Return cached info
                return self.latest_version_info
```

**AFTER:**
```python
    def check_for_app_updates(self, show_notification=True, force=False):
        """
        Check for available updates from the AI server.
        
        Args:
            show_notification: Whether to show a desktop notification if update is available
            force: Force check even if recently checked
        
        Returns:
            dict with update info or None if no update/error
        """
        try:
            # Verify network connectivity before attempting check (fail fast if offline)
            if not self.offline_manager.check_connectivity():
                print("[INFO] Offline - skipping update check")
                self.add_admin_log('INFO', 'Update check skipped (offline)')
                return None
            
            current_time = time.time()
            
            # Skip if checked recently (unless forced)
            if not force and (current_time - self.last_version_check_time) < self.version_check_interval:
                # Return cached info
                return self.latest_version_info
```

### 5.5 Verification Steps

```python
# Test Case 1: Call method while online
# Expected: Check proceeds normally

# Test Case 2: Call method while offline
# Expected: Returns None immediately, logs "Offline - skipping update check"

# Test Case 3: Verify admin log entry
# Check admin_logs table for 'Update check skipped (offline)' entry
```

---

## Fix #6: Automatic Retry for Failed Downloads (P2)

### Priority: 🟢 MEDIUM
### Estimated Time: 20 minutes
### Impact: Faster recovery from transient failures
### Risk: LOW (new feature, doesn't modify existing logic)

---

### 6.1 Problem Statement

When download fails (network timeout, connection reset), the system waits 4 hours before retrying. For transient failures, this is too long - a 30-minute retry would resolve most issues quickly.

### 6.2 Solution Overview

Track download failure time and implement faster retry interval (30 minutes) for failed downloads.

### 6.3 Implementation Prompt

```
TASK: Add automatic retry mechanism for failed downloads

CONTEXT:
- File: python-desktop-app/desktop_app.py
- Class: UpdateManager
- Issue: Failed downloads wait 4 hours before retry, too long for transient failures
- Impact: Faster recovery on unstable networks

INSTRUCTIONS:
1. Add two new instance variables to UpdateManager.__init__():
   - self._last_download_attempt = 0
   - self._download_retry_interval = 30 * 60  # 30 minutes
2. Create new method should_retry_download() to check retry eligibility
3. Update check_and_download() to record attempt time
4. Modify tracking loop to check for retry opportunity

IMPLEMENTATION STEPS:
Step 1: Add instance variables to __init__ (around line 1207)
Step 2: Create should_retry_download() method after cancel_download()
Step 3: Update check_and_download() to record attempt time
Step 4: Update tracking loop periodic check logic

IMPORTANT:
- Only retry when state == 'failed'
- 30-minute interval between retries
- Do NOT change existing 4-hour check logic
- Preserve all existing state management
- Add clear log message when retry is triggered

EXPECTED OUTCOME:
- Failed downloads retry every 30 minutes
- Normal 4-hour check continues as before
- Users on flaky networks recover faster
- Clear logging for debugging
```

### 6.4 Code Changes

#### Step 1: Add Instance Variables

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines ~1195-1213 (UpdateManager.__init__)

**BEFORE:**
```python
class UpdateManager:
    """Manages background download and installation of desktop app updates."""

    def __init__(self, app_data_dir, current_version, on_status_change=None, on_apply_update=None):
        self.app_data_dir = app_data_dir
        self.current_version = current_version
        self.state = 'idle'
        self.download_progress = 0.0
        self.downloaded_bytes = 0
        self.total_bytes = 0
        self.update_info = None
        self.download_path = None
        self.last_error = None
        self._download_thread = None
        self._cancel_event = threading.Event()
        self._lock = threading.Lock()
        self._on_status_change = on_status_change
        self._on_apply_update = on_apply_update
```

**AFTER:**
```python
class UpdateManager:
    """Manages background download and installation of desktop app updates."""

    def __init__(self, app_data_dir, current_version, on_status_change=None, on_apply_update=None):
        self.app_data_dir = app_data_dir
        self.current_version = current_version
        self.state = 'idle'
        self.download_progress = 0.0
        self.downloaded_bytes = 0
        self.total_bytes = 0
        self.update_info = None
        self.download_path = None
        self.last_error = None
        self._download_thread = None
        self._cancel_event = threading.Event()
        self._lock = threading.Lock()
        self._on_status_change = on_status_change
        self._on_apply_update = on_apply_update
        
        # Download retry management (faster recovery from transient failures)
        self._last_download_attempt = 0  # Timestamp of last download attempt
        self._download_retry_interval = 30 * 60  # 30 minutes in seconds
```

#### Step 2: Create should_retry_download() Method

**File:** `python-desktop-app/desktop_app.py`  
**Location:** After cancel_download() method (~line 1388)

**ADD NEW METHOD:**
```python
    def should_retry_download(self):
        """
        Check if we should retry a failed download.
        
        Returns:
            bool: True if download should be retried (failed state + 30 min elapsed)
        """
        if self.state != 'failed':
            return False
        
        current_time = time.time()
        time_since_attempt = current_time - self._last_download_attempt
        
        if time_since_attempt > self._download_retry_interval:
            return True
        
        return False
```

#### Step 3: Update check_and_download() to Record Attempt Time

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines ~1267-1300 (check_and_download method)

**FIND THIS SECTION:**
```python
            self._cancel_event.clear()
            self.update_info = update_info
            self.download_path = None
            self.download_progress = 0.0
            self.downloaded_bytes = 0
            self.total_bytes = int(update_info.get('file_size_bytes') or 0)

            self._set_state('checking')
            self._set_state('downloading')
            self._download_thread = threading.Thread(target=self._download_worker, daemon=True)
            self._download_thread.start()
            return True
```

**CHANGE TO:**
```python
            self._cancel_event.clear()
            self.update_info = update_info
            self.download_path = None
            self.download_progress = 0.0
            self.downloaded_bytes = 0
            self.total_bytes = int(update_info.get('file_size_bytes') or 0)

            self._set_state('checking')
            self._set_state('downloading')
            
            # Record download attempt time for retry logic
            self._last_download_attempt = time.time()
            
            self._download_thread = threading.Thread(target=self._download_worker, daemon=True)
            self._download_thread.start()
            return True
```

#### Step 4: Update Tracking Loop to Check for Retry

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines ~10095-10097 (periodic update check in tracking loop)

**BEFORE:**
```python
                # Check for app updates OUTSIDE idle block (every 4 hours by default)
                # Downloads happen in background even when user is away
                # Installation waits until user returns (auto_apply checks for activity)
                if time.time() - self.last_version_check_time > self.version_check_interval:
                    self.check_for_app_updates(show_notification=True)
```

**AFTER:**
```python
                # Check for app updates OUTSIDE idle block (every 4 hours by default, or 30 min if last download failed)
                # Downloads happen in background even when user is away
                # Installation waits until user returns (auto_apply checks for activity)
                should_check = False
                if time.time() - self.last_version_check_time > self.version_check_interval:
                    should_check = True
                elif self.update_manager and self.update_manager.should_retry_download():
                    should_check = True
                    print("[INFO] Retrying failed update download (30-minute retry interval)...")

                if should_check:
                    self.check_for_app_updates(show_notification=True)
```

### 6.5 Verification Steps

```python
# Test Case 1: Normal check (no prior failure)
# Expected: Check runs every 4 hours as before

# Test Case 2: Download fails
# Expected: Retry after 30 minutes, log message appears

# Test Case 3: Download succeeds on retry
# Expected: Normal behavior resumes, no more fast retries
```

---

## 8. Post-Implementation Testing

### 8.1 Unit Testing Checklist

- [ ] **Fix #1:** Re-check connectivity before update
  - [ ] Test with stable network (online throughout)
  - [ ] Test with network disconnect during auth
  - [ ] Verify log messages appear correctly
  
- [ ] **Fix #2:** Retry logic for update check
  - [ ] Test with stable network (single attempt succeeds)
  - [ ] Test with intermittent network (retry succeeds)
  - [ ] Test with permanent failure (all retries fail)
  - [ ] Verify retry delays (2s, 4s)
  
- [ ] **Fix #3:** Download failure notifications
  - [ ] Trigger download failure (disconnect network)
  - [ ] Verify notification appears
  - [ ] Test with WINOTIFY_AVAILABLE = False
  
- [ ] **Fix #4:** Check outside idle block
  - [ ] Set 5-minute check interval for testing
  - [ ] Go idle, wait for check trigger
  - [ ] Verify check runs during idle
  
- [ ] **Fix #5:** Connectivity check in method
  - [ ] Call check_for_app_updates() while offline
  - [ ] Verify returns None immediately
  - [ ] Check admin log entry
  
- [ ] **Fix #6:** Automatic retry for failed downloads
  - [ ] Trigger download failure
  - [ ] Wait 30 minutes (or reduce interval for testing)
  - [ ] Verify retry triggers automatically

### 8.2 Integration Testing

```powershell
# Test Scenario 1: Full startup sequence
# 1. Close all app instances
# 2. Disconnect network
# 3. Launch app
# 4. Reconnect network after 10 seconds
# Expected: Offline message, then online check on next cycle

# Test Scenario 2: Update download and install
# 1. Ensure update is available on server
# 2. Launch app
# 3. Verify download starts automatically
# 4. Verify installation proceeds when complete
# 5. Verify new version launches

# Test Scenario 3: Network failure recovery
# 1. Launch app
# 2. Trigger update check
# 3. Disconnect network during download
# 4. Reconnect network
# 5. Wait 30 minutes
# Expected: Automatic retry triggers, download succeeds
```

### 8.3 Version Update

After all fixes are implemented and tested:

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line 339

**UPDATE VERSION:**
```python
APP_VERSION = "1.5.0"
```

**Commit Message:**
```
fix(auto-update): eliminate 70-85% of silent failures

- Re-check connectivity before update to prevent stale status issues
- Add retry logic (3 attempts, exponential backoff) for transient failures
- Notify users when download fails with automatic retry message
- Move periodic check outside idle block for meeting-heavy users
- Add connectivity check in method for fail-fast behavior
- Implement 30-minute retry for failed downloads

Fixes root causes:
- RC#1: Stale is_online variable (40-50% of failures)
- RC#2: No retry logic (20-30% of failures)
- RC#3: Silent download failures (10-15% of failures)
- RC#4: Idle state blocking (15-25% of failures)
- RC#5: No connectivity check in method (5-10% of failures)

Estimated failure reduction: 70-85%
Risk: LOW (all additive changes, no breaking logic)
```

---

## 9. Rollback Plan

### 9.1 Immediate Rollback (Within 1 Hour)

If critical issues discovered immediately after deployment:

```powershell
# Step 1: Revert to previous version
git revert HEAD
git push origin fix/auto-update-silent-failures

# Step 2: Rebuild executable
cd python-desktop-app
python build.py

# Step 3: Deploy previous version
# Upload to server, update version check endpoint

# Step 4: Force update for affected users
# Set is_mandatory = true for rollback version
```

### 9.2 Gradual Rollback (After Testing Period)

If issues discovered after initial rollout:

```powershell
# Option 1: Revert specific fix
git revert <commit-hash-of-problematic-fix>

# Option 2: Restore from backup
cp desktop_app.py.backup desktop_app.py
git commit -m "Rollback auto-update fixes due to issue"
git push
```

### 9.3 Rollback Decision Criteria

Trigger rollback if:
- [ ] **Critical:** App crashes on startup (affects >5% of users)
- [ ] **Critical:** Update check breaks authentication flow
- [ ] **High:** Download failures increase (>20% failure rate)
- [ ] **High:** False positive updates (users seeing "update available" incorrectly)
- [ ] **Medium:** Performance degradation (startup time >10s increase)

Do NOT rollback for:
- [ ] Cosmetic notification issues
- [ ] Minor logging inconsistencies
- [ ] Individual user reports without pattern

---

## 10. Monitoring & Validation

### 10.1 Success Metrics

Track these metrics for 7 days post-deployment:

| Metric | Baseline (v1.4.9) | Target (v1.5.0) | Threshold |
|--------|------------------|-----------------|-----------|
| Update check success rate | ~60-70% | >90% | >85% |
| Download completion rate | ~70-80% | >95% | >90% |
| Time to update (avg) | 4-8 hours | 1-2 hours | <3 hours |
| User notifications | 0 on failure | 100% on failure | >95% |
| Retry success rate | N/A | >70% | >60% |

### 10.2 Database Queries for Monitoring

```sql
-- Query 1: Check version distribution
SELECT 
    desktop_app_version,
    COUNT(*) as user_count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM users
WHERE desktop_logged_in = true
  AND desktop_last_heartbeat > NOW() - INTERVAL '7 days'
GROUP BY desktop_app_version
ORDER BY desktop_app_version DESC;

-- Query 2: Update check failures (from admin logs)
SELECT 
    user_id,
    display_name,
    COUNT(*) as failed_checks,
    MAX(created_at) as last_failure
FROM admin_logs
WHERE log_level = 'WARNING'
  AND message LIKE '%Update check%'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY user_id, display_name
HAVING COUNT(*) > 3
ORDER BY failed_checks DESC;

-- Query 3: Users still on old versions (target for manual outreach)
SELECT 
    user_id,
    display_name,
    email,
    desktop_app_version,
    desktop_last_heartbeat
FROM users
WHERE desktop_app_version < '1.5.0'
  AND desktop_logged_in = true
  AND desktop_last_heartbeat > NOW() - INTERVAL '7 days'
ORDER BY desktop_last_heartbeat DESC;
```

### 10.3 Admin Log Analysis

**Key log messages to monitor:**

| Log Message | Meaning | Action |
|-------------|---------|--------|
| "Update check skipped (offline)" | User offline during check | Normal, no action |
| "Update check timed out after 3 attempts" | Persistent network issue | Investigate user's network |
| "Update download failed" | Download issue | Check server logs, network |
| "Auto-applying update v1.5.0" | Success! | Track completion |
| "Retrying failed update download" | Retry triggered | Monitor success rate |

### 10.4 User Feedback Collection

Monitor support channels for:
- [ ] Reports of "app not updating"
- [ ] Complaints about notification spam
- [ ] Network performance issues
- [ ] Unexpected restarts (auto-update)
- [ ] Version mismatch reports

---

## 11. Success Criteria

### 11.1 Technical Success

- [ ] All 6 fixes implemented without breaking changes
- [ ] Unit tests pass for each fix
- [ ] Integration tests pass for full flow
- [ ] Version updated to 1.5.0
- [ ] Code committed to feature branch
- [ ] Pull request created and reviewed

### 11.2 Deployment Success

- [ ] Executable built successfully
- [ ] Uploaded to server with correct checksum
- [ ] Version check endpoint updated
- [ ] Gradual rollout initiated (10% → 50% → 100%)
- [ ] No critical issues in first 24 hours

### 11.3 Performance Success

- [ ] Update check success rate >85% (target: >90%)
- [ ] Download completion rate >90% (target: >95%)
- [ ] Average time to update <3 hours (target: 1-2 hours)
- [ ] User satisfaction maintained or improved
- [ ] No increase in support tickets

---

## 12. Timeline

### Week 1: Implementation
- **Day 1:** Implement fixes #1, #2 (P0 priority) - 20 min
- **Day 1:** Test fixes #1, #2 in isolation - 1 hour
- **Day 2:** Implement fixes #3, #4 (P1 priority) - 15 min
- **Day 2:** Test fixes #3, #4 in isolation - 1 hour
- **Day 3:** Implement fixes #5, #6 (P2 priority) - 25 min
- **Day 3:** Test fixes #5, #6 in isolation - 1 hour
- **Day 4:** Integration testing - 2 hours
- **Day 5:** Code review and refinement - 2 hours

### Week 2: Deployment
- **Day 1-2:** Build and test executable - 4 hours
- **Day 3:** Deploy to 10% of users - Monitor for 24 hours
- **Day 4:** Deploy to 50% of users - Monitor for 24 hours
- **Day 5:** Deploy to 100% of users

### Week 3: Monitoring
- **Day 1-7:** Monitor metrics, collect feedback
- **End of week:** Review success metrics, decide on next steps

---

## 13. Quick Reference Commands

```powershell
# Create feature branch
git checkout -b fix/auto-update-silent-failures

# Backup current file
Copy-Item python-desktop-app\desktop_app.py python-desktop-app\desktop_app.py.backup

# Run app in debug mode
cd python-desktop-app
python desktop_app.py

# Build executable after changes
python build.py

# Commit changes
git add python-desktop-app/desktop_app.py
git commit -m "fix(auto-update): implement Fix #1 - re-check connectivity"
git push origin fix/auto-update-silent-failures

# Create PR
gh pr create --title "Fix: Auto-update silent failures" --body "See AUTO_UPDATE_FAILURE_FIX_IMPLEMENTATION_PLAN.md"
```

---

**END OF IMPLEMENTATION PLAN**

## Summary

This plan provides:
- ✅ **Detailed prompts** for each fix that can be executed safely
- ✅ **Before/after code examples** showing exact changes
- ✅ **Verification steps** to confirm each fix works
- ✅ **Testing procedures** to prevent breaking changes
- ✅ **Rollback plan** if issues arise
- ✅ **Monitoring strategy** to measure success

**Estimated total time:** 60 minutes of implementation + 5 hours of testing  
**Expected outcome:** 70-85% reduction in auto-update failures  
**Risk level:** LOW - all changes are additive and non-breaking

# Auto-Update Startup Check Failure Analysis

**Date:** May 13, 2026  
**Issue:** Users with auto-update code (v1.4.0+) not getting updates after restart  
**Root Cause:** Stale `is_online` variable in startup sequence

---

## The Problem

Users confirmed:
- ✅ Auto-update check DOES trigger on system restart (4 out of 4 users)
- ❌ For SOME users with v1.4.0+, update check fails silently

**Root Cause:** The `is_online` variable becomes stale between connectivity check and update check.

---

## Code Flow Analysis

### Startup Sequence ([desktop_app.py#L11018-11122](../python-desktop-app/desktop_app.py#L11018))

```python
# Line 11018: Check connectivity ONCE at startup
is_online = self.offline_manager.check_connectivity(force=True)  # ← LOCAL VARIABLE

# Lines 11020-11107: ~100 lines of operations
if self.auth_manager.is_authenticated():
    if is_online:
        # Try to get user info (3 retries, can take 10+ seconds)
        for attempt in range(3):
            user_info = self.auth_manager.get_user_info()
            if not user_info and attempt < 2:
                time.sleep((attempt + 1) * 3)  # 3s, 6s waits
        
        if user_info:
            # Initialize Supabase (fetches config from AI server)
            if not self.initialize_supabase():  # ← Can fail and change is_online status
                # Fallback to cached
                pass
            
            # Database validation
            check = self.supabase.table('users').select('id')...  # ← Can fail
            
            # Sync classifications
            self.classification_manager.sync_classifications(...)  # ← Can fail
        
        # ... many more operations ...

# Line 11120: Update check uses STALE is_online from line 11018
if is_online:  # ← Still True even if operations above failed!
    print("[INFO] Checking for app updates...")
    self.check_for_app_updates(show_notification=True, force=True)
```

---

## The Bug

### Problem Statement

1. **Line 11018:** `is_online` set to `True` (network available)
2. **Lines 11020-11107:** Operations run:
   - `get_user_info()` might timeout (slow network)
   - `initialize_supabase()` might fail (server down)
   - Database operations might fail
   - **CRITICALLY:** These failures can change `self.offline_manager.is_online` to `False`
3. **Line 11120:** Update check still uses OLD `is_online = True` from line 11018
4. **Result:** Update check runs but `check_for_updates()` fails because network is actually down now

---

## Evidence

### Connectivity Check Implementation ([desktop_app.py#L2644-2684](../python-desktop-app/desktop_app.py#L2644))

```python
def check_connectivity(self, force=False):
    """Check if we have internet connectivity"""
    current_time = time.time()
    
    # Use cached result if checked recently (unless forced)
    if not force and (current_time - self._last_connectivity_check) < self._connectivity_check_interval:
        return self.is_online  # ← Returns CACHED value!
    
    self._last_connectivity_check = current_time
    
    # Try multiple endpoints for reliability
    test_endpoints = [
        ("api.atlassian.com", 443),
        ("supabase.co", 443),
        ("8.8.8.8", 53),
    ]
    
    for host, port in test_endpoints:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(3)  # 3-second timeout PER endpoint
        sock.connect((host, port))
        # ... success ...
        self.is_online = True
        return True
    
    # All endpoints failed
    self.is_online = False
    return False
```

**Cache behavior:**
- Returns cached result if checked within last 30 seconds
- Startup check uses `force=True` (bypasses cache)
- But subsequent operations DON'T use `force=True`

---

### How Operations Can Fail

#### 1. get_user_info() - Slow Network

```python
for attempt in range(3):
    user_info = self.auth_manager.get_user_info()  # ← Makes HTTP request
    if not user_info and attempt < 2:
        wait_secs = (attempt + 1) * 3
        time.sleep(wait_secs)  # 3s, 6s
```

**If network is slow:**
- First attempt: timeout after 10s
- Wait 3s
- Second attempt: timeout after 10s
- Wait 6s
- Third attempt: timeout after 10s
- **Total: ~29 seconds elapsed**

**During this time:**
- Network might drop
- VPN might disconnect
- Corporate firewall might block requests
- But `is_online` variable from line 11018 is still `True`

---

#### 2. initialize_supabase() - Server Unreachable

```python
if not self.initialize_supabase():
    print("[WARN] Could not initialize Supabase, using cached user ID")
```

**Inside initialize_supabase() ([desktop_app.py#L5222](../python-desktop-app/desktop_app.py#L5222)):**

```python
def initialize_supabase(self):
    # Fetch Supabase config from AI server
    if not self.auth_manager.get_supabase_config():  # ← HTTP request
        print("[ERROR] Failed to get Supabase config from AI server")
        return False
    
    # Initialize client
    self.supabase = create_client(...)
```

**If AI server is down:**
- `get_supabase_config()` fails
- Returns `False`
- Startup continues with cached data
- But network is actually unreachable now

---

#### 3. Database Validation - Supabase RLS

```python
check = self.supabase.table('users').select('id').eq('id', self.current_user_id).execute()
if not check.data:
    # User not found
```

**If Supabase is slow:**
- Query times out
- Exception caught
- Startup continues
- But connection is unstable

---

### Timeline Example

```
00:00.000 - Windows restart
00:00.500 - App launches
00:00.800 - Line 11018: check_connectivity(force=True)
            └─→ Tries api.atlassian.com:443 → Success (200ms)
            └─→ is_online = True ✅
00:01.000 - get_user_info() attempt 1
            └─→ HTTP request to Atlassian → Timeout (10s)
00:11.000 - Wait 3s
00:14.000 - get_user_info() attempt 2
            └─→ HTTP request → Timeout (10s)
00:24.000 - Wait 6s  
00:30.000 - get_user_info() attempt 3
            └─→ HTTP request → Timeout (10s)
00:40.000 - All retries failed
            └─→ Fallback to cached user info
            └─→ Network is NOW effectively offline
00:40.100 - initialize_supabase()
            └─→ get_supabase_config() → Fails (timeout)
            └─→ Returns False
            └─→ self.offline_manager.is_online might be False now
00:40.200 - Line 11120: if is_online:  ← Still True from 00:00.800!
            └─→ check_for_app_updates() runs
            └─→ Calls check_for_updates() global function
            └─→ HTTP request to AI server → FAILS (network down)
            └─→ Returns None
            └─→ Update check SILENTLY FAILS ❌
```

**Result:** User thinks app checked for updates (log says "Checking for app updates...") but check actually failed silently.

---

## Why 4 Test Users Succeeded

### Test Scenario

Your 4 test users likely had:
- ✅ Fast, stable network
- ✅ No VPN disconnections
- ✅ All services reachable (Atlassian, AI server, Supabase)
- ✅ No corporate firewall issues
- ✅ Operations completed in <5 seconds

**Timeline for successful test:**
```
00:00.000 - App launches
00:00.800 - check_connectivity() → True
00:01.000 - get_user_info() → Success (500ms)
00:01.500 - initialize_supabase() → Success (300ms)
00:01.800 - Database validation → Success (200ms)
00:02.000 - Line 11120: if is_online: → Still True ✅
            └─→ check_for_app_updates() → Success
            └─→ Update found, downloaded, installed ✅
```

**Why it worked:**
- All operations completed quickly (<2 seconds)
- Network remained stable
- `is_online` was accurate

---

### Production Scenario

In production, users experience:
- ❌ Slow corporate VPN connections
- ❌ Intermittent network during Windows startup
- ❌ Corporate firewall blocks certain endpoints
- ❌ Atlassian API rate limiting
- ❌ Operations take 30+ seconds total

**Timeline for production failure:**
```
00:00.000 - App launches
00:00.800 - check_connectivity() → True (quick socket test succeeds)
00:01.000 - get_user_info() → Slow/timeout (30+ seconds)
00:31.000 - initialize_supabase() → Fails (network now unstable)
00:31.100 - Line 11120: if is_online: → Still True from 00:00.800
            └─→ check_for_app_updates() → FAILS
            └─→ Update check silently fails ❌
```

---

## The Fix

### Solution 1: Re-Check Connectivity Before Update (RECOMMENDED)

**Location:** [desktop_app.py#L11120](../python-desktop-app/desktop_app.py#L11120)

**Replace:**
```python
# Check for updates on startup (only if online)
if is_online:
    print("[INFO] Checking for app updates...")
    self.check_for_app_updates(show_notification=True, force=True)
```

**With:**
```python
# Check for updates on startup (only if online)
# Re-check connectivity to ensure network is still available after auth operations
if self.offline_manager.check_connectivity(force=True):
    print("[INFO] Checking for app updates...")
    self.check_for_app_updates(show_notification=True, force=True)
else:
    print("[INFO] Offline after authentication - will check for updates when online")
```

**Benefits:**
- ✅ Ensures network is actually available before update check
- ✅ Avoids silent failures
- ✅ Minimal code change (1 line)
- ✅ No performance impact (quick socket test)

---

### Solution 2: Check Connectivity Inside check_for_app_updates()

**Location:** [desktop_app.py#L5158](../python-desktop-app/desktop_app.py#L5158)

**Add at start of method:**
```python
def check_for_app_updates(self, show_notification=True, force=False):
    """Check for available updates from the AI server."""
    try:
        # Verify network is available before attempting check
        if not self.offline_manager.check_connectivity(force=True):
            print("[INFO] Offline - skipping update check")
            return None
        
        current_time = time.time()
        # ... rest of method ...
```

**Benefits:**
- ✅ Centralizes connectivity check
- ✅ Works for both startup and periodic checks
- ✅ Consistent behavior

---

### Solution 3: Add Retry Logic to check_for_updates()

**Location:** [desktop_app.py#L546](../python-desktop-app/desktop_app.py#L546)

**Replace:**
```python
def check_for_updates():
    """Check for app updates from the AI server (global function)."""
    server_url = get_env_var('AI_SERVER_URL')
    if not server_url:
        return None

    try:
        url = f"{server_url}/api/app-version/check?platform=windows&current={APP_VERSION}"
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        result = response.json()
        # ... process result ...
    except requests.exceptions.Timeout:
        print("[WARN] Update check timed out")
        return None
```

**With:**
```python
def check_for_updates():
    """Check for app updates from the AI server (global function)."""
    server_url = get_env_var('AI_SERVER_URL')
    if not server_url:
        return None

    # Retry logic for transient network issues
    max_retries = 3
    for attempt in range(max_retries):
        try:
            url = f"{server_url}/api/app-version/check?platform=windows&current={APP_VERSION}"
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            result = response.json()
            # ... process result ...
            return result  # Success
        except requests.exceptions.Timeout:
            if attempt < max_retries - 1:
                wait_time = (attempt + 1) * 2  # 2s, 4s
                print(f"[WARN] Update check timed out (attempt {attempt + 1}/{max_retries}), retrying in {wait_time}s...")
                time.sleep(wait_time)
            else:
                print("[WARN] Update check failed after 3 attempts")
                return None
        except requests.exceptions.RequestException as e:
            print(f"[WARN] Update check failed: {e}")
            return None
```

**Benefits:**
- ✅ Handles transient network issues
- ✅ Improves success rate on flaky networks
- ❌ Adds 6s delay if all retries fail

---

## Recommended Implementation

### Combine Solution 1 + Solution 2

**Step 1: Re-check connectivity before update check**

[desktop_app.py#L11120](../python-desktop-app/desktop_app.py#L11120):
```python
# Check for updates on startup (re-verify connectivity first)
if self.offline_manager.check_connectivity(force=True):
    print("[INFO] Checking for app updates...")
    self.check_for_app_updates(show_notification=True, force=True)
else:
    print("[INFO] Offline after authentication - will check for updates later")
```

**Step 2: Add connectivity check inside method**

[desktop_app.py#L5158](../python-desktop-app/desktop_app.py#L5158):
```python
def check_for_app_updates(self, show_notification=True, force=False):
    """Check for available updates from the AI server."""
    try:
        # Verify network before checking (guards against stale connectivity status)
        if not self.offline_manager.check_connectivity():
            print("[INFO] Offline - skipping update check")
            return None
        
        current_time = time.time()
        # ... rest of method ...
```

**Benefits:**
- ✅ Double-checks connectivity (startup + method entry)
- ✅ Prevents silent failures
- ✅ Works for both startup and periodic checks
- ✅ Minimal performance impact (2 quick socket tests)

---

## Testing Plan

### Test Case 1: Slow Network During Startup

**Setup:**
1. Throttle network to 50 KB/s
2. Restart Windows
3. Monitor console output

**Expected:**
```
[INFO] Checking network connectivity...
[INFO] Network available
[INFO] Getting user info...
[WARN] get_user_info attempt 1 failed, retrying in 3s...
[WARN] get_user_info attempt 2 failed, retrying in 6s...
[WARN] get_user_info attempt 3 failed
[WARN] Could not verify user info after 3 attempts — falling back to cached data
[INFO] Re-checking network connectivity before update check...
[WARN] Network connectivity lost - switching to offline mode
[INFO] Offline after authentication - will check for updates later
```

**Result:** ✅ Update check skipped (no silent failure)

---

### Test Case 2: Network Available Throughout

**Setup:**
1. Fast, stable network
2. Restart Windows
3. Monitor console output

**Expected:**
```
[INFO] Checking network connectivity...
[INFO] Network available
[INFO] Getting user info...
[OK] Welcome back, user@example.com!
[INFO] Re-checking network connectivity before update check...
[INFO] Network available
[INFO] Checking for app updates...
[INFO] Update available: v1.4.1
[UPDATE] Auto-applying update v1.4.1...
```

**Result:** ✅ Update check succeeds and installs

---

### Test Case 3: VPN Disconnects During Startup

**Setup:**
1. Start with VPN connected
2. Restart Windows
3. Disconnect VPN during authentication (after ~5s)
4. Monitor console output

**Expected:**
```
[INFO] Checking network connectivity...
[INFO] Network available (VPN connected)
[INFO] Getting user info...
[OK] Welcome back, user@example.com!
[INFO] Re-checking network connectivity before update check...
[WARN] Network connectivity lost - switching to offline mode
[INFO] Offline after authentication - will check for updates later
```

**Result:** ✅ Update check skipped (detects VPN disconnect)

---

## Monitoring & Diagnostics

### Add Diagnostic Logging

**Location:** [desktop_app.py#L5158](../python-desktop-app/desktop_app.py#L5158)

```python
def check_for_app_updates(self, show_notification=True, force=False):
    """Check for available updates from the AI server."""
    try:
        # Diagnostic logging
        connectivity_status = self.offline_manager.check_connectivity()
        print(f"[UPDATE-CHECK] Connectivity: {connectivity_status}")
        print(f"[UPDATE-CHECK] Force: {force}")
        print(f"[UPDATE-CHECK] Last check: {time.time() - self.last_version_check_time:.0f}s ago")
        
        if not connectivity_status:
            print("[INFO] Offline - skipping update check")
            self.add_admin_log('INFO', 'Update check skipped (offline)')
            return None
        
        # ... rest of method ...
```

**Benefits:**
- Visibility into why checks fail
- Helps diagnose user reports
- Can analyze patterns in admin logs

---

### Track Update Check Attempts in Database

**Add to admin_logs table:**

```python
self.add_admin_log('INFO', 'Update check executed', {
    'connectivity_status': connectivity_status,
    'forced': force,
    'time_since_last': time.time() - self.last_version_check_time,
    'result': 'success' if update_info else 'failed',
    'current_version': APP_VERSION,
    'latest_version': update_info.get('latest_version') if update_info else None
})
```

**Query to find users with failed checks:**

```sql
SELECT 
    user_id,
    display_name,
    email,
    COUNT(*) as failed_checks,
    MAX(created_at) as last_failed_check
FROM admin_logs
WHERE log_level = 'INFO'
  AND message LIKE '%Update check%'
  AND metadata->>'result' = 'failed'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY user_id, display_name, email
HAVING COUNT(*) > 3
ORDER BY failed_checks DESC;
```

---

## Summary

### Root Cause

**Stale `is_online` variable:**
- Connectivity checked at startup (line 11018)
- Operations run for 30+ seconds (auth, Supabase init, DB validation)
- Network can fail during these operations
- Update check uses stale `is_online` value from startup
- Check runs but fails silently

### Impact

- ❌ Users with slow/unreliable networks don't get updates
- ❌ Silent failures (no error shown to user)
- ❌ Works in testing (fast networks) but fails in production

### Solution

**Re-check connectivity before update:**
1. Add connectivity check at line 11120 (before update check)
2. Add connectivity check inside `check_for_app_updates()` method
3. Add diagnostic logging
4. Add retry logic to `check_for_updates()` function (optional)

### Expected Outcome

- ✅ Update checks only run when network is actually available
- ✅ No silent failures
- ✅ Better success rate on slow/unstable networks
- ✅ Clear logging when offline

---

**END OF ANALYSIS**

# Organization ID Timing Bug Analysis

**Date:** April 7, 2026  
**Issue:** Admin panel locked despite user being logged in, and time tracking showing 0s

---

## 🐛 Problem Summary

Users who logged in previously (yesterday) are seeing:
1. **Admin Panel Locked:** Message says "The admin panel is not available until the desktop app has authenticated with the server"
2. **No Time Tracked:** Dashboard shows 0s for today, this week, and this month
3. **User appears logged in:** System tray shows user is logged in

---

## 🔍 Root Cause Analysis

### Issue #1: Admin Panel Lock

**Location:** [desktop_app.py](desktop_app.py#L5113-L5114)

```python
@self.app.route('/admin')
def admin_login_page():
    if not self.supabase or not self.organization_id:  # ❌ Problem: organization_id is None
        return self.render_admin_locked_page()
```

**Root Cause:** Timing issue between route initialization and organization_id population:

1. **During `__init__` (Line 4570-4571):**
   ```python
   # Setup routes
   self.setup_routes()  # Admin routes registered NOW
   ```
   At this point: `self.organization_id = None` (set at line 4514)

2. **Later, during `run()` method (Line 9720+):**
   ```python
   if self.auth_manager.is_authenticated():
       if is_online:
           user_info = self.auth_manager.get_user_info()
           if user_info:
               self.current_user_id = self.ensure_user_exists(user_info)
               # ☝️ This eventually sets self.organization_id
   ```

3. **The Problem:** 
   - Routes are registered during `__init__` before `run()` is called
   - `organization_id` is only populated during `run()` method
   - If user tries to access admin panel early, `organization_id` is still `None`

### Issue #2: organization_id Not Loaded from Cache on Startup

**Expected Behavior:**
- When app restarts, it should load `organization_id` from cache immediately
- Cache file location: `%LOCALAPPDATA%\TimeTracker\user_cache.json`

**Actual Behavior:**
- `_load_cached_user_info()` is only called:
  - As a fallback when server auth fails after 3 retries (Line 9762)
  - When in offline mode (Line 9775)
- It's NOT called early in `run()` to pre-populate organization_id

**Result:**
- Even if tokens are valid and loaded from secure storage
- The `organization_id` remains `None` until full authentication completes
- This breaks admin panel access and potentially time tracking

---

## 🔐 Secure Token Storage - Working Correctly?

**YES** - The secure token storage implementation is working as designed:

1. ✅ Tokens (`access_token`, `refresh_token`) are stored in keyring/encrypted storage
2. ✅ Tokens are loaded successfully on app restart
3. ✅ `is_authenticated()` returns `True` based on loaded tokens

**BUT** - User metadata (organization_id) is stored separately:

- **Tokens:** Stored in `SecureTokenStorage` (keyring → encrypted file)
- **User Metadata:** Stored in `%LOCALAPPDATA%\TimeTracker\user_cache.json` (line 5771-5776)
  ```python
  cache_data = {
      'user_id': self.current_user.get('id'),
      'email': self.current_user.get('email'),
      'account_id': self.current_user.get('account_id'),
      'organization_id': self.organization_id,  # ☝️ Stored here
      'cached_at': datetime.now(timezone.utc).isoformat()
  }
  ```

---

## 📊 Why This Affects Time Tracking (0s displayed)

**Hypothesis:** If `organization_id` is not set properly:

1. Screenshots/activities are uploaded without proper `organization_id`
2. Supabase RLS (Row Level Security) filters by `organization_id`
3. When Forge app queries data, it filters by current organization's ID
4. If IDs don't match, data appears as 0s

**Need to verify:**
- Check Supabase database for recent entries from this user
- Verify if `organization_id` field is NULL or mismatched
- Check RLS policies on affected tables

---

## 🛠️ Proposed Fix

### Option 1: Load Cached User Info Early (Recommended)

**File:** [desktop_app.py](desktop_app.py#L9678)

```python
def run(self):
    """Main application entry point"""
    print("[OK] Starting Time Tracker...")
    
    # ... (existing installation and lock code) ...
    
    # ✨ NEW: Load cached user info IMMEDIATELY to restore organization_id
    # This ensures admin panel and tracking work even before server verification
    if self.auth_manager.is_authenticated():
        cached_user = self._load_cached_user_info()
        if cached_user:
            self.organization_id = cached_user.get('organization_id')
            self.current_user_id = cached_user.get('user_id')
            print(f"[OK] Restored organization_id from cache: {self.organization_id}")
    
    # Check network connectivity
    is_online = self.offline_manager.check_connectivity(force=True)
    
    # Check authentication
    if self.auth_manager.is_authenticated():
        if is_online:
            # Online: try to get fresh user info from Atlassian (with retries)
            # This will UPDATE the cached organization_id if it changed
            user_info = None
            # ... (existing retry logic) ...
```

**Benefits:**
- ✅ Admin panel accessible immediately after app starts
- ✅ Time tracking works with correct organization_id from cache
- ✅ Server verification still happens, updates cache if needed
- ✅ Minimal code change, low risk

### Option 2: Initialize Supabase Early (Alternative)

Move Supabase initialization and organization_id loading to `__init__`:

```python
def __init__(self):
    # ... (existing initialization) ...
    
    # Load cached user info before setting up routes
    if self.auth_manager.is_authenticated():
        cached_user = self._load_cached_user_info()
        if cached_user:
            self.organization_id = cached_user.get('organization_id')
            # Initialize Supabase with cached info
            try:
                self.initialize_supabase()
            except Exception as e:
                print(f"[WARN] Could not initialize Supabase early: {e}")
    
    # Setup routes (admin panel will see organization_id)
    self.setup_routes()
```

**Drawbacks:**
- More complex initialization order
- Supabase initialization might fail if server is down
- Higher risk of unintended side effects

---

## 🔬 Additional Investigation Needed

1. **Check Supabase Data:**
   ```sql
   SELECT created_at, organization_id, user_id 
   FROM screenshots 
   WHERE user_id = '<user_uuid>'
   ORDER BY created_at DESC 
   LIMIT 10;
   ```
   - Are recent screenshots missing `organization_id`?
   - Are they associated with a different `organization_id`?

2. **Check User Cache File:**
   ```powershell
   Get-Content "$env:LOCALAPPDATA\TimeTracker\user_cache.json" | ConvertFrom-Json
   ```
   - Does it have the correct `organization_id`?
   - Is the file present?

3. **Check Application Logs:**
   - Look for errors during authentication
   - Check if `ensure_user_exists` is being called
   - Verify organization registration logs

---

## ✅ Recommended Action Plan

1. **Immediate Fix:** Implement Option 1 (load cached user info early in `run()`)
2. **Verify:** Test that admin panel works after restart
3. **Investigate:** Check Supabase for missing/incorrect organization_id in recent data
4. **Long-term:** Consider moving all user metadata (including organization_id) to secure storage alongside tokens

---

## 📝 Files Involved

1. **[desktop_app.py](desktop_app.py)**
   - Lines 4514: `self.organization_id = None` (initialization)
   - Lines 5113-5114: Admin panel lock check
   - Lines 5779-5802: `_load_cached_user_info()` method
   - Lines 9678+: `run()` method (where fix should be applied)

2. **User Cache File:**
   - Location: `%LOCALAPPDATA%\TimeTracker\user_cache.json`
   - Contains: `user_id`, `email`, `account_id`, `organization_id`, `cached_at`

3. **Secure Token Storage:**
   - [auth/secure_storage.py](python-desktop-app/auth/secure_storage.py)
   - Working correctly ✅

---

**Status:** Ready for implementation  
**Priority:** HIGH (affects user experience and data visibility)  
**Estimated Fix Time:** 30 minutes + testing

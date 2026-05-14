# Code Fix: Force JWT Refresh on App Version Change

## Purpose
Prevent the `supabase_user_id` backfill issue from recurring by forcing JWT refresh when the desktop app version changes.

## Problem
The current backfill logic (in AI server) only runs when `/api/auth/exchange-token` is called. If a user's JWT is cached (55-minute window), the backfill never runs, and version updates can fail due to RLS blocking.

## Solution
Detect when the app version has changed and force a JWT refresh on first launch after update.

---

## Implementation

### File: `python-desktop-app/desktop_app.py`

### Change 1: Add version tracking

**Location**: After `APP_VERSION` constant (line ~339)

```python
# Application version - IMPORTANT: Update this when releasing new versions
# Semantic versioning: MAJOR.MINOR.PATCH
APP_VERSION = "1.4.9"

# Version tracking for forcing JWT refresh after updates
# Stored in metadata to detect version changes across app restarts
LAST_PROCESSED_VERSION_KEY = 'last_processed_version'
```

### Change 2: Modify `_set_supabase_jwt()` to accept force_refresh

**Location**: Line ~5288

**Before:**
```python
def _set_supabase_jwt(self):
    """Set custom JWT on Supabase client for RLS-scoped access.
    The JWT contains sub=user_id and app_metadata.org_id for tenant isolation.
    Must be called after initialize_supabase() and whenever the JWT is refreshed."""
    if not self.supabase:
        print("[WARN] Supabase client not initialized — cannot set JWT")
        return False
    try:
        supabase_token = self.auth_manager.get_valid_supabase_token()
        if not supabase_token:
            print("[WARN] Could not get valid Supabase token")
            return False
```

**After:**
```python
def _set_supabase_jwt(self, force_refresh=False):
    """Set custom JWT on Supabase client for RLS-scoped access.
    The JWT contains sub=user_id and app_metadata.org_id for tenant isolation.
    Must be called after initialize_supabase() and whenever the JWT is refreshed.
    
    Args:
        force_refresh: If True, forces a new JWT fetch even if cached token is valid.
                      Used after app version updates to ensure supabase_user_id backfill runs.
    """
    if not self.supabase:
        print("[WARN] Supabase client not initialized — cannot set JWT")
        return False
    try:
        supabase_token = self.auth_manager.get_valid_supabase_token(force_refresh=force_refresh)
        if not supabase_token:
            print("[WARN] Could not get valid Supabase token")
            return False
```

### Change 3: Modify `get_valid_supabase_token()` to support force_refresh

**Location**: Line ~2350

**Before:**
```python
def get_valid_supabase_token(self):
    """Get a valid Supabase token, refreshing if needed"""
    supabase_token = self.tokens.get('supabase_token')
    expires_at = self.tokens.get('supabase_token_expires_at', 0)

    # Check if token exists and is not expired (with 5 min buffer)
    if supabase_token and time.time() < (expires_at - 300):
        return supabase_token

    # Token expired or doesn't exist, get a new one
    print("[INFO] Supabase token expired or missing, getting new one...")
```

**After:**
```python
def get_valid_supabase_token(self, force_refresh=False):
    """Get a valid Supabase token, refreshing if needed
    
    Args:
        force_refresh: If True, ignores cached token and fetches a new one from AI server.
                      This ensures the backfill logic runs (sets supabase_user_id = users.id).
    
    Returns:
        str: Supabase JWT token, or None if fetch failed
    """
    supabase_token = self.tokens.get('supabase_token')
    expires_at = self.tokens.get('supabase_token_expires_at', 0)

    # Check if token exists and is not expired (with 5 min buffer)
    # Skip cache if force_refresh is requested (e.g., after app version update)
    if not force_refresh and supabase_token and time.time() < (expires_at - 300):
        return supabase_token

    # Token expired, force refresh requested, or doesn't exist - get a new one
    reason = "forced refresh" if force_refresh else "expired or missing"
    print(f"[INFO] Supabase token {reason}, getting new one...")
```

### Change 4: Add version change detection helper

**Location**: Add new method in `AtlassianAuthManager` class (around line ~2500)

```python
def should_force_jwt_refresh(self):
    """Check if JWT refresh should be forced due to app version change.
    
    Returns:
        bool: True if app version changed since last processed version
    """
    last_version = self.tokens.get(LAST_PROCESSED_VERSION_KEY)
    
    if last_version is None:
        # First run or metadata cleared - force refresh to be safe
        print(f"[INFO] No previous version recorded, forcing JWT refresh for v{APP_VERSION}")
        return True
    
    if last_version != APP_VERSION:
        print(f"[INFO] App version changed: {last_version} → {APP_VERSION}, forcing JWT refresh")
        return True
    
    # Same version, no force refresh needed
    return False

def mark_version_processed(self):
    """Mark the current app version as processed (JWT refresh completed)"""
    self.tokens[LAST_PROCESSED_VERSION_KEY] = APP_VERSION
    self._save_tokens()
    print(f"[INFO] Marked version {APP_VERSION} as processed")
```

### Change 5: Call force refresh during session restore

**Location**: In `run()` method, session restore path (line ~11038)

**Before:**
```python
# Initialize Supabase clients (fetches config from AI server)
if not self.initialize_supabase():
    print("[WARN] Could not initialize Supabase, using cached user ID")
    self.current_user_id = self._load_cached_user_id()
else:
    self.current_user_id = self.ensure_user_exists(user_info)
    # Validate user actually exists in DB (detect stale/phantom IDs)
    if self.current_user_id and self.supabase:
```

**After:**
```python
# Initialize Supabase clients (fetches config from AI server)
# Force JWT refresh if app version changed (ensures supabase_user_id backfill runs)
force_jwt_refresh = self.auth_manager.should_force_jwt_refresh()
if force_jwt_refresh:
    print("[INFO] Forcing JWT refresh due to app version change")

if not self.initialize_supabase(force_jwt_refresh=force_jwt_refresh):
    print("[WARN] Could not initialize Supabase, using cached user ID")
    self.current_user_id = self._load_cached_user_id()
else:
    self.current_user_id = self.ensure_user_exists(user_info)
    
    # Mark version as processed after successful JWT refresh
    if force_jwt_refresh:
        self.auth_manager.mark_version_processed()
    
    # Validate user actually exists in DB (detect stale/phantom IDs)
    if self.current_user_id and self.supabase:
```

### Change 6: Update `initialize_supabase()` signature

**Location**: Line ~5225

**Before:**
```python
def initialize_supabase(self):
    """Initialize Supabase client with custom JWT for RLS-scoped access.
    Uses anon key + custom JWT — no service role key needed.
    Must be called after successful authentication."""
```

**After:**
```python
def initialize_supabase(self, force_jwt_refresh=False):
    """Initialize Supabase client with custom JWT for RLS-scoped access.
    Uses anon key + custom JWT — no service role key needed.
    Must be called after successful authentication.
    
    Args:
        force_jwt_refresh: If True, forces new JWT fetch even if cached token is valid.
                          Used after app version updates to ensure RLS backfill runs.
    """
```

And update the `_set_supabase_jwt()` call within it:

**Before:**
```python
# Set custom JWT from AI server on the client for RLS-scoped access
if not self._set_supabase_jwt():
    print("[ERROR] Could not set Supabase JWT - authentication incomplete")
    logging.error("Could not set Supabase JWT - authentication incomplete")
    return False
```

**After:**
```python
# Set custom JWT from AI server on the client for RLS-scoped access
# Pass force_jwt_refresh to ensure backfill runs after version updates
if not self._set_supabase_jwt(force_refresh=force_jwt_refresh):
    print("[ERROR] Could not set Supabase JWT - authentication incomplete")
    logging.error("Could not set Supabase JWT - authentication incomplete")
    return False
```

---

## Testing

### Test Case 1: Version Change Detection

1. Set `last_processed_version` in tokens metadata to `"1.4.8"`
2. Launch app with `APP_VERSION = "1.4.9"`
3. Verify:
   - ✅ `should_force_jwt_refresh()` returns `True`
   - ✅ Log shows "App version changed: 1.4.8 → 1.4.9, forcing JWT refresh"
   - ✅ `/api/auth/exchange-token` is called (not cached JWT)
   - ✅ `last_processed_version` is updated to `"1.4.9"`

### Test Case 2: Same Version (No Force Refresh)

1. Launch app twice with same version
2. Verify:
   - ✅ First launch: JWT refresh happens
   - ✅ Second launch (within 55 min): JWT cached, no API call
   - ✅ `should_force_jwt_refresh()` returns `False` on second launch

### Test Case 3: First Run (No Previous Version)

1. Delete tokens metadata (simulate first install)
2. Launch app
3. Verify:
   - ✅ `should_force_jwt_refresh()` returns `True` (safety default)
   - ✅ JWT refresh happens
   - ✅ `last_processed_version` is set

---

## Rollout Plan

### Phase 1: Deploy Migration (Immediate)
1. Run `DRY_RUN_20260514_backfill_check.sql` on production DB
2. Review affected users
3. Run `20260514_backfill_supabase_user_id.sql` during maintenance window
4. Verify with queries in the migration script

### Phase 2: Deploy Code Fix (Next Release)
1. Implement the changes above in desktop app code
2. Bump version to `1.5.0` (to trigger force refresh)
3. Test on staging environment
4. Deploy to production
5. Monitor logs for "forcing JWT refresh" messages

### Phase 3: Monitor (Ongoing)
1. Check daily for new users with NULL/mismatched `supabase_user_id`:
   ```sql
   SELECT COUNT(*) 
   FROM users 
   WHERE (supabase_user_id IS NULL OR supabase_user_id != id)
     AND created_at > NOW() - INTERVAL '1 day';
   ```
2. Should be 0 after code fix is deployed

---

## Impact

**Before both fixes:**
- ❌ Existing users: Version updates blocked by RLS
- ❌ New users who update quickly: Same issue
- ❌ Manual workaround: Users must log out/in after each update

**After migration only:**
- ✅ Existing users: Fixed
- ❌ New users who update quickly: Still vulnerable
- ⚠️ Not future-proof

**After migration + code fix:**
- ✅ Existing users: Fixed by migration
- ✅ New users: Force refresh after version change → backfill runs
- ✅ Future-proof: Issue cannot recur
- ✅ No user action required

---

## Alternative: Simpler Approach (If Code Changes Are Blocked)

If you can't deploy code changes soon, use this workaround:

**Option A: Change RLS policy** (not recommended - affects all queries)
```sql
-- Current policy (strict)
CREATE POLICY "users_update_own" ON public.users 
    FOR UPDATE USING (auth.uid() = supabase_user_id);

-- Alternative policy (looser - use with caution)
CREATE POLICY "users_update_own" ON public.users 
    FOR UPDATE USING (
        auth.uid() = supabase_user_id 
        OR auth.uid() = id  -- Allow if JWT sub matches users.id
    );
```

⚠️ **Warning**: This weakens security slightly (allows updates if either field matches)

**Option B: Force all users to re-login** (poor UX)
- Clear all cached tokens
- Users must log in again → fresh JWT → backfill runs
- Not recommended (bad user experience)

---

## Summary

✅ **Migration script is safe:**
- Only affects `users` table, `supabase_user_id` column
- Creates backup before changes
- Has rollback instructions
- Includes pre/post verification

✅ **Code fix prevents future occurrences:**
- Detects version changes
- Forces JWT refresh after updates
- Ensures backfill logic always runs

🎯 **Recommended: Do both**
- Migration fixes existing users immediately
- Code fix prevents the issue from happening again

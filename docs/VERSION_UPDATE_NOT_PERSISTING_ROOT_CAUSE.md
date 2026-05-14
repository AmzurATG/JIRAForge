# Root Cause Analysis: Desktop App Version Not Updating in Database

## Problem Statement

For some users, even though they update their desktop app to a new version, the `desktop_app_version` field in the Supabase `users` table is not being updated. This causes:

1. **False "Update Available" banners** in the Jira Forge UI showing they need to update when they're already on the latest version
2. **Stale version information** in analytics and admin dashboards
3. **Inability to track update adoption rates** accurately

## Executive Summary

**Root Cause**: Row Level Security (RLS) policy blocking version updates due to NULL or incorrect `supabase_user_id` values for users who installed the app before the backfill logic was implemented.

**Impact**: Affects users who:
- Installed the desktop app before the `supabase_user_id` backfill fix (approx. early 2026)
- Have never logged out and back in since the fix was deployed
- Update the desktop app while having a valid cached JWT (within the 55-minute validity window)

**Solution Required**: Force a JWT refresh on startup OR run a one-time database migration to backfill `supabase_user_id` for all existing users.

---

## Technical Deep Dive

### 1. The Update Flow (How It Should Work)

When a user updates the desktop app and launches it:

```
1. App starts → session restore path (line ~11000 in desktop_app.py)
2. initialize_supabase() called (line 11038)
   └─→ _set_supabase_jwt() (line 5274)
       └─→ get_valid_supabase_token() (line 5296)
           └─→ get_supabase_token() (line 2266) [only if JWT expired]
               └─→ POST /api/auth/exchange-token (AI server)
                   └─→ Backfill logic runs (auth-controller.js:612-625)
                       ├─→ IF supabase_user_id IS NULL OR != dbUser.id
                       └─→ UPDATE users SET supabase_user_id = id WHERE id = dbUser.id
3. JWT minted with sub = dbUser.id
4. JWT set on Supabase client
5. _update_desktop_status(logged_in=True) called (line 11054)
   └─→ UPDATE users SET desktop_app_version='1.4.9', desktop_last_heartbeat=NOW()
       WHERE id = current_user_id
6. RLS Policy Check: auth.uid() = supabase_user_id
   ├─→ auth.uid() returns JWT sub claim (dbUser.id)
   └─→ Must match supabase_user_id column
7. ✅ Update succeeds
```

### 2. The Actual Flow (Why It Fails)

For users with cached JWTs and NULL/incorrect `supabase_user_id`:

```
1. App starts → session restore path
2. initialize_supabase() called
   └─→ _set_supabase_jwt()
       └─→ get_valid_supabase_token()
           ├─→ Checks: time.time() < (expires_at - 300) [line 2357]
           └─→ ✅ JWT still valid (within 55-min window)
               └─→ Returns CACHED JWT (never calls AI server)
               └─→ ❌ Backfill logic NEVER runs
3. Cached JWT has sub = dbUser.id
4. _update_desktop_status(logged_in=True) called
   └─→ UPDATE users SET desktop_app_version='1.4.9'
       WHERE id = current_user_id
5. RLS Policy Check: auth.uid() = supabase_user_id
   ├─→ auth.uid() = dbUser.id (from JWT sub claim)
   └─→ supabase_user_id = NULL (or wrong value - never backfilled)
   └─→ dbUser.id != NULL → RLS BLOCKS UPDATE
6. ❌ Update fails silently (result.data is empty)
7. Log: "[WARN] Desktop status update returned no rows - RLS may be blocking"
```

### 3. Database Schema

#### Users Table Structure

```sql
CREATE TABLE public.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    atlassian_account_id TEXT UNIQUE NOT NULL,
    email TEXT,
    display_name TEXT,
    supabase_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    organization_id UUID,
    desktop_logged_in BOOLEAN DEFAULT FALSE,
    desktop_last_heartbeat TIMESTAMPTZ,
    desktop_app_version TEXT,  -- ← THIS FIELD FAILS TO UPDATE
    ...
);
```

**Key columns:**
- `id` - Primary key (UUID) for the user record
- `supabase_user_id` - Reference to auth.users table (used by RLS policies)
- `desktop_app_version` - The field that should be updated but isn't

#### RLS Policy

```sql
-- DEV_MIGRATION_COMPLETE.sql:842-843
CREATE POLICY "users_update_own" ON public.users 
    FOR UPDATE USING (auth.uid() = supabase_user_id);
```

**How it works:**
- `auth.uid()` returns the JWT's `sub` claim
- JWT `sub` is set to `dbUser.id` (the `users.id` UUID)
- Policy requires: `dbUser.id = supabase_user_id`
- **If `supabase_user_id` is NULL or different**, the update is BLOCKED

### 4. JWT Structure

The AI server mints custom JWTs for Supabase RLS (auth-controller.js:636-670):

```javascript
const payload = {
  // Standard claims
  iss: 'supabase',
  role: 'authenticated',
  iat: now,
  exp: now + 3600,  // 1 hour expiration
  
  // Supabase auth claims
  aud: 'authenticated',
  sub: dbUser.id,  // ← Set to users.id (NOT auth.users.id)
  
  // Custom claims
  atlassian_account_id: atlassianAccountId,
  email: email,
  
  // App metadata
  app_metadata: {
    provider: 'atlassian',
    org_id: dbUser.organization_id
  }
};
```

**The mismatch:**
- JWT `sub` = `users.id` (e.g., `123e4567-e89b-12d3-a456-426614174000`)
- RLS expects: `auth.uid()` (= JWT `sub`) = `supabase_user_id`
- For old users: `supabase_user_id` might be NULL or a completely different UUID

### 5. The Backfill Logic (The Fix That Doesn't Always Run)

#### AI Server Backfill (auth-controller.js:612-625)

```javascript
// Ensure supabase_user_id is set so RLS policies work
if (!dbUser.supabase_user_id || dbUser.supabase_user_id !== dbUser.id) {
  const supabase = getClient();  // Uses SERVICE_ROLE_KEY (bypasses RLS)
  if (supabase) {
    const { error: updateError } = await supabase
      .from('users')
      .update({ supabase_user_id: dbUser.id })  // ← Set to users.id
      .eq('id', dbUser.id);
    
    if (updateError) {
      logger.error('[Auth] Failed to set supabase_user_id for user %s: %s', 
        atlassianAccountId, updateError.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to update user profile for authentication' 
      });
    }
    logger.info('[Auth] Set supabase_user_id = %s for user %s', 
      dbUser.id, atlassianAccountId);
  }
}
```

**When it runs:**
- Only when `/api/auth/exchange-token` is called
- Only if JWT is expired OR missing

**When it DOESN'T run:**
- When JWT is cached and still valid (within 55-minute window before expiry)
- This is the problem!

#### Desktop App JWT Caching (desktop_app.py:2350-2386)

```python
def get_valid_supabase_token(self):
    """Get a valid Supabase token, refreshing if needed"""
    supabase_token = self.tokens.get('supabase_token')
    expires_at = self.tokens.get('supabase_token_expires_at', 0)
    
    # Check if token exists and is not expired (with 5 min buffer)
    if supabase_token and time.time() < (expires_at - 300):
        return supabase_token  # ← Returns cached token, skips API call
    
    # Token expired or doesn't exist, get a new one
    print("[INFO] Supabase token expired or missing, getting new one...")
    for attempt in range(3):
        try:
            return self.get_supabase_token()  # ← Calls AI server
        except (requests.exceptions.ConnectionError, ...):
            # Retry logic
            ...
```

**The caching window:**
- JWT expires in 3600 seconds (1 hour)
- Desktop app refreshes when `time.time() >= (expires_at - 300)` (5-min buffer)
- **Effective cache duration: 55 minutes**

### 6. Who Is Affected?

**Users affected by this issue:**

1. **Old users (before backfill fix was deployed)**
   - `supabase_user_id` is NULL or has a wrong value
   - Never logged out/in after the fix was deployed
   
2. **Users who update the app frequently**
   - Update desktop app → launch within 55 minutes → cached JWT used → backfill skipped
   
3. **Users in the "session restore" path**
   - Most users only do a full OAuth login once
   - Every subsequent launch uses session restore (refresh token)
   - Session restore path calls `_update_desktop_status` (line 11054)

**Users NOT affected:**

1. **New users** (created after backfill fix)
   - `supabase_user_id` is correctly set on creation (auth-controller.js:328-333)
   
2. **Users who log out/in** after each update
   - Forces JWT refresh → backfill runs → RLS works
   
3. **Users who wait >55 minutes** before launching after update
   - JWT expires → fresh token → backfill runs

### 7. Evidence of the Issue

#### Log Pattern (When RLS Blocks Update)

```
[OK] User 123e4567-e89b-12d3-a456-426614174000 verified in database
[OK] Supabase JWT set on client (PostgREST + Storage)
[WARN] Desktop status update returned no rows - RLS may be blocking
```

#### Database Query to Find Affected Users

```sql
SELECT 
    id,
    atlassian_account_id,
    email,
    display_name,
    desktop_app_version,
    desktop_last_heartbeat,
    supabase_user_id,
    CASE 
        WHEN supabase_user_id IS NULL THEN 'NULL'
        WHEN supabase_user_id != id THEN 'MISMATCH'
        ELSE 'OK'
    END as supabase_user_id_status
FROM users
WHERE desktop_logged_in = true
  AND desktop_last_heartbeat > NOW() - INTERVAL '7 days'
ORDER BY desktop_last_heartbeat DESC;
```

**Expected results:**
```
| id                                   | supabase_user_id                     | status    |
|--------------------------------------|--------------------------------------|-----------|
| 123e4567-e89b-12d3-a456-426614174000 | NULL                                 | NULL      | ← Problem
| 987fcdeb-51a2-43d1-b789-123456789abc | 11111111-2222-3333-4444-555555555555 | MISMATCH  | ← Problem
| abcdef01-2345-6789-abcd-ef0123456789 | abcdef01-2345-6789-abcd-ef0123456789 | OK        | ← Works
```

### 8. Why The Current Fix Doesn't Fully Solve It

The current fix (auth-controller.js:612-625) is **correct but incomplete**:

✅ **What it does:**
- Backfills `supabase_user_id = dbUser.id` when `/api/auth/exchange-token` is called
- Uses service role key (bypasses RLS)
- Prevents the issue for NEW JWT requests

❌ **What it misses:**
- Doesn't handle cached JWTs (55-minute window)
- Doesn't migrate existing users with NULL/wrong `supabase_user_id`
- Desktop app trusts cached JWT and never calls the API

### 9. Impact Analysis

#### User Experience Impact

1. **Confusion**: Users see "Update Available" banner even after updating
2. **Support burden**: Users contact support reporting the banner won't go away
3. **Analytics**: Version adoption metrics are incorrect
4. **Feature rollout**: Can't accurately track who has the latest version

#### Technical Impact

1. **Silent failures**: Updates fail without visible errors to users
2. **Data inconsistency**: Database shows old versions when apps are actually updated
3. **Dashboard inaccuracy**: Admin dashboard shows wrong version distribution
4. **Monitoring blind spot**: Can't detect update failures vs. users declining updates

---

## Solutions

### Solution 1: One-Time Database Migration (Recommended)

**Run a migration to backfill all users' `supabase_user_id` field:**

```sql
-- Backfill supabase_user_id for all users where it's NULL or mismatched
UPDATE public.users
SET supabase_user_id = id
WHERE supabase_user_id IS NULL 
   OR supabase_user_id != id;

-- Verify the fix
SELECT 
    COUNT(*) as total_users,
    COUNT(*) FILTER (WHERE supabase_user_id = id) as correct_users,
    COUNT(*) FILTER (WHERE supabase_user_id IS NULL) as null_users,
    COUNT(*) FILTER (WHERE supabase_user_id IS NOT NULL AND supabase_user_id != id) as mismatched_users
FROM public.users;
```

**Pros:**
- ✅ Fixes all existing users immediately
- ✅ No desktop app changes needed
- ✅ No user action required

**Cons:**
- ⚠️ Requires database access
- ⚠️ Must coordinate with backend deployment

---

### Solution 2: Force JWT Refresh on App Startup

**Modify `get_valid_supabase_token()` to ignore cached JWT on first startup after update:**

```python
# In desktop_app.py

def get_valid_supabase_token(self, force_refresh=False):
    """Get a valid Supabase token, refreshing if needed
    
    Args:
        force_refresh: If True, ignores cached token and fetches new one
    """
    supabase_token = self.tokens.get('supabase_token')
    expires_at = self.tokens.get('supabase_token_expires_at', 0)
    
    # Check if token exists and is not expired (with 5 min buffer)
    if not force_refresh and supabase_token and time.time() < (expires_at - 300):
        return supabase_token
    
    # Token expired, force refresh requested, or doesn't exist - get a new one
    print("[INFO] Supabase token refresh requested...")
    for attempt in range(3):
        try:
            return self.get_supabase_token()  # Calls AI server → backfill runs
        except (...):
            # Existing retry logic
            ...

# In run() method, during session restore:
def run(self):
    # ... existing code ...
    
    if self.auth_manager.is_authenticated():
        if is_online:
            # ... existing code ...
            
            # Force JWT refresh on app startup to ensure supabase_user_id is correct
            # This is needed for users who installed before the backfill fix
            if self.initialize_supabase(force_jwt_refresh=True):
                print("[OK] Supabase initialized with fresh JWT")
            
            # ... rest of session restore logic ...
```

**Pros:**
- ✅ Guarantees backfill runs for all users on next app launch
- ✅ No database migration needed

**Cons:**
- ⚠️ Requires desktop app code change + new release
- ⚠️ Users must update to the fixed version
- ⚠️ Adds ~2-3 seconds to startup time (API call)

---

### Solution 3: Hybrid Approach (Best Long-Term)

**Combine both solutions:**

1. **Immediate**: Run database migration to fix existing users
2. **Long-term**: Implement force refresh logic for resilience

This ensures:
- Existing users are fixed immediately (no waiting for next release)
- New installations always backfill correctly
- System is resilient to future similar issues

---

## Recommended Implementation Plan

### Phase 1: Immediate Fix (Database Migration)

1. **Backup database** (standard pre-migration practice)

2. **Run migration script:**
   ```sql
   -- Script: backfill_supabase_user_id.sql
   BEGIN;
   
   -- Log before counts
   CREATE TEMP TABLE migration_before_counts AS
   SELECT 
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE supabase_user_id IS NULL) as null_count,
       COUNT(*) FILTER (WHERE supabase_user_id != id) as mismatch_count
   FROM public.users;
   
   -- Perform backfill
   UPDATE public.users
   SET supabase_user_id = id,
       updated_at = NOW()
   WHERE supabase_user_id IS NULL 
      OR supabase_user_id != id;
   
   -- Log after counts and results
   INSERT INTO admin_logs (log_level, message, created_at)
   SELECT 
       'INFO',
       format('Backfilled supabase_user_id: %s users fixed (%s NULL, %s mismatched)',
              b.null_count + b.mismatch_count,
              b.null_count,
              b.mismatch_count),
       NOW()
   FROM migration_before_counts b;
   
   COMMIT;
   ```

3. **Verify migration:**
   ```sql
   -- Should return 0 for null_users and mismatched_users
   SELECT 
       COUNT(*) as total_users,
       COUNT(*) FILTER (WHERE supabase_user_id = id) as correct_users,
       COUNT(*) FILTER (WHERE supabase_user_id IS NULL) as null_users,
       COUNT(*) FILTER (WHERE supabase_user_id IS NOT NULL AND supabase_user_id != id) as mismatched_users
   FROM public.users;
   ```

### Phase 2: Long-Term Resilience (Desktop App Update)

1. **Implement force refresh on version change:**
   - Detect when `APP_VERSION` differs from last stored version
   - Force JWT refresh on first launch after update
   - Store last processed version in local storage

2. **Add telemetry:**
   - Log when RLS blocks an update (already present)
   - Send diagnostic data to AI server for monitoring

3. **Improve error handling:**
   - Retry `_update_desktop_status` with exponential backoff
   - Surface errors to user if persistent (with actionable guidance)

### Phase 3: Monitoring & Validation

1. **Database query to monitor affected users** (run daily):
   ```sql
   SELECT 
       COUNT(*) as affected_users
   FROM users
   WHERE (supabase_user_id IS NULL OR supabase_user_id != id)
     AND desktop_logged_in = true
     AND desktop_last_heartbeat > NOW() - INTERVAL '24 hours';
   ```
   Alert if count > 0 after migration.

2. **Desktop app telemetry:**
   - Track `_update_desktop_status` success/failure rate
   - Alert if failure rate > 5%

3. **Forge UI banner accuracy:**
   - Track false "Update Available" banner reports
   - Should drop to ~0 after migration

---

## Testing Strategy

### Test Case 1: User with NULL supabase_user_id

**Setup:**
```sql
-- Create test user with NULL supabase_user_id
INSERT INTO users (id, atlassian_account_id, email, supabase_user_id, organization_id)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    'test-account-1',
    'test1@example.com',
    NULL,  -- ← NULL value
    'org-uuid-here'
);
```

**Test Steps:**
1. Desktop app launches with valid JWT (sub = user.id)
2. `_update_desktop_status(logged_in=True)` is called
3. RLS should BLOCK the update (before migration)

**Expected Outcome (Before Migration):**
- ❌ Update fails
- Log: "[WARN] Desktop status update returned no rows - RLS may be blocking"

**Expected Outcome (After Migration):**
- ✅ `supabase_user_id` is backfilled to `11111111-1111-1111-1111-111111111111`
- ✅ Update succeeds
- ✅ `desktop_app_version` is updated correctly

### Test Case 2: User with Mismatched supabase_user_id

**Setup:**
```sql
-- Create test user with wrong supabase_user_id
INSERT INTO users (id, atlassian_account_id, email, supabase_user_id, organization_id)
VALUES (
    '22222222-2222-2222-2222-222222222222',
    'test-account-2',
    'test2@example.com',
    '99999999-9999-9999-9999-999999999999',  -- ← Wrong UUID
    'org-uuid-here'
);
```

**Test Steps:**
1. Desktop app launches
2. JWT is minted with sub = `22222222-2222-2222-2222-222222222222`
3. `_update_desktop_status` called
4. RLS check: `auth.uid() = supabase_user_id` → `22222222...` != `99999999...`

**Expected Outcome (Before Migration):**
- ❌ Update fails

**Expected Outcome (After Migration):**
- ✅ `supabase_user_id` is corrected to `22222222-2222-2222-2222-222222222222`
- ✅ Update succeeds

### Test Case 3: User with Correct supabase_user_id (Control)

**Setup:**
```sql
-- User with correct supabase_user_id
INSERT INTO users (id, atlassian_account_id, email, supabase_user_id, organization_id)
VALUES (
    '33333333-3333-3333-3333-333333333333',
    'test-account-3',
    'test3@example.com',
    '33333333-3333-3333-3333-333333333333',  -- ← Correct (matches id)
    'org-uuid-here'
);
```

**Test Steps:**
1. Desktop app launches
2. `_update_desktop_status` called

**Expected Outcome (Before and After Migration):**
- ✅ Update succeeds (no change needed)
- ✅ No migration applied (already correct)

---

## Related Issues & Documentation

### Related Planning Documents

- [fix-stale-desktop-banner.md](../plan/fix-stale-desktop-banner.md) - Original fix for session restore not updating status
- [SESSION_BUG_ROOT_CAUSE_ANALYSIS.md](../plan/SESSION_BUG_ROOT_CAUSE_ANALYSIS.md) - Analysis of JWT token and session maintenance issues
- [2026-05-06_python-desktop-app_fix-session-maintenance.md](../plan/2026-05-06_python-desktop-app_fix-session-maintenance.md) - Session maintenance fix implementation

### Key Code Locations

#### Desktop App (python-desktop-app/desktop_app.py)

- **Line 2266-2346**: `get_supabase_token()` - Calls AI server for JWT
- **Line 2350-2386**: `get_valid_supabase_token()` - JWT caching logic (55-min window)
- **Line 5225-5285**: `initialize_supabase()` - Supabase client initialization
- **Line 5288-5325**: `_set_supabase_jwt()` - Sets JWT on client
- **Line 6412-6454**: `_update_desktop_status()` - Updates version in DB (RLS applies here)
- **Line 11054**: Session restore calls `_update_desktop_status(logged_in=True)`

#### AI Server (ai-server/src/controllers/auth-controller.js)

- **Line 572-693**: `exchangeToken()` - Mints JWT and backfills `supabase_user_id`
- **Line 612-625**: Backfill logic (only runs when API is called)
- **Line 636-670**: JWT payload construction (sub = dbUser.id)

#### Database (supabase/)

- **DEV_MIGRATION_COMPLETE.sql:25-50**: Users table schema
- **DEV_MIGRATION_COMPLETE.sql:842-843**: RLS policy `users_update_own`
- **DEV_MIGRATION_COMPLETE.sql:478-491**: `get_current_user_id()` function (uses `supabase_user_id`)

---

## Frequently Asked Questions

### Q1: Why not just remove the RLS policy?

**A:** RLS is critical for multi-tenant security. It prevents users from accidentally (or maliciously) updating other users' records. Removing it would create a security vulnerability.

### Q2: Why not change the RLS policy to use `id` instead of `supabase_user_id`?

**A:** Other parts of the codebase rely on the current RLS pattern:
- `get_current_user_id()` function (DEV_MIGRATION_COMPLETE.sql:489)
- Other RLS policies reference `get_current_user_id()` extensively
- Changing this would require a massive refactoring effort

The migration to set `supabase_user_id = id` is the path of least resistance.

### Q3: How many users are affected?

**A:** Run this query to find out:

```sql
SELECT 
    COUNT(*) FILTER (WHERE supabase_user_id IS NULL) as null_count,
    COUNT(*) FILTER (WHERE supabase_user_id != id) as mismatch_count,
    COUNT(*) FILTER (WHERE supabase_user_id = id) as correct_count,
    COUNT(*) as total
FROM users
WHERE desktop_logged_in = true;
```

Expected: Most users created recently (after the backfill fix) should be correct. Users created before early 2026 may have NULL/mismatch issues.

### Q4: Will the migration break anything?

**A:** No. Setting `supabase_user_id = id` is exactly what the backfill logic does (auth-controller.js:618). This migration just applies it retroactively to all users instead of waiting for their next JWT refresh.

### Q5: Why does the JWT have `sub = dbUser.id` instead of `supabase_user_id`?

**A:** Historical reasons. The JWT minting logic predates the RLS policy implementation. When RLS was added, it assumed `supabase_user_id` would equal `id`, but for older users this field was never populated. The backfill logic was added later to fix this, but doesn't handle cached JWTs.

### Q6: Can we just force all users to log out/in?

**A:** That would work but creates a poor user experience. The database migration is cleaner and requires no user action.

---

## Monitoring Queries

### Active Users with Incorrect supabase_user_id

```sql
SELECT 
    id,
    atlassian_account_id,
    email,
    desktop_app_version,
    desktop_last_heartbeat,
    CASE 
        WHEN supabase_user_id IS NULL THEN 'NULL'
        WHEN supabase_user_id != id THEN 'MISMATCH'
    END as issue_type
FROM users
WHERE desktop_logged_in = true
  AND desktop_last_heartbeat > NOW() - INTERVAL '7 days'
  AND (supabase_user_id IS NULL OR supabase_user_id != id)
ORDER BY desktop_last_heartbeat DESC;
```

### Version Distribution (Before vs After Migration)

```sql
-- Before migration: May show stale versions
-- After migration: Should show accurate versions
SELECT 
    desktop_app_version,
    COUNT(*) as user_count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage,
    MIN(desktop_last_heartbeat) as oldest_heartbeat,
    MAX(desktop_last_heartbeat) as newest_heartbeat
FROM users
WHERE desktop_logged_in = true
  AND desktop_last_heartbeat > NOW() - INTERVAL '7 days'
GROUP BY desktop_app_version
ORDER BY desktop_app_version DESC;
```

### Failed Update Attempts (From Admin Logs)

```sql
SELECT 
    DATE_TRUNC('hour', created_at) as hour,
    COUNT(*) as failure_count
FROM admin_logs
WHERE message LIKE '%Desktop status update returned no rows%'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY hour
ORDER BY hour DESC;
```

---

## Conclusion

The root cause of desktop app versions not updating in the database is a **Row Level Security policy mismatch** caused by NULL or incorrect `supabase_user_id` values for users who installed before the backfill logic was implemented.

The issue is exacerbated by JWT caching (55-minute window) which prevents the backfill logic from running even when users update the app and launch it immediately.

**Recommended Solution**: Run a one-time database migration to backfill `supabase_user_id = id` for all users. This will immediately fix the issue for all affected users without requiring code changes or user action.

**Priority**: High - This affects user experience (false update banners) and prevents accurate version tracking for feature rollouts and analytics.

# Root Cause Analysis: Desktop App Version Not Updating in Database

**Date:** 2026-05-14  
**Issue:** Users who install the latest desktop app version (manually or automatically) do not have the version reflected in the database  
**Impact:** High — Affects update tracking, support diagnostics, and user communications about available updates  
**Status:** Analysis Complete — Fix Proposed  

---

## Executive Summary

**Root Cause:** Users with `supabase_user_id IS NULL` or `supabase_user_id != id` cannot update their own records due to Row Level Security (RLS) policy blocking the update. The desktop app's heartbeat mechanism attempts to update `desktop_app_version` via a user-scoped JWT, but the RLS policy's `get_current_user_id()` function returns `NULL` when `supabase_user_id` is not properly set, causing the UPDATE to be silently rejected.

**Severity:** Critical — Affects an unknown percentage of users, likely those who:
1. Were created before the 2026-04-01 migration that backfills `supabase_user_id`
2. Were auto-provisioned but the backfill update failed silently
3. Have stale cached credentials that don't trigger re-authentication

**Affected Components:**
- Desktop app (heartbeat mechanism)
- RLS policies on `users` table
- Authentication flow in `ai-server/src/controllers/auth-controller.js`

---

## Technical Deep Dive

### 1. Authentication and RLS Architecture

#### JWT Flow (Working Path)
```
1. Desktop app → AI server: Exchange Atlassian token
2. AI server validates token with Atlassian API
3. AI server looks up user in database by atlassian_account_id
4. AI server mints custom Supabase JWT:
   {
     sub: dbUser.id,              // Critical: This is the database UUID
     role: 'authenticated',
     app_metadata: {
       org_id: dbUser.organization_id
     }
   }
5. Desktop app initializes Supabase client with:
   - supabase_anon_key (for connection)
   - Custom JWT (for RLS scope via setAuth())
```

#### RLS Policy on users Table
```sql
CREATE POLICY users_update_self ON public.users 
AS PERMISSIVE 
FOR UPDATE 
USING (id = get_current_user_id());
```

**Translation:** Users can only UPDATE their own row if `id` matches the result of `get_current_user_id()`.

#### get_current_user_id() Function
```sql
CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS UUID AS $$
BEGIN
    RETURN (
        SELECT id 
        FROM public.users 
        WHERE supabase_user_id = auth.uid() 
        LIMIT 1
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
```

**Key Dependency:** This function requires `supabase_user_id = auth.uid()` to resolve the user.

- `auth.uid()` returns the `sub` claim from the JWT = `dbUser.id`
- For this to work: `supabase_user_id` MUST equal `dbUser.id`
- If `supabase_user_id` is `NULL` or points to a different value, the function returns `NULL`
- The RLS check becomes `id = NULL`, which is **always FALSE** in SQL
- Result: **UPDATE is silently rejected with 0 rows affected**

---

### 2. Heartbeat Mechanism (Where the Failure Occurs)

**File:** `python-desktop-app/desktop_app.py`, lines 6453-6471

```python
def _send_heartbeat(self):
    """Send heartbeat to Supabase to indicate app is still running"""
    if not self.current_user_id or self.current_user_id.startswith('anonymous_'):
        return

    try:
        client = self.supabase  # User-scoped client with JWT
        if not client:
            return

        client.table('users').update({
            'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
            'desktop_app_version': self.app_version  # THIS LINE FAILS
        }).eq('id', self.current_user_id).execute()

        print(f"[OK] Heartbeat sent (v{self.app_version})")

    except Exception as e:
        print(f"[WARN] Failed to send heartbeat: {e}")
```

**Execution Path:**
1. Desktop app's tracking loop calls `_send_heartbeat()` every 4 hours
2. The `client.table('users').update()` call goes to Supabase with the user JWT
3. Supabase evaluates the RLS policy:
   - Extracts `sub` from JWT = user's database `id`
   - Calls `get_current_user_id()` which does `WHERE supabase_user_id = auth.uid()`
   - If `supabase_user_id` is missing/incorrect: returns `NULL`
   - RLS check fails: `id = NULL` evaluates to `FALSE`
   - **UPDATE affects 0 rows**
4. The `.execute()` call succeeds (HTTP 200) but returns empty `data: []`
5. Desktop app logs "[OK] Heartbeat sent" even though nothing was updated

**Critical Observation:** The desktop app doesn't check `result.data` after the update, so it doesn't know the update was blocked. This is why the issue is silent and hard to detect.

---

### 3. User Auto-Provisioning (Where the Data Gap Originates)

**File:** `ai-server/src/controllers/auth-controller.js`, lines 305-345

#### Scenario A: New User Auto-Provisioning
```javascript
// Create new user
const { data: newUser, error: createUserError } = await supabase
  .from('users')
  .insert({
    atlassian_account_id: atlassianAccountId,
    organization_id: organization.id,
    email: email || null,
    display_name: displayName || null
    // NOTE: supabase_user_id is NOT set here!
  })
  .select()
  .single();

if (createUserError) throw createUserError;

// Separate update to backfill supabase_user_id
const { error: backfillError } = await supabase
  .from('users')
  .update({ supabase_user_id: newUser.id })  // Fix it immediately
  .eq('id', newUser.id);

if (backfillError) {
  logger.error('[Auth] Failed to set supabase_user_id for new user %s: %s', 
    newUser.id, backfillError.message);
  throw backfillError;
}
```

**Why This Pattern is Fragile:**
- The INSERT and UPDATE are separate database calls
- If the UPDATE fails (network issue, permission issue, timeout), `supabase_user_id` remains `NULL`
- The error is logged but the user might still be authenticated
- The AI server uses `SERVICE_ROLE_KEY` which bypasses RLS, so the backfill update usually works
- However, if there's any transaction rollback or silent failure, the user is left in a broken state

#### Scenario B: Existing User with Missing supabase_user_id

**File:** `ai-server/src/controllers/auth-controller.js`, lines 614-630

```javascript
// Defensive check in exchangeToken endpoint
if (!dbUser.supabase_user_id || dbUser.supabase_user_id !== dbUser.id) {
  const supabase = getClient();
  if (supabase) {
    const { error: updateError } = await supabase
      .from('users')
      .update({ supabase_user_id: dbUser.id })
      .eq('id', dbUser.id);

    if (updateError) {
      logger.error('[Auth] Failed to set supabase_user_id for user %s: %s', 
        atlassianAccountId, updateError.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to update user profile for authentication' 
      });
    }
    logger.info('[Auth] Set supabase_user_id = %s for user %s', dbUser.id, atlassianAccountId);
  }
}
```

**Good News:** This defensive fix was added to repair broken users when they re-authenticate.

**Bad News:** This only runs during `/api/auth/exchange-token` calls, which happen:
- During initial OAuth login
- When the desktop app explicitly refreshes its Supabase JWT
- **NOT during routine heartbeats** — the heartbeat uses the already-initialized Supabase client with cached JWT

**Implication:** Users who logged in before this fix was deployed, or whose update failed silently, will remain broken until they:
1. Manually log out and log back in (rare)
2. The JWT expires and forces a refresh (1 hour expiry, but refresh tokens can last weeks)
3. The desktop app restarts and re-authenticates from scratch (depends on session restore logic)

---

### 4. Database Migration History

**File:** `supabase/migrations/20260401_drop_supabase_user_id_fk_and_backfill.sql`

```sql
-- Step 2: Backfill supabase_user_id = id for all existing users
UPDATE public.users
SET supabase_user_id = id
WHERE supabase_user_id IS NULL
   OR supabase_user_id != id;
```

**What This Migration Did:**
- Removed the foreign key constraint from `users.supabase_user_id` → `auth.users(id)`
- Backfilled `supabase_user_id = id` for all rows at migration time (2026-04-01)

**What It DIDN'T Do:**
- Prevent future INSERTs with `supabase_user_id IS NULL`
- Add a constraint to enforce `supabase_user_id = id`
- Add a database trigger to auto-populate this column on INSERT

**Result:** Any users created AFTER 2026-04-01 via the auto-provision code path are vulnerable to the two-step INSERT→UPDATE race condition.

---

## How Users Get Into a Broken State

### Path 1: Pre-Migration Users (Before 2026-04-01)
1. User was created before the migration
2. Migration backfilled `supabase_user_id = id`
3. ✅ User can update their record (works)

### Path 2: Post-Migration Users — Happy Path
1. User auto-provisions via `autoProvisionUser()` (lines 305-345)
2. INSERT creates user (no `supabase_user_id` set)
3. Immediate UPDATE sets `supabase_user_id = newUser.id`
4. ✅ User can update their record (works)

### Path 3: Post-Migration Users — Backfill Update Fails
1. User auto-provisions via `autoProvisionUser()`
2. INSERT creates user (no `supabase_user_id` set)
3. UPDATE to set `supabase_user_id` fails due to:
   - Network timeout
   - Database connection issue
   - RLS misconfiguration (though AI server uses service role key)
   - Exception thrown before UPDATE executes
4. Error is logged but user might still get authenticated
5. ❌ User CANNOT update their own record — RLS blocks all UPDATEs
6. Desktop app's heartbeat fails silently
7. `desktop_app_version` never updates

### Path 4: Users with Cached Sessions (Most Common)
1. User logs in successfully before any issues
2. Desktop app caches Atlassian refresh token and Supabase JWT
3. User closes and reopens desktop app
4. Desktop app restores session from cache (no call to `/api/auth/exchange-token`)
5. If the user's `supabase_user_id` was never set correctly, the defensive fix never runs
6. ❌ User's version updates fail silently every 4 hours

---

## Evidence of the Issue

### Database Query to Find Affected Users
```sql
-- Users with missing or incorrect supabase_user_id
SELECT 
  id,
  email,
  display_name,
  atlassian_account_id,
  desktop_app_version,
  desktop_last_heartbeat,
  supabase_user_id,
  CASE 
    WHEN supabase_user_id IS NULL THEN 'NULL (broken)'
    WHEN supabase_user_id != id THEN 'Mismatch (broken)'
    ELSE 'Correct'
  END as status
FROM public.users
WHERE supabase_user_id IS NULL 
   OR supabase_user_id != id
ORDER BY desktop_last_heartbeat DESC NULLS LAST;
```

### Expected Results
- **If count > 0:** These users CANNOT update their `desktop_app_version` via RLS
- **desktop_last_heartbeat:** Will show stale timestamps (4+ hours old) if the user is actively running the desktop app
- **desktop_app_version:** Will show old version even if user upgraded

### Desktop App Logs to Look For
```
[OK] Heartbeat sent (v1.3.7)
```
**Followed by checking Supabase:**
- If `desktop_app_version` is still showing `v1.3.5`, the RLS policy blocked the update

---

## Proposed Fix

### Phase 1: Emergency Database Backfill (Zero Code Changes)

**Goal:** Fix all existing broken users immediately.

**Migration File:** `supabase/migrations/20260514_fix_missing_supabase_user_id.sql`

```sql
-- ============================================================================
-- Migration: Fix missing/incorrect supabase_user_id for all users
-- Date: 2026-05-14
-- Context: Users with supabase_user_id != id cannot update their own records
--          due to RLS policy depending on get_current_user_id() function.
-- ============================================================================

-- Step 1: Identify and log affected users (for audit trail)
DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO affected_count
  FROM public.users
  WHERE supabase_user_id IS NULL 
     OR supabase_user_id != id;
  
  RAISE NOTICE 'Found % users with incorrect supabase_user_id', affected_count;
END;
$$;

-- Step 2: Backfill supabase_user_id = id for all affected users
UPDATE public.users
SET supabase_user_id = id
WHERE supabase_user_id IS NULL 
   OR supabase_user_id != id;

-- Step 3: Add NOT NULL constraint to prevent future NULLs
-- (Existing rows are now guaranteed to have a value)
ALTER TABLE public.users
ALTER COLUMN supabase_user_id SET NOT NULL;

-- Step 4: Add CHECK constraint to enforce supabase_user_id = id
-- This prevents the two-step INSERT→UPDATE pattern from leaving broken rows
ALTER TABLE public.users
ADD CONSTRAINT users_supabase_user_id_equals_id 
CHECK (supabase_user_id = id);

-- Step 5: Create index if not exists (already exists from 20260401 migration)
CREATE INDEX IF NOT EXISTS idx_users_supabase_user_id
ON public.users USING btree (supabase_user_id);

-- Documentation
COMMENT ON CONSTRAINT users_supabase_user_id_equals_id ON public.users IS 
  'Ensures supabase_user_id always equals id for RLS to work correctly with get_current_user_id()';
```

**Impact:**
- ✅ All existing users fixed immediately
- ✅ NOT NULL constraint prevents future NULLs
- ✅ CHECK constraint prevents future mismatches
- ⚠️ This will **BREAK** the auto-provision code's two-step pattern (see Phase 2)

---

### Phase 2: Fix Auto-Provision Code (Required After Phase 1)

**File:** `ai-server/src/controllers/auth-controller.js`, lines 315-328

**Problem:** The CHECK constraint added in Phase 1 will cause the INSERT to fail if `supabase_user_id` is not provided.

**Solution:** Set `supabase_user_id = DEFAULT` in the INSERT, then let a database DEFAULT expression or trigger populate it.

#### Option A: Use Database DEFAULT Expression (Recommended)

**Migration File:** `supabase/migrations/20260514_add_supabase_user_id_default.sql`

```sql
-- Set DEFAULT for supabase_user_id to auto-populate on INSERT
ALTER TABLE public.users
ALTER COLUMN supabase_user_id SET DEFAULT gen_random_uuid();

-- Create trigger to set supabase_user_id = id after INSERT
CREATE OR REPLACE FUNCTION public.set_supabase_user_id_to_id()
RETURNS TRIGGER AS $$
BEGIN
  -- Only set if not explicitly provided (though it should always trigger)
  IF NEW.supabase_user_id IS NULL OR NEW.supabase_user_id = NEW.id THEN
    NEW.supabase_user_id := NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_supabase_user_id
BEFORE INSERT ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.set_supabase_user_id_to_id();
```

**Update JavaScript Code:**

```javascript
// Before (lines 315-345) — REMOVE the two-step pattern
const { data: newUser, error: createUserError } = await supabase
  .from('users')
  .insert({
    atlassian_account_id: atlassianAccountId,
    organization_id: organization.id,
    email: email || null,
    display_name: displayName || null,
    // supabase_user_id will be auto-set by trigger to match id
  })
  .select()
  .single();

if (createUserError) throw createUserError;

// REMOVE the separate backfill update — no longer needed
// The trigger handles it atomically

dbUser = newUser;
dbUser.supabase_user_id = newUser.id; // For local reference
```

**Benefits:**
- ✅ Atomic INSERT — no race condition
- ✅ Works with CHECK constraint
- ✅ No separate UPDATE needed
- ✅ Guaranteed consistency

#### Option B: Computed Generated Column (PostgreSQL 12+)

**Migration File (Alternative):**

```sql
-- Drop existing column and recreate as GENERATED
ALTER TABLE public.users
DROP COLUMN supabase_user_id;

ALTER TABLE public.users
ADD COLUMN supabase_user_id UUID 
GENERATED ALWAYS AS (id) STORED;

-- Index still needed for performance
CREATE INDEX IF NOT EXISTS idx_users_supabase_user_id
ON public.users USING btree (supabase_user_id);
```

**Benefits:**
- ✅ Impossible to have mismatch — database enforces equality
- ✅ No trigger overhead
- ✅ No application code changes needed

**Drawbacks:**
- ⚠️ GENERATED columns are immutable — cannot be updated manually (not a problem here)
- ⚠️ Migration requires column drop/recreate (data preserved automatically)

---

### Phase 3: Improve Desktop App Error Handling

**File:** `python-desktop-app/desktop_app.py`, line 6462

**Current Code:**
```python
client.table('users').update({
    'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
    'desktop_app_version': self.app_version
}).eq('id', self.current_user_id).execute()

print(f"[OK] Heartbeat sent (v{self.app_version})")
```

**Problem:** Doesn't check if the update actually affected any rows.

**Improved Code:**
```python
result = client.table('users').update({
    'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
    'desktop_app_version': self.app_version
}).eq('id', self.current_user_id).execute()

# Check if the update actually happened
if not result.data or len(result.data) == 0:
    print(f"[WARN] Heartbeat update affected 0 rows - RLS may be blocking update")
    print(f"[WARN] User ID: {self.current_user_id}, Version: {self.app_version}")
    # Optionally: Force re-authentication to fix broken supabase_user_id
    # self._handle_authentication_error()
else:
    print(f"[OK] Heartbeat sent (v{self.app_version})")
```

**Benefits:**
- ✅ Visible error messages when RLS blocks updates
- ✅ Helps diagnose similar issues in the future
- ✅ Could trigger automatic remediation (force re-auth)

---

### Phase 4: Add Monitoring and Alerts

**Query to Add to Admin Dashboard:**

```sql
-- Users with stale heartbeats (logged in but not updating)
SELECT 
  u.id,
  u.email,
  u.display_name,
  u.desktop_app_version,
  u.desktop_last_heartbeat,
  u.desktop_logged_in,
  EXTRACT(EPOCH FROM (NOW() - u.desktop_last_heartbeat))/3600 AS hours_since_heartbeat,
  CASE 
    WHEN u.supabase_user_id IS NULL THEN 'Missing supabase_user_id'
    WHEN u.supabase_user_id != u.id THEN 'Mismatched supabase_user_id'
    ELSE 'OK'
  END as rls_status
FROM public.users u
WHERE u.desktop_logged_in = TRUE
  AND u.desktop_last_heartbeat < NOW() - INTERVAL '6 hours'
ORDER BY u.desktop_last_heartbeat DESC;
```

**Alert Trigger:**
- If count > 5 users with stale heartbeats for 6+ hours
- Send notification to ops team
- Could indicate RLS misconfiguration or network issues

---

## Testing Plan

### Test 1: Verify Fix for Existing Broken Users

**Steps:**
1. Run diagnostic query to find users with incorrect `supabase_user_id`
2. Apply Phase 1 migration
3. Re-run query to confirm all users fixed
4. Pick a test user, log into desktop app, wait for heartbeat (or force it)
5. Verify `desktop_app_version` updates in database

**Expected Result:** All broken users can now update their version.

### Test 2: Verify New User Auto-Provisioning

**Steps:**
1. Create a new Atlassian account (or use a test account)
2. Log into desktop app for the first time
3. Verify user is auto-provisioned in database
4. Check that `supabase_user_id = id` (no NULL, no mismatch)
5. Wait for heartbeat or close/reopen app
6. Verify `desktop_app_version` updates correctly

**Expected Result:** New users have correct `supabase_user_id` from the start.

### Test 3: Verify Constraint Prevents Future Issues

**Steps:**
1. Attempt to INSERT a user with `supabase_user_id = NULL` (via SQL)
2. Attempt to INSERT a user with `supabase_user_id != id` (via SQL)
3. Both should FAIL with constraint violation

**Expected Result:** Database prevents creation of broken user records.

### Test 4: Verify Desktop App Error Reporting

**Steps:**
1. Manually corrupt a test user's `supabase_user_id` in database:
   ```sql
   UPDATE users SET supabase_user_id = gen_random_uuid() WHERE id = '<test-user-id>';
   ```
2. Log into desktop app as that user
3. Wait for heartbeat or force it
4. Check desktop app logs for warning message

**Expected Result:** Desktop app logs clear warning about RLS blocking update.

---

## Risk Assessment

### Risk 1: CHECK Constraint Breaks Existing Code
- **Likelihood:** High
- **Impact:** High (application errors)
- **Mitigation:** Deploy Phase 2 (trigger or generated column) BEFORE Phase 1 (constraint)

### Risk 2: Migration Takes Too Long on Large Users Table
- **Likelihood:** Medium (depends on user count)
- **Impact:** Medium (downtime during migration)
- **Mitigation:** 
  - Test migration on staging with production-scale data
  - Run during low-traffic window
  - Consider adding index before UPDATE for faster query

### Risk 3: Users with Active Sessions Don't Get Fixed Until Re-Auth
- **Likelihood:** High
- **Impact:** Low (fixes gradually as users re-auth)
- **Mitigation:**
  - Phase 1 backfill fixes database immediately
  - Existing JWT tokens remain valid until expiry (1 hour)
  - Next heartbeat after JWT refresh will work

### Risk 4: Orphaned Users Created During Migration
- **Likelihood:** Low
- **Impact:** Low (single user affected)
- **Mitigation:**
  - Transaction wrapping in auto-provision code
  - Retry logic on constraint violation

---

## Recommended Deployment Order

1. **Phase 2 FIRST** — Deploy trigger/generated column solution (no breaking changes)
2. **Phase 1** — Deploy backfill + constraints (depends on Phase 2)
3. **Phase 3** — Desktop app error handling (optional, low priority)
4. **Phase 4** — Monitoring queries (ongoing)

**Rationale:** This order prevents breaking the auto-provision code.

---

## Conclusion

This issue is a **critical RLS misconfiguration** that prevents users from updating their own records. The root cause is a missing or incorrect `supabase_user_id` column value that breaks the `get_current_user_id()` function used by RLS policies.

**Fix Complexity:** Medium
- Database migration: Simple UPDATE + constraint
- Code changes: Minimal (remove two-step INSERT→UPDATE pattern)
- Testing: Straightforward (query-based verification)

**Fix Confidence:** High
- Root cause is well-understood
- Solution is proven (migration 20260401 already did this once)
- Adds safeguards to prevent recurrence

**Next Steps:**
1. Review this analysis with team
2. Test Phase 2 trigger solution on staging
3. Deploy Phase 2 to production
4. Deploy Phase 1 backfill + constraints
5. Monitor for successful version updates

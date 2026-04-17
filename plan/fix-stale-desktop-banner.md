# Fix: Stale Desktop App Banner (Version + Heartbeat Not Updated on Session Restore)

## Problem

Users report two false banners in the Jira Forge UI even after installing the latest desktop app version:

1. **"Update Available"** banner showing "Download Update" with the version they already have installed
2. **"Desktop App Not Active"** / stale "Last seen" timestamp even though the app is running and logged in

Both banners display accurate information based on what is stored in the Supabase `users` table -- the problem is that the table is not being updated when it should be.

## Root Cause

The desktop app has two login paths:

| Path | When it runs | Updates DB? |
|---|---|---|
| **Fresh OAuth login** | First login, or after logout | Yes -- `_update_desktop_status(logged_in=True)` is called inside `auth_callback()` |
| **Session restore** | Every subsequent app launch (token refresh) | **No** -- the session restore path at line ~10440 verified the user in the DB but never called `_update_desktop_status()` |

Most users only do a fresh OAuth login once. Every subsequent launch uses session restore (refresh token). This means `desktop_app_version`, `desktop_logged_in`, and `desktop_last_heartbeat` in the `users` table are only set on first login and then every 4 hours via heartbeat.

### How this causes false banners

**False "Update Available" banner:**

1. User installs v1.3.5, logs in via OAuth -- DB gets `desktop_app_version = '1.3.5'`
2. User later installs v1.3.7, launches the app -- session restore runs, but DB still has `'1.3.5'`
3. The Forge resolver (`getDesktopAppStatus`) queries the `users` table and the `app_releases` table
4. It compares: `isVersionNewer('1.3.7', '1.3.5')` --> `true`
5. The "Update Available" banner renders with "Current: v1.3.5" even though the user is running v1.3.7
6. After ~4 hours the heartbeat fires and updates the version, but by then the user has already seen the wrong banner

**False "Desktop App Not Active" banner:**

1. User closes laptop overnight, opens it in the morning
2. Desktop app launches, session restore runs -- but `desktop_last_heartbeat` is still from yesterday
3. The Forge resolver computes `effectiveLastActive` and finds it's >3 hours old
4. Returns `status: 'inactive'`, `showDownload: true`
5. The "Desktop App seems inactive" banner renders with a stale "Last seen" timestamp
6. Again, after ~4 hours the heartbeat corrects this

## Affected Code Path

### Session restore (desktop_app.py, line ~10395-10494)

```
App launches
  --> has_valid_session() returns True (refresh token exists)
  --> refresh_access_token() succeeds
  --> get_user_info() succeeds
  --> ensure_user_exists() runs
  --> user verified in DB
  --> [MISSING] _update_desktop_status(logged_in=True)   <-- THE BUG
  --> classification sync, offline record association, etc.
```

### Forge resolver (userResolvers.js, line 44-212)

```
invoke('getDesktopAppStatus')
  --> getLatestAppVersion() from AI server (app_releases table)
  --> query users table: desktop_logged_in, desktop_last_heartbeat, desktop_app_version
  --> query activity_records for latest batch_end
  --> compute effectiveLastActive = MAX(heartbeat, latest batch_end)
  --> compute updateAvailable = isVersionNewer(latestVersion, desktop_app_version)
  --> return status, showDownload, updateAvailable, appVersion, lastHeartbeat, etc.
```

### Frontend banner (DesktopAppStatusBanner.js)

```
Banner Priority 1 (line 87): "Update Available"
  --> renders when: status.updateAvailable && !updateDismissed
  --> shows: "Current: v{status.appVersion}" (from DB, stale)

Banner Priority 2 (line 246): "Desktop App Not Active" / "Download"
  --> renders when: status.showDownload === true
  --> triggered by: status = 'inactive' (heartbeat > 3h old) or 'not-setup' or 'logged-out'
```

## Change

**One change in a single file: `python-desktop-app/desktop_app.py`**

---

### Location

Line ~10452, inside the session restore path, after the user is verified in the database.

### What

Add a call to `_update_desktop_status(logged_in=True)` immediately after the DB verification succeeds.

**Before:**
```python
else:
    print(f"[OK] User {self.current_user_id} verified in database")
```

**After:**
```python
else:
    print(f"[OK] User {self.current_user_id} verified in database")
    self._update_desktop_status(logged_in=True)
```

### What `_update_desktop_status(logged_in=True)` does

Defined at line ~5847. It sends a single Supabase UPDATE to the `users` table:

```python
update_data = {
    'desktop_logged_in': True,              # marks app as logged in
    'desktop_last_heartbeat': <now UTC>,     # refreshes "Last seen" timestamp
    'desktop_app_version': self.app_version  # e.g. '1.3.7'
}
client.table('users').update(update_data).eq('id', self.current_user_id).execute()
```

This single call fixes both banner issues:

| Field updated | Banner fixed |
|---|---|
| `desktop_app_version` | "Update Available" -- resolver now compares correct version, `isVersionNewer('1.3.7', '1.3.7')` returns `false` |
| `desktop_last_heartbeat` | "Desktop App Not Active" -- resolver sees recent heartbeat, returns `status: 'active'` |
| `desktop_logged_in` | Prevents `status: 'logged-out'` if it was previously set to `false` |

### Why this location is correct

The call is placed inside the `try` block, after:
- Supabase client is confirmed available (`self.supabase` is not None)
- `current_user_id` is set and verified to exist in the DB (the `check.data` query returned a row)

So the UPDATE will succeed -- the user row exists and the client is authenticated.

### Why not call it earlier (e.g., right after `ensure_user_exists`)?

`ensure_user_exists` can return a user ID even when the user doesn't actually exist in the DB (stale cached ID). The DB verification check (`select('id').eq('id', ...)`) immediately after catches this. We only want to update the status after we've confirmed the user row is real.

## Impact on Existing Functionality -- NONE

| Scenario | Effect |
|---|---|
| **Fresh OAuth login** | No change. `_update_desktop_status(logged_in=True)` is already called in the OAuth callback. Calling it again during session restore on a subsequent launch is a no-op (same values). |
| **Session restore (happy path)** | The fix. DB is now updated immediately instead of waiting up to 4 hours for the heartbeat. |
| **Session restore (offline)** | No change. The offline path (line ~10489) doesn't reach this code -- `_update_desktop_status` is only called when the user was successfully verified online. |
| **Session restore (Supabase client missing)** | No change. `_update_desktop_status` checks `self.supabase` at the top and returns early if None. |
| **Session restore (anonymous user)** | No change. `_update_desktop_status` checks for `anonymous_` prefix and returns early. |
| **Heartbeat (every 4 hours)** | Still runs as before. Now serves as a keep-alive rather than the only mechanism to update version/heartbeat. |
| **Logout** | No change. Logout calls `_update_desktop_status(logged_in=False)` separately. |

## Resolver and Frontend -- NO Changes Needed

### Forge resolver (`userResolvers.js`)

The resolver logic is correct:
- `isVersionNewer()` (line 221-236): Standard semver comparison, works as expected
- `effectiveLastActive` computation (line 121-126): Correctly uses MAX(heartbeat, latest batch_end)
- 3-hour inactivity threshold (line 154): Appropriate for matching the Time Analytics timeline
- Error handling for missing `latestVersionInfo` (line 129): Falls back to `false` for `updateAvailable`

### AI server (`forge-proxy-controller.js`)

The version endpoint is correct:
- Queries `app_releases` where `is_latest=true, is_active=true` (line 1081-1087)
- Returns `latestVersion` field mapped correctly
- `parseSuccessfulResponse` in `remote.js` (line 127-133) unwraps `result.data` correctly

### Frontend (`DesktopAppStatusBanner.js`)

The banner rendering logic is correct:
- Priority 1 banner (line 87): Only shows when `updateAvailable` is truly `true`
- Priority 2 banner (line 246): Only shows when `showDownload` is truly `true`
- Dismiss logic (line 68-73): Correctly stores dismissed version in localStorage
- Re-show logic (line 44-47): Correctly resets dismiss when a new version appears
- Weekend suppression (line 80-84): Works as intended
- Once-per-day logic (line 236-239): Works for Priority 2 banners

## Spec File and Requirements -- NO Changes Needed

The change is a single method call to an existing method. No new imports, no new dependencies.

## Testing

1. **Reproduce the stale "Update Available" banner:**
   - Set `desktop_app_version` to an old value (e.g., '1.3.5') directly in Supabase for a test user
   - Ensure `app_releases` table has a newer version marked as `is_latest=true`
   - Open the Jira Forge UI -- confirm "Update Available" banner appears with "Current: v1.3.5"
   
2. **Verify the fix:**
   - Apply the change, restart the desktop app (session restore triggers)
   - Check Supabase `users` table -- `desktop_app_version` should now show the current version (e.g., '1.3.7')
   - Refresh the Jira Forge UI -- "Update Available" banner should be gone (or show only if a genuinely newer version exists)

3. **Reproduce the stale "Last seen" / inactive banner:**
   - Set `desktop_last_heartbeat` to >3 hours ago in Supabase for a test user
   - Open the Jira Forge UI -- confirm "Desktop App seems inactive" banner appears
   
4. **Verify the fix:**
   - Restart the desktop app (session restore triggers)
   - Check Supabase `users` table -- `desktop_last_heartbeat` should be updated to now
   - Refresh the Jira Forge UI -- banner should show `status: 'active'` (no inactive banner)

5. **Verify no regression -- fresh OAuth:**
   - Log out, log back in via OAuth
   - Confirm DB is still updated correctly (as before)
   - Confirm banners behave correctly

6. **Verify no regression -- heartbeat:**
   - Let the app run for >4 hours (or temporarily reduce the heartbeat interval)
   - Confirm heartbeat still updates `desktop_app_version` and `desktop_last_heartbeat`

## Minor Caveat

There is a brief timing window: if a user opens the Jira Forge UI before the desktop app finishes session restore (which involves a token refresh + user verification + DB update), they may see the stale banner once. On next page load or tab re-focus, the banner will be correct. This is a transient race condition and does not warrant additional complexity.

## Related Fix

This issue is related to but separate from the TLS CA Bundle Authentication Failure fix (see `plan/fix-tls-ca-bundle-auth-failure.md`). That fix prevents users with PostgreSQL installed from failing to authenticate at all. This fix ensures users who authenticate successfully get their status reflected correctly in the database.

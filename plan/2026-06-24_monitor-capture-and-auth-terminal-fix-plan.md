# Root Cause Analysis and Fix Plan

Date: 2026-06-24
Scope: `monitor_capture.py`, `desktop_app.py`

## 1. Root Cause Identified from Logs
The log file `timetracker_suchith.log.md` reveals two distinct root causes that crash the application and cause tracking to fail:

### Issue 1: GLib Context Threading Corruption (`WinDetect` ALL METHODS FAILED)
- **Log Evidence:** 
  ```
  ERROR - STDERR - /usr/lib/python3/dist-packages/gi/overrides/GLib.py:497: Warning: g_hash_table_lookup: assertion 'hash_table != NULL' failed
  WARNING - __main__ - [TRACKER] [WinDetect] ALL METHODS FAILED - returning ('Unknown', 'Unknown')
  ```
- **Root Cause:** In `monitor_capture.py`, `GLib.MainLoop()` is instantiated directly inside background D-Bus threads (for XDG Portal and ScreenCast features). Calling `GLib.MainLoop()` without a specific context attaches it to the *default global main context*. Because multiple threads (including the background window detection `gnome_introspect` thread) use the default context simultaneously, it leads to race conditions, memory corruption (GLib hash table assertions), and ultimate failure of all GNOME D-Bus integrations.
- **Fix:** Create a thread-local context using `context = GLib.MainContext.new()`, push it as the thread default using `context.push_thread_default()`, and pass it to `GLib.MainLoop(context)`. Pop the context when the loop exits.

### Issue 2: OAuth Refresh Token Terminal Failure Loops
- **Log Evidence:**
  ```
  [WARN] Server confirmed refresh token permanently invalid (OAUTH_REAUTH_REQUIRED) — marking invalid immediately
  [ERROR] Token refresh failed, please re-authenticate
  [ERROR] Could not set Supabase JWT - authentication incomplete
  ```
- **Root Cause:** When the server returns `OAUTH_REAUTH_REQUIRED` (e.g. refresh token expired or revoked), the app marks the token as invalid and blocks refresh. However, it does not purge the stale tokens from secure storage nor strictly transition to a terminal auth state. This causes continuous background loops (heartbeat, offline sync) to repeatedly attempt and fail JWT initialization, keeping the user stuck without pushing pending local SQLite records to the cloud.
- **Fix:** Implement the pending `2026-06-20_python-desktop-app_reauth-recovery-and-stale-token-purge-plan.md` plan:
  1. Transition the app to a strict terminal state.
  2. Purge stale tokens from `secure_storage`.
  3. Ensure background threads (heartbeat, sync, batch upload) respect this state and do not spam refresh errors.
  4. Force the UI to show a reauthentication prompt.

## 2. Implementation Steps
1. **Fix `monitor_capture.py`**: Replace `GLib.MainLoop()` with a thread-default context in `_capture_xdg_portal()`, `_init_screencast_session()`, and `_has_screencast_permission()`.
2. **Fix `desktop_app.py`**: Add strict `AUTH_REAUTH_REQUIRED` handling, including securely purging local stale tokens when this status is reached.
3. **Fix `secure_storage.py` (if needed)**: Add a `purge_tokens` method.

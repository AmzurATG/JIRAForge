# ScreenCast Permission Dialog Root Cause Analysis

## Problem Statement
The screen sharing permission dialog appears **every time** the application captures a screenshot (every 5 minutes by default), instead of remembering the user's permission.

## Root Cause

### 1. **Session Handle Expiration**
The ScreenCast Portal session is not persisting between captures due to several issues:

**Location:** `monitor_capture.py` lines 790-853

```python
# Try to reuse cached session first (avoids repeated consent dialogs)
if (_SCREENCAST_SESSION_CACHE['session_handle'] and 
    _SCREENCAST_SESSION_CACHE['node_id']):
    
    logger.debug("Reusing cached ScreenCast session (no consent needed)")
    
    try:
        # Try to open new PipeWire connection with cached session
        result = proxy.call_with_unix_fd_list_sync(
            'OpenPipeWireRemote',
            GLib.Variant('(oa{sv})', (_SCREENCAST_SESSION_CACHE['session_handle'], {})),
            ...
        )
```

**Problem:** When `OpenPipeWireRemote` fails (session expired/invalid), the code immediately clears the entire cache and creates a **brand new session**, which requires user consent again.

### 2. **Session Not Persisted Across Captures**
The XDG Desktop Portal ScreenCast API has two modes:
- **Transient sessions**: Expire after inactivity (current implementation)
- **Persistent sessions**: Use `persist_mode` and `restore_token` to survive app restarts

**Current code (line 1182-1184):**
```python
# Cache session info for future captures (avoids repeated consent dialogs)
_SCREENCAST_SESSION_CACHE['session_handle'] = session_state['session_handle']
_SCREENCAST_SESSION_CACHE['node_id'] = session_state['node_id']
```

**Missing:** `restore_token` is defined in cache structure but never saved or used.

### 3. **Aggressive Cache Clearing**
**Location:** Lines 847-853

```python
except Exception as e:
    logger.debug(f"Cached session failed: {e}, creating new session...")
    # Clear cache and fall through to create new session
    _SCREENCAST_SESSION_CACHE = {
        'session_handle': None,
        'pipewire_fd': None,
        'node_id': None,
        'restore_token': None
    }
```

**Problem:** On ANY failure (network glitch, temporary D-Bus issue, etc.), the cache is wiped and a new session is created, requiring user consent.

### 4. **No Session Keep-Alive Mechanism**
With 5-minute intervals between captures (`CAPTURE_INTERVAL=300`), the Portal daemon may consider the session abandoned and invalidate it. The code has no mechanism to:
- Keep the session alive between captures
- Detect session expiration before attempting reuse
- Gracefully refresh an expired session

## Timeline of Events

1. **First Capture (T=0):**
   - No cached session exists
   - Creates new ScreenCast session
   - **User sees permission dialog → grants permission**
   - Session cached: `session_handle`, `node_id`

2. **Second Capture (T=5min):**
   - Attempts to reuse cached session
   - Calls `OpenPipeWireRemote` with cached session handle
   - **Session handle is invalid/expired** (Portal closed it after inactivity)
   - `OpenPipeWireRemote` throws exception
   - Cache is cleared completely
   - Creates brand new session
   - **User sees permission dialog AGAIN**

3. **Repeat every 5 minutes...**

## Why Sessions Expire

### GNOME Portal Behavior
The `xdg-desktop-portal-gnome` implementation may close ScreenCast sessions:
- After a period of inactivity (exact timeout varies)
- When no active PipeWire connection exists
- On compositor/shell restarts
- As a security measure for idle sessions

### Current Implementation Gap
The code opens a NEW PipeWire fd for each capture but doesn't keep the session "active" in Portal's perspective.

## Proposed Solutions

### Solution 1: Use Persistent Sessions with Restore Tokens ⭐ **RECOMMENDED**

**Add persist_mode to CreateSession options:**
```python
options = {
    'handle_token': GLib.Variant('s', request_token),
    'session_handle_token': GLib.Variant('s', session_token),
    'persist_mode': GLib.Variant('u', 2)  # 2 = persist until explicitly revoked
}
```

**Save and load restore_token:**
```python
# After Start response (line ~1182):
if 'restore_token' in results:
    _SCREENCAST_SESSION_CACHE['restore_token'] = results['restore_token']
    _save_restore_token_to_disk()  # Persist to file

# On next capture, use restore_token:
options = {
    'handle_token': GLib.Variant('s', request_token),
    'restore_token': GLib.Variant('s', cached_restore_token)
}
```

### Solution 2: Graceful Session Refresh

**Don't immediately clear cache on first failure:**
```python
except Exception as e:
    logger.warning(f"Cached session reuse failed: {e}")
    # Try to query if session is still valid before creating new one
    if _is_session_valid(_SCREENCAST_SESSION_CACHE['session_handle']):
        # Session exists but PipeWire connection failed - try once more
        ...
    else:
        # Session truly invalid - create new (will show consent dialog)
        logger.info("ScreenCast session expired, requesting new user consent")
        _SCREENCAST_SESSION_CACHE = {...}
```

### Solution 3: Keep Session Alive

**Maintain a persistent PipeWire connection:**
```python
# Don't close PipeWire fd after each capture
# Keep it open and reuse for subsequent captures
# Only close on app shutdown or explicit session end
```

### Solution 4: Better Error Logging

**Add detailed logging to understand failures:**
```python
except Exception as e:
    logger.error(
        f"Cached session reuse failed: {e.__class__.__name__}: {e}\n"
        f"Session handle: {_SCREENCAST_SESSION_CACHE['session_handle']}\n"
        f"Node ID: {_SCREENCAST_SESSION_CACHE['node_id']}\n"
        f"Traceback: {traceback.format_exc()}"
    )
```

## Implementation Priority

1. **Immediate (P0):** Add detailed error logging to confirm root cause
2. **High (P1):** Implement persistent sessions with restore tokens
3. **Medium (P2):** Add graceful session refresh logic
4. **Low (P3):** Consider keeping PipeWire connection alive (complex, resource implications)

## Expected Outcome After Fix

- **First run:** User grants permission once
- **Subsequent captures:** No permission dialog
- **After app restart:** Permission remembered via restore token
- **Session expiration:** Gracefully handled with minimal user disruption

## Files to Modify

1. `python-desktop-app/monitor_capture.py`:
   - Lines 700-705: Update cache structure
   - Lines 790-853: Fix session reuse logic
   - Lines 970-1010: Add persist_mode and restore_token handling
   - Lines 1182-1184: Save restore_token to disk
   - Add helper functions: `_save_restore_token()`, `_load_restore_token()`, `_is_session_valid()`

2. New persistent storage for restore token (similar to `time_tracker_consent.json`)

## Testing Plan

1. Run app, grant permission once
2. Wait 5 minutes, verify no new dialog appears
3. Restart app, verify permission remembered
4. Manually invalidate session (restart GNOME Shell), verify graceful handling
5. Check logs for detailed error messages if issues occur

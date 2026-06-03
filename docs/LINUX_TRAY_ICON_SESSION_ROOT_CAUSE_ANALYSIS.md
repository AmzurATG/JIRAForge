# Linux Desktop App - Tray Icon & Session Expiration Root Cause Analysis

**Date:** June 3, 2026  
**Platform:** Linux (Wayland/X11)  
**Component:** Python Desktop App - Time Tracker  
**Status:** ✅ Root Cause Identified

---

## Executive Summary

Two critical issues identified in the Linux version of the desktop time tracker:

1. **Tray Icon Shows Orange During Active Work** - Icon displays orange (idle/offline state) even when user is actively working
2. **Session Expired Notifications** - Users receive "Your session has expired" notifications even when the app appears to be working

**Impact:** User confusion, perceived app malfunction, unnecessary re-authentication requests

**Root Causes Identified:**
- Activity monitoring issues on Linux (pynput compatibility with Wayland)
- Idle state not properly cleared when resuming from system events
- Authentication state check timing issues
- Misleading visual feedback (orange = both idle AND auth failed)

---

## Issue #1: Tray Icon Orange During Active Work

### Current Behavior

The tray icon color logic in `get_tray_icon_state()` (line 12448) shows **orange** in these scenarios:

```python
def get_tray_icon_state(self):
    # ... other conditions ...
    elif self.is_idle:
        return 'orange'  # System idle
    elif self.tracking_active:
        if not self.auth_manager.is_authenticated():
            return 'orange'  # Auth failed but tracking continues
        return 'green'  # Normal tracking
```

**Orange Color Means:**
- System is idle (no keyboard/mouse activity for 5+ minutes)
- Anonymous mode (before login)
- **Authentication failed** (token expired/invalid)

### Root Causes

#### 1. Linux Activity Detection Issues

**File:** `desktop_app.py`, lines 11370-11408  
**Problem:** `pynput` library may not properly detect activity on Linux, especially on Wayland

```python
def monitor_user_activity(self):
    """Monitor mouse and keyboard activity for idle detection"""
    try:
        from pynput import mouse, keyboard
    except ImportError:
        print("[WARN] pynput not installed - idle detection disabled")
        return

    def on_activity(*args, **kwargs):
        self.last_activity_time = time.time()
        if self.is_idle:
            self.needs_idle_resume = True
    
    # Start listeners...
```

**Issues on Linux:**
- **Wayland Security**: Wayland restricts global input monitoring for security
- **X11 Compatibility**: `pynput` works on X11 but may fail silently on Wayland
- **No Fallback**: If `pynput` fails to detect activity, `last_activity_time` doesn't update
- **No Error Logging**: Silent failures in listener initialization

#### 2. Idle State Not Cleared After System Resume

**File:** `desktop_app.py`, lines 11730-11780  
**Problem:** System suspension detection doesn't always properly clear idle state

```python
# Detect system suspension
time_since_last_loop = current_loop_time - last_loop_time
if time_since_last_loop > 30:  # 30s threshold
    print(f"[INFO] Large time gap detected: {int(time_since_last_loop)}s")
    self._finalize_active_session("system suspension detected")
    
    # Check if screen is locked
    if self._is_screen_locked():
        self.enter_idle("screen still locked after suspension")
        # ... continues in idle state
```

**Issue:** When system resumes from suspension, if the screen is locked, the app stays in idle state. However, if the user then unlocks without the pynput listener properly triggering, `is_idle` stays True.

#### 3. Authentication Check Frequency

**File:** `desktop_app.py`, line 12491  
**Problem:** Authentication check happens on every tray icon update

```python
elif self.tracking_active:
    if not self.auth_manager.is_authenticated():  # <-- Called frequently
        return 'orange'
    return 'green'
```

**`is_authenticated()` logic** (line 3060):
```python
def is_authenticated(self):
    # ... checks ...
    # If token expired, tries to refresh (up to 3 attempts with backoff)
    if expires_at and time.time() > expires_at:
        for attempt in range(3):
            if self.refresh_access_token():
                return True
            # ... backoff logic ...
        return False  # <-- Causes orange icon
```

**Issue:** If token refresh fails (network issue, AI server down, rate limit), `is_authenticated()` returns False, causing orange icon even though:
- User is actively working
- Screenshots are still being captured locally
- Data will sync when auth recovers

---

## Issue #2: Screenshots Continue in Orange State

### Current Behavior

Screenshots are captured continuously even when tray icon is orange.

**File:** `desktop_app.py`, lines 12035-12050 (tracking_loop)

```python
if should_capture and not self.is_idle:
    if not should_skip:
        screenshot = self.capture_screenshot()
        if screenshot:
            self.upload_screenshot(screenshot, window_info)
```

**No authentication check before screenshot capture!**

### Root Cause Analysis

This is **INTENTIONAL BY DESIGN**, not a bug:

1. **Offline Queue Architecture**: Screenshots are saved to local SQLite when upload fails
2. **Resilience**: App continues tracking even when authentication/network fails
3. **Eventual Consistency**: Queued screenshots upload when authentication recovers

**Evidence:** In `upload_screenshot()` (line 10970):

```python
except Exception as e:
    print(f"[ERROR] Screenshot upload failed: {e}")
    # Try to save offline as fallback
    local_id = self.offline_manager.save_screenshot_offline(...)
    if local_id:
        return f"offline_{local_id}"
```

### Why This Confuses Users

**The Problem:** Orange icon suggests "not working", but app IS working (capturing screenshots).

**User Expectation:**
- Orange = broken, not tracking
- Green = working, syncing

**Reality:**
- Orange = tracking locally, not syncing
- Green = tracking AND syncing

**Gap:** The visual feedback doesn't match the actual behavior.

---

## Issue #3: Session Expired Notification

### Current Behavior

User sees notification: **"Your session has expired. Please open Time Tracker and log in again."**

**File:** `desktop_app.py`, lines 9364-9400

```python
def _show_reauth_notification(self, reason_code=None):
    """Show auth notification with reason-specific messaging"""
    # Throttled every 15 minutes
    if now - last_shown < 900:
        return
    
    # Show notification
    _linux_notify("Time Tracker", 
                  "Your session has expired. Please open Time Tracker and log in again.", 
                  urgency="critical")
```

### Root Causes

#### 1. JWT Refresh Failure

**File:** `desktop_app.py`, lines 9592-9700 (`upload_activity_batch`)

```python
# Check if JWT is expired before upload
sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
if sb_expires_at and time.time() > (sb_expires_at - 300):  # 5min buffer
    if not self._set_supabase_jwt():  # <-- Fails here
        # Triggers reauth notification
        self.add_admin_log('ERROR', 'JWT refresh failed. Re-login may be required.')
        return
```

**When `_set_supabase_jwt()` fails** (line 6323):

```python
def _set_supabase_jwt(self):
    try:
        supabase_token = self.auth_manager.get_valid_supabase_token()
        if not supabase_token:  # <-- Fails after 3 retry attempts
            print("[WARN] Could not get valid Supabase token")
            return False
```

**And `get_valid_supabase_token()` fails** (line 3251):

```python
def get_valid_supabase_token(self):
    # Tries 3 times to get token
    for attempt in range(3):
        try:
            return self.get_supabase_token()  # <-- Calls AI server
        except Exception as e:
            if attempt < 2:
                time.sleep((attempt + 1) * 3)  # Backoff: 3s, 6s
    
    print("[ERROR] Could not get Supabase token after 3 attempts")
    return None  # <-- Triggers session expired
```

#### 2. Refresh Token Invalidity

**File:** `desktop_app.py`, lines 3060-3100 (`is_authenticated`)

```python
def is_authenticated(self):
    # Check if refresh token is marked invalid
    if getattr(self, '_refresh_token_invalid', False):
        grace_period = 1800  # 30 minutes
        invalid_since = getattr(self, '_refresh_invalid_set_at', 0)
        if invalid_since and (time.time() - invalid_since) >= grace_period:
            # Grace period expired - clear flag and retry
            self._refresh_token_invalid = False
        else:
            return False  # <-- Still invalid, session expired
```

**When refresh token becomes invalid:**
1. User logs in with Atlassian OAuth
2. Receives access_token (expires in 1 hour) + refresh_token (expires in days/weeks)
3. App uses access_token for API calls
4. When access_token expires, app calls `refresh_access_token()` using refresh_token
5. **If refresh fails** (network, AI server down, token rotation issue):
   - `_refresh_token_invalid = True`
   - `_refresh_invalid_set_at = current_time`
   - 30-minute grace period starts
6. **If still invalid after 30 minutes:**
   - Session expired notification shown
   - User must re-authenticate

#### 3. Network Connectivity Issues

**File:** `desktop_app.py`, lines 3260-3290

```python
for attempt in range(3):
    try:
        return self.get_supabase_token()
    except (requests.exceptions.ConnectionError, 
            requests.exceptions.Timeout) as e:
        network_status = "unknown"
        try:
            socket.create_connection(("8.8.8.8", 53), timeout=2).close()
            network_status = "online"
        except Exception:
            network_status = "offline"
        
        if attempt < 2:
            time.sleep((attempt + 1) * 3)
```

**Issue:** If network is down or AI server unreachable, all 3 retry attempts fail → session expired notification.

---

## Linux-Specific Complications

### 1. Wayland vs X11 Input Monitoring

**Problem:** `pynput` requires X11 protocol access for global input monitoring.

**On Wayland:**
- Security model prevents applications from monitoring global input
- `pynput` may fail silently or require X11 compatibility layer (XWayland)
- No clear error indication to user

**Current Code:** No detection of Wayland vs X11, no alternate monitoring strategy

### 2. Screen Lock Detection

**File:** `desktop_app.py`, lines 10429-10470

```python
def _is_screen_locked(self):
    """Check if screen is locked"""
    # Linux: ask GNOME ScreenSaver via D-Bus
    try:
        result = subprocess.run([
            'gdbus', 'call', '--session',
            '--dest', 'org.gnome.ScreenSaver',
            '--object-path', '/org/gnome/ScreenSaver',
            '--method', 'org.gnome.ScreenSaver.GetActive',
        ], capture_output=True, text=True, timeout=1)
        
        if result.returncode == 0:
            return 'true' in result.stdout.lower()
    except Exception:
        pass
    return False  # Assume not locked if detection fails
```

**Issues:**
- **GNOME-specific**: Only works on GNOME desktop environment
- **No KDE/XFCE support**: Other DEs have different D-Bus interfaces
- **Silent failure**: Returns False if detection fails, may cause incorrect state

### 3. Window Focus Detection

**File:** `desktop_app.py`, lines 10472-10530

```python
def _get_active_window_linux(self):
    """Get active window on Linux"""
    # Tries gdbus (Wayland) first, then xdotool (X11) fallback
    # ...on Wayland, xdotool returns stale XWayland focus
```

**Issue:** On Wayland, focus detection may be delayed or inaccurate, causing:
- Incorrect idle detection
- Wrong window being tracked
- Activity not detected when switching windows

---

## Proposed Fixes

### Fix #1: Improve Linux Activity Detection

**Goal:** Ensure `pynput` works properly on both X11 and Wayland

**Changes to:** `desktop_app.py`, lines 11370-11450

```python
def monitor_user_activity(self):
    """Monitor mouse and keyboard activity for idle detection (Linux-compatible)"""
    
    # Detect display server
    session_type = os.environ.get('XDG_SESSION_TYPE', 'unknown')
    wayland_display = os.environ.get('WAYLAND_DISPLAY')
    is_wayland = session_type == 'wayland' or wayland_display
    
    print(f"[INFO] Display server detected: {session_type} (Wayland={is_wayland})")
    
    try:
        from pynput import mouse, keyboard
    except ImportError:
        print("[ERROR] pynput not installed - idle detection DISABLED")
        print("[INFO] Install with: pip3 install pynput")
        return
    
    # Track listener health
    self._activity_listener_started = False
    self._activity_listener_error = None
    
    def on_activity(*args, **kwargs):
        """Called on any mouse or keyboard activity"""
        if not self._activity_listener_started:
            self._activity_listener_started = True
            print("[OK] Activity listener confirmed working")
        
        self.last_activity_time = time.time()
        
        # Signal idle resume
        if self.is_idle:
            self.needs_idle_resume = True
    
    def on_error(error):
        """Handle listener errors"""
        self._activity_listener_error = str(error)
        print(f"[ERROR] Activity listener error: {error}")
    
    try:
        # Start mouse listener
        mouse_listener = mouse.Listener(
            on_move=on_activity,
            on_click=on_activity,
            on_scroll=on_activity
        )
        mouse_listener.start()
        
        # Start keyboard listener
        keyboard_listener = keyboard.Listener(
            on_press=on_activity
        )
        keyboard_listener.start()
        
        print("[OK] Activity monitoring started (pynput)")
        
        if is_wayland:
            print("[WARN] Running on Wayland - pynput may require XWayland for input monitoring")
            print("[INFO] If idle detection fails, check XWayland is running: ps aux | grep XWayland")
        
        # Verify listeners started (check after 5 seconds)
        def verify_listener():
            time.sleep(5)
            if not self._activity_listener_started:
                print("[ERROR] Activity listener NOT receiving events after 5s")
                print("[ERROR] This means idle detection is BROKEN")
                if is_wayland:
                    print("[HELP] Wayland detected - try these fixes:")
                    print("[HELP] 1. Ensure XWayland is installed and running")
                    print("[HELP] 2. Or run app with: QT_QPA_PLATFORM=xcb ./TimeTracker")
                    print("[HELP] 3. Or use X11 session instead of Wayland")
                # Add admin log for visibility
                self.add_admin_log('ERROR', 'Activity monitoring not working - idle detection broken')
        
        threading.Thread(target=verify_listener, daemon=True).start()
        
    except Exception as e:
        print(f"[ERROR] Failed to start activity listeners: {e}")
        traceback.print_exc()
        self._activity_listener_error = str(e)
        # Continue without idle detection rather than crashing
```

### Fix #2: Add Window Switch Fallback for Activity Detection

**Goal:** Use window switches as proof of activity when pynput fails

**Changes to:** `desktop_app.py`, lines 11950-11960 (in tracking_loop)

```python
# Check for window switches
window_info = self.get_active_window()
window_switched = window_info.get('is_new_window', False)

if window_switched:
    # Window switch = user is DEFINITELY active
    # Update activity time as fallback when pynput fails
    self.last_activity_time = time.time()
    
    # If we were idle, trigger resume
    if self.is_idle:
        print("[INFO] Window switch detected while idle - user is active")
        self.needs_idle_resume = True
    
    # Process window event
    self.process_window_event(window_info)
```

### Fix #3: Add Idle State Verification

**Goal:** Prevent false idle state when user is actually active

**Changes to:** `desktop_app.py`, after line 11880

```python
# Check for idle timeout
idle_duration = time.time() - self.last_activity_time
current_idle_timeout = self.tracking_settings.get('idle_threshold_seconds', self.idle_timeout)

if idle_duration > current_idle_timeout:
    if self.state == TrackingState.ACTIVE:
        # VERIFY idle state before entering
        # Check if we've captured any screenshots in the last idle_timeout period
        # If yes, user was likely active but pynput failed to detect it
        
        recent_activity = False
        if window_switched or (time.time() - last_screenshot_time) < current_idle_timeout:
            recent_activity = True
            print(f"[INFO] Idle timeout but recent window activity detected - NOT entering idle")
            print(f"[INFO] This suggests pynput activity monitoring may not be working")
            # Reset activity time to prevent immediate re-check
            self.last_activity_time = time.time()
            continue
        
        if not recent_activity:
            print(f"[INFO] Idle timeout ({int(idle_duration)}s) — entering idle state")
            self.enter_idle("idle timeout")
            
            # Upload accumulated data before entering idle
            try:
                self.upload_activity_batch()
            except Exception as e:
                print(f"[WARN] Pre-idle batch upload failed: {e}")
```

### Fix #4: Improve Tray Icon State Communication

**Goal:** Add visual distinction between "idle" and "auth failed"

**Changes to:** `desktop_app.py`, lines 12448-12500

**Option A: Use Different Icon States**

```python
def get_tray_icon_state(self):
    """Determine tray icon color with improved state distinction"""
    
    # Not logged in
    if not self.current_user and not (self.current_user_id and self.current_user_id.startswith('anonymous_')):
        return 'red'
    
    # Anonymous mode
    elif self.current_user_id and self.current_user_id.startswith('anonymous_'):
        if self.tracking_active:
            return 'orange'  # Tracking locally before login
        else:
            return 'red'
    
    # Manually paused
    elif self.pause_start_time is not None:
        return 'yellow'
    
    # System idle (no activity detected)
    elif self.is_idle:
        return 'orange'
    
    # Tracking active - check authentication
    elif self.tracking_active:
        # Check auth with caching to avoid repeated API calls
        auth_valid = self._check_auth_with_cache()
        
        if not auth_valid:
            # Distinguish between "temporarily offline" and "session expired"
            if self._is_auth_temporary_failure():
                # Use orange with different tooltip
                return 'orange'  # "Queuing locally (temporary issue)"
            else:
                # Use a new color (magenta/purple) for "session expired"
                return 'magenta'  # "Session expired - please re-login"
        
        return 'green'  # Normal tracking + syncing
    
    # Logged in but not tracking
    else:
        return 'blue'

def _check_auth_with_cache(self, cache_ttl=30):
    """Check authentication with 30-second cache to avoid repeated calls"""
    now = time.time()
    if hasattr(self, '_auth_check_cache_time') and (now - self._auth_check_cache_time) < cache_ttl:
        return getattr(self, '_auth_check_cache_result', True)
    
    # Perform actual check
    auth_valid = self.auth_manager.is_authenticated()
    self._auth_check_cache_time = now
    self._auth_check_cache_result = auth_valid
    return auth_valid

def _is_auth_temporary_failure(self):
    """Check if auth failure is temporary (vs expired session)"""
    # If refresh token is marked invalid for >30 min, it's not temporary
    if getattr(self.auth_manager, '_refresh_token_invalid', False):
        invalid_since = getattr(self.auth_manager, '_refresh_invalid_set_at', 0)
        if invalid_since and (time.time() - invalid_since) >= 1800:  # 30 min
            return False  # Session expired
    
    # Check if we're just offline
    if not self.offline_manager.check_connectivity():
        return True  # Temporary (offline)
    
    # Check if AI server is reachable
    try:
        import socket
        ai_server_host = urllib.parse.urlparse(self.auth_manager.ai_server_url).hostname
        socket.create_connection((ai_server_host, 443), timeout=2).close()
        return True  # Server reachable, likely temporary auth issue
    except:
        return True  # Server unreachable, temporary
```

**Option B: Simpler - Improve Tooltip Only** (Less invasive)

```python
def update_tray_icon(self):
    """Update tray icon with improved status tooltip"""
    if self.tray:
        try:
            state = self.get_tray_icon_state()
            show_badge = getattr(self, 'update_available', False)
            new_icon = self.create_tray_icon(state, show_update_badge=show_badge)
            self.tray.icon = new_icon
            
            # Set informative tooltip based on state
            if state == 'green':
                self.tray.title = "TimeTracker - Tracking & Syncing"
            elif state == 'orange':
                if self.is_idle:
                    self.tray.title = "TimeTracker - Idle (No Activity)"
                elif not self.auth_manager.is_authenticated():
                    if self.offline_manager.check_connectivity():
                        self.tray.title = "TimeTracker - Auth Issue (Queuing Locally)"
                    else:
                        self.tray.title = "TimeTracker - Offline (Queuing Locally)"
                else:
                    self.tray.title = "TimeTracker - Tracking Locally"
            elif state == 'yellow':
                self.tray.title = "TimeTracker - Paused"
            elif state == 'blue':
                self.tray.title = "TimeTracker - Ready (Click to Start)"
            elif state == 'red':
                self.tray.title = "TimeTracker - Not Logged In"
            else:
                self.tray.title = "TimeTracker"
                
        except Exception as e:
            print(f"[WARN] Failed to update tray icon: {e}")
```

### Fix #5: Reduce Session Expired Notification Frequency

**Goal:** Only notify when genuinely expired, not on temporary failures

**Changes to:** `desktop_app.py`, lines 9340-9410

```python
def _show_reauth_notification(self, reason_code=None):
    """Show auth notification ONLY when session is genuinely expired (not temporary failures)"""
    
    reason = str(reason_code or '').upper()
    is_temporary = reason == 'OAUTH_TEMPORARY_FAILURE'
    
    # Check if this is actually a temporary failure vs genuine expiration
    if not is_temporary:
        # Don't notify if we're just offline
        if not self.offline_manager.check_connectivity():
            print("[INFO] Auth notification suppressed - offline (data queuing locally)")
            return
        
        # Don't notify if refresh token grace period hasn't elapsed yet
        if hasattr(self.auth_manager, '_refresh_invalid_set_at'):
            invalid_since = self.auth_manager._refresh_invalid_set_at
            if invalid_since and (time.time() - invalid_since) < 1800:  # 30 min grace
                print("[INFO] Auth notification suppressed - still in 30min grace period")
                return
    
    # Throttle to once every 15 minutes per notification type
    now = time.time()
    throttle_attr = '_auth_temp_notification_last_shown' if is_temporary else '_reauth_notification_last_shown'
    last_shown = getattr(self, throttle_attr, 0)
    if now - last_shown < 900:  # 15 minutes
        return
    setattr(self, throttle_attr, now)
    
    # Show notification
    if not WINOTIFY_AVAILABLE:
        if is_temporary:
            _linux_notify("Time Tracker", 
                         "Temporary sync issue. Data is queuing locally and will sync automatically.", 
                         urgency="normal")
        else:
            _linux_notify("Time Tracker", 
                         "Your session has expired. Please open Time Tracker and log in again.", 
                         urgency="critical")
    else:
        if is_temporary:
            title = "Sync Issue"
            msg = "Temporary issue syncing data. Your work is being tracked locally and will sync when connection recovers."
        else:
            title = "Session Expired"
            msg = "Your session has expired. Please open Time Tracker and log in again to continue syncing with Jira."
        
        notification = Notification(
            app_id="Time Tracker",
            title=title,
            msg=msg,
            duration="long"
        )
        notification.set_audio(audio.Default, loop=False)
        notification.show()
    
    print(f"[INFO] Auth notification shown: type={reason}, temporary={is_temporary}")
```

### Fix #6: Add Diagnostic Logging for Activity Monitoring

**Goal:** Help diagnose why idle detection fails on specific systems

**Changes to:** Add new method after `monitor_user_activity()`

```python
def get_activity_monitoring_status(self):
    """Get diagnostic info about activity monitoring health"""
    status = {
        'pynput_available': False,
        'listener_started': getattr(self, '_activity_listener_started', False),
        'listener_error': getattr(self, '_activity_listener_error', None),
        'last_activity_time': self.last_activity_time,
        'idle_duration': time.time() - self.last_activity_time,
        'is_idle': self.is_idle,
        'display_server': os.environ.get('XDG_SESSION_TYPE', 'unknown'),
        'wayland_display': os.environ.get('WAYLAND_DISPLAY'),
        'xwayland_running': False
    }
    
    # Check if pynput is available
    try:
        import pynput
        status['pynput_available'] = True
        status['pynput_version'] = getattr(pynput, '__version__', 'unknown')
    except ImportError:
        pass
    
    # Check if XWayland is running (for Wayland systems)
    try:
        result = subprocess.run(['pgrep', '-x', 'Xwayland'], 
                               capture_output=True, timeout=1)
        status['xwayland_running'] = (result.returncode == 0)
    except:
        pass
    
    return status

# Add to tray menu for easy access
def show_diagnostic_info(self):
    """Show diagnostic information popup"""
    status = self.get_activity_monitoring_status()
    
    info_lines = [
        "=== Activity Monitoring Status ===",
        f"pynput installed: {status['pynput_available']}",
        f"Listener started: {status['listener_started']}",
        f"Listener error: {status['listener_error'] or 'None'}",
        f"Display server: {status['display_server']}",
        f"Wayland: {status['wayland_display'] or 'No'}",
        f"XWayland running: {status['xwayland_running']}",
        "",
        f"Last activity: {int(status['idle_duration'])}s ago",
        f"Currently idle: {status['is_idle']}",
        "",
        "=== Authentication Status ===",
        f"Authenticated: {self.auth_manager.is_authenticated()}",
        f"User: {self.current_user.get('email') if self.current_user else 'Not logged in'}",
    ]
    
    print("\n".join(info_lines))
    
    # Show in GUI notification
    _linux_notify("TimeTracker Diagnostics", "\n".join(info_lines[:10]))
```

---

## Testing Checklist

### Test on X11

- [ ] Install app on Ubuntu 22.04 with X11 session
- [ ] Verify `pynput` detects mouse/keyboard activity
- [ ] Verify tray icon turns orange after 5 min idle
- [ ] Verify tray icon turns green when activity resumes
- [ ] Verify session expiration notification only shows when truly expired

### Test on Wayland

- [ ] Install app on Ubuntu 22.04 with Wayland session
- [ ] Check if `pynput` works (may require XWayland)
- [ ] Verify window switch detection works as fallback
- [ ] Test with XWayland running
- [ ] Test without XWayland (if detection fails, show helpful error)

### Test on KDE Plasma

- [ ] Verify screen lock detection (may need KDE-specific D-Bus fix)
- [ ] Verify window focus detection
- [ ] Test system suspension/resume

### Test Authentication Scenarios

- [ ] Disconnect network → verify orange icon with "Offline" tooltip
- [ ] Reconnect → verify icon turns green when sync resumes
- [ ] Force token expiration → verify orange icon first, then notification after grace period
- [ ] Re-login → verify queued data uploads successfully

---

## Implementation Priority

### P0 - Critical (Implement First)

1. **Fix #2: Window Switch Activity Fallback** - Quick win, improves reliability immediately
2. **Fix #4 Option B: Improved Tooltips** - Low risk, high user value
3. **Fix #5: Reduce False Session Expired Notifications** - Reduces user annoyance

### P1 - Important (Implement Next)

4. **Fix #1: Improved Activity Monitoring** - Fixes root cause on Wayland
5. **Fix #3: Idle State Verification** - Prevents false idle states

### P2 - Nice to Have

6. **Fix #6: Diagnostic Logging** - Helps debug user-specific issues
7. **Fix #4 Option A: New Icon States** - Better UX but requires new icon assets

---

## Deployment Plan

### Phase 1: Low-Risk Fixes (Week 1)
- Implement Fix #2 (window switch fallback)
- Implement Fix #4 Option B (improved tooltips)
- Implement Fix #5 (notification throttling)
- **Deploy to beta testers on Linux**

### Phase 2: Core Fixes (Week 2)
- Implement Fix #1 (activity monitoring improvements)
- Implement Fix #3 (idle verification)
- **Deploy to wider Linux user base**

### Phase 3: Enhanced Diagnostics (Week 3)
- Implement Fix #6 (diagnostic logging)
- Collect telemetry on activity monitoring health
- **Full production rollout**

---

## Expected Outcomes

After implementing all fixes:

✅ **Tray icon accurately reflects app state**
- Green = actively tracking + syncing
- Orange = idle OR offline (clear tooltip explains which)
- Magenta = session genuinely expired

✅ **Activity detection works reliably**
- `pynput` works on X11
- Window switches provide fallback on Wayland
- False idle states eliminated

✅ **Session expiration notifications are accurate**
- Only shown when session truly expired (not temporary failures)
- Grace period and offline detection prevent false alarms
- Users understand they can continue working (data queues locally)

✅ **Better Linux compatibility**
- Works on both X11 and Wayland
- Provides helpful guidance when detection fails
- Diagnostic tools help troubleshoot user-specific issues

---

## References

- Main app file: `python-desktop-app/desktop_app.py`
- Icon state logic: Lines 12448-12498
- Activity monitoring: Lines 11370-11408
- Tracking loop: Lines 11700-12150
- Authentication flow: Lines 2427-3460
- Session expiration notification: Lines 9340-9410

---

**Document Version:** 1.0  
**Author:** Root Cause Analysis  
**Status:** Ready for Implementation Review  
**Next Steps:** Review with team → Implement P0 fixes → Deploy to beta → Monitor metrics

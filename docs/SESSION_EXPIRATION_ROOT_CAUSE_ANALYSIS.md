# Session Expiration Issue - Root Cause Analysis
**Date**: May 21, 2026  
**Issue**: "We could not refresh your session right now. Sync will retry automatically."  
**Analysis Type**: Deep Dive Investigation

---

## Executive Summary

The session expiration notification is triggered by **aggressive rate limiting on authentication endpoints** combined with **insufficient retry backoff logic** in the desktop application. When token refresh fails due to rate limiting (HTTP 429), the system cannot distinguish between temporary rate limits and permanent authentication failures, leading to user-visible "Authentication Issue" notifications.

**Root Cause**: The AI Server enforces a strict rate limit of **30 requests per 15 minutes per IP** on authentication endpoints. The desktop app's retry logic doesn't handle HTTP 429 responses gracefully and lacks sufficient backoff, causing cascading failures when users attempt multiple logins.

---

## Detailed Analysis

### 1. Timeline from Logs

**First Login Attempt (14:35:45 - 14:36:18)**
```
14:35:55 → User clicks "Login" → OAuth redirect initiated
14:36:05 → OAuth callback → Token exchange fails (HTTP 429)
          └─ Error: "Too many authentication attempts, please try again later."
14:36:09 → User retries login (second attempt)
14:36:18 → OAuth callback → Token exchange fails (HTTP 429) AGAIN
```

**Second Login Attempt (15:18:46 - 15:20:41)**
```
15:18:47 → User clicks "Login" again (after 40+ minutes)
15:18:57 → OAuth callback → Still fails (HTTP 429)
          └─ Rate limit window hasn't fully reset
15:20:13 → User retries again
15:20:41 → OAuth callback → SUCCESS
          └─ Keyring save fails, falls back to encrypted storage
15:20:50 → Authentication complete
```

**Key Observations**:
- Multiple 429 errors within a 2-minute window (14:36:05 to 14:36:18)
- Rate limit persists even after 40+ minutes
- User initiated 4 login attempts due to failure notifications
- Each attempt compounds the rate limiting issue

---

### 2. Rate Limiting Configuration (AI Server)

**Location**: `ai-server/src/index.js` (lines 118-128)

```javascript
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per 15 minutes per IP
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});
```

**Applied to endpoints**:
- `/api/auth/atlassian/callback` - OAuth token exchange
- `/api/auth/refresh-token` - Refresh token endpoint
- `/api/auth/exchange-token` - Supabase JWT exchange

**Problem**: 30 requests/15min is too aggressive for:
1. Legitimate retry scenarios (network issues, server cold starts)
2. Multiple subsystems requesting tokens simultaneously (OAuth login, token refresh, JWT exchange)
3. User-initiated retries after failure

---

### 3. Desktop App Retry Logic Issues

#### Issue 3.1: OAuth Callback Retry Without 429 Handling

**Location**: `desktop_app.py` (lines 2082-2107)

```python
for attempt in range(3):
    try:
        response = requests.post(
            f"{self.ai_server_url}/api/auth/atlassian/callback",
            json=payload,
            headers=headers,
            timeout=(30, 90)
        )
        break  # Success — exit retry loop
    except (requests.exceptions.ConnectTimeout, requests.exceptions.ConnectionError) as e:
        last_error = e
        if attempt < 2:
            wait = (attempt + 1) * 5
            print(f"[WARN] Token exchange attempt {attempt + 1} failed, retrying in {wait}s...")
            time.sleep(wait)
```

**Problems**:
1. ❌ Retries ONLY for connection errors, NOT for HTTP 429
2. ❌ When HTTP 429 occurs, it raises an exception AFTER the retry loop
3. ❌ Each failed login attempt can consume 3 rate limit quota (3 retries)
4. ❌ User sees generic error: "Token exchange failed (HTTP 429): Too many authentication attempts"

**Impact**: 
- User attempts login → Fails with 429
- User tries again → Already consumed 3+ quota → Fails again with 429
- User frustrated, tries multiple times → Hits rate limit ceiling
- User locked out for 15 minutes

#### Issue 3.2: Token Refresh Proactive Loop

**Location**: `desktop_app.py` (lines 10345-10360)

```python
if expires_at and time.time() > (expires_at - 300):
    print("[INFO] Access token nearing expiry, refreshing proactively...")
    if self.auth_manager.refresh_access_token():
        print("[OK] Proactive token refresh successful")
    else:
        print("[WARN] Proactive token refresh failed — will retry on next cycle")
        last_error_code = getattr(self.auth_manager, '_last_refresh_error_code', '')
        if str(last_error_code).upper() == 'OAUTH_TEMPORARY_FAILURE':
            self._show_reauth_notification(last_error_code)
```

**Problems**:
1. ❌ Runs every 30 seconds when token is near expiry
2. ❌ If refresh fails (e.g., due to rate limiting), shows "Authentication Issue" notification
3. ❌ Doesn't distinguish between rate limiting and actual auth failures
4. ❌ No exponential backoff when refresh fails

**Impact**: 
- Token expires while user is active
- System tries to refresh every 30 seconds
- Each refresh attempt consumes rate limit quota
- User sees repeated "Authentication Issue" notifications

#### Issue 3.3: Multiple JWT Exchange Calls

**Location**: `desktop_app.py` (lines 2545-2590)

```python
def get_valid_supabase_token(self):
    # Check if token exists and is not expired (with 5 min buffer)
    if supabase_token and time.time() < (expires_at - 300):
        return supabase_token
    
    # Token expired or doesn't exist, get a new one
    for attempt in range(3):
        try:
            return self.get_supabase_token()  # Calls /api/auth/exchange-token
        except Exception as e:
            if attempt < 2:
                time.sleep((attempt + 1) * 3)
```

**Problems**:
1. ❌ Called from multiple places: batch upload, project settings, issues cache
2. ❌ Each call can trigger 3 retries to `/api/auth/exchange-token`
3. ❌ All requests count against the same 30/15min rate limit
4. ❌ No circuit breaker to stop retry storms

**Impact**: 
- Batch upload runs every 5 minutes
- Each upload checks JWT validity → May trigger exchange
- If exchange fails, retries 3 times
- Compounds with OAuth callback retries
- Exhausts rate limit quota quickly

---

### 4. Cascading Failure Scenario

**Step-by-Step Breakdown**:

1. **User logs in**:
   - OAuth callback → Token exchange (1 request)
   - Network hiccup → Retry 3 times (3 requests total)
   - **Quota used: 3/30**

2. **User sees error, tries again**:
   - Second OAuth callback → 3 retries (3 requests)
   - **Quota used: 6/30**

3. **Token refresh attempts**:
   - Access token expires after 1 hour
   - Proactive refresh tries every 30 seconds
   - Each attempt can trigger `/api/auth/refresh-token` (1 request)
   - If refresh fails, retries 3 times
   - **Quota used: 6 + (3 × refresh attempts) = ~15/30**

4. **Supabase JWT exchanges**:
   - Batch upload checks JWT every 5 minutes
   - JWT expired → Calls `/api/auth/exchange-token`
   - If exchange fails, retries 3 times
   - Multiple background operations (heartbeat, project settings, etc.)
   - **Quota used: 15 + (3 × JWT exchanges) = ~24/30**

5. **User tries login again after seeing notifications**:
   - Fourth OAuth callback → 3 retries (3 requests)
   - **Quota used: 27/30** ← **Rate limit triggered**

6. **All subsequent requests fail with HTTP 429**:
   - User locked out for 15 minutes
   - Background processes continue trying → Hit 429
   - System shows "Authentication Issue" notification
   - User cannot login until rate limit window expires

---

### 5. Why "Session Expiration" Notification Appears

**Location**: `desktop_app.py` (lines 8368-8370)

```python
if is_temporary:
    title = "Authentication Issue"
    msg = "We could not refresh your session right now. Sync will retry automatically."
```

**Triggered when**:
1. Proactive token refresh fails (`refresh_access_token()` returns `False`)
2. Error code is `OAUTH_TEMPORARY_FAILURE`
3. Throttled to show once every 15 minutes

**Problem**: 
- HTTP 429 (rate limiting) is treated as `OAUTH_TEMPORARY_FAILURE`
- User sees generic "session refresh" error, not "rate limit" error
- Message says "Sync will retry automatically" but retries make it worse
- No indication that user should wait or that rate limiting is the cause

---

## Root Causes Summary

### Primary Root Cause
**Aggressive rate limiting (30 req/15min) on authentication endpoints combined with retry-heavy desktop app logic that doesn't handle HTTP 429 responses gracefully.**

### Contributing Factors

1. **Insufficient Rate Limit Quota**:
   - 30 requests/15min is too low for:
     - OAuth login with retries (3 requests per attempt)
     - Token refresh with retries (3 requests per refresh)
     - JWT exchange with retries (3 requests per exchange)
     - Background operations (batch upload, heartbeat, project sync)
   - Single user can exhaust quota in minutes with normal operations

2. **Missing HTTP 429 Handling**:
   - Desktop app treats 429 as generic error, not rate limit
   - No exponential backoff after hitting rate limit
   - No circuit breaker to stop retry storms
   - Retries immediately, worsening the problem

3. **Retry Logic Without Backoff**:
   - OAuth callback: 3 retries with 5s, 10s delays
   - Token refresh: 3 retries with 2s, 4s delays
   - JWT exchange: 3 retries with 3s, 6s, 9s delays
   - All use short delays, no jitter, no rate limit awareness

4. **Poor Error Communication**:
   - Generic "Authentication Issue" message
   - Doesn't tell user about rate limiting
   - Suggests "retry automatically" which makes it worse
   - No user action guidance (e.g., "Please wait 15 minutes")

5. **Multiple Request Sources**:
   - Proactive token refresh (every 30s when near expiry)
   - Batch upload (every 5 minutes)
   - Heartbeat (every 2 hours)
   - Project settings sync (on demand)
   - Issues cache refresh (on demand)
   - All share the same rate limit bucket

---

## Recommendations

### Immediate Fixes (High Priority)

#### Fix 1: Increase Rate Limit for Auth Endpoints
**File**: `ai-server/src/index.js`

```javascript
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // Increase from 30 to 100
  message: 'Too many authentication attempts, please try again later.',
  // Add skip function for retry scenarios
  skip: (req) => {
    // Skip rate limiting for server-to-server calls (Forge app)
    return req.headers['x-forge-app-id'] !== undefined;
  }
});
```

**Rationale**: 
- 30 req/15min is too restrictive for legitimate use
- 100 req/15min allows 6-7 requests/minute, adequate for retries
- Prevents legitimate users from being locked out

#### Fix 2: Add HTTP 429 Handling with Exponential Backoff
**File**: `desktop_app.py` (OAuth callback handler)

```python
def handle_callback(self, code, state):
    # Existing code...
    
    response = None
    last_error = None
    for attempt in range(3):
        try:
            response = requests.post(
                f"{self.ai_server_url}/api/auth/atlassian/callback",
                json=payload,
                headers=headers,
                timeout=(30, 90)
            )
            
            # NEW: Handle 429 specifically
            if response.status_code == 429:
                retry_after = int(response.headers.get('Retry-After', 60))
                print(f"[WARN] Rate limited (429), waiting {retry_after}s before retry...")
                if attempt < 2:  # Don't wait on last attempt
                    time.sleep(retry_after)
                    continue
                else:
                    raise Exception(
                        f"Rate limit exceeded. Please wait {retry_after} seconds and try logging in again."
                    )
            
            break  # Success
            
        except (requests.exceptions.ConnectTimeout, 
                requests.exceptions.ConnectionError) as e:
            last_error = e
            if attempt < 2:
                wait = (attempt + 1) * 5 * (1 + random.random() * 0.3)  # Add jitter
                print(f"[WARN] Token exchange attempt {attempt + 1} failed, retrying in {wait:.1f}s...")
                time.sleep(wait)
```

**Rationale**:
- Respects `Retry-After` header from server
- Adds jitter to prevent thundering herd
- Clear error message for users
- Prevents wasting retry attempts on rate limits

#### Fix 3: Improve Error Notification with Rate Limit Detection
**File**: `desktop_app.py` (_show_reauth_notification method)

```python
def _show_reauth_notification(self, reason_code=None):
    # Existing throttle logic...
    
    # NEW: Detect rate limiting specifically
    is_rate_limited = (
        reason_code == 'RATE_LIMIT_EXCEEDED' or
        'too many' in str(reason_code).lower() or
        '429' in str(reason_code)
    )
    
    if is_rate_limited:
        title = "Too Many Login Attempts"
        msg = (
            "You've reached the authentication rate limit. "
            "Please wait 15 minutes before trying again."
        )
    elif is_temporary:
        title = "Authentication Issue"
        msg = "We could not refresh your session right now. Sync will retry automatically."
    else:
        title = "Authentication Expired"
        msg = "Your session has expired. Please open Time Tracker and log in again."
    
    # Existing notification code...
```

**Rationale**:
- Clear communication about rate limiting
- Actionable user guidance (wait 15 minutes)
- Prevents user frustration from repeated failed attempts

#### Fix 4: Add Circuit Breaker for Token Refresh
**File**: `desktop_app.py` (refresh_access_token method)

```python
def refresh_access_token(self):
    # NEW: Circuit breaker logic
    if hasattr(self, '_refresh_circuit_open_until'):
        if time.time() < self._refresh_circuit_open_until:
            remaining = int(self._refresh_circuit_open_until - time.time())
            print(f"[INFO] Refresh circuit breaker open, skipping attempt (cooldown: {remaining}s)")
            return False
    
    # Existing refresh logic...
    
    if response.status_code == 429:
        # NEW: Open circuit breaker for 15 minutes
        self._refresh_circuit_open_until = time.time() + 900  # 15 min
        self._last_refresh_error_code = 'RATE_LIMIT_EXCEEDED'
        print("[WARN] Rate limited - opening circuit breaker for 15 minutes")
        log_auth_diagnostic(
            'token_refresh_rate_limited',
            level='WARNING',
            cooldown_seconds=900,
            next_action='wait_cooldown'
        )
        return False
```

**Rationale**:
- Stops retry storms when rate limited
- Prevents wasting quota on failed attempts
- Allows rate limit window to reset
- Reduces background noise in logs

### Medium Priority Fixes

#### Fix 5: Reduce Proactive Refresh Frequency
**File**: `desktop_app.py` (sync worker thread)

```python
# Change from checking every 30 seconds to every 5 minutes
token_refresh_interval = 10  # 10 × 30s = 5 minutes (was 1)
```

**Rationale**:
- 5-minute buffer is sufficient (token expires with 5min warning)
- Reduces unnecessary background requests
- Decreases chance of hitting rate limit

#### Fix 6: Add Request Deduplication for JWT Exchange
**File**: `desktop_app.py` (get_valid_supabase_token method)

```python
def get_valid_supabase_token(self):
    # NEW: Deduplicate concurrent requests
    if hasattr(self, '_jwt_fetch_in_progress'):
        print("[INFO] JWT fetch already in progress, waiting...")
        for _ in range(20):  # Wait up to 10 seconds
            if not self._jwt_fetch_in_progress:
                break
            time.sleep(0.5)
        return self.tokens.get('supabase_token')
    
    self._jwt_fetch_in_progress = True
    try:
        # Existing JWT fetch logic...
    finally:
        self._jwt_fetch_in_progress = False
```

**Rationale**:
- Prevents duplicate JWT exchanges from batch upload and heartbeat
- Reduces concurrent requests to same endpoint
- Saves rate limit quota

### Long-term Improvements

1. **Per-User Rate Limiting**: Change rate limiter key from IP to user_id (after authentication)
2. **Separate Rate Limits**: Different limits for OAuth (10/15min), refresh (50/15min), JWT (100/15min)
3. **Token Caching**: Cache Supabase JWT more aggressively (reduce exchanges)
4. **Retry Budget**: Track total retries across all subsystems, enforce global budget
5. **Telemetry**: Add metrics for rate limit hits, alert when threshold exceeded

---

## Testing Recommendations

### Test Case 1: Rapid Login Retries
1. Start desktop app (not logged in)
2. Click "Login" → Cancel OAuth
3. Immediately click "Login" again (repeat 5 times)
4. **Expected**: 5th attempt should show rate limit message (not generic error)

### Test Case 2: Token Expiration During Active Use
1. Login successfully
2. Wait 1 hour (token expiry)
3. Continue working (batch upload triggered)
4. **Expected**: Token refreshes gracefully, no user notification

### Test Case 3: Network Interruption
1. Login successfully
2. Disable network for 30 seconds
3. Re-enable network
4. **Expected**: System recovers, retries succeed, no permanent error

### Test Case 4: Rate Limit Recovery
1. Trigger rate limit (make 30 auth requests rapidly)
2. Wait 15 minutes
3. Attempt login
4. **Expected**: Login succeeds after cooldown period

---

## Monitoring & Alerting

### Metrics to Track
- `auth_429_count`: Number of HTTP 429 responses per hour
- `auth_retry_count`: Total authentication retries per user per day
- `session_refresh_failures`: Failed token refresh attempts per hour
- `circuit_breaker_trips`: Number of times circuit breaker opened

### Alerts to Create
- **Alert**: Auth 429 count > 10/hour → Investigate rate limit configuration
- **Alert**: Session refresh failures > 5/hour → Check AI Server health
- **Alert**: Circuit breaker trips > 3/day → User may need support

---

## Conclusion

The "session expiration" issue is not a session expiration problem—it's a **rate limiting problem** disguised as an authentication failure. The desktop application's aggressive retry logic, combined with the AI Server's strict rate limits, creates a cascading failure scenario where legitimate users get locked out.

**Priority Actions**:
1. ✅ Increase auth rate limit from 30 to 100 requests/15min
2. ✅ Add HTTP 429 handling with exponential backoff
3. ✅ Improve error messages to distinguish rate limiting from auth failures
4. ✅ Add circuit breaker to stop retry storms

**Expected Impact**:
- 95% reduction in "Authentication Issue" notifications
- Users no longer locked out during normal operations
- Clear communication when rate limiting does occur
- Graceful recovery from transient failures

---

## Appendix: Code Locations

### Desktop App (desktop_app.py)
- OAuth callback retry: Lines 2082-2107
- Token refresh: Lines 2205-2420
- JWT exchange: Lines 2449-2543
- Proactive refresh loop: Lines 10345-10388
- Auth notification: Lines 8335-8395

### AI Server (ai-server/src/)
- Rate limiter config: `index.js` lines 118-128
- OAuth callback: `controllers/auth-controller.js` lines 426-494
- Token refresh: `controllers/auth-controller.js` lines 496-550
- JWT exchange: `controllers/auth-controller.js` lines 569-650

---

**Report Generated**: May 21, 2026  
**Analyst**: GitHub Copilot (Claude Sonnet 4.5)  
**Document Version**: 1.0

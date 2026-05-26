# Rate Limiter Isolation Fix — Detailed Plan

**Date**: May 25, 2026  
**Issue**: HTTP 429 errors during login despite increasing auth rate limiter limit  
**Root Cause**: Auth and background operations share the same rate limit bucket

---

## Executive Summary

Currently, authentication endpoints are protected by **two nested rate limiters**:
1. **General limiter** — 100 requests/10 minutes, applies to ALL `/api/*` routes
2. **Auth limiter** — 100 requests/10 minutes, applies specifically to auth routes

Desktop app background operations (batch uploads, syncs, heartbeats, diagnostics) use up the general limiter quota, leaving no room for login attempts even though the auth limiter is idle.

**Solution**: Exclude `/api/auth/*` routes from the general limiter, so auth endpoints only use their dedicated auth limiter quota.

---

## Current State Analysis

### Rate Limiters Defined

| Limiter | Window | Max | Used By | Purpose |
|---------|--------|-----|---------|---------|
| `limiter` (general) | 10 min | 100 | ALL `/api/*` except `/api/forge/*` | Prevent DDoS to general API |
| `authLimiter` | 10 min | 100 | Auth endpoints only | Prevent brute force on auth |
| `publicLimiter` | 1 min | 30 | `/health`, `/`, legal pages | Prevent DDoS on public endpoints |
| `accuracyDashboardLimiter` | 1 min | 200 | `/api/forge/accuracy/*` | Accuracy dashboard (high parallel requests) |
| `feedbackLimiter` | 15 min | 10 | `/api/feedback/submit` | Prevent feedback spam |
| `versionCheckLimiter` | 15 min | 60 | `/api/app-version/*` | Version check endpoints |
| `forgeLimiter` | 1 min | 200 | `/api/forge/*` | Forge app requests (per-tenant) |

### Auth Routes (All Protected by Both `limiter` AND `authLimiter`)

```javascript
// Line 251: Applied to ALL /api/ routes including auth
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/forge/')) return next(); // forge skips general limiter
  return limiter(req, res, next);                    // auth does NOT skip
});

// Lines 260-275: Auth endpoints with explicit authLimiter
app.get('/api/auth/config',               authLimiter, ...);
app.post('/api/auth/atlassian/callback',  authLimiter, ...);  // ← CRITICAL: used during login
app.post('/api/auth/refresh-token',       authLimiter, ...);
app.post('/api/auth/exchange-token',      authLimiter, ...);
app.post('/api/auth/verify',              authLimiter, ...);
app.post('/api/auth/supabase-config',     authLimiter, ...);
app.post('/api/auth/ocr-config',          authLimiter, ...);
app.post('/api/auth/diagnostics',         authLimiter, ...);
```

### Background Routes Using General Limiter

Desktop app makes these calls repeatedly (every 5-30 minutes):
- `/api/auth/verify` — verify Atlassian token validity
- `/api/auth/refresh-token` — refresh expired token
- `/api/auth/supabase-config` — fetch Supabase config
- `/api/auth/diagnostics` — submit diagnostic logs
- `/api/forge/dashboard` — fetch task data
- `/api/forge/organization` — fetch org data
- `/api/forge/issues/cache` — update issue cache

**Each call counts against the general limiter's 100/10min quota.**

### Quota Exhaustion Scenario

```
Timeline (10-minute window):

T0:00  → Batch upload sync     → -1 from general limiter (99 left)
T0:05  → Heartbeat check       → -1 from general limiter (98 left)
T0:05  → Token refresh         → -1 from general limiter (97 left)
T0:10  → Project sync          → -1 from general limiter (96 left)
T0:15  → Diagnostics push      → -1 from general limiter (95 left)
...
T5:00  → User clicks LOGIN
        → Request goes to general limiter
        → General limiter has ~50 calls left (half exhausted)
        → But if hammering or many background ops...
        → General limiter could be at 90+/100
        → ❌ 429 BLOCKED
        
        → authLimiter never gets consulted
        → authLimiter still has 100/100 available (wasted capacity)
```

---

## The Fix

**File**: `ai-server/src/index.js`  
**Lines**: 251-254 (the general limiter middleware)

### Current Code (Lines 251-254)
```javascript
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/forge/')) return next();
  return limiter(req, res, next);
});
```

### Fixed Code
```javascript
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/forge/')) return next();
  if (req.path.startsWith('/auth/'))  return next();  // ← ADD THIS LINE
  return limiter(req, res, next);
});
```

### What This Changes

| Route | Before | After | Auth Limiter Used |
|-------|--------|-------|-------------------|
| `/api/auth/atlassian/callback` | `limiter` + `authLimiter` | `authLimiter` only | ✅ Yes |
| `/api/auth/refresh-token` | `limiter` + `authLimiter` | `authLimiter` only | ✅ Yes |
| `/api/auth/verify` | `limiter` + `authLimiter` | `authLimiter` only | ✅ Yes |
| `/api/forge/dashboard` | `limiter` | `limiter` | ❌ No (forge has own limiter) |
| `/api/other/*` | `limiter` | `limiter` | ❌ No |

---

## Impact Analysis

### What Gets Fixed
✅ Auth operations (login, token refresh, verification) now have **dedicated 100/10min quota**  
✅ Background operations can no longer starve auth requests  
✅ Login success rate improves dramatically  
✅ Error message now matches correct limiter (authLimiter's message says "authentication attempts")

### What Remains Protected
✅ General API routes still protected by `limiter` (100/10min)  
✅ Forge routes still protected by `forgeLimiter` (200/min, per-tenant)  
✅ Public routes still protected by `publicLimiter` (30/min)  
✅ Feedback still protected by `feedbackLimiter` (10/15min)  
✅ Version checks still protected by `versionCheckLimiter` (60/15min)

### Security Impact

**Potential Risk**: Auth endpoints get their own quota, so theoretically an attacker could use all 100/10min quota on just auth endpoints without hitting the general limiter first.

**Mitigation**: 
- 100 auth attempts per 10 minutes = 10 attempts per minute = ~1 attempt every 6 seconds
- This is still slow enough to prevent effective brute force (TOTP codes expire every 30 seconds)
- Atlassian OAuth requires valid client credentials (no credential stuffing)
- Consider further restricting authLimiter if abuse is detected

**Verdict**: ✅ ACCEPTABLE — auth limiter is already specifically designed for this purpose

---

## Verification Checklist

### Pre-Deployment Testing

- [ ] **Unit Test**: Verify middleware order in index.js is correct
  ```bash
  grep -A 5 "app.use('/api/'" ai-server/src/index.js
  ```

- [ ] **Code Review**: Check that no other files depend on general limiter applying to auth
  ```bash
  grep -r "limiter" ai-server/src --include="*.js" | grep -E "(auth|callback)" | grep -v "authLimiter|forgeLimiter|publicLimiter"
  ```

- [ ] **Verify All Auth Routes**: Ensure all auth routes explicitly use `authLimiter`
  ```bash
  grep "app\.\(get\|post\|put\|patch\|delete\).*'/api/auth/" ai-server/src/index.js | wc -l
  # Should show 8 auth routes, all with authLimiter
  ```

### Post-Deployment Testing

**Test 1: Auth Limiter Only Applies to Auth**
```bash
# Rapid requests to verify both limiters work independently
for i in {1..101}; do curl http://localhost:3001/api/auth/config; done
# Should see 429 after 100 attempts
# Error message should say: "Too many authentication attempts, please try again later."
```

**Test 2: General Limiter Still Works for Non-Auth**
```bash
# Make 101 calls to a non-auth endpoint
for i in {1..101}; do curl -X POST http://localhost:3001/api/forge/dashboard -H "FIT: token"; done
# Should see 429 after 100 attempts (or 200 if using forgeLimiter instead)
```

**Test 3: Realistic Scenario**
```
1. Start desktop app with background operations running
2. Check that background operations (every 5 min) don't exhaust quota
3. Try to login 10 times in rapid succession
4. Verify at least some login attempts succeed (not all hit 429)
5. Check AI Server logs for error messages
```

**Test 4: Load Test**
```bash
# Simulate concurrent background ops + login attempt
# Run background task simulator (if exists)
# Then attempt 5-10 logins in parallel
# Measure success rate — should be high (>90%)
```

### Monitoring Alerts to Enable

After deployment, monitor these metrics:
- Count of 429 errors from `limiter` (should decrease)
- Count of 429 errors from `authLimiter` (should be low, only if truly hammering)
- Login success rate (should improve)
- Auth endpoint response times (should be stable)

---

## Rollback Plan

If the fix causes unexpected issues:

1. **Revert in index.js** (remove the auth exclusion line)
2. **Redeploy** the previous version
3. **Root cause analysis**:
   - Check if any code expects general limiter to apply to auth
   - Check if any auth endpoints are missing `authLimiter` middleware
   - Check if request paths don't start with `/auth/` (e.g., nested paths)

---

## Files Modified

- **`ai-server/src/index.js`**: 1 line added at line 252

---

## Timeline

- **Preparation**: Review this plan (5 min)
- **Code Change**: 1 line addition (1 min)
- **Testing**: Run verification checklist (15 min)
- **Deployment**: Push to production (5 min)
- **Monitoring**: Watch logs for 2 hours (2 hours)

---

## Questions to Ask Team Before Proceeding

1. ✅ **Are auth routes the only ones that should bypass the general limiter?**  
   → Current bypass list: `/forge/*` (Atlassian's shared IPs), `/auth/*` (proposed)

2. ✅ **Is 100/10min quota enough for auth limiter?**  
   → If background ops still hit quota, may need to increase to 200-300

3. ✅ **Should we add monitoring alerts for 429 errors?**  
   → Recommended: Alert if 429 rate > 5% of total auth requests

4. ✅ **Should we log which limiter rejected a request?**  
   → Recommended: Add header `X-Rate-Limit-By: authLimiter` or `X-Rate-Limit-By: general`

---

## Decision Gate

**⚠️ Requires Team Lead Approval Before Proceeding**

- [ ] Team lead reviewed and approved this plan
- [ ] No blockers or concerns raised
- [ ] Ready to apply fix

---

## Appendix: Rate Limiter Behavior Reference

### How express-rate-limit Works

Each middleware in the stack independently tracks requests:

```javascript
app.use('/api/', middleware1);  // Tracks all /api/* 
app.post('/api/auth/callback', middleware2, middleware3);  // Tracks only this route
```

When a request comes in:
1. `middleware1` checks its bucket and increments counter (if passed)
2. If `middleware1` blocks it, `middleware2` never runs
3. If `middleware1` passes it, `middleware2` checks its bucket independently

**Current Problem**: 
- Request to `/api/auth/callback` hits `middleware1` (general limiter) first
- If `middleware1` blocks it, user gets 429 with message "Too many requests from this IP..."
- `middleware2` (authLimiter) never gets consulted

**After Fix**:
- Request to `/api/auth/callback` bypasses `middleware1`
- Goes directly to `middleware2` (authLimiter)
- Gets accurate message: "Too many authentication attempts..."
- Background ops continue using `middleware1` without interfering with auth


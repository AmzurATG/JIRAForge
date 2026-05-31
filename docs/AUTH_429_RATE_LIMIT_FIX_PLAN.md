# Authentication 429 Rate Limit Fix Plan

**Date:** 2026-05-29  
**Affected service:** `ai-analysis-server` (deployed at `forgesync.amzur.com`)  
**Affected file:** `ai-server/src/index.js`  
**Symptom:** Desktop app login fails with `Authentication Failed — Token exchange failed (HTTP 429): Too many authentication attempts, please try again later.`

---

## 1. Symptom

The browser-based OAuth callback page shows:

```
Authentication Failed
Token exchange failed. This may be a temporary server issue.

ERROR TYPE: TOKEN_EXCHANGE
Token exchange failed (HTTP 429): Too many authentication attempts, please try again later.
```

This error is thrown by the desktop app's `handle_callback()` method in `desktop_app.py` when the AI server returns HTTP 429 on `POST /api/auth/atlassian/callback`.

---

## 2. History of the Fix Attempt

A previous fix raised the `authLimiter` `max` from 30 → 100 (per 10 minutes per IP). This helped but **did not resolve the problem**, because it misidentified the cause. The real issue is architectural — a shared rate-limit bucket, not a bucket that was simply too small.

---

## 3. Root Cause Analysis

### 3.1 The single shared bucket

In `ai-server/src/index.js`, a single `authLimiter` instance was applied to **every** auth endpoint:

```js
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 100,                  // 100 requests per 10 minutes per IP
  ...
});

app.get ('/api/auth/config',              authLimiter, ...);
app.post('/api/auth/atlassian/callback',  authLimiter, ...);  // ← actual login
app.post('/api/auth/refresh-token',       authLimiter, ...);  // ← runs in background
app.post('/api/auth/exchange-token',      authLimiter, ...);
app.post('/api/auth/verify',              authLimiter, ...);
app.post('/api/auth/supabase-config',     authLimiter, ...);  // ← called on every startup
app.post('/api/auth/ocr-config',          authLimiter, ...);  // ← called on every startup
app.post('/api/auth/diagnostics',         authLimiter, ...);  // ← periodic background
app.post('/admin-dashboard/api/login',    authLimiter, ...);
```

All nine endpoints share the **same IP-keyed counter**. This means every request to any of these endpoints — regardless of intent — drains from the same pool.

### 3.2 Background operations run continuously

The desktop app is not just a login client. Once a user is logged in, the app continuously fires requests to the AI server as part of normal operation:

| Endpoint | When called | Approximate frequency |
|---|---|---|
| `/api/auth/refresh-token` | Whenever the access token nears expiry | Every ~55 minutes |
| `/api/auth/supabase-config` | On app startup and after token refresh | Each login + restart |
| `/api/auth/ocr-config` | On app startup | Each login + restart |
| `/api/auth/diagnostics` | Periodic telemetry, login events, errors | Multiple times per session |

### 3.3 Why this blocks login at the office

The `authLimiter` was IP-keyed. In an office environment, all users share the same public egress IP.

**Example: 5 users logged in at the same office**

Each user's running desktop app generates approximately:
- 1 token refresh per hour = `5 req/hr` across users
- 2 config fetches per restart (supabase + ocr)
- Several diagnostics per session

Over a 10-minute window this easily exceeds 100 requests — and this is without counting any actual login attempts. When the budget is exhausted, the next user who tries to log in sends a `POST /api/auth/atlassian/callback`, which hits the same bucket and gets HTTP 429 immediately.

**The budget math:**
```
10 users logged in × (1 refresh/hr + startup fetches + diagnostics)
≈ 15-30 background requests per 10-minute window

Add: one user logging in for the first time
= POST /api/auth/atlassian/callback   [1 req]
+ POST /api/auth/exchange-token       [1 req]
+ POST /api/auth/supabase-config      [1 req]
+ POST /api/auth/ocr-config           [1 req]
= 4 requests per login flow

At ~50 background reqs already consumed, a single login flow is fine.
At ~96 background reqs consumed, the login's 4th request hits 429.
At 100+ background reqs consumed, login fails on the first request.
```

Raising the limit to 100 bought some headroom but did not fix the root cause: **background operations can still saturate any fixed budget that is shared with the login endpoint**.

### 3.4 Why a higher number cannot solve this

No matter how large the shared bucket is, as the number of logged-in users grows, background traffic grows linearly with it. A team of 20 users generates roughly 4× the background traffic of a team of 5. The only durable fix is to isolate the login endpoint into its own budget.

---

## 4. The Fix

### 4.1 Split into two rate limiters

Replace the single `authLimiter` with two distinct limiters applied to separate endpoint groups:

**`loginLimiter`** — strict, for the actual login step only:
```js
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,  // 30 login attempts per 15 min per IP
  message: 'Too many authentication attempts, please try again later.',
  ...
});
```

Applied to: `POST /api/auth/atlassian/callback`

- 30 login attempts per 15 minutes is very generous for real users (a typical user logs in once or twice a day).
- Still protects against auth-code replay / brute-force abuse.
- Has its **own isolated counter** — background operations never drain it.

---

**`backgroundAuthLimiter`** — generous, for continuous background operations:
```js
const backgroundAuthLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 500, // 500 requests per 10 min per IP
  message: 'Too many requests, please try again later.',
  ...
});
```

Applied to:
- `POST /api/auth/refresh-token`
- `POST /api/auth/exchange-token`
- `POST /api/auth/verify`
- `POST /api/auth/supabase-config`
- `POST /api/auth/ocr-config`
- `POST /api/auth/diagnostics`

**Why 500 is safe here:** These endpoints require a valid Atlassian bearer token in the request body. An attacker cannot meaningfully abuse them without first completing a real OAuth flow. The rate limit here exists only to prevent catastrophic runaway loops in the client code, not to guard against brute-force.

---

**`authLimiter`** — kept as an alias to `loginLimiter` for remaining endpoints that are not background operations (e.g., `POST /admin-dashboard/api/login`, `GET /api/auth/config`).

### 4.2 File changed

`ai-server/src/index.js`

```diff
- // Rate limiter specifically for auth endpoints (stricter to prevent abuse)
- const authLimiter = rateLimit({
-   windowMs: 10 * 60 * 1000, // 10 minutes
-   max: 100, // 100 requests per 10 minutes per IP
-   ...
- });

+ const loginLimiter = rateLimit({
+   windowMs: 15 * 60 * 1000,
+   max: 30,
+   ...
+ });
+
+ const backgroundAuthLimiter = rateLimit({
+   windowMs: 10 * 60 * 1000,
+   max: 500,
+   ...
+ });
+
+ const authLimiter = loginLimiter; // alias for non-background misc endpoints

  // Login (isolated bucket — cannot be drained by background ops)
- app.post('/api/auth/atlassian/callback', authLimiter,  authController.atlassianCallback);
+ app.post('/api/auth/atlassian/callback', loginLimiter, authController.atlassianCallback);

  // Background ops (generous bucket — shared among all logged-in users)
- app.post('/api/auth/refresh-token',   authLimiter, authController.refreshToken);
- app.post('/api/auth/exchange-token',  authLimiter, authController.exchangeToken);
- app.post('/api/auth/verify',          authLimiter, authController.verifyToken);
- app.post('/api/auth/supabase-config', authLimiter, authController.getSupabaseConfig);
- app.post('/api/auth/ocr-config',      authLimiter, authController.getOcrConfig);
- app.post('/api/auth/diagnostics',     authLimiter, authController.submitDiagnostics);
+ app.post('/api/auth/refresh-token',   backgroundAuthLimiter, authController.refreshToken);
+ app.post('/api/auth/exchange-token',  backgroundAuthLimiter, authController.exchangeToken);
+ app.post('/api/auth/verify',          backgroundAuthLimiter, authController.verifyToken);
+ app.post('/api/auth/supabase-config', backgroundAuthLimiter, authController.getSupabaseConfig);
+ app.post('/api/auth/ocr-config',      backgroundAuthLimiter, authController.getOcrConfig);
+ app.post('/api/auth/diagnostics',     backgroundAuthLimiter, authController.submitDiagnostics);
```

---

## 5. Deployment Steps

1. **Pull the latest code** on the server:
   ```bash
   cd /home/appuser/root/JIRAForge/ai-server
   git pull origin main
   ```

2. **Restart the service** (adjust for your process manager):
   ```bash
   # PM2
   pm2 restart ai-server

   # systemd
   sudo systemctl restart ai-server
   ```

3. **Verify the fix** — watch logs immediately after a login attempt:
   ```bash
   tail -f logs/combined.log | grep '\[Auth\]'
   ```
   You should see `[Auth] Successfully exchanged code for tokens` with no 429 errors.

4. **Confirm background ops are unaffected** — check that token refresh log lines continue appearing normally for already-logged-in users:
   ```bash
   tail -f logs/combined.log | grep 'refresh'
   ```

---

## 6. Verification Checklist

- [ ] A new user can log in from an office IP where 5+ other users are already running the app
- [ ] `POST /api/auth/atlassian/callback` returns 200 on first attempt after fix deployment
- [ ] Background token refreshes for existing sessions continue without interruption
- [ ] Server logs show no 429 errors during normal multi-user usage
- [ ] Admin dashboard login still works (uses `authLimiter` alias → `loginLimiter`)

---

## 7. Related Issues

| Issue | Status | Notes |
|---|---|---|
| `authLimiter` max raised 30 → 100 | ✅ Merged | Partial fix only — did not address shared bucket problem |
| Login fails with HTTP 429 from shared office IP | ✅ Fixed by this plan | Root cause: background ops sharing login bucket |
| `[Auth] Token refresh error: refresh_token is invalid` (×~9 in logs) | ℹ️ Unrelated | Affected users need to re-authenticate; refresh token was revoked upstream by Atlassian. No code fix needed. |
| FIT authentication failures (`aud` mismatch) | ℹ️ Separate issue | See `FIT_AUTH_FIX_PLAN.md` — fix is to set correct `FORGE_APP_ID` env var on deployed host |

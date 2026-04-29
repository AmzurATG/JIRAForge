# FIT Authentication Fix Plan

**Date:** 2026-04-28
**Affected service:** `ai-analysis-server` (deployed at `forgesync.amzur.com`, container path `/home/appuser/root/JIRAForge/ai-server`)
**Affected component:** `src/middleware/forge-auth.js`

---

## 1. Verified Findings

### 1.1 Codebase facts (confirmed by reading current files)

| Claim | Source | Status |
|---|---|---|
| Forge app ID is `ari:cloud:ecosystem::app/c8bab1dc-ae32-4e6f-9dbd-eb242cc6c14a` | `forge-app/manifest.yml:2` | ✅ Confirmed |
| Local `.env` sets `FORGE_APP_ID` to the matching ARI | `ai-server/.env:122` | ✅ Confirmed |
| `.env.example` documents comma-separated ARI format | `ai-server/.env.example:107` | ✅ Confirmed |
| FIT verifier loops candidate audiences and throws only the last error | `ai-server/src/middleware/forge-auth.js:107-123` | ✅ Confirmed |
| `clockTolerance: '60s'` is already applied to `jose.jwtVerify` | `ai-server/src/middleware/forge-auth.js:114` | ✅ Confirmed |
| Failure-logging line uses 6 positional args to `logger.error` (root cause of mangled "Expected one of:" output) | `ai-server/src/middleware/forge-auth.js:133` | ✅ Confirmed |
| `[Auth] Token refresh error:` originates from Atlassian OAuth refresh path, not FIT | `ai-server/src/controllers/auth-controller.js:541` | ✅ Confirmed (separate subsystem) |
| Stack frames in error logs show `/home/appuser/root/...` ⇒ deployed Linux server, not the Windows dev box | Log stack traces | ✅ Confirmed |

### 1.2 Diagnosis (from log analysis)

- The token's `aud` claim is the full ARI (`[ARI_REDACTED]` matches the sanitizer's ARI regex `ari:cloud:[a-z]+::[a-z]+/...`).
- The "Expected one of:" log line renders as a character-indexed JSON object. Sorting keys 0–62 yields the literal string:
  `forge/invocation-tokenapp/c8bab1dc-ae32-4e6f-9dbd-eb242cc6c14a"`
  which decodes back to the array `["forge/invocation-token", "app/c8bab1dc-ae32-4e6f-9dbd-eb242cc6c14a"]` — i.e., the value `process.env.FORGE_APP_ID` evaluated to on the running server, after `.split(',')`.
- Neither array entry is a valid Forge audience. `forge/invocation-token` is the **issuer** (`iss`), and `app/<uuid>` is not the ARI form Forge mints into `aud`.
- `aud` is checked by `jose` before `nbf`/`exp`, so this surfaces as an `aud` error regardless of clock skew. Prior memory note about clock skew masking does **not** apply here — `clockTolerance: 60s` is already in place and `aud` is a literal mismatch.

### 1.3 Other errors in the log dump (independent of FIT)

| Error | Location | Action |
|---|---|---|
| `[Auth] Token refresh error: refresh_token is invalid` (×~9) | `auth-controller.js:541` (Atlassian OAuth refresh) | Affected user(s) need to re-authenticate from the desktop app. No code fix needed; refresh token was revoked or expired upstream. |
| Single Cloudflare HTML 500 logged at 17:38:10 | Log dump only | Transient upstream response body being logged as error. Ignore unless it recurs. Worth a follow-up if frequent. |

---

## 2. Fix Plan

### Step 1 — Correct the deployed `FORGE_APP_ID` env var (REQUIRED, primary fix)

**On the deployed host** (`/home/appuser/root/JIRAForge/ai-server`), set:

```
FORGE_APP_ID=ari:cloud:ecosystem::app/c8bab1dc-ae32-4e6f-9dbd-eb242cc6c14a
```

Locate the env source actually used by the running process. Likely candidates, in order of likelihood:
1. `/home/appuser/root/JIRAForge/ai-server/.env` (read by `dotenv` at startup)
2. Process manager env (PM2 `ecosystem.config.js`, systemd unit `Environment=` line, or Docker `--env-file`/`-e`)
3. CI/CD pipeline that templates env vars at deploy time

Then restart the service. Verify by tailing logs immediately after restart for the line:

```
[FIT] Configured FORGE_APP_IDs: [ 'ari:cloud:ecosystem::app/c8bab1dc-ae32-4e6f-9dbd-eb242cc6c14a' ]
```

(Source: `forge-auth.js:19`.) If the array contains anything else, the wrong env source is still being loaded.

### Step 2 — Smoke-test FIT validation

After restart, trigger a Forge frontend action that calls the `ai-server` remote (e.g., open the BRD time tracker project page). Tail `logs/error.log`:
- ✅ Success: no new `[FIT] Authentication failed` entries; `[FIT] Request authenticated` info entries appear.
- ❌ Still failing: capture one fresh JWT and decode it (`base64url -d` the middle segment) to inspect the actual `aud` value, then compare byte-for-byte against the configured ARI.

### Step 3 — Improve the failure-log readability (OPTIONAL, recommended)

The character-indexed JSON output that obscured this issue comes from passing 6 positional args to `logger.error`. Replace the call at `forge-auth.js:133` with a structured form so the next failure is immediately readable:

```js
// Before (line 133):
logger.error('[FIT] Token validation failed. Expected one of:', FORGE_APP_IDS, '| Actual aud:', JSON.stringify(decoded.aud), '| iss:', decoded.iss);

// After:
logger.error('[FIT] Token validation failed: aud mismatch', {
  expected: FORGE_APP_IDS,
  actualAud: decoded.aud,
  iss: decoded.iss
});
```

This is a one-line change, no behavior impact, and avoids the winston `splat()` + `Object.assign(info, arrayLikeString)` interaction that produced the indexed-character output.

### Step 4 — Remediate refresh-token errors (OPTIONAL, separate)

The `[Auth] Token refresh error: refresh_token is invalid` entries are unrelated to FIT. Action items:
- Identify which user(s) hit this (correlate by source IP / request context if traceable).
- Have them sign out and re-authenticate from the desktop app to mint a new refresh token.
- No server-side code fix required; the existing handler at `auth-controller.js:543` already distinguishes 401 (`requiresReauth`) from transient 400 errors.

### Step 5 — (Defer) Investigate possible secondary clock skew

After fixing `aud`, **if** new errors surface for the `nbf` claim, the deployed host's clock may be ~60–90s behind the token issuer. Diagnose with:

```bash
date -u                  # compare to a fresh token's iat
chronyc tracking         # if chrony is installed
timedatectl              # systemd-based hosts
```

Token validity window is `iat - 30s ≤ now ≤ iat + 25s`, padded by `clockTolerance: 60s` ⇒ `iat - 90s ≤ now ≤ iat + 85s`. If the host is outside that band, fix NTP. **Do not pre-emptively raise `clockTolerance` beyond 60s** — that weakens replay protection.

---

## 3. Acceptance Criteria

- [ ] `[FIT] Configured FORGE_APP_IDs:` startup log on the deployed server prints exactly the ARI from `forge-app/manifest.yml:2`.
- [ ] No new `[FIT] Authentication failed: unexpected "aud" claim value` entries appear in `logs/error.log` after restart.
- [ ] A Forge frontend action successfully reaches an authenticated `ai-server` route (e.g., the project page loads data).
- [ ] (Optional, Step 3) Next FIT failure (if any) logs a flat JSON object with `expected`/`actualAud`/`iss` keys instead of character-indexed output.

---

## 4. Out of Scope

- Adding new audience formats to `buildAudienceOptions`. The current logic already handles the full ARI and the bare UUID; no expansion is needed once the env var is correct.
- Changing the `clockTolerance` value. 60s is already in place and is the recommended ceiling.
- Modifying the log sanitizer. The PII redaction is working correctly (the ARI was redacted as `[ARI_REDACTED]`); the visibility issue is purely a `winston` formatting interaction with positional args.

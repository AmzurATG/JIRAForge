# Refresh-Token Error Misclassification Causes Log-Burst and Wasted Retries

**Prepared:** 2026-05-26
**Components:** ai-server (primary), python-desktop-app (defense-in-depth)
**Status:** Root cause confirmed — fix proposed, awaiting approval to proceed
**Severity:** Medium (affected users still need to re-authenticate; the bug amplifies log noise and burns 3–5 wasted refresh attempts per cycle, but does not corrupt data or block other users)

---

## 1. Summary (TL;DR)

The ai-server error log shows repeated bursts of:

```
{"error":"unauthorized_client","error_description":"refresh_token is invalid",
 "level":"error","message":"[Auth] Token refresh error:",
 "service":"ai-analysis-server"}
```

The errors originate from the desktop app (the Forge frontend does **not** call this
endpoint — it authenticates with Forge Invocation Tokens). They appear when a desktop
user's Atlassian refresh token has rotated out of validity, been revoked, or expired.

The underlying user condition is benign and unavoidable (Atlassian rotates refresh
tokens). The **bug** is in how the server and the desktop client classify Atlassian's
response: both treat this permanent OAuth failure as "transient," so the desktop client
keeps retrying 3–5 times before its safety-net counter kicks in. That produces the burst
pattern of 5–15 identical errors in seconds and delays the "please re-authenticate"
notification to the user.

The fix is two small changes — one on the server, one on the desktop client — plus
adding the actual HTTP status code to the log line so future incidents are diagnosable at
a glance. **No database changes, no new permissions, no manifest changes.**

---

## 2. What users experience

- After a long period away from the app (or after using the app from a second device that
  rotated the refresh token chain), the desktop app silently fails to refresh its
  Atlassian token. The user is not immediately prompted to re-authenticate.
- The desktop app makes 3 immediate retries (2 s / 4 s backoff) and several follow-up
  attempts before reaching its internal "5 failures = permanent" threshold.
- Only after the threshold is reached does the tray notification show "session expired —
  please sign in again." Until then the app looks idle without explanation.
- Operations team sees `[Auth] Token refresh error: refresh_token is invalid` arriving in
  bursts, with no user identifier in the log line, making it impossible to correlate the
  errors to a specific account without enriching the logging.

---

## 3. Why it happens (root cause)

### 3.1 The original log path

The log line is emitted at [ai-server/src/controllers/auth-controller.js:541](../ai-server/src/controllers/auth-controller.js#L541)
inside `exports.refreshToken`. That handler proxies the desktop app's
`POST /api/auth/refresh-token` call to Atlassian's `https://auth.atlassian.com/oauth/token`
endpoint with `grant_type=refresh_token`.

Atlassian's response to an invalid/rotated/revoked refresh token is, per their docs and
observed in production:

```json
{"error":"unauthorized_client","error_description":"refresh_token is invalid"}
```

Atlassian's [refresh-token docs](https://developer.atlassian.com/cloud/oauth/getting-started/refresh-tokens/)
describe this as a **permanent** failure — the only recovery is for the user to go through
the OAuth consent flow again.

### 3.2 Bug #1 — server classifies by HTTP status only

The server handler at [auth-controller.js:546](../ai-server/src/controllers/auth-controller.js#L546)
treats permanence as a function of the HTTP status code:

```js
if (error.response?.status === 401) {
  return res.status(401).json({ ..., requiresReauth: true, errorCode: 'OAUTH_REAUTH_REQUIRED' });
}
// Anything else (400 / 403 / 5xx / network) is classified as transient:
res.status(error.response?.status || 500).json({ ..., errorCode: 'OAUTH_TEMPORARY_FAILURE' });
```

Atlassian, however, returns these permanent OAuth failures with **HTTP 403** (per their
docs) — and the team's own tests at
[auth-controller.test.js:262-318](../ai-server/tests/controllers/auth-controller.test.js#L262-L318)
also anticipate **HTTP 400** for `invalid_grant`. So the actual production response falls
into the `OAUTH_TEMPORARY_FAILURE` branch, even though it is permanent.

The correct OAuth classifier is the **error code in the response body**
(`invalid_grant`, `unauthorized_client`), not the HTTP status that wraps it. RFC 6749
mandates `invalid_grant` for an expired or revoked refresh token; Atlassian additionally
uses `unauthorized_client` when an out-of-rotation refresh token from the same client is
used. Both are permanent.

### 3.3 Bug #2 — desktop text-matching fallback has a typo

The desktop client at
[desktop_app.py:2322-2334](../python-desktop-app/desktop_app.py#L2322-L2334) does have a
text-based fallback to catch this pattern, but two problems prevent it from firing:

1. **Short-circuit:** because the server tags the response `errorCode: 'OAUTH_TEMPORARY_FAILURE'`,
   the client's `elif error_code == 'OAUTH_TEMPORARY_FAILURE': is_permanent_failure = False`
   branch executes before the text-matching `else` branch is ever reached.
2. **Even if the text branch were reached,** the check at
   [desktop_app.py:2331](../python-desktop-app/desktop_app.py#L2331) looks for the literal
   string `'refresh token is invalid'` (with a space). Atlassian sends
   `'refresh_token is invalid'` (with an underscore). The substring check misses it.

### 3.4 Why the bursts look so dense

A single desktop install will:

- Retry up to 3 times inside `is_authenticated()` ([desktop_app.py:2442-2452](../python-desktop-app/desktop_app.py#L2442-L2452))
  with 2 s / 4 s backoff.
- Need 5 consecutive permanent-classified failures inside a 10-minute window
  ([desktop_app.py:2353-2357](../python-desktop-app/desktop_app.py#L2353-L2357)) before
  marking the refresh token "invalid" and falling silent for 30 minutes.

Because the misclassification keeps each failure tagged as transient, the 5-attempt
counter takes longer to trip. Multiply that by N desktop installs whose tokens went stale
around the same time (e.g., overnight) and a burst of 10–20 errors in 30 seconds is the
expected shape — exactly what the log shows.

### 3.5 Why the log line is hard to triage

The current `logger.error('[Auth] Token refresh error:', error.response?.data || error.message)`
call at [auth-controller.js:541](../ai-server/src/controllers/auth-controller.js#L541)
captures the Atlassian body, but **not** the HTTP status code, **not** the request ID,
and **not** the source IP. That means operators looking at the log cannot:

- Confirm whether Atlassian returned 400 vs 401 vs 403 (which is currently the *only*
  thing the server uses to classify the failure).
- Tell which user/install is affected, so they can be told to re-authenticate.

---

## 4. The proposed fix

Three changes, ordered so each can ship independently. Layer 1 alone unblocks operations;
Layers 2 and 3 fix the underlying behaviour for every future occurrence.

### Layer 1 — Enrich the failure log (ai-server, ~5 lines)

**File:** [ai-server/src/controllers/auth-controller.js](../ai-server/src/controllers/auth-controller.js)

Replace the existing single-line `logger.error` at line 541 with a structured form that
captures HTTP status, the OAuth error code, request ID, and source IP. Include only the
last 8 characters of the refresh token for correlation — the suffix alone is not a usable
secret but is enough to confirm whether the same token is being retried.

```js
logger.error('[Auth] Token refresh error', {
  status: error.response?.status,
  oauthError: error.response?.data?.error,
  oauthDesc: error.response?.data?.error_description,
  requestId: req.id,
  ip: req.ip,
  refreshTokenSuffix: refresh_token?.slice(-8)
});
```

This change has **no functional impact**; it makes Layers 2 and 3 verifiable and lets
operations identify affected users from the existing log stream.

### Layer 2 — Server classifies by OAuth error code, not HTTP status (ai-server)

**File:** [ai-server/src/controllers/auth-controller.js](../ai-server/src/controllers/auth-controller.js),
lines 540–562 (inside the `catch` block of `exports.refreshToken`).

Replace the `error.response?.status === 401` branch with an OAuth-error-code-driven
classifier:

```js
} catch (error) {
  const status = error.response?.status;
  const oauthError = error.response?.data?.error;

  logger.error('[Auth] Token refresh error', {
    status,
    oauthError,
    oauthDesc: error.response?.data?.error_description,
    requestId: req.id,
    ip: req.ip,
    refreshTokenSuffix: refresh_token?.slice(-8)
  });

  // Permanent failure — refresh token will never work again.
  // RFC 6749 mandates `invalid_grant` for expired/revoked refresh tokens; Atlassian
  // additionally returns `unauthorized_client` for tokens that rotated out of the active
  // chain. Both are terminal regardless of the HTTP status code Atlassian wraps them in.
  const isPermanent =
    status === 401 ||
    oauthError === 'invalid_grant' ||
    oauthError === 'unauthorized_client';

  if (isPermanent) {
    return res.status(401).json({
      success: false,
      error: 'Refresh token expired, revoked, or rotated out. User must re-authenticate.',
      requiresReauth: true,
      errorCode: 'OAUTH_REAUTH_REQUIRED'
    });
  }

  // Genuinely transient (5xx, network blip, malformed request) — client may retry.
  res.status(status || 500).json({
    success: false,
    error: `Token refresh failed: ${formatAtlassianError(error)}`,
    errorCode: 'OAUTH_TEMPORARY_FAILURE'
  });
}
```

#### Test updates that go with Layer 2

**File:** [ai-server/tests/controllers/auth-controller.test.js](../ai-server/tests/controllers/auth-controller.test.js)

- The existing test at lines 281–302 currently asserts that `400 + invalid_grant` is
  transient. That assertion contradicts the OAuth spec — flip it to expect HTTP 401 +
  `requiresReauth: true` + `errorCode: 'OAUTH_REAUTH_REQUIRED'`.
- The existing test at lines 305–318 currently asserts that `403 + forbidden` is
  transient. That can stay (`forbidden` is not an OAuth permanent error code), but **add
  a new test** for the actual production payload:
  `403 + { error: 'unauthorized_client', error_description: 'refresh_token is invalid' }`,
  expecting HTTP 401 + `requiresReauth: true`.
- Add a third new test for `Token was globally revoked` (`403 + { error: 'invalid_grant',
  error_description: 'Token was globally revoked' }`), expecting the same permanent
  classification.

### Layer 3 — Desktop client text-matching belt-and-suspenders (python-desktop-app)

**File:** [python-desktop-app/desktop_app.py](../python-desktop-app/desktop_app.py),
lines 2328–2334.

After Layer 2 ships, the server will always send `OAUTH_REAUTH_REQUIRED` for this case
and the client's text-matching `else` branch will never be reached for it. However:

- Older desktop builds in the field will keep talking to the new server. The text-matching
  branch *is* the right fix for them.
- The current text check misses Atlassian's exact wording (underscore-vs-space) — that
  should be corrected regardless.

Update the `else` branch:

```python
else:
    is_permanent_failure = (
        error_data.get('requiresReauth') or
        'invalid_grant' in error_lower or
        'unauthorized_client' in error_lower or            # NEW — covers Atlassian's exact error code
        'refresh_token is invalid' in error_lower or       # NEW — exact Atlassian phrasing (underscore)
        'refresh token is invalid' in error_lower or       # existing (space) — keep for safety
        'token has been revoked' in error_lower or
        'token was globally revoked' in error_lower or     # NEW — exact Atlassian phrasing
        'token has been expired' in error_lower
    )
```

#### Test updates that go with Layer 3

**File:** [python-desktop-app/tests/test_auth_refresh_classification.py](../python-desktop-app/tests/test_auth_refresh_classification.py)

Add tests that simulate a server response **without** `errorCode` (i.e., the older
text-matching path), with each of the following error strings, asserting that
`is_permanent_failure` ends up `True`:

1. `Token refresh failed: refresh_token is invalid` (Atlassian's actual response)
2. `Token refresh failed: Token was globally revoked`
3. Body containing `"error": "unauthorized_client"` with no `errorCode`

---

## 5. Operational steps (after Layers 1–3 ship)

1. Deploy the ai-server change. Wait for the next burst of `[Auth] Token refresh error`
   entries.
2. The enriched log line will now show the source IP and refresh-token suffix for each
   failing user. Identify affected users.
3. Inform each affected user to **sign out from the desktop tray menu and sign back in**.
   That triggers a fresh OAuth consent and mints a new refresh-token chain.
4. After Layer 3 ships and desktop installs auto-update, the tray notification will fire
   immediately on the first failure rather than after 5 retries, so step 3 will normally
   be initiated by the user without operator intervention.

---

## 6. Acceptance criteria

1. The error log line emitted from `exports.refreshToken` includes (a) Atlassian HTTP
   status, (b) Atlassian OAuth error code, (c) request ID, (d) source IP, (e) refresh-token
   last-8-character suffix. **(Layer 1)**
2. Given Atlassian responds with HTTP 403 and body `{"error":"unauthorized_client",
   "error_description":"refresh_token is invalid"}`, the server returns HTTP 401 with
   `requiresReauth: true` and `errorCode: 'OAUTH_REAUTH_REQUIRED'`. **(Layer 2)**
3. Given Atlassian responds with HTTP 403 and body `{"error":"invalid_grant",
   "error_description":"Token was globally revoked"}`, the server returns HTTP 401 with
   `requiresReauth: true` and `errorCode: 'OAUTH_REAUTH_REQUIRED'`. **(Layer 2)**
4. Given Atlassian responds with HTTP 503 or a network error, the server still returns the
   original transient classification (`errorCode: 'OAUTH_TEMPORARY_FAILURE'`, no
   `requiresReauth`). **(Layer 2)**
5. Given a desktop client receives a server response whose body contains
   `"refresh_token is invalid"` and no explicit `errorCode`, the client classifies the
   failure as permanent on the **first** call (sets `_refresh_token_invalid = True` once
   the consecutive-failure threshold is reached or `requiresReauth` is present). **(Layer 3)**
6. After Layer 2 deploy, the desktop app shows the "please sign in again" tray
   notification on the **first** refresh failure for a revoked token, not after 5
   retries. **(Layer 2 + existing client `OAUTH_REAUTH_REQUIRED` handling)**
7. The unit tests in `ai-server/tests/controllers/auth-controller.test.js` and
   `python-desktop-app/tests/test_auth_refresh_classification.py` are updated to match
   criteria 2–5 and all pass.

---

## 7. Risk and rollback

| Risk | Mitigation |
|---|---|
| Layer 2 reclassifies a genuinely transient error as permanent, signing a user out unnecessarily. | The new classifier triggers **only** on the exact OAuth error codes `invalid_grant` and `unauthorized_client`. Network errors, 5xx, malformed requests, and HTTP 400 without one of those codes still fall through to the transient branch. |
| Layer 3 over-matches on Atlassian phrasing that may change. | Each new substring is taken from Atlassian's published error responses. If Atlassian later changes the wording, Layer 2 (error-code-based) catches it server-side; Layer 3 is a fallback for old clients only. |
| Enriched log line accidentally leaks sensitive data. | Only the last 8 characters of the refresh token are logged, the rest of the token is not. The log sanitizer already redacts full token strings — this change passes a deliberately small slice. Verify no PII is added in the merged change. |

Rollback for each layer is a single-file revert with no DB / schema / manifest impact.

---

## 8. Out of scope

- Changing the desktop client's retry counts, backoff timings, or 30-minute grace period.
  Those are correct as a defense-in-depth and should be preserved.
- Changing Atlassian OAuth scopes, client configuration, or the OAuth client itself.
- Adding a server-side cache or pre-validation of refresh tokens. There is no Atlassian
  API that validates a refresh token without consuming a rotation; any pre-validation
  would itself burn the token.
- Changing the Forge frontend auth path. The Forge app does not call this endpoint and is
  not involved in this bug.
- Re-architecting `formatAtlassianError` or the surrounding helpers. The only behavioral
  change inside that helper would be to also log `error.response?.status`, which is
  handled by Layer 1.

---

## 9. References

- Source files: [ai-server/src/controllers/auth-controller.js:499-563](../ai-server/src/controllers/auth-controller.js#L499-L563),
  [python-desktop-app/desktop_app.py:2214-2419](../python-desktop-app/desktop_app.py#L2214-L2419)
- Existing test files: [ai-server/tests/controllers/auth-controller.test.js](../ai-server/tests/controllers/auth-controller.test.js),
  [python-desktop-app/tests/test_auth_refresh_classification.py](../python-desktop-app/tests/test_auth_refresh_classification.py),
  [python-desktop-app/test_session_management.py](../python-desktop-app/test_session_management.py)
- Earlier related plan: [ai-server/FIT_AUTH_FIX_PLAN.md](../ai-server/FIT_AUTH_FIX_PLAN.md)
  (Step 4 there flagged this as a separate follow-up — this document is that follow-up.)
- Atlassian official docs: [Implementing the Refresh Token Flow](https://developer.atlassian.com/cloud/oauth/getting-started/refresh-tokens/)
- Atlassian community thread on `unauthorized_client` semantics:
  [Why does my refresh token become invalid after using another refresh token in the same OAuth app?](https://community.atlassian.com/forums/Jira-questions/Why-does-my-refresh-token-become-invalid-after-using-another/qaq-p/3058598)

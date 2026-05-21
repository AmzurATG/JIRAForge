# Session Expiration Hardening (Desktop + AI Server)

## Problem
A subset of desktop users receives repeated "Authentication Expired" notifications and is forced to re-login, including cases where the failure may be transient or ambiguous. The current refresh failure classification is partially string-based and treats some server responses as permanently invalid too aggressively.

## Root Cause / Context
- Desktop refresh classification in `python-desktop-app/desktop_app.py` determines when `_refresh_token_invalid` is set.
- AI server refresh endpoint in `ai-server/src/controllers/auth-controller.js` returns `requiresReauth` for 401, but desktop still relies heavily on message parsing and status-based heuristics.
- Missing stable machine-readable error codes makes client behavior brittle.

## Proposed Solution
1. AI server: add stable `errorCode` values on refresh failures.
   - `OAUTH_REAUTH_REQUIRED` for true re-auth required conditions.
   - `OAUTH_TEMPORARY_FAILURE` for transient/unknown failures.
2. Desktop: classify permanent failures primarily from server `errorCode` and known OAuth revocation signals.
   - Keep compatibility with legacy payloads using existing checks.
   - Remove unconditional `HTTP 403 => permanent failure` behavior.
3. Preserve existing failure window behavior (5 permanent failures within 10 minutes) and 30-minute auto-recovery grace.

## Acceptance Criteria
1. AI server returns `errorCode: OAUTH_REAUTH_REQUIRED` with `requiresReauth: true` for 401 token refresh failures.
2. AI server returns `errorCode: OAUTH_TEMPORARY_FAILURE` and does not set `requiresReauth` for 400/403/5xx refresh failures unless explicitly re-auth required.
3. Desktop marks permanent refresh failure when `errorCode == OAUTH_REAUTH_REQUIRED`.
4. Desktop does not mark permanent refresh failure solely because of HTTP 403 when `errorCode` is not re-auth required.
5. Existing refresh-success behavior remains unchanged: tokens are updated and failure counters/flags reset.

## Out of Scope
- Multi-device canonical refresh-token persistence in server database.
- UI redesign of notification copy or workflows.
- Broader auth architecture refactor beyond refresh classification and error contracts.

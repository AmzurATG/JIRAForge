# Reauth Recovery and Stale Token Purge Plan

Date: 2026-06-20
Owner: Desktop App Team
Status: Proposed
Priority: P0
Scope: python-desktop-app, ai-server (minor), support runbook

## 1) Problem Summary

A subset of Linux users enters a persistent broken state:

1. Desktop app starts and loads cached tokens from secure storage.
2. AI server returns `OAUTH_REAUTH_REQUIRED` (refresh token permanently invalid).
3. App marks refresh token invalid and cannot mint Supabase JWT.
4. Batch uploads are restored to local SQLite and never reach DB while auth remains invalid.
5. Reinstall does not help because the same dead token is reloaded from secure storage.

Observed in logs:
- Initial runs can still show heartbeat/status updates before token expiry.
- Later runs repeatedly fail token refresh and Supabase JWT setup.
- Batch uploader repeatedly restores sessions to SQLite for retry.

Impact:
- User appears logged in but data does not flow to cloud.
- Support sees "no records in DB" and treats it as app failure.
- Retry loops add noise and delay clear user action.

## 2) Root Cause

Primary root cause:
- Permanently invalid Atlassian refresh token is persisted and repeatedly re-used across app restarts/reinstall.

Contributing factors:
- Reauth notification is suppressed during grace window, delaying recovery path.
- Invalid session state does not always force an immediate, explicit reauth flow.
- User-level activity data uses 5-minute batch upload, which can hide early collection state from operators.

## 3) Desired End State

When the server says `OAUTH_REAUTH_REQUIRED`, the app must immediately switch to a deterministic recovery state:

1. Purge stale auth artifacts that can re-poison restart.
2. Pause cloud sync attempts (no noisy retries).
3. Preserve all local pending activity safely.
4. Force a clear interactive reauth journey now (not after grace delay).
5. Resume Supabase JWT setup and flush backlog immediately after successful reauth.

## 4) Best Fix (Recommended)

Implement a strict "Permanent Auth Failure State Machine" in desktop app.

### 4.1 State Machine

States:
- AUTH_OK
- AUTH_TEMP_FAILURE (retry allowed)
- AUTH_REAUTH_REQUIRED (terminal until user reauth)

Transition rules:
- `OAUTH_REAUTH_REQUIRED` -> AUTH_REAUTH_REQUIRED immediately.
- While AUTH_REAUTH_REQUIRED:
  - Do not call refresh token endpoint in background loops.
  - Do not attempt Supabase JWT refresh.
  - Do not claim logged-in heartbeat success.
  - Keep local capture active if product policy allows, but queue only locally.

Recovery:
- Successful OAuth callback -> AUTH_OK.
- Immediately set Supabase JWT and flush pending batches.

### 4.2 Purge Behavior on Permanent Failure

On first transition to AUTH_REAUTH_REQUIRED:

1. Purge only stale remote auth credentials from secure storage:
   - access_token
   - refresh_token
   - expires_at
   - supabase_token
   - supabase_token_expires_at
2. Preserve non-sensitive metadata needed for UX (if required):
   - organization_id cache
   - basic display preferences
3. Set an explicit durable flag: `requires_interactive_reauth=true`.
4. Record reason code and timestamp for diagnostics.

Important:
- Do not purge local offline queue DB.
- Do not purge user-generated configuration.

### 4.3 UX and Routing

When in AUTH_REAUTH_REQUIRED:

1. Force `/` and tray fallback to route to `/login`.
2. Show a prominent banner on login page:
   - "Session expired or revoked. Please sign in again to resume cloud sync."
3. Trigger browser launch to `/login` immediately on first terminal failure.
4. Disable suppression for terminal failures (suppression is only for temporary failures).

### 4.4 Sync and Batch Logic Hardening

While AUTH_REAUTH_REQUIRED:
- Batch uploader should skip cloud insert attempts and keep sessions local without retry storm.
- Offline sync thread should back off to low-frequency check and avoid token refresh calls.
- Emit one periodic status log (for example every 5 minutes), not per loop.

After successful reauth:
- Initialize Supabase client JWT once.
- Run immediate `upload_activity_batch()`.
- Run immediate offline screenshot sync.
- Send heartbeat with `desktop_logged_in=true`.

### 4.5 Server Contract (Minor)

Keep and enforce explicit terminal contract:
- `errorCode=OAUTH_REAUTH_REQUIRED` must remain stable.
- Include clear text reason in response payload.

Optional hardening:
- Add `isTerminal=true` field to avoid string-based logic drift.

## 5) Implementation Plan

## Phase 1 - Desktop Auth Core

Files:
- `python-desktop-app/desktop_app.py`
- `python-desktop-app/auth/secure_storage.py`

Tasks:
1. Add explicit auth state enum or equivalent flags.
2. Centralize terminal-failure handler:
   - set state AUTH_REAUTH_REQUIRED
   - purge stale remote tokens
   - persist `requires_interactive_reauth`
   - write diagnostic event once
3. Ensure all token-refresh entry points short-circuit in terminal state.

Exit criteria:
- No refresh attempts occur while terminal state is active.

## Phase 2 - UX and Navigation

Files:
- `python-desktop-app/desktop_app.py` (routes, tray fallback, notification flow)

Tasks:
1. Force login route if terminal state.
2. Show session-expired banner and reason on login page.
3. Immediate browser open for terminal state (Linux and non-Linux).
4. Disable grace suppression for terminal state notifications.

Exit criteria:
- User always gets a deterministic path to reauth within seconds.

## Phase 3 - Sync Thread and Batch Uploader

Files:
- `python-desktop-app/desktop_app.py`

Tasks:
1. Gate heartbeat/sync/batch attempts behind auth state.
2. Keep local queue intact and avoid repeated failed inserts.
3. On auth recovery, perform immediate backlog flush sequence.

Exit criteria:
- No repeated "JWT refresh failed" storms during terminal state.
- Backlog flushes automatically after reauth.

## Phase 4 - Server Contract and Diagnostics

Files:
- `ai-server/src/controllers/auth-controller.js`

Tasks:
1. Ensure terminal response contains stable explicit fields.
2. Add structured logging fields for correlation:
   - user_id (if available)
   - errorCode
   - reason
   - request_id

Exit criteria:
- Desktop logic has unambiguous machine-readable terminal signal.

## 6) Test Plan

### 6.1 Unit Tests (Desktop)

Add/update tests for:
1. `OAUTH_REAUTH_REQUIRED` transitions to AUTH_REAUTH_REQUIRED in one step.
2. Terminal state purges stale tokens but preserves offline queue.
3. Refresh paths short-circuit while terminal state is active.
4. `/` and tray fallback route to `/login` in terminal state.
5. Terminal notifications are not grace-suppressed.
6. Successful callback clears terminal state and triggers immediate sync.

### 6.2 Integration Tests

1. Simulate invalid refresh token response from server.
2. Verify no DB writes attempted during terminal state.
3. Verify local sessions accumulate in SQLite.
4. Perform reauth and verify backlog drains to cloud.

### 6.3 Manual QA Matrix

Platforms:
- Ubuntu GNOME Wayland
- Ubuntu GNOME X11
- Windows

Scenarios:
1. Fresh install with valid token.
2. Restart with revoked token.
3. Reinstall with stale secure-storage token.
4. Reauth recovery with pending local backlog.

## 7) Observability and Supportability

Add concise diagnostics:
- `auth_state_transition` event with from/to/reason.
- `terminal_auth_purge_done` event.
- `sync_paused_requires_reauth` periodic event (rate-limited).
- `reauth_success_backlog_flush_started/completed` events.

Support runbook additions:
1. If no cloud logs but app running, check auth state first.
2. Confirm terminal auth code in logs.
3. If stuck, use forced reauth command from tray/admin page.

## 8) Rollout Strategy

1. Ship desktop change first (most impact).
2. Ship server contract hardening in parallel or next patch.
3. Release as hotfix build.
4. Validate with one internal revoked-token test account before broad rollout.

## 9) Risks and Mitigations

Risk: accidental data loss during token purge.
- Mitigation: purge only auth credentials, never local queue DB.

Risk: aggressive routing to login annoys users in temporary outage.
- Mitigation: only trigger strict flow for explicit terminal code.

Risk: duplicate uploads after reauth flush.
- Mitigation: keep existing batch timestamp/idempotency checks.

## 10) Acceptance Criteria

1. Reinstall with stale token no longer loops silently.
2. Terminal auth failure surfaces reauth UI within 10 seconds.
3. No repeated Supabase JWT refresh attempts in terminal state.
4. Offline/local queue preserved through failure and recovery.
5. After reauth, pending records begin syncing without manual restart.
6. Support can identify auth terminal state from logs in under 1 minute.

## 11) Out of Scope

1. Full OAuth redesign.
2. Changing 5-minute batch interval policy.
3. New backend storage model for activity records.

## 12) Suggested Branch and Work Items

Branch: `fix/desktop-terminal-auth-recovery`

Work items:
1. Implement auth terminal state machine and purge handler.
2. Implement UX and routing hardening.
3. Implement sync/batch gates and recovery flush.
4. Add tests and update runbook.
5. Add server contract hardening (optional but recommended).

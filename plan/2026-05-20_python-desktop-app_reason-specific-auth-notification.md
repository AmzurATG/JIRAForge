# Reason-Specific Auth Notification (Desktop)

## Problem
Users currently see a generic "Authentication Expired" notification, even when the underlying refresh failure is temporary and auto-recoverable. This causes unnecessary confusion and re-login attempts.

## Root Cause / Context
- Desktop notification path uses `_show_reauth_notification()` with a fixed title/body.
- Refresh flow now receives machine-readable `errorCode` (`OAUTH_REAUTH_REQUIRED`, `OAUTH_TEMPORARY_FAILURE`), but notification text does not adapt to this signal.

## Proposed Solution
1. Extend `_show_reauth_notification()` to accept `reason_code`.
2. Use reason-specific title/message:
   - `OAUTH_REAUTH_REQUIRED` (or unknown legacy permanent failures): ask user to log in again.
   - `OAUTH_TEMPORARY_FAILURE`: inform user sync is temporarily paused and automatic retry is in progress.
3. Keep independent throttle keys for temporary vs re-auth notifications (15 minutes each) to prevent spam while preserving important alerts.
4. Pass `reason_code` from sync thread based on `auth_manager._last_refresh_error_code`.

## Acceptance Criteria
1. Calling `_show_reauth_notification('OAUTH_TEMPORARY_FAILURE')` produces a temporary-retry message and does not instruct login.
2. Calling `_show_reauth_notification('OAUTH_REAUTH_REQUIRED')` keeps the existing login-required message.
3. Existing callers without reason code still show login-required behavior (backward compatibility).
4. Sync-thread re-auth notification path passes through the latest refresh error code.

## Out of Scope
- New UI surfaces beyond Windows toast notifications.
- Server-side token canonicalization across devices.
- Any change to retry intervals or refresh-window thresholds.

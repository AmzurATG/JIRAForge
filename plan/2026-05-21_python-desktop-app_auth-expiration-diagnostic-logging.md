# Auth Expiration Diagnostic Logging

## Problem
When users report authentication/session expiration issues, the desktop log file does not currently record enough structured context to distinguish revoked refresh tokens, temporary server/network failures, grace-period behavior, or which notification path was shown.

## Root Cause / Context
- `AtlassianAuthManager.refresh_access_token()` prints generic success/failure lines but does not emit root-cause-grade diagnostics to the application logger.
- `_show_reauth_notification()` records only a generic message and does not log whether the app showed a temporary retry notice or a re-login-required notice.
- Because the file logger captures the desktop app logger and stdout/stderr, adding targeted auth diagnostics here makes the user-side `%LOCALAPPDATA%\TimeTracker\logs\timetracker.log` actionable for support.

## Proposed Solution
1. Add a small auth diagnostic logging helper in `desktop_app.py` that writes sanitized, structured key/value context through the app logger.
2. Log refresh-failure diagnostics with fields including HTTP status, server `errorCode`, `requiresReauth`, permanent/transient classification, fail counter, grace timing, and next action.
3. Log refresh-success recovery context and exception-based refresh failures.
4. Log auth notification display/suppression with the reason code and notification type.

## Acceptance Criteria
1. Refresh failures write a log entry containing enough fields to distinguish `OAUTH_REAUTH_REQUIRED` vs `OAUTH_TEMPORARY_FAILURE`.
2. When the invalid flag/grace logic leads to a user-facing auth notification, the log records which notification path was shown.
3. Successful refresh clears prior-failure context and writes a recovery log entry.
4. No token values or secrets are logged.

## Out of Scope
- Changing retry intervals or auth-state behavior.
- Server-side auth logging changes.
- Exporting logs from the UI.

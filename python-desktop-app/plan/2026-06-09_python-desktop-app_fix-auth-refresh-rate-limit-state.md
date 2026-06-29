# Python Desktop App: Fix Auth Refresh Rate-Limit State

## Problem
Manual tray action "Test Description Quality Nudges" does not open the popup even when AI server refresh runs successfully. Desktop logs show:
- `'AtlassianAuthManager' object has no attribute '_last_token_refresh_time'`
- Supabase token retrieval failures and `missing-token` trigger results

## Root Cause / Context
`AtlassianAuthManager.refresh_access_token()` reads rate-limit fields (`_last_token_refresh_time`, `_token_refresh_min_interval`) but those fields are not initialized on `AtlassianAuthManager.__init__`. The code then throws before refresh can complete, which prevents Supabase JWT minting and downstream DQ trigger/poll calls.

## Proposed Solution
1. Initialize refresh rate-limit fields in `AtlassianAuthManager.__init__`.
2. Add a defensive initializer in `refresh_access_token()` to self-heal instances missing these fields (for partially initialized/test-created instances).
3. Add regression test coverage proving `refresh_access_token()` does not crash when those fields are absent.

## Acceptance Criteria
1. `refresh_access_token()` never raises `AttributeError` for missing `_last_token_refresh_time`.
2. Manual DQ trigger path no longer returns `missing-token` due to this attribute crash.
3. New regression test fails before fix and passes after fix.

## Out Of Scope
- Server-side DQ score computation or candidate selection changes.
- Popup UI rendering/layout changes.
- OAuth credential policy or refresh endpoint semantics.

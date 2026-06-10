# Fix first-login OAuth failure due to placeholder env leakage

## Problem
After first installation, the desktop app sometimes redirects Atlassian OAuth with placeholder values (for example placeholder `client_id`), causing Atlassian to return `invalid_request` (`failed to retrieve client`). Login only succeeds after reboot.

## Root cause / context
The frozen desktop executable currently loads `.env` at module import. During installer-first-run execution from a dev/release folder that contains template `.env`, placeholder values are loaded into process environment. The newly launched installed process inherits those values and builds OAuth URL with invalid `ATLASSIAN_CLIENT_ID` and other placeholder host values.

## Proposed solution
1. Do not load `.env` automatically when running as a frozen executable.
2. Add defensive placeholder filtering in `get_env_var` so obvious template values are treated as unset and fallback continues to runtime/embedded defaults.
3. Add tests that validate placeholder values are ignored and valid runtime values still work.

## Acceptance criteria
1. In frozen mode, placeholder env values do not override embedded production OAuth client ID.
2. `get_auth_url()` uses non-placeholder client ID even when process env contains template placeholder values.
3. Non-placeholder env values are still honored.
4. Unit tests cover placeholder filtering behavior.

## Out of scope
- Changing Atlassian OAuth scopes or callback APIs.
- Changing AI server token exchange logic.
- Packaging/deployment pipeline changes outside this app runtime config handling.

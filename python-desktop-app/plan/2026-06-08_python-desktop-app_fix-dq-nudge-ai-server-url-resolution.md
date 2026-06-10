# Fix DQ nudge popup trigger using placeholder AI server URL

## Problem
Clicking tray action "Test Description Quality Nudges..." does not open the popup even when triggered manually.

## Root cause / context
DQ nudge modules (`poller`, `preferences`, `ack_client`) resolve AI server URL from `os.environ['AI_SERVER_URL']` at import time. In installer/update flows, placeholder inherited env values (for example `http://your-ai-server-url:3001`) can be present. DQ requests then fail DNS resolution and return no nudges, so popup never opens.

## Proposed solution
1. Centralize DQ AI server URL resolution with precedence:
   - explicit arg
   - authenticated `auth_manager.ai_server_url`
   - env var only if not placeholder
   - hardcoded production default
2. Apply resolver in DQ poller, preferences, and ack client.
3. Add tests proving placeholder env is ignored and auth_manager URL is used.

## Acceptance criteria
1. Manual DQ trigger uses `auth_manager.ai_server_url` when available.
2. Placeholder env `your-ai-server-url` is ignored.
3. DQ preference refresh and ack use non-placeholder URL.
4. Tests cover URL resolution fallback rules.

## Out of scope
- DQ popup UI layout/styling changes.
- AI server endpoint contract changes.
- Tray menu behavior changes beyond URL routing fix.

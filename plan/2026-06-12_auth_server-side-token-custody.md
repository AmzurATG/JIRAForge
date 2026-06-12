# Server-Side Token Custody — Eliminating Forced Re-Logins in the Desktop App

**Date:** 2026-06-12
**Components:** ai-server, python-desktop-app
**Status:** Proposed

---

## Summary

Desktop users are intermittently forced to log in again — most recently on 2026-06-12, when a laptop going to sleep during a routine session renewal permanently invalidated the session. The fix is to move session-renewal credentials off user laptops and onto the AI server, where renewals happen over a stable connection that cannot be interrupted by sleep or Wi-Fi drops. After this change, a user logs in once and stays logged in; re-login is only ever needed for three unavoidable cases set by Atlassian: 90 days of total inactivity, a password change, or the user revoking the app's access.

## Problem

Atlassian requires single-use, rotating renewal credentials ("refresh tokens"): each renewal burns the old credential and issues a new one. Today that credential lives on the user's laptop and travels over the user's network on every renewal (about once per hour of use). If the laptop sleeps or loses Wi-Fi at the wrong moment, the new credential is lost in transit while the old one is already burned. Atlassian allows a 10-minute window to retry — but a sleeping laptop cannot retry in time. Result: a permanently dead session and a forced re-login.

A secondary defect compounds this: when the session dies, the server misclassifies the failure as temporary, so the app shows "Sync will retry automatically" notifications every 15 minutes indefinitely instead of asking the user to log in once.

Both behaviors were confirmed end-to-end in the 2026-06-12 incident investigation (desktop logs, production database, Atlassian documentation, and Atlassian staff statements).

## Why this design

- The AI server already performs every Atlassian token operation today (login exchange and renewal both go through it). This plan changes only **where the renewal credential is stored** — server instead of laptop.
- Atlassian staff guidance states rotating refresh tokens break when shared across processes or devices; the prescribed shape is a single owner performing renewals. A server-side store with serialized renewals is exactly that.
- Backend credential custody is the industry-standard pattern for this situation (IETF OAuth guidance, Auth0/Atlassian reuse-interval design assumptions).
- If the server ever loses a renewal response (rare on a datacenter connection), it retries within seconds — inside Atlassian's 10-minute window — and self-heals.

## How it works after the change

1. **Login (unchanged for the user):** browser consent as today. The server receives the renewal credential and stores it encrypted in the database. It never leaves the server again.
2. **The desktop receives:** a 1-hour Atlassian access token (as today) plus a long-lived **device session token** issued by our server. The device token does not rotate, survives sleep indefinitely, and can be revoked server-side per device.
3. **Hourly renewal:** the desktop presents its device token; the server renews with Atlassian centrally and returns a fresh access token. Nothing fragile ever travels over the user's network.
4. **Multiple devices:** all of a user's devices share the single server-held credential through their own device tokens. A second-device login replaces the stored credential; both devices keep working.
5. **Existing users:** migrated automatically — the next time an existing installation renews, the server takes custody and issues a device token. No forced re-login for the upgrade.

---

## Phases

### Phase 0 — Immediate relief (independent of the rest; ship first)
- Fix the server's error classification so a permanently dead session is reported as such (`OAUTH_REAUTH_REQUIRED`), ending the misleading retry notifications. One clear "Please log in again" prompt instead.
- Desktop: after the machine wakes from sleep, wait for network/DNS to be available before any authentication call (wake events now work as of the 2026-06-10 build).
- Desktop notification text: distinguish "temporary issue, retrying" from "login required."

### Phase 1 — Validation gate (must pass before Phase 2 begins)
- Using a disposable test Atlassian account: authorize the app twice and verify what happens to the first credential chain when a second authorization is made. Atlassian does not document this; the migration logic must follow the observed rule, not an assumption. (~30 minutes; touches no real users.)
- Sign off design parameters: device-token lifetime (proposed 180 days), encryption method for stored credentials, one-credential-per-user model.

### Phase 2 — Server changes (ai-server)
- Database migration (delivered as a SQL file for review and manual application, per team process): encrypted storage for the per-user renewal credential, plus a device-sessions table (device, user, token hash, issued/last-seen/revoked).
- Login endpoint: store the renewal credential server-side; return access token + device token.
- New endpoint: exchange a valid device token for a fresh access token (renewing with Atlassian centrally when needed; renewals serialized per user; new credential persisted before responding; automatic same-credential retry within the 10-minute window on network failure).
- Legacy renewal endpoint kept fully working for older desktop versions — and doubles as the seamless migration path (takes custody, returns a device token).
- Device revocation endpoint (logout / lost device).

### Phase 3 — Desktop changes (python-desktop-app)
- Store the device token in the existing secure keyring slot in place of the renewal credential.
- Replace the renewal logic with a single call to the new endpoint. The rotation-failure machinery (failure counters, invalid flags, 30-minute grace timers) is removed rather than reworked.
- A genuine "login required" response shows one clear prompt and stops background retries.

### Phase 4 — Rollout
- Deploy server first — fully backward compatible; existing installations are unaffected, then migrate seamlessly on their next renewal.
- Release desktop update (version bump required for auto-update distribution).
- Monitor for two weeks: renewal failure rate, forced re-login count, migration completion rate.
- Rollback path: legacy endpoint remains; desktop versions ≤ 1.4.7 continue to function throughout.

Tests are written first and mapped one-to-one to the acceptance criteria below, per the repository's spec-driven workflow.

---

## Acceptance criteria

1. A laptop sleeping for any duration during or immediately after a session renewal does not require re-login.
2. From the new desktop version onward, renewal credentials are never sent to or stored on user devices.
3. Existing logged-in users upgrade with no re-login (automatic custody migration verified).
4. A user active on two devices remains logged in on both indefinitely (subject only to Atlassian's 90-day total-inactivity rule).
5. A genuinely dead session produces exactly one "Please log in again" prompt within one minute — no retry loops, no repeating notifications.
6. Desktop versions ≤ 1.4.7 continue to work unchanged against the updated server.
7. Stored credentials are encrypted at rest and unreachable through any client-facing API or database policy.
8. The repeated-authorization behavior observed in the Phase 1 test is documented in this file.

## Out of scope

- The Google-account integration token flow (mirrors this pattern; migrate separately later).
- Forge app authentication (entirely separate mechanism).
- Atlassian's 90-day inactivity limit (platform rule; cannot be changed by any client design).
- Correction of historical activity records.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Central credential store becomes a higher-value target | Encrypted at rest; accessible only via the server's service role; never exposed through client APIs; per-device revocation limits blast radius |
| Server outage blocks renewals | No regression — renewals already require the server today; the 1-hour access token buffers short outages; offline capture/queue behavior is unchanged |
| Undocumented Atlassian behavior on repeated authorizations | Phase 1 gate resolves it empirically before any dependent code is written |
| Migration defect strands a user | Legacy endpoint preserved; staged rollout; per-user migration is a single idempotent step |

## Estimated effort

| Phase | Estimate |
|---|---|
| Phase 0 | 1 day including tests |
| Phase 1 | Half a day |
| Phase 2 | 2–3 days including tests |
| Phase 3 | 2–3 days including tests |
| Phase 4 | 1 day plus a two-week monitoring window |

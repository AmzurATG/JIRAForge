# Enhancement #13 — Scheduled Description-Quality Notifications

> **Status:** Planning only. No code changes in this commit.
> **Parent spec:** [plan/2026-06-04_forge-app_my-focus-description-quality.md](../../plan/2026-06-04_forge-app_my-focus-description-quality.md)
> **Depends on:** [11_MY_FOCUS_QUALITY_COLUMN.md](./11_MY_FOCUS_QUALITY_COLUMN.md), [12_IMPROVE_REDIRECT_FLOW.md](./12_IMPROVE_REDIRECT_FLOW.md)
>
> **2026-06-04 update:** Adds a third notification channel — a **centred
> desktop popup** delivered through the existing
> [python-desktop-app](../../python-desktop-app/desktop_app.py) — and a
> viability analysis of that channel.

---

## 1. Goal

Every ~30 minutes, proactively remind each user about their **assigned**
open Jira tickets whose **cached description quality score is < 80**.
Reminders must:

- Acknowledge the specific tickets needing attention (issue key + summary
  + score).
- Surface inside Jira **and** on the user's desktop, so the prompt is
  visible whether or not Jira is the active window.
- Provide a one-click path back to the Improve-with-AI flow described in
  [12_IMPROVE_REDIRECT_FLOW.md](./12_IMPROVE_REDIRECT_FLOW.md).

## 2. Cadence — The 30-Minute Constraint

### 2.1 Forge scheduled-trigger limitation

The Forge `scheduledTrigger.interval` field accepts only `hour`, `day`,
and `week` in `nodejs22.x` runtime. **There is no native 30-minute
interval.**

### 2.2 Approximation strategy

Two hourly triggers, naturally phased ~30 minutes apart, both invoking
the same handler:

```yaml
scheduledTrigger:
  - key: description-quality-nudge-a
    function: descriptionQualityNudge
    interval: hour
  - key: description-quality-nudge-b
    function: descriptionQualityNudge
    interval: hour
```

Forge does not guarantee absolute clock time — only cadence. Two
independently-registered hourly triggers are scheduled at different
offsets within the hour, giving a best-effort ~30-minute spread. If
Forge later supports `interval: 30-minute`, collapse to one trigger.

### 2.3 Idempotency

Because two triggers share a handler, the handler **must** be idempotent:

- Per-(user, issue, channel) dedupe (§6) so the same notification is not
  duplicated across the two triggers.
- A short-lived KVS lock (`scheduler-lock/dq-nudge`, 60 s TTL) so two
  near-simultaneous fires do not duplicate the scan.

## 3. Notification Channels

V1 ships **two channels in parallel**: Jira in-product notification and
desktop popup. Email is V2.

### 3.1 Channel A — Jira in-product notification (bell icon)

Per low-quality ticket per nudge:

```http
POST /rest/api/3/issue/{issueKey}/notify
Content-Type: application/json
{
  "subject": "Improve description: {{issueKey}}",
  "textBody": "Your assigned ticket {{issueKey}} has a description quality score of {{score}}/100. Click to improve it: {{appLink}}",
  "htmlBody": "<p>Your assigned ticket <b>{{issueKey}}</b> ({{summary}}) has a quality score of <b>{{score}}/100</b>.</p><p><a href=\"{{appLink}}\">Open in Time Tracker</a></p>",
  "to": { "assignee": true }
}
```

- Sent as the app user with existing `write:jira-work` scope.
- One REST call per (user, issue), capped per §5.

### 3.2 Channel B — Desktop popup (NEW)

The existing python-desktop-app
([python-desktop-app/desktop_app.py](../../python-desktop-app/desktop_app.py))
already runs as a Windows tray application and authenticates the same
end-user that Jira does. We extend it to **poll for pending nudges** and
display a centred modal popup when any are returned.

#### 3.2.1 Polling vs server-push — choice & rationale

The desktop app already has an authenticated polling loop that talks to
ai-server. There is no existing push channel (no WebSocket, no
FCM-equivalent), and adding one is large-scope work.

| Approach | Latency | New infra required | Decision |
|---|---|---|---|
| Add WebSocket / SSE channel from ai-server to desktop | Real-time | New connection lifecycle, NAT/proxy concerns, reconnect logic | Rejected for V1 |
| Push via OS notification service (Windows Toast XML) | Real-time | Toast XML packaging is fragile across Windows versions and only supports a small banner — cannot show a centred modal with multiple tickets | Rejected |
| **Periodic poll from desktop app** | Up to one poll interval | None (reuses existing HTTP client + JWT auth) | **Selected** |

Polling cadence: **every 5 minutes** while the desktop app is in the
foreground / unlocked, **every 15 minutes** while the user is idle (the
existing idle detector — see
[python-desktop-app/IDLE_DETECTION_GUIDE.md](../../python-desktop-app/IDLE_DETECTION_GUIDE.md)).
Total poll volume capped at ≤ 12/hr/user even at the tightest cadence.

#### 3.2.2 Endpoint contract

```http
GET /api/desktop/description-quality-nudges
Authorization: Bearer <jwt>

200 OK
{
  "nudges": [
    {
      "id": "abc-123",
      "issueKey": "FEEDBACK-83",
      "summary": "Login Form UX Issues - Placeholder Text Visible",
      "score": 38,
      "issueUrl": "https://amzur-itracker.atlassian.net/browse/FEEDBACK-83#dq=improve",
      "appUrl":   "https://amzur-itracker.atlassian.net/jira/your-work?focusApp=...&issueKey=FEEDBACK-83#mf-improve",
      "createdAt": "2026-06-04T10:30:00Z"
    }
  ],
  "showModal": true,
  "ackEndpoint": "/api/desktop/description-quality-nudges/ack"
}
```

Server-side rules:

- Endpoint reads from `description_quality_notifications` (§6) where
  `channel = 'desktop'` and `acknowledged_at IS NULL`.
- Nudge rows are created **only by the scheduler** (§5). Polling does
  not trigger creation.
- `showModal: true` only when `nudges.length > 0`.

#### 3.2.3 Acknowledgement

```http
POST /api/desktop/description-quality-nudges/ack
{
  "nudgeIds": ["abc-123"],
  "action": "viewed" | "opened-in-jira" | "dismissed" | "snoozed",
  "snoozeUntil": "2026-06-04T15:00:00Z"   // only when action == "snoozed"
}
```

- Sets `acknowledged_at = now()` and `ack_action = …` on the row(s).
- For `snoozed`, also sets `snooze_until` so the scheduler does not
  re-create a nudge for the same (user, issue) before that timestamp.

#### 3.2.4 Popup UX

Implemented as a **tkinter `Toplevel` window** (the desktop app already
uses tkinter — see [desktop_app.py](../../python-desktop-app/desktop_app.py)),
with these properties:

- Centred on the **primary monitor** using `winfo_screenwidth/height`.
- Always-on-top **without** stealing focus
  (`attributes('-topmost', True)`; do not call `focus_force()`, so the
  user's typing is not interrupted).
- Modal within the desktop app process (does not block other Windows
  apps).
- Title: **"Time Tracker — Improve your ticket descriptions"**.
- Body:
  > Hi {{userName}}, the following assigned tickets need a clearer
  > description (quality < 80%). Improving them helps your reviewers
  > and avoids back-and-forth.
- A scrollable list of tickets, each row:

  ```
  ┌────────────────────────────────────────────────────────────┐
  │  FEEDBACK-83  Login Form UX Issues — Placeholder Text…     │
  │  Score: 38 / 100   [ Improve in Jira → ]   [ Snooze 1h ▼ ] │
  └────────────────────────────────────────────────────────────┘
  ```

- Footer buttons: `Open My Focus`, `Dismiss all`, `Don't show again`.
- "Improve in Jira →" opens `issueUrl` in the user's default browser via
  `webbrowser.open(...)` — landing on the Jira issue with `#dq=improve`,
  which auto-starts the existing Improve flow per
  [12_IMPROVE_REDIRECT_FLOW.md](./12_IMPROVE_REDIRECT_FLOW.md).
- "Open My Focus" opens `appUrl` (project page → My Focus tab focused on
  the first ticket).
- "Snooze 1h" → POST ack with `action: snoozed, snoozeUntil: now+1h`.
- "Dismiss all" → POST ack with `action: dismissed` for every nudge in
  the popup.
- "Don't show again" → flips a per-user setting `dq-popups-enabled = false`
  in the local config + server-side preference, identical to §7's opt-out.

### 3.3 Channel C — Email (V2, out of scope)

Optional later — uses ai-server's existing notifme-sdk pipeline. Gated
by user opt-in.

## 4. Viability Analysis — Desktop Popup

### 4.1 Technical viability — **High**

- The python-desktop-app is already installed on every active end-user's
  machine; this is a precondition we control.
- It already authenticates with ai-server (JWT) and has an HTTP client
  with retry/backoff.
- tkinter `Toplevel` windows centred on the primary screen are standard
  Python and used elsewhere in the desktop app.
- Polling adds one HTTP call every 5–15 minutes — negligible load.
- The acknowledgement endpoint reuses the same dedupe table as the
  Jira-bell channel (§6), so the two channels do not duplicate
  notifications for the same user.

### 4.2 UX viability — **Medium-high**, with caveats

| Concern | Mitigation |
|---|---|
| Centred always-on-top popups can feel intrusive | Show only when ≥ 1 new low-quality ticket exists, dedupe per 24 h, hard cap of 5 tickets per popup, "Don't show again" exit |
| Steals focus from the user's current work | Use `-topmost` without `focus_force()`; popup appears but does not consume keystrokes |
| User has multiple monitors | Render on the **primary** monitor (the one with the taskbar). Document this; revisit if telemetry shows complaints |
| Popup appears in remote desktops / shared sessions | Same constraint as today's tray icon — no new privacy concern, since both surfaces only show data the logged-in user already has access to |

### 4.3 Privacy & security viability — **High, with strict guardrails**

The popup must **not** display ticket description content (which could
contain PII). Only:

- Issue key (already public to the assignee in their project).
- Summary (also public to the assignee).
- Numeric score.

This matches the rule for the Jira-bell channel (§11). The desktop app
continues to flow all OCR / activity data through `privacy/`
([python-desktop-app/privacy/](../../python-desktop-app/privacy/)); the
nudge payload is server-generated and separate, so privacy redaction
does not need new wiring.

### 4.4 Operational viability — **Medium**

- Adds one new endpoint per channel and a small amount of desktop-app
  code (~150 LOC for popup + poller + ack).
- Requires a build/release of the desktop app — coordinate with the
  existing PyInstaller pipeline (`build.bat`).
- Increases poll volume — bounded by the cadences in §3.2.1.
- Users who never open Jira at all can still be reached → **this is the
  primary win** versus Jira-bell-only.

### 4.5 Decision

**Ship the desktop popup channel in V1, in parallel with the Jira-bell
channel.** The two channels share dedupe state so a user is not nudged
twice for the same ticket within the cooldown window — they receive at
most one prompt per (user, issue, 24 h) regardless of channel.

If telemetry shows desktop popups are dismissed > 50% of the time, the
popup cadence drops from 30 min → 2 h automatically (org-level setting).

## 5. Scheduler Algorithm

```
descriptionQualityNudge(event):
  if KVS.acquireLock('scheduler-lock/dq-nudge', ttl=60s) is False:
    return  # another invocation is in flight
  try:
    for each tenant (cloudId, orgId) in known tenants:
      # Step 1 — list candidate issues (cheap, no LLM)
      issues = jiraSearch(jql = "assignee is not EMPTY AND statusCategory != Done AND updated >= -30d",
                         fields = ["summary","assignee","updated"],
                         maxResults = 500)

      # Step 2 — group by assignee
      byUser = groupBy(issues, i -> i.assignee.accountId)

      for accountId, issuesForUser in byUser:
        prefs = getPreferences(orgId, accountId)
        if not (prefs.bellEnabled or prefs.popupEnabled): continue

        # Step 3 — read cached scores
        scores = descriptionQualityCacheReader.batch(orgId, [i.key for i in issuesForUser])

        lowQuality = [i for i in issuesForUser
                      if scores[i.key] is not None and scores[i.key].score < 80]
        uncached   = [i for i in issuesForUser if scores[i.key] is None]

        # Step 4 — warm-up queue (bounded LLM spend per tenant per run)
        for i in uncached[:WARMUP_CAP_PER_TENANT_PER_RUN]:  # default 10
           analyzeDescription(i.key)

        # Step 5 — dedupe across BOTH channels and cap notifications
        toNotify = []
        for i in lowQuality:
          last = notificationsTable.lookupAnyChannel(orgId, accountId, i.key)
          if notificationsTable.isSnoozed(orgId, accountId, i.key, now): continue
          if last is None or now - last >= NOTIFY_COOLDOWN_HOURS:
            toNotify.append(i)
          if len(toNotify) >= NOTIFY_CAP_PER_USER_PER_RUN:  # default 5
            break

        # Step 6 — fan out to enabled channels
        for i in toNotify:
          if prefs.bellEnabled:
            jiraNotify(i.key, accountId, scores[i.key].score, i.summary)
            notificationsTable.upsert(orgId, accountId, i.key, channel='jira', now)
          if prefs.popupEnabled:
            notificationsTable.upsert(orgId, accountId, i.key, channel='desktop', now,
                                      payload = { score, summary, issueUrl, appUrl })
            # No outbound send here — the desktop app polls and pulls.
  finally:
    KVS.releaseLock('scheduler-lock/dq-nudge')
```

### 5.1 Caps and tunables (default → KVS-overridable)

| Tunable | Default | Where stored |
|---|---|---|
| `WARMUP_CAP_PER_TENANT_PER_RUN` | 10 issues | Org settings in KVS |
| `NOTIFY_CAP_PER_USER_PER_RUN` | 5 notifications | Org settings in KVS |
| `NOTIFY_COOLDOWN_HOURS` | 24 h per (user, issue) — applies across both channels | Org settings in KVS |
| `WARMUP_CONCURRENCY` | 3 concurrent analyses | Hard-coded |
| `DESKTOP_POLL_FOREGROUND_MIN` | 5 min | Desktop app config |
| `DESKTOP_POLL_IDLE_MIN` | 15 min | Desktop app config |

### 5.2 What the scheduler **does not** do (V1)

- Does not analyze every uncached ticket on every run (cost guard).
- Does not send to channels the user has disabled.
- Does not notify about tickets with no assignee, status = Done, or
  updated > 30 days ago.
- Does not push to the desktop — the desktop **pulls** via polling.

## 6. Database

### 6.1 New table

```sql
-- supabase/migrations/20260605_description_quality_notifications.sql
-- Tracks per-user, per-issue, per-channel notification history for the
-- description-quality nudge scheduler. Used for dedupe (preventing spam),
-- desktop-app polling, and acknowledgement.
create table public.description_quality_notifications (
  id              bigserial primary key,
  org_id          uuid not null,
  account_id      text not null,
  cloud_id        text not null,
  issue_key       text not null,
  score_at_notify smallint not null,
  channel         text not null,                       -- 'jira' | 'desktop' | 'email'
  payload         jsonb,                               -- denormalised for desktop poll (summary, urls, score)
  notified_at     timestamptz not null default now(),
  acknowledged_at timestamptz,
  ack_action      text,                                -- 'viewed' | 'opened-in-jira' | 'dismissed' | 'snoozed'
  snooze_until    timestamptz
);

create index dqn_org_user_issue_idx
  on public.description_quality_notifications (org_id, account_id, issue_key);

create index dqn_pending_desktop_idx
  on public.description_quality_notifications (org_id, account_id)
  where channel = 'desktop' and acknowledged_at is null;

create index dqn_org_recent_idx
  on public.description_quality_notifications (org_id, notified_at desc);

alter table public.description_quality_notifications enable row level security;

create policy dqn_select_own_org
  on public.description_quality_notifications
  for select
  using (org_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'org_id')::uuid);

create policy dqn_insert_own_org
  on public.description_quality_notifications
  for insert
  with check (org_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'org_id')::uuid);

create policy dqn_update_own_org
  on public.description_quality_notifications
  for update
  using (org_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'org_id')::uuid);
```

> **Difference from prior revision:** the table no longer carries a
> unique constraint on `(org_id, account_id, issue_key, channel)` — the
> 24-h cooldown is now enforced in code, not by the unique key. This
> permits historical rows for the same (user, issue, channel) and
> preserves analytics. Migration filename:
> `20260605_description_quality_notifications.sql`.

## 7. User Opt-Out

### 7.1 Storage

Per-user, per-channel preferences in Forge KVS:

- `user-settings/<accountId>/dq-nudges.bell-enabled` (boolean, default `true`)
- `user-settings/<accountId>/dq-nudges.popup-enabled` (boolean, default `true`)

Mirrored locally in the desktop app's config so the popup can suppress
itself instantly when the user clicks "Don't show again", without
waiting for a server round-trip. Server is the source of truth on next
sync.

### 7.2 UI

#### 7.2.1 Forge settings page

New "Notifications" section in the existing settings UI
([forge-app/static/settings/](../../forge-app/static/settings/)):

> **Description quality reminders**
> - [x] Show in Jira (bell icon)
> - [x] Show as desktop popup
>
> Up to 5 reminders per scan, no more than once per ticket per day.

#### 7.2.2 Desktop popup

The "Don't show again" footer button toggles only the **popup** channel
off; the bell channel is unaffected. A subtle link `Manage in Jira →`
opens the Forge settings page.

### 7.3 Resolver / endpoint additions

- Forge resolvers: `getDqNudgePreferences()`, `setDqNudgePreferences({ bellEnabled, popupEnabled })`.
- ai-server endpoints (called by desktop app):
  - `GET  /api/desktop/description-quality-nudges` — pull pending nudges.
  - `POST /api/desktop/description-quality-nudges/ack` — acknowledge / dismiss / snooze.
  - `GET  /api/desktop/preferences/dq-nudges` — fetch current preferences.
  - `PUT  /api/desktop/preferences/dq-nudges` — update.

## 8. Files (planned)

### 8.1 New files

| Path | Purpose |
|---|---|
| `forge-app/src/services/descriptionQualityNudge.js` | Scheduler handler — implements §5 algorithm. |
| `forge-app/src/resolvers/dqNudgePreferenceResolvers.js` | `get/setDqNudgePreferences` resolvers (per-channel). |
| `forge-app/static/settings/src/components/NudgeSettings.js` | Two-checkbox UI (bell, popup). |
| `ai-server/src/controllers/desktopDqNudgesController.js` | `GET /api/desktop/description-quality-nudges` + `POST .../ack`. |
| `ai-server/src/controllers/desktopDqPreferencesController.js` | GET/PUT preferences. |
| `ai-server/src/services/db/descriptionQualityNotificationsRepo.js` | CRUD for the new table (multi-channel). |
| `supabase/migrations/20260605_description_quality_notifications.sql` | New table + RLS. |
| `python-desktop-app/dq_nudge/__init__.py` | Package marker. |
| `python-desktop-app/dq_nudge/poller.py` | Background thread polling the new endpoint at the cadence in §5.1. |
| `python-desktop-app/dq_nudge/popup.py` | tkinter `Toplevel` popup, centred on primary monitor, scrollable list, action buttons. |
| `python-desktop-app/dq_nudge/ack_client.py` | Thin wrapper around the ack endpoint. |
| `python-desktop-app/dq_nudge/preferences.py` | Local + remote preference sync. |
| `forge-app/tests/services/descriptionQualityNudge.test.js` | Algorithm tests — caps, dedupe across channels, opt-out per channel. |
| `forge-app/tests/resolvers/dqNudgePreferenceResolvers.test.js` | Preference resolver tests. |
| `ai-server/tests/controllers/desktopDqNudgesController.test.js` | Endpoint tests — auth, RLS, ack actions. |
| `ai-server/tests/services/db/descriptionQualityNotificationsRepo.test.js` | Repo tests — multi-channel insert, cooldown lookup, snooze. |
| `python-desktop-app/tests/test_dq_nudge_poller.py` | Poller tests — cadence, error handling, ack on user action. |
| `python-desktop-app/tests/test_dq_nudge_popup.py` | Popup tests — list rendering, button wiring (using a tkinter test harness). |
| `supabase/functions/__tests__/dqn_rls.test.ts` (optional) | RLS policy tests via local Supabase. |

### 8.2 Modified files

| Path | Change |
|---|---|
| [forge-app/manifest.yml](../../forge-app/manifest.yml) | Add two `scheduledTrigger` entries `description-quality-nudge-a/b` and a `function` entry for `descriptionQualityNudge`. |
| [forge-app/src/index.js](../../forge-app/src/index.js) | Export `descriptionQualityNudgeHandler`; register preference resolvers. |
| `forge-app/static/main/src/App.js` | On mount, parse `?issueKey=…#mf-improve`, switch to My Focus tab, scroll-to-row, trigger the Improve deep-link. |
| `forge-app/static/main/src/components/tabs/DashboardTab.js` | Accept a `highlightIssueKey` prop / context; add transient highlight class. |
| `forge-app/static/settings/src/...` | Wire up `NudgeSettings.js` into the existing settings layout. |
| [python-desktop-app/desktop_app.py](../../python-desktop-app/desktop_app.py) | Start `dq_nudge.poller` thread on app startup; respect existing tray menu and shutdown lifecycle. |
| `python-desktop-app/requirements.txt` | No new deps expected (tkinter ships with Python; reuse existing requests/urllib3). Verify at impl time. |

## 9. Acceptance Criteria

11. Best-effort ~30-min cadence via two hourly triggers; documented limitation.
12. Per scheduler run: ≤ 10 LLM warm-up calls per tenant, ≤ 5 notifications per user, across both channels combined.
13. Per (user, issue): one notification per 24 h (configurable) **across all channels** — a user enrolled in both bell and popup channels still gets at most one prompt per ticket per day.
14. Notification body (bell) and popup row (desktop) include issue key, summary, score, and a deep-link that lands the user in the Improve flow.
15. Per-channel opt-out in the app settings page; opted-out channels are skipped at scheduler fan-out time.
16. Scheduler skips unassigned, Done, or > 30-day-old issues.
17. **Desktop popup is centred on the primary monitor, always-on-top without stealing focus, and dismissible / snoozable. It only appears when at least one unacknowledged desktop nudge exists for the logged-in user.**
18. **The desktop popup never displays ticket description content — only key, summary, and score.**
19. **"Improve in Jira" from the popup opens the Jira issue URL with `#dq=improve`, which auto-starts the existing Improve-with-AI flow per [12_IMPROVE_REDIRECT_FLOW.md](./12_IMPROVE_REDIRECT_FLOW.md).**
20. **Acknowledgement (view / open / dismiss / snooze) is recorded server-side and prevents re-display until the cooldown / snooze elapses.**

## 10. Test Plan

| AC | Test | File |
|---|---|---|
| 11 | Manifest has two triggers pointing to same handler | `descriptionQualityNudge.test.js` |
| 12 | Mock 100 uncached + 50 low-quality issues → assert exactly 10 analyses + 5 notifies per user across channels | `descriptionQualityNudge.test.js` |
| 13 | Same user/issue called twice in same hour across both channels → second call sends 0 to either | `descriptionQualityNudge.test.js` |
| 14 | Captured Jira-notify payload + desktop-poll response both include key, summary, score, deep-link | `descriptionQualityNudge.test.js`, `desktopDqNudgesController.test.js` |
| 15 | Bell-only user → 0 desktop rows; popup-only user → 0 Jira-notify calls; both-off → 0 of either | `descriptionQualityNudge.test.js` |
| 16 | Mock issues with null assignee / Done / old `updated` → excluded | `descriptionQualityNudge.test.js` |
| 17 | Popup window centred on primary monitor; topmost flag set; focus not stolen | `test_dq_nudge_popup.py` |
| 18 | Payload shape excludes `description` field; assertion in repo and controller tests | `descriptionQualityNotificationsRepo.test.js`, `desktopDqNudgesController.test.js` |
| 19 | "Improve in Jira" button opens URL ending in `#dq=improve` | `test_dq_nudge_popup.py` |
| 20 | After ack, the next poll returns empty list; snooze respects `snooze_until` | `desktopDqNudgesController.test.js`, `descriptionQualityNudge.test.js` |
| Lock | Concurrent invocation while lock held → early return, no duplicate work | `descriptionQualityNudge.test.js` |
| Repo | RLS prevents cross-tenant reads | `descriptionQualityNotificationsRepo.test.js` |
| Poller | Cadence 5 min foreground / 15 min idle; backoff on 5xx | `test_dq_nudge_poller.py` |

## 11. Security & Compliance

- All Supabase writes scoped by `org_id`; RLS enforces multi-tenant isolation.
- Notification body (both channels) **must not** include any ticket
  description content — only `issueKey`, `summary`, and `score`.
- Logs at `info` must not contain the description body. Debug-level may
  include redacted content — follow the existing pattern from
  [.github/copilot-instructions.md](../../.github/copilot-instructions.md).
- Per-user, per-channel opt-out is honoured at the very top of fan-out;
  no row is inserted for a disabled channel.
- Rate-limit safeguards (caps + cooldown across channels) prevent the
  system from being weaponized as a spam vector.
- Desktop poller authenticates with the same JWT used elsewhere in the
  desktop app (see [auth/](../../python-desktop-app/auth/)). No new
  credentials.
- The `payload` JSONB stored in `description_quality_notifications` is
  generated server-side from already-allowed fields (no description, no
  PII). Validated in the repo write path with a strict allow-list.
- Desktop popup must **not** be re-shown to other users on the same
  machine — the popup process is bound to the currently authenticated
  user, and switching users requires re-auth (existing behaviour).

## 12. Open Questions

1. Should we surface a per-org "Last scheduler run at" diagnostic on the
   admin dashboard? (Recommended, but defer to V2.)
2. Should the warm-up queue prioritize most-recently-updated issues?
   (Recommended yes — likely the tickets the user is actively working
   on.)
3. Should the in-product Jira notification be marked as a Jira mention
   to land on the bell icon with higher priority? Test `to.users[]` vs
   `to.assignee` payload variants at impl time.
4. Should desktop popups support multiple monitors (render on the
   monitor currently containing the cursor)? Defer to V2; primary
   monitor for V1.
5. Should auto-cadence-degradation (drop 30 min → 2 h after high
   dismiss rate) be per-user or per-org? Suggest per-org for V1,
   per-user for V2.
6. What happens if the desktop app is offline at the moment a nudge is
   created? Answer: nudges persist in the DB until acknowledged, so the
   popup appears on the next successful poll — no loss.

## 13. Rollout

- Ship behind a per-org feature flag (`features.dqNudges`, default `off`).
- Per-channel sub-flags (`features.dqNudges.bell`, `features.dqNudges.popup`)
  to allow staged rollout — bell first, popup a week later.
- Enable for internal Amzur tenant first; monitor:
  - Cache hit rate trend
  - LLM call volume per scheduler run
  - Notification volume per user per day
  - Per-channel acknowledgement rates (viewed / opened / dismissed / snoozed)
  - Desktop poll error rate
- Promote to default-on after 1 week of clean telemetry.

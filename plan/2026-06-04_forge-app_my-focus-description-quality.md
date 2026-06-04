# Spec — Description Quality in My Focus + Scheduled Nudges

**Date:** 2026-06-04
**Component:** forge-app (+ ai-server, supabase)
**Status:** Draft — pending review

---

## 1. Problem

The existing "Description Quality" feature lives only inside the Jira issue panel
([DescriptionQuality.js](forge-app/static/main/src/components/issue-panel/DescriptionQuality.js)).
A user has to open each ticket individually to learn whether its description is
poor. There is:

- No at-a-glance view of description quality across the user's assigned work
- No quick path from a low-quality score to the "Improve with AI" flow
- No proactive reminder when assigned tickets have poor descriptions

Result: the feature is under-discovered, and ticket-quality regressions are
silent.

## 2. Root Cause / Context

- **My Focus page** lives in [DashboardTab.js](forge-app/static/main/src/components/tabs/DashboardTab.js)
  and renders the columns `ID | Title | Status | Priority | Time Tracked`.
  There is no quality column today.
- **Description analysis** is fronted by the `analyzeDescription` resolver
  ([descriptionResolvers.js](forge-app/src/resolvers/descriptionResolvers.js))
  and cached in Supabase (`description_quality_cache`, see
  [08_DATABASE_SCHEMA.md](docs/jira_ticket_description_enhancement/08_DATABASE_SCHEMA.md)).
  Today the cache is **only** written when a user opens a panel and triggers
  analysis — there is no batch entry-point.
- **Scheduled triggers** are declared in
  [manifest.yml](forge-app/manifest.yml) (currently `interval: hour`). Forge
  scheduled-trigger intervals supported in `nodejs22.x` runtime: `hour`, `day`,
  `week` (no native `30-minute`). A 30-minute cadence must be emulated by an
  **hourly** Forge trigger that itself fans out two 30-min checks via timestamp
  windowing — see §3.3 below.
- **Forge has no native end-user push notification API.** The only first-party
  channel that reaches a user inside Jira is **mentioning them in an
  in-product notification via the Jira REST notification endpoint**
  (`POST /rest/api/3/issue/{key}/notify`) or via email (which already exists
  for other features in ai-server). Both are addressed in §3.3.

## 3. Proposed Solution

Three increments, deliverable independently.

### 3.1 — Description-quality column in My Focus (Enhancement #1)

Add a **Quality** column to the My Focus table. Strategy revised on
2026-06-04 to **eager bulk analysis** per stakeholder direction:

| Strategy | Cold-load latency | LLM cost | UX | Decision |
|---|---|---|---|---|
| A. Per-row "Check Quality" button (manual only) | 0 calls | $0 | Hidden by default; defeats discoverability | Reject |
| B. Eager analysis ignoring the cache | N × LLM every load | High, redundant | Slow, expensive | Reject |
| C. **Cache-first read + sync fill of cache misses** | 1 cache read + (≤ N) LLM (deduped by content hash) | Bounded, gated by deterministic scorer | Every visible row shows a score; spinners only for first-time misses | **Selected** |

**Selected: Strategy C.**

- On My Focus load, the frontend calls a **new resolver**
  `getDescriptionScores({ issueKeys, fillMisses: true })` which calls a
  **new ai-server endpoint** `POST /api/forge/description/scores/batch`.
- Stage 1 (cache read): Supabase lookup, returns hits in < 300 ms.
- Stage 2 (sync fill): for cache misses the endpoint runs the existing
  `analyzeDescription` pipeline (deterministic scorer first, LLM only
  when deterministic < 80) with concurrency cap 5 and 20 s deadline.
- Cache hit / fill complete → coloured badge (Red < 50, Yellow 50-79,
  Green ≥ 80). Fill in flight → spinner. Fill error → grey "—" + retry.
- No manual "Check" button. Per-page hard cap of 50 issues.
- The scheduler in §3.3 keeps progressively warming the cache so
  steady-state opens are pure cache hits.

Acceptance: see numbered list in §4.

### 3.2 — "Improve" button → deep-link to issue panel (Enhancement #2)

In the My Focus Quality cell, when a cached score exists and is **< 80**,
show an **"Improve"** button next to the badge.

- Clicking navigates the user to the Jira issue view using the Forge
  router (`@forge/bridge` → `router.open()` with the issue URL built from
  the cloud base URL + issue key).
- The issue view loads the existing Issue Panel, which already hosts
  [DescriptionQuality.js](forge-app/static/main/src/components/issue-panel/DescriptionQuality.js).
- To make the panel auto-start in the "Improve with AI" flow rather than the
  IDLE state, we pass an **auto-improve hint** via:
  1. A URL fragment `#dq=improve` appended by `router.open()`.
  2. `DescriptionQuality.js` reads `window.location.hash` on mount; if it
     contains `dq=improve` it immediately calls `runAnalysis(true)` and skips
     the IDLE → SCORED stages.
- The hint is ephemeral (no persistence) and only fires once per page load.

### 3.3 — Scheduled quality nudges (Enhancement #3)

Goal: every ~30 minutes, scan each user's assigned open tickets, and notify
them about tickets whose cached description score is < 80.

#### 3.3.1 Cadence

Forge scheduled-trigger `interval` does not support 30 minutes. Approach:

- Declare a new scheduled trigger `descriptionQualityNudge` with
  `interval: hour`.
- Inside the handler, run the scan once. To approximate a 30-minute cadence,
  we **additionally** subscribe the same handler to the existing hourly
  `worklog-sync-trigger` offset (which fires on the half-hour relative to
  `descriptionQualityNudge`). Document the limitation and revisit if Forge
  adds finer intervals.
- Per-user dedupe: a user is only nudged about the same issue at most once
  per N hours (default **24h**, configurable in app settings) regardless of
  how often the trigger fires.

#### 3.3.2 Scan algorithm (per tenant)

1. For each `cloudId` known to the app (from existing tenant table), call the
   Jira search API as the app user to list **assignee = currentUser, status
   != Done, updated within last 30 days** — chunked, max 500 issues/tenant.
2. Group by `assigneeAccountId`.
3. For each user's issue set, look up scores in `description_quality_cache`.
   - Tickets with no cached score are **not auto-analyzed by the scheduler**
     in V1 (avoid runaway LLM cost). They are added to a low-priority
     "warm-up queue" that processes ≤ 10 issues per tenant per run.
   - Tickets with cached score < 80 enter the **notify set**.
4. Filter the notify set against the per-user dedupe table
   `description_quality_notifications` (`org_id, account_id, issue_key,
   last_notified_at`).
5. For up to **5 tickets per user per run** (configurable cap), send a
   notification (see §3.3.3) and write to the dedupe table.

#### 3.3.3 Notification channels

V1 ships **two channels in parallel**, sharing one dedupe table so a
user receives at most one prompt per (issue, 24 h) regardless of how
many channels they enabled. Email is V2.

**Channel A — Jira in-product notification (bell icon).**
`POST /rest/api/3/issue/{issueKey}/notify` referencing the assignee. Body
links to:

```
https://<cloudHost>/jira/your-work?focusApp=<appId>&issueKey=<KEY>#mf-improve
```

The link opens the Time Tracker app's main page; the My Focus tab reads
`#mf-improve` and the `issueKey` query param on mount, scrolls/highlights
the row, and triggers the Improve deep-link from §3.2 in one click.

**Channel B — Desktop popup (NEW).** The existing python-desktop-app
polls a new ai-server endpoint
`GET /api/desktop/description-quality-nudges` every 5 min (foreground)
or 15 min (idle). When pending nudges are returned, a centred,
always-on-top tkinter `Toplevel` popup lists up to 5 low-quality
tickets (issue key + summary + score only — no description content)
with "Improve in Jira →", "Snooze", and "Dismiss" buttons. "Improve in
Jira" opens the issue URL with `#dq=improve`, auto-starting the
existing Improve flow per §3.2. Acknowledgements POST to
`/api/desktop/description-quality-nudges/ack` and prevent re-display
until cooldown / snooze elapses.

Viability of the desktop channel was assessed (see
[13_SCHEDULED_QUALITY_NOTIFICATIONS.md](docs/jira_ticket_description_enhancement/13_SCHEDULED_QUALITY_NOTIFICATIONS.md) §4)
and judged **High** technically (reuses existing JWT auth and HTTP
client), **Medium-high** for UX (centred popup without focus-steal,
"Don't show again" exit), and **High** for privacy (server-generated
payload contains no description content).

#### 3.3.4 User opt-out

Add a per-user toggle in the existing settings page
([settings/](forge-app/static/settings/)): "Notify me about low-quality
ticket descriptions" (default **on**). Stored in app KVS under
`user-settings/<accountId>/dq-nudges`. Scheduler checks this flag before
notifying.

## 4. Acceptance Criteria

### 4.1 — My Focus Quality column

1. My Focus table renders a new **Quality** column between "Priority" and "Time Tracked".
2. On page load, the frontend issues a batched request for all visible issue keys (≤ 50 per page) that returns cache hits immediately and triggers analysis for cache misses.
3. For an issue with a final score (cache hit or filled), the cell renders a coloured badge: red (<50), yellow (50-79), green (≥80).
4. For an issue whose cache miss is being filled, the cell renders a "Analysing…" spinner; for an analysis error or 20 s timeout it renders "—" with a retry icon.
5. The bulk-fill pipeline runs the deterministic scorer first; the LLM is only invoked when the deterministic score < 80 (existing LLM Gate). Concurrency is capped at 5 in flight per request.
6. Sorting the column by score works (ascending = worst first), with pending/error rows sorted last.

### 4.2 — Improve deep-link

7. For any cell whose badge < 80, an "Improve" button is visible inline.
8. Clicking "Improve" calls `router.open(<issueUrl>#dq=improve)` and the active tab/window navigates to the Jira issue view.
9. When the issue panel mounts with `#dq=improve` in the URL hash, [DescriptionQuality.js](forge-app/static/main/src/components/issue-panel/DescriptionQuality.js) immediately enters the LOADING_LLM stage (skips IDLE/SCORED).
10. The hint is consumed exactly once per page load; reloading the issue without the hash returns to the existing IDLE flow.

### 4.3 — Scheduled nudges

11. Two hourly scheduled triggers (`description-quality-nudge-a/b`) share one handler, giving best-effort ~30-min cadence. Documented limitation: not guaranteed.
12. Per scheduler run, ≤ **10 LLM warm-up calls per tenant** and ≤ **5 notifications per user** **across both channels combined**.
13. A user receives at most one notification per issue per 24 h (configurable) **across all channels** (bell + desktop). Dedupe lives in a new table `description_quality_notifications`.
14. Notifications (Jira bell text + desktop popup row) include the issue key, summary, score, and a deep-link that auto-triggers the Improve flow.
15. Per-channel opt-out (bell on/off, popup on/off) in the settings page; disabled channels are skipped at fan-out time.
16. Scheduler never analyzes or notifies on tickets where `assignee` is unset, status is `Done`, or `updated` is older than 30 days.
17. Desktop popup is centred on the primary monitor, always-on-top without stealing focus; it appears only when the desktop app polls and receives at least one unacknowledged nudge.
18. Desktop popup **never** displays ticket description content — only key, summary, and score.
19. Acknowledgements (viewed / opened-in-jira / dismissed / snoozed) are recorded server-side and prevent re-display until cooldown or snooze elapses.

## 5. Out of Scope

- Changing the existing deterministic scorer, LLM prompt, or PII redaction
  in ai-server.
- A 5- or 15-minute scheduler cadence (Forge runtime limitation).
- Sending notifications via Slack, Teams, or push (only Jira in-product
  notifications in V1; email in V2).
- Auto-rewriting descriptions without user approval (the existing approve
  flow is preserved).
- Showing the quality column anywhere other than My Focus (no Team
  Analytics / Org Analytics changes).
- Persisting the "auto-improve" hint across reloads or session restores.

## 6. Files Affected (planning only — no code changes yet)

See [11_MY_FOCUS_QUALITY_COLUMN.md](docs/jira_ticket_description_enhancement/11_MY_FOCUS_QUALITY_COLUMN.md),
[12_IMPROVE_REDIRECT_FLOW.md](docs/jira_ticket_description_enhancement/12_IMPROVE_REDIRECT_FLOW.md),
[13_SCHEDULED_QUALITY_NOTIFICATIONS.md](docs/jira_ticket_description_enhancement/13_SCHEDULED_QUALITY_NOTIFICATIONS.md)
for full file-by-file breakdowns.

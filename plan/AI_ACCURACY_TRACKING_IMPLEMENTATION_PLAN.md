# AI Accuracy Tracking — Implementation Plan

## Goal

Measure how often the AI's issue-classification suggestions are correct, so prompts can be tuned and the human-approval flow eventually retired. Built as an **append-only observation layer** that can be removed in under an hour with zero impact on production data.

## Non-goals

- Not a permanent feature. Designed for removal.
- Not a replacement for the existing approval workflow.
- Not a user-facing analytics tool. Internal only.
- Not multi-tenant in the usual sense — single dashboard, organization-aware queries.

---

## What we capture

Three event types, one row per user decision:

| Event | When fired | Signal |
|---|---|---|
| `approved_as_is` | User clicks Approve on a pending session | AI got it right |
| `reassigned` | User reassigns pending time to a different issue | AI got it wrong; capture both keys |
| `manually_assigned` | User assigns previously-unassigned work to an issue | AI failed to classify (or never tried) |

Critical distinction: `ai_suggested_issue_key = NULL` means the AI returned no suggestion. A non-null value means the AI suggested something but the user disagreed (for `reassigned`) or accepted it (for `approved_as_is`). Without this distinction the accuracy numbers are meaningless.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│ Forge resolvers (production code, untouched)    │
│   approveRecords                                │
│   reassignAndApproveRecords                     │
│   createIssueAndApproveRecords                  │
│   <unassigned-work assignment resolver>         │
└──────────────┬──────────────────────────────────┘
               │ try { recordAccuracyEvent(...) } catch swallow+log
               ▼
┌─────────────────────────────────────────────────┐
│ accuracyTracking.js (new — single helper file)  │
│   - reads ACCURACY_TRACKING_ENABLED env flag    │
│   - inserts one row into ai_accuracy_events     │
│   - never throws to caller                      │
└──────────────┬──────────────────────────────────┘
               │ INSERT
               ▼
┌─────────────────────────────────────────────────┐
│ Supabase: ai_accuracy_events (append-only)      │
└──────────────┬──────────────────────────────────┘
               │ SELECT
               ▼
┌─────────────────────────────────────────────────┐
│ AI server: /accuracy-dashboard                  │
│   - Atlassian OAuth (existing)                  │
│   - email allowlist check (new)                 │
│   - read-only HTML + JSON sub-routes            │
└─────────────────────────────────────────────────┘
```

**Removal = drop two tables, delete `accuracyTracking.js`, delete the dashboard route, revert ~5 resolver lines.**

---

## Phase 1 — Schema (Supabase)

One migration: `supabase/migrations/YYYYMMDD_ai_accuracy_tracking.sql`

```sql
-- Append-only event log for AI suggestion accuracy
CREATE TABLE public.ai_accuracy_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'approved_as_is', 'reassigned', 'manually_assigned'
  )),
  activity_record_id uuid,           -- nullable: missing for some manually_assigned events
  ai_suggested_issue_key text,        -- NULL when AI gave no suggestion
  ai_confidence_score numeric,        -- NULL when AI gave no suggestion
  final_issue_key text NOT NULL,      -- what the user accepted
  duration_seconds int NOT NULL DEFAULT 0,
  window_title text,
  application_name text,
  classification text,                -- AI's classification label, if any
  metadata jsonb,                     -- escape hatch for future signals
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_aae_org_created ON public.ai_accuracy_events (organization_id, created_at DESC);
CREATE INDEX idx_aae_event_created ON public.ai_accuracy_events (event_type, created_at DESC);
CREATE INDEX idx_aae_suggested_final ON public.ai_accuracy_events (ai_suggested_issue_key, final_issue_key)
  WHERE event_type = 'reassigned';

-- Email allowlist for the accuracy dashboard
CREATE TABLE public.accuracy_dashboard_users (
  email text PRIMARY KEY,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by text,
  notes text
);

-- Seed the initial allowlist via SQL (manual — no UI to add users):
-- INSERT INTO public.accuracy_dashboard_users (email, added_by, notes)
-- VALUES ('owner@example.com', 'bootstrap', 'product owner');
```

**RLS:** keep RLS off on both tables. Inserts happen with the service-role key from the Forge backend, reads happen from the AI server with the same key. The dashboard's gate is the email allowlist, not RLS.

**Retention:** none for now. If event volume grows uncomfortable, add a partial cleanup job later. Before removal day this is moot.

---

## Phase 2 — Capture helper (Forge backend)

New file: `forge-app/src/services/accuracy/accuracyTracking.js`

```javascript
// Single entrypoint for accuracy event logging.
// Failures are swallowed so production flows are never blocked.
// Disable with ACCURACY_TRACKING_ENABLED=false (default: enabled).

import { supabaseRequest } from '../../utils/supabase.js';

const ENABLED = process.env.ACCURACY_TRACKING_ENABLED !== 'false';

export async function recordAccuracyEvent(supabaseConfig, {
  organizationId,
  userId,
  eventType,            // 'approved_as_is' | 'reassigned' | 'manually_assigned'
  activityRecordId,
  aiSuggestedIssueKey,  // null when no AI suggestion
  aiConfidenceScore,    // null when no AI suggestion
  finalIssueKey,
  durationSeconds,
  windowTitle,
  applicationName,
  classification,
  metadata
}) {
  if (!ENABLED) return;

  try {
    await supabaseRequest(supabaseConfig, 'ai_accuracy_events', {
      method: 'POST',
      body: {
        organization_id: organizationId,
        user_id: userId,
        event_type: eventType,
        activity_record_id: activityRecordId || null,
        ai_suggested_issue_key: aiSuggestedIssueKey || null,
        ai_confidence_score: aiConfidenceScore ?? null,
        final_issue_key: finalIssueKey,
        duration_seconds: durationSeconds || 0,
        window_title: windowTitle || null,
        application_name: applicationName || null,
        classification: classification || null,
        metadata: metadata || null
      }
    });
  } catch (err) {
    console.warn('[accuracyTracking] log failed (non-fatal):', err.message);
  }
}

export async function recordAccuracyEventsBatch(supabaseConfig, events) {
  if (!ENABLED || !events?.length) return;
  // Bulk insert — used when one user action affects N records (e.g. Approve all).
  // Same swallow-on-error contract.
  try {
    const rows = events.map(e => ({ /* same shape mapping as above */ }));
    await supabaseRequest(supabaseConfig, 'ai_accuracy_events', {
      method: 'POST',
      body: rows
    });
  } catch (err) {
    console.warn('[accuracyTracking] batch log failed (non-fatal):', err.message);
  }
}
```

---

## Phase 3 — Wire capture into resolvers

Touchpoints, all in `forge-app/src/resolvers/`:

### `approval/approvalResolvers.js`

**`approveRecords`** (one event per approved record):
- Before the PATCH, fetch the rows you're about to approve (need their `user_assigned_issue_key`, AI confidence from `metadata`, window/app context).
- After successful PATCH, batch-log one `approved_as_is` event per row.
- `ai_suggested_issue_key = final_issue_key = user_assigned_issue_key` (the AI suggested what was approved).

**`reassignAndApproveRecords`** (one event per reassigned record):
- The resolver already snapshots `existing` rows with their original `user_assigned_issue_key` for the `reassigned_from` audit. Reuse that.
- After successful PATCH, batch-log one `reassigned` event per row:
  - `ai_suggested_issue_key` = original key (what AI picked)
  - `final_issue_key` = `newIssueKey` (what user picked)

**`createIssueAndApproveRecords`** (one event per record):
- Same as above but `final_issue_key` is the freshly created issue.
- This is also a "reassigned" event from the AI's perspective — its suggestion was wrong enough that the user created a brand-new issue.

### `unassigned/*` (whichever resolver finalises an unassigned-group assignment)

- One `manually_assigned` event per activity record being assigned.
- `ai_suggested_issue_key` = whatever the AI's record originally had (may be NULL).
- `final_issue_key` = the user's chosen issue.
- This event type tells you "AI completely missed this" vs. "AI suggested but user disagreed" depending on whether the suggested key is NULL.

**Implementation note:** keep all event-construction logic in the resolver files (next to the action), not in `accuracyTracking.js`. The helper is dumb — it just writes whatever you give it. Logic-near-action makes the removal grep simple: `grep -r "recordAccuracyEvent" forge-app/src/resolvers/`.

---

## Phase 4 — Dashboard (AI server)

### Allowlist middleware

New file: `ai-server/src/middleware/accuracy-dashboard-auth.js`

```javascript
// Atlassian OAuth (reuse logic from dashboard-auth.js for /me lookup) +
// email allowlist check. NO Jira admin requirement — explicit allowlist only.

const accuracyDashboardAuth = async (req, res, next) => {
  // 1. Verify Atlassian Bearer token via /me  (copy from dashboard-auth.js)
  // 2. Get user email from /me response
  // 3. SELECT 1 FROM accuracy_dashboard_users WHERE email = $1
  // 4. If not found → 403 with { error: 'Access denied' }
  // 5. Attach req.user = { email, account_id }
};
```

### Routes

New file: `ai-server/src/controllers/accuracy-dashboard-controller.js`

| Route | Returns |
|---|---|
| `GET /accuracy-dashboard` | The HTML page |
| `GET /accuracy-dashboard/api/summary?days=7` | `{ approved, reassigned, manually_assigned, accuracy_rate }` |
| `GET /accuracy-dashboard/api/wrong-pairs?days=7` | Top AI-picked vs user-picked pairs |
| `GET /accuracy-dashboard/api/by-app?days=7` | Right/wrong counts per `application_name` |
| `GET /accuracy-dashboard/api/calibration?days=7` | Confidence-bucket vs actual-accuracy table |
| `GET /accuracy-dashboard/api/recent-mistakes?limit=50` | Last N reassigned events with context |

Mount in `ai-server/src/index.js` behind `accuracyDashboardAuth` middleware.

### HTML page

New file: `ai-server/src/dashboard/accuracy-dashboard.html`

Single static file, fetches the JSON endpoints, renders four panels:

1. **Headline accuracy rate** — big number, last 7 / 30 days toggle.
2. **Top wrong pairs** — table: AI picked → user picked, count, % of all reassigns.
3. **Worst applications** — bar chart of reassign rate per app.
4. **Confidence calibration** — table showing whether AI confidence is meaningful.
5. **Recent mistakes** — scrollable list with window title and app for prompt-tuning context.

Keep it intentionally ugly. This is not a polished surface — its job is to feed prompt iteration.

---

## Phase 5 — Operational

### Adding users to the allowlist

Manual SQL only (no admin UI — keeps the surface area small for removal):

```sql
INSERT INTO accuracy_dashboard_users (email, added_by, notes)
VALUES ('person@company.com', 'admin', 'reason for access');
```

Removal:
```sql
DELETE FROM accuracy_dashboard_users WHERE email = 'person@company.com';
```

Initial seed: bootstrap with the product owner's email in the migration's `-- INSERT` comment, run manually after migration applies.

### Feature flag

- `ACCURACY_TRACKING_ENABLED=true` (default if unset) — capture writes happen.
- `ACCURACY_TRACKING_ENABLED=false` — helper no-ops. Production flows unaffected. Use this in dev/CI.

The dashboard route is unconditionally present but returns empty data when no events exist — no separate flag needed.

### Open decisions before build

1. **Should `manually_assigned` events also fire when bulk-assigning many records to a single issue?** Recommend yes, one event per record, so the per-app and per-window breakdowns are accurate.
2. **Do we need a per-organization filter on the dashboard?** If multiple orgs use the app, mix one dropdown above the panels. If only one org, skip it.
3. **Should event-write failures emit a metric?** Currently just `console.warn`. Probably fine — they're non-critical and a sustained failure would show up as a flat accuracy-rate line that we'd notice anyway.

---

## Removal procedure (when AI is good enough)

1. `DROP TABLE ai_accuracy_events; DROP TABLE accuracy_dashboard_users;` — one migration.
2. Delete `forge-app/src/services/accuracy/`.
3. Delete `ai-server/src/middleware/accuracy-dashboard-auth.js`, `ai-server/src/controllers/accuracy-dashboard-controller.js`, `ai-server/src/dashboard/accuracy-dashboard.html`.
4. `grep -r "recordAccuracyEvent\|recordAccuracyEventsBatch" forge-app/src/` → delete the call sites and their try/catch wrappers.
5. Remove the route mount from `ai-server/src/index.js`.
6. Drop `ACCURACY_TRACKING_ENABLED` from `.env.example` and any deployed env config.

Total: one PR, ~30 minutes of work, zero impact on production tables.

---

## Effort estimate

| Phase | Estimate |
|---|---|
| Migration | 30 min |
| `accuracyTracking.js` helper | 30 min |
| Wire 4 resolver touchpoints | 1.5 hr |
| Allowlist middleware | 45 min |
| Dashboard controller + routes | 1.5 hr |
| HTML page | 1.5 hr |
| Manual testing across all 4 events | 1 hr |
| **Total** | **~7 hours** (one focused day) |

---

## Out of scope (intentionally)

- Real-time updates (polling is fine for a tuning tool)
- Authentication beyond email allowlist (no roles, no groups)
- Per-user accuracy scores (the AI doesn't change per-user; org-level is the right grain)
- Exports to CSV/BigQuery (if you need that, query Supabase directly)
- Alerts on accuracy regressions (eyeball the dashboard weekly)

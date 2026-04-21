# Human-in-the-Loop Approval for AI-Assigned Time

> **Implementation status (2026-04-21):** All phases below have been implemented.
> Minor divergences from the original plan text (kept here for historical
> fidelity):
>
> - The Phase 1.3 column is **`approval_pending_digest_enabled`** (not
>   `approval_digest_enabled`). The rename matches the notification service's
>   `${type}_enabled` lookup convention.
> - Phase 1.3 also extends `notification_logs.valid_notification_type` CHECK to
>   accept `'approval_pending_digest'` (copying the list from 20260405 + one new
>   entry, same DROP + recreate idiom).
> - Phase 4 ships **seven** resolvers (not six): the original six plus
>   `getPendingApprovalRecords`, which powers the per-card "Details ▾" expander
>   in the UI.
> - Phase 6 polling uses `checkApprovalPending` (no leading underscore) to match
>   the naming of existing check methods in `notification-polling.js`.
> - **Phase 1.2 was reverted on 2026-04-22.** The approval gate is a *Jira-sync*
>   safety check, not a reporting gate. Filtering `pending_approval` rows out of
>   the daily/weekly/monthly summary views made totals look artificially low
>   without adding any safety (worklog sync is already blocked in
>   [worklogService.js](JIRAForge/forge-app/src/services/worklogService.js)).
>   See `supabase/migrations/20260422_revert_summaries_approval_filter.sql` —
>   the three views are restored to their 20260417 state.

## Context

Today, when the AI server classifies a captured activity record and picks a Jira issue ([activity-db-service.js:58-98](JIRAForge/ai-server/src/services/db/activity-db-service.js#L58)), the record is written with `user_assigned_issue_key` and `status = 'analyzed'`. From that moment, the hourly worklog sync in [scheduledWorklogSync.js](JIRAForge/forge-app/src/services/scheduledWorklogSync.js) (via [worklogService.js:96-98](JIRAForge/forge-app/src/services/worklogService.js#L96)) picks it up and **creates/updates a real Jira worklog with no user review**.

The user wants a human approval gate between those two steps:

1. Every AI-assigned record must be explicitly approved by the owning user before it syncs to Jira.
2. Records awaiting approval are shown grouped into sessions so users aren't forced to click every 5-minute row.
3. Until approval, the record is **blocked from Jira sync**.
4. Unapproved records stay pending indefinitely; users are notified (daily email digest) to keep the backlog visible.
5. Per-group actions available during review: **(a) Approve as-is**, **(b) Reassign to a different existing issue**, **(c) Create a brand-new issue and assign to it**. A Reject path is deferred — the user will decide its behavior later.
6. This feature is orthogonal to the existing `jira_worklog_sync_enabled` project toggle.

### Design invariant — purely additive

The existing `status` values (`pending`, `processing`, `analyzed`, `failed`) are hard-wired into summary views, worklog sync, retry logic, and tests. Rather than mutating that state machine, we add an **independent approval dimension** via one new nullable column:

```
approval_status ∈ { NULL, 'pending_approval', 'approved' }
```

(Only two non-null values for now; `'rejected'` is reserved for later.)

- `NULL` — record never needed approval (pre-existing rows, records with no AI-assigned issue key, manually-assigned rows). **Backward-compatible default.**
- `pending_approval` — AI auto-assigned an issue; user must approve before sync.
- `approved` — user approved (explicitly, or implicitly via manual assign).

Every existing query continues to work as-is. We *add* a filter in exactly one place — `aggregateUserTrackedTime` (Jira worklog sync) — that excludes rows where `approval_status = 'pending_approval'`. Rows with `approval_status IS NULL` are unaffected. The summary views (daily/weekly/monthly) are NOT filtered — they report all time the user actually worked, consistent with their role as time-reporting surfaces rather than Jira-safety gates.

### Migration discipline

**Every schema change lives in a new `YYYYMMDD_*.sql` migration file.** No existing migration is edited. The summary-view rebuild in Phase 1 follows the exact precedent set by the most recent view migration [20260417_exclude_idle_from_summaries.sql](JIRAForge/supabase/migrations/20260417_exclude_idle_from_summaries.sql), which itself DROPs and recreates the three views inside a new file — this is the established idiom in this repo.

---

## Phase 1 — Schema (three new migration files)

### 1.1 `supabase/migrations/20260421_add_approval_status.sql` (NEW)

```sql
-- Additive: new nullable column + partial index. No existing data touched.
ALTER TABLE public.activity_records
  ADD COLUMN IF NOT EXISTS approval_status TEXT
    CHECK (approval_status IS NULL OR approval_status IN ('pending_approval','approved')),
  ADD COLUMN IF NOT EXISTS approved_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_notes TEXT;

-- Hot query: "show me my pending approvals" — partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_activity_approval_pending
  ON public.activity_records(user_id, organization_id, start_time)
  WHERE approval_status = 'pending_approval';

COMMENT ON COLUMN public.activity_records.approval_status IS
  'Human review state for AI-assigned records: NULL (n/a), pending_approval, approved.';
```

### 1.2 `supabase/migrations/20260421_summaries_exclude_pending_approval.sql` (NEW — **REVERTED 2026-04-22**)

> **Status: reverted.** The filter described below was applied via 20260421 but
> then rolled back via `20260422_revert_summaries_approval_filter.sql`, which
> rebuilds the three views in their 20260417 state. The summary views now show
> all activity (including `pending_approval`) — approval is enforced only at
> Jira-sync time in [worklogService.js](JIRAForge/forge-app/src/services/worklogService.js).
> Rationale: summaries are time-reports, not sync gates; hiding unreviewed time
> made totals look artificially low without adding any real safety.

~~DROP + recreate `daily_time_summary`, `weekly_time_summary`, `monthly_time_summary`. The new migration copies verbatim from [20260417_exclude_idle_from_summaries.sql](JIRAForge/supabase/migrations/20260417_exclude_idle_from_summaries.sql) and adds ONE line inside each view's `activity_records` subquery:~~

```sql
WHERE act.status IN ('pending', 'processing', 'analyzed')
  AND act.work_date IS NOT NULL
  AND COALESCE(act.is_idle, false) = false
  AND LOWER(COALESCE(act.application_name, '')) NOT IN ('lockapp.exe', 'logonui.exe')
  AND COALESCE(act.approval_status, 'approved') <> 'pending_approval'   -- REVERTED
```

~~`COALESCE(..., 'approved')` means NULL stays visible (all historical data unaffected). Preserve `ALTER VIEW … SET (security_invoker = on)` for all three, same as 20260417.~~

### 1.3 `supabase/migrations/20260421_notification_preferences_approval.sql` (NEW)

```sql
-- Per-user opt-out flag. Named approval_pending_digest_enabled so the generic
-- notification-service lookup (`${type}_enabled`) resolves it automatically.
ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS approval_pending_digest_enabled BOOLEAN DEFAULT TRUE;

-- Extend notification_logs CHECK to accept the new type. Same DROP + recreate
-- idiom as 20260302 and 20260405; the list below copies 20260405's 7 values
-- verbatim and adds one new entry.
ALTER TABLE public.notification_logs
  DROP CONSTRAINT IF EXISTS valid_notification_type;

ALTER TABLE public.notification_logs
  ADD CONSTRAINT valid_notification_type CHECK (
    notification_type IN (
      'login_reminder',
      'download_reminder',
      'new_version',
      'inactivity_alert',
      'admin_inactivity_digest',
      'admin_download_digest',
      'default_password_reminder',
      'approval_pending_digest'
    )
  );
```

---

## Phase 2 — AI server stamps `pending_approval`

**Only** [ai-server/src/services/db/activity-db-service.js:81-88](JIRAForge/ai-server/src/services/db/activity-db-service.js#L81) changes. Modify the `updateData` object inside `updateActivityRecordAnalysis`:

```js
const updateData = {
  status: 'analyzed',
  user_assigned_issue_key: effectiveTaskKey,
  project_key: projectKey,
  metadata: analysisResult.metadata || {},
  analyzed_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  // NEW: if AI assigned an issue, require human approval.
  // If AI couldn't confidently pick one, leave NULL — the record falls into
  // the existing Unassigned Work panel, which is already a human-review surface.
  approval_status: effectiveTaskKey ? 'pending_approval' : null
};
```

No other writer sets `pending_approval`. `markBatchAnalyzed` and `markBatchFailed` don't assign an issue key, so they leave `approval_status` untouched (stays NULL).

**Test update:** [ai-server/tests/services/activity-db-service.test.js](JIRAForge/ai-server/tests/services/activity-db-service.test.js) — extend existing `updateActivityRecordAnalysis` tests to assert `approval_status: 'pending_approval'` when `taskKey` meets confidence, and `approval_status: null` otherwise. No test is being rewritten, only augmented.

> **Deployment ordering:** Phase 1 migrations MUST run before the Phase 2 code
> ships. If the code ships first, every `UPDATE activity_records` will fail with
> `column "approval_status" does not exist`. Deploy schema first, code second.

---

## Phase 3 — Block unapproved records from Jira sync

**Only** [forge-app/src/services/worklogService.js](JIRAForge/forge-app/src/services/worklogService.js) changes — two query strings.

### 3.1 `aggregateUserTrackedTime` ([line 96-98](JIRAForge/forge-app/src/services/worklogService.js#L96))

Append to the PostgREST filter:
```
&or=(approval_status.is.null,approval_status.neq.pending_approval)
```
Keeps rows that are `approved`, `rejected` (future), or NULL. Explicitly handles NULL because PostgREST `neq` alone treats NULL as unknown/false.

### 3.2 `aggregateUnassignedTimeWithFallback` ([line 168](JIRAForge/forge-app/src/services/worklogService.js#L168))

Same filter — defensive. This path handles records with `user_assigned_issue_key IS NULL`, which by our Phase 2 rule never carry `pending_approval` today, but future-proofing is cheap.

**Test update:** [forge-app/tests/services/worklogService.test.js](JIRAForge/forge-app/tests/services/worklogService.test.js) — add cases that seed pending-approval rows and assert they're excluded from the totals.

No other reader is touched. Analytics services ([userAnalyticsService](JIRAForge/forge-app/src/services/analytics/userAnalyticsService.js), [teamAnalyticsService](JIRAForge/forge-app/src/services/analytics/teamAnalyticsService.js), [issueQueryService](JIRAForge/forge-app/src/services/issue/issueQueryService.js)) roll up through the summary views already handled in Phase 1.2.

---

## Phase 4 — Resolvers for approval workflow

**New file:** `forge-app/src/resolvers/approval/approvalResolvers.js`. Registered in [forge-app/src/index.js](JIRAForge/forge-app/src/index.js) next to the existing `registerAssignmentResolvers` / `registerSessionResolvers` calls.

### 4.1 `getPendingApprovalGroups({ limit = 20, offset = 0, workDate?, fromDate?, toDate? })`

Fetches records and collapses them into session groups on the server (same 10-minute gap algorithm as [sessionResolvers.js:455-597](JIRAForge/forge-app/src/resolvers/unassigned/sessionResolvers.js#L455)).

```js
const rows = await supabaseRequest(cfg,
  `activity_records?user_id=eq.${userId}&approval_status=eq.pending_approval
   &select=id,user_assigned_issue_key,project_key,duration_seconds,
           start_time,end_time,window_title,application_name,work_date,metadata
   &order=start_time.asc&limit=1000`);
```

Group algorithm (in JS): walk sorted rows; start a new group when `next.user_assigned_issue_key !== prev.user_assigned_issue_key` OR `(next.start_time - prev.end_time) > 10 min`. Emit:
```ts
{
  groupKey: string,              // stable hash of (issueKey, startTime)
  issueKey: string,
  issueSummary: string,          // resolved via invoke('getIssueSummary') or cache
  projectKey: string,
  sessionIds: string[],          // all activity_records.id in the group
  startTime: iso, endTime: iso,
  totalSeconds: number,
  recordCount: number,
  workDate: 'YYYY-MM-DD',
  sampleWindowTitles: string[],  // top 3 most common from window_title
  sampleApps: string[],          // top 2 from application_name
  aiConfidence: number | null    // from first record's metadata.confidenceScore
}
```
Response: `{ success, groups, hasMore, totalGroups, nextOffset, pendingCountByDate }`.

`pendingCountByDate` is a cheap `{ 'YYYY-MM-DD': count }` map used by the UI date-picker.

### 4.2 `approveRecords({ sessionIds })`

```js
PATCH activity_records?id=in.(${ids})&user_id=eq.${userId}
      &approval_status=eq.pending_approval
Body: { approval_status: 'approved', approved_at: now, approved_by: userId }
```

The `&approval_status=eq.pending_approval` guard is critical: it makes the PATCH idempotent and race-safe. If the row was already approved by another tab, zero rows are affected and we return `{ success: true, updated: 0 }`.

### 4.3 `reassignAndApproveRecords({ sessionIds, newIssueKey, reason? })`

Reuses the shape of [worklogReassignmentService.js:52-55](JIRAForge/forge-app/src/services/worklogReassignmentService.js#L52):

```js
const newProjectKey = newIssueKey.split('-')[0];
PATCH activity_records?id=in.(${ids})&user_id=eq.${userId}
      &approval_status=eq.pending_approval
Body: {
  user_assigned_issue_key: newIssueKey,
  project_key: newProjectKey,
  reassigned_from: <batch-fetched current value>,
  reassigned_at: now,
  approval_status: 'approved',
  approved_at: now,
  approved_by: userId,
  approval_notes: reason || null
}
```

For the `reassigned_from` audit column: do one SELECT before the PATCH to capture the current issue keys, then write them into the update. If sessionIds span multiple original issue keys (unusual but possible), fan out per-original-key.

### 4.4 `createIssueAndApproveRecords({ sessionIds, issueSummary, issueDescription, projectKey, issueType, assigneeAccountId, assignToSelf, statusName })`

**Delegates to the existing** [createIssueAndAssignSelection](JIRAForge/forge-app/src/resolvers/unassigned/assignmentResolvers.js#L444) function body, with two adjustments:

1. Skip the "mark unassigned group as fully/partially assigned" block ([lines 564-586](JIRAForge/forge-app/src/resolvers/unassigned/assignmentResolvers.js#L564)) — these records aren't in `unassigned_group_members`; they're in `activity_records` directly.
2. After [updateSessionsAndAnalysis](JIRAForge/forge-app/src/resolvers/unassigned/assignmentResolvers.js#L554), run an additional PATCH that stamps `approval_status = 'approved'`, `approved_at`, `approved_by` on the same session IDs.

The Jira-issue-creation block (lines 484-531), the cache upsert (597-613), the `created_issues_log` insert (617-631), and the worklog creation (591-596) are **reused verbatim** to ensure identical behavior to the Unassigned Work "create new issue" path.

**Refactor opportunity** (optional, low risk): extract the common Jira-create-issue logic from `createIssueAndAssignSelection` into a helper like `createJiraIssueForSelection(opts)` so both resolvers share one implementation. If the refactor adds risk, skip it and copy the relevant block — the copy is ~50 lines and the duplication is acceptable for a zero-regression rollout.

### 4.5 `bulkApproveByDateRange({ fromDate, toDate })`

For users returning from leave with days of backlog. Server-side single-query PATCH:

```js
PATCH activity_records?user_id=eq.${userId}&approval_status=eq.pending_approval
      &work_date=gte.${fromDate}&work_date=lte.${toDate}
Body: { approval_status: 'approved', approved_at: now, approved_by: userId,
        approval_notes: 'Bulk approved by date range' }
```

Returns `{ success, updated }`. No ID list crosses the wire.

### 4.6 `getPendingApprovalCount()`

Cheap count for the sidebar badge. The actual implementation selects `id` with a generous `limit=10000` and returns `rows.length` — the partial index (`idx_activity_approval_pending`) keeps this sub-millisecond in practice and avoids the HEAD/Prefer:count=exact path that the thin PostgREST wrapper doesn't expose.

```js
GET activity_records?user_id=eq.${userId}&organization_id=eq.${orgId}
    &approval_status=eq.pending_approval&select=id&limit=10000
Returns: { success, count }
```

Called on mount and after every mutation in the UI to refresh the badge.

### 4.7 `getPendingApprovalRecords({ sessionIds })` — added during implementation

Returns the individual activity records behind a set of session IDs. Used by the per-card "Details ▾" expander to show timestamp / window_title / application_name / duration for each row and to drive the partial-approval UI.

```js
GET activity_records?id=in.(${ids})&user_id=eq.${userId}
    &approval_status=eq.pending_approval
    &select=id,start_time,end_time,duration_seconds,window_title,application_name,user_assigned_issue_key
    &order=start_time.asc
Returns: { success, records }
```

The `user_id` filter is load-bearing: even if a foreign session ID leaked in from the client, RLS + this filter ensure the caller only ever sees their own rows.

---

## Phase 5 — Frontend UI (thorough)

### 5.1 Sidebar entry with live badge

**File:** [forge-app/static/main/src/App.js](JIRAForge/forge-app/static/main/src/App.js) — insert a new `sidebar-item` directly after the "Unassigned Work" item at [line 170](JIRAForge/forge-app/static/main/src/App.js#L170):

```jsx
<button
  className={`sidebar-item ${activeTab === 'needs-review' ? 'active' : ''}`}
  onClick={() => setActiveTab('needs-review')}
  title="Needs Review"
>
  <span className="sidebar-icon">{/* CheckCircle icon SVG */}</span>
  {sidebarOpen && <span className="sidebar-label">Needs Review</span>}
  {sidebarOpen && pendingCount > 0 && (
    <span className="sidebar-badge sidebar-badge--warn">
      {pendingCount > 99 ? '99+' : pendingCount}
    </span>
  )}
</button>
```

Badge fetched via `invoke('getPendingApprovalCount')` on App mount, polled every 60s while the panel is open, and refreshed after every approval mutation. Badge styling: small pill (12px font, 18px height), background `var(--ds-background-warning-bold, #ff8b00)`, white text — matches Atlassian design tokens already used (see [UnassignedWork.css:3-7](JIRAForge/forge-app/static/main/src/components/UnassignedWork.css#L3)).

Collapsed-sidebar fallback: when `!sidebarOpen`, show a small badge overlaid on the icon's top-right (like macOS notification dots).

### 5.2 NeedsReview component — layout

**New files:**
- `forge-app/static/main/src/components/NeedsReview.js`
- `forge-app/static/main/src/components/NeedsReview.css`
- `forge-app/static/main/src/components/needs-review/ReviewGroupCard.js`
- `forge-app/static/main/src/components/needs-review/ReassignModal.js` (wraps existing issue picker)
- `forge-app/static/main/src/components/needs-review/CreateIssueModal.js` (wraps existing create form)
- `forge-app/static/main/src/components/needs-review/BulkActionBar.js`
- `forge-app/static/main/src/components/needs-review/EmptyState.js`

**Page layout** (top → bottom):

```
┌─────────────────────────────────────────────────────────────────┐
│  Needs Review                                   [?] help icon   │
│  Review and approve AI-assigned time before it syncs to Jira    │
├─────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  📊 Summary strip                                          │ │
│  │  12 sessions pending · 4h 32m total · oldest: 3 days ago  │ │
│  └────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Filters:  [Date ▼ All dates]   [Project ▼ All]   [Search 🔍]  │
│  Bulk:     [☐ Select all]   [Approve all for <date>]           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  📅 Today — 2026-04-20 (3 sessions, 2h 10m)                    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ☐  PROJ-123  "Implement auth middleware"                │   │
│  │    10:00 AM – 11:15 AM · 1h 15m · 14 records            │   │
│  │    AI confidence: 0.87 ●●●●○                            │   │
│  │    Apps: code.exe, chrome.exe                           │   │
│  │    "Cursor: src/auth/middleware.ts"                     │   │
│  │    "GitHub PR #842 — auth refactor"                     │   │
│  │    ┌─────────┬───────────┬────────────────┬──────────┐  │   │
│  │    │ Approve │ Reassign… │ Create issue… │ Details ▾│  │   │
│  │    └─────────┴───────────┴────────────────┴──────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ☐  PROJ-45   …                                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  📅 Yesterday — 2026-04-19 (9 sessions, 2h 22m)                │
│  ...                                                            │
│                                                                 │
│  [Load more]                                                    │
└─────────────────────────────────────────────────────────────────┘
```

**When any card is selected**, a sticky BulkActionBar slides up from the bottom:

```
┌─────────────────────────────────────────────────────────────────┐
│  3 selected · 1h 45m total                                     │
│  [Approve selected]  [Reassign…]  [Create issue…]  [Clear]     │
└─────────────────────────────────────────────────────────────────┘
```

### 5.3 ReviewGroupCard — per-card detail

Matches the visual vocabulary of [GroupAccordion](JIRAForge/forge-app/static/main/src/components/unassigned/GroupAccordion.js) but with approve-oriented affordances.

Fields displayed:
- **Checkbox** (left) for multi-select. Styled as Atlassian-like `[☐]` / `[✓]`.
- **Issue key** as a deep link to the Jira issue (opens in new tab). Format: `<a>PROJ-123</a> <span class="issue-summary">"Implement auth middleware"</span>`. Summary comes from `invoke('getIssueSummary', { issueKey })` batched at component level.
- **Time range:** `10:00 AM – 11:15 AM` in the user's locale (use `Intl.DateTimeFormat`). Duration formatted as `1h 15m`.
- **Record count:** `14 records` — tiny muted text.
- **AI confidence meter:** 5-dot meter (●●●●○) + numeric value, tooltip: "Confidence this record belongs to PROJ-123. Low confidence means the AI was uncertain; please double-check."
- **Context lines:** up to 2 sample window titles (truncated at 60 chars with `…`), in monospace muted style.
- **App icons/names:** up to 2 application names as chip pills.
- **Action row:** three primary buttons + a "Details ▾" expander.

Button spec:

| Button | Color | Action |
|---|---|---|
| **Approve** | Primary (green/brand) — `background: var(--ds-background-success, #36b37e)` | Calls `invoke('approveRecords', { sessionIds })`. Optimistic UI: card fades + disappears. On error: restore + toast. |
| **Reassign…** | Secondary | Opens ReassignModal. |
| **Create issue…** | Secondary outline | Opens CreateIssueModal. |
| **Details ▾** | Tertiary / link-style | Expands the card in-place to show the full record list: one row per activity_record with timestamp, window_title, app_name, duration. Allows **partial approval** — per-record checkboxes and a "Approve selected records" mini-button at the bottom of the expanded view, which calls `approveRecords` with a subset of `sessionIds`. Data loaded lazily via `invoke('getPendingApprovalRecords', { sessionIds })`. |

All buttons: min-height 32px, 14px font, keyboard accessible (Enter/Space), proper `aria-label` and `aria-busy` states during invoke.

### 5.4 ReassignModal

**Reuses the `<select>` issue picker pattern from** [AssignmentModal.js:213-230](JIRAForge/forge-app/static/main/src/components/unassigned/AssignmentModal.js#L213). Data source: `invoke('getAllUserAssignedIssues')`, already loaded at the panel level and passed down as a prop.

Structure:
```
┌─ Modal ─────────────────────────────────────────┐
│  Reassign 14 records (1h 15m)                   │
│  Currently assigned to: PROJ-123                │
│  ─────────────────────────────────────────────  │
│  Reassign to:                                   │
│  ┌───────────────────────────────────────────┐  │
│  │ Search issues… 🔍                         │  │
│  └───────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────┐  │
│  │ PROJ-45:  "Fix auth token refresh"     ○ │  │
│  │ PROJ-78:  "Write middleware tests"     ● │  │
│  │ PROJ-91:  "Update API docs"            ○ │  │
│  │ ... (up to 50 most recent issues)         │  │
│  └───────────────────────────────────────────┘  │
│  Optional note (visible in audit log):          │
│  [                                          ]   │
│  ─────────────────────────────────────────────  │
│                         [Cancel]  [Reassign]    │
└─────────────────────────────────────────────────┘
```

- Uses a searchable list (client-side filter on the pre-loaded `userIssues`). No server round-trip per keystroke.
- Radio-select style (one issue at a time).
- "Reassign" button disabled until a selection is made.
- On submit: call `invoke('reassignAndApproveRecords', { sessionIds, newIssueKey, reason })`. Modal shows a spinner; on success, modal closes, card fades out, count decrements, success toast `"14 records reassigned to PROJ-78"`.
- Escape key and backdrop click close the modal (same pattern as `AssignmentModal`).

### 5.5 CreateIssueModal

Reuses the entire create-issue form from [AssignmentModal.js](JIRAForge/forge-app/static/main/src/components/unassigned/AssignmentModal.js) — lift it into a shared `CreateIssueForm` component used by both Unassigned Work (existing) and Needs Review (new).

Form fields:
- **Project** (dropdown, from `userProjects`)
- **Issue type** (Task / Story / Bug, from Jira metadata for the selected project)
- **Summary** (required, 255 chars, inline validation)
- **Description** (textarea, auto-populated with a helpful default: `"Work performed across 14 records from 2026-04-20, totaling 1h 15m. Imported from time tracking."`)
- **Status** (optional dropdown — "To Do" default; uses `getIssueTransitions`)
- **Assignee** (defaults to self, can be overridden for delegation)

Submit → `invoke('createIssueAndApproveRecords', { sessionIds, ...formFields })`. On success: modal closes, card disappears, success toast `"Issue PROJ-212 created and assigned"` with a link to the new issue. Badge count decrements.

### 5.6 Filters & bulk actions

- **Date filter** — segmented control with quick options: `Today | Yesterday | This week | All` + a custom date-picker. Updates URL query string `?tab=needs-review&from=YYYY-MM-DD&to=YYYY-MM-DD`. Invokes `getPendingApprovalGroups` with the range.
- **Project filter** — dropdown populated from distinct `project_key` values in the loaded set. Client-side filter on the already-fetched groups (no re-query).
- **Search** — client-side filter on `issueKey`, `issueSummary`, and `sampleWindowTitles`.
- **"Approve all for \[date\]"** — primary button next to the date filter. Opens a confirmation dialog showing count and total time. On confirm: `invoke('bulkApproveByDateRange', { fromDate, toDate })`. Only enabled when a bounded date range is selected (not "All dates") to prevent accidental approve-everything.

### 5.7 Loading / empty / error states

- **Initial load:** 3 skeleton cards (animated shimmer). Respect `prefers-reduced-motion`.
- **Empty (zero pending):** centered illustration + copy: "🎉 All caught up! When the AI assigns time to issues, you'll review it here before it syncs to Jira."
- **Error:** inline banner with retry — never a blank page.
- **Optimistic approve:** card gets `.approving` class (opacity 0.5, spinner overlay) → fade-out → remove from DOM. On failure, restore + red toast.
- **Network failure:** toast "Couldn't approve right now — please try again." Card returns to idle state.

### 5.8 Accessibility

- All buttons have descriptive `aria-label`s (e.g., "Approve 14 records assigned to PROJ-123 totaling 1 hour 15 minutes").
- Keyboard support: Tab moves between cards, `Space` toggles checkbox, `A` approves focused card (with tooltip hint).
- Focus trap within modals; Esc closes.
- Color-contrast-safe: the AI-confidence dots double as numeric text (not color-only).
- Screen-reader announcement after every mutation: `aria-live="polite"` region reporting "14 records approved. 11 remaining."

### 5.9 Copy / microcopy

- Sidebar label: **Needs Review** (not "Approval Queue" — friendlier)
- Page header: **"Needs Review"** with subtitle **"Review AI-assigned time before it syncs to Jira."**
- Approve button tooltip: **"Approve — time will sync to Jira on the next hourly sync."**
- Reassign tooltip: **"The AI's issue pick wasn't right — pick a different one."**
- Create-issue tooltip: **"The right issue doesn't exist yet — create one now."**
- Empty state: friendly, not patronizing.

### 5.10 Settings toggle

**File:** `forge-app/static/settings/src/...` (admin settings app).

Add a user-level preference **"Require approval for AI-assigned time"** (default ON) under the existing tracking-settings UI. When OFF: Phase 2 writes `approval_status = 'approved'` directly, restoring the zero-touch flow. The setting lives in `notification_preferences.approval_pending_digest_enabled` OR a new row (whichever column lands cleanest) — pick during implementation after reading `notification_preferences` in detail. A small resolver `getApprovalPreference` / `setApprovalPreference` exposes it to the settings UI.

> **Status:** Settings toggle is **deferred** — feature ships with approval always
> required. The Phase 1.1 column layout supports it and the kill-switch SQL in
> guarantee #9 below is the interim workaround.

---

## Phase 6 — Email digest notification

### 6.1 Template

**New file:** `ai-server/src/services/notifications/templates/approval-pending-digest.js`

Modeled on [admin-download-digest.js](JIRAForge/ai-server/src/services/notifications/templates/admin-download-digest.js). Subject function + HTML/text bodies.

```js
subject: ({ pendingCount }) =>
  `${pendingCount} time ${pendingCount === 1 ? 'entry needs' : 'entries need'} your review`,

text: ({ displayName, pendingCount, oldestDate, totalHours, panelUrl }) => `
Hi ${displayName},

The AI has assigned time to ${pendingCount} work session${pendingCount === 1 ? '' : 's'}
(${totalHours}) that need your review before they sync to Jira.

Oldest pending: ${oldestDate}

Review and approve here: ${panelUrl}

You're receiving this digest once per day while you have pending reviews.
`,
// plus HTML with a table by-date and a primary CTA button.
```

Registered in `ai-server/src/services/notifications/templates/index.js` with key `approval_pending_digest`.

### 6.2 Polling extension

**Modify** [ai-server/src/services/notifications/notification-polling.js](JIRAForge/ai-server/src/services/notifications/notification-polling.js) — add `checkApprovalPending()` to the cycle, called alongside existing checks inside `runAllChecks()`'s `Promise.allSettled` so its failure cannot take down other checks.

```js
async checkApprovalPending() {
  const minAgeHours = Number.parseFloat(process.env.APPROVAL_PENDING_MIN_AGE_HOURS || '4');
  const cutoff = new Date(Date.now() - minAgeHours * 3600 * 1000).toISOString();

  const { data: pending } = await supabase
    .from('activity_records')
    .select('user_id, organization_id, duration_seconds, work_date, analyzed_at')
    .eq('approval_status', 'pending_approval')
    .lt('analyzed_at', cutoff)
    .limit(10000);

  const byUser = this._aggregatePendingApproval(pending);   // per-user summary
  let sentCount = 0;
  for (const [userId, summary] of byUser) {
    if (sentCount >= MAX_EMAILS_PER_CYCLE) break;
    if (!(await this._isWithinWorkHours(userId))) continue;

    await notificationService.sendNotification(
      userId, summary.organizationId, 'approval_pending_digest',
      {
        pendingCount: summary.count,
        totalHours: this._formatDurationShort(summary.totalSeconds),
        oldestDate: summary.oldestDate,
        byDate: summary.byDate,
        panelUrl: await this._buildApprovalPanelUrl(summary.organizationId),
        _cooldownHours: 24
      }
    );
    sentCount++;
  }
  this.stats.notificationsSent.approval_pending_digest += sentCount;
}
```

The existing notification-service stack handles per-user `approval_pending_digest_enabled` preference (added in Phase 1.3), cooldowns, and the 50-per-cycle cap. Work-hours gate reuses `_isWithinWorkHours(userId)`.

---

## Critical Files Summary

| # | File | Change type |
|---|------|---|
| 1 | `supabase/migrations/20260421_add_approval_status.sql` | NEW migration |
| 2 | `supabase/migrations/20260421_summaries_exclude_pending_approval.sql` | NEW migration (DROP + recreate views) — **reverted by file #23** |
| 3 | `supabase/migrations/20260421_notification_preferences_approval.sql` | NEW migration (new column + CHECK extension) |
| 4 | [ai-server/src/services/db/activity-db-service.js:81-93](JIRAForge/ai-server/src/services/db/activity-db-service.js#L81) | Edit 1 object |
| 5 | [ai-server/tests/services/activity-db-service.test.js](JIRAForge/ai-server/tests/services/activity-db-service.test.js) | Augment tests |
| 6 | [forge-app/src/services/worklogService.js:98-101](JIRAForge/forge-app/src/services/worklogService.js#L98) | Append filter |
| 7 | [forge-app/src/services/worklogService.js:173-175](JIRAForge/forge-app/src/services/worklogService.js#L173) | Append filter |
| 8 | [forge-app/tests/services/worklogService.test.js](JIRAForge/forge-app/tests/services/worklogService.test.js) | Augment tests |
| 9 | `forge-app/src/resolvers/approval/approvalResolvers.js` | NEW (7 resolvers) |
| 10 | [forge-app/src/index.js](JIRAForge/forge-app/src/index.js) | Register resolver group |
| 11 | `forge-app/tests/services/approvalResolvers.test.js` | NEW unit tests |
| 12 | `forge-app/static/main/src/components/NeedsReview.js` + `.css` | NEW page |
| 13 | `forge-app/static/main/src/components/needs-review/ReviewGroupCard.js` | NEW |
| 14 | `forge-app/static/main/src/components/needs-review/ReassignModal.js` | NEW |
| 15 | `forge-app/static/main/src/components/needs-review/CreateIssueModal.js` | NEW |
| 16 | `forge-app/static/main/src/components/needs-review/BulkActionBar.js` | NEW |
| 17 | `forge-app/static/main/src/components/needs-review/EmptyState.js` | NEW |
| 18 | [forge-app/static/main/src/App.js](JIRAForge/forge-app/static/main/src/App.js) | Add sidebar item + route + polling |
| 19 | [forge-app/static/main/src/components/common/Sidebar.css](JIRAForge/forge-app/static/main/src/components/common/Sidebar.css) | Add badge styles |
| 20 | `ai-server/src/services/notifications/templates/approval-pending-digest.js` | NEW template |
| 21 | [ai-server/src/services/notifications/templates/index.js](JIRAForge/ai-server/src/services/notifications/templates/index.js) | Register template |
| 22 | [ai-server/src/services/notifications/notification-polling.js](JIRAForge/ai-server/src/services/notifications/notification-polling.js) | Add `checkApprovalPending` |
| 23 | `supabase/migrations/20260422_revert_summaries_approval_filter.sql` | NEW migration — reverts file #2, rebuilds views to 20260417 state |
| 24 | `forge-app/static/settings/src/...` (deferred) | Preference toggle |

**Unchanged (no edits):**
`scheduledWorklogSync.js`, `workAssignmentService.js`, `worklogReassignmentService.js`, all assignment/session resolvers, all analytics services, all existing React components, `activity-webhook/index.ts`, the Python desktop app, every existing migration file.

---

## Existing Utilities to Reuse

- Session grouping (10-min gap): algorithm from [sessionResolvers.js:455-597](JIRAForge/forge-app/src/resolvers/unassigned/sessionResolvers.js#L455).
- Jira issue creation + cache upsert + `created_issues_log` + worklog: reuse blocks from [createIssueAndAssignSelection](JIRAForge/forge-app/src/resolvers/unassigned/assignmentResolvers.js#L444).
- User issue picker data: existing `invoke('getAllUserAssignedIssues')`.
- Create-issue form: lift from [AssignmentModal.js](JIRAForge/forge-app/static/main/src/components/unassigned/AssignmentModal.js) into shared component.
- Issue-select dropdown: same component, same props.
- Notification send / cooldown / work-hours / daily cap: existing [notification-service.js:58](JIRAForge/ai-server/src/services/notifications/notification-service.js#L58).
- RLS + `user_id=eq.${userId}` PATCH guard: pattern from [workAssignmentService.js:116](JIRAForge/forge-app/src/services/workAssignmentService.js#L116).
- Design tokens / CSS variables: `var(--ds-*)` vars already used in [UnassignedWork.css](JIRAForge/forge-app/static/main/src/components/UnassignedWork.css).

---

## Zero-Regression Guarantees

1. **No existing migration file is edited.** Every schema change lands in a new `20260421_*.sql` file.
2. **`activity_records` schema change is purely additive.** New nullable column + new indexes + new timestamp/note columns. No existing constraint is altered. No trigger is changed.
3. **`status` state machine untouched.** Every existing reader of `status` keeps working exactly as before.
4. **Summary views:** the new filter is `COALESCE(approval_status, 'approved') <> 'pending_approval'`. Rows with `approval_status = NULL` evaluate to `'approved'` and pass — **historical data totals are byte-identical**.
5. **Worklog sync filter** only hides NEW AI-assigned records awaiting approval. Historical rows (NULL) and manual-assignment rows (NULL) keep syncing.
6. **Manual assignment via Unassigned Work panel:** unchanged code path. Those writers don't touch `approval_status`, so it stays NULL → "skip review" → instant sync, preserving current UX.
7. **Reassignment via existing panel:** unchanged. The new approval-panel reassignment is a separate resolver.
8. **Tests:** new tests are additive. Only two existing test files are augmented (`activity-db-service.test.js`, `worklogService.test.js`) — no rewrites.
9. **Instant kill-switch:** if anything goes wrong post-deploy, a single SQL — `UPDATE activity_records SET approval_status='approved' WHERE approval_status='pending_approval'` — plus reverting Phase 2 returns the system to pre-feature state without touching the schema.
10. **Feature rollout can be flagged off per user** via the Phase 5.10 settings toggle: default ON for new installs, can be flipped OFF globally by admin. (Toggle deferred; kill-switch SQL is the interim path.)

---

## Verification Plan

### Automated
- `cd ai-server && npm test` — passes including new cases in `activity-db-service.test.js`.
- `cd forge-app && npm test` — passes including new `approvalResolvers.test.js` and augmented `worklogService.test.js`.
- `cd forge-app && npm run build` — React build compiles cleanly.
- `supabase db reset` locally — migrations replay, views rebuild, no constraint violations.

### Manual end-to-end on a dev tenant

1. Pre-flight: note current counts from `SELECT COUNT(*) FROM activity_records WHERE status='analyzed' AND user_assigned_issue_key IS NOT NULL` and from `daily_time_summary`. After deployment of migrations only (Phase 1), re-run — both must be unchanged (NULL `approval_status` passes the filter).
2. Deploy Phase 2 to the AI server in staging. Capture a fresh desktop activity that the AI can confidently match to an existing issue.
3. Verify row: `status='analyzed'`, `user_assigned_issue_key='PROJ-X'`, `approval_status='pending_approval'`.
4. Trigger `scheduledWorklogSync` via Forge CLI / test harness. **Assert Jira does NOT receive a worklog for that issue.**
5. Deploy Phase 4 + 5 to the Forge app. Open the panel → Needs Review tab → the group appears.
6. **Approve path:** click Approve. Row flips to `approval_status='approved'`. Re-trigger sync → Jira receives the worklog.
7. **Reassign path:** seed another pending row. Click Reassign → pick a different issue → submit. Row updated: `user_assigned_issue_key` changed, `reassigned_from` set, `approval_status='approved'`. Sync → Jira receives worklog on the NEW issue.
8. **Create-issue path:** seed a third pending row. Click Create issue → fill the form → submit. New issue appears in Jira; row points at the new key; `approval_status='approved'`. Sync → worklog on the new issue.
9. **Bulk approve by date:** seed 30 rows across 2 days. Approve-all-for-yesterday → exactly 15 flip. Verify count delta.
10. **Badge + polling:** approve a record from a second tab; within 60s the original tab's sidebar badge decrements.
11. **Notification:** leave a row pending for >4h. Trigger a polling cycle (or reduce threshold temporarily). Confirm digest email arrives, cooldown honored on a re-trigger within 24h.
12. **Regression sweep:** open Unassigned Work, Time Analytics, Team Analytics, My Focus — totals for rows with `approval_status='approved'` or NULL match pre-feature baseline. Rows `pending_approval` are excluded from summaries but visible in Needs Review.
13. **Settings toggle:** (deferred) turn the preference OFF for one user → new AI-assigned rows for that user get `approval_status='approved'` immediately, skipping the panel. Toggle back ON → new rows require review again.

### Rollback drill
- Revert Phase 2 on the AI server; run the one-line SQL from guarantee #9. System returns to pre-feature behavior within one sync cycle. Keep schema + sidebar entry in place (harmless).

---

## Deferred (Explicitly Out of Scope)

- **Reject action** — user will return with requirements. Column `approval_status` already reserves room; a future `'rejected'` value can be added via a new migration that extends the CHECK constraint.
- **Settings toggle (Phase 5.10)** — shipped feature always requires approval; use the kill-switch SQL if a global opt-out is ever needed.
- Admin/manager approval of other users' time.
- In-app push notifications (only email digest per existing infra).
- Retroactive approval requirement for historical rows (stay NULL → pre-approved).
- Auto-approval timeout.

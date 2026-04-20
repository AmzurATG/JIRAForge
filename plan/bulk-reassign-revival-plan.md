# Bulk Reassign Revival Plan

**Status:** Approved scope — implementation pending
**Date:** 2026-04-19
**Author:** Vishnu (with Claude)
**Goal:** Re-enable the previously hidden "Bulk Time Edit" feature on the Unassigned Work page, rewritten to use **only** the new `activity_records` pipeline. Drop all legacy `analysis_results` / `unassigned_activity` code paths from the two bulk resolvers.

---

## 1. Background

The bulk reassign feature lets a user pick a date + start/end time on the Unassigned Work page and reassign **all** activities in that window (both currently-tracked and unassigned) to a single Jira issue, optionally creating a worklog.

### 1.1 What's already in place
| Layer | Location | State |
|---|---|---|
| Backend resolver — preview | [assignmentResolvers.js:501](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L501) | Present, registered |
| Backend resolver — apply | [assignmentResolvers.js:614](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L614) | Present, registered |
| UI component | [BulkEditModal.js](../forge-app/static/main/src/components/unassigned/BulkEditModal.js) | 315 lines, fully wired |
| Entry button | [UnassignedWork.js:266-276](../forge-app/static/main/src/components/UnassignedWork.js#L266-L276) | JSX present |
| **CSS hide** | [UnassignedWork.css:318-321](../forge-app/static/main/src/components/UnassignedWork.css#L318-L321) | `display: none !important` |

### 1.2 Why it was hidden
Not recorded. We are reviving it because users have asked for it again.

### 1.3 What changed under it
The data model migrated from per-screenshot rows (`screenshots` + `analysis_results`) to **aggregated** activity records:

- One `activity_records` row = one window+app session within a batch
- `start_time` = first time the window came to focus
- `end_time` = last time the window was active
- `total_time_seconds` = **sum of focused time across visits** (truth)
- `visit_count` = number of times window was activated
- `duration_seconds` = wall-clock span (may be NULL for aggregated records)

Schema source: [20260221_add_activity_records.sql](../supabase/migrations/20260221_add_activity_records.sql). Aggregation behaviour: [desktop_app.py:3859-3916](../python-desktop-app/desktop_app.py#L3859-L3916).

The desktop app already stopped uploading screenshots ([desktop_app.py:339](../python-desktop-app/desktop_app.py#L339): `SCREENSHOT_MONITORING_HARD_DISABLED = True`). The legacy tables still exist and are still read by other features for historical data display, but **bulk reassign will no longer touch them**.

---

## 2. Scope Decision

**Approved:** Drop the legacy code path from bulk reassign entirely. Single source of truth = `activity_records`. Other features that read legacy tables for historical display are out of scope for this work.

**Not in scope (deferred):**
- Removing legacy reads from other features (analytics, dashboard, fullscreen viewer, feedback modal).
- Dropping the legacy tables themselves.
- Migrating historical screenshot-era data into the new schema.

These can be a separate cleanup project later. Today's job is to ship a clean, correct bulk reassign feature.

---

## 3. Issues to Fix (Priority Order)

### P0 — Correctness (must fix before re-enable)

#### 3.1 Strip the legacy branch
**Where:** [assignmentResolvers.js:540-575, 654-773](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L540)
**Action:**
- Delete the `analysis_results` query in `previewBulkReassign` and the legacy formatting/merge.
- Delete the entire `legacyActivitiesInRange` PATCH branch in `bulkReassignByTimeInterval`, including the cascading `unassigned_activity` PATCH and the `unassigned_work_groups` mark.
- Single source = `activity_records`.

**Acceptance:** Both resolvers contain zero references to `analysis_results`, `unassigned_activity`, `unassigned_work_groups`, or `screenshots`. `filterActivitiesByTimeRange` import removed if unused after.

#### 3.2 Wrong duration field priority
**Where:** [assignmentResolvers.js:555](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L555), [665](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L665)
**Bug:** `a.duration_seconds || a.total_time_seconds || 0` prefers the wall-clock span over the focused-time aggregate. For aggregated records this inflates totals.
**Fix:** Swap to `a.total_time_seconds || a.duration_seconds || 0`.
**Acceptance:** Preview total equals the sum a user would see in DayView for the same range.

#### 3.3 Time-window filter incoherent for aggregated records
**Where:** [assignmentResolvers.js:535](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L535), [651](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L651)
**Bug:** Filter is `start_time>=W_start AND end_time<=W_end` (containment). An aggregated record spanning 09:30–17:10 with 35 min of focus time:
- Window 10:00–17:00 → record dropped (start<10:00) → user loses 25 min that genuinely fell in window.
- Window 09:00–18:00 → record included with all 35 min, even bursts outside.

**Fix:** Switch to overlap semantics `start_time < W_end AND end_time > W_start`. For each overlapping record, **pro-rate** the time:
```
overlap_ratio = max(0, min(end_time, W_end) - max(start_time, W_start)) / (end_time - start_time)
attributed_seconds = round(total_time_seconds * overlap_ratio)
```
**Apply path:** Apply must use the same record set the preview showed. The PATCH still updates the full record (we can't split rows), so the worklog total = sum of pro-rated seconds. UI shows a notice when any record partially falls outside the window: "X activities partially fall outside the window — pro-rated time will be logged. Activities will be fully reassigned to the target issue."

**Acceptance:** Preview totals match overlap+pro-rate math. Worklog uses pro-rated total. UI shows the pro-rate notice when applicable.

#### 3.4 NULL `end_time` records dropped
**Where:** Same lines as 3.3.
**Bug:** PostgreSQL `NULL <= X` returns NULL (≈false), so any in-progress or improperly-closed record is invisible to bulk.
**Fix:** Treat NULL `end_time` as "open" — include if `start_time < W_end`. Use `start_time + total_time_seconds` as a proxy end for pro-rate math, or count as fully attributed if no other data available.
**Acceptance:** Inserting a test row with NULL end_time appears in preview if its start falls in window.

#### 3.5 Multi-tenancy defense-in-depth on PATCH
**Where:** [assignmentResolvers.js:687](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L687)
**Bug:** PATCH filters only by `id=in.(...)`. IDs come from a tenant-scoped query so it's safe today, but any future query change could leak across tenants.
**Fix:** Add `&user_id=eq.${userId}&organization_id=eq.${organization.id}` to the PATCH URL.
**Acceptance:** Code review — the bulk PATCH carries user+org filters.

---

### P1 — UX correctness (should fix before re-enable)

#### 3.6 No `clustering_dismissed` filter
**Where:** [assignmentResolvers.js:535](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L535)
**Bug:** Records the user has already dismissed via the unassigned UI re-appear in bulk preview. (Compare to [sessionResolvers.js:107](../forge-app/src/resolvers/unassigned/sessionResolvers.js#L107) which does filter.)
**Fix:** Add `&clustering_dismissed=eq.false` to the `activity_records` query.
**Acceptance:** Dismiss a group, run bulk preview for its time range — its activities don't appear.

#### 3.7 Cross-midnight not supported
**Where:** [BulkEditModal.js:40](../forge-app/static/main/src/components/unassigned/BulkEditModal.js#L40), [assignmentResolvers.js:527](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L527)
**Bug:** `endTime <= startTime` produces an empty range silently. Common case: night-shift workers (22:00 → 02:00).
**Fix (minimal):** UI validation — if `endTime <= startTime`, show inline error "End time must be after start time on the same day." Document scope: bulk operates on a single date.
**Acceptance:** Modal blocks the apply button with a clear error message.

#### 3.8 No target-issue validation
**Where:** [assignmentResolvers.js:614](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L614)
**Bug:** Bulk skips the access/transition check that single-issue assign does. User could reassign 200 activities to a closed/inaccessible issue and discover the failure only when worklog creation fails.
**Fix:** Before the PATCH, call `api.asUser().requestJira(/rest/api/3/issue/${targetIssueKey})` — if not 200, return `{success:false, error:'Cannot access target issue'}`. If status category is "done", return a warning the UI can surface as a confirm dialog.
**Acceptance:** Selecting a closed/inaccessible issue blocks (or confirms) before any DB write.

---

### P2 — Audit & polish (nice to have)

#### 3.9 Audit trail
**Where:** [assignmentResolvers.js:687-696](../forge-app/src/resolvers/unassigned/assignmentResolvers.js#L687-L696)
**Observation:** Migration [20260417_add_unassigned_conversion_columns.sql](../supabase/migrations/20260417_add_unassigned_conversion_columns.sql) added `conversion_reason` + `converted_at`. Bulk doesn't write either, and the modal has no reason input.
**Proposal:** Add an optional "Reason" textarea (max 500 chars) to `BulkEditModal`. Pass `reason` through. PATCH activity_records with `conversion_reason: reason`, `converted_at: now()`.
**Decision:** Skip for v1 unless explicitly requested. Can add later without schema change.

#### 3.10 Re-enable the button (CSS)
**Where:** [UnassignedWork.css:318-321](../forge-app/static/main/src/components/UnassignedWork.css#L318-L321)
**Fix:** Remove the `display: none !important` block. Replace with proper button styles matching the header row layout. Visually verify alignment alongside the notification clock button.

---

## 4. Implementation Steps

In order:

1. **Branch + read-through** — confirm no other consumer of bulk resolvers exists (it shouldn't — Forge resolvers are internal).
2. **3.1** — strip legacy branches from both resolvers. Largest diff (~150 LOC removed).
3. **3.2** — swap duration field priority. Trivial.
4. **3.5** — add user/org filters to PATCH URL. Trivial.
5. **3.6** — add `clustering_dismissed=eq.false` filter. Trivial.
6. **3.4** — NULL end_time handling in the query.
7. **3.3** — overlap window + pro-rate math.
   - Update `previewBulkReassign` query to overlap semantics.
   - Add pro-rate helper in shared utils.
   - Return per-activity `attributed_seconds` and `partial: boolean` flags in the preview payload.
   - Wire UI to show partial-record badges and a top-line warning.
   - Update `bulkReassignByTimeInterval` to use the same query and sum pro-rated seconds for the worklog.
8. **3.7** — UI validation for cross-midnight in `BulkEditModal`.
9. **3.8** — target issue access check in `bulkReassignByTimeInterval`.
10. **3.10** — remove CSS hide.
11. **QA** (see §5).
12. **Forge deploy** to dev → production.

---

## 5. Testing Plan

### 5.1 Unit tests (forge-app/tests)
- `previewBulkReassign` returns expected counts and totals for:
  - Empty range
  - Range fully contained inside an activity record (pro-rate verification)
  - Range covering whole record (full attribution)
  - Records with NULL end_time
  - Dismissed records (excluded)
- Time-format and date-format validation rejects bad input.
- Cross-midnight rejected at UI; resolver also defends.
- No queries against `analysis_results`, `unassigned_activity`, or `screenshots` exist in either resolver.

### 5.2 Integration / manual QA
Set up a test user with:
- New activity_records rows with varied `total_time_seconds` vs span
- One in-progress record (NULL end_time)
- A dismissed group

Then exercise:
1. Preview at narrow window inside a long-running record → expect pro-rated time + partial badge.
2. Preview at wide window covering whole record → expect full `total_time_seconds`.
3. Apply to an open issue → worklog created with pro-rated total.
4. Apply to a closed issue → block or confirm.
5. Apply to inaccessible issue → blocked.
6. Apply with worklog checkbox off → no worklog, only DB updated.
7. Cross-midnight → UI blocks.
8. Verify activity_records PATCHed correctly (correct user_assigned_issue_key, project_key) — no other tables modified.

### 5.3 Regression checks
- Single-group `assignToExistingIssue` flow still works (shared helpers untouched).
- Day View / timeline conversion not affected.
- DayView totals match bulk preview totals for the same range.
- Unassigned Work page still loads old groups (legacy data still visible elsewhere — only bulk feature changed).
- Analytics summary views still show historical data correctly.

---

## 6. Out of Scope / Deferred

- Multi-day bulk reassign (cross-midnight beyond a single day).
- Multi-select on groups (a different "bulk assign" UX).
- Pro-rate using per-visit data — would require a new `activity_record_visits` table.
- Splitting `activity_records` rows at the window boundary.
- Removing legacy reads from other features.
- Dropping legacy tables.

---

## 7. Open Decisions

| # | Question | Owner | Default if unresolved |
|---|---|---|---|
| D1 | Pro-rate or warn-and-skip partial records? | Vishnu | Pro-rate (matches DayView) |
| D2 | Add a reason textarea (3.9)? | Vishnu | Skip for v1 |
| D3 | NULL end_time records — pro-rate using `start + total_time_seconds`, or fully attribute? | Vishnu | Pro-rate using `start + total_time_seconds` as proxy end |

---

## 8. Rollout

1. Deploy to Forge dev environment.
2. Verify with at least one test user across the QA cases.
3. Deploy to production.
4. Watch forge-app logs for `[previewBulkReassign]` / `[bulkReassignByTimeInterval]` errors for one week.
5. Announce in release notes.

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pro-rate math under-counts focused time vs user intuition | Med | Med | Document the math in the modal tooltip; warn on partial records |
| Bulk PATCH on large date ranges times out | Low | High | Cap activity count at preview (e.g., 500); refuse apply above threshold |
| User reassigns to wrong issue at scale | Med | High | Confirm dialog showing target issue + count before apply |
| Worklog double-write if user clicks twice | Low | Med | Disable apply button while in flight (already done in modal) |
| Old screenshot-era data not reachable from bulk | High | Low | Accepted — desktop app stopped writing screenshots; users have already moved on from old data |

---

## 10. Phase 2 — Create New Issue, Active Sprint, Status (planned 2026-04-20)

**Status:** Planned — not yet implemented
**Trigger:** User requests to extend bulk reassign so the target can be a *new* issue (not just an existing one), can be added to the project's **active sprint**, and can have its **status set** in the same action.

### 10.1 What's already in place after Phase 1
- Timezone bug fixed: browser computes `windowStartUtc` / `windowEndUtc` via `new Date(y,m-1,d,h,min).toISOString()`; resolvers consume those UTC ISO strings directly. No more `${date}T${time}:00Z` local-as-UTC bug.
- `createIssueAndAssign` already implements the reusable pattern for `getIssueTransitions` → match-by-name → `transitionIssue`. The helpers exist; reuse them.
- Manifest already has `read:jira-work` + `write:jira-work` (covers transitions). Sprint scopes are missing.

### 10.2 Web-search confirmations (2026-04-20)
- **Add existing issue to sprint:** `POST /rest/agile/1.0/sprint/{sprintId}/issue` with `{ "issues": [key] }`. Scope `write:sprint:jira-software`. 50-issue cap (we send 1).
- **Discover active sprint:** `GET /rest/agile/1.0/board?projectKeyOrId={KEY}&type=scrum` → first board → `GET /rest/agile/1.0/board/{boardId}/sprint?state=active`. Scopes `read:board-scope:jira-software` + `read:sprint:jira-software`. Kanban projects return no board / no active sprint — UI must handle that gracefully.
- **Set status:** No direct setter — must POST a transition. Use existing `getIssueTransitions` → match by `to.name` → `transitionIssue` pattern. Workflows differ per project, so soft-fail and surface the warning.

Sources: [Sprint API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/), [Board API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/), [Issues API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).

### 10.3 Manifest changes
Add to `permissions.scopes` in [forge-app/manifest.yml](../forge-app/manifest.yml):
```yaml
read:board-scope:jira-software:
  allowImpersonation: true
read:sprint:jira-software:
  allowImpersonation: true
write:sprint:jira-software:
  allowImpersonation: true
```
**Risk:** scope additions trigger re-consent on next install/upgrade.

### 10.4 New backend helpers
**File:** [forge-app/src/services/jira/sprintService.js](../forge-app/src/services/jira/sprintService.js) *(new)*

- `getActiveSprintForProject(projectKey)` → `{ boardId, sprintId, sprintName } | null`. Two REST calls; no caching for v1.
- `addIssueToSprint(sprintId, issueKey)` → POST one issue; throws on non-2xx with response body for diagnostics.

**New resolver `getActiveSprint`** in [assignmentResolvers.js](../forge-app/src/resolvers/unassigned/assignmentResolvers.js): takes `projectKey`, returns the helper result. Register in [forge-app/src/index.js](../forge-app/src/index.js).

### 10.5 Backend resolver changes

#### 10.5.a Extend `bulkReassignByTimeInterval` (existing-issue target)
Accept new optional payload: `addToActiveSprint: bool`, `statusName: string`. After PATCH succeeds:
- If `statusName` → reuse `getIssueTransitions` + `transitionIssue` (same code path as `createIssueAndAssign:408-431`). Soft-fail.
- If `addToActiveSprint` → look up project from `targetIssueKey` (split on `-`), call `getActiveSprintForProject`, then `addIssueToSprint`. Soft-fail.
- Return `sprint_added`, `sprint_skipped_reason`, `status_changed`, `status_skipped_reason` so the UI can surface partial success.

#### 10.5.b New resolver `bulkCreateIssueAndReassign`
Composition only — no novel logic:
1. Validate full payload (window + create-issue fields).
2. Extract `findActivityRecordsInWindow(ctx, windowStartUtc, windowEndUtc)` from `previewBulkReassign` into a shared private helper so both resolvers use it.
3. **Zero matches → bail before creating** (never strand an empty issue).
4. Run create-issue flow from `createIssueAndAssign:356-404`.
5. PATCH activity_records to point at the new key (mirror `bulkReassignByTimeInterval`).
6. Optional transition (already handled by reusing the helper from `createIssueAndAssign`).
7. Optional add-to-active-sprint via new helper.
8. Optional worklog (mirror `createIssueAndAssign:451-457`).
9. Cache + log to `created_issues_log` (mirror lines 459-498).
10. Return rich payload including partial-success flags.

**Sequencing:** create → reassign → transition → add-to-sprint. Failures after create return partial success; **do not** delete the issue (Jira automation may have already fired).

### 10.6 Frontend — BulkEditModal
**Files:** [BulkEditModal.js](../forge-app/static/main/src/components/unassigned/BulkEditModal.js), [BulkEditModal.css](../forge-app/static/main/src/components/unassigned/BulkEditModal.css)

New state:
```js
const [targetMode, setTargetMode] = useState('existing'); // 'existing' | 'new'
const [newIssueSummary, setNewIssueSummary] = useState('');
const [newIssueDescription, setNewIssueDescription] = useState('');
const [selectedProject, setSelectedProject] = useState('');
const [issueType, setIssueType] = useState('Task');
const [statusName, setStatusName] = useState('');             // '' = no change
const [statusOptions, setStatusOptions] = useState([]);
const [addToActiveSprint, setAddToActiveSprint] = useState(false);
const [activeSprintInfo, setActiveSprintInfo] = useState(null); // {sprintName} | 'none' | null
```

UI additions (below the existing preview section):
- **Radio:** Existing issue / Create new issue.
- **Existing branch:** existing issue dropdown (already present). On select → fire `getIssueTransitions(issueKey)` to populate `statusOptions`; fire `getActiveSprint(projectKey from issueKey)`.
- **New branch:** project picker (reuse `userProjects`), summary input, description textarea, type select. On project change → fire `getActiveSprint(projectKey)`. Status options for new issue default to `["To Do","In Progress","Done"]`.
- **Set status to** dropdown — first option `Don't change` (omits `statusName` from payload).
- **Add to active sprint** checkbox — disabled with helper text "This project's board has no active sprint" when `activeSprintInfo === 'none'`. Label includes sprint name when known.

`handleApplyBulkEdit` routes to `bulkReassignByTimeInterval` (existing) or `bulkCreateIssueAndReassign` (new), passing `windowStartUtc` / `windowEndUtc` unchanged.

Surface partial-success flags in the success panel: e.g. *"Created TT-42 and reassigned 12 activities. Status set to In Progress. Sprint add failed: Issue type not on board."*

### 10.7 Test plan additions (Phase 2)
- Existing-issue + status + sprint on a scrum project (happy path).
- Existing-issue on a kanban project — sprint checkbox disabled, no API call attempted.
- Existing-issue + status the workflow can't reach — soft warning, assignment still succeeds.
- New-issue, **zero matches in window** → fails before create; no orphan issue.
- New-issue + sprint + status → verify in Jira UI.
- New-issue, sprint add fails (issue type not on board filter) → partial success surfaced, issue still created and activities still reassigned.
- Manifest scope re-consent flow validates on `forge tunnel`.

### 10.8 Out of scope (Phase 2)
- Multi-issue / multi-sprint bulk operations (always create exactly 1 issue).
- Custom transition fields (e.g. Resolution required for "Done") — surface Jira's error rather than build a dynamic field UI.
- Caching board/sprint lookup — premature.
- Letting the user pick a non-active sprint (future / closed).
- Multi-board projects — pick first scrum board; if multiple boards become a real complaint, add a board picker later.

### 10.9 Suggested commit order
1. Manifest scopes + `sprintService.js` + `getActiveSprint` resolver. Testable on tunnel in isolation.
2. Extend `bulkReassignByTimeInterval` + UI for the existing-issue path (status + sprint). Ship.
3. Add `bulkCreateIssueAndReassign` + radio toggle + new-issue UI. Ship.

### 10.10 Open decisions for Phase 2
| # | Question | Default if unresolved |
|---|---|---|
| D4 | If a new issue's status transition fails, leave issue in default status or fail the apply? | Leave in default — soft-fail with warning (mirrors current `createIssueAndAssign` behavior) |
| D5 | If add-to-sprint fails after create, leave issue out of sprint or fail? | Leave out — soft-fail (do **not** delete the created issue) |
| D6 | When project has multiple scrum boards, pick first or prompt? | Pick first; revisit if users complain |
| D7 | Default for `addToActiveSprint` checkbox? | Unchecked (opt-in) |
| D8 | Default for `statusName` dropdown? | "Don't change" (preserves current behavior) |

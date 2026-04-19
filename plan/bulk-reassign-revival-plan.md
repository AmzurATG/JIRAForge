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

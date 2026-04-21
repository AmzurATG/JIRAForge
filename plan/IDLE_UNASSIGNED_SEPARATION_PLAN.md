# Idle Sessions Separation in Unassigned Work Page - Detailed Plan

## 1. Objective

Separate idle sessions from regular unassigned work sessions inside the existing Unassigned Work page so users can find and process idle time quickly, without loading and scanning a large mixed list.

This plan implements:
- Idea 1: section/tab-style separation (All / Unassigned Work / Idle Sessions)
- Idea 3: quick filters (All / AI Recommended / Needs Review)

Out of scope for this phase:
- New delete flow for idle-only entries
- New standalone Idle page
- Changes to timeline conversion UX

---

## 2. Current Problem

Users currently see one combined unassigned groups list. Idle groups are mixed with normal work groups, so users may need to load and inspect many groups before finding the idle entries they care about.

Key pain points:
- No quick way to isolate idle groups
- High scroll/load overhead when group count is large
- Existing grouping UI is useful, but discovery is poor

---

## 3. Solution Overview

### 3.1 Backend Classification
Enhance unassigned group payload with a new field:
- `group_type: 'idle' | 'work'`

Classification rule:
- Group is `idle` only when all `activity_records` members in the group have `is_idle = true`
- Any legacy-only member (without idle signal) is treated as `work` for safety

### 3.2 Frontend Separation Controls
Add UI controls in Unassigned Work header:
1. Group type tabs:
   - All
   - Unassigned Work
   - Idle Sessions
2. Quick filters:
   - All
   - AI Recommended
   - Needs Review

### 3.3 Filtered Rendering
Render `GroupAccordion` using filtered groups (`displayedGroups`) instead of the full groups array.

### 3.4 Existing Behaviors Preserved
- Expand group details
- Assign group
- Select intervals
- Dismiss (existing behavior remains unchanged)
- Bulk edit modal

No idle-specific delete was added in this phase.

---

## 4. Detailed Implementation Steps

## 4.1 Backend - Group Type Classification
File:
- `forge-app/src/resolvers/unassigned/sessionResolvers.js`

Tasks:
1. In `getUnassignedGroups`, after loading paginated groups, fetch members for only those group IDs.
2. Collect `activity_record_id`s and query `activity_records(id,is_idle)`.
3. Build per-group totals:
   - total members
   - idle members
4. Compute `group_type`:
   - `idle` if `idle === total` and `total > 0`
   - else `work`
5. Add `group_type` to response payload for each group.

Expected outcome:
- Frontend can filter groups without expanding each group.

---

## 4.2 Frontend - State and Derivations
File:
- `forge-app/static/main/src/components/UnassignedWork.js`

Tasks:
1. Add tab state:
   - `groupTypeTab` (`all|work|idle`)
2. Add quick-filter state:
   - `quickFilter` (`all|recommended|review`)
3. Add derived counts (`groupTypeCounts`) from loaded groups.
4. Add filtered list (`displayedGroups`) from:
   - type tab
   - quick filter
5. Update summary metrics to use `displayedGroups`.
6. Update `GroupAccordion` input to use `displayedGroups`.
7. Clear selection when tab/filter changes to avoid stale selection across hidden groups.
8. Keep loading and empty-state behavior safe when groups and sessions can load independently.

Expected outcome:
- User can isolate idle groups in one click and refine further with quick filters.

---

## 4.3 Frontend - Styles
File:
- `forge-app/static/main/src/components/UnassignedWork.css`

Tasks:
1. Add styles for type tabs:
   - default, hover, active states
2. Add styles for quick-filter chips/buttons:
   - default, hover, active states
3. Add mobile adjustments for smaller viewports.

Expected outcome:
- Separation controls look consistent with current page styling and remain usable on small screens.

---

## 5. Data Contract Changes

`getUnassignedGroups` response group object now includes:

```json
{
  "id": "uuid",
  "label": "...",
  "session_count": 5,
  "total_seconds": 1200,
  "group_type": "idle"
}
```

Backward compatibility:
- Frontend defaults unknown/missing type to `work`
- Existing consumers that ignore new field remain unaffected

---

## 6. UX Behavior Matrix

1. Tab: All
- Shows all groups

2. Tab: Unassigned Work
- Shows only `group_type = work`

3. Tab: Idle Sessions
- Shows only `group_type = idle`

4. Quick Filter: AI Recommended
- Further filters visible tab set to groups with `recommendation`

5. Quick Filter: Needs Review
- Further filters visible tab set to groups without `recommendation`

6. Expand/Assign flow
- Works as before for all filtered groups, including idle groups

7. Delete group flow (existing behavior)
- Uses existing `dismissUnassignedGroup` resolver for both work and idle groups
- No new idle-specific delete endpoint introduced

---

## 6.1 Post-Implementation Fixes (Idle Actions + Delete Reliability)

### 6.1.1 Action Buttons Visibility Fix
File:
- `forge-app/static/main/src/components/unassigned/GroupAccordion.js`

Issue:
- `Assign This Group` and `Delete Group` buttons were gated behind a `details` render condition.
- For idle groups where details loading was unavailable/delayed, actions did not render.

Fix:
1. Keep sessions list behind the `details` guard.
2. Render action buttons in a separate block that depends only on non-loading state.

Outcome:
- Idle groups now consistently show assign/delete actions.

### 6.1.2 Dismiss Resolver Hardening
File:
- `forge-app/src/resolvers/unassigned/assignmentResolvers.js`

Issue:
- Dismiss failures were not explicit enough for diagnosing idle-specific failures (for example, permissions/RLS effects).

Fix:
1. Added structured logs around each dismiss step.
2. Added update-count checks and warnings when zero rows are updated.
3. Added clearer error returns when group dismissal update fails.

Outcome:
- Delete failures are now diagnosable from backend logs.

### 6.1.3 Frontend Dismiss Error Surfacing
File:
- `forge-app/static/main/src/components/UnassignedWork.js`

Issue:
- Dismiss failures were mostly silent from user perspective.

Fix:
1. Added explicit success checks for dismiss responses.
2. Added user-facing alert messages on failure.
3. Added success/failure logging for QA verification.

Outcome:
- Users get immediate feedback when delete/remove operations fail.

---

## 7. Validation and Testing Plan

## 7.1 Functional Checks
1. Open Unassigned Work page with mixed groups.
2. Confirm tab counts reflect expected distribution.
3. Switch to Idle Sessions and verify only idle groups appear.
4. Apply AI Recommended filter and verify subset updates.
5. Apply Needs Review filter and verify inverse subset updates.
6. Expand an idle group and assign it to issue (existing/new).
7. Ensure no regression in group selection bar and bulk assign actions.

## 7.2 Edge Cases
1. No groups at all.
2. Groups exist but selected tab/filter has no matches.
3. Only idle groups exist.
4. Only work groups exist.
5. Mixed legacy and activity-record members.

## 7.3 Non-Functional
1. Confirm no new lint/type errors in edited files.
2. Validate query volume remains bounded to paginated group IDs only.
3. Confirm dismiss logs are sufficient to diagnose permissions/RLS failures.

## 7.4 Regression Checks for Idle Actions
1. Open Idle Sessions tab and verify each idle group shows `Assign This Group` and `Delete Group`.
2. Delete one idle group and verify it disappears from list without manual refresh.
3. Remove one session from an idle group and verify session count is reduced.
4. If delete fails, verify user sees a clear error message and console logs include failure context.

---

## 8. Risks and Mitigations

1. Risk: Misclassification for legacy-only groups
- Mitigation: classify legacy members as `work` to avoid false idle labeling

2. Risk: Selection state across tab/filter switches
- Mitigation: clear selection on tab/filter change

3. Risk: Additional backend queries per page load
- Mitigation: only classify visible page of groups (`limit` + `offset`), not all groups

---

## 9. Rollout Strategy

1. Deploy backend + frontend together to ensure `group_type` is available.
2. Monitor logs for group classification query failures.
3. Validate first with users having high unassigned volume.
4. If needed, add telemetry counters:
   - tab usage
   - idle tab selection frequency
   - time-to-assign improvements

---

## 10. Acceptance Criteria

1. Users can switch between All / Unassigned Work / Idle Sessions tabs.
2. Users can apply quick filters (All / AI Recommended / Needs Review).
3. Idle groups are not mixed with work groups when Idle tab is selected.
4. Expand and assign flow continues to work for idle groups.
5. No new idle-specific delete option is introduced in this phase.
6. Existing delete flow works for idle groups via shared dismiss resolver.
7. Dismiss failures are surfaced with clear diagnostics in frontend/backend logs.
8. No compile/lint errors in touched files.

---

## 11. Future Enhancements (Optional)

1. Hide dismiss controls only on Idle tab (assign-only UX for idle section).
2. Add dedicated idle badge/icon in group headers.
3. Add server-side tab filter params for very large datasets.
4. Add "mixed" group_type if needed for future pipeline behavior.

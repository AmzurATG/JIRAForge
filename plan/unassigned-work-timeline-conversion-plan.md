# Unassigned Work Conversion from Timeline - Detailed Implementation Plan

## 1. Objective

Enable users to convert **unassigned work** directly from the Time Analytics timeline (Day View), with parity to the existing idle conversion UX:

- Add unassigned timeline block conversion action (same interaction pattern as idle conversion).
- Allow two conversion modes:
  - Add time to existing issue.
  - Create new issue and assign time.
- For create-new flow, reuse the unassigned-work-page recommendation behavior:
  - If confidence is high, prefill issue summary/description/project.
  - User can review/edit and confirm creation.
- Ensure conversion updates time analytics immediately and consistently:
  - Unassigned time decreases.
  - Assigned issue time increases.
  - Timeline visuals and totals remain in sync.

## 2. Current State (What Exists Today)

## 2.1 Timeline and Idle Conversion
- Timeline UI is in [forge-app/static/main/src/components/tabs/time-analytics/DayView.js](../forge-app/static/main/src/components/tabs/time-analytics/DayView.js).
- Idle conversion already exists via resolver `convertIdleToWorklog`.
- Idle conversion UI includes modal/popup with existing/new issue modes.
- Idle conversion backend updates idle metadata and writes Jira worklog.

## 2.2 Unassigned Work Page (Recommendation + Create)
- Unassigned grouping and recommendations are loaded by:
  - [forge-app/src/resolvers/unassigned/sessionResolvers.js](../forge-app/src/resolvers/unassigned/sessionResolvers.js)
- Assign/create actions are handled by:
  - [forge-app/src/resolvers/unassigned/assignmentResolvers.js](../forge-app/src/resolvers/unassigned/assignmentResolvers.js)
- Modal with prefill logic exists in:
  - [forge-app/static/main/src/components/unassigned/AssignmentModal.js](../forge-app/static/main/src/components/unassigned/AssignmentModal.js)
- Group recommendation fields currently available:
  - `recommended_action`, `suggested_issue_key`, `recommendation_reason`, `confidence_level`, `group_label`, `group_description`.

## 2.3 Analytics Source of Truth
- Timeline sessions are sourced from `activity_records` + legacy fallback in:
  - [forge-app/src/services/analytics/teamAnalyticsService.js](../forge-app/src/services/analytics/teamAnalyticsService.js)
- Issue breakdown and unassigned analytics use `user_assigned_issue_key`/summary records.
- Current idle conversion updates `converted_issue_key` and reclassification fields, but not issue assignment key.

## 3. Functional Requirements

## 3.1 User-Level Functional Requirements
1. User sees action control on timeline blocks representing unassigned active work (not idle).
2. Clicking action opens conversion modal with:
   - Existing issue mode.
   - Create new issue mode.
3. Existing issue conversion:
   - Assign selected unassigned records to issue.
   - Optionally create Jira worklog immediately (same behavior as current assignment paths).
4. Create new issue conversion:
   - Auto-fill fields when confidence is high (summary/description/project/type/status where available).
   - User can edit and submit.
   - Created issue receives assigned time.
5. After conversion completes:
   - Timeline refreshes and converted block no longer appears as unassigned.
   - Time analytics unassigned values reduce.
   - Assigned issue totals reflect converted time.
  - Converted sessions are removed from the Unassigned Work page immediately.
  - If converted sessions belonged to an unassigned group, group membership/count/total is updated and empty groups are hidden.

## 3.2 Non-Functional Requirements
1. Preserve permission boundaries (only own data for regular users).
2. Keep multi-tenant filters (`organization_id`) intact in all mutations.
3. Avoid double conversion and race conditions.
4. Keep behavior consistent with sub-minute worklog handling already used in unassigned assignment flows.

## 4. Proposed Design

## 4.1 UX Pattern
Use the same visual/interaction pattern as idle conversion in Day View:
- Similar hover affordance and modal layout.
- Same issue/project fetch mechanisms (`getAllUserAssignedIssues`, `getUserProjects`, statuses if needed).
- Add distinct labels so users know this is converting unassigned active work, not idle work.

## 4.2 Timeline Data Enhancement
Current timeline sessions do not include enough metadata for safe conversion. Add per-session metadata in timeline response:
- `id` (activity_record id)
- `source` (`activity_records` vs `legacy`)
- `projectKey` (if present)
- `issueKey` (already present)

In frontend block-coalescing logic, retain a list of underlying session IDs for each merged unassigned block so conversion can target exact records.

## 4.3 New Backend Mutation for Timeline Unassigned Conversion
Add a dedicated resolver flow for timeline unassigned conversion (recommended name: `convertUnassignedToWorklog`) to avoid misuse of broad bulk APIs.

Payload should include:
- `sessionIds` (exact IDs represented by clicked block)
- mode fields:
  - existing: `issueKey`
  - new: `createNewIssue`, `issueSummary`, `issueDescription`, `projectKey`, `issueType`, `statusName`
- optional metadata for recommendation tracking (confidence/recommendation source)

Behavior:
1. Validate ownership + org + unassigned-only (`user_assigned_issue_key IS NULL`).
2. If create-new mode: create Jira issue first.
3. Update target `activity_records`:
   - set `user_assigned_issue_key = issueKey`
   - set `project_key = extractedProjectKey`
4. Keep unassigned-group data consistent for converted sessions:
  - remove or invalidate corresponding `unassigned_group_members` rows for converted records.
  - recalculate `unassigned_work_groups.session_count` and `total_seconds`.
  - mark group hidden/dismissed/assigned when it has no remaining unassigned members.
5. Create Jira worklog using same rules as `assignmentResolvers`:
   - skip/defer under-60s according to existing policy.
6. Return updated totals and issue key.

## 4.4 Recommendation Prefill Strategy (High Confidence)
For timeline unassigned block conversion, obtain recommendations using one of these approaches:
- Preferred: create a small service method that computes recommendation for selected records (same logic as unassigned group clustering output).
- Alternative (faster): call a new resolver that asks AI/recommendation endpoint for the selected records only.

Prefill only when confidence is high:
- summary from recommendation label
- description from recommendation description/reason
- default project from dominant project key in selected sessions (if valid)

If confidence is medium/low:
- do not auto-fill aggressively; provide placeholders.

## 5. Files to Modify

## 5.1 Frontend (Time Analytics)
1. [forge-app/static/main/src/components/tabs/time-analytics/DayView.js](../forge-app/static/main/src/components/tabs/time-analytics/DayView.js)
- Add unassigned block conversion trigger (similar to idle trigger).
- Preserve per-block `sessionIds` for conversion mutation payload.
- Add modal mode handling for unassigned conversion.
- Integrate recommendation prefill flow on modal open.
- Refresh timeline + analytics cards after success.

2. [forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css](../forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css)
- Add styling for unassigned convert CTA and modal variants.
- Ensure visual distinction between idle conversion and unassigned conversion.

3. Optional extraction for maintainability (recommended):
- Create shared modal component for idle + unassigned conversions:
  - new file candidate: `time-analytics/ConvertWorkModal.js`
- Reduce duplication and future regression risk.

## 5.2 Backend (Resolvers/Services)
1. [forge-app/src/resolvers/analyticsResolvers.js](../forge-app/src/resolvers/analyticsResolvers.js)
- Register new resolver `convertUnassignedToWorklog`.
- Reuse/create helper for issue creation + transition + worklog creation.

2. [forge-app/src/services/analytics/teamAnalyticsService.js](../forge-app/src/services/analytics/teamAnalyticsService.js)
- Extend timeline session mapping with record IDs/source fields.
- Add service function to reassign selected unassigned activity records.
- Add safety checks against converting already-assigned records.

3. [forge-app/src/resolvers/unassigned/assignmentResolvers.js](../forge-app/src/resolvers/unassigned/assignmentResolvers.js)
- Refactor reusable logic (issue creation, worklog creation policy, assignment patch logic) into shared utility to avoid duplicate business rules.

4. New shared helper (recommended):
- file candidate: `forge-app/src/services/workAssignmentService.js`
- centralize:
  - create issue + transition
  - create worklog/defer policy
  - patch assigned issue keys

## 5.3 Recommendation / Prefill Path
Potential touchpoints (based on existing recommendation storage):
1. [forge-app/src/resolvers/unassigned/sessionResolvers.js](../forge-app/src/resolvers/unassigned/sessionResolvers.js)
- Add resolver to fetch recommendation/prefill for selected session IDs, or expose helper used by timeline.

2. [forge-app/static/main/src/components/unassigned/AssignmentModal.js](../forge-app/static/main/src/components/unassigned/AssignmentModal.js)
- Reference behavior only; optionally extract prefill logic into shared util for reuse by timeline modal.

## 5.4 Resolver Registration / Wiring
1. [forge-app/src/index.js](../forge-app/src/index.js)
- No module changes expected if resolver is added in existing analytics registration.

2. [forge-app/src/resolvers/unassignedWorkResolvers.js](../forge-app/src/resolvers/unassignedWorkResolvers.js)
- Optional if shared conversion resolver placed under unassigned module instead of analytics module.

## 6. Data Changes and Analytics Impact

## 6.1 Required Data Mutation for Analytics Consistency
To make Time Analytics unassigned values change correctly, conversion must update:
- `activity_records.user_assigned_issue_key`
- `activity_records.project_key` (where applicable)

To make the Unassigned Work page update correctly in the same interaction window, conversion must also keep group data in sync:
- remove/invalidate matching `unassigned_group_members` entries for converted sessions.
- recalculate or update `unassigned_work_groups` aggregates (`session_count`, `total_seconds`).
- ensure fully consumed groups are not returned by `getUnassignedGroups`.

If only annotation fields are written (like `converted_issue_key`), issue-level and unassigned analytics can remain stale/misleading.

## 6.2 Legacy Data Consideration
Timeline conversion should focus on `activity_records` (new pipeline). Legacy `analysis_results` conversion can be out of scope initially unless timeline exposes legacy-only blocks for conversion.

If needed, phase-2 support can patch both tables similarly to existing bulk reassign behavior.

## 6.3 Summary Aggregation Dependencies
If daily analytics are driven by materialized summaries/triggers, validate refresh behavior after assignment updates. If summaries are delayed, force UI refresh from activity source in day-level views to avoid temporary mismatch.

## 7. Impact on Other Features

## 7.1 Features Potentially Affected
1. Idle conversion UX in Day View.
2. Unassigned Work page assignment/create flows.
3. Bulk time edit modal behavior (shared assignment logic).
4. Team/member day drilldowns showing unassigned seconds.
5. Export reports containing unassigned columns.

## 7.2 Regression Risks
1. Double-worklog creation if shared code is not centralized properly.
2. Assigning already-assigned records due to stale block state.
3. Permission leakage in team/admin timeline views.
4. UI inconsistency if merged block session IDs are not preserved.
5. Sub-minute worklog policy divergence across idle/unassigned/new timeline flow.

## 7.3 Mitigation
1. Reuse single assignment helper/service.
2. Backend enforces `user_assigned_issue_key IS NULL` guard before patch.
3. Add idempotency checks and clear error messaging.
4. Keep existing worklog threshold/defer rules.
5. Add focused tests for conversion + analytics deltas.

## 8. Implementation Phases

## Phase 1: Foundation and Shared Logic
1. Extract shared create-issue + transition + worklog helpers.
2. Add unassigned timeline conversion service method.
3. Add resolver endpoint and validations.

## Phase 2: Timeline Data + UI
1. Enhance timeline payload with session IDs/source.
2. Update Day View merging logic to keep session IDs per block.
3. Add unassigned conversion CTA and modal flow.

## Phase 3: Recommendation Prefill
1. Add resolver/helper for recommendation on selected sessions.
2. Apply high-confidence prefill rules in timeline modal.
3. Add user override/edit support before submit.

## Phase 4: Verification and Hardening
1. Add tests (unit + integration + playwright where practical).
2. Validate analytics update behavior across views.
3. Add logging/telemetry for conversion outcomes.

## 9. Testing Plan

## 9.1 Backend Tests
- Add tests around:
  - valid conversion to existing issue
  - create new issue then assign
  - reject conversion for non-owner sessions
  - reject already-assigned sessions
  - sub-minute worklog defer behavior

Suggested locations:
- [forge-app/tests/services](../forge-app/tests/services)
- new resolver tests under `forge-app/tests/resolvers` (if test harness supports)

## 9.2 Frontend Tests
1. Unit/integration:
- DayView block merge keeps `sessionIds`.
- Convert action disabled/enabled states.
- Prefill behavior for high vs low confidence.

2. Playwright:
- Add timeline unassigned conversion specs parallel to idle specs in:
  - [forge-app/tests/playwright/idle-time](../forge-app/tests/playwright/idle-time)
  - new folder suggestion: `forge-app/tests/playwright/unassigned-timeline`

## 9.3 Manual QA Scenarios
1. Convert unassigned block to existing issue.
2. Convert unassigned block by creating new issue with prefilled fields.
3. Confirm unassigned duration decreases in day analytics and issue breakdown.
4. Confirm converted sessions disappear from Unassigned Work page without waiting for a separate clustering cycle.
5. Confirm partially converted groups show updated count/time and fully consumed groups disappear.
4. Confirm no conversion actions shown for other users in admin view.
5. Confirm converted blocks do not show conversion CTA again.

## 10. Rollout Strategy

1. Hide with feature flag for controlled rollout (recommended):
- `timelineUnassignedConversionEnabled`

2. Staged rollout:
- internal org -> pilot customers -> full enablement.

3. Monitoring:
- conversion success/failure rate
- worklog creation failure rate
- mismatch incidents between timeline and analytics totals

## 11. Open Questions / Decisions Required

1. Should timeline conversion include legacy `analysis_results` records in v1?
2. Should new issue status/issue type controls in timeline match AssignmentModal exactly, or simplified first?
3. Do we require confidence threshold config (e.g., high >= 0.8) server-side?
4. Should recommendation prefill occur only on create-new mode selection or immediately on modal open?

## 12. Definition of Done

1. Unassigned conversion action is available in timeline for own unassigned blocks.
2. Existing/new issue conversion both succeed with proper permission checks.
3. High-confidence recommendation prefill works for create-new flow.
4. Time analytics reflects reduced unassigned time after conversion.
5. No regression in idle conversion, unassigned page assignment, and bulk time edit.
6. Tests added and passing for critical paths.

# Spec: Previous-Day Unassigned Sync Against In-Progress Jira Issues

## Problem
Clicking Sync with Jira on the Unassigned Work page and Sync Recent Work on the description-quality ticket page currently evaluates only a recent 30-minute window. This often returns zero assignments even when there is valid unassigned work from the prior day that should be matched.

## Root Cause / Context
- Resolver `syncRecentUnassignedWorkWithAllUpdatedIssues` in `forge-app/src/resolvers/descriptionResolvers.js` now needs the same previous-day session pool as the single-issue resolver.
- Resolver `syncRecentUnassignedWorkForIssue` still used a 30-minute cutoff for its source sessions.
- UI copy in `forge-app/static/main/src/components/UnassignedWork.js` and `forge-app/static/main/src/components/issue-panel/DescriptionQuality.js` reflected 30-minute behavior.
- Matching payloads should include attachment context alongside title/description so the LLM can ground ticket matching better.

## Proposed Solution
- For both sync entry points:
  - Fetch candidate unassigned sessions from `unassigned_group_members` where `created_at` is within the previous UTC day.
  - Restrict scope to unresolved/unassigned groups for the current user and organization.
  - Resolve member rows to concrete session records from `activity_records` and legacy `unassigned_activity`.
- For the Unassigned Work page:
  - Match the previous-day session pool against all in-progress Jira issues assigned to the current user (`statusCategory = "In Progress"` and unresolved).
- For the ticket description-quality page:
  - Match the same previous-day session pool against the current Jira ticket.
- Include richer issue context in matching payloads:
  - `title`, `description`, and `attachmentContext` (attachment metadata summary).
- Update sync result reasons/messages/tooltips in both UIs to reflect previous-day matching.

## Acceptance Criteria
1. Sync with Jira in Unassigned Work scans only sessions linked by `unassigned_group_members` rows whose `created_at` falls in the previous UTC day.
2. Sync Recent Work on the Jira ticket page uses the same previous-day session pool for that ticket.
3. Sync with Jira matches against all user-assigned in-progress Jira issues, not only recently updated issues.
4. LLM receives per-issue `title`, `description`, and attachment context for matching.
5. Existing assignment behavior remains unchanged (high-confidence matches only, worklog creation behavior unchanged).
6. UI sync banner/messages accurately describe the new previous-day + in-progress behavior.

## Out of Scope
- Changing clustering schedule/job cadence.
- Altering confidence threshold.
- Reworking the post-description single-issue sync flow.
- Extracting and embedding full binary attachment content for sync matching.
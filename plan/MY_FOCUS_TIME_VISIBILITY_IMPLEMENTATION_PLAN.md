# My Focus Time Visibility Implementation Plan

## Objective

Improve the My Focus page so users can immediately distinguish between:

- Issues with tracked time
- Issues with no tracked time

The requested enhancement should make "missing time" visible without requiring users to infer it from the current `-` placeholder in the Time Tracked column.

## Current Implementation Baseline

### UI entry point

`forge-app/static/main/src/components/tabs/DashboardTab.js`

Current behavior:

- The My Focus screen is rendered by `DashboardTab`
- Existing filter tabs only support status-based filtering:
  - `all`
  - `in-progress`
  - `done`
- Issue rows are filtered locally in the component via:

```js
const filteredIssues = activeIssues.filter(issue => {
  if (issueFilter === 'all') return true;
  if (issueFilter === 'in-progress') return issue.statusCategory === 'indeterminate';
  if (issueFilter === 'done') return issue.statusCategory === 'done';
  return true;
});
```

- The Time Tracked cell currently shows formatted time only when `issue.timeTracked > 0`
- Otherwise it renders `-`

```js
<td className="issue-time">
  {issue.timeTracked > 0 ? formatTime(issue.timeTracked) : '-'}
</td>
```

### Data source

The frontend receives `activeIssues` from:

- `forge-app/static/main/src/context/AppContext.js`
  - `loadActiveIssues()`
  - `invoke('getActiveIssuesWithTime')`
- `forge-app/src/resolvers/issueResolvers.js`
  - `getActiveIssuesWithTime`
- `forge-app/src/services/issue/issueQueryService.js`
  - `getActiveIssuesWithTime(accountId, cloudId)`

### Relevant data contract

Based on the current implementation, the My Focus UI already has enough information to distinguish time states without backend changes if these assumptions remain true:

- `issue.timeTracked` is numeric
- `issue.timeTracked > 0` means time exists
- `issue.timeTracked === 0` means no associated time

## Problem Statement

The current `-` placeholder is too subtle and ambiguous.

Users cannot quickly answer:

- Which issues already have time logged?
- Which issues are still missing time?

The page also lacks a dedicated time-based filter, so users cannot isolate missing-time issues when reviewing their work.

## Proposed Product Approach

Implement this in two layers:

### Layer 1: Clear visual state in the Time Tracked column

Replace the ambiguous `-` display for zero-time issues with an explicit label, such as:

- `No time logged`
- `No time associated`

Recommended default label:

- `No time logged`

Reason:

- It is shorter
- It is easier to scan in a dense table
- It maps more naturally to user intent than "associated"

Also give the zero-time state a dedicated visual treatment so it is distinguishable from real durations at a glance.

Recommended presentation:

- Keep actual time values as plain formatted duration text
- Render zero-time values as a compact badge or muted status pill
- Use a neutral/warning visual tone, not destructive/error styling

### Layer 2: Add optional time-based filtering

Add a second filtering dimension for time state:

- Show all issues
- Show only issues with time tracked
- Show only issues without time tracked

This can be introduced either as:

- A compact secondary segmented control near the existing status tabs
- A dropdown filter near the table header

Recommended default UX:

- Preserve the current status tabs as the primary filter
- Add a secondary time filter control beside or below them
- Apply both filters together

This preserves current user mental models while adding the requested visibility.

## Recommended UX Design

### Option A: Indicator only

Scope:

- Explicit `No time logged` label in each zero-time row
- No new filter control

Pros:

- Lowest implementation risk
- No change to existing filter interactions
- Fastest path to improved visibility

Cons:

- Users still cannot isolate missing-time issues

### Option B: Indicator plus time filter

Scope:

- Explicit `No time logged` label
- New time-state filter control

Pros:

- Fully addresses both visibility and workflow efficiency
- Lets users quickly review only missing-time issues

Cons:

- Slightly larger UI and state-management change
- Requires clearer interaction rules between status filter and time filter

### Recommendation

Implement Option B.

Reason:

The user request explicitly asks for a filter or visual indicator, and the cleanest product outcome is to provide both. The existing DashboardTab already performs local filtering, so extending it to support a second filter dimension should remain contained to the frontend.

## Technical Design

### 1. Frontend state changes

Target file:

- `forge-app/static/main/src/components/tabs/DashboardTab.js`

Introduce a second local UI state for time filtering.

Suggested state shape:

```js
const [issueFilter, setIssueFilter] = useState('all');
const [timeFilter, setTimeFilter] = useState('all');
```

Suggested time filter values:

- `all`
- `with-time`
- `without-time`

### 2. Filtering logic update

Refactor the current single-filter predicate into a composed filter pipeline.

Suggested approach:

1. Apply the existing status filter
2. Apply the new time filter using `issue.timeTracked > 0`

Suggested behavior rules:

- `all` time filter: no time-based exclusion
- `with-time`: include only `issue.timeTracked > 0`
- `without-time`: include only `!issue.timeTracked || issue.timeTracked <= 0`

Why use the broader zero-time check:

- It is slightly more defensive than strict equality
- It avoids edge-case regressions if some issue objects omit the field

### 3. Time cell rendering update

Replace the existing fallback `-` with an explicit visual label.

Suggested rendering behavior:

- If `issue.timeTracked > 0`, show `formatTime(issue.timeTracked)`
- Otherwise, show a styled label such as `No time logged`

Suggested CSS treatment:

- Add a dedicated class for missing-time indicators
- Use readable contrast and compact pill styling
- Keep the table density close to current behavior

### 4. Styling changes

Target file:

- `forge-app/static/main/src/components/tabs/DashboardTab.css`

Expected styling additions:

- Time filter control styles
- Missing-time badge styles
- Optional positive-state styling if desired for consistency
- Responsive handling if an extra control is added beside the existing tabs

Important constraint:

- Do not disrupt the current layout of the status tabs on narrower widths
- If needed, allow the filter bar to wrap into two rows rather than compressing controls too tightly

### 5. Backend impact

No backend or resolver change is expected for the initial implementation.

Reason:

- `issue.timeTracked` is already present in the My Focus payload
- The request is a display and client-side filtering enhancement
- Existing data loading flow already supports the needed distinction

## Implementation Steps

### Phase 1: Confirm data assumptions

Validate in the current code and sample payloads that:

- All My Focus issue records contain `timeTracked`
- Zero-time issues consistently use `0`
- There is no separate state where time is "unknown" rather than truly absent

If an "unknown" state exists, split the UI states into:

- time tracked
- no time logged
- time unavailable

If not, keep the simpler two-state model.

### Phase 2: Add visual indicator

In `DashboardTab.js`:

- Replace `-` fallback with explicit text label
- Add class names for the zero-time state

In `DashboardTab.css`:

- Add styles for the zero-time label
- Ensure the label remains readable in the table row height already used

### Phase 3: Add time filter control

In `DashboardTab.js`:

- Add new local `timeFilter` state
- Add filter controls to the My Focus header area
- Update `filteredIssues` logic to combine status and time filtering

In `DashboardTab.css`:

- Add layout and selected-state styles for the new control
- Verify desktop and narrower app iframe widths

### Phase 4: Empty-state handling

If combined filters produce zero results, ensure the page communicates the reason clearly.

Recommended empty-state text:

- `No issues match the selected filters.`

This is preferable to a generic empty state because the absence may result from the new filter combination rather than missing data.

### Phase 5: Regression verification

Check that the following continue to work:

- Existing status tabs
- Expand/collapse session rows
- Time formatting for issues with actual tracked time
- Status dropdown interactions
- Jira issue navigation links

## Acceptance Criteria

### Visual indicator

- Every issue with `timeTracked > 0` shows its formatted tracked duration
- Every issue with `timeTracked <= 0` shows an explicit label instead of `-`
- Users can distinguish missing-time issues at a glance without opening details

### Time filter

- Users can show all issues regardless of time state
- Users can show only issues with tracked time
- Users can show only issues without tracked time
- The time filter works together with the existing status tabs

### UX behavior

- Existing issue status filters still behave exactly as before
- Combined filtering does not break session row expansion or status updates
- The new controls remain usable within the Forge app layout width

## Test Plan

### Functional scenarios

1. Issue with tracked time
- Example: `timeTracked = 3600`
- Expected: row displays `1h` or equivalent formatted value
- Expected: included in `with-time`
- Expected: excluded from `without-time`

2. Issue with no tracked time
- Example: `timeTracked = 0`
- Expected: row displays `No time logged`
- Expected: included in `without-time`
- Expected: excluded from `with-time`

3. Mixed list
- Example: page contains both timed and untimed issues
- Expected: visual distinction is immediately visible
- Expected: counts and rows change correctly when time filter changes

4. Status + time filter combination
- Example: `In Progress` + `without-time`
- Expected: only in-progress issues with zero tracked time remain visible

5. Done + with-time combination
- Expected: only done issues with tracked time remain visible

6. No matches
- Example: select a filter combination with zero matching rows
- Expected: clear empty-state message

7. Missing or undefined field defense
- Example: `timeTracked` absent or null in one record
- Expected: issue is treated as `without-time` unless a stronger backend guarantee is introduced

### Regression scenarios

1. Expandable rows still expand only for issues with sessions
2. Existing `All Issues`, `In Progress`, and `Done` tabs remain functional
3. Status changes still reload data correctly
4. Time values with sessions still render as before
5. No layout breakage in the app iframe width shown in the current UI

## Risks and Mitigations

### Risk: Ambiguous semantics of zero time

Issue:

A zero value may mean "no time tracked" or "time not yet synchronized".

Mitigation:

- Confirm whether `0` is final or transitional in the current payload lifecycle
- If sync lag exists, consider future enhancement text such as `No time logged yet`

### Risk: Filter UI becomes crowded

Issue:

The current focus tabs already occupy horizontal space.

Mitigation:

- Prefer a compact secondary filter row or dropdown
- Allow wrapping instead of shrinking controls too aggressively

### Risk: Users misunderstand combined filters

Issue:

Users may think the new time filter replaces the status tabs rather than combining with them.

Mitigation:

- Use clear labels such as `Time: All / With time / No time`
- Keep the time filter visually secondary to the existing status tabs

## Out of Scope

These should not be included in the first implementation pass:

- Backend query changes
- Database schema changes
- New analytics counts or summary cards
- Bulk actions for missing-time issues
- Automatic reminders for unlogged time

## Recommended Deliverable Breakdown

### Minimal viable delivery

- Explicit `No time logged` indicator
- Defensive zero-time detection
- Regression-safe styling update

### Full requested delivery

- Explicit `No time logged` indicator
- Secondary time filter control
- Combined status + time filtering
- Empty-state handling for filter combinations
- Responsive UI validation

## Suggested Follow-up Enhancements

If the first release is successful, consider:

1. Add counts to the time filter options, such as `No time (4)`
2. Persist the selected time filter in local component state across reloads or tab revisits
3. Add a lightweight tooltip clarifying how tracked time is calculated
4. Surface a summary banner when missing-time issues exist

## Files Expected To Change During Implementation

Frontend only:

- `forge-app/static/main/src/components/tabs/DashboardTab.js`
- `forge-app/static/main/src/components/tabs/DashboardTab.css`

Potential test coverage additions if desired:

- Existing frontend test location for DashboardTab, if present
- If no component tests exist yet, manual QA may be used initially

## Final Recommendation

Proceed with a frontend-only implementation that adds both:

- An explicit `No time logged` visual indicator
- A secondary time-state filter

This addresses the root usability problem with minimal architectural risk because the current My Focus page already receives the necessary `timeTracked` field and already performs local filtering in the component.
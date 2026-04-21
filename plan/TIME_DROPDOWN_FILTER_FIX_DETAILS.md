# Time Dropdown Filter Fix Details

## Summary
The Time dropdown in My Focus UI was visible and interactive, but it did not affect the issue list. Users could select `With Time` or `No Time`, but the table results remained unchanged.

## Affected Area
- Frontend component: `forge-app/static/main/src/components/tabs/DashboardTab.js`
- Feature: My Focus issue list filtering
- Controls involved:
  - Status tabs (`All Issues`, `In Progress`, `Done`)
  - Time dropdown (`All`, `With Time`, `No Time`)
  - Search input

## Root Cause
Two implementation gaps caused the malfunction:

1. Time predicate was never applied during filtering
- The function `matchesTimeFilter(issue)` existed and computed correct logic for:
  - all
  - with-time
  - without-time
- But `filteredIssues` only returned `statusMatch && searchMatch`.
- Result: time dropdown value changed state, but had no impact on filtered rows.

2. Pagination reset did not include time filter
- The page reset effect depended on `[issueFilter, searchQuery]`.
- It omitted `timeFilter`.
- Result: changing time filter could keep user on a stale page index, creating confusing empty or partial views.

## Code Changes Applied
File updated:
- `forge-app/static/main/src/components/tabs/DashboardTab.js`

### Change 1: Reset pagination when time filter changes
Before:
```js
useEffect(() => {
  setCurrentPage(1);
}, [issueFilter, searchQuery]);
```

After:
```js
useEffect(() => {
  setCurrentPage(1);
}, [issueFilter, searchQuery, timeFilter]);
```

### Change 2: Apply time filter in issue filtering pipeline
Before:
```js
return statusMatch && searchMatch;
```

After:
```js
let timeMatch = matchesTimeFilter(issue);
return statusMatch && timeMatch && searchMatch;
```

## Functional Behavior After Fix
The issue table now correctly applies all three dimensions together:
- Status filter
- Time filter
- Search query

Expected behavior:
- `Time = All` -> all issues eligible by status/search
- `Time = With Time` -> only issues where `Number(issue.timeTracked) > 0`
- `Time = No Time` -> only issues where `Number(issue.timeTracked) <= 0`

## Validation Checklist
Use this checklist to confirm behavior in UI:

1. Open My Focus page.
2. Set status to `All Issues` and clear search.
3. Select `Time = With Time` and verify only issues with tracked time are shown.
4. Select `Time = No Time` and verify only issues without tracked time are shown.
5. Switch between status tabs while time filter is active and verify combined filtering works.
6. Enter a search term with each time option and verify all three filters combine correctly.
7. Navigate to a later page (if available), then change time filter and verify pagination resets to page 1.

## Risk Assessment
Low risk. The fix is scoped to local UI filtering logic and pagination behavior in a single component.

Potential edge cases covered by current logic:
- Non-numeric or null `timeTracked` values are normalized to `0` by `Number(issue.timeTracked) || 0`.
- `No Time` intentionally includes zero and invalid/missing numeric values.

## Notes
- No backend resolver changes were required.
- No schema or API contract changes were required.
- This fix aligns with the existing implementation plan for My Focus time visibility/filtering.

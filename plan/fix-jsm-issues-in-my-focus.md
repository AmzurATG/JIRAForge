# Fix: Include JSM Issues in My Focus Dashboard

## Problem

The "My Focus" screen in the Forge app only shows issues from Scrum/Software projects because the JQL query filters by `sprint in openSprints()`. Jira Service Management (JSM) projects use queues, not sprints, so all JSM issues are excluded at the Jira API level.

**Root Cause:** `issueQueryService.js:40` — `getAllUserAssignedIssues({ jqlFilter: 'sprint in openSprints()' })`

## Data Flow

```
DashboardTab (My Focus UI)
  -> AppContext.loadActiveIssues()
    -> invoke('getActiveIssuesWithTime')
      -> issueResolvers.js (resolver)
        -> issueQueryService.getActiveIssuesWithTime()
          -> jira.getAllUserAssignedIssues({ jqlFilter: 'sprint in openSprints()' })
            -> Jira API: "assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC"
               ^^^ JSM issues have no sprint field — 0 results returned
```

## Solution

### JQL Change

```
OLD: sprint in openSprints()
NEW: (sprint in openSprints()) OR (sprint is EMPTY AND resolution = EMPTY AND statusCategory != Done)
```

### What This Achieves

| Project Type         | Before          | After                                      |
|----------------------|-----------------|---------------------------------------------|
| Software (Scrum)     | Active sprint   | Active sprint (unchanged)                   |
| Service Management   | Not shown       | All unresolved, active assigned issues      |
| Kanban               | Not shown       | All unresolved, active assigned issues      |
| Software backlog     | Not shown       | Items not in any sprint also appear (minor) |

### Known Side Effect

Software project backlog items not yet assigned to a sprint will also appear since they have `sprint is EMPTY`. This is a minor side effect and arguably useful for a "My Focus" view — users should see all active work assigned to them.

## Files to Change

### 1. `src/services/issue/issueQueryService.js` (line 34-42)

**What:** Update the JQL filter and code comment.

```javascript
// BEFORE
getAllUserAssignedIssues({ jqlFilter: 'sprint in openSprints()' })

// AFTER
getAllUserAssignedIssues({
  jqlFilter: '((sprint in openSprints()) OR (sprint is EMPTY AND resolution = EMPTY AND statusCategory != Done))'
})
```

**Update comment (lines 36-38):**
```javascript
// My Focus shows active sprint issues AND unresolved non-sprint issues (JSM, Kanban).
// Sprint-based projects: only active sprint issues appear.
// Non-sprint projects (JSM queues, Kanban boards): all unresolved active issues appear.
```

### 2. `src/utils/jira.js` (line 67-69) — No code change needed

The `getAllUserAssignedIssues()` function already supports any JQL filter string and already avoids sprint-only fields in the SELECT clause (line 69 comment). No changes needed here.

### 3. `static/main/src/components/tabs/DashboardTab.js` — No code change needed

The frontend already handles any issues returned by the backend. The status category filter (all / in-progress / done) will work for JSM issues too since JSM statuses also have status categories.

## Testing Plan

1. **Verify Software (Scrum) projects still work** — Active sprint issues should appear as before
2. **Verify JSM issues now appear** — Unresolved JSM issues assigned to the user should show in My Focus
3. **Verify resolved JSM issues are excluded** — Issues with a resolution set or in "Done" status category should not appear
4. **Verify time tracking data** — If the desktop app tracks time on JSM issues, verify the time data appears alongside the issues
5. **Check for performance** — The broader JQL may return more results; verify pagination still works correctly (jira.js handles this)

## Rollback

If issues arise, revert the JQL filter back to `sprint in openSprints()` on line 40 of `issueQueryService.js`.

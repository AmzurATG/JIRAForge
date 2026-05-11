# Bulk Delete Selected Unassigned Sessions — Implementation Guide

**Status:** Ready for Implementation  
**Date:** 2026-05-11  
**Feature:** Add "Delete Selected" button to SelectionBar for bulk deletion of unassigned work sessions

---

## 1. Executive Summary

### Problem Statement
The Unassigned Work page supports multi-select with a SelectionBar showing "Clear" and "Assign Selected" buttons. Users can select multiple groups and individual intervals, but there's no option to **delete the selected sessions in bulk**. Currently, users must dismiss groups one-by-one or individual sessions manually.

### Proposed Solution
Add a **"Delete Selected"** button to the SelectionBar (next to "Assign Selected") that:
- Dismisses all selected sessions (full groups + partial intervals) in one operation
- Follows the same multi-select pattern as "Assign Selected"
- Reuses existing backend dismiss primitives (`dismissUnassignedGroup`, `dismissGroupMember`)
- Shows confirmation dialog before deletion
- Provides feedback on operation success/failure

### Implementation Scope
- **Frontend:** Add button to SelectionBar + handler in UnassignedWork.js
- **Backend:** Create new resolver `deleteSelectedSessions` (multi-group aware)
- **Testing:** Unit tests for resolver + manual E2E validation
- **Effort:** ~2-3 hours (small feature, reuses existing patterns)

---

## 2. Architecture Analysis

### 2.1 Current Multi-Select Implementation

**State Management (UnassignedWork.js):**
```javascript
// Two pieces of state track selections:
const [fullySelectedGroups, setFullySelectedGroups] = useState(new Set());
const [selectedIntervalsByGroup, setSelectedIntervalsByGroup] = useState(new Map());

// Derived summary for SelectionBar
const selectionSummary = { groupCount, sessionCount, totalSeconds };

// Payload builder extracts sessionIds + groupIds
const buildSelectionPayload = () => ({
  sessionIds: [...sessionIds],  // Deduped activity_record UUIDs
  groupIds: [...groupIds],       // Affected group IDs
  totalSeconds,
  sessionCount
});
```

**SelectionBar Component (SelectionBar.js):**
```javascript
function SelectionBar({ groupCount, sessionCount, totalSeconds, onClear, onAssign }) {
  return (
    <div className="selection-bar">
      <div className="selection-bar-summary">
        {groupCount} groups · {sessionCount} sessions · {formatTime(totalSeconds)} selected
      </div>
      <div className="selection-bar-actions">
        <button onClick={onClear}>Clear</button>
        <button onClick={onAssign}>Assign Selected →</button>
      </div>
    </div>
  );
}
```

### 2.2 Existing Delete Functionality

**Single Group Dismiss (dismissUnassignedGroup):**
- Location: `forge-app/src/resolvers/unassigned/assignmentResolvers.js:1263`
- Process:
  1. Fetches all group members (activity_record_id + unassigned_activity_id)
  2. Marks records as `clustering_dismissed = true` in both tables
  3. Updates group: `is_dismissed = true`, `dismissed_at = now()`
  4. Returns success with dismissed count

**Single Interval Dismiss (dismissGroupMember):**
- Location: `forge-app/src/resolvers/unassigned/assignmentResolvers.js:1377`
- Process:
  1. Finds the member row in `unassigned_group_members`
  2. Marks source record as `clustering_dismissed`
  3. Deletes the member link from `unassigned_group_members`
  4. Decrements group's `session_count`
  5. Returns success

**Frontend Handler (UnassignedWork.js:511):**
```javascript
const handleDismissGroup = async (groupId) => {
  const result = await invoke('dismissUnassignedGroup', { groupId });
  if (result.success) {
    setGroups(prev => prev.filter(g => g.id !== groupId));
    setTotalGroups(prev => Math.max(0, prev - 1));
  }
};
```

### 2.3 Parallel Pattern: Assign Selected

**Frontend (UnassignedWork.js:505):**
```javascript
const handleAssignSelection = () => {
  const payload = buildSelectionPayload();
  if (payload.sessionIds.length === 0) return;
  
  setSelectedGroup({
    id: null,
    groupIds: payload.groupIds,
    session_ids: payload.sessionIds,
    session_count: payload.sessionCount,
    total_seconds: payload.totalSeconds,
    // ...other fields
  });
  setShowAssignModal(true);
};
```

**Backend (assignmentResolvers.js:444):**
```javascript
export async function assignSelectionToExistingIssue(req) {
  const { sessionIds, groupIds, issueKey, totalSeconds } = req.payload;
  
  // 1. Validate + sanitize input
  const validSessionIds = sanitizeUUIDArray(sessionIds);
  const validGroupIds = sanitizeUUIDArray(groupIds);
  
  // 2. Update all sessions to assigned
  await updateSessionsAndAnalysis({ validSessionIds, issueKey, ... });
  
  // 3. Per-group: mark fully assigned OR leave as partial
  for (const groupId of validGroupIds) {
    const members = await fetchGroupMembers(groupId);
    const fullyCovered = members.every(id => sessionIdsSet.has(id));
    
    if (fullyCovered) {
      await markGroupAsAssigned({ groupId, issueKey, ... });
    } else {
      // Leave group in place — remaining intervals still unassigned
    }
  }
  
  return { success: true, assigned_count: validSessionIds.length };
}
```

---

## 3. Implementation Design

### 3.1 Frontend Changes

#### SelectionBar.js — Add Delete Button

**File:** `forge-app/static/main/src/components/unassigned/SelectionBar.js`

**Change:** Add third button after "Assign Selected"

```javascript
function SelectionBar({ groupCount, sessionCount, totalSeconds, onClear, onAssign, onDelete }) {
  if (groupCount === 0 && sessionCount === 0) return null;

  return (
    <div className="selection-bar">
      <div className="selection-bar-summary">
        <strong>{groupCount}</strong> {groupCount === 1 ? 'group' : 'groups'}
        <span className="selection-bar-divider">·</span>
        <strong>{sessionCount}</strong> {sessionCount === 1 ? 'session' : 'sessions'}
        <span className="selection-bar-divider">·</span>
        <strong>{formatTime(totalSeconds)}</strong> selected
      </div>
      <div className="selection-bar-actions">
        <button className="selection-bar-clear" onClick={onClear}>
          Clear
        </button>
        <button className="selection-bar-delete" onClick={onDelete}>
          Delete Selected
        </button>
        <button className="selection-bar-assign" onClick={onAssign}>
          Assign Selected
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <line x1="5" y1="12" x2="19" y2="12"></line>
            <polyline points="12 5 19 12 12 19"></polyline>
          </svg>
        </button>
      </div>
    </div>
  );
}
```

#### SelectionBar.css — Add Delete Button Styles

**File:** `forge-app/static/main/src/components/unassigned/SelectionBar.css`

**Change:** Add styles matching the pattern of existing buttons

```css
.selection-bar-delete {
  padding: 6px 14px;
  background: var(--ds-background-danger, #de350b);
  color: var(--ds-text-inverse, #ffffff);
  border: none;
  border-radius: 3px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease-in-out;
  white-space: nowrap;
}

.selection-bar-delete:hover {
  background: var(--ds-background-danger-hovered, #bf2600);
}

.selection-bar-delete:active {
  background: var(--ds-background-danger-pressed, #a32500);
}

.selection-bar-delete:disabled {
  background: var(--ds-background-disabled, #f4f5f7);
  color: var(--ds-text-disabled, #a5adba);
  cursor: not-allowed;
}
```

#### UnassignedWork.js — Add Handler + Wire to SelectionBar

**File:** `forge-app/static/main/src/components/UnassignedWork.js`

**Change 1:** Add delete handler (insert after `handleAssignSelection` at line ~530)

```javascript
const handleDeleteSelection = async () => {
  const payload = buildSelectionPayload();
  if (payload.sessionIds.length === 0) return;

  // Confirmation dialog
  const groupLabel = payload.groupIds.length === 1 ? 'group' : 'groups';
  const sessionLabel = payload.sessionCount === 1 ? 'session' : 'sessions';
  const confirmMsg = `Delete ${payload.groupIds.length} ${groupLabel} (${payload.sessionCount} ${sessionLabel}, ${formatTime(payload.totalSeconds)})?

This will permanently dismiss these sessions from clustering. They won't appear in unassigned work again.`;

  if (!window.confirm(confirmMsg)) {
    return;
  }

  try {
    // Call new backend resolver
    const result = await invoke('deleteSelectedSessions', {
      sessionIds: payload.sessionIds,
      groupIds: payload.groupIds
    });

    if (result.success) {
      // Remove fully dismissed groups from UI
      setGroups(prev => prev.filter(g => !result.fullyDismissedGroupIds.includes(g.id)));
      setTotalGroups(prev => Math.max(0, prev - result.fullyDismissedGroupIds.length));

      // Clear caches for affected groups
      result.groupIds.forEach(gid => {
        setGroupDetails(prev => {
          const next = { ...prev };
          delete next[gid];
          return next;
        });
        setGroupWorkSessions(prev => {
          const next = { ...prev };
          delete next[gid];
          return next;
        });
      });

      // Clear selection state
      clearSelection();

      console.log(`[UnassignedWork] ✓ Deleted ${result.dismissedSessionCount} sessions across ${result.groupIds.length} groups`);
    } else {
      const errorMsg = result.error || 'Unknown error';
      console.error('[UnassignedWork] Delete selected failed:', errorMsg);
      alert(`Failed to delete sessions: ${errorMsg}`);
    }
  } catch (err) {
    console.error('[UnassignedWork] Error deleting selection:', err);
    alert(`Error deleting sessions: ${err.message || String(err)}`);
  }
};
```

**Change 2:** Wire handler to SelectionBar (line ~755)

```javascript
{selectionSummary.groupCount > 0 && (
  <SelectionBar
    groupCount={selectionSummary.groupCount}
    sessionCount={selectionSummary.sessionCount}
    totalSeconds={selectionSummary.totalSeconds}
    onClear={clearSelection}
    onAssign={handleAssignSelection}
    onDelete={handleDeleteSelection}  // NEW
  />
)}
```

---

### 3.2 Backend Changes

#### New Resolver: deleteSelectedSessions

**File:** `forge-app/src/resolvers/unassigned/assignmentResolvers.js`

**Location:** Insert after `dismissGroupMember` (line ~1500)

```javascript
/**
 * Delete (dismiss) selected sessions across multiple groups.
 * Multi-group aware — fully dismisses groups when all members are selected,
 * otherwise removes selected intervals and updates group aggregates.
 * 
 * Mirrors assignSelectionToExistingIssue pattern for consistency.
 */
export async function deleteSelectedSessions(req) {
  try {
    const { sessionIds, groupIds } = req.payload;

    // Validate input
    const validSessionIds = sanitizeUUIDArray(sessionIds);
    if (validSessionIds.length === 0) {
      return { success: false, error: 'No valid session IDs provided' };
    }

    const validGroupIds = sanitizeUUIDArray(groupIds);
    if (validGroupIds.length === 0) {
      return { success: false, error: 'No valid group IDs provided' };
    }

    // Initialize context
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId } = ctx;
    const now = new Date().toISOString();
    const sessionIdsSet = new Set(validSessionIds);

    console.log(`[deleteSelectedSessions] Processing ${validSessionIds.length} sessions across ${validGroupIds.length} groups`);

    // Step 1: Determine full vs partial coverage per group
    const fullyDismissedGroupIds = [];
    const partialGroupIds = [];
    const memberIdsToDelete = []; // unassigned_group_members rows to remove

    for (const groupId of validGroupIds) {
      // Fetch group members
      const members = ensureArray(await supabaseRequest(
        supabaseConfig,
        `unassigned_group_members?group_id=eq.${groupId}&select=id,activity_record_id,unassigned_activity_id`
      ));

      if (members.length === 0) {
        console.warn(`[deleteSelectedSessions] Group ${groupId} has no members, skipping`);
        continue;
      }

      // Collect all session IDs from members (both pipelines)
      const memberSessionIds = members
        .flatMap(m => [m.activity_record_id, m.unassigned_activity_id])
        .filter(Boolean);

      // Check if user selected ALL members of this group
      const fullyCovered = memberSessionIds.every(id => sessionIdsSet.has(id));

      if (fullyCovered) {
        // Dismiss entire group
        fullyDismissedGroupIds.push(groupId);
      } else {
        // Partial dismissal — only mark selected members
        partialGroupIds.push(groupId);
        
        // Collect member row IDs to delete from unassigned_group_members
        members.forEach(m => {
          const sessionId = m.activity_record_id || m.unassigned_activity_id;
          if (sessionId && sessionIdsSet.has(sessionId)) {
            memberIdsToDelete.push(m.id);
          }
        });
      }
    }

    console.log(`[deleteSelectedSessions] Full dismissals: ${fullyDismissedGroupIds.length}, Partial: ${partialGroupIds.length}`);

    // Step 2: Mark all selected sessions as clustering_dismissed
    // (Regardless of full/partial, every selected session gets dismissed)
    const activityRecordIds = validSessionIds.filter(id => id); // All are activity_record UUIDs in new pipeline
    const unassignedActivityIds = []; // Legacy pipeline if needed (usually empty for new groups)

    if (activityRecordIds.length > 0) {
      try {
        const arResult = await supabaseRequest(
          supabaseConfig,
          `activity_records?id=in.(${activityRecordIds.join(',')})&user_id=eq.${userId}`,
          {
            method: 'PATCH',
            body: { clustering_dismissed: true, clustering_dismissed_at: now }
          }
        );
        const arUpdated = ensureArray(arResult).length;
        console.log(`[deleteSelectedSessions] Marked ${arUpdated}/${activityRecordIds.length} activity_records as dismissed`);
      } catch (err) {
        console.error(`[deleteSelectedSessions] Error updating activity_records:`, err.message);
        throw err;
      }
    }

    // Also handle legacy unassigned_activity if present (rare for new groups)
    if (unassignedActivityIds.length > 0) {
      try {
        await supabaseRequest(
          supabaseConfig,
          `unassigned_activity?id=in.(${unassignedActivityIds.join(',')})&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
          {
            method: 'PATCH',
            body: { clustering_dismissed: true, clustering_dismissed_at: now }
          }
        );
      } catch (err) {
        console.error(`[deleteSelectedSessions] Error updating unassigned_activity:`, err.message);
        // Don't throw — legacy path is optional
      }
    }

    // Step 3: Process fully dismissed groups
    if (fullyDismissedGroupIds.length > 0) {
      try {
        const groupResult = await supabaseRequest(
          supabaseConfig,
          `unassigned_work_groups?id=in.(${fullyDismissedGroupIds.join(',')})&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
          {
            method: 'PATCH',
            body: { is_dismissed: true, dismissed_at: now, dismissed_by: userId }
          }
        );
        const groupsUpdated = ensureArray(groupResult).length;
        console.log(`[deleteSelectedSessions] Marked ${groupsUpdated} groups as fully dismissed`);
      } catch (err) {
        console.error(`[deleteSelectedSessions] Error dismissing groups:`, err.message);
        throw err;
      }
    }

    // Step 4: Process partial groups — remove selected members and update aggregates
    if (partialGroupIds.length > 0 && memberIdsToDelete.length > 0) {
      try {
        // Delete member links
        await supabaseRequest(
          supabaseConfig,
          `unassigned_group_members?id=in.(${memberIdsToDelete.join(',')})`,
          { method: 'DELETE' }
        );
        console.log(`[deleteSelectedSessions] Deleted ${memberIdsToDelete.length} member links`);

        // Recalculate aggregates per partial group
        for (const groupId of partialGroupIds) {
          // Fetch remaining members
          const remainingMembers = ensureArray(await supabaseRequest(
            supabaseConfig,
            `unassigned_group_members?group_id=eq.${groupId}&select=activity_record_id,unassigned_activity_id`
          ));

          const newSessionCount = remainingMembers.length;

          // Fetch total_time_seconds from remaining activity_records
          const remainingActivityIds = remainingMembers
            .map(m => m.activity_record_id)
            .filter(Boolean);
          
          let newTotalSeconds = 0;
          if (remainingActivityIds.length > 0) {
            const activities = ensureArray(await supabaseRequest(
              supabaseConfig,
              `activity_records?id=in.(${remainingActivityIds.join(',')})&select=total_time_seconds,duration_seconds`
            ));
            newTotalSeconds = activities.reduce((sum, a) => sum + (a.total_time_seconds || a.duration_seconds || 0), 0);
          }

          // Update group
          await supabaseRequest(
            supabaseConfig,
            `unassigned_work_groups?id=eq.${groupId}&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
            {
              method: 'PATCH',
              body: {
                session_count: newSessionCount,
                total_seconds: newTotalSeconds
              }
            }
          );
          console.log(`[deleteSelectedSessions] Updated group ${groupId}: session_count=${newSessionCount}, total_seconds=${newTotalSeconds}`);
        }
      } catch (err) {
        console.error(`[deleteSelectedSessions] Error processing partial groups:`, err.message);
        throw err;
      }
    }

    // Step 5: Return success with metadata
    return {
      success: true,
      dismissedSessionCount: validSessionIds.length,
      groupIds: validGroupIds,
      fullyDismissedGroupIds,
      partialGroupIds
    };

  } catch (error) {
    console.error(`[deleteSelectedSessions] Fatal error:`, error);
    return handleResolverError(error, 'deleting selected sessions');
  }
}
```

#### Register the Resolver

**File:** `forge-app/src/resolvers/unassigned/assignmentResolvers.js`

**Location:** Line ~1512 (in `registerAssignmentResolvers` function)

```javascript
export function registerAssignmentResolvers(resolver) {
  resolver.define('assignToExistingIssue', assignToExistingIssue);
  resolver.define('assignSelectionToExistingIssue', assignSelectionToExistingIssue);
  resolver.define('createIssueAndAssign', createIssueAndAssign);
  resolver.define('createIssueAndAssignSelection', createIssueAndAssignSelection);
  resolver.define('previewBulkReassign', previewBulkReassign);
  resolver.define('bulkReassignByTimeInterval', bulkReassignByTimeInterval);
  resolver.define('dismissUnassignedGroup', dismissUnassignedGroup);
  resolver.define('dismissGroupMember', dismissGroupMember);
  resolver.define('deleteSelectedSessions', deleteSelectedSessions); // NEW
}
```

---

## 4. Implementation Prompts

Use these prompts with Claude/Copilot to implement the feature step-by-step:

### Prompt 1: Frontend — SelectionBar Component

```
Update the SelectionBar component to add a "Delete Selected" button:

File: forge-app/static/main/src/components/unassigned/SelectionBar.js

Add a new prop `onDelete` to the component signature.
Add a third button "Delete Selected" between "Clear" and "Assign Selected".
Button should have className="selection-bar-delete".
Button text: "Delete Selected" (no icon).

Also update SelectionBar.css to add styles for .selection-bar-delete:
- Background: var(--ds-background-danger, #de350b)
- Color: white
- Hover: var(--ds-background-danger-hovered, #bf2600)
- Active: var(--ds-background-danger-pressed, #a32500)
- Match padding/border-radius of other buttons (6px 14px, 3px radius)
```

### Prompt 2: Frontend — UnassignedWork Handler

```
Add a delete handler to UnassignedWork.js:

File: forge-app/static/main/src/components/UnassignedWork.js

Insert after handleAssignSelection (around line 530):

Create a new function handleDeleteSelection that:
1. Calls buildSelectionPayload() to get sessionIds, groupIds, sessionCount, totalSeconds
2. Shows a confirmation dialog with the counts (use window.confirm)
3. If confirmed, calls invoke('deleteSelectedSessions', { sessionIds, groupIds })
4. On success:
   - Removes fullyDismissedGroupIds from groups state
   - Clears groupDetails and groupWorkSessions caches for affected groups
   - Calls clearSelection()
5. On error, shows alert with error message

Then wire this handler to the SelectionBar component (around line 755):
Add onDelete={handleDeleteSelection} prop to the SelectionBar component.
```

### Prompt 3: Backend — New Resolver

```
Create a new backend resolver for bulk delete:

File: forge-app/src/resolvers/unassigned/assignmentResolvers.js

Insert a new function deleteSelectedSessions after dismissGroupMember (line ~1500).

The function should:
1. Accept req.payload: { sessionIds: string[], groupIds: string[] }
2. Validate and sanitize input using sanitizeUUIDArray
3. For each group, determine if ALL members are selected (full dismiss) or only some (partial)
4. Mark all selected sessions as clustering_dismissed in activity_records table
5. For fully covered groups: mark group as is_dismissed=true
6. For partial groups: delete member links from unassigned_group_members and recalculate session_count and total_seconds
7. Return { success, dismissedSessionCount, groupIds, fullyDismissedGroupIds, partialGroupIds }

Follow the pattern of assignSelectionToExistingIssue for multi-group logic.
Use existing helpers: initializeRequestContext, ensureArray, supabaseRequest.

Then register it in registerAssignmentResolvers:
Add resolver.define('deleteSelectedSessions', deleteSelectedSessions);
```

### Prompt 4: Testing

```
Create a Jest test for the deleteSelectedSessions resolver:

File: forge-app/tests/resolvers/deleteSelectedSessions.test.js (new file)

Test cases:
1. Successfully dismisses a fully selected group
2. Successfully processes partial group selection (removes members, updates aggregates)
3. Handles mixed selection (some full groups, some partial)
4. Returns error when sessionIds array is empty
5. Returns error when groupIds array is empty
6. Marks activity_records as clustering_dismissed

Mock supabaseRequest to return appropriate data.
Follow the pattern of existing resolver tests (see tests/resolvers/).
```

---

## 5. Testing Strategy

### 5.1 Unit Tests

**New test file:** `forge-app/tests/resolvers/deleteSelectedSessions.test.js`

```javascript
describe('deleteSelectedSessions', () => {
  it('fully dismisses a group when all members are selected', async () => {
    // Mock: group has 3 members, all 3 in sessionIds
    // Expect: group marked as is_dismissed=true
  });

  it('partially dismisses a group when some members are selected', async () => {
    // Mock: group has 5 members, 2 in sessionIds
    // Expect: 2 member links deleted, session_count updated to 3
  });

  it('handles mixed selection across multiple groups', async () => {
    // Mock: 2 groups, first fully selected, second partial
    // Expect: first group dismissed, second group updated
  });

  it('returns error when sessionIds is empty', async () => {
    // Expect: { success: false, error: 'No valid session IDs provided' }
  });

  it('marks all selected records as clustering_dismissed', async () => {
    // Verify PATCH call to activity_records with clustering_dismissed=true
  });
});
```

### 5.2 Manual Testing Checklist

| Test Case | Steps | Expected Result |
|-----------|-------|-----------------|
| **Single group full selection** | 1. Check a group's header checkbox<br>2. Click "Delete Selected"<br>3. Confirm dialog | Group disappears from list immediately |
| **Single group partial selection** | 1. Expand group, check 2 of 5 intervals<br>2. Click "Delete Selected"<br>3. Confirm | Group remains, shows 3 intervals, updated time |
| **Multi-group full selection** | 1. Check 3 group headers<br>2. Click "Delete Selected"<br>3. Confirm | All 3 groups disappear |
| **Mixed selection** | 1. Check 1 full group + 2 intervals from another<br>2. Click "Delete Selected"<br>3. Confirm | First group gone, second group updated |
| **Cancel confirmation** | 1. Select sessions<br>2. Click "Delete Selected"<br>3. Cancel dialog | Nothing happens, selection persists |
| **Error handling** | 1. Mock backend failure<br>2. Click "Delete Selected" | Alert shows error message |
| **Selection bar visibility** | 1. Delete all selected items<br>2. Observe UI | SelectionBar disappears |
| **Pagination preserved** | 1. Select items<br>2. Delete them<br>3. Check offset | "Load More" still works correctly |

---

## 6. Database Impact Analysis

### 6.1 Tables Modified

| Table | Operation | Field Updated | Notes |
|-------|-----------|---------------|-------|
| `activity_records` | PATCH | `clustering_dismissed = true`<br>`clustering_dismissed_at = now()` | Prevents re-clustering |
| `unassigned_work_groups` | PATCH | `is_dismissed = true`<br>`dismissed_at = now()`<br>`dismissed_by = userId` | Full dismissal only |
| `unassigned_work_groups` | PATCH | `session_count`<br>`total_seconds` | Partial dismissal recalc |
| `unassigned_group_members` | DELETE | (row deletion) | Partial dismissal only |

### 6.2 RLS Policy Compliance

All queries include:
- `user_id=eq.${userId}` — ensures users can only delete their own data
- `organization_id=eq.${organization.id}` — multi-tenancy boundary

Existing RLS policies on these tables already enforce these constraints at the database level, so the resolver's filters match the policies.

### 6.3 Data Retention

**No data is permanently deleted:**
- Activity records remain in `activity_records` table (only flagged as dismissed)
- Groups remain in `unassigned_work_groups` (only marked as dismissed)
- Screenshot/OCR data untouched
- Only the **clustering membership** is removed (sessions won't re-cluster)

This follows the existing dismiss pattern — "delete" is semantic (remove from UI), not physical.

---

## 7. Edge Cases & Error Handling

### 7.1 Edge Cases

| Scenario | Behavior |
|----------|----------|
| **User selects same group twice** | Deduplication in `buildSelectionPayload()` prevents duplicate processing |
| **Group deleted by another user mid-operation** | Backend returns success (no rows updated), frontend silently continues |
| **Session already dismissed** | PATCH is idempotent — no error, just logs "0 rows updated" |
| **Empty selection** | `handleDeleteSelection` returns early if `sessionIds.length === 0` |
| **Network timeout** | Forge Remote handles retries — eventual error caught in catch block |

### 7.2 Error States

| Error | Frontend Handling | Backend Response |
|-------|------------------|------------------|
| **Validation failure** | Alert with `result.error` | `{ success: false, error: "No valid session IDs provided" }` |
| **Supabase query error** | Alert with exception message | Logged as "Fatal error", returns generic error |
| **Partial failure** | Not applicable — operation is atomic per session | N/A |
| **Permission denied (RLS)** | Alert "Check permissions" | Returns success but logs warning |

---

## 8. Code Review Checklist

Before merging, verify:

- [ ] SelectionBar has `onDelete` prop and "Delete Selected" button
- [ ] Button styles match Atlassian design tokens (danger variant)
- [ ] Confirmation dialog shows correct counts (groups, sessions, time)
- [ ] `handleDeleteSelection` clears caches for affected groups
- [ ] Backend resolver validates `sessionIds` and `groupIds` (non-empty, valid UUIDs)
- [ ] Full vs partial dismissal logic matches `assignSelectionToExistingIssue` pattern
- [ ] Partial groups correctly recalculate `session_count` and `total_seconds`
- [ ] All database updates include `user_id` and `organization_id` filters
- [ ] Resolver returns `fullyDismissedGroupIds` for frontend to filter groups
- [ ] Unit tests cover full/partial/mixed scenarios
- [ ] Manual testing confirms UI updates immediately after delete
- [ ] No console errors or warnings in browser/server logs
- [ ] Existing single-group "Delete" button still works (no regression)

---

## 9. Rollout Plan

### Phase 1: Implementation (1 hour)
1. Create feature branch: `feature/bulk-delete-unassigned-sessions`
2. Implement frontend changes (SelectionBar, UnassignedWork.js)
3. Implement backend resolver (`deleteSelectedSessions`)
4. Run local tests (`npm test` in forge-app/)

### Phase 2: Testing (30 min)
1. Deploy to dev environment (`forge deploy --env development`)
2. Manual testing per checklist (section 5.2)
3. Write unit tests if time permits (else add to tech debt)

### Phase 3: Production (30 min)
1. Code review + approval
2. Merge to main
3. Deploy to production (`forge deploy`)
4. Monitor logs for errors (first 24 hours)

### Rollback Plan
If critical issue discovered:
1. Revert commit via Git
2. Re-deploy previous version
3. Users lose only the "Delete Selected" button (no data loss — feature is additive)

---

## 10. Future Enhancements (Out of Scope for v1)

| Enhancement | Effort | Priority |
|-------------|--------|----------|
| **Undo deletion** | High | Low (sessions can be re-captured by desktop app) |
| **Bulk delete from collapsed groups** | Medium | Medium (convenience feature) |
| **Keyboard shortcut (Delete key)** | Low | Low (power user feature) |
| **Deletion analytics** | Medium | Low (track how often users delete vs assign) |
| **"Delete All Unassigned"** | Low | Low (dangerous — requires extra safeguards) |

---

## 11. Summary for LLM Implementation

**When given this document + the prompt "implement bulk delete for unassigned sessions", the LLM should:**

1. **Read sections 3.1 and 3.2** for exact code changes
2. **Apply prompts from section 4** in order (SelectionBar → UnassignedWork → Resolver)
3. **Validate against section 7** (edge cases) and section 8 (checklist)
4. **Reference section 2** for architectural context if needed

**Key files to modify:**
- `forge-app/static/main/src/components/unassigned/SelectionBar.js`
- `forge-app/static/main/src/components/unassigned/SelectionBar.css`
- `forge-app/static/main/src/components/UnassignedWork.js`
- `forge-app/src/resolvers/unassigned/assignmentResolvers.js`

**Pattern to follow:** Mirror `assignSelectionToExistingIssue` but replace "assign to issue" logic with "mark as dismissed" logic.

**Critical constraints:**
- Never physically delete records — only flag as `clustering_dismissed`
- Always include `user_id` and `organization_id` in queries
- Handle both full and partial group dismissals
- Update group aggregates when doing partial dismissal

**Success criteria:**
- User can select multiple groups/intervals → click "Delete Selected" → confirm → items disappear from UI
- Backend marks records as dismissed and updates group state
- No data loss — dismissed records remain queryable in database
- Feature works identically to "Assign Selected" from a UX perspective

---

## Appendix A: Quick Reference — Key Functions

### Frontend (UnassignedWork.js)

```javascript
// Build payload from selection state
buildSelectionPayload() → { sessionIds, groupIds, totalSeconds, sessionCount }

// Clear all selections
clearSelection() → resets fullySelectedGroups + selectedIntervalsByGroup

// Remove session from cache after dismiss
removeSessionFromGroupCache(groupId, session) → updates groupDetails + groupWorkSessions
```

### Backend (assignmentResolvers.js)

```javascript
// Initialize request context (org, user, config)
initializeRequestContext(req) → { success, config, organization, userId, accountId, cloudId }

// Sanitize UUIDs from user input
sanitizeUUIDArray(arr) → string[] (valid UUIDs only)

// Query Supabase via Forge Remote
supabaseRequest(config, query, options?) → Promise<any>

// Wrap errors for consistent response format
handleResolverError(error, action) → { success: false, error: string }
```

---

**End of Implementation Guide**

This document contains everything needed to implement the bulk delete feature without breaking existing functionality. All code changes are spec-driven and follow established patterns in the codebase.

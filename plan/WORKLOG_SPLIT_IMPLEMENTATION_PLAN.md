# Worklog Split Between Issues — Implementation Plan

## 1. Overview

### Problem Statement

When the desktop app's AI analysis incorrectly attributes all tracked time to a single Jira issue, the user ends up with a single aggregated worklog on the wrong issue. For example:

- User works **10 minutes on issue A** and **8 minutes on issue B**
- AI assigns all activity records to issue B
- Worklog sync creates a **single 18-minute worklog on issue B**
- Issue A has **0 minutes** logged

The existing `reassignWorklog` feature moves the **entire** worklog from one issue to another (all-or-nothing), which doesn't solve this — moving 18m from B to A is equally wrong.

### Proposed Solution

Introduce a **Split Worklog** feature that allows users to **split a portion** of an existing Jira worklog and move it to a different issue. The existing "Reassign Worklog" (move 100%) becomes a special case of split where `splitSeconds == totalSeconds`.

**User flow:** User sees 18m on issue B → clicks split → enters "10m" to move to issue A → result: 8m remains on B, 10m created on A.

### Scope

| In Scope | Out of Scope |
|----------|-------------|
| Split a synced Jira worklog into two (partial move) | Splitting into 3+ issues in one operation |
| Full reassign as special case (move 100%) | Bulk split across multiple users |
| Update Jira worklog via PUT (reduce source) | Cross-organization splits |
| Create new Jira worklog via POST (target) | Splitting worklogs not created by JIRAForge |
| Update `worklog_sync` + `activity_records` | Desktop app changes |
| Time input UI (minutes/slider) | Automatic split suggestions |
| Maintain audit trail | Undo/revert UI |

---

## 2. Architecture & Data Flow

### Current State (Existing Reassign — All or Nothing)

```
User clicks "Reassign Worklog" (⇄ button in DayView)
    ↓
reassignWorklog(fromIssueKey, toIssueKey)
    ├─ DELETE Jira worklog on source issue
    ├─ CREATE Jira worklog on target issue (same total time)
    ├─ UPDATE worklog_sync record (change issue_key)
    └─ UPDATE ALL activity_records from source → target
```

**Problem:** Moves everything. Cannot split 18m into 10m + 8m.

### Proposed State (Split Worklog)

```
User clicks "Split Worklog" (⇄ button in DayView)
    ↓
Opens WorklogSplitModal with time input
    ↓ User enters: move 10m (600s) to issue A
    ↓
splitWorklog(fromIssueKey, toIssueKey, splitSeconds)
    ├─ 1. Validate inputs (splitSeconds > 0 && splitSeconds <= totalSeconds)
    ├─ 2. Fetch worklog_sync record for source issue
    ├─ 3. Calculate: remainingSeconds = totalSeconds - splitSeconds
    │
    ├─ IF splitSeconds == totalSeconds (full move):
    │   ├─ 4a. DELETE Jira worklog on source issue
    │   ├─ 5a. CREATE Jira worklog on target issue
    │   ├─ 6a. UPDATE worklog_sync (change issue_key, jira_worklog_id)
    │   └─ 7a. UPDATE ALL activity_records from source → target
    │
    ├─ IF splitSeconds < totalSeconds (partial split):
    │   ├─ 4b. UPDATE Jira worklog on source: totalSeconds → remainingSeconds (PUT)
    │   ├─ 5b. CREATE Jira worklog on target: splitSeconds (POST)
    │   ├─ 6b. UPDATE worklog_sync for source: last_synced_seconds = remainingSeconds
    │   ├─ 7b. CREATE new worklog_sync for target: last_synced_seconds = splitSeconds
    │   └─ 8b. Reassign proportional activity_records from source → target
    │
    └─ 9. Return success with split details
```

### Jira API Calls Per Scenario

| Scenario | Source Issue | Target Issue |
|----------|-------------|-------------|
| Full move (splitSeconds == total) | `DELETE /rest/api/3/issue/{key}/worklog/{id}` | `POST /rest/api/3/issue/{key}/worklog` |
| Partial split (splitSeconds < total) | `PUT /rest/api/3/issue/{key}/worklog/{id}` (reduce time) | `POST /rest/api/3/issue/{key}/worklog` |

The `PUT` approach is preferred for partial splits because it preserves the original worklog's author and creation timestamp on the source issue.

---

## 3. Database Changes

### 3.1 No New Migrations Required

The existing migration `20260327_add_worklog_reassignment.sql` already added `reassigned_from` and `reassigned_at` to `worklog_sync`. These columns plus the existing `worklog_sync` table structure are sufficient for the split feature.

For a partial split:
- The **source** `worklog_sync` record gets its `last_synced_seconds` reduced (no new columns needed)
- A **new** `worklog_sync` record is created for the target issue (standard INSERT)

### 3.2 Data Changes Per Operation

| Operation | `worklog_sync` (source) | `worklog_sync` (target) | `activity_records` |
|-----------|------------------------|------------------------|--------------------|
| Full move | UPDATE `issue_key`, `jira_worklog_id`, `reassigned_from`, `reassigned_at` | — (source record reused) | UPDATE all records: `user_assigned_issue_key` → target |
| Partial split | UPDATE `last_synced_seconds` = remaining | INSERT new record with target issue + `splitSeconds` + `reassigned_from` | UPDATE a subset of records: `user_assigned_issue_key` → target |

### 3.3 Activity Records Splitting Strategy

When splitting partially, we need to decide **which** `activity_records` to move to the target issue. Strategy:

1. Query all `activity_records` for the source issue, ordered by `end_time DESC`
2. Accumulate `duration_seconds` until we reach `splitSeconds`
3. Move those records to the target issue
4. Remaining records stay on the source issue

This is a **best-effort** approach — since the AI may have misattributed records, exact matching isn't expected. What matters is that the **worklog seconds in Jira** are correct.

If activity records don't sum neatly to `splitSeconds`, we move the closest set and let the worklog_sync `last_synced_seconds` be the source of truth for Jira accuracy.

---

## 4. Backend Implementation

### 4.1 Update Service: `worklogReassignmentService.js`

**File:** `forge-app/src/services/worklogReassignmentService.js`

Add a new exported function `splitWorklog()` alongside the existing `reassignWorklog()`. The existing `reassignWorklog()` function remains unchanged for backward compatibility.

```javascript
/**
 * Split a synced worklog — move a portion of time from one issue to another.
 *
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} fromIssueKey - Source issue key (e.g., "PROJ-2")
 * @param {string} toIssueKey - Target issue key (e.g., "PROJ-1")
 * @param {number} splitSeconds - Seconds to move to target issue
 * @returns {Promise<Object>} Result of the split
 */
export async function splitWorklog(accountId, cloudId, fromIssueKey, toIssueKey, splitSeconds) {
  // 1. Validate inputs
  //    - Both issue keys valid format
  //    - Source ≠ target
  //    - splitSeconds > 0 and is an integer
  //    - splitSeconds ≤ source worklog's last_synced_seconds

  // 2. Fetch worklog_sync record for source issue
  //    - Must exist and have jira_worklog_id (synced state)

  // 3. Check if target already has a worklog_sync record
  //    - If yes, BLOCK (merge not supported — user must reassign activity records first)

  // 4. Calculate remainingSeconds = last_synced_seconds - splitSeconds

  // 5. Branch: full move vs partial split
  //    IF splitSeconds === last_synced_seconds:
  //      → delegate to existing reassignWorklog() for full move
  //    ELSE (partial split):
  //      → Step 5a: PUT source worklog (reduce to remainingSeconds)
  //      → Step 5b: POST target worklog (splitSeconds)
  //      → Step 5c: Update source worklog_sync (last_synced_seconds = remainingSeconds)
  //      → Step 5d: Insert new worklog_sync for target
  //      → Step 5e: Move proportional activity_records to target

  // 6. Return result
}
```

**Key implementation details:**

```javascript
// --- Partial split: UPDATE source, CREATE target ---

// Step 5a: Reduce source worklog in Jira
const updateResponse = await updateJiraWorklog(fromIssueKey, jira_worklog_id, remainingSeconds);
if (updateResponse.status !== 200) {
  throw new Error(`Failed to update worklog on ${fromIssueKey}: HTTP ${updateResponse.status}`);
}

// Step 5b: Create target worklog in Jira
const createResult = await createJiraWorklog(toIssueKey, splitSeconds, worklogStartedAt);
if (!createResult.id) {
  // ROLLBACK: restore source worklog to original seconds
  await updateJiraWorklog(fromIssueKey, jira_worklog_id, totalSeconds);
  throw new Error(`Failed to create worklog on ${toIssueKey}`);
}

// Step 5c: Update source worklog_sync
await supabaseRequest(supabaseConfig, `worklog_sync?id=eq.${syncId}`, {
  method: 'PATCH',
  body: { last_synced_seconds: remainingSeconds, updated_at: now }
});

// Step 5d: Create target worklog_sync
await supabaseRequest(supabaseConfig, 'worklog_sync', {
  method: 'POST',
  body: {
    organization_id: orgId,
    user_id: userId,
    issue_key: toIssueKey,
    jira_worklog_id: String(createResult.id),
    last_synced_seconds: splitSeconds,
    started_at: worklogStartedAt,
    created_as_user: true,
    reassigned_from: fromIssueKey,
    reassigned_at: now
  }
});

// Step 5e: Move proportional activity_records
await reassignProportionalActivityRecords(
  supabaseConfig, userId, orgId, fromIssueKey, toIssueKey, splitSeconds
);
```

**Activity record reassignment helper:**

```javascript
/**
 * Move a subset of activity_records from source → target to cover splitSeconds.
 * Uses newest-first ordering so the most recent work gets reassigned.
 */
async function reassignProportionalActivityRecords(
  supabaseConfig, userId, orgId, fromIssueKey, toIssueKey, splitSeconds
) {
  const toProjectKey = toIssueKey.split('-')[0];
  const now = new Date().toISOString();

  // Fetch activity records for the source issue, newest first
  const records = await supabaseRequest(
    supabaseConfig,
    `activity_records?user_id=eq.${userId}&organization_id=eq.${orgId}` +
    `&user_assigned_issue_key=eq.${fromIssueKey}` +
    `&select=id,duration_seconds,total_time_seconds` +
    `&order=end_time.desc&limit=500`
  );

  if (!records || records.length === 0) return;

  // Accumulate records until we cover splitSeconds
  let accumulated = 0;
  const idsToMove = [];

  for (const record of records) {
    if (accumulated >= splitSeconds) break;
    const duration = record.duration_seconds || record.total_time_seconds || 0;
    idsToMove.push(record.id);
    accumulated += duration;
  }

  if (idsToMove.length === 0) return;

  // Batch update (Supabase supports IN filter)
  await supabaseRequest(
    supabaseConfig,
    `activity_records?id=in.(${idsToMove.join(',')})`,
    {
      method: 'PATCH',
      body: {
        user_assigned_issue_key: toIssueKey,
        project_key: toProjectKey,
        reassigned_from: fromIssueKey,
        reassigned_at: now
      }
    }
  );
}
```

### 4.2 Rollback Strategy

| Step that fails | Rollback action |
|----------------|-----------------|
| Jira PUT on source (step 5a) | No changes made — throw error |
| Jira POST on target (step 5b) | PUT source back to original seconds |
| Supabase update source sync (step 5c) | Jira is already correct; DB is eventually consistent via next sync cycle |
| Supabase insert target sync (step 5d) | Source sync is already correct; orphaned Jira worklog cleaned up next sync |
| Activity records update (step 5e) | Non-critical; worklog_sync `last_synced_seconds` is source of truth |

The two Jira API calls (steps 5a + 5b) are the only ones that need explicit rollback handling. Database operations are best-effort — the scheduled sync job will reconcile any inconsistencies.

### 4.3 New Resolver: `splitWorklog`

**File:** `forge-app/src/resolvers/worklogResolvers.js`

```javascript
/**
 * Resolver for splitting a synced Jira worklog between two issues.
 * Moves a specified amount of time from one issue to another.
 */
resolver.define('splitWorklog', async (req) => {
  const { context, payload } = req;
  const accountId = context.accountId;
  const cloudId = context.cloudId;
  const { fromIssueKey, toIssueKey, splitSeconds } = payload;

  if (!fromIssueKey || !toIssueKey) {
    return { success: false, error: 'Both fromIssueKey and toIssueKey are required' };
  }
  if (fromIssueKey === toIssueKey) {
    return { success: false, error: 'Cannot split to the same issue' };
  }
  if (!splitSeconds || splitSeconds <= 0 || !Number.isInteger(splitSeconds)) {
    return { success: false, error: 'splitSeconds must be a positive integer' };
  }

  try {
    const result = await splitWorklog(accountId, cloudId, fromIssueKey, toIssueKey, splitSeconds);
    return {
      success: true,
      fromIssueKey: result.fromIssueKey,
      toIssueKey: result.toIssueKey,
      splitSeconds: result.splitSeconds,
      remainingSeconds: result.remainingSeconds,
      message: result.message
    };
  } catch (error) {
    console.error(`[splitWorklog] Error: ${error.message}`);
    return { success: false, error: error.message };
  }
});
```

### 4.4 Import Updates

**File:** `forge-app/src/resolvers/worklogResolvers.js` — add import:

```javascript
import { reassignWorklog, splitWorklog } from '../services/worklogReassignmentService.js';
```

No changes needed to `manifest.yml` — the `splitWorklog` resolver uses the same handler function (`index.handler`) already registered for all resolvers.

---

## 5. Frontend Implementation

### 5.1 Update Component: `WorklogReassignModal.js` → `WorklogSplitModal.js`

**File:** `forge-app/static/main/src/components/modals/WorklogReassignModal.js`

Rename and enhance the existing modal to support time input:

```
┌─────────────────────────────────────────────┐
│  Split Worklog                            ✕ │
│                                             │
│  Issue B (PROJ-2) — Total: 18m              │
│                                             │
│  Time to move:                              │
│  ┌─────────────────────────────────────┐    │
│  │  ◀──────────●──────────▶            │    │
│  │             10m                     │    │
│  └─────────────────────────────────────┘    │
│  [ 10 ] minutes  of 18m                    │
│                                             │
│  ⚠ 10m will be moved to the selected       │
│  issue. 8m will remain on PROJ-2.           │
│  (Move all 18m for full reassignment)       │
│                                             │
│  🔍 Search issues...                       │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ PROJ-1  Implement feature           │    │
│  │         In Progress  ●              │    │
│  ├─────────────────────────────────────┤    │
│  │ PROJ-3  Update docs                 │    │
│  │         In Progress  ●              │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

**Key changes to the existing `WorklogReassignModal`:**

1. **Add state:** `splitMinutes` (initialized to total minutes of the worklog)
2. **Add range slider** and number input for specifying how many minutes to move
3. **Dynamic label:** Shows "Moving Xm to [target]. Ym remaining on [source]."
4. **Full move shortcut:** If slider is at max, show "Moving all time (full reassignment)"
5. **Update `onReassign` callback:** Pass `splitSeconds` as second argument: `onReassign(toIssueKey, splitMinutes * 60)`

**Props change:**

```javascript
// Before:
onReassign(toIssueKey)

// After:
onReassign(toIssueKey, splitSeconds)
```

**Validation rules in the UI:**

| Rule | Behavior |
|------|----------|
| Minimum: 1 minute (60 seconds) | Slider min = 1, input min = 1 |
| Maximum: total minutes of the worklog | Slider max = totalMinutes |
| Jira minimum: 60 seconds | Always enforced (both split portion and remainder must be ≥ 60s) |
| Remainder check | If `totalSeconds - splitSeconds < 60`, force full move |

### 5.2 Update `App.js` Handler

**File:** `forge-app/static/main/src/App.js`

Update `handleReassignWorklog` to pass `splitSeconds` to the new resolver:

```javascript
const handleReassignWorklog = async (toIssueKey, splitSeconds) => {
  if (!worklogToReassign || reassigningWorklog) return;

  setReassigningWorklog(true);
  try {
    const result = await invoke('splitWorklog', {
      fromIssueKey: worklogToReassign.fromIssueKey,
      toIssueKey: toIssueKey,
      splitSeconds: splitSeconds
    });

    if (result.success) {
      await loadActiveIssues();
      closeWorklogReassignModal();
    } else {
      alert(`Failed to split worklog: ${result.error}`);
    }
  } catch (err) {
    console.error('Error splitting worklog:', err);
    alert(`Error splitting worklog: ${err.message}`);
  } finally {
    setReassigningWorklog(false);
  }
};
```

### 5.3 DayView Button — No Changes

The existing ⇄ button in [DayView.js](forge-app/static/main/src/components/tabs/time-analytics/DayView.js) (lines 769–782) already passes `{ fromIssueKey, timeSpentSeconds, issueSummary }` to `onOpenWorklogReassignModal`. This data is sufficient — the modal uses `timeSpentSeconds` to set the slider maximum.

### 5.4 CSS Additions

**File:** `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css` (or existing stylesheet)

```css
/* Split Worklog Modal — Time Input */
.split-time-section {
  margin: 16px 0;
  padding: 12px;
  background: #f4f5f7;
  border-radius: 6px;
}

.split-slider-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.split-slider {
  flex: 1;
  -webkit-appearance: none;
  height: 6px;
  border-radius: 3px;
  background: #dfe1e6;
  outline: none;
}

.split-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #0052cc;
  cursor: pointer;
}

.split-minutes-input {
  width: 60px;
  padding: 4px 8px;
  border: 1px solid #dfe1e6;
  border-radius: 4px;
  font-size: 0.9rem;
  text-align: center;
}

.split-summary {
  margin-top: 8px;
  font-size: 0.85rem;
  color: #5e6c84;
}

.split-summary strong {
  color: #172b4d;
}
```

---

## 6. Step-by-Step Implementation Checklist

### Phase 1: Backend — Split Service (Priority 1)

- [ ] Add `splitWorklog()` function to `forge-app/src/services/worklogReassignmentService.js`
- [ ] Add `reassignProportionalActivityRecords()` helper function
- [ ] Implement rollback logic (PUT source back to original if target POST fails)
- [ ] Handle full-move case (delegate to existing `reassignWorklog()` when splitSeconds == total)
- [ ] Add `splitWorklog` resolver to `forge-app/src/resolvers/worklogResolvers.js`
- [ ] Update import in `worklogResolvers.js` to include `splitWorklog`

### Phase 2: Frontend — Modal Update (Priority 2)

- [ ] Update `WorklogReassignModal.js` to add time slider + number input
- [ ] Add `splitMinutes` state, initialized to total minutes
- [ ] Add validation: min 1 minute, max = total; remainder must be ≥ 60s or do full move
- [ ] Update `onReassign` callback to pass `splitSeconds`
- [ ] Update `App.js` `handleReassignWorklog` to call `splitWorklog` resolver with `splitSeconds`
- [ ] Add CSS for slider and time input

### Phase 3: Unit Tests (Priority 3)

- [ ] Write `forge-app/tests/services/worklogSplit.test.js`
- [ ] Test: partial split (10m of 18m) — Jira PUT + POST, two worklog_sync records
- [ ] Test: full move (18m of 18m) — delegates to reassignWorklog
- [ ] Test: splitSeconds > totalSeconds → error
- [ ] Test: splitSeconds == 0 → error
- [ ] Test: remainder < 60s → auto-converts to full move
- [ ] Test: target already has worklog → error
- [ ] Test: rollback when Jira POST (target) fails
- [ ] Test: activity_records proportional reassignment

### Phase 4: Playwright E2E Tests (Priority 4)

- [ ] Update existing `worklog-reassignment/` test directory
- [ ] Test: modal shows slider/input for time amount
- [ ] Test: slider adjusts split amount
- [ ] Test: partial split completes and updates both issues
- [ ] Test: full move (slider at max) still works
- [ ] Test: minimum/maximum validation on input

### Phase 5: QA & Verification

- [ ] Manual test with Forge tunnel
- [ ] Verify source issue worklog reduced in Jira (not deleted)
- [ ] Verify target issue has new worklog with correct time
- [ ] Verify time analytics totals update correctly
- [ ] Verify worklog_sync has two records (source reduced, target new)

---

## 7. API Contract

### `splitWorklog` Resolver

**Request Payload:**

```json
{
  "fromIssueKey": "PROJ-2",
  "toIssueKey": "PROJ-1",
  "splitSeconds": 600
}
```

**Success Response (Partial Split):**

```json
{
  "success": true,
  "fromIssueKey": "PROJ-2",
  "toIssueKey": "PROJ-1",
  "splitSeconds": 600,
  "remainingSeconds": 480,
  "newWorklogId": "54321",
  "message": "Split 600s from PROJ-2 to PROJ-1 (480s remaining on PROJ-2)"
}
```

**Success Response (Full Move):**

```json
{
  "success": true,
  "fromIssueKey": "PROJ-2",
  "toIssueKey": "PROJ-1",
  "splitSeconds": 1080,
  "remainingSeconds": 0,
  "newWorklogId": "54321",
  "message": "Worklog fully moved from PROJ-2 to PROJ-1 (1080s)"
}
```

**Error Response:**

```json
{
  "success": false,
  "error": "splitSeconds (2000) exceeds worklog total (1080s)"
}
```

---

## 8. Validation Rules

| Rule | Check Location | Error Message |
|------|---------------|---------------|
| `fromIssueKey` valid format | Backend + Frontend | "Invalid source issue key format" |
| `toIssueKey` valid format | Backend + Frontend | "Invalid target issue key format" |
| `fromIssueKey ≠ toIssueKey` | Backend + Frontend | "Cannot split to the same issue" |
| `splitSeconds > 0` | Backend + Frontend | "splitSeconds must be a positive integer" |
| `splitSeconds ≤ totalSeconds` | Backend | "splitSeconds (X) exceeds worklog total (Y)" |
| `splitSeconds` is integer | Backend | "splitSeconds must be a positive integer" |
| Jira minimum (60s) | Backend | Handled by `Math.max(seconds, 60)` in jira.js |
| Remainder ≥ 60s or full move | Frontend (UI) | Auto-switch to full move when remainder < 60s |
| Source worklog exists | Backend | "No synced worklog found for issue X" |
| Source worklog synced | Backend | "Worklog has not been synced to Jira yet" |
| Target has no existing worklog | Backend | "A worklog already exists for issue X" |

---

## 9. Edge Cases & Risk Mitigation

| Edge Case | Handling |
|-----------|---------|
| `splitSeconds` exactly equals total | Delegate to existing `reassignWorklog()` (full move via DELETE + CREATE) |
| Remainder would be < 60s (Jira minimum) | Frontend auto-converts to full move; backend enforces ≥ 60s via jira.js |
| Jira PUT succeeds but POST fails | Rollback: PUT source back to original total seconds |
| Rollback PUT also fails | Log CRITICAL error; `worklog_sync.last_synced_seconds` still has original value, next sync cycle will reconcile |
| Target issue already has a worklog | Block — return error. User must use session reassignment first |
| Activity records don't sum to splitSeconds | Best-effort: move records until ≥ splitSeconds covered; `worklog_sync` is source of truth |
| No activity records on source issue | Skip activity record reassignment; only Jira + worklog_sync are updated |
| Scheduled sync runs during split | Race condition is low-risk: sync skips entries where `last_synced_seconds` matches tracked time |
| User enters fractional minutes | Convert to whole seconds; UI uses minute granularity |
| Concurrent splits on same issue | UNIQUE constraint on `worklog_sync(org, user, issue)` prevents duplicate target records |

---

## 10. UX Flow

```
┌─────────────────────────────────────────────────────────────┐
│  Time Analytics → Day View                                   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  PROJ-2  Fix login bug         18m    ⇄              │   │
│  └──────────────────────────────────────────────────────┘   │
│        ↓ Click ⇄ (split worklog button)                      │
│                                                              │
│  ┌─────────────────────────────────────┐                     │
│  │  Split Worklog                    ✕ │                     │
│  │                                     │                     │
│  │  PROJ-2 — Total: 18m               │                     │
│  │                                     │                     │
│  │  Time to move:                      │                     │
│  │  ◀────────●────────▶   [10] min     │                     │
│  │                                     │                     │
│  │  ⚠ 10m → selected issue            │                     │
│  │    8m remains on PROJ-2             │                     │
│  │                                     │                     │
│  │  🔍 Search issues...               │                     │
│  │                                     │                     │
│  │  ┌─────────────────────────────┐   │                     │
│  │  │ PROJ-1  Implement feature   │   │                     │
│  │  │         In Progress  ●      │   │                     │
│  │  ├─────────────────────────────┤   │                     │
│  │  │ PROJ-3  Update docs         │   │                     │
│  │  │         In Progress  ●      │   │                     │
│  │  └─────────────────────────────┘   │                     │
│  └─────────────────────────────────────┘                     │
│                                                              │
│  After split:                                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  PROJ-1  Implement feature     10m    ⇄              │   │
│  │  PROJ-2  Fix login bug          8m    ⇄              │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 11. Files to Create / Modify

### Modified Files

| File | Change |
|------|--------|
| `forge-app/src/services/worklogReassignmentService.js` | Add `splitWorklog()` + `reassignProportionalActivityRecords()` |
| `forge-app/src/resolvers/worklogResolvers.js` | Add `splitWorklog` resolver + update import |
| `forge-app/static/main/src/components/modals/WorklogReassignModal.js` | Add time slider/input, update `onReassign` signature |
| `forge-app/static/main/src/App.js` | Update `handleReassignWorklog` to pass `splitSeconds` and call `splitWorklog` |
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css` (or equivalent) | Add slider/input CSS |

### New Files

| File | Purpose |
|------|---------|
| `forge-app/tests/services/worklogSplit.test.js` | Unit tests for split logic |

### Unchanged Files

| File | Reason |
|------|--------|
| `forge-app/manifest.yml` | No new function — resolver uses existing `index.handler` |
| `forge-app/src/index.js` | No new registration — `registerWorklogResolvers` already covers it |
| `supabase/migrations/` | No new columns needed |
| `forge-app/static/main/src/components/tabs/time-analytics/DayView.js` | ⇄ button already passes correct data |
| `forge-app/static/main/src/components/modals/index.js` | Component name unchanged |

---

## 12. Comparison: Split vs. Existing Reassign

| Aspect | Existing `reassignWorklog` | New `splitWorklog` |
|--------|---------------------------|-------------------|
| Time moved | 100% (all or nothing) | User-specified (1 min to 100%) |
| Source Jira worklog | DELETED | UPDATED (reduced) or DELETED if full |
| Source `worklog_sync` | Updated (issue_key changed) | Updated (seconds reduced) |
| Target `worklog_sync` | — (source record reused) | NEW record created |
| Activity records | All moved | Proportional subset moved |
| API calls | 1 DELETE + 1 POST | 1 PUT + 1 POST (or 1 DELETE + 1 POST for full) |
| Rollback | Re-create on source (POST) | Restore source seconds (PUT) |

The full-move case in `splitWorklog` delegates to the existing `reassignWorklog()` to avoid code duplication.

---

## 13. Testing Commands

```bash
# Run split worklog unit tests
cd forge-app && npm test -- --testPathPattern=worklogSplit

# Run all worklog-related tests
cd forge-app && npm test -- --testPathPattern=worklog

# Run Playwright E2E tests (if updated)
cd forge-app && npx playwright test --project=worklog-reassignment

# Manual testing with Forge tunnel
cd forge-app && forge tunnel
```

---

## 14. Definition of Done

- [ ] Users can split a worklog by specifying how many minutes to move
- [ ] Source Jira worklog is reduced (not deleted) for partial splits
- [ ] Target Jira worklog is created with the split amount
- [ ] `worklog_sync` has two records: source (reduced) + target (new)
- [ ] `activity_records` proportionally reassigned
- [ ] Full move (slider at max) delegates to existing reassign flow
- [ ] Time input validation enforces ≥ 1 min, ≤ total, remainder ≥ 60s
- [ ] Rollback works when target worklog creation fails
- [ ] Time analytics in DayView updates correctly after split
- [ ] Unit tests pass
- [ ] No regressions in existing reassign flow

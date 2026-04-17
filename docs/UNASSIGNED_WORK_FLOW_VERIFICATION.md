# Unassigned Work Flow - Complete Verification Guide

## Overview
This document describes the complete flow of unassigned work tracking, display in timeline, and conversion/assignment process. This flow helps verify that the recent fix for time spent calculations is working correctly.

---

## 1. UNASSIGNED WORK TRACKING FLOW

### 1.1 When Work is Tracked as Unassigned
**Source**: Hybrid OCR system (`activity_records`) or Legacy screenshots (`analysis_results`)

**Condition**: A work session is marked as unassigned when:
- `activity_records.user_assigned_issue_key IS NULL` (for new pipeline)
- `analysis_results.active_task_key IS NULL` (for legacy pipeline)
- The work is classified as productive or unknown
- It's not marked as idle or already dismissed

**Data Flow**:
```
Desktop App Tracks Work
    ↓
Window title/app capture → Activity Records (Hybrid OCR)
    ↓
Filter: Status = pending/processing/analyzed
        Classification = productive/unknown
        user_assigned_issue_key IS NULL
    ↓
Activity Record stored unassigned
```

### 1.2 Activity Records Table Structure
```sql
activity_records:
├── id                    -- UUID primary key
├── user_id               -- User who tracked the work
├── organization_id       -- Multi-tenant isolation
├── user_assigned_issue_key    -- NULL = unassigned ⭐
├── project_key          -- Project of assigned work (NULL for unassigned)
├── window_title         -- What was being worked on
├── application_name     -- Which app was active
├── start_time          -- When work started
├── end_time            -- When work ended
├── duration_seconds    -- Actual tracked time
├── classification      -- productive|unknown|other
├── clustering_dismissed -- If user dismissed the cluster
└── created_at
```

---

## 2. GROUPING & CLUSTERING FLOW

### 2.1 AI-Based Clustering
The **AI Server** periodically runs (scheduled or on-demand) to:
1. Fetch all unassigned work for a user/org
2. Group similar activities (same app/window title patterns)
3. Create `unassigned_work_groups` records
4. Link activities to groups via `unassigned_group_members`

### 2.2 Unassigned Work Groups Table
```sql
unassigned_work_groups:
├── id                      -- Group ID (UUID)
├── user_id                 -- Which user's work
├── organization_id         -- Multi-tenant isolation
├── group_label            -- AI-generated name ("Database Queries", etc)
├── group_description      -- More detail about the group
├── session_count          -- Number of activities in group
├── total_seconds          -- Total time for all activities
├── is_assigned            -- FALSE = shows in timeline ⭐
├── assigned_to_issue_key  -- JIRA issue key when assigned (null when unassigned)
├── assigned_at            -- When manual assignment happened
├── assigned_by            -- User who assigned it
├── confidence_level       -- high|medium|low regarding clustering accuracy
├── recommended_action     -- AI suggestion: assign_to or create_new
├── suggested_issue_key    -- Which issue AI recommends
├── recommendation_reason  -- Why it recommends that
└── created_at
```

### 2.3 Group Members Linking
```sql
unassigned_group_members:
├── id                      -- Link record ID
├── group_id                -- Which group
├── unassigned_activity_id  -- Which activity (from unassigned_activity table)
└── activity_record_id      -- Which activity (from activity_records table - new pipeline) [OPTIONAL]
```

**Important**: A group member can be from EITHER:
- Legacy pipeline: `unassigned_activity` → `analysis_results` + screenshots
- New pipeline: `activity_records` directly

---

## 3. TIMELINE DISPLAY FLOW

### 3.1 Timeline Query (Team Analytics Service)
**File**: `teamAnalyticsService.js` → `getTeamTimeline()`

**Query Structure**:
```javascript
// For a specific date (e.g., 2026-04-16)

// 1. Query activity_records (new pipeline)
activity_records:
  ├── user_id = specific_user_id
  ├── organization_id = org_id
  ├── created_at BETWEEN start_of_date AND end_of_date
  └── SEPARATE INTO:
      ├─ user_assigned_issue_key IS NOT NULL → sessions (assigned work)
      ├─ user_assigned_issue_key IS NULL → unassignedBlocks ⭐
      └─ is_idle = TRUE → idleBlocks

// 2. Query analysis_results with embedded screenshots (legacy pipeline)
analysis_results (with screenshots):
  ├── user_id = specific_user_id
  ├── organization_id = org_id
  ├── Filter by work_date or screenshot timestamp
  └── SEPARATE INTO:
      ├─ active_task_key IS NOT NULL → sessions
      ├─ active_task_key IS NULL → unassignedBlocks ⭐
      └─ is_idle = TRUE → idleBlocks
```

### 3.2 Timeline Data Structure
```javascript
userTimeline = {
  userId,
  displayName,
  sessions: [
    { startTime, endTime, durationSeconds, issueKey, id }  // Assigned work
  ],
  unassignedBlocks: [
    { startTime, endTime, durationSeconds, id }  // ⭐ Unassigned work shown as bars
  ],
  idleBlocks: [
    { startTime, endTime, durationSeconds, convertedIssueKey }
  ]
}
```

### 3.3 Timeline UI Rendering
**Expected Display**:
- **Green bars**: Assigned work (has issueKey)
- **Yellow/Orange bars**: Unassigned work (unassignedBlocks) ⭐
- **Gray bars**: Idle time
- **Total time calculation**:
  - "Total unassigned time" = SUM of all unassignedBlocks[].durationSeconds for the date

---

## 4. UNASSIGNED WORK PAGE & GROUPS LIST

### 4.1 getUnassignedGroups Query
**File**: `sessionResolvers.js`

**Query**:
```sql
unassigned_work_groups:
  ├── user_id = current_user_id
  ├── organization_id = org_id
  ├── is_assigned = FALSE ⭐ (only show un-assigned groups)
  ├── is_dismissed = FALSE
  ├── session_count > 0 (viability filter)
  ├── total_seconds > 0 (viability filter)
  ├── ORDER BY created_at DESC
  └── LIMIT X OFFSET Y (pagination: 10 per page default)
```

**Response Format**:
```javascript
{
  success: true,
  groups: [
    {
      id: group_uuid,
      label: "Database Queries",
      description: "Time spent on database optimization",
      session_count: 5,
      total_seconds: 1283,
      total_time_formatted: "21m 23s",
      confidence: "high",
      recommendation: {
        action: "assign_to",
        suggested_issue_key: "PROJ-123",
        reason: "Matches project timeline"
      },
      created_at: "2026-04-15T10:30:00Z",
      details_loaded: false  // Details fetched on-demand
    }
  ],
  total_groups: 15,
  has_more: true,
  next_offset: 10
}
```

### 4.2 Get Group Details (on-demand)
**File**: `sessionResolvers.js` → `getGroupDetails()`

When user expands a group:
```javascript
getGroupDetails(groupId) returns:
  ├── Group metadata (label, description, confidence, etc)
  ├── session_ids: [...] // List of actual activity record IDs in the group
  ├── activities: [
  │   {
  │     id, window_title, app_name, 
  │     start_time, end_time, duration_seconds, 
  │     timestamp
  │   }
  │ ]
  └── total_seconds, session_count (recalculated from actual data)
```

---

## 5. ASSIGNMENT/CONVERSION FLOW ⭐ CRITICAL

### 5.1 When User Assigns Unassigned Work
**User Actions**:
1. User opens "Unassigned Work" page
2. Sees list of grouped unassigned work
3. Clicks on a group
4. Chooses: "Assign to existing issue" OR "Create new issue"
5. Selects target issue or provides details for new issue
6. Clicks "Assign"

### 5.2 Backend Assignment Process
**File**: `assignmentResolvers.js` → `assignToExistingIssue()` or `createIssueAndAssign()`

**Steps**:
```
Step 1: Validate Input
  ├─ sessionIds array (activity record IDs)
  ├─ issueKey (PROJ-123 format)
  ├─ groupId (UUID of the group)
  ├─ totalSeconds (time to log)

Step 2: Update Activity Records ⭐ CRITICAL
  await activity_records
    .WHERE(id IN sessionIds)
    .WHERE(user_id = current_user_id)
    .WHERE(organization_id = org_id)
    .UPDATE({
      user_assigned_issue_key = issueKey,  // ⭐ NOW ASSIGNED!
      project_key = extracted_from_issueKey
    })

Step 3: Update Analysis Results (Legacy Support)
  await analysis_results
    .WHERE(id IN analysisResultIds from unassigned_activity)
    .UPDATE({
      active_task_key = issueKey,
      active_project_key = projectKey,
      manually_assigned = true,
      assignment_group_id = groupId
    })

Step 4: Mark Group as Assigned ⭐ CRITICAL FIX
  await unassigned_work_groups
    .WHERE(id = groupId)
    .UPDATE({
      is_assigned = TRUE,
      assigned_to_issue_key = issueKey,
      assigned_at = NOW(),
      assigned_by = current_user_id
    })

Step 5: Create Worklog in Jira (if timeToLog >= 60 seconds)
  POST /rest/api/3/issue/{issueKey}/worklog
  body: {
    timeSpentSeconds: timeToLog,
    comment: "Time tracked from N work session(s)...",
    started: current_timestamp
  }

Step 6: Return Success Response
  {
    success: true,
    assigned_count: sessionCount,
    worklog_id: worklog_uuid,
    worklog_skipped: false,
    issue_key: issueKey
  }
```

### 5.3 The Fix - What Should Change After Assignment
**BEFORE assignment:**
- Timeline query for that date returns activity as part of `unassignedBlocks`
- Group shows in `getUnassignedGroups()` list (is_assigned = FALSE)
- Total unassigned time includes this duration

**AFTER assignment (the fix):**
1. ✅ Activity record now has `user_assigned_issue_key = issueKey`
2. ✅ Timeline query re-evaluates: 
   - `user_assigned_issue_key IS NULL` is now FALSE
   - Activity goes to `sessions` (green bar) instead of `unassignedBlocks` (yellow bar)
3. ✅ Group row updated: `is_assigned = TRUE`
4. ✅ `getUnassignedGroups()` query filters it out (is_assigned = FALSE)
5. ✅ Total unassigned time DECREASES

**Expected UI Changes:**
```
BEFORE:
  Timeline: [Yellow bar: Database work] Total unassigned: 47m
  Unassigned Page: "Database Queries" group shown (5 sessions, 21m 23s)

AFTER (user converted it to PROJ-123):
  Timeline: [Green bar: Database work] Total unassigned: 26m
  Unassigned Page: "Database Queries" group NOT shown anymore
```

---

## 6. VERIFICATION CHECKLIST

### 6.1 Timeline Bars Update
- [ ] Before conversion: Yellow/unassigned bar visible for the work session
- [ ] After conversion: Bar turns green (becomes assigned session)
- [ ] Timeline updates without page reload
- [ ] Correct issue key shown on the bar

### 6.2 Total Unassigned Time Calculation
- [ ] Before: Total unassigned time includes the converted session's duration
- [ ] After: Total unassigned time decreases by exactly that session's duration
- [ ] Calculation is correct for multiple sessions in a group

### 6.3 Unassigned Work Page
- [ ] Before: Group visible with correct session count and total time
- [ ] After: Group no longer appears in the list
- [ ] Total unassigned groups count decreases
- [ ] No orphaned entries remain

### 6.4 Database State
- [ ] `activity_records.user_assigned_issue_key` updated to issueKey
- [ ] `unassigned_work_groups.is_assigned` set to TRUE
- [ ] `unassigned_work_groups.assigned_at` timestamp set correctly
- [ ] Worklog created in Jira (if >= 60 seconds)

### 6.5 Timeline Query Filters
- [ ] Query filters correctly: `user_assigned_issue_key IS NULL` for unassigned
- [ ] After assignment, record excluded from unassigned list
- [ ] Legacy data (analysis_results) also gets filtered correctly

---

## 7. DEBUGGING QUERIES

### 7.1 Check Unassigned Activities
```sql
-- See all unassigned work for a user on a date
SELECT 
  id, start_time, end_time, duration_seconds, 
  window_title, application_name,
  user_assigned_issue_key,  -- Should be NULL for unassigned
  project_key,
  created_at
FROM activity_records
WHERE user_id = 'USER_UUID'
  AND organization_id = 'ORG_UUID'
  AND user_assigned_issue_key IS NULL
  AND DATE(created_at) = '2026-04-16'
ORDER BY created_at DESC;
```

### 7.2 Check Unassigned Groups
```sql
-- See groups that should appear in unassigned work page
SELECT 
  id, group_label, session_count, total_seconds,
  is_assigned,  -- Should be FALSE to show
  is_dismissed,  -- Should be FALSE to show
  assigned_to_issue_key
FROM unassigned_work_groups
WHERE user_id = 'USER_UUID'
  AND organization_id = 'ORG_UUID'
  AND is_assigned = FALSE
  AND is_dismissed = FALSE
  AND session_count > 0
ORDER BY created_at DESC;
```

### 7.3 Check After Assignment
```sql
-- See if assignment was successful
SELECT 
  a.id, a.start_time, a.duration_seconds,
  a.user_assigned_issue_key,  -- Should NOW have issueKey
  a.project_key,
  g.id as group_id,
  g.is_assigned,  -- Should be TRUE
  g.assigned_to_issue_key
FROM activity_records a
LEFT JOIN unassigned_work_groups g ON a.id = ANY(g.session_ids_array)
WHERE a.id = 'ACTIVITY_UUID';
```

### 7.4 Check Group Members
```sql
-- See which activities belong to a group
SELECT 
  ugm.id, ugm.activity_record_id, ugm.unassigned_activity_id,
  ar.user_assigned_issue_key,
  ar.start_time, ar.duration_seconds
FROM unassigned_group_members ugm
LEFT JOIN activity_records ar ON ugm.activity_record_id = ar.id
WHERE ugm.group_id = 'GROUP_UUID'
ORDER BY ar.start_time DESC;
```

---

## 8. COMMON ISSUES & FIXES

### Issue 1: Unassigned Bars Don't Disappear After Conversion
**Causes**:
- Activity record's `user_assigned_issue_key` not updated
- Timeline query still filters it as unassigned
- Frontend cache not cleared

**Verification**:
```sql
SELECT user_assigned_issue_key FROM activity_records WHERE id = 'ACTIVITY_ID';
-- Should show the issueKey, not NULL
```

**Fix**: Check `updateSessionsAndAnalysis()` in assignmentResolvers.js

### Issue 2: Total Unassigned Time Doesn't Decrease
**Causes**:
- Group `is_assigned` not updated
- Timeline recalculation using cached data
- Additional unassigned activities still in the group

**Verification**:
```sql
SELECT is_assigned, assigned_to_issue_key FROM unassigned_work_groups WHERE id = 'GROUP_ID';
-- Should show is_assigned = TRUE and assigned_to_issue_key = PROJ-123
```

**Fix**: Check `markGroupAsAssigned()` in assignmentResolvers.js

### Issue 3: Group Still Shows in Unassigned List
**Causes**:
- `is_assigned` flag not set correctly
- Query still includes it due to stale cache
- `is_dismissed` flag interfering

**Verification**:
```sql
SELECT is_assigned, is_dismissed, session_count FROM unassigned_work_groups 
WHERE id = 'GROUP_ID';
-- Should show is_assigned = TRUE, is_dismissed = FALSE
```

**Fix**: Verify `getUnassignedGroups()` query includes the filter `is_assigned = FALSE`

---

## 9. KEY IMPLEMENTATION DETAILS

### 9.1 Multi-Timeline Support
The system supports BOTH pipelines simultaneously:
- **New Pipeline**: `activity_records` → `unassigned_work_groups` (direct)
- **Legacy Pipeline**: `analysis_results` + `unassigned_activity` → `unassigned_work_groups`

Both feed into the same groups table, so conversion logic must handle both sources.

### 9.2 Lazy Loading in Unassigned Page
- Summary load: Just group metadata (fast)
- Details load (on-demand): Full session list and screenshots
- This prevents loading unnecessary data for users who don't expand all groups

### 9.3 Worklog Creation Logic
- **If >= 60 seconds**: Create worklog immediately
- **If < 60 seconds**: Defer to scheduled sync (groups multiple entries per user+issue)
- **If auto-sync enabled**: Skip immediate worklog creation entirely

### 9.4 Security & Multi-Tenancy
All queries filter by:
- `organization_id` (multi-tenant isolation)
- `user_id` (data ownership)
- This prevents users seeing other users' unassigned work

---

## 10. TEST SCENARIOS

See TEST_UNASSIGNED_WORK_INTEGRATION.md for complete test scenarios and the sample data generation script.

---

*Last Updated: April 17, 2026*
*Flow Verified Against: assignmentResolvers.js, sessionResolvers.js, teamAnalyticsService.js*

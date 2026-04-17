# Unassigned Work - Test & Validation Guide

## Quick Start

### Option 1: Using SQL (Supabase Dashboard)
1. Open Supabase dashboard → SQL Editor
2. Copy entire `TEST_UNASSIGNED_WORK_INTEGRATION.sql`
3. Replace `'TARGET_USER_ID'::uuid`, `'TARGET_ORG_ID'::uuid`, etc with actual values
4. Run each PHASE section sequentially
5. Compare results with expected outputs

### Option 2: Using Node.js Script
```bash
# Install dependencies (if not already installed)
npm install @supabase/supabase-js

# Replace placeholders with actual values
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_KEY="your-service-key"

# Run the test
node test-unassigned-work-integration.js \
  --user-id "550e8400-e29b-41d4-a716-446655440000" \
  --org-id "660e8400-e29b-41d4-a716-446655440001" \
  --project "PROJ" \
  --issue "PROJ-123"

# Run with automatic cleanup
node test-unassigned-work-integration.js \
  --user-id "550e8400-e29b-41d4-a716-446655440000" \
  --org-id "660e8400-e29b-41d4-a716-446655440001" \
  --cleanup
```

---

## Understanding the Flow

### Three Data Pipelines
The system supports TWO concurrent pipelines:

#### Pipeline 1: New Hybrid OCR Approach (Modern)
```
activity_records Table
├── Directly tracks unassigned work
├── Columns: user_assigned_issue_key (NULL for unassigned)
└── Used by: Timeline queries, unassigned groups
```

#### Pipeline 2: Legacy Screenshot Analysis (Backwards Compat)
```
analysis_results + unassigned_activity
├── Legacy AI analysis of screenshots
├── Columns: active_task_key (NULL for unassigned)
└── Used by: Legacy clients, worklog sync
```

#### Pipeline 3: Grouping (Both Sources)
```
unassigned_work_groups + unassigned_group_members
├── AI-clusters similar activities from BOTH pipelines
├── Key Filter: is_assigned = FALSE (shows in UI)
└── After assignment: is_assigned = TRUE (hidden from UI)
```

---

## Test Phases Explained

### Phase 1: Sample Data Creation
**What it does**: Creates 3 unassigned work activities
- Activity 1: pgAdmin (900s = 15m) @ 09:30-09:45
- Activity 2: VS Code (720s = 12m) @ 10:15-10:27
- Activity 3: Chrome (1080s = 18m) @ 11:00-11:18
- **Total**: 2700 seconds = 45 minutes

**What to verify**:
```sql
SELECT COUNT(*), SUM(duration_seconds) 
FROM activity_records 
WHERE user_assigned_issue_key IS NULL 
  AND window_title IN ('localhost:5432...', 'localhost:3000...', 'GitHub...')
-- Expected: 3 rows, 2700 seconds
```

### Phase 2: Group Creation
**What it does**: Clusters the 3 activities into an unassigned work group
```
unassigned_work_groups
├── id: <GROUP_UUID>
├── group_label: "Backend Development Work"
├── session_count: 3
├── total_seconds: 2700
├── is_assigned: FALSE ⭐ KEY
└── assigned_to_issue_key: NULL
```

**What to verify**:
```sql
SELECT is_assigned, assigned_to_issue_key, session_count 
FROM unassigned_work_groups 
WHERE group_label = 'Backend Development Work'
-- Expected: is_assigned = FALSE, assigned_to_issue_key = NULL, session_count = 3
```

### Phase 3: Pre-Conversion Verification
**What it checks** (5 assertions):

#### CHECK 1: Group is unassigned
```
✅ Group.is_assigned = FALSE
✅ Group.assigned_to_issue_key = NULL
✅ Group.assigned_at = NULL
```

#### CHECK 2: Activities are unassigned
```
✅ ALL activity_records.user_assigned_issue_key = NULL
✅ ALL activity_records.project_key = NULL
```

#### CHECK 3: Group appears in UI list
```
-- This is what getUnassignedGroups() returns
SELECT * FROM unassigned_work_groups 
WHERE user_id = 'USER_ID'
  AND organization_id = 'ORG_ID'
  AND is_assigned = FALSE      ← Query filter
  AND is_dismissed = FALSE     ← Query filter
  AND session_count > 0        ← Viability filter
  AND total_seconds > 0        ← Viability filter
-- ✅ Our group should be IN this result
```

#### CHECK 4: Total unassigned time includes this group
```
SELECT SUM(duration_seconds) as total 
FROM activity_records 
WHERE user_id = 'USER_ID'
  AND organization_id = 'ORG_ID'
  AND user_assigned_issue_key IS NULL  ← Unassigned filter
  AND classification IN ('productive', 'unknown')
-- ✅ Should include 2700 seconds from our activities
```

#### CHECK 5: Timeline shows unassigned bars
```
-- Simulated in teamAnalyticsService.js
Timeline.unassignedBlocks[] should include:
  ├─ Activity 1 (900s, 09:30-09:45, yellow bar)
  ├─ Activity 2 (720s, 10:15-10:27, yellow bar)
  └─ Activity 3 (1080s, 11:00-11:18, yellow bar)
-- ✅ Total unassigned time = 45 minutes
```

---

### Phase 4: Assignment Simulation
**What it does**: Mimics the backend assignment process

**Step 1**: Update activity_records
```sql
UPDATE activity_records
SET 
  user_assigned_issue_key = 'PROJ-123',  ← NULL → 'PROJ-123'
  project_key = 'PROJ'
WHERE id IN (<activity_ids>)
```

**Step 2**: Mark group as assigned
```sql
UPDATE unassigned_work_groups
SET 
  is_assigned = TRUE,                    ← FALSE → TRUE ⭐
  assigned_to_issue_key = 'PROJ-123',    ← NULL → 'PROJ-123'
  assigned_at = NOW(),
  assigned_by = 'USER_ID'
WHERE id = '<group_id>'
```

**What changed**:
```
BEFORE:
  activity_records.user_assigned_issue_key = NULL
  unassigned_work_groups.is_assigned = FALSE

AFTER:
  activity_records.user_assigned_issue_key = 'PROJ-123'  ✅
  unassigned_work_groups.is_assigned = TRUE              ✅
```

---

### Phase 5: Post-Conversion Verification
**What it checks** (4 critical assertions):

#### CHECK 6: Group is now marked as assigned ⭐ CRITICAL
```
✅ Group.is_assigned = TRUE (was FALSE)
✅ Group.assigned_to_issue_key = 'PROJ-123' (was NULL)
✅ Group.assigned_at = <timestamp>
```
**If FAIL**: Assignment not persisted. Check `markGroupAsAssigned()`.

#### CHECK 7: Activities are now assigned to PROJ-123 ⭐ CRITICAL
```sql
SELECT user_assigned_issue_key, project_key 
FROM activity_records 
WHERE id IN (<our_activity_ids>)
-- ✅ All should have: user_assigned_issue_key = 'PROJ-123', project_key = 'PROJ'
```
**If FAIL**: Activities not updated. Check `updateSessionsAndAnalysis()`.

#### CHECK 8: Group NO LONGER appears in unassigned list ⭐ CRITICAL
```sql
SELECT COUNT(*) 
FROM unassigned_work_groups 
WHERE user_id = 'USER_ID'
  AND organization_id = 'ORG_ID'
  AND is_assigned = FALSE        ← Filter excludes our group now
  AND is_dismissed = FALSE
  AND session_count > 0
-- ✅ Should be 1 LESS than before (our group excluded)
```
**If FAIL**: Query not filtering properly or group flag not updated.

#### CHECK 9: Total unassigned time DECREASED ⭐ CRITICAL
```sql
SELECT SUM(duration_seconds) as total 
FROM activity_records 
WHERE user_id = 'USER_ID'
  AND organization_id = 'ORG_ID'
  AND user_assigned_issue_key IS NULL  ← Filter excludes assigned work
-- BEFORE: 2700 seconds (45 minutes)
-- AFTER:  0 seconds (our activities excluded) ✅
```
**If FAIL**: Activities not properly updated to assigned state.

---

### Phase 6: Timeline Behavior
**What it verifies**: Timeline correctly reflects the change

**Unassigned blocks AFTER**:
```sql
SELECT id, start_time, duration_seconds 
FROM activity_records 
WHERE id IN (<our_activity_ids>)
  AND user_assigned_issue_key IS NULL
-- ✅ Should return 0 rows (all are now assigned)
```

**Assigned blocks AFTER**:
```sql
SELECT id, start_time, duration_seconds, user_assigned_issue_key 
FROM activity_records 
WHERE id IN (<our_activity_ids>)
  AND user_assigned_issue_key = 'PROJ-123'
-- ✅ Should return 3 rows (our activities are now there)
```

**Timeline Rendering**:
```
BEFORE:
  Timeline [09:30-09:45] Yellow bar (15m unassigned)
  Timeline [10:15-10:27] Yellow bar (12m unassigned)
  Timeline [11:00-11:18] Yellow bar (18m unassigned)
  > Total unassigned: 45m

AFTER (no page reload needed):
  Timeline [09:30-09:45] Green bar (15m on PROJ-123)   ✅
  Timeline [10:15-10:27] Green bar (12m on PROJ-123)   ✅
  Timeline [11:00-11:18] Green bar (18m on PROJ-123)   ✅
  > Total unassigned: 0m                               ✅
```

---

### Phase 7: Data Consistency
**What it verifies**: No orphaned or inconsistent records

**Group members still linked**:
```sql
SELECT COUNT(*) 
FROM unassigned_group_members WHERE group_id = '<group_id>'
-- ✅ Should be 3 (links still exist even after assignment)
```

**Group metadata matches actual data**:
```sql
SELECT 
  g.session_count as metadata,
  COUNT(ugm.id) as actual_count
FROM unassigned_work_groups g
LEFT JOIN unassigned_group_members ugm ON g.id = ugm.group_id
WHERE g.id = '<group_id>'
GROUP BY g.id
-- ✅ metadata = actual_count (3 = 3)
```

---

## Troubleshooting Guide

### ❌ Problem: Unassigned bars don't disappear from timeline

**Symptoms**:
- After assignment, timeline still shows yellow bars
- Phase 6 CHECK shows activities still have `user_assigned_issue_key = NULL`

**Root Causes**:
1. `updateSessionsAndAnalysis()` not updating activities
2. Frontend cache not cleared
3. Timeline query still filtering as unassigned

**Diagnostic Queries**:
```sql
-- Step 1: Check if activities were updated
SELECT id, user_assigned_issue_key, project_key 
FROM activity_records 
WHERE id = 'ACTIVITY_ID'
-- Should show PROJ-123, not NULL

-- Step 2: Check if group was updated
SELECT id, is_assigned, assigned_to_issue_key 
FROM unassigned_work_groups 
WHERE id = 'GROUP_ID'
-- Should show is_assigned = TRUE

-- Step 3: Check if members link is intact
SELECT * FROM unassigned_group_members 
WHERE group_id = 'GROUP_ID'
-- Should still have 3 rows
```

**Fix Steps**:
1. Check [assignmentResolvers.js](./forge-app/src/resolvers/unassigned/assignmentResolvers.js) line ~120-145 (`updateSessionsAndAnalysis`)
2. Verify the UPDATE statement is being executed
3. Check for any transaction rollbacks
4. Clear frontend cache (F5 or Ctrl+Shift+R)

---

### ❌ Problem: Total unassigned time doesn't decrease

**Symptoms**:
- Phase 5 CHECK 8 fails
- Total unassigned seconds same or only slightly less
- Indicates not all activities were updated

**Root Causes**:
1. `markGroupAsAssigned()` not being called
2. Only some activities updated, not all in group
3. Legacy data not being converted

**Diagnostic Queries**:
```sql
-- Step 1: Check group assignment
SELECT is_assigned, assigned_to_issue_key 
FROM unassigned_work_groups 
WHERE id = 'GROUP_ID'
-- Should show is_assigned = TRUE

-- Step 2: Check activity count
SELECT COUNT(*) as actual_assigned
FROM unassigned_work_groups g
JOIN unassigned_group_members ugm ON g.id = ugm.group_id
JOIN activity_records ar ON ugm.activity_record_id = ar.id
WHERE g.id = 'GROUP_ID' AND ar.user_assigned_issue_key = 'PROJ-123'
-- Should equal g.session_count

-- Step 3: Check for unassigned stragglers
SELECT ar.id, ar.user_assigned_issue_key 
FROM unassigned_group_members ugm
JOIN activity_records ar ON ugm.activity_record_id = ar.id
WHERE ugm.group_id = 'GROUP_ID' 
  AND ar.user_assigned_issue_key IS NULL
-- Should return 0 rows
```

**Fix Steps**:
1. Check [assignmentResolvers.js](./forge-app/src/resolvers/unassigned/assignmentResolvers.js) line ~200-220 (`markGroupAsAssigned`)
2. Verify is_assigned is being set to TRUE
3. Run Phase 5 CHECK 8 again to re-check total

---

### ❌ Problem: Group still appears in unassigned work page

**Symptoms**:
- Phase 5 CHECK 7 fails
- Group still visible after assignment
- Count of unassigned groups not decremented

**Root Causes**:
1. Group `is_assigned` flag not set to TRUE
2. Filter logic in `getUnassignedGroups()` not working
3. Frontend cache showing stale list

**Diagnostic Queries**:
```sql
-- Step 1: Check group flag
SELECT id, is_assigned, is_dismissed 
FROM unassigned_work_groups 
WHERE id = 'GROUP_ID'
-- Should show is_assigned = TRUE, is_dismissed = FALSE

-- Step 2: Simulate getUnassignedGroups filter
SELECT COUNT(*) FROM unassigned_work_groups 
WHERE user_id = 'USER_ID'
  AND organization_id = 'ORG_ID'
  AND is_assigned = FALSE      -- ← Our group should NOT match
  AND is_dismissed = FALSE
  AND session_count > 0
-- Our group should NOT be included

-- Step 3: Try without filter
SELECT id, is_assigned FROM unassigned_work_groups 
WHERE id = 'GROUP_ID'
-- If this returns is_assigned = FALSE, flag is wrong
```

**Fix Steps**:
1. Verify `markGroupAsAssigned()` is called (line ~200)
2. Check [sessionResolvers.js](./forge-app/src/resolvers/unassigned/sessionResolvers.js) line ~166 `getUnassignedGroups()` filter
3. Clear frontend cache and refresh

---

### ❌ Problem: Worklog not created in Jira

**Symptoms**:
- Assignment succeeds but no worklog appears in Jira
- Phase 4 returns `worklog_skipped = true`

**Root Causes**:
1. Time < 60 seconds (deferring to scheduled sync)
2. Auto-sync enabled (skipping immediate creation)
3. Jira API error (insufficient permissions, invalid issue key)

**Diagnostic Queries**:
```sql
-- Check account Jira settings
SELECT jiraWorklogSyncEnabled 
FROM tracking_settings 
WHERE account_id = 'ACCOUNT_ID'
-- If TRUE, worklogs deferred to scheduled sync

-- Check if worklog sync ran
SELECT * FROM worklog_sync_log 
WHERE user_id = 'USER_ID' AND issue_key = 'PROJ-123'
ORDER BY synced_at DESC
-- Check timestamps and success status
```

**Fix Steps**:
1. If auto-sync enabled: Check worklog sync scheduled task
2. If < 60 seconds: This is expected behavior (deferred)
3. If time >= 60s and sync disabled: Check Jira API logs for errors

---

### ❌ Problem: Multiple activities in group, only some converted

**Symptoms**:
- Only 1-2 of 3 activities have `user_assigned_issue_key` set
- Phase 5 CHECK 7 partial success
- Timeline shows mix of assigned and unassigned bars

**Root Causes**:
1. Query filtering too restrictively in `updateSessionsAndAnalysis()`
2. Legacy data not being handled properly
3. Activity from different pipeline not updated

**Diagnostic Queries**:
```sql
-- Check all activities in group
SELECT 
  ar.id, ar.user_assigned_issue_key, ar.source,
  ugm.activity_record_id, ugm.unassigned_activity_id
FROM unassigned_group_members ugm
LEFT JOIN activity_records ar ON ugm.activity_record_id = ar.id
WHERE ugm.group_id = 'GROUP_ID'
-- Check for NULL values or mixed sources

-- Check legacy data
SELECT id, active_task_key 
FROM analysis_results ar
JOIN unassigned_activity ua ON ar.id = ua.analysis_result_id
JOIN unassigned_group_members ugm ON ua.id = ugm.unassigned_activity_id
WHERE ugm.group_id = 'GROUP_ID'
-- Should also have active_task_key = 'PROJ-123'
```

**Fix Steps**:
1. Check `updateSessionsAndAnalysis()` handles BOTH pipelines
2. Look for legacy analysis_results updates (line ~155-170)
3. Verify `sanitizeUUIDArray()` not filtering out valid IDs

---

## Verification Checklist

- [ ] Phase 1: 3 activities created with total 2700 seconds
- [ ] Phase 2: Group created with is_assigned = FALSE
- [ ] Phase 3 CHECK 1: Group is unassigned
- [ ] Phase 3 CHECK 2: All activities unassigned
- [ ] Phase 3 CHECK 3: Group in unassigned list
- [ ] Phase 3 CHECK 4: Total unassigned time includes group (≥ 2700s)
- [ ] Phase 4: Assignment simulated successfully
- [ ] Phase 5 CHECK 5: Group is now assigned (is_assigned = TRUE)
- [ ] Phase 5 CHECK 6: Activities assigned to PROJ-123
- [ ] Phase 5 CHECK 7: Group no longer in list
- [ ] Phase 5 CHECK 8: Total unassigned time decreased
- [ ] Phase 6: No unassigned activities remain for our sessions
- [ ] Phase 6: All 3 activities show as assigned
- [ ] Phase 7: Group members still linked (3 members)
- [ ] Data consistency: Metadata matches actual counts

---

## Performance Considerations

### Query Optimization
The `getUnassignedGroups()` query uses these filters for efficiency:
- `is_assigned = FALSE` (index prevents full table scans)
- `session_count > 0` (viability filter, index helps)
- `total_seconds > 0` (viability filter, index helps)
- Pagination: `LIMIT 10 OFFSET X` (default)

**Expected query time**: < 100ms for typical users

### Timeline Query Optimization
The timeline query uses separate queries for:
- `activity_records` (new pipeline) - indexed on user_id, organization_id, date
- `analysis_results` + `screenshots` (legacy) - indexed on user_id, date

**Expected query time**: < 500ms for a full day

### Post-Assignment Updates
The assignment operation:
1. Updates activity_records (batch, indexed)
2. Updates analysis_results if needed (batch, indexed)
3. Updates unassigned_work_groups (single row)
4. Creates Jira worklog (API call, ~500ms)

**Expected total time**: < 2 seconds

---

## Common Questions

**Q: Why do we need to test both activity_records and analysis_results?**
A: The system supports two concurrent pipelines for backwards compatibility. New data uses activity_records (hybrid OCR), legacy data uses analysis_results. Assignment must update both for consistency.

**Q: What happens to group members after assignment?**
A: The `unassigned_group_members` links remain unchanged. They still point to the activities, which are now assigned. This allows audit trails and history.

**Q: Does assignment happen in real-time on the timeline?**
A: The test simulates a backend-only change. The frontend must either:
1. Poll the timeline API (getTeamTimeline)
2. Use WebSocket subscription
3. Refresh on demand

**Q: What if some activities in a group are < 60 seconds?**
A: The system deferscreation to the scheduled sync, which aggregates all time for user+issue and rounds up once if the total is < 60s.

**Q: Can a group be partially assigned?**
A: No - the entire group is assigned as a unit. The `markGroupAsAssigned()` sets one flag for the whole group.

---

## References

- [Assignment Resolvers](./forge-app/src/resolvers/unassigned/assignmentResolvers.js)
- [Session Resolvers](./forge-app/src/resolvers/unassigned/sessionResolvers.js)
- [Team Analytics Service](./forge-app/src/services/analytics/teamAnalyticsService.js)
- [Database Schema](./supabase/DEV_MIGRATION_COMPLETE.sql)
- [Unassigned Work Flow Diagram](./docs/UNASSIGNED_WORK_FLOW_VERIFICATION.md)


# Unassigned Work Testing - Quick Reference Card

## Quick Test (10 minutes)

### Step 1: Get Your IDs
```bash
# From Supabase users table
SELECT id FROM users WHERE email = 'test@example.com';  # User UUID
SELECT id FROM organizations LIMIT 1;                    # Org UUID
```

### Step 2: Configure
```sql
-- Replace these in test script:
:TARGET_USER_ID = '550e8400-e29b-41d4-a716-446655440000'
:TARGET_ORG_ID  = '660e8400-e29b-41d4-a716-446655440001'
```

### Step 3: Run Test
**SQL Option:**
```bash
# Supabase Dashboard → SQL Editor
# Copy: docs/TEST_UNASSIGNED_WORK_INTEGRATION.sql
# Run each PHASE sequentially (Ctrl+Enter)
```

**Node.js Option:**
```bash
cd ai-server
node test-unassigned-work-integration.js \
  --user-id 550e8400-e29b-41d4-a716-446655440000 \
  --org-id 660e8400-e29b-41d4-a716-446655440001
```

### Step 4: Read Output
```
✅ Phase 1: 3 activities created
✅ Phase 2: Group created
✅ Phase 3: Pre-state verified
✅ Phase 4: Assignment simulated
✅ Phase 5: Post-state verified (THE FIX)
✅ Phase 6: Timeline behavior correct
✅ Phase 7: Data consistent
```

---

## Expected Results

### Phase 3: PRE-CONVERSION
```
Total unassigned activities: 3
Total unassigned seconds: 2700 (45 minutes)
Group in unassigned list: YES
Group.is_assigned: FALSE
Activity.user_assigned_issue_key: NULL
```

### Phase 5: POST-CONVERSION ⭐ THE FIX
```
Total unassigned activities: 0 (decreased!)
Total unassigned seconds: 0 (decreased!)
Group in unassigned list: NO (removed!)
Group.is_assigned: TRUE (changed!)
Activity.user_assigned_issue_key: PROJ-123 (assigned!)
```

---

## One-Liner Diagnostic Queries

### Is the group assigned?
```sql
SELECT id, is_assigned, assigned_to_issue_key 
FROM unassigned_work_groups WHERE id = 'GROUP_UUID';
-- Should show: is_assigned = TRUE, assigned_to_issue_key = PROJ-123
```

### Are activities assigned?
```sql
SELECT COUNT(*), COUNT(CASE WHEN user_assigned_issue_key IS NOT NULL THEN 1 END)
FROM activity_records WHERE id IN ('ID1', 'ID2', 'ID3');
-- Should show: 3, 3 (all assigned)
```

### Total unassigned time?
```sql
SELECT SUM(duration_seconds) FROM activity_records
WHERE user_id = 'USER_UUID' 
  AND user_assigned_issue_key IS NULL
  AND organization_id = 'ORG_UUID';
-- BEFORE: 2700 seconds | AFTER: 0 seconds
```

### Is group in unassigned list?
```sql
SELECT COUNT(*) FROM unassigned_work_groups
WHERE user_id = 'USER_UUID'
  AND is_assigned = FALSE AND is_dismissed = FALSE
  AND session_count > 0 AND total_seconds > 0;
-- BEFORE: includes our group | AFTER: excludes it
```

---

## Common Issues & Quick Fixes

| Issue | Check | Fix |
|-------|-------|-----|
| Bars still yellow | `SELECT user_assigned_issue_key FROM activity_records WHERE id = 'ID'` | Run UPDATE in Phase 4 SQL |
| Time same | `SELECT is_assigned FROM unassigned_work_groups WHERE id = 'ID'` | Check markGroupAsAssigned() |
| Group still visible | Run "Is group in list" query | Verify is_assigned = TRUE |
| Worklog not created | Time < 60s OR auto-sync enabled | Expected, check sync log |

---

## Database State Checklist

### After Phase 2 (Group Created)
- [ ] `unassigned_work_groups.is_assigned = FALSE`
- [ ] `unassigned_work_groups.session_count = 3`
- [ ] `activity_records.user_assigned_issue_key` = all NULL
- [ ] 3 rows in `unassigned_group_members`

### After Phase 4 (Assignment Simulated)
- [ ] `unassigned_work_groups.is_assigned = TRUE` ← CRITICAL
- [ ] `activity_records.user_assigned_issue_key` = all 'PROJ-123' ← CRITICAL
- [ ] Total unassigned seconds decreased to 0 ← CRITICAL

---

## Files Reference

| What | Where |
|------|-------|
| Full test script | `supabase/TEST_UNASSIGNED_WORK_INTEGRATION.sql` |
| Node.js test | `ai-server/test-unassigned-work-integration.js` |
| Flow explanation | `docs/UNASSIGNED_WORK_FLOW_VERIFICATION.md` |
| Troubleshooting | `docs/TEST_AND_VALIDATION_GUIDE.md` |
| Full guide | `docs/UNASSIGNED_WORK_TEST_SUITE_README.md` |

---

## The 4 Critical Updates (The Fix)

**Location 1: updateSessionsAndAnalysis() → assignmentResolvers.js:120**
```javascript
// Updates activity_records with new issue key
UPDATE activity_records
SET user_assigned_issue_key = 'PROJ-123'
WHERE id IN (...)
```

**Location 2: markGroupAsAssigned() → assignmentResolvers.js:200**
```javascript
// Updates group to mark as assigned
UPDATE unassigned_work_groups
SET is_assigned = TRUE
WHERE id = 'GROUP_UUID'
```

**Location 3: Timeline Query → teamAnalyticsService.js:768**
```javascript
// Filters: user_assigned_issue_key IS NULL
// After update, activities excluded from unassignedBlocks
```

**Location 4: getUnassignedGroups() → sessionResolvers.js:192**
```javascript
// Filters: is_assigned = FALSE
// After update, group excluded from results
```

---

## Test Cleanup

### Auto Cleanup
```bash
node test-unassigned-work-integration.js \
  --user-id <UUID> --org-id <UUID> --cleanup
```

### Manual Cleanup
```sql
-- Run these queries with test GROUP_UUID and ACTIVITY_UUIDs
DELETE FROM unassigned_group_members 
WHERE group_id = 'GROUP_UUID';

DELETE FROM unassigned_work_groups 
WHERE id = 'GROUP_UUID';

DELETE FROM activity_records 
WHERE id IN ('ID1', 'ID2', 'ID3');
```

---

## Performance Baseline

- Test execution: 5-10 seconds
- Database queries: < 100ms (indexed)
- Assignment operation: < 2 seconds
- Timeline query: < 500ms/day

---

## Success = All Green ✅

```
Phase 1: ✅ Created 3 activities (2700s)
Phase 2: ✅ Created group with 3 members
Phase 3: ✅ Pre-state verified (unassigned)
Phase 4: ✅ Assignment simulated
Phase 5: ✅ Post-state verified (ASSIGNED) ← THE FIX WORKS
Phase 6: ✅ Timeline behavior correct
Phase 7: ✅ Data consistent
```

---

## Failure = Any Red ❌

If ANY phase shows failure:
1. Check the specific check that failed
2. Run diagnostic query from "One-Liner" section above
3. See "Common Issues & Quick Fixes" table
4. Read detailed troubleshooting in TEST_AND_VALIDATION_GUIDE.md

---

*Quick Reference v1.0 - April 17, 2026*

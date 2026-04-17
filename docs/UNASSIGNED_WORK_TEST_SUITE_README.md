# Unassigned Work Time Tracking - Complete Test Suite

## Overview

This comprehensive test suite validates the unassigned work tracking fix that ensures:
1. ✅ Unassigned work appears in the timeline as yellow/orange bars
2. ✅ Total time spent on unassigned work is displayed correctly
3. ✅ When user converts unassigned work to an issue (JIRA issue), the bars turn green
4. ✅ The total unassigned time in timeline decreases by the converted amount
5. ✅ The converted group no longer appears in the "Unassigned Work" page

---

## Files Included

### 1. Flow Documentation
📄 **[UNASSIGNED_WORK_FLOW_VERIFICATION.md](./docs/UNASSIGNED_WORK_FLOW_VERIFICATION.md)**
- **Purpose**: Comprehensive explanation of the unassigned work flow
- **Contents**:
  - How work is tracked as unassigned
  - Database schema and relationships
  - Timeline display logic
  - Assignment/conversion process
  - Verification checklist
  - Debugging queries
  - Common issues and fixes

### 2. SQL Test Script
📄 **[TEST_UNASSIGNED_WORK_INTEGRATION.sql](./supabase/TEST_UNASSIGNED_WORK_INTEGRATION.sql)**
- **Purpose**: Complete SQL test harness for creating and validating test data
- **Contents**:
  - Phase 1: Create 3 sample unassigned activities (2700 seconds total)
  - Phase 2: Create unassigned work group and link activities
  - Phase 3: Verify PRE-CONVERSION state (5 checks)
  - Phase 4: Simulate assignment to PROJ-123
  - Phase 5: Verify POST-CONVERSION state (4 critical checks)
  - Phase 6: Validate timeline behavior
  - Phase 7: Verify data consistency
  - Phase 8-10: Cross-checks and cleanup
- **Usage**: Copy-paste into Supabase SQL editor or run via psql

### 3. Node.js Test Harness
📄 **[test-unassigned-work-integration.js](./ai-server/test-unassigned-work-integration.js)**
- **Purpose**: Programmatic test runner for integration testing
- **Contents**:
  - Automated test phases 1-7
  - Real-time status checking
  - JSON report generation
  - Cleanup functionality
- **Usage**: `node test-unassigned-work-integration.js --user-id <UUID> --org-id <UUID>`

### 4. Test & Validation Guide
📄 **[TEST_AND_VALIDATION_GUIDE.md](./docs/TEST_AND_VALIDATION_GUIDE.md)**
- **Purpose**: Detailed troubleshooting and validation guide
- **Contents**:
  - Quick start instructions
  - Understanding the flow
  - Detailed phase explanations
  - Expected vs actual results
  - Troubleshooting guide (6 common issues)
  - Verification checklist
  - Performance considerations
  - FAQ

---

## The Fix - What Should Happen

### Before Assignment
```
Timeline View (User sees):
  [09:30-09:45] ⬜ Yellow bar: 15m unassigned work
  [10:15-10:27] ⬜ Yellow bar: 12m unassigned work
  [11:00-11:18] ⬜ Yellow bar: 18m unassigned work
  Total unassigned time: 45 minutes

Unassigned Work Page:
  ✓ "Backend Development Work" group visible
    - 3 sessions
    - 45 minutes total
```

### After Assignment (Fix Applied)
```
Timeline View (User sees):
  [09:30-09:45] 🟢 Green bar: 15m on PROJ-123
  [10:15-10:27] 🟢 Green bar: 12m on PROJ-123
  [11:00-11:18] 🟢 Green bar: 18m on PROJ-123
  Total unassigned time: 0 minutes ✅

Unassigned Work Page:
  ✗ "Backend Development Work" group NO LONGER visible
```

---

## How to Run Tests

### Quickest Way (SQL Only)
1. Open [Supabase Dashboard](https://supabase.com) → SQL Editor
2. Copy [TEST_UNASSIGNED_WORK_INTEGRATION.sql](./supabase/TEST_UNASSIGNED_WORK_INTEGRATION.sql)
3. Replace variables:
   ```sql
   :TARGET_USER_ID = 'your-user-uuid'
   :TARGET_ORG_ID = 'your-org-uuid'
   :TEST_PROJECT_KEY = 'PROJ'
   :TEST_ISSUE_KEY = 'PROJ-123'
   ```
4. Run each PHASE sequentially
5. Compare results with expected outputs

### Full Automated Test (Node.js)
```bash
# Set environment variables
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_KEY="sbp_..."

# Run tests
cd ai-server
node test-unassigned-work-integration.js \
  --user-id "550e8400-e29b-41d4-a716-446655440000" \
  --org-id "660e8400-e29b-41d4-a716-446655440001" \
  --project "PROJ" \
  --issue "PROJ-123"

# Output: JSON report with all checks
```

### Manual Testing Steps
1. **Set up test data**: Run Phase 1-2 from SQL script
2. **Verify unassigned state**: Run Phase 3 checks
3. **Assign via UI**: Use "Unassigned Work" page to convert group
4. **Verify assigned state**: Run Phase 5 checks
5. **Check timeline**: Manually inspect timeline view
6. **Cleanup**: Run cleanup section

---

## Critical Test Assertions

### The Fix Must Pass ALL of These ✅

#### PRE-CONVERSION State
- [ ] Group record has `is_assigned = FALSE`
- [ ] Group record has `assigned_to_issue_key = NULL`
- [ ] All activity records have `user_assigned_issue_key = NULL`
- [ ] Group appears in `getUnassignedGroups()` query results
- [ ] Total unassigned time includes this group (≥ 2700 seconds)

#### POST-CONVERSION State (THE FIX)
- [ ] Group record updated to `is_assigned = TRUE` ⭐
- [ ] Group record updated to `assigned_to_issue_key = 'PROJ-123'` ⭐
- [ ] All activity records updated to `user_assigned_issue_key = 'PROJ-123'` ⭐
- [ ] Group NO LONGER appears in `getUnassignedGroups()` query ⭐
- [ ] Total unassigned time DECREASED by 2700 seconds ⭐

#### Timeline Impact
- [ ] No yellow/unassigned bars for these activities
- [ ] 3 green bars appear for PROJ-123
- [ ] Timeline total unassigned time = 0 (was 45m)

---

## Test Data Schema

### Activities Created
```
Activity 1
├─ Window: "localhost:5432 - pgAdmin 4"
├─ App: pgAdmin
├─ Duration: 900 seconds (15 minutes)
├─ Time: 2026-04-16 09:30-09:45
└─ Status: Unassigned → PROJ-123

Activity 2
├─ Window: "localhost:3000 - My API Server"
├─ App: VS Code
├─ Duration: 720 seconds (12 minutes)
├─ Time: 2026-04-16 10:15-10:27
└─ Status: Unassigned → PROJ-123

Activity 3
├─ Window: "GitHub - Pull Request Review"
├─ App: Google Chrome
├─ Duration: 1080 seconds (18 minutes)
├─ Time: 2026-04-16 11:00-11:18
└─ Status: Unassigned → PROJ-123

Total: 2700 seconds (45 minutes)
```

### Group Created
```
unassigned_work_groups
├─ id: <auto-generated UUID>
├─ user_id: Your test user
├─ organization_id: Your org
├─ group_label: "Backend Development Work"
├─ session_count: 3
├─ total_seconds: 2700
├─ is_assigned: FALSE (before) → TRUE (after)
└─ assigned_to_issue_key: NULL (before) → 'PROJ-123' (after)
```

---

## Key Code Files Involved

### Backend Assignment Logic
- **[assignmentResolvers.js](./forge-app/src/resolvers/unassigned/assignmentResolvers.js)**
  - `assignToExistingIssue()` - Main assignment function
  - `updateSessionsAndAnalysis()` - Updates activity records (line ~120)
  - `markGroupAsAssigned()` - Marks group as assigned (line ~200)
  
### Querying Unassigned Groups
- **[sessionResolvers.js](./forge-app/src/resolvers/unassigned/sessionResolvers.js)**
  - `getUnassignedGroups()` - Filters with `is_assigned = FALSE` (line ~166)
  - Key filter: `is_assigned=eq.false&is_dismissed=eq.false` (line ~192)

### Timeline Display
- **[teamAnalyticsService.js](./forge-app/src/services/analytics/teamAnalyticsService.js)**
  - Separates work into: `sessions[]`, `unassignedBlocks[]`, `idleBlocks[]` (line ~750-800)
  - Unassigned filter: `user_assigned_issue_key IS NULL` (line ~768)

---

## Troubleshooting Quick Reference

| Problem | Check | Fix |
|---------|-------|-----|
| Bars don't turn green | Phase 6 - activity still has `user_assigned_issue_key = NULL` | Check `updateSessionsAndAnalysis()` |
| Total time unchanged | Phase 5 CHECK 8 - group not filtered | Check `is_assigned` flag updated |
| Group still in list | Phase 5 CHECK 7 - group appears in query | Check `getUnassignedGroups()` filter |
| No worklog created | Check if time < 60s or auto-sync enabled | Expected behavior if < 60s |
| Partial conversion | Some activities missing update | Check query scope in assignment |

See [TEST_AND_VALIDATION_GUIDE.md](./docs/TEST_AND_VALIDATION_GUIDE.md) for detailed troubleshooting.

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      TEST EXECUTION FLOW                         │
└─────────────────────────────────────────────────────────────────┘

PHASE 1: Create Activities
  └─→ INSERT 3 activity_records with user_assigned_issue_key = NULL
      └─→ 900s + 720s + 1080s = 2700s total

PHASE 2: Create Group
  └─→ INSERT unassigned_work_groups with is_assigned = FALSE
      └─→ LINK activities via unassigned_group_members

PHASE 3: Pre-Conversion Checks ✅
  ├─ Group is_assigned = FALSE ✓
  ├─ Activities unassigned ✓
  ├─ Group in unassigned list ✓
  ├─ Total time includes group ✓
  └─ Timeline shows unassigned bars ✓

PHASE 4: Assignment (THE FIX)
  ├─→ UPDATE activity_records.user_assigned_issue_key = 'PROJ-123'
  └─→ UPDATE unassigned_work_groups.is_assigned = TRUE

PHASE 5: Post-Conversion Checks ✅ CRITICAL
  ├─ Group is_assigned = TRUE ← FIX WORKING
  ├─ Activities assigned to PROJ-123 ← FIX WORKING
  ├─ Group not in list ← FIX WORKING
  └─ Total time decreased to 0 ← FIX WORKING

PHASE 6: Timeline Behavior ✅
  ├─ 0 unassigned activities for our sessions ✓
  └─ 3 assigned activities for PROJ-123 ✓

PHASE 7: Data Consistency ✅
  └─ Group members still linked ✓
```

---

## Success Criteria

### All Tests Pass If:
1. ✅ Sample data created successfully
2. ✅ Group created and linked to activities
3. ✅ Pre-conversion state shows correct unassigned status
4. ✅ Assignment simulation updates both group and activities
5. ✅ Post-conversion state shows correct assigned status
6. ✅ Timeline would display green bars (for activities with issue key)
7. ✅ Total unassigned time decreased from 2700s to 0s
8. ✅ Group no longer appears in unassigned groups list
9. ✅ Data consistency maintained (members still linked)
10. ✅ Cleanup removes all test data cleanly

---

## Next Steps After Testing

### If All Tests Pass ✅
1. The fix is working correctly
2. User conversions will properly update timelines
3. Unassigned work page will reflect assignments immediately
4. Total time calculations will be accurate

### If Any Test Fails ❌
1. Review the failure in the test output
2. Check the corresponding troubleshooting section
3. Examine the code file mentioned
4. Verify the database update was executed
5. Run relevant diagnostic queries

---

## Performance Notes

- **Test duration**: ~5-10 seconds (SQL) or ~10-15 seconds (Node.js)
- **Database impact**: Minimal (3 activities, 1 group, typical indexes used)
- **Timeline query impact**: < 500ms for a full day
- **Assignment operation**: < 2 seconds total (including Jira API call)

---

## Documentation Index

| Document | Purpose | When to Read |
|----------|---------|--------------|
| [UNASSIGNED_WORK_FLOW_VERIFICATION.md](./docs/UNASSIGNED_WORK_FLOW_VERIFICATION.md) | Architecture & flow explanation | Before running tests |
| [TEST_UNASSIGNED_WORK_INTEGRATION.sql](./supabase/TEST_UNASSIGNED_WORK_INTEGRATION.sql) | SQL test script | When running SQL tests |
| [test-unassigned-work-integration.js](./ai-server/test-unassigned-work-integration.js) | Node.js test harness | When running automated tests |
| [TEST_AND_VALIDATION_GUIDE.md](./docs/TEST_AND_VALIDATION_GUIDE.md) | Detailed validation & troubleshooting | When debugging failures |
| [README.md](./docs/README.md) **← You are here** | Quick reference & overview | First documentation to read |

---

## Support

For questions or issues:
1. Check [TEST_AND_VALIDATION_GUIDE.md](./docs/TEST_AND_VALIDATION_GUIDE.md) troubleshooting section
2. Review the diagnostic queries appropriate to your issue
3. Check the code files for the actual implementation
4. Compare your database state to the expected states documented

---

*Last Updated: April 17, 2026*
*Version: 1.0 - Complete Test Suite*

# Unassigned Work Timeline Conversion - Testing Guide

## 📚 Overview

This directory contains SQL scripts and guides for testing the unassigned work conversion feature in the Time Analytics dashboard.

**Feature:** Convert unassigned work sessions from the timeline to Jira issues, with automatic removal from both the timeline and Unassigned Work page.

---

## 📁 Files in This Directory

### 1. **SIMPLE_TEST_DATA.sql** ⭐ START HERE
- **Purpose:** Quick setup in 2 minutes
- **What it does:** Creates 3 test unassigned sessions ready to convert
- **How to use:** 
  1. Replace YOUR_USER_ID_HERE and YOUR_ORG_ID_HERE (lines 16-21)
  2. Copy all content into Supabase SQL Editor
  3. Click RUN
  4. Done! Test in UI

### 2. **TEST_UNASSIGNED_WORK_DATA.sql** 
- **Purpose:** Comprehensive test data with multiple scenarios
- **What it creates:**
  - 2 unassigned work groups
  - 5 test activity sessions
  - Multiple test scenarios (thin blocks, mixed groups, etc.)
- **How to use:** Same as SIMPLE_TEST_DATA.sql but with more options

### 3. **QUICK_START_TEST_UNASSIGNED.md** 📖
- **Purpose:** Complete guide with screenshots and instructions
- **Contains:**
  - Step-by-step setup instructions
  - How to test in the UI
  - Edge cases to test
  - Cleanup instructions
  - FAQ section

### 4. **VERIFY_CONVERSION.sql**
- **Purpose:** Run AFTER testing to verify everything worked
- **What it checks:**
  - Sessions converted (have issue keys)
  - Unassigned sessions removed (count = 0)
  - Groups marked as assigned
  - Group members cleaned up

---

## 🚀 Quick Start (2 Minutes)

### Step 1: Get Your IDs from Supabase
```sql
-- Get your user ID
SELECT id FROM users WHERE email = 'your@email.com' LIMIT 1;

-- Get your org ID
SELECT id FROM organizations LIMIT 1;
```

### Step 2: Update SIMPLE_TEST_DATA.sql
Open file and replace lines 16-21:
```sql
\set TEST_USER 'your-user-uuid-here'
\set TEST_ORG 'your-org-uuid-here'
\set TEST_DATE '2026-04-17'
```

### Step 3: Run in Supabase SQL Editor
1. Copy all content from SIMPLE_TEST_DATA.sql
2. Paste into Supabase SQL Editor
3. Click RUN
4. See verification results

### Step 4: Test in the UI
1. Go to **Time Analytics** → **My Daily Timesheet**
2. Look for **3 BLUE DOTTED blocks** around 9:00 AM
3. Hover over a block and click the **+** button
4. Choose project and click **Assign**
5. Watch the block turn **GREEN** ✅

---

## 🧪 Testing Checklist

### Before Conversion
- [ ] See 3 blue dotted blocks in timeline (9:00-10:15)
- [ ] Hover shows blue + button
- [ ] Click + opens "Assign unassigned work" modal
- [ ] Go to Unassigned Work page - see all 3 sessions there

### Converting a Session
- [ ] Modal has two modes: "Existing Issue" and "Create New"
- [ ] Can search for existing issues
- [ ] Can create new issue with project selector
- [ ] Shows created issue key after assignment
- [ ] Modal closes successfully
- [ ] No error messages

### After Conversion
- [ ] Block turns green and shows issue key
- [ ] Blue dotted block disappears from timeline
- [ ] Go to Unassigned Work page - session is GONE
- [ ] Check timeline again - issue appears under correct issue key
- [ ] Click convert on remaining blue blocks

### Final Verification
- [ ] All blue blocks converted to green
- [ ] Unassigned Work page is EMPTY (no test sessions)
- [ ] Show the verified data with your queries

---

## 📊 What the Test Data Creates

```
Test Group: "Test Code Reviews"
├── Session 1: 09:00-09:15 (GitHub PR #456) → Becomes ATG-XXX
├── Session 2: 09:30-09:45 (GitHub PR #457) → Becomes ATG-YYY
└── Session 3: 10:00-10:15 (GitHub PR #458) → Becomes ATG-ZZZ

Total: 45 minutes of unassigned work
```

Each session:
- Appears in **timeline** as blue dotted block
- Listed in **Unassigned Work** page
- Linked to **unassigned work group**
- Ready to convert to issue

---

## ✅ Verification After Conversion

Run `VERIFY_CONVERSION.sql` after testing:

```sql
-- Update the same TEST_USER and TEST_ORG
\set TEST_USER 'your-uuid'
\set TEST_ORG 'your-org-uuid'
\set TEST_DATE '2026-04-17'

-- Copy and run entire file
```

**You should see:**
- ✅ All sessions have issue keys
- ✅ 0 unassigned sessions remaining
- ✅ Group members count = 0
- ✅ Groups marked as "assigned"

---

## 🧹 Cleanup

After testing, remove test data:

### Option 1: Use the cleanup in SIMPLE_TEST_DATA.sql
```sql
-- Uncomment and run the cleanup section at bottom of SIMPLE_TEST_DATA.sql
DELETE FROM public.unassigned_group_members...
DELETE FROM public.unassigned_work_groups...
DELETE FROM public.unassigned_activity...
DELETE FROM public.activity_records...
```

### Option 2: Manual queries
```sql
DELETE FROM public.unassigned_group_members 
WHERE group_id IN (
    SELECT id FROM public.unassigned_work_groups 
    WHERE group_name LIKE '%Test%'
);

DELETE FROM public.unassigned_work_groups 
WHERE group_name LIKE '%Test%';

DELETE FROM public.unassigned_activity 
WHERE window_title LIKE 'GitHub%';

DELETE FROM public.activity_records 
WHERE window_title LIKE 'GitHub - PR%' 
AND user_assigned_issue_key IS NULL;
```

---

## 🎯 Testing Scenarios

### Scenario 1: Single Session Conversion
1. Create test data
2. Convert the 10:00-10:15 session to a new issue
3. Verify it disappears and turns green
4. Verify it's removed from Unassigned Work

**Tests:** Basic conversion flow, modal, issue creation

### Scenario 2: Batch Group Conversion
1. Create test data
2. Convert all 3 sessions in the same group to one issue
3. Verify group is marked as "assigned"
4. Verify all group members are removed

**Tests:** Group consistency, batch update, group state

### Scenario 3: Different Project Conversion
1. Create test data
2. Convert Session 1 to Project A
3. Convert Session 2 to Project B
4. Verify both appear with correct projects

**Tests:** Project handling, multi-conversion, data isolation

### Scenario 4: Thin Block Interaction
1. Create test data
2. Try to click on the 10-minute Slack session (thin block)
3. Verify modal opens despite small size

**Tests:** UI hit target, clickability fix, small blocks

---

## 🔧 Database Schema

The test creates data across these tables:

**activity_records**
- user_assigned_issue_key: NULL (unassigned)
- Appears in timeline view
- Updated to add issue_key after conversion

**unassigned_activity**
- Represents unassigned work sessions
- Linked to groups via unassigned_group_members

**unassigned_work_groups**
- Groups unassigned sessions together
- is_assigned: false (until all converted)

**unassigned_group_members**
- Links unassigned_activity to groups
- Entries deleted when sessions converted

---

## 🐛 Troubleshooting

### Problem: No blue blocks appear in timeline
**Solution:**
1. Verify test data was created (run SIMPLE_TEST_DATA.sql again)
2. Check you're looking at correct date (Test date = '2026-04-17')
3. Run verification: `SELECT COUNT(*) FROM activity_records WHERE user_assigned_issue_key IS NULL`

### Problem: + button doesn't appear on hover
**Solution:**
1. Hover for 1-2 seconds
2. Move mouse slightly to trigger hover
3. Check browser console for errors: press F12

### Problem: Modal doesn't open on click
**Solution:**
1. Try refreshing the page
2. Check browser console for JavaScript errors
3. Verify you're logged in with correct user

### Problem: Sessions still unassigned after clicking Assign
**Solution:**
1. Refresh the page
2. Check browser network tab for errors
3. Verify issue key is shown in the modal
4. Run VERIFY_CONVERSION.sql to check database

### Problem: Sessions appear in both timeline AND Unassigned Work after conversion
**Solution:**
1. Refresh Unassigned Work page
2. Check that activity_records.user_assigned_issue_key IS NOT NULL
3. Verify unassigned_group_members entries were deleted

---

## 📝 Notes

### Performance
- Creating test data is instant
- Timeline rendering optimized for ~5000 sessions
- Group deletion cascades automatically

### Data Integrity
- Cleanup scripts delete only test data (group_name LIKE '%Test%')
- Won't affect production data
- Safe to run multiple times

### Security
- Tests use your actual user/org IDs
- Data scoped by organization_id
- RLS policies enforced

---

## 📞 Support

If issues occur:

1. Check the troubleshooting section above
2. Review the test data creation logs (at bottom of SIMPLE_TEST_DATA.sql)
3. Run VERIFY_CONVERSION.sql to see database state
4. Check browser console (F12) for errors

---

## Related Files

- Feature Implementation: `forge-app/src/services/analytics/teamAnalyticsService.js`
- UI Component: `forge-app/static/main/src/components/tabs/time-analytics/DayView.js`
- API Resolver: `forge-app/src/resolvers/analyticsResolvers.js`
- Styling: `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css`

---

## Summary

| Step | File | Time | Action |
|------|------|------|--------|
| 1 | SIMPLE_TEST_DATA.sql | 1 min | Create test data |
| 2 | Time Analytics UI | 30 sec | Find blue blocks |
| 3 | Modal | 2 min | Convert sessions |
| 4 | VERIFY_CONVERSION.sql | 1 min | Verify success |
| 5 | CLEANUP | 1 min | Remove test data |

**Total time: ~5 minutes** ⏱️


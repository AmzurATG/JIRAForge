# Quick Start: Testing Unassigned Work Conversion Feature

## 📋 Overview

This guide helps you quickly set up test data and verify the unassigned work timeline conversion feature works correctly.

## 🚀 Quick Setup (5 minutes)

### Step 1: Get Your User and Organization IDs

Open Supabase SQL Editor and run:

```sql
-- Get your user ID (replace email with yours)
SELECT id, email FROM users WHERE email = 'your_email@company.com' LIMIT 1;

-- Get your organization ID
SELECT id, org_name FROM organizations LIMIT 1;
```

Copy these two UUIDs.

### Step 2: Update the Test Script

Open the SQL file: `supabase/TEST_UNASSIGNED_WORK_DATA.sql`

Update lines 20-30 with your values:

```sql
\set test_user_id 'YOUR_USER_UUID_HERE'
\set test_org_id 'YOUR_ORG_UUID_HERE'
\set test_date '2026-04-17'  -- Or today's date
```

### Step 3: Run the Script

1. Select all content from `TEST_UNASSIGNED_WORK_DATA.sql`
2. Paste into Supabase SQL Editor
3. Click **Run**

The script will:
- ✅ Create 2 test unassigned work groups
- ✅ Create 5 test unassigned activity records
- ✅ Create 5 timeline sessions (UNASSIGNED - no issue key)
- ✅ Link everything together
- ✅ Show verification results

**You should see 5 sessions created and ready to test.**

---

## 🧪 Testing the Feature in the UI

### Before Conversion (What you should see):

1. Go to **Time Analytics** → **My Daily Timesheet**
2. Look for **BLUE DOTTED** blocks in the timeline (around 9:00 AM - 11:20 AM)
3. Hover over a blue block — it should show a blue `+` button
4. You should see these sessions:
   - 9:00-9:15 (GitHub PR #456) - 15 min
   - 9:30-9:45 (GitHub PR #457) - 15 min
   - 10:00-10:15 (GitHub PR #458) - 15 min
   - 10:30-10:40 (Slack) - **10 min (thin block - tests clickability)**
   - 11:00-11:20 (Email) - 20 min

5. Also check **Unassigned Work** page — you should see all 5 sessions there

### Convert a Session:

1. Click the `+` button on any blue block
2. A modal should open: "Assign unassigned work"
3. Choose:
   - **"Create New"** → Select project → Enter summary → Click "Assign"
   - Or **"Existing Issue"** → Search and select issue → Click "Assign"
4. You should see a success message with the **created/assigned issue key**

### After Conversion (Verify):

1. The blue block should turn **green** and move to assigned sessions
2. Go to **Unassigned Work** page — the converted sessions should be **GONE**
3. Timeline should now show the issue key instead of "Unassigned"

---

## ✅ Verification Queries

After testing conversions, run these queries to verify data integrity:

### Check 1: Unassigned Sessions Removed

```sql
-- Should show 0 unassigned sessions (or fewer than before)
SELECT COUNT(*) as still_unassigned
FROM public.activity_records
WHERE user_id = 'd3b0c4d2-5e1f-4a9c-b1d2-3e4f5a6b7c8d'::uuid
AND work_date = '2026-04-17'
AND user_assigned_issue_key IS NULL;
```

**Expected:** 0 or fewer sessions

### Check 2: Sessions Now Have Issue Keys

```sql
-- Should show converted sessions with issue keys
SELECT 
    TO_CHAR(start_time, 'HH24:MI') as time,
    window_title,
    user_assigned_issue_key,
    project_key
FROM public.activity_records
WHERE user_id = 'd3b0c4d2-5e1f-4a9c-b1d2-3e4f5a6b7c8d'::uuid
AND work_date = '2026-04-17'
AND user_assigned_issue_key IS NOT NULL
AND window_title LIKE '%GitHub%';
```

**Expected:** Shows issue keys (e.g., FEEDBACK-123)

### Check 3: Group Members Removed

```sql
-- Should show 0 members if all sessions in group were converted
WITH test_group AS (
    SELECT id FROM public.unassigned_work_groups 
    WHERE group_name = 'Code Review Sessions - Test Group 1'
    LIMIT 1
)
SELECT COUNT(*) as remaining_members
FROM public.unassigned_group_members
WHERE group_id = (SELECT id FROM test_group);
```

**Expected:** 0 members (empty group is hidden from UI)

### Check 4: Unassigned Work Page

Go to **Unassigned Work** → You should see **NO test sessions** (they're all converted and removed)

---

## 🧹 Cleanup

When you're done testing, run this to remove all test data:

Open `TEST_UNASSIGNED_WORK_DATA.sql` and scroll to the bottom section (around line 350):

```sql
/* CLEANUP SECTION - Uncomment and run to remove test data */
```

Uncomment the cleanup statements and run them.

Or manually run:

```sql
-- Delete group members
DELETE FROM public.unassigned_group_members 
WHERE group_id IN (
    SELECT id FROM public.unassigned_work_groups
    WHERE group_name LIKE '% - Test Group%'
);

-- Delete groups
DELETE FROM public.unassigned_work_groups
WHERE group_name LIKE '% - Test Group%';

-- Delete activities
DELETE FROM public.unassigned_activity
WHERE window_title LIKE 'GitHub%' 
   OR window_title LIKE '%Slack%' 
   OR window_title LIKE '%Email%';

-- Delete timeline sessions
DELETE FROM public.activity_records
WHERE (window_title LIKE 'GitHub%' 
    OR window_title LIKE '%Slack%' 
    OR window_title LIKE '%Email%')
AND user_assigned_issue_key IS NULL;
```

---

## 🐛 Testing Edge Cases

### 1. Thin Block (10 min Slack session)
- Tests if very small blocks are clickable
- This block is only 10 minutes wide
- Try clicking on it to verify the + button is accessible

### 2. Multiple Issues from Same Group
- Group 1 has 3 code review sessions
- Try converting them all to the SAME issue
- Verify that the group is then marked as fully assigned

### 3. Mixed Group Conversion
- Group 2 has Slack (10 min) and Email (20 min)
- Convert Slack to one issue
- Convert Email to another issue
- Verify that both conversions work and group shows combined assignment

---

## 📊 Data Structure

The test creates this data:

```
Test Group 1: "Code Review Sessions - Test Group 1"
├── Session 1: 9:00-9:15 (GitHub #456)
├── Session 2: 9:30-9:45 (GitHub #457)
└── Session 3: 10:00-10:15 (GitHub #458)

Test Group 2: "Communication - Test Group 2"
├── Session 4: 10:30-10:40 (Slack) ← THIN BLOCK TEST
└── Session 5: 11:00-11:20 (Email)
```

Each session appears in:
1. **unassigned_activity** table
2. **unassigned_work_groups** (2 groups)
3. **unassigned_group_members** (5 member links)
4. **activity_records** (5 timeline entries with no issue_key)

---

## ❓ FAQ

**Q: What should I do if the + button doesn't appear on hover?**
A: 
1. Make sure you're logged in with the correct user
2. Make sure the sessions are created with `user_assigned_issue_key = NULL`
3. Run verification query above to confirm sessions exist

**Q: The modal doesn't open when I click +?**
A: 
1. Check browser console for JavaScript errors
2. Verify the test data was created successfully
3. Try refreshing the page

**Q: Sessions are converted but still showing in Unassigned Work page?**
A:
1. Refresh the Unassigned Work page
2. Check that `activity_records.user_assigned_issue_key` is NOT NULL
3. Check that `unassigned_group_members` entries were deleted

**Q: How do I know conversion worked?**
A: Compare before/after:
- **Before:** 5 blue dotted blocks in timeline + same sessions in Unassigned Work
- **After:** 0-5 green blocks in timeline + 0 sessions in Unassigned Work

---

## 📝 Notes

- Test data expires after your testing
- Use cleanup script to remove it when done
- You can rerun the setup script multiple times (it avoids duplicates)
- Each conversion test can use different projects/issues

---

## 🔗 Related Files

- Script: `supabase/TEST_UNASSIGNED_WORK_DATA.sql`
- Feature: `forge-app/src/services/analytics/teamAnalyticsService.js` (convertUnassignedToWorklog)
- UI: `forge-app/static/main/src/components/tabs/time-analytics/DayView.js`
- Resolver: `forge-app/src/resolvers/analyticsResolvers.js` (convertUnassignedToWorklog)

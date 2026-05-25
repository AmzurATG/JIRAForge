# Portal Admin Users Setup Guide

## Overview

This guide explains how to create portal admin users for your existing JIRAForge organization.

## Prerequisites

- Your JIRAForge system must already have at least one organization configured
- You need access to Supabase Studio SQL Editor
- You need your organization's UUID (we'll show you how to find it)

---

## Step 1: Find Your Organization ID

Run this query in Supabase Studio SQL Editor:

```sql
SELECT id, org_name, jira_instance_url 
FROM organizations 
WHERE is_active = true;
```

Copy the `id` (UUID) of the organization you want to create portal admins for.

Example result:
```
id: 123e4567-e89b-12d3-a456-426614174000
org_name: My Company
jira_instance_url: https://mycompany.atlassian.net
```

---

## Step 2: Update the Seed Migration

1. Open `supabase/migrations/20260521_seed_portal_test_data.sql`

2. Find this line:
   ```sql
   v_org_id UUID := 'YOUR_ORG_ID_HERE';
   ```

3. Replace `'YOUR_ORG_ID_HERE'` with your actual organization ID:
   ```sql
   v_org_id UUID := '123e4567-e89b-12d3-a456-426614174000';
   ```

4. (Optional) Update the email addresses to match your organization's domain:
   ```sql
   (v_org_id, 'admin@example.com', ...
   (v_org_id, 'manager@example.com', ...
   (v_org_id, 'viewer@example.com', ...
   ```
   
   Change to:
   ```sql
   (v_org_id, 'admin@mycompany.com', ...
   (v_org_id, 'manager@mycompany.com', ...
   (v_org_id, 'viewer@mycompany.com', ...
   ```

---

## Step 3: Run the Migration

1. **Open Supabase Studio SQL Editor**
   - Go to: https://supabase.com/dashboard/project/YOUR_PROJECT/sql

2. **Create a new query**
   - Click "+ New query"

3. **Copy the updated migration SQL**
   - Copy the entire contents of `20260521_seed_portal_test_data.sql`

4. **Paste and Run**
   - Paste into the SQL Editor
   - Click "Run" or press `Ctrl+Enter`

5. **Verify Success**
   - You should see success messages in the output
   - Check for "Portal Admin Users Created Successfully"

---

## Default Credentials

After running the migration, you'll have 3 portal admin accounts:

### Superadmin Account
- **Email**: `admin@example.com` (or your custom domain)
- **Password**: `Password123!`
- **Role**: superadmin (full access)

### Admin Account
- **Email**: `manager@example.com` (or your custom domain)
- **Password**: `Password123!`
- **Role**: admin (manage users, view data)

### Viewer Account
- **Email**: `viewer@example.com` (or your custom domain)
- **Password**: `Password123!`
- **Role**: viewer (read-only access)

---

## Step 4: Start the Portal

1. **Start Backend Server**
   ```bash
   cd ai-server
   npm run dev
   ```
   Backend will run on http://localhost:3001

2. **Start Frontend Server**
   ```bash
   cd ai-server/src/portal
   npm run dev
   ```
   Frontend will run on http://localhost:3002

3. **Log In**
   - Open http://localhost:3002
   - Enter your organization ID
   - Enter email and password from above
   - Click "Sign In"

---

## Important: Change Default Passwords

⚠️ **Security Notice**: The default password `Password123!` is for testing only. 

After logging in:
1. Go to **Settings** page (superadmin only)
2. Click the key icon next to each user
3. Change passwords to secure values

---

## Verifying the Setup

After seeding, verify by running:

```sql
-- Check portal admins
SELECT email, display_name, role, created_at
FROM portal_admin_users 
WHERE org_id = 'YOUR_ORG_ID_HERE';
```

You should see 3 records with the emails you configured.

---

## What About Activity Data?

The portal displays activity data from the `activity_records` table. This data comes from:

1. **Desktop App**: Users with the desktop app installed automatically generate activity records
2. **Existing Data**: If you already have users with desktop apps, the portal will show their existing activity

To see data in the portal:
- Make sure employees have the desktop app installed and logged in
- The desktop app will capture screenshots and generate activity records
- These records will appear in the portal automatically

---

## Troubleshooting

### Error: "Organization with ID ... does not exist"
- The org_id you provided doesn't match any organization in the database
- Run Step 1 again to get the correct organization ID

### Error: "duplicate key value violates unique constraint"
- Portal admin users already exist for this organization
- Either delete existing admins or use different email addresses

### No data showing in portal
- Check that employees have the desktop app installed
- Verify activity_records exist for your organization:
  ```sql
  SELECT COUNT(*), MIN(work_date), MAX(work_date)
  FROM activity_records 
  WHERE organization_id = 'YOUR_ORG_ID_HERE';
  ```

### Can't log in
- Verify the email and org_id are correct
- Check browser console for API errors
- Verify backend server is running on port 3001

---

## Adding More Admin Users

To add additional portal admin users later:

1. Go to **Settings** page (requires superadmin role)
2. Click "+ Add Admin User"
3. Fill in the form:
   - Email
   - Display Name
   - Role (superadmin/admin/viewer)
   - Password
4. Click "Create"

---

## Role Permissions

### Superadmin
- Full access to all features
- Can manage other admin users (create, edit, delete)
- Can change passwords
- Can view all reports and analytics

### Admin
- Can view all reports and analytics
- Can export data
- Cannot manage other admin users
- Cannot access Settings page

### Viewer
- Read-only access
- Can view dashboards and reports
- Cannot export data
- Cannot manage users

---

## Next Steps

After successfully setting up portal admins:

1. Share credentials with your team members
2. Have each admin change their password after first login
3. Monitor activity data as employees use the desktop app
4. Customize date ranges and filters to analyze productivity
5. Export reports for management reviews

---

**Need Help?** Check the implementation documentation in:
- `plan/2026-05-21_web-productivity-portal_implementation-plan.md`
- `ai-server/src/portal/PHASE_1_COMPLETE.md` through `PHASE_5_COMPLETE.md`

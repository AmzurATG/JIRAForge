# Quick Start: Deployment & Testing Guide

**For:** Personal Data Reporting API (GDPR Compliance)  
**Time Required:** 1-2 hours  
**Date:** April 7, 2026

---

## 📋 Prerequisites Checklist

Before you start, make sure you have:

- [ ] Supabase account access with admin permissions
- [ ] Node.js installed on your local machine
- [ ] Access to the Supabase SQL Editor
- [ ] Your AI server deployment environment ready

---

## Step 1: Run Database Migrations (15 minutes)

### 1.1 Open Supabase SQL Editor

1. Go to https://supabase.com/dashboard
2. Select your project
3. Click **SQL Editor** in the left sidebar
4. Click **New Query**

### 1.2 Run Migration 1 - Create Data Requests Table

1. Open this file in VS Code:  
   `supabase/migrations/20260403_add_data_requests_table.sql`

2. **Copy the entire contents** of the file

3. Paste into Supabase SQL Editor

4. Click **RUN** button (or press F5)

5. ✅ **Expected Result:**
   ```
   Success. No rows returned
   ```

6. **Verify it worked:**
   ```sql
   -- This will show all columns in the table
   SELECT column_name, data_type, is_nullable
   FROM information_schema.columns
   WHERE table_name = 'data_requests'
   ORDER BY ordinal_position;
   ```
   You should see about 10-12 rows showing columns like:
   - `id`, `account_id`, `request_type`, `status`, `requested_at`, etc.

### 1.3 Run Migration 2 - Create Exports Storage Bucket

1. Open this file in VS Code:  
   `supabase/migrations/20260403_add_exports_storage_bucket.sql`

2. **Copy the entire contents** of the file

3. Paste into Supabase SQL Editor (new query)

4. Click **RUN**

5. ✅ **Expected Result:**
   ```
   Success. No rows returned
   ```

6. **Verify it worked:**
   - Go to **Storage** in left sidebar
   - You should see a bucket named **exports**
   - Click on it (should be empty)

### 1.3 Run Migration 3 - Create User Data Discovery Function (IMPORTANT!)

**⚡ NEW: Dynamic Table Discovery**  
This migration enables automatic discovery of ALL tables with user data.  
When you add new tables in the future, they'll be included automatically!

1. Open this file in VS Code:  
   `supabase/migrations/20260407_add_user_data_discovery_function.sql`

2. **Copy the entire contents** of the file

3. Paste into Supabase SQL Editor (new query)

4. Click **RUN**

5. ✅ **Expected Result:**
   ```
   Success. No rows returned
   ```

6. **Verify it worked:**
   ```sql
   -- Test the discovery function
   SELECT * FROM discover_user_data_tables();
   ```
   You should see a list of all tables with `user_id` column (16+ tables)

### 1.4 Run Migration 4 - Create Deletion Lifecycle (Optional)

1. Open this file in VS Code:  
   `supabase/migrations/20260403_add_deletion_lifecycle.sql`

2. **Copy the entire contents** of the file

3. Paste into Supabase SQL Editor (new query)

4. Click **RUN**

5. ✅ **Expected Result:**
   ```
   Success. No rows returned
   ```

---

## Step 2: Set Up Cleanup Job (30 minutes)

This job automatically deletes export files older than 7 days from your Supabase storage.

### 2.1 Test the Cleanup Script First

**Note:** This script runs on your local computer and connects to Supabase remotely to clean up files.

1. **Verify Prerequisites:**
   - Node.js is installed (check: `node --version`)
   - You're in the correct directory

2. **Open PowerShell**

3. **Navigate to ai-server directory:**
   ```powershell
   cd d:\ATG-timetracker\compliance\JIRAForge\ai-server
   ```

4. **Verify your `.env` file has Supabase credentials:**
   ```powershell
   # Check .env file exists
   Get-Content .env | Select-String "SUPABASE"
   ```
   You should see:
   - `SUPABASE_URL=https://...`
   - `SUPABASE_SERVICE_ROLE_KEY=...`

5. **Run the cleanup script:**
   ```powershell
   node scripts/cleanup-old-exports.js
   ```

6. ✅ **Expected Output:**
   ```
   ✅ Cleanup Summary:
      Deleted: 0 files
      Skipped: 0 files (< 7 days old)
      Errors: 0 files
   ```

   **If you see errors:**
   - ❌ `Cannot find module`: Run `npm install` first
   - ❌ `Invalid API key`: Check your `.env` file has correct `SUPABASE_SERVICE_ROLE_KEY`
   - ❌ `Bucket not found`: The exports bucket doesn't exist (run migration 2 first)

### 2.1.1 Optional: Test with a Real File

Want to verify the cleanup actually works? Upload a test file to Supabase:

1. **Go to Supabase Dashboard** → **Storage** → **exports** bucket

2. **Upload a test file:**
   - Click **Upload file**
   - Upload any small file (e.g., `test.txt`)

3. **Manually change the file's created date** (this requires a workaround):
   - Files < 7 days old won't be deleted
   - To test deletion, you would need to wait 7 days OR modify the script temporarily to use `MAX_AGE_DAYS = 0`

4. **Run the cleanup script again:**
   ```powershell
   node scripts/cleanup-old-exports.js
   ```
   - Files < 7 days old: Skipped
   - Files ≥ 7 days old: Deleted

5. **Check Supabase Storage** to confirm the file was handled correctly

### 2.2 Schedule the Job (Windows)

#### Option A: Using Task Scheduler (Recommended)

1. **Open Task Scheduler:**
   - Press `Win + R`
   - Type: `taskschd.msc`
   - Press Enter

2. **Create New Task:**
   - Click **"Create Basic Task..."** in right panel
   
3. **Name the Task:**
   - Name: `Cleanup Old Exports`
   - Description: `Deletes export files older than 7 days`
   - Click **Next**

4. **Set Schedule:**
   - Select **Weekly**
   - Click **Next**
   - Start date: Today
   - Start time: `02:00 AM`
   - Recur every: `1` week
   - Check **Sunday**
   - Click **Next**

5. **Set Action:**
   - Select **"Start a program"**
   - Click **Next**

6. **Configure Program:**
   - **Program/script:**
     ```
     C:\Program Files\nodejs\node.exe
     ```
   - **Add arguments:**
     ```
     scripts\cleanup-old-exports.js
     ```
   - **Start in:**
     ```
     d:\ATG-timetracker\compliance\JIRAForge\ai-server
     ```
   - Click **Next**

7. **Finish Setup:**
   - Check **"Open the Properties dialog..."**
   - Click **Finish**

8. **Configure Additional Settings:**
   - **General tab:**
     - Check ✅ "Run whether user is logged on or not"
     - Check ✅ "Run with highest privileges"
   - **Settings tab:**
     - Uncheck ❌ "Stop the task if it runs longer than..."
   - Click **OK**

9. **Test the Task:**
   - Right-click the task in the list
   - Click **"Run"**
   - Check **"Last Run Result"** column
   - Should show: `0x0` (success)

✅ **Job scheduled successfully!**

---

#### Option B: Using Supabase Edge Function (Cloud-Based)

**Why use this?** Runs in the cloud (no local machine needed), works on any OS, easier to manage.

---

### 🔍 How It Works - Complete Flow Explanation

**Simple Answer:**
- **WHO triggers it?** → pg_cron (Supabase database extension)
- **WHEN?** → Every Sunday at 2 AM (automatically)
- **WHERE?** → In your Supabase cloud database

**Detailed Flow:**

```
┌─────────────────────────────────────────────────────────────────┐
│  STEP 1: You Schedule the Cron Job (One-Time Setup)            │
│  ─────────────────────────────────────────────────────          │
│  You run this SQL in Supabase (Step 5):                        │
│  SELECT cron.schedule('cleanup-old-exports', '0 2 * * 0', ...) │
│                                                                  │
│  This tells pg_cron: "Every Sunday at 2 AM, run this command"  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  STEP 2: pg_cron Runs Automatically (Every Sunday 2 AM)        │
│  ────────────────────────────────────────────────────           │
│  pg_cron extension (running inside Supabase Postgres)          │
│  wakes up and says: "It's Sunday 2 AM, time to run!"           │
│                                                                  │
│  It executes the SQL command you scheduled                      │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  STEP 3: SQL Makes HTTP Request to Edge Function               │
│  ──────────────────────────────────────────────                 │
│  The SQL command uses net.http_post() to call:                 │
│  https://your-project.supabase.co/functions/v1/cleanup-exports│
│                                                                  │
│  With Authorization header (your CRON_SECRET)                   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  STEP 4: Edge Function Receives Request & Runs                 │
│  ─────────────────────────────────────────────                  │
│  Your Edge Function (cleanup-exports/index.ts):                │
│  1. Checks Authorization header (security)                      │
│  2. Connects to Supabase Storage                                │
│  3. Lists all files in 'exports' bucket                         │
│  4. Deletes files older than 7 days                             │
│  5. Returns summary: {deleted: X, skipped: Y, errors: 0}       │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  STEP 5: Result Logged in Database                             │
│  ──────────────────────────────────────                         │
│  pg_cron logs the result in cron.job_run_details table         │
│  You can check: SELECT * FROM cron.job_run_details;            │
└─────────────────────────────────────────────────────────────────┘
```

**Key Points:**

1. **You only set it up ONCE** (by running the SQL in step 5)
2. **Then it runs AUTOMATICALLY** every Sunday at 2 AM forever
3. **No need to manually trigger** anything after setup
4. **Works even if your computer is off** (runs in Supabase cloud)

**Think of it like setting an alarm clock:**
- You set the alarm once → Running the cron.schedule() SQL
- The alarm goes off automatically every Sunday → pg_cron triggers
- The alarm makes a phone call → HTTP POST to edge function
- The person answers and does the cleanup → Edge function executes

---

### 📋 Setup Steps (Follow These in Order)

1. **Create Edge Function Directory:**
   ```powershell
   cd d:\ATG-timetracker\compliance\JIRAForge\supabase
   mkdir -p functions/cleanup-exports
   ```

2. **Create the Edge Function:**
   
   Create file: `supabase/functions/cleanup-exports/index.ts`
   
   ```typescript
   import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
   import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
   
   const BUCKET_NAME = 'exports'
   const MAX_AGE_DAYS = 7
   
   serve(async (req) => {
     try {
       // Security: Verify request is from cron or has auth
       const authHeader = req.headers.get('Authorization')
       if (!authHeader || authHeader !== `Bearer ${Deno.env.get('CRON_SECRET')}`) {
         return new Response(JSON.stringify({ error: 'Unauthorized' }), {
           status: 401,
           headers: { 'Content-Type': 'application/json' },
         })
       }
   
       // Initialize Supabase client
       const supabaseUrl = Deno.env.get('SUPABASE_URL')!
       const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
       const supabase = createClient(supabaseUrl, supabaseServiceKey)
   
       console.log('[Cleanup] Starting cleanup of old export files...')
   
       // List all files in exports bucket
       const { data: files, error: listError } = await supabase.storage
         .from(BUCKET_NAME)
         .list('', {
           limit: 1000,
           sortBy: { column: 'created_at', order: 'asc' },
         })
   
       if (listError) {
         throw new Error(`Failed to list files: ${listError.message}`)
       }
   
       if (!files || files.length === 0) {
         console.log('[Cleanup] No files found in exports bucket')
         return new Response(JSON.stringify({ deleted: 0, skipped: 0, errors: 0 }), {
           headers: { 'Content-Type': 'application/json' },
         })
       }
   
       console.log(`[Cleanup] Found ${files.length} files in exports bucket`)
   
       // Calculate cutoff date (7 days ago)
       const cutoffDate = new Date()
       cutoffDate.setDate(cutoffDate.getDate() - MAX_AGE_DAYS)
   
       let deleted = 0
       let skipped = 0
       let errors = 0
   
       // Process each file
       for (const file of files) {
         const fileCreatedAt = new Date(file.created_at)
         
         if (fileCreatedAt < cutoffDate) {
           // File is older than MAX_AGE_DAYS, delete it
           const { error: deleteError } = await supabase.storage
             .from(BUCKET_NAME)
             .remove([file.name])
           
           if (deleteError) {
             console.error(`[Cleanup] Failed to delete ${file.name}: ${deleteError.message}`)
             errors++
           } else {
             console.log(`[Cleanup] Deleted: ${file.name} (age: ${Math.floor((Date.now() - fileCreatedAt.getTime()) / (1000 * 60 * 60 * 24))} days)`)
             deleted++
           }
         } else {
           skipped++
         }
       }
   
       const summary = { deleted, skipped, errors }
       console.log('[Cleanup] Summary:', summary)
   
       return new Response(JSON.stringify(summary), {
         headers: { 'Content-Type': 'application/json' },
       })
   
     } catch (error) {
       console.error('[Cleanup] Fatal error:', error)
       return new Response(JSON.stringify({ error: error.message }), {
         status: 500,
         headers: { 'Content-Type': 'application/json' },
       })
     }
   })
   ```

3. **Deploy the Edge Function:**
   ```powershell
   # Login to Supabase CLI (if not already)
   npx supabase login
   
   # Link to your project
   npx supabase link --project-ref jvijitdewbypqbatfboi
   
   # Deploy the function
   npx supabase functions deploy cleanup-exports
   ```

4. **Set Environment Secrets:**
   
   First, generate a strong random secret (or use this PowerShell command):
   ```powershell
   # Generate a random secret (copy the output)
   -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | % {[char]$_})
   ```
   
   Then set it in Supabase:
   ```powershell
   # Set YOUR secret for cron authentication (replace with your generated secret)
   npx supabase secrets set CRON_SECRET=Abc123XyzYourSecretHere456
   
   # The function will automatically have access to SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
   ```
   
   **⚠️ Important:** Remember this secret! You'll need it in step 5 for the cron SQL.

5. **Create a Cron Job (Supabase Dashboard):**
   
   Go to your Supabase Dashboard → **Database** → **Extensions** → Enable **pg_cron**
   
   Then run this SQL in SQL Editor:
   ```sql
   -- Create _a scheduled job that runs every Sunday at 2 AM
   SELECT cron.schedule(
     'cleanup-old-exports',           -- Job name
     '0 2 * * 0',                     -- Cron expression (Sunday 2 AM)
     $$
     SELECT
       net.http_post(
         url := 'https://jvijitdewbypqbatfboi.supabase.co/functions/v1/cleanup-exports',
         headers := jsonb_build_object(
           'Content-Type', 'application/json',
           'Authorization', 'Bearer Abc123XyzYourSecretHere456'
         ),
         body := '{}'::jsonb
       ) as request_id;
     $$
   );
   ```
   
   **⚠️ IMPORTANT - Replace these values:**
   - `project_ref` → Your Supabase project ID
   - `Abc123XyzYourSecretHere456` → The SAME secret you set in step 4

6. **Test the Edge Function Manually:**
   ```powershell
   # Test it via HTTP (replace with YOUR secret from step 4)
   Invoke-WebRequest -Uri "https://jvijitdewbypqbatfboi.supabase.co/functions/v1/cleanup-exports" `
     -Method POST `
     -Headers @{
       "Authorization" = "Bearer Abc123XyzYourSecretHere456"
       "Content-Type" = "application/json"
     }
   
   # Expected: {"success":true,"deleted":0,"skipped":0,"errors":0}
   ```

7. **Verify Cron Job is Scheduled:**
   ```sql
   -- Check scheduled jobs
   SELECT jobid, schedule, command, nodename, nodeport, database, username, active
   FROM cron.job;
   
   -- Check job run history (if any runs have completed)
   SELECT runid, jobid, job_pid, database, username, command, status, 
          return_message, start_time, end_time
   FROM cron.job_run_details
   ORDER BY start_time DESC
   LIMIT 10;
   
   -- To see runs for a specific job, first get the jobid from cron.job, then:
   -- SELECT * FROM cron.job_run_details WHERE jobid = YOUR_JOB_ID;
   ```

✅ **Cloud-based cleanup scheduled successfully!**

---

### ❓ What Happens Next? (After Setup)

**You're done! Here's what happens automatically:**

✅ **Now (Immediately After Setup):**
- Edge function is deployed and ready
- Cron job is scheduled in database
- Next run: This coming Sunday at 2 AM

✅ **Every Sunday at 2 AM (Automatic):**
- pg_cron wakes up
- Makes HTTP POST to your edge function
- Edge function deletes old export files (7+ days old)
- Result logged in `cron.job_run_details` table

✅ **You Do Nothing!**
- No manual triggering needed
- No need to keep your computer on
- No need to run scripts manually
- It just works in the cloud ☁️

**Want to verify it's working?**

1. **Check the cron schedule exists:**
   ```sql
   SELECT * FROM cron.job;
   -- You should see 'cleanup-old-exports' with schedule '0 2 * * 0'
   ```

2. **After the first run (next Sunday 2 AM), check the logs:**
   ```sql
   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 1;
   -- You'll see the execution result
   ```

3. **Check Supabase Function Logs:**
   - Go to Supabase Dashboard → **Edge Functions** → **cleanup-exports**
   - Click **Logs** tab
   - You'll see "[Cleanup] ✅ Cleanup completed successfully"

**Want to test it NOW without waiting?**
- Run the edge function manually (see step 6 above)
- Or temporarily change the cron schedule to run every minute for testing:
  ```sql
  -- Delete old schedule
  SELECT cron.unschedule('cleanup-old-exports');
  
  -- Create new schedule (runs every minute)
  SELECT cron.schedule('cleanup-old-exports', '* * * * *', $$...(same SQL as before)$$);
  
  -- After testing, change back to weekly
  SELECT cron.unschedule('cleanup-old-exports');
  SELECT cron.schedule('cleanup-old-exports', '0 2 * * 0', $$...(same SQL as before)$$);
  ```

---

**Benefits of Option B:**
- ✅ Runs in the cloud (no local machine needed)
- ✅ Works even if your computer is off
- ✅ Managed by Supabase infrastructure
- ✅ Easy to monitor via Supabase dashboard
- ✅ Scales automatically

**Drawbacks:**
- Requires pg_cron extension (available on paid plans)
- Slightly more complex setup

---

## Step 3: Deploy AI Server (15 minutes)

### 3.1 Install Dependencies (if needed)

```powershell
cd d:\ATG-timetracker\compliance\JIRAForge\ai-server
npm install
```

### 3.2 Verify Environment Variables

Check your `.env` file contains:

```bash
FORGE_APP_ID=ari:cloud:ecosystem::app/c8bab1dc-ae32-4e6f-9dbd-eb242cc6c14a
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
```

### 3.3 Test Locally (Optional)

```powershell
npm run dev
```

✅ **Expected:**
- Server starts on port 3001
- No errors in console
- You should see: `[Server] AI Server started on port 3001`

Press `Ctrl+C` to stop.

### 3.4 Deploy to Production

Deploy using your normal deployment process (e.g., to `https://forgesync.amzur.com`)

✅ **Verify:** Server is online and accessible

---

## Step 4: Deploy Forge App (15 minutes)

### 4.1 Lint Check

```powershell
cd d:\ATG-timetracker\compliance\JIRAForge\forge-app
forge lint
```

✅ **Expected:** No errors or warnings

### 4.2 Deploy to Development First

```powershell
forge deploy --environment development
```

✅ **Expected:** Deployment succeeds

### 4.3 Deploy to Production

```powershell
forge deploy --environment production
```

✅ **Expected:** Deployment succeeds

---

## Step 5: Testing (30-60 minutes)

### 5.1 Quick Database Check

Run this in Supabase SQL Editor to verify migrations:

```sql
-- 1. Check data_requests table exists (should return ~10-12 columns)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'data_requests'
ORDER BY ordinal_position;

-- 2. Check exports bucket exists (should return 1 row with id='exports')
SELECT id, name, public, created_at 
FROM storage.buckets 
WHERE id = 'exports';

-- 3. Check deletion_requests table (if you ran migration 3)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'deletion_requests'
ORDER BY ordinal_position;
```

✅ **Expected Results:**
- Query 1: Should show columns like `id`, `account_id`, `request_type`, `status`, etc.
- Query 2: Should return 1 row with bucket name "exports"
- Query 3: Should show deletion_requests columns (if migration 3 was run)

### 5.2 Test Export Flow (Manual)

**⚠️ Important:** This requires a real Atlassian/Jira account with app installed.

1. **Login to Jira:**
   - Use your Jira Cloud instance
   - Login as an admin

2. **Navigate to App Settings:**
   - Go to **Settings** (⚙️ icon)
   - Click **Apps** → **Manage your apps**
   - Find **"Time Tracker"** in the list

3. **Request Personal Data Export:**
   - Click on the app (depends on Atlassian UI)
   - Look for **"Request Personal Data"** or **"Privacy"** section
   - Click **"Export my data"**

4. **First Poll - Check PENDING Status:**
   - You should see: "Your request is being processed"
   - **Check Forge Logs:**
     ```powershell
     forge logs --environment development
     ```
     Look for:
     ```
     [PersonalData] Request received
     [PersonalData] Creating new request
     ```

5. **Check AI Server Logs:**
   - Check your server logs
   - Look for:
     ```
     [UserData] Created new request
     [UserData] Starting export
     ```

6. **Wait for Processing:**
   - Should complete in 1-5 minutes
   - **Check Database:**
     ```sql
     SELECT * FROM data_requests ORDER BY requested_at DESC LIMIT 1;
     ```
   - Status should change: `pending` → `processing` → `completed`

7. **Second Poll - Check COMPLETED:**
   - Refresh the Jira page or wait for Atlassian to poll again
   - You should see a **Download** button or link
   - Click download
   - Verify you get a JSON file

8. **Verify Export Contents:**
   - Open the downloaded JSON file
   - Check it contains:
     ```json
     {
       "dataType": "user_personal_data_export",
       "exportedAt": "2026-04-07T...",
       "user": { ... },
       "screenshots": [ ... ],
       "analysisResults": [ ... ],
       "activityRecords": [ ... ],
       ...
     }
     ```

✅ **Export test PASSED!**

### 5.3 Test Deletion Flow (Manual)

**⚠️ CRITICAL WARNING:** Only test with a TEST USER account! Deletion is PERMANENT!

1. **Create a Test User:**
   - Create a test Jira account
   - Install the app for that user
   - Generate some test data (screenshots, worklogs, etc.)

2. **Request Deletion:**
   - Login as test user
   - Follow same steps as export, but choose **"Delete my data"**
   - Confirm the deletion warning

3. **Check PENDING Status:**
   - Similar to export flow
   - Check logs for confirmation

4. **Wait for Processing:**
   - Should complete in 1-5 minutes
   - **Check Database:**
     ```sql
     -- User should be GONE
     SELECT * FROM users WHERE atlassian_account_id = 'test-account-id';
     -- Should return 0 rows
     
     -- Check child tables are also empty
     SELECT COUNT(*) FROM screenshots WHERE user_id = (
       SELECT id FROM users WHERE atlassian_account_id = 'test-account-id'
     );
     -- Should return 0
     ```

5. **Verify Deletion Summary:**
   - User should see completion message with summary
   - Check `activity_log` for deletion audit entry:
     ```sql
     SELECT * FROM activity_log 
     WHERE event_type = 'user_data_deletion'
     ORDER BY created_at DESC LIMIT 1;
     ```

✅ **Deletion test PASSED!**

### 5.4 Test API Endpoints Directly (Advanced)

If you want to test the API endpoints directly:

```powershell
# Test status endpoint
Invoke-WebRequest -Uri "https://forgesync.amzur.com/api/v1/user-data/status" `
  -Method POST `
  -Headers @{
    "Authorization" = "Bearer YOUR_FIT_TOKEN_HERE"
    "Content-Type" = "application/json"
  } `
  -Body '{"accountId":"test-account-id"}'

# Expected: {"exists":false} or {"exists":true,"status":"completed",...}
```

✅ **API test PASSED!**

---

## ✅ Final Verification Checklist

Go through this checklist to confirm everything is working:

- [ ] **Database:**
  - [ ] `data_requests` table exists
  - [ ] `exports` storage bucket exists
  - [ ] `deletion_requests` table exists (optional)

- [ ] **Cleanup Job:**
  - [ ] Cleanup script runs successfully manually
  - [ ] Task scheduler job created and tested
  - [ ] Last run result shows success (0x0)

- [ ] **AI Server:**
  - [ ] Deployed successfully
  - [ ] No errors in logs on startup
  - [ ] New routes accessible: `/api/v1/user-data/*`

- [ ] **Forge App:**
  - [ ] `forge lint` passes
  - [ ] Deployed to production
  - [ ] `userDataProvider` module registered

- [ ] **Testing:**
  - [ ] Export flow tested successfully
  - [ ] Deletion flow tested successfully (on test user)
  - [ ] Download link works and JSON is valid
  - [ ] Deleted data is actually gone from database

---

## 🐛 Troubleshooting

### Problem: Migration fails with "relation already exists"

**Solution:** Table already created. Check if it exists:
```sql
-- This will show the table structure
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'data_requests';
```
If you see columns listed, the migration already ran successfully.

---

### Problem: "Success. No rows returned" - Is the table created?

**Solution:** Yes! This message means the migration succeeded. To verify the table structure:
```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'data_requests'
ORDER BY ordinal_position;
```
You should see columns like `id`, `account_id`, `status`, etc.

---

### Problem: Cleanup script shows "Module not found"

**Solution:** 
1. Make sure you're in the `ai-server` directory
2. Check `.env` file exists with correct credentials
3. Run `npm install` to ensure dependencies are installed

---

### Problem: Can I test the cleanup script without waiting 7 days?

**Solution:** Yes! Temporarily modify the script for testing:

1. Open `ai-server/scripts/cleanup-old-exports.js`
2. Find line: `const MAX_AGE_DAYS = 7;`
3. Change to: `const MAX_AGE_DAYS = 0;` (delete ALL files)
4. Upload a test file to exports bucket in Supabase
5. Run: `node scripts/cleanup-old-exports.js`
6. File should be deleted immediately
7. **IMPORTANT:** Change `MAX_AGE_DAYS` back to `7` before scheduling!

**For Edge Function (Option B):**
1. Open `supabase/functions/cleanup-exports/index.ts`
2. Change `const MAX_AGE_DAYS = 7` to `const MAX_AGE_DAYS = 0`
3. Redeploy: `npx supabase functions deploy cleanup-exports`
4. Test the function
5. **IMPORTANT:** Change back to `7` and redeploy!

---

### Problem: Edge Function returns "Unauthorized"

**Solution:**
1. Check the `CRON_SECRET` is set correctly:
   ```powershell
   npx supabase secrets list
   ```
2. Make sure your cron SQL uses the same secret in the Authorization header
3. Test manually with the correct Bearer token

---

### Problem: pg_cron is not available

**Solution:**
- pg_cron requires a paid Supabase plan (Pro or higher)
- Alternative: Use a third-party cron service like:
  - **cron-job.org** (free)
  - **EasyCron** (free tier available)
  - **GitHub Actions** (free for public repos)
  
Configure them to call your edge function URL weekly.

---

### Problem: Task Scheduler shows "Not Scheduled"

**Solution:**
1. Verify Node.js path:
   ```powershell
   where node
   # Should show: C:\Program Files\nodejs\node.exe
   ```
2. Use the full path in Task Scheduler
3. Make sure "Start in" directory is correct

---

### Problem: Export/Deletion stays in PENDING forever

**Solution:**
1. Check AI server logs for errors
2. Verify AI server is accessible
3. Check database:
   ```sql
   SELECT * FROM data_requests WHERE status = 'pending' AND requested_at < NOW() - INTERVAL '1 hour';
   ```
4. Manually trigger re-processing or mark as failed

---

### Problem: "Cannot find module" errors

**Solution:**
Ensure your `ai-server/.env` file has:
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_key_here
```

---

## 📞 Need Help?

If you encounter issues:

1. **Check Logs:**
   - AI Server logs: Check your deployment logs
   - Forge logs: `forge logs --environment production`
   - Supabase logs: Check Logs section in Supabase dashboard

2. **Check Database:**
   - Query `data_requests` table for status
   - Check for error messages in `error_message` column

3. **Verify Configuration:**
   - Environment variables in `.env`
   - Forge app ID matches in manifest.yml and AI server config
   - Supabase credentials are valid

---

## 🎉 Success Criteria

You're done when:

✅ All migrations run successfully  
✅ Cleanup job scheduled and tested  
✅ AI server deployed with no errors  
✅ Forge app deployed with no errors  
✅ Export test completes successfully  
✅ Deletion test completes successfully (on test user)  
✅ All data is properly deleted from database  

**Congratulations! Your Personal Data Reporting API is now live and GDPR compliant! 🚀**

---

**Created:** April 7, 2026  
**Last Updated:** April 7, 2026

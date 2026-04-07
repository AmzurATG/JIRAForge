# Quick Start: App Uninstall Deletion Setup

**Simple step-by-step guide to set up automatic data deletion on app uninstall**

Last Updated: April 7, 2026

---

## 📋 Prerequisites

Before you start, make sure you have:
- ✅ Supabase project credentials (Project ID, Database URL)
- ✅ Access to Supabase SQL Editor
- ✅ AI server API key (the `AI_SERVER_API_KEY` from your `ai-server/.env` file)
- ✅ AI server running at `https://forgesync.amzur.com`

---

## 🚀 Step 1: Run Database Migration (5 minutes)

### Option A: Using Supabase Dashboard (Easiest)

1. **Open the migration file:**
   ```
   d:\ATG-timetracker\compliance\JIRAForge\supabase\migrations\20260403_add_deletion_lifecycle.sql
   ```

2. **Copy the entire file content** (Ctrl+A, Ctrl+C)

3. **Open Supabase SQL Editor:**
   - Go to: https://app.supabase.com
   - Select your project
   - Click **SQL Editor** in left sidebar
   - Click **New Query**

4. **Paste and run:**
   - Paste the SQL (Ctrl+V)
   - Click **Run** (or press Ctrl+Enter)
   - Wait for "Success. No rows returned" message

### Option B: Using Supabase CLI

```powershell
# Navigate to project root
cd d:\ATG-timetracker\compliance\JIRAForge

# Run migration
supabase db push
```

### ✅ Verify Migration Success

Run this in Supabase SQL Editor:

```sql
-- Should return 3 rows
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'organizations' 
  AND column_name IN ('status', 'scheduled_deletion_at', 'uninstalled_at');

-- Should return rows showing your tables
SELECT * FROM get_org_scoped_tables();
```

**✅ If both queries return results, migration succeeded!**

---

## 🕐 Step 2: Set Up Scheduled Deletion Job (10 minutes)

You have 2 options. Choose ONE:

### Option A: Supabase Edge Function + pg_cron (Recommended)

#### 2A.1: Create Edge Function

```powershell
# Create function directory
cd d:\ATG-timetracker\compliance\JIRAForge\supabase\functions
mkdir scheduled-deletion
cd scheduled-deletion
```

Create file `index.ts`:

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

serve(async (req) => {
  try {
    console.log('[Edge Function] Starting scheduled deletion');
    
    const response = await fetch('https://forgesync.amzur.com/api/admin/process-deletions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('ADMIN_API_KEY')}`,
        'Content-Type': 'application/json'
      }
    });
    
    const result = await response.json();
    console.log('[Edge Function] Result:', result);
    
    return new Response(JSON.stringify({ success: true, result }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('[Edge Function] Error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
})
```

#### 2A.2: Deploy Edge Function

```powershell
# Login to Supabase (if not already)
supabase login

# Link project (replace YOUR_PROJECT_ID)
supabase link --project-ref YOUR_PROJECT_ID

# Deploy function
supabase functions deploy scheduled-deletion

# Set admin API key secret
# (Use the same value as AI_SERVER_API_KEY from ai-server/.env)
supabase secrets set ADMIN_API_KEY=your_ai_server_api_key_here
```

#### 2A.3: Test Edge Function

**Option A: Test in Supabase Dashboard (Easiest)**

1. Go to your Supabase project: https://app.supabase.com
2. Click **Edge Functions** in the left sidebar
3. Find `scheduled-deletion` in the list
4. Click **Invoke** button
5. Leave request body empty: `{}`
6. Click **Send request**
7. Check the response panel

**Expected response:** 
```json
{
  "success": true,
  "result": {
    "processed": 0,
    "succeeded": 0,
    "failed": 0
  }
}
```

**✅ If you see this response, the edge function works!**

**❌ Getting "Endpoint not found" error?**

If you see this response:
```json
{
  "success": true,
  "result": {
    "success": false,
    "error": "Endpoint not found"
  }
}
```

This means the edge function is working, but the AI server endpoint doesn't exist yet. **This is expected if you haven't deployed the AI server code yet.**

**Solutions:**
1. **Deploy AI server first** (see Step 4.2 below)
2. **Or skip this test for now** - The edge function is working, you'll test the full flow in Step 3

The edge function itself is deployed correctly. The "endpoint not found" just means the AI server needs to be updated with the deletion code.

---

**Option B: Test via PowerShell (Alternative)**

```powershell
# Test the deployed function (replace YOUR_PROJECT_ID and YOUR_ANON_KEY)
Invoke-WebRequest -Uri "https://YOUR_PROJECT_ID.supabase.co/functions/v1/scheduled-deletion" `
  -Method POST `
  -Headers @{"Authorization" = "Bearer YOUR_SUPABASE_ANON_KEY"}
```

#### 2A.4: Schedule with pg_cron

Run this in Supabase SQL Editor (replace YOUR_PROJECT_ID and YOUR_ANON_KEY):

```sql
-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule daily at 2 AM UTC
SELECT cron.schedule(
  'scheduled-deletion-job',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_ID.supabase.co/functions/v1/scheduled-deletion',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SUPABASE_ANON_KEY"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- Verify job created
SELECT jobid, schedule, jobname, active 
FROM cron.job 
WHERE jobname = 'scheduled-deletion-job';
```

**✅ If you see a row with `active = t`, job is scheduled!**

---

### Option B: Node.js Cron in AI Server (Simpler)

#### 2B.1: Add Cron Code

Add to `ai-server/src/index.js` (after app initialization):

```javascript
// Add at the top with other imports
const cron = require('node-cron');
const { processScheduledDeletions } = require('./services/deletion-service');

// Add before app.listen()
cron.schedule('0 2 * * *', async () => {
  logger.info('[Cron] Starting scheduled deletion job');
  try {
    const result = await processScheduledDeletions();
    logger.info('[Cron] Deletion completed', result);
  } catch (error) {
    logger.error('[Cron] Deletion failed', { error: error.message });
  }
});

logger.info('[Cron] Scheduled deletion job registered (daily at 2 AM UTC)');
```

#### 2B.2: Install Dependency & Restart

```powershell
cd d:\ATG-timetracker\compliance\JIRAForge\ai-server

# Install node-cron
npm install node-cron

# Restart server
pm2 restart ai-server
# OR if not using pm2:
npm run start:prod
```

#### 2B.3: Verify Cron Started

```powershell
# Check logs for confirmation
pm2 logs ai-server | grep Cron

# Should see: "[Cron] Scheduled deletion job registered (daily at 2 AM UTC)"
```

---

## 🧪 Step 3: Test the Deletion Flow (15 minutes)

### 3.1: Create Test Organization

```sql
-- Run in Supabase SQL Editor

-- Create test organization (using auto-generated UUIDs)
INSERT INTO organizations (id, jira_cloud_id, jira_instance_url, org_name, created_at)
VALUES (
  '11111111-1111-1111-1111-111111111111'::uuid,
  'test-cloud-123',
  'https://test-org.atlassian.net',
  'Test Organization',
  NOW()
)
ON CONFLICT (jira_cloud_id) DO NOTHING;

-- Create test user
INSERT INTO users (id, organization_id, atlassian_account_id, email, display_name)
VALUES (
  '22222222-2222-2222-2222-222222222222'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'test-account-id-123',
  'test@example.com',
  'Test User'
)
ON CONFLICT (atlassian_account_id) DO NOTHING;

-- Create test screenshot
INSERT INTO screenshots (user_id, organization_id, timestamp, storage_url, storage_path)
VALUES (
  '22222222-2222-2222-2222-222222222222'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  NOW(),
  'https://test.url',
  'test/path.png'
);

-- Verify test data exists
SELECT 
  (SELECT COUNT(*) FROM users WHERE organization_id = '11111111-1111-1111-1111-111111111111') as users_count,
  (SELECT COUNT(*) FROM screenshots WHERE organization_id = '11111111-1111-1111-1111-111111111111') as screenshots_count;
```

**✅ Should show: `users_count: 1, screenshots_count: 1`**

### 3.2: Simulate App Uninstall

```sql
-- Mark organization for deletion
UPDATE organizations
SET status = 'pending_deletion',
    scheduled_deletion_at = NOW() + INTERVAL '30 days',
    uninstalled_at = NOW()
WHERE id = '11111111-1111-1111-1111-111111111111';

-- Create audit log entry
INSERT INTO deletion_audit_log (
  organization_id, jira_cloud_id, org_name, 
  initiated_at, scheduled_for, status
)
VALUES (
  '11111111-1111-1111-1111-111111111111'::uuid,
  'test-cloud-123',
  'Test Organization',
  NOW(),
  NOW() + INTERVAL '30 days',
  'pending'
);

-- Verify organization is pending deletion
SELECT id, org_name, status, scheduled_deletion_at 
FROM organizations 
WHERE id = '11111111-1111-1111-1111-111111111111';
```

**✅ Should show: `status: pending_deletion, scheduled_deletion_at: 30 days from now`**

### 3.3: Test Manual Deletion (Skip 30-day wait)

```sql
-- Set deletion date to NOW for testing
UPDATE deletion_audit_log
SET scheduled_for = NOW() - INTERVAL '1 hour'
WHERE organization_id = '11111111-1111-1111-1111-111111111111';
```

Trigger deletion manually:

**Option A: Using PowerShell (Recommended - See Response)**

```powershell
# Call admin endpoint (replace YOUR_AI_SERVER_API_KEY with value from ai-server/.env)
Invoke-WebRequest -Uri "https://forgesync.amzur.com/api/admin/process-deletions" `
  -Method POST `
  -Headers @{
    "Authorization" = "Bearer YOUR_AI_SERVER_API_KEY"
    "Content-Type" = "application/json"
  }
```

> **Where to find YOUR_AI_SERVER_API_KEY:**
> 1. Open `ai-server/.env` file
> 2. Find the line: `AI_SERVER_API_KEY=your-secret-key-here`
> 3. Copy the value after the `=` sign
> 4. Replace `YOUR_AI_SERVER_API_KEY` in the command above

**Expected response:**
```json
{
  "success": true,
  "processed": 1,
  "succeeded": 1,
  "failed": 0,
  "results": [...]
}
```

**Option B: Using Supabase SQL (Fire & Forget)**

If you prefer SQL, run this in Supabase SQL Editor:

```sql
-- Trigger deletion (Note: You won't see the response in SQL)
SELECT net.http_post(
  url := 'https://forgesync.amzur.com/api/admin/process-deletions',
  headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_AI_SERVER_API_KEY"}'::jsonb,
  body := '{}'::jsonb
) AS request_id;
```

This returns a request ID number. To verify it worked, skip to Step 3.4 to check if data was deleted.

### 3.4: Verify Data Deleted

```sql
-- Check all data is gone
SELECT 
  (SELECT COUNT(*) FROM users WHERE organization_id = '11111111-1111-1111-1111-111111111111') as users_count,
  (SELECT COUNT(*) FROM screenshots WHERE organization_id = '11111111-1111-1111-1111-111111111111') as screenshots_count,
  (SELECT COUNT(*) FROM organizations WHERE id = '11111111-1111-1111-1111-111111111111') as org_count;

-- All should be 0
-- Expected: users_count: 0, screenshots_count: 0, org_count: 0
```

**✅ If all counts are 0, deletion works!**

### 3.5: Check Audit Log

```sql
-- View deletion summary
SELECT status, deletion_summary, completed_at
FROM deletion_audit_log
WHERE organization_id = '11111111-1111-1111-1111-111111111111';

-- Should show:
-- status: completed
-- deletion_summary: {tables: {...}, storage: {...}}
-- completed_at: (timestamp)
```

**✅ If status is 'completed', everything works correctly!**

---

## 🎯 Step 4: Deploy to Production

### 4.1: Update Forge App

```powershell
cd d:\ATG-timetracker\compliance\JIRAForge\forge-app

# Build
forge build

# Deploy to production
forge deploy --environment production

# Install in production Jira site
forge install --site your-production-site.atlassian.net
```

### 4.2: Restart AI Server

```powershell
cd d:\ATG-timetracker\compliance\JIRAForge\ai-server

# Pull latest code
git pull origin main

# Install dependencies
npm install

# Restart
pm2 restart ai-server
```

---

## 📊 Step 5: Monitor (Ongoing)

### Daily Check (30 seconds)

```sql
-- Check for failed deletions
SELECT org_name, error_details, initiated_at
FROM deletion_audit_log
WHERE status = 'failed'
ORDER BY initiated_at DESC
LIMIT 5;

-- Check pending deletions
SELECT org_name, scheduled_for, 
       EXTRACT(DAY FROM (scheduled_for - NOW())) as days_until_deletion
FROM deletion_audit_log
WHERE status = 'pending'
ORDER BY scheduled_for ASC;
```

### Weekly Check

```sql
-- View deletion statistics (last 7 days)
SELECT 
  DATE(initiated_at) as date,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE status = 'completed') as successful,
  COUNT(*) FILTER (WHERE status = 'failed') as failed
FROM deletion_audit_log
WHERE initiated_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(initiated_at)
ORDER BY date DESC;
```

---

## 🐛 Troubleshooting

### Problem: Migration fails

**Solution:**
```sql
-- Check if columns already exist
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'organizations';

-- If columns exist, skip migration
```

### Problem: Scheduled job not running

**Solution:**
```sql
-- Check cron job status
SELECT * FROM cron.job WHERE jobname = 'scheduled-deletion-job';

-- Check execution history
SELECT * FROM cron.job_run_details 
WHERE jobname = 'scheduled-deletion-job' 
ORDER BY start_time DESC 
LIMIT 5;
```

### Problem: Edge function returns "Endpoint not found"

**Cause:** AI server doesn't have the deletion endpoint yet

**Solution:**
```powershell
# 1. Check if AI server has the deletion code
cd d:\ATG-timetracker\compliance\JIRAForge\ai-server
ls src/controllers/uninstall-controller.js
ls src/services/deletion-service.js

# 2. If files don't exist, pull latest code
git pull origin gdpr-atlassian-compliance-fixes-2026

# 3. Restart AI server
pm2 restart ai-server

# 4. Test endpoint directly (get AI_SERVER_API_KEY from ai-server/.env)
Invoke-WebRequest -Uri "https://forgesync.amzur.com/api/admin/process-deletions" `
  -Method POST `
  -Headers @{"Authorization" = "Bearer YOUR_AI_SERVER_API_KEY"; "Content-Type" = "application/json"}
```

### Problem: Manual deletion fails

**Solution:**
```powershell
# Check AI server logs
pm2 logs ai-server --lines 50

# Verify admin token is correct
# Check deletion-service.js for errors
```

### Problem: Data not deleted

**Solution:**
```sql
-- Check audit log for errors
SELECT error_details FROM deletion_audit_log 
WHERE organization_id = 'YOUR_ORG_ID';

-- Manually clean up if needed
DELETE FROM users WHERE organization_id = 'YOUR_ORG_ID';
DELETE FROM screenshots WHERE organization_id = 'YOUR_ORG_ID';
-- ... repeat for other tables
```

---

## ✅ Success Checklist

- [ ] Database migration completed (Step 1)
- [ ] Scheduled job running (Step 2)
- [ ] Test deletion successful (Step 3)
- [ ] All test data deleted (Step 3.4)
- [ ] Audit log shows 'completed' (Step 3.5)
- [ ] Production deployment done (Step 4)
- [ ] Monitoring queries work (Step 5)

---

## 📞 Need Help?

**Quick Reference:**
- Migration file: `supabase/migrations/20260403_add_deletion_lifecycle.sql`
- Deletion service: `ai-server/src/services/deletion-service.js`
- Uninstall controller: `ai-server/src/controllers/uninstall-controller.js`
- Full docs: `docs/APP_UNINSTALL_IMPLEMENTATION_SUMMARY.md`

**Common Commands:**
```powershell
# Check Supabase connection
supabase login
supabase projects list

# Check AI server status
pm2 status

# View AI server logs
pm2 logs ai-server

# Manual deletion trigger (get AI_SERVER_API_KEY from ai-server/.env)
Invoke-WebRequest -Uri "https://forgesync.amzur.com/api/admin/process-deletions" `
  -Method POST `
  -Headers @{"Authorization" = "Bearer YOUR_AI_SERVER_API_KEY"; "Content-Type" = "application/json"}
```

---

**Time to complete:** ~30 minutes  
**Difficulty:** Beginner-friendly

Good luck! 🚀

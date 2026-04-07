# App Uninstall Deletion - Setup Checklist

Print this and check off each step as you complete it.

---

## 🎯 Setup Phase

### Step 1: Database Migration
- [ ] Open Supabase SQL Editor
- [ ] Copy `20260403_add_deletion_lifecycle.sql` content
- [ ] Paste into SQL Editor
- [ ] Click Run
- [ ] Verify success: Run `SELECT * FROM get_org_scoped_tables();`
- [ ] ✅ See list of tables returned

**Time:** 5 minutes

---

### Step 2: Scheduled Job Setup

**Choose ONE option:**

#### Option A: Supabase Edge Function
- [ ] Create `supabase/functions/scheduled-deletion/index.ts`
- [ ] Copy edge function code
- [ ] Run: `supabase functions deploy scheduled-deletion`
- [ ] Run: `supabase secrets set ADMIN_API_KEY=...`
- [ ] Test in dashboard: Edge Functions → scheduled-deletion → Invoke
- [ ] ✅ Response shows: `"success": true`
- [ ] Create pg_cron schedule in SQL Editor
- [ ] Verify: `SELECT * FROM cron.job WHERE jobname = 'scheduled-deletion-job';`
- [ ] ✅ See job with `active = t`

**OR**

#### Option B: Node.js Cron
- [ ] Add cron code to `ai-server/src/index.js`
- [ ] Run: `npm install node-cron`
- [ ] Run: `pm2 restart ai-server`
- [ ] Check logs: `pm2 logs ai-server | grep Cron`
- [ ] ✅ See: "Scheduled deletion job registered"

**Time:** 10 minutes

---

## 🧪 Testing Phase

### Step 3: Create Test Data
```sql
-- Copy and run this:
INSERT INTO organizations (id, jira_cloud_id, jira_instance_url, org_name, created_at)
VALUES (
  '11111111-1111-1111-1111-111111111111'::uuid,
  'test-cloud-123',
  'https://test-org.atlassian.net',
  'Test Organization',
  NOW()
);

INSERT INTO users (id, organization_id, atlassian_account_id, email, display_name)
VALUES (
  '22222222-2222-2222-2222-222222222222'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  'test-account-id-123',
  'test@example.com',
  'Test User'
);

INSERT INTO screenshots (user_id, organization_id, timestamp, storage_url, storage_path)
VALUES (
  '22222222-2222-2222-2222-222222222222'::uuid,
  '11111111-1111-1111-1111-111111111111'::uuid,
  NOW(),
  'https://test.url',
  'test/path.png'
);

-- Verify:
SELECT COUNT(*) FROM users WHERE organization_id = '11111111-1111-1111-1111-111111111111';
SELECT COUNT(*) FROM screenshots WHERE organization_id = '11111111-1111-1111-1111-111111111111';
```

- [ ] Run SQL above
- [ ] ✅ Confirm: 1 user, 1 screenshot

---

### Step 4: Simulate Uninstall
```sql
-- Copy and run this:
UPDATE organizations
SET status = 'pending_deletion',
    scheduled_deletion_at = NOW() + INTERVAL '30 days',
    uninstalled_at = NOW()
WHERE id = '11111111-1111-1111-1111-111111111111';

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

-- Verify:
SELECT status, scheduled_deletion_at FROM organizations WHERE id = '11111111-1111-1111-1111-111111111111';
```

- [ ] Run SQL above
- [ ] ✅ Confirm: `status = pending_deletion`

---

### Step 5: Test Deletion
```sql
-- Set deletion to NOW:
UPDATE deletion_audit_log
SET scheduled_for = NOW() - INTERVAL '1 hour'
WHERE organization_id = '11111111-1111-1111-1111-111111111111';
```

```sql
-- Trigger deletion (get AI_SERVER_API_KEY from ai-server/.env):
SELECT net.http_post(
  url := 'https://forgesync.amzur.com/api/admin/process-deletions',
  headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_AI_SERVER_API_KEY"}'::jsonb,
  body := '{}'::jsonb
);
```

- [ ] Run SQL above
- [ ] ✅ Response shows: `"succeeded": 1`

---
11111111-1111-1111-1111-111111111111';
SELECT COUNT(*) FROM screenshots WHERE organization_id = '11111111-1111-1111-1111-111111111111';
SELECT COUNT(*) FROM organizations WHERE id = '11111111-1111-1111-1111-111111111111';

-- Check audit log:
SELECT status, deletion_summary FROM deletion_audit_log 
WHERE organization_id = '11111111-1111-1111-1111-111111111111ERE id = 'test-org-123';

-- Check audit log:
SELECT status, deletion_summary FROM deletion_audit_log 
WHERE organization_id = 'test-org-123';
```

- [ ] Run SQL above
- [ ] ✅ All counts = 0
- [ ] ✅ Audit log status = 'completed'

**Time:** 15 minutes

---

## 🚀 Production Deployment

### Step 7: Deploy Forge App
```powershell
cd forge-app
forge build
forge deploy --environment production
forge install --site your-production-site.atlassian.net
```

- [ ] Run commands above
- [ ] ✅ App shows "Installed" in Jira

---

### Step 8: Deploy AI Server
```powershell
cd ai-server
git pull origin main
npm install
pm2 restart ai-server
```

- [ ] Run commands above
- [ ] ✅ Server status shows "online"

**Time:** 10 minutes

---

## 📊 Monitoring Setup

### Step 9: Test Monitoring Queries

```sql
-- Failed deletions:
SELECT org_name, error_details 
FROM deletion_audit_log 
WHERE status = 'failed' 
ORDER BY initiated_at DESC 
LIMIT 5;

-- Pending deletions:
SELECT org_name, scheduled_for 
FROM deletion_audit_log 
WHERE status = 'pending' 
ORDER BY scheduled_for ASC;

-- Statistics (last 7 days):
SELECT 
  DATE(initiated_at) as date,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE status = 'completed') as successful
FROM deletion_audit_log
WHERE initiated_at > NOW() - INTERVAL '7 days'
GROUP BY DATE(initiated_at);
```

- [ ] Save these queries in Supabase
- [ ] Run each query
- [ ] ✅ Queries return results (may be empty)

**Time:** 5 minutes

---

## ✅ Final Checklist

- [ ] Database migration: ✅ Completed
- [ ] Scheduled job: ✅ Running
- [ ] Test deletion: ✅ Succeeded
- [ ] All test data: ✅ Deleted
- [ ] Audit log: ✅ Shows 'completed'
- [ ] Forge app: ✅ Deployed to production
- [ ] AI server: ✅ Deployed and running
- [ ] Monitoring: ✅ Queries work

---

## 🎉 You're Done!

**Total Time:** ~45 minutes

**What happens now:**
1. When someone uninstalls your app from Jira, the org is marked `pending_deletion`
2. After 30 days, the scheduled job automatically deletes all data
3. Audit log tracks all deletions
4. If they reinstall within 30 days, data is restored

**Next Steps:**
- Set up daily monitoring (run failed deletions query)
- Set up alerts for failed deletions
- Document your admin API key in a secure location

---

**Need help?** See full docs: `docs/APP_UNINSTALL_IMPLEMENTATION_SUMMARY.md`

**Quick test anytime:**
```powershell
curl -X POST https://forgesync.amzur.com/api/admin/process-deletions \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Should return: `{"success": true, "processed": X, ...}`

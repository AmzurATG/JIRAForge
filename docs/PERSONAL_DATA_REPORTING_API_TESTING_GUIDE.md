# Personal Data Reporting API - Quick Testing Guide

**Purpose:** Quick reference for testing the Personal Data Reporting API endpoints

---

## Prerequisites

- AI server running at `https://forgesync.amzur.com` (or `http://localhost:3001`)
- Valid Forge Invocation Token (FIT) 
- Test user account in Supabase with some data

---

## Method 1: Testing via Forge App (Recommended)

### Export Request

1. Log into Jira as admin
2. Go to **Settings → Apps → Manage your apps**
3. Find your app in the list
4. Click **User Settings** or **Privacy Options** (Atlassian UI varies)
5. Click **"Request Personal Data Export"**
6. Atlassian will handle polling automatically
7. You'll receive a download link when ready

### Deletion Request

1. Same as above, but select **"Request Personal Data Deletion"**
2. ⚠️ **WARNING:** Use test account only!
3. Confirm deletion
4. Atlassian will handle polling automatically

---

## Method 2: Direct API Testing (Development Only)

### Setup

**For testing, you need a valid Forge Invocation Token (FIT).**

In development, you can get one by:
1. Adding debug logging to your Forge handler
2. Making a request from the Forge UI
3. Logging the `context` object which contains the token

**OR** use Forge API mocking for local testing:
```javascript
// In your test script
import { fetch } from '@forge/api';
// This automatically includes FIT in production
```

### Test Export Flow

**Step 1: Create Request**

```bash
curl -X POST http://localhost:3001/api/v1/user-data/create-request \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_FIT_TOKEN_HERE" \
  -d '{
    "accountId": "712020:abc123...",
    "cloudId": "cloud-xyz",
    "requestType": "export"
  }'

# Expected Response:
# {
#   "success": true,
#   "request": {
#     "id": "uuid-here",
#     "status": "pending",
#     "request_type": "export",
#     ...
#   }
# }
```

**Step 2: Trigger Export Processing**

```bash
curl -X POST http://localhost:3001/api/v1/user-data/export \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_FIT_TOKEN_HERE" \
  -d '{
    "requestId": "uuid-from-step-1",
    "accountId": "712020:abc123...",
    "cloudId": "cloud-xyz"
  }'

# Expected Response (takes 1-30 seconds):
# {
#   "success": true,
#   "requestId": "uuid",
#   "signedUrl": "https://...supabase.co/storage/v1/object/sign/exports/...",
#   "expiresAt": "2026-04-04T12:00:00Z",
#   "processingDurationMs": 12345
# }
```

**Step 3: Check Status**

```bash
curl -X POST http://localhost:3001/api/v1/user-data/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_FIT_TOKEN_HERE" \
  -d '{
    "accountId": "712020:abc123...",
    "cloudId": "cloud-xyz",
    "requestType": "export"
  }'

# Expected Response:
# {
#   "success": true,
#   "request": {
#     "id": "uuid",
#     "status": "completed",
#     "result_url": "https://...",
#     "completed_at": "2026-04-03T12:00:00Z",
#     ...
#   }
# }
```

**Step 4: Download Export**

```bash
# Copy the signedUrl from step 2 or step 3
curl "https://...supabase.co/storage/v1/object/sign/exports/..." \
  -o export_data.json

# Verify JSON structure
cat export_data.json | jq .
```

### Test Deletion Flow

**⚠️ WARNING: This PERMANENTLY deletes user data. Use test accounts only!**

**Step 1: Create Request**

```bash
curl -X POST http://localhost:3001/api/v1/user-data/create-request \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_FIT_TOKEN_HERE" \
  -d '{
    "accountId": "TEST-ACCOUNT-ID",
    "cloudId": "cloud-xyz",
    "requestType": "delete"
  }'
```

**Step 2: Trigger Deletion**

```bash
curl -X POST http://localhost:3001/api/v1/user-data/delete \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_FIT_TOKEN_HERE" \
  -d '{
    "requestId": "uuid-from-step-1",
    "accountId": "TEST-ACCOUNT-ID",
    "cloudId": "cloud-xyz"
  }'

# Expected Response:
# {
#   "success": true,
#   "requestId": "uuid",
#   "summary": {
#     "recordsDeleted": {
#       "users": 1,
#       "screenshots": 123,
#       "analysis_results": 123,
#       "activity_records": 456,
#       ...
#     },
#     "filesDeleted": 150,
#     "deletedAt": "2026-04-03T12:00:00Z"
#   },
#   "processingDurationMs": 5678
# }
```

**Step 3: Verify Deletion**

```sql
-- In Supabase SQL Editor
SELECT * FROM users WHERE atlassian_account_id = 'TEST-ACCOUNT-ID';
-- Should return 0 rows

SELECT * FROM screenshots WHERE user_id = 'deleted-user-uuid';
-- Should return 0 rows

SELECT * FROM activity_log 
WHERE event_type = 'user_data_deletion' 
ORDER BY created_at DESC 
LIMIT 1;
-- Should show deletion audit log entry
```

---

## Method 3: Database Inspection

### Check Request Status

```sql
-- Get all requests
SELECT 
  id,
  request_type,
  account_id,
  status,
  requested_at,
  completed_at,
  processing_duration_ms,
  retry_count
FROM data_requests
ORDER BY requested_at DESC
LIMIT 10;

-- Get pending requests
SELECT * FROM data_requests 
WHERE status IN ('pending', 'processing')
ORDER BY requested_at ASC;

-- Get stuck requests (> 24 hours)
SELECT 
  id,
  request_type,
  account_id,
  requested_at,
  NOW() - requested_at as age
FROM data_requests
WHERE status IN ('pending', 'processing')
  AND requested_at < NOW() - INTERVAL '24 hours';
```

### Check Export Files

```sql
-- Check exports bucket
SELECT 
  name,
  metadata->>'size' as size_bytes,
  created_at
FROM storage.objects
WHERE bucket_id = 'exports'
ORDER BY created_at DESC
LIMIT 20;
```

### Check User Data

```sql
-- Get user data summary
SELECT 
  u.id,
  u.atlassian_account_id,
  u.email,
  (SELECT COUNT(*) FROM screenshots WHERE user_id = u.id) as screenshot_count,
  (SELECT COUNT(*) FROM analysis_results WHERE user_id = u.id) as analysis_count,
  (SELECT COUNT(*) FROM worklogs WHERE user_id = u.id) as worklog_count
FROM users u
WHERE u.atlassian_account_id = 'TEST-ACCOUNT-ID';
```

---

## Common Test Scenarios

### ✅ Happy Path - Export

1. Create request → PENDING
2. Start export → Processing (1-30 seconds)
3. Export completes → COMPLETED with signed URL
4. Check status → COMPLETED
5. Download file → Valid JSON
6. Wait 25 hours → Signed URL expired

**Expected:** All steps succeed, data is complete

### ✅ Happy Path - Deletion

1. Create request → PENDING
2. Start deletion → Processing (1-10 seconds)
3. Deletion completes → COMPLETED with summary
4. Check database → User gone, all data deleted
5. Check storage → Files deleted
6. Check audit log → Deletion logged

**Expected:** All steps succeed, all data permanently removed

### ⚠️ Error Case - User Not Found

1. Create request for non-existent user
2. Start export/deletion
3. Should return FAILED status with error: "User not found"

**Expected:** Graceful error handling

### ⚠️ Error Case - Duplicate Request

1. Create request → PENDING
2. Create same request again
3. Should return existing request (not create duplicate)

**Expected:** Idempotent behavior

### ⚠️ Error Case - Missing FIT Token

1. Make request without Authorization header
2. Should return 401 Unauthorized

**Expected:** Security enforcement

---

## Monitoring Queries

### Daily Summary

```sql
SELECT 
  DATE(requested_at) as date,
  request_type,
  status,
  COUNT(*) as count,
  AVG(processing_duration_ms)::int as avg_duration_ms,
  MAX(processing_duration_ms)::int as max_duration_ms
FROM data_requests
WHERE requested_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(requested_at), request_type, status
ORDER BY date DESC, request_type, status;
```

### Failed Requests

```sql
SELECT 
  id,
  request_type,
  account_id,
  error_message,
  requested_at,
  retry_count
FROM data_requests
WHERE status = 'failed'
ORDER BY requested_at DESC
LIMIT 20;
```

### Performance Metrics

```sql
SELECT 
  request_type,
  COUNT(*) as total_requests,
  COUNT(*) FILTER (WHERE status = 'completed') as completed,
  COUNT(*) FILTER (WHERE status = 'failed') as failed,
  COUNT(*) FILTER (WHERE status IN ('pending', 'processing')) as in_progress,
  AVG(processing_duration_ms) FILTER (WHERE status = 'completed')::int as avg_duration_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY processing_duration_ms) FILTER (WHERE status = 'completed')::int as p95_duration_ms
FROM data_requests
WHERE requested_at > NOW() - INTERVAL '7 days'
GROUP BY request_type;
```

---

## Troubleshooting

### Request Stuck in PENDING

**Symptoms:** Request status = 'pending' for > 1 hour

**Possible Causes:**
1. AI server not reachable from Forge app
2. Processing failed but status not updated
3. Network timeout

**Solutions:**
```sql
-- 1. Check if processing ever started
SELECT * FROM data_requests WHERE id = 'stuck-request-id';
-- If started_processing_at is NULL, processing never began

-- 2. Manually retry processing
-- (Requires manual intervention - call export/delete endpoint with requestId)

-- 3. Mark as failed
UPDATE data_requests 
SET status = 'failed', 
    error_message = 'Manual intervention - request timeout',
    completed_at = NOW()
WHERE id = 'stuck-request-id';
```

### Export Download Fails

**Symptoms:** Signed URL returns 404 or access denied

**Possible Causes:**
1. URL expired (> 24 hours)
2. File deleted from storage
3. Storage permissions issue

**Solutions:**
```sql
-- Check if file exists
SELECT * FROM storage.objects 
WHERE bucket_id = 'exports' 
AND name LIKE '%request-id%';

-- If file gone, can re-run export:
-- Delete old request record
DELETE FROM data_requests WHERE id = 'old-request-id';

-- Create new export request
-- (User must trigger new request)
```

### Deletion Not Complete

**Symptoms:** Some user data still exists after deletion

**Possible Causes:**
1. Foreign key constraint violation
2. Deletion order incorrect
3. Storage cleanup failed

**Investigation:**
```sql
-- Check what data remains
SELECT 'screenshots' as table_name, COUNT(*) FROM screenshots WHERE user_id = 'user-uuid'
UNION ALL
SELECT 'analysis_results', COUNT(*) FROM analysis_results WHERE user_id = 'user-uuid'
UNION ALL
SELECT 'activity_records', COUNT(*) FROM activity_records WHERE user_id = 'user-uuid'
-- ... repeat for all tables

-- Check audit log
SELECT * FROM activity_log 
WHERE event_type = 'user_data_deletion' 
AND event_data->>'atlassian_account_id_hash' LIKE '%hash%'
ORDER BY created_at DESC;
```

**Manual Cleanup (if needed):**
```sql
-- DO NOT run this in production without backup!
BEGIN;

DELETE FROM activity_records WHERE user_id = 'user-uuid';
DELETE FROM analysis_results WHERE user_id = 'user-uuid';
DELETE FROM screenshots WHERE user_id = 'user-uuid';
-- ... repeat for all tables
DELETE FROM users WHERE id = 'user-uuid';

COMMIT;
```

---

## Logs to Monitor

### Forge App Logs

```
[PersonalData] Request received: { accountId: ..., requestType: ... }
[PersonalData] Found existing request: { requestId: ..., status: ... }
[PersonalData] Creating new request
[PersonalData] Starting async processing: { requestId: ... }
[PersonalData] Async processing completed
[PersonalData] Async processing failed: Error: ...
```

### AI Server Logs

```
[UserData] Checking request status: { accountId: ..., requestType: ... }
[UserData] Created new request: { requestId: ..., requestType: ... }
[UserData] Starting export: { requestId: ..., accountId: ... }
[UserData] Export completed: { userId: ..., totalRecords: ... }
[UserData] Uploading export data: { requestId: ..., sizeKB: ... }
[UserData] Export data uploaded successfully
[UserData] Updated request status: { requestId: ..., status: 'completed' }
[UserData] Starting deletion: { requestId: ..., accountId: ... }
[UserData] Deleted storage files: { count: ..., userId: ... }
[UserData] Deletion completed: { userId: ..., totalRecordsDeleted: ..., filesDeleted: ... }
```

---

## Success Criteria

**Export Success:**
- [x] Request created (status = pending)
- [x] Export processing started (started_processing_at populated)
- [x] Export completed < 30 seconds for average user
- [x] Export completed < 5 minutes for power user
- [x] Signed URL generated
- [x] JSON download works
- [x] All tables included in export
- [x] Storage files have valid signed URLs
- [x] Signed URLs expire after 24 hours

**Deletion Success:**
- [x] Request created (status = pending)
- [x] Deletion processing started
- [x] Deletion completed < 10 seconds
- [x] User record deleted
- [x] All child records deleted (0 rows in all tables)
- [x] All storage files deleted
- [x] Audit log entry created
- [x] Activity log entries anonymized
- [x] Data cannot be recovered

---

## Next Steps After Testing

1. ✅ Verify all test scenarios pass
2. ✅ Document any edge cases found
3. ✅ Update implementation plan with findings
4. ✅ Prepare for production deployment
5. ✅ Update Privacy Policy
6. ✅ Train support team
7. ✅ Set up production monitoring
8. ✅ Deploy to production

---

**Happy Testing! 🚀**

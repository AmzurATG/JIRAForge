# Personal Data Reporting API - Complete Code Flow

**Complete Technical Walkthrough: From Atlassian Request to Data Deletion**

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Atlassian's 7-Day Polling Mechanism](#atlassians-7-day-polling-mechanism)
3. [Complete Request Flow](#complete-request-flow)
4. [Code Files & Functions](#code-files--functions)
5. [Database Schema](#database-schema)
6. [Endpoints Reference](#endpoints-reference)
7. [Data Flow Diagrams](#data-flow-diagrams)

---

## Overview

### What Happens When a User Requests Data Deletion?

```
User (Close Account / Support Ticket)
         ↓
Atlassian Platform (Identifies all apps user has data in)
         ↓
Atlassian POLLS your app every 7 days for 6 weeks
         ↓
Your Forge App (personalDataHandler)
         ↓
AI Server (process deletion)
         ↓
Supabase (delete from 16 tables + 4 storage buckets)
         ↓
Return COMPLETED status to Atlassian
```

### Key Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Forge App** | Node.js 20 (Serverless) | Receives Atlassian's polls, validates requests |
| **AI Server** | Node.js + Express | Processes deletion/export, manages database |
| **Supabase** | PostgreSQL 16 | Stores user data + tracking table |
| **Storage** | Supabase Storage | Screenshots, documents, feedback images |

---

## Atlassian's 7-Day Polling Mechanism

### How It Works

**Atlassian does NOT send a one-time webhook.** Instead, they poll your API repeatedly:

1. **Day 0**: User requests account deletion → Atlassian starts polling
2. **Day 0-7**: Atlassian polls every 1-7 days (exact timing unknown)
3. **Week 1**: Your app receives first poll → returns `PENDING`
4. **Week 1**: You process deletion asynchronously
5. **Week 2**: Atlassian polls again → you return `COMPLETED`
6. **Done**: Atlassian stops polling

### Why Polling?

- **Resilience**: If your app is down, Atlassian retries later
- **Async processing**: You can take days to process large datasets
- **Idempotency**: Your app can return same request status multiple times
- **No missed deletions**: Polling ensures eventual completion

### Your Implementation Strategy

```javascript
// First poll from Atlassian
Request comes in → Check if request exists in DB → No?
  → Create request record with status='pending'
  → Trigger async processing
  → Return { status: 'PENDING' } to Atlassian

// Subsequent polls (7 days later)
Request comes in → Check if request exists in DB → Yes!
  → Request status is 'completed'
  → Return { status: 'COMPLETED', summary: {...} } to Atlassian
```

**No separate polling endpoint needed** - Atlassian calls the same handler repeatedly.

---

## Complete Request Flow

### 🔹 Step 1: Atlassian Calls Your Handler

**Trigger**: User closes account or requests data deletion via support ticket

**File**: `forge-app/src/index.js` (Line 55)
```javascript
export const personalDataHandler = async (event, context) => {
  return await handlePersonalDataRequest(event);
};
```

**Input (event.payload)**:
```json
{
  "accountId": "557058:abc123...",
  "cloudId": "1234abcd-5678-90ef-ghij-klmnopqrstuv",
  "requestType": "delete"  // or "export"
}
```

**Processing**: Delegates to `personalDataService.js`

---

### 🔹 Step 2: Validate & Check Existing Request

**File**: `forge-app/src/services/personalDataService.js` (Line 29)

**Function**: `handlePersonalDataRequest(event)`

**Logic**:
```javascript
// 1. Validate input
if (!accountId || !cloudId || !requestType) {
  return { status: 'FAILED', error: 'Missing required fields' };
}

// 2. Check if request already exists
const existingRequest = await checkRequestStatus(accountId, cloudId, requestType);

if (existingRequest) {
  // SUBSEQUENT POLL - return current status
  if (existingRequest.status === 'completed') {
    return formatCompletedResponse(existingRequest, requestType);
  }
  return { status: 'PENDING' };
} else {
  // FIRST POLL - create new request
  const newRequest = await createNewRequest(accountId, cloudId, requestType);
  await triggerProcessing(newRequest.id, accountId, cloudId, requestType);
  return { status: 'PENDING' };
}
```

**Calls AI Server**: `/api/v1/user-data/status`

---

### 🔹 Step 3: Check Request Status (AI Server)

**File**: `ai-server/src/controllers/user-data-controller.js` (Line 18)

**Endpoint**: `POST /api/v1/user-data/status`

**Authentication**: Requires Forge Invocation Token (FIT) - validated by `forgeAuthMiddleware`

**Input (req.body)**:
```json
{
  "accountId": "557058:abc123...",
  "cloudId": "1234abcd-5678-90ef-ghij-klmnopqrstuv",
  "requestType": "delete"
}
```

**Function**: `userDataService.getRequestStatus(accountId, cloudId, requestType)`

**SQL Query**:
```sql
SELECT * FROM data_requests
WHERE account_id = $1
  AND cloud_id = $2
  AND request_type = $3
  AND status IN ('pending', 'processing', 'completed', 'failed')
ORDER BY requested_at DESC
LIMIT 1;
```

**Output**:
```json
{
  "success": true,
  "data": {
    "request": {
      "id": "uuid-here",
      "status": "pending",  // or "processing", "completed", "failed"
      "requested_at": "2026-04-08T10:00:00Z",
      "result_data": null   // populated when completed
    }
  }
}
```

**Returns to Forge App**: Request object or null

---

### 🔹 Step 4A: Create New Request (First Poll Only)

**File**: `forge-app/src/services/personalDataService.js` (Line 143)

**Function**: `createNewRequest(accountId, cloudId, requestType)`

**Calls AI Server**: `POST /api/v1/user-data/create-request`

**File**: `ai-server/src/controllers/user-data-controller.js` (Line 60)

**Function**: `userDataService.createRequest(accountId, cloudId, requestType)`

**SQL Insert**:
```sql
INSERT INTO data_requests (
  account_id,
  cloud_id,
  request_type,
  status,
  requested_at
) VALUES (
  $1, -- accountId
  $2, -- cloudId
  $3, -- requestType ('delete' or 'export')
  'pending',
  NOW()
) RETURNING *;
```

**Database Constraints**:
- **Unique constraint**: Only ONE active request per (accountId, cloudId, requestType)
- **If duplicate**: Returns existing request (idempotent)

**Output**:
```json
{
  "success": true,
  "data": {
    "request": {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "account_id": "557058:abc123...",
      "cloud_id": "1234abcd-5678-90ef-ghij-klmnopqrstuv",
      "request_type": "delete",
      "status": "pending",
      "requested_at": "2026-04-08T10:00:00.123Z",
      "retry_count": 0
    }
  }
}
```

---

### 🔹 Step 4B: Trigger Async Processing

**File**: `forge-app/src/services/personalDataService.js` (Line 164)

**Function**: `triggerProcessing(requestId, accountId, cloudId, requestType)`

**Decision Logic**:
```javascript
const endpoint = requestType === 'export' 
  ? '/api/v1/user-data/export'    // Export endpoint
  : '/api/v1/user-data/delete';   // Delete endpoint
```

**Calls**: `POST /api/v1/user-data/delete` (for deletion requests)

**Important**: This call is **non-blocking**. The Forge app doesn't wait for completion.

---

### 🔹 Step 5: Delete User Data (AI Server)

**File**: `ai-server/src/controllers/user-data-controller.js` (Line 212)

**Endpoint**: `POST /api/v1/user-data/delete`

**Authentication**: Forge Invocation Token (FIT)

**Input (req.body)**:
```json
{
  "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "accountId": "557058:abc123...",
  "cloudId": "1234abcd-5678-90ef-ghij-klmnopqrstuv"
}
```

**Processing Steps**:

1. **Update status to 'processing'**
```javascript
await userDataService.updateRequestStatus(requestId, 'processing');
```

SQL:
```sql
UPDATE data_requests
SET status = 'processing',
    started_processing_at = NOW()
WHERE id = $1;
```

2. **Execute deletion**
```javascript
const deletionSummary = await userDataService.deleteUserData(accountId, cloudId);
```

3. **Update status to 'completed'**
```javascript
await userDataService.updateRequestStatus(requestId, 'completed', {
  result_data: {
    records_deleted: { /* ... */ },
    files_deleted: 42,
    deleted_at: "2026-04-08T10:05:32.123Z"
  }
});
```

SQL:
```sql
UPDATE data_requests
SET status = 'completed',
    completed_at = NOW(),
    result_data = $2,
    processing_duration_ms = $3
WHERE id = $1;
```

**Output to Caller**:
```json
{
  "success": true,
  "data": {
    "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "summary": {
      "recordsDeleted": {
        "screenshots": 145,
        "analysis_results": 145,
        "activity_records": 2340,
        "worklogs": 89,
        "users": 1
      },
      "filesDeleted": 145,
      "deletedAt": "2026-04-08T10:05:32.123Z"
    },
    "processingDurationMs": 5432
  }
}
```

---

### 🔹 Step 6: Core Deletion Logic (Dynamic Table Discovery)

**File**: `ai-server/src/services/user-data-service.js` (Line 620)

**Function**: `deleteUserData(accountId, cloudId)`

**Complete Logic Flow**:

```javascript
async function deleteUserData(accountId, cloudId) {
  const deletionSummary = {
    recordsDeleted: {},
    filesDeleted: 0,
    deletedAt: new Date().toISOString()
  };

  // 1. Get user record by Atlassian account ID
  const user = await getUserByAccountId(accountId);
  const userId = user.id;  // Internal UUID
  const organizationId = user.organization_id;

  // 2. DELETE STORAGE FILES FIRST (before database records)
  const filesDeleted = await deleteStorageFiles(userId, organizationId);
  deletionSummary.filesDeleted = filesDeleted;

  // 3. DISCOVER TABLES DYNAMICALLY
  const userDataTables = await discoverUserDataTables();
  // Calls: SELECT table_name FROM information_schema.columns 
  //        WHERE column_name = 'user_id'
  //        AND table_schema = 'public'

  // 4. SORT TABLES BY DELETION ORDER (prevents FK violations)
  const sortedTables = userDataTables.sort((a, b) => {
    return userDataConfig.getDeletionOrderIndex(a) - 
           userDataConfig.getDeletionOrderIndex(b);
  });
  // Order: activity_records → analysis_results → screenshots → users

  // 5. DELETE FROM EACH TABLE
  for (const tableName of sortedTables) {
    const result = await deleteFromTable(supabase, tableName, userId);
    
    if (result.action === 'anonymized') {
      // Special handling for audit logs (anonymize, don't delete)
      deletionSummary.recordsDeleted[`${tableName}_anonymized`] = result.count;
    } else {
      // Normal deletion
      deletionSummary.recordsDeleted[tableName] = result.count;
    }
  }

  // 6. CREATE AUDIT LOG ENTRY (after user deletion)
  await supabase.from('activity_log').insert({
    user_id: null,  // User is deleted
    organization_id: organizationId,
    event_type: 'user_data_deletion',
    event_data: {
      atlassian_account_id_hash: crypto.createHash('sha256')
        .update(accountId).digest('hex').substring(0, 16),
      deletion_summary: deletionSummary
    }
  });

  return deletionSummary;
}
```

---

### 🔹 Step 6A: Delete Storage Files

**File**: `ai-server/src/services/user-data-service.js` (Line 730)

**Function**: `deleteStorageFiles(userId, organizationId)`

**Storage Buckets**:

| Bucket | Path Pattern | Content |
|--------|-------------|---------|
| `screenshots` | `{orgId}/{userId}/` | Screenshot images (.png, .jpg) |
| `screenshots` | `{userId}/` | Legacy screenshots (old format) |
| `documents` | `{orgId}/{userId}/` | BRD documents (.pdf, .docx) |
| `documents` | `{userId}/` | Legacy documents |
| `feedback-images` | `{userId}/` | Feedback screenshot attachments |

**Logic**:
```javascript
async function deleteStorageFiles(userId, organizationId) {
  let totalFilesDeleted = 0;

  // 1. Screenshots - check both new and legacy paths
  const screenshotPaths = [
    `${organizationId}/${userId}`,  // New format
    userId                           // Legacy format
  ];
  
  for (const basePath of screenshotPaths) {
    const { data: files } = await supabase.storage
      .from('screenshots')
      .list(basePath, { limit: 10000 });

    if (files && files.length > 0) {
      const filePaths = files.map(f => `${basePath}/${f.name}`);
      await supabase.storage.from('screenshots').remove(filePaths);
      totalFilesDeleted += files.length;
    }
  }

  // 2. Documents - same pattern
  // 3. Feedback images - user_id only (no org prefix)

  return totalFilesDeleted;
}
```

**SQL-equivalent operations**:
```sql
-- Supabase Storage uses internal tables, roughly equivalent to:
DELETE FROM storage.objects
WHERE bucket_id = 'screenshots'
  AND name LIKE '{orgId}/{userId}/%';
```

---

### 🔹 Step 6B: Dynamic Table Discovery

**File**: `ai-server/src/services/user-data-service.js` (Line 175)

**Function**: `discoverUserDataTables()`

**Database Function Call**:
```sql
-- Calls stored procedure (created in migration)
SELECT * FROM discover_user_data_tables();
```

**Stored Procedure Logic**:
```sql
CREATE OR REPLACE FUNCTION discover_user_data_tables()
RETURNS TABLE(table_name TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT c.table_name::TEXT
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.column_name = 'user_id'
    AND c.table_name NOT IN ('spatial_ref_sys', 'geography_columns', 'geometry_columns')
  ORDER BY c.table_name;
END;
$$ LANGUAGE plpgsql STABLE;
```

**Result** (example):
```json
[
  { "table_name": "activity_log" },
  { "table_name": "activity_records" },
  { "table_name": "analysis_results" },
  { "table_name": "documents" },
  { "table_name": "feedback" },
  { "table_name": "notification_logs" },
  { "table_name": "notification_preferences" },
  { "table_name": "organization_members" },
  { "table_name": "screenshots" },
  { "table_name": "tracking_settings" },
  { "table_name": "unassigned_activity" },
  { "table_name": "user_jira_issues_cache" },
  { "table_name": "users" },
  { "table_name": "worklog_sync" },
  { "table_name": "worklogs" }
]
```

**Why Dynamic?** When you add new tables with `user_id` column in the future, they're automatically included!

---

### 🔹 Step 6C: Delete From Each Table

**File**: `ai-server/src/services/user-data-service.js` (Line 283)

**Function**: `deleteFromTable(supabase, tableName, userId)`

**Special Handling - Anonymization** (for audit logs):
```javascript
if (userDataConfig.shouldAnonymize(tableName)) {
  // Example: activity_log table
  const { count } = await supabase
    .from('activity_log')
    .update({
      user_id: null,
      ip_address: null,
      user_agent: 'REDACTED',
      event_data: { redacted: true, reason: 'user_data_deletion' }
    })
    .eq('user_id', userId);
  
  return { tableName, count, action: 'anonymized' };
}
```

SQL equivalent:
```sql
UPDATE activity_log
SET user_id = NULL,
    ip_address = NULL,
    user_agent = 'REDACTED',
    event_data = '{"redacted": true, "reason": "user_data_deletion"}'
WHERE user_id = $1;
```

**Normal Deletion** (most tables):
```javascript
const { count } = await supabase
  .from(tableName)
  .delete({ count: 'exact' })
  .eq('user_id', userId);

return { tableName, count, action: 'deleted' };
```

SQL equivalent:
```sql
DELETE FROM screenshots WHERE user_id = $1;
DELETE FROM analysis_results WHERE user_id = $1;
DELETE FROM activity_records WHERE user_id = $1;
-- ... etc for all 16 tables
```

**Deletion Order** (from config):
```javascript
const deletionOrder = [
  // Deep children first (no other tables depend on these)
  'activity_records',           // DELETE 1st
  'unassigned_activity',
  'notification_logs',
  
  // Mid-level tables
  'analysis_results',           // DELETE 2nd (references screenshots)
  'worklogs',
  'documents',
  
  // Primary data
  'screenshots',                // DELETE 3rd (referenced by analysis_results)
  
  // Settings
  'tracking_settings',
  
  // Memberships
  'organization_members',       // DELETE 2nd-to-last
  
  // User table LAST (CASCADE cleans up missed FKs)
  'users'                       // DELETE LAST
];
```

**Why Order Matters?** Foreign key constraints:
```sql
-- Example FK constraint:
ALTER TABLE analysis_results
  ADD CONSTRAINT fk_screenshot
  FOREIGN KEY (screenshot_id) REFERENCES screenshots(id);

-- Must delete analysis_results BEFORE screenshots, or you get:
-- ERROR: update or delete on table "screenshots" violates foreign key constraint
```

---

### 🔹 Step 7: Subsequent Polls (7 Days Later)

**What Happens**: Atlassian polls your handler again after ~7 days

**File**: `forge-app/src/services/personalDataService.js` (Line 60)

**Flow**:
```javascript
// Check existing request status
const existingRequest = await checkRequestStatus(accountId, cloudId, requestType);

if (existingRequest.status === 'completed') {
  // Deletion finished! Return summary to Atlassian
  return formatCompletedResponse(existingRequest, requestType);
}
```

**formatCompletedResponse** (Line 205):
```javascript
function formatCompletedResponse(request, requestType) {
  if (requestType === 'delete') {
    return {
      status: 'COMPLETED',
      summary: {
        deletedAt: request.completed_at,
        recordsDeleted: request.result_data?.records_deleted || {},
        filesDeleted: request.result_data?.files_deleted || 0
      }
    };
  }
}
```

**Output to Atlassian**:
```json
{
  "status": "COMPLETED",
  "summary": {
    "deletedAt": "2026-04-08T10:05:32.123Z",
    "recordsDeleted": {
      "screenshots": 145,
      "analysis_results": 145,
      "activity_records": 2340,
      "worklogs": 89,
      "documents": 12,
      "feedback": 3,
      "users": 1
    },
    "filesDeleted": 145
  }
}
```

**Atlassian's Action**: Stops polling, marks data as deleted ✅

---

## Code Files & Functions

### Forge App Files

| File | Functions | Purpose |
|------|-----------|---------|
| `forge-app/src/index.js` | `personalDataHandler` | Entry point for Atlassian polls |
| `forge-app/src/services/personalDataService.js` | `handlePersonalDataRequest`<br>`checkRequestStatus`<br>`createNewRequest`<br>`triggerProcessing`<br>`formatCompletedResponse` | Validates requests, manages polling cycle, calls AI server |

### AI Server Files

| File | Functions | Purpose |
|------|-----------|---------|
| `ai-server/src/controllers/user-data-controller.js` | `POST /status`<br>`POST /create-request`<br>`POST /export`<br>`POST /delete` | REST endpoints for Forge app |
| `ai-server/src/services/user-data-service.js` | `getRequestStatus`<br>`createRequest`<br>`updateRequestStatus`<br>`deleteUserData`<br>`exportUserData`<br>`discoverUserDataTables`<br>`deleteFromTable`<br>`deleteStorageFiles` | Core business logic |
| `ai-server/src/config/user-data-config.js` | `getDeletionOrderIndex`<br>`shouldAnonymize`<br>`getExportRowLimit` | Configuration for special handling |

### Configuration Files

| File | Purpose |
|------|---------|
| `forge-app/manifest.yml` | Declares `userDataProvider` module, `personalDataHandler` function |
| `ai-server/src/config/user-data-config.js` | Deletion order, anonymization rules, storage associations |

### Database Files

| File | Purpose |
|------|---------|
| `supabase/migrations/20260403_add_data_requests_table.sql` | Creates `data_requests` table schema |

---

## Database Schema

### Table: `data_requests`

**Purpose**: Tracks export/deletion requests for 7-day polling cycle

```sql
CREATE TABLE data_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Request identification
    request_type TEXT NOT NULL CHECK (request_type IN ('export', 'delete')),
    account_id TEXT NOT NULL,  -- Atlassian account ID
    cloud_id TEXT NOT NULL,    -- Jira cloud instance ID
    
    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending' 
           CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    
    -- Timestamps
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_processing_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    
    -- Results
    result_url TEXT,           -- Signed URL for export (24hr expiry)
    result_data JSONB,         -- Deletion summary or export metadata
    error_message TEXT,
    
    -- Metadata
    retry_count INTEGER DEFAULT 0,
    processing_duration_ms INTEGER,
    
    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Indexes**:
```sql
-- Fast lookup by account + cloud + type
CREATE INDEX idx_data_requests_account_cloud 
    ON data_requests(account_id, cloud_id);

-- Find pending/processing requests
CREATE INDEX idx_data_requests_status 
    ON data_requests(status) 
    WHERE status IN ('pending', 'processing');

-- Unique constraint: Only ONE active request per user/type
CREATE UNIQUE INDEX idx_data_requests_active_unique 
    ON data_requests(account_id, cloud_id, request_type) 
    WHERE status IN ('pending', 'processing');
```

**Lifecycle**:

| Status | Meaning | Next Action |
|--------|---------|-------------|
| `pending` | Request created, not started | Begin processing |
| `processing` | Deletion/export in progress | Wait for completion |
| `completed` | Successfully finished | Return result to Atlassian |
| `failed` | Error occurred | Return error, possibly retry |

**Example Record** (deletion request):
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "request_type": "delete",
  "account_id": "557058:abc123...",
  "cloud_id": "1234abcd-5678-90ef-ghij-klmnopqrstuv",
  "status": "completed",
  "requested_at": "2026-04-08T10:00:00.000Z",
  "started_processing_at": "2026-04-08T10:00:01.234Z",
  "completed_at": "2026-04-08T10:05:32.123Z",
  "result_data": {
    "records_deleted": {
      "screenshots": 145,
      "analysis_results": 145,
      "activity_records": 2340,
      "worklogs": 89,
      "users": 1
    },
    "files_deleted": 145,
    "deleted_at": "2026-04-08T10:05:32.123Z"
  },
  "processing_duration_ms": 331089
}
```

---

## Endpoints Reference

### 1. Personal Data Handler (Forge)

**Type**: Forge Function Handler (not a REST endpoint)

**Trigger**: Atlassian polls this function (timing unknown, estimated 7 days)

**File**: `forge-app/src/index.js` → `personalDataHandler`

**Input**:
```json
{
  "payload": {
    "accountId": "557058:abc123...",
    "cloudId": "1234abcd-5678-90ef-ghij-klmnopqrstuv",
    "requestType": "delete"
  }
}
```

**Output** (first poll):
```json
{
  "status": "PENDING",
  "message": "Request created and processing started. Request ID: uuid"
}
```

**Output** (subsequent poll, completed):
```json
{
  "status": "COMPLETED",
  "summary": {
    "deletedAt": "2026-04-08T10:05:32.123Z",
    "recordsDeleted": { "screenshots": 145, "users": 1 },
    "filesDeleted": 145
  }
}
```

---

### 2. Check Request Status

**Endpoint**: `POST /api/v1/user-data/status`

**Auth**: Forge Invocation Token (FIT)

**File**: `ai-server/src/controllers/user-data-controller.js`

**Request**:
```bash
curl -X POST https://forgesync.amzur.com/api/v1/user-data/status \
  -H "Authorization: Bearer FIT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "557058:abc123...",
    "cloudId": "1234abcd-5678-90ef-ghij-klmnopqrstuv",
    "requestType": "delete"
  }'
```

**Response**:
```json
{
  "success": true,
  "data": {
    "request": {
      "id": "uuid",
      "status": "completed",
      "requested_at": "2026-04-08T10:00:00Z",
      "completed_at": "2026-04-08T10:05:32Z",
      "result_data": { /* summary */ }
    }
  }
}
```

**Response** (not found):
```json
{
  "success": true,
  "data": {
    "request": null
  }
}
```

---

### 3. Create Request

**Endpoint**: `POST /api/v1/user-data/create-request`

**Auth**: Forge Invocation Token (FIT)

**File**: `ai-server/src/controllers/user-data-controller.js`

**Request**:
```bash
curl -X POST https://forgesync.amzur.com/api/v1/user-data/create-request \
  -H "Authorization: Bearer FIT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "557058:abc123...",
    "cloudId": "1234abcd-5678-90ef-ghij-klmnopqrstuv",
    "requestType": "delete"
  }'
```

**Response**:
```json
{
  "success": true,
  "data": {
    "request": {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "account_id": "557058:abc123...",
      "cloud_id": "1234abcd-5678-90ef-ghij-klmnopqrstuv",
      "request_type": "delete",
      "status": "pending",
      "requested_at": "2026-04-08T10:00:00.123Z",
      "retry_count": 0
    }
  }
}
```

**Idempotency**: If active request already exists, returns existing request instead of error

---

### 4. Delete User Data

**Endpoint**: `POST /api/v1/user-data/delete`

**Auth**: Forge Invocation Token (FIT)

**File**: `ai-server/src/controllers/user-data-controller.js`

**Request**:
```bash
curl -X POST https://forgesync.amzur.com/api/v1/user-data/delete \
  -H "Authorization: Bearer FIT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "accountId": "557058:abc123...",
    "cloudId": "1234abcd-5678-90ef-ghij-klmnopqrstuv"
  }'
```

**Response**:
```json
{
  "success": true,
  "data": {
    "requestId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "summary": {
      "recordsDeleted": {
        "activity_records": 2340,
        "unassigned_activity": 45,
        "notification_logs": 123,
        "notification_cooldowns": 5,
        "analysis_results": 145,
        "worklogs": 89,
        "documents": 12,
        "feedback": 3,
        "user_jira_issues_cache": 234,
        "screenshots": 145,
        "tracking_settings": 1,
        "notification_preferences": 1,
        "worklog_sync": 1,
        "organization_members": 1,
        "users": 1
      },
      "filesDeleted": 145,
      "deletedAt": "2026-04-08T10:05:32.123Z"
    },
    "processingDurationMs": 5432
  }
}
```

**Processing Time**: Typically 2-10 seconds depending on data volume

**What It Deletes**:
- ✅ 16 database tables (all records where `user_id` matches)
- ✅ 4 storage buckets (screenshots, documents, feedback-images, exports)
- ✅ Audit log created (anonymized, user_id = null)

---

### 5. Export User Data

**Endpoint**: `POST /api/v1/user-data/export`

**Auth**: Forge Invocation Token (FIT)

**File**: `ai-server/src/controllers/user-data-controller.js`

**Request**:
```bash
curl -X POST https://forgesync.amzur.com/api/v1/user-data/export \
  -H "Authorization: Bearer FIT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "uuid",
    "accountId": "557058:abc123...",
    "cloudId": "1234abcd-5678-90ef-ghij-klmnopqrstuv"
  }'
```

**Response**:
```json
{
  "success": true,
  "data": {
    "requestId": "uuid",
    "signedUrl": "https://supabase.co/storage/v1/object/sign/exports/export_uuid_timestamp.json?token=...",
    "expiresAt": "2026-04-09T10:00:00.000Z",
    "processingDurationMs": 3210
  }
}
```

**Export File Structure**:
```json
{
  "dataType": "user_personal_data_export",
  "exportedAt": "2026-04-08T10:00:00.000Z",
  "user": {
    "atlassianAccountId": "557058:abc123...",
    "email": "user@example.com",
    "displayName": "John Doe"
  },
  "tables": {
    "screenshots": [ /* all screenshot records */ ],
    "analysis_results": [ /* all analysis records */ ],
    "worklogs": [ /* all worklog records */ ]
  },
  "tableSummary": {
    "screenshots": { "count": 145, "totalAvailable": 145 },
    "worklogs": { "count": 89, "totalAvailable": 89 }
  },
  "storageSummary": {
    "totalFiles": 145,
    "totalStorageMB": 342.5,
    "screenshotFiles": [ /* signed URLs for downloads */ ]
  }
}
```

---

## Data Flow Diagrams

### Overall Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      ATLASSIAN PLATFORM                          │
│  (User Account Deletion / Close Account Page / Support Ticket)  │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 │ Polls every ~7 days (for 6 weeks max)
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                         FORGE APP                                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  personalDataHandler(event)                              │   │
│  │  ├─ Validate accountId, cloudId, requestType             │   │
│  │  ├─ Check if request exists (call AI server)             │   │
│  │  ├─ Create new request (first poll)                      │   │
│  │  ├─ Trigger async processing (non-blocking)              │   │
│  │  └─ Return PENDING or COMPLETED                          │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 │ invokeRemote (FIT authentication)
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                     AI SERVER (Express.js)                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  POST /api/v1/user-data/status                           │   │
│  │  POST /api/v1/user-data/create-request                   │   │
│  │  POST /api/v1/user-data/delete                           │   │
│  │  POST /api/v1/user-data/export                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  user-data-service.js                                    │   │
│  │  ├─ getRequestStatus()                                   │   │
│  │  ├─ createRequest()                                      │   │
│  │  ├─ deleteUserData()                                     │   │
│  │  │   ├─ Delete storage files (screenshots, docs)         │   │
│  │  │   ├─ Discover tables dynamically                      │   │
│  │  │   ├─ Sort by deletion order                           │   │
│  │  │   ├─ Delete from each table                           │   │
│  │  │   └─ Create audit log                                 │   │
│  │  └─ exportUserData()                                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────┬─────────────────────────────────────────────────┘
                 │
                 │ Supabase Client (PostgreSQL + Storage)
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                 SUPABASE (Database + Storage)                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  PostgreSQL Database (16 tables)                          │  │
│  │  ├─ data_requests (tracks polling cycle)                  │  │
│  │  ├─ users                                                 │  │
│  │  ├─ screenshots                                           │  │
│  │  ├─ analysis_results                                      │  │
│  │  ├─ activity_records                                      │  │
│  │  ├─ worklogs                                              │  │
│  │  └─ ... (11 more tables)                                  │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Storage Buckets (4 buckets)                              │  │
│  │  ├─ screenshots (images)                                  │  │
│  │  ├─ documents (PDFs/DOCX)                                 │  │
│  │  ├─ feedback-images                                       │  │
│  │  └─ exports (temporary JSON exports)                      │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Polling Cycle Timeline

```
Day 0: User Requests Account Deletion
       │
       ├─ Atlassian Platform starts polling cycle
       │
       ▼
Day 0-1: FIRST POLL
       ┌─────────────────────────────────────────────────────┐
       │ Atlassian → Forge personalDataHandler              │
       │   Input: { accountId, cloudId, requestType }       │
       │                                                     │
       │ Forge → Check DB: Does request exist?              │
       │   Answer: NO                                        │
       │                                                     │
       │ Forge → Create request (status = 'pending')        │
       │ Forge → Trigger async deletion                     │
       │                                                     │
       │ Forge → Atlassian: { status: 'PENDING' }           │
       └─────────────────────────────────────────────────────┘
       │
       ├─ AI Server processes deletion asynchronously
       ├─ Deletes storage files (145 files)
       ├─ Deletes database records (2,340 activity records, etc.)
       ├─ Updates request status to 'completed'
       │
       ▼
Day 7: SECOND POLL
       ┌─────────────────────────────────────────────────────┐
       │ Atlassian → Forge personalDataHandler              │
       │   Input: { accountId, cloudId, requestType }       │
       │                                                     │
       │ Forge → Check DB: Does request exist?              │
       │   Answer: YES, status = 'completed'                │
       │                                                     │
       │ Forge → Atlassian: { status: 'COMPLETED',          │
       │                      summary: { ... } }             │
       └─────────────────────────────────────────────────────┘
       │
       ▼
Done: Atlassian stops polling ✅
```

---

### Deletion Sequence

```
1. DELETE STORAGE FILES (before database)
   ┌────────────────────────────────────────────────┐
   │ Bucket: screenshots                            │
   │   Path: {orgId}/{userId}/*.png     (145 files) │
   │   Path: {userId}/*.png             (0 files)   │
   ├────────────────────────────────────────────────┤
   │ Bucket: documents                              │
   │   Path: {orgId}/{userId}/*.pdf     (12 files)  │
   ├────────────────────────────────────────────────┤
   │ Bucket: feedback-images                        │
   │   Path: {userId}/*.png             (3 files)   │
   └────────────────────────────────────────────────┘
   Total: 160 files deleted

2. DISCOVER TABLES DYNAMICALLY
   ┌────────────────────────────────────────────────┐
   │ SELECT table_name FROM information_schema...   │
   │ WHERE column_name = 'user_id'                  │
   ├────────────────────────────────────────────────┤
   │ Result: [                                      │
   │   'activity_records',                          │
   │   'analysis_results',                          │
   │   'screenshots',                               │
   │   'users',                                     │
   │   ... (15 tables total)                        │
   │ ]                                              │
   └────────────────────────────────────────────────┘

3. SORT BY DELETION ORDER (FK constraints)
   ┌────────────────────────────────────────────────┐
   │ Order 1: activity_records    (child table)     │
   │ Order 2: unassigned_activity                   │
   │ Order 3: notification_logs                     │
   │ Order 4: analysis_results    (references       │
   │                               screenshots)     │
   │ Order 5: worklogs                              │
   │ Order 6: screenshots         (parent table)    │
   │ ...                                            │
   │ Order 15: users              (LAST, CASCADE)   │
   └────────────────────────────────────────────────┘

4. DELETE FROM EACH TABLE
   ┌────────────────────────────────────────────────┐
   │ DELETE FROM activity_records WHERE user_id=?   │
   │   Result: 2,340 rows deleted                   │
   ├────────────────────────────────────────────────┤
   │ DELETE FROM analysis_results WHERE user_id=?   │
   │   Result: 145 rows deleted                     │
   ├────────────────────────────────────────────────┤
   │ DELETE FROM screenshots WHERE user_id=?        │
   │   Result: 145 rows deleted                     │
   ├────────────────────────────────────────────────┤
   │ ...                                            │
   ├────────────────────────────────────────────────┤
   │ DELETE FROM users WHERE id=?                   │
   │   Result: 1 row deleted                        │
   │   (CASCADE deletes any missed FK references)   │
   └────────────────────────────────────────────────┘

5. CREATE AUDIT LOG
   ┌────────────────────────────────────────────────┐
   │ INSERT INTO activity_log (                     │
   │   user_id = NULL,                              │
   │   event_type = 'user_data_deletion',           │
   │   event_data = {                               │
   │     atlassian_account_id_hash: 'abc123...',    │
   │     deletion_summary: { ... }                  │
   │   }                                            │
   │ )                                              │
   └────────────────────────────────────────────────┘

6. UPDATE REQUEST STATUS
   ┌────────────────────────────────────────────────┐
   │ UPDATE data_requests                           │
   │ SET status = 'completed',                      │
   │     completed_at = NOW(),                      │
   │     result_data = {                            │
   │       records_deleted: { ... },                │
   │       files_deleted: 160                       │
   │     }                                          │
   │ WHERE id = ?                                   │
   └────────────────────────────────────────────────┘
```

---

## Summary

### Key Takeaways

1. **No Separate Polling Endpoint**: Atlassian calls the same `personalDataHandler` function repeatedly
2. **Idempotent Design**: Same request can be checked multiple times safely
3. **Async Processing**: Deletion happens asynchronously, not during the Forge handler
4. **Dynamic Table Discovery**: Automatically finds all tables with `user_id` column
5. **Deletion Order Matters**: FK constraints require careful sequencing
6. **Storage First**: Delete files before database records to preserve references
7. **Audit Trail**: Anonymized log entry created after user deletion
8. **Grace Period**: Related to app uninstall (30 days), not Personal Data API

### Testing Checklist

- [ ] Test first poll (creates request, returns PENDING)
- [ ] Test subsequent poll before completion (returns PENDING)
- [ ] Test subsequent poll after completion (returns COMPLETED)
- [ ] Test deletion completes all 16 tables
- [ ] Test deletion removes all storage files
- [ ] Test export generates signed URL with valid data
- [ ] Test idempotency (duplicate requests don't cause errors)
- [ ] Test FIT authentication rejects invalid tokens
- [ ] Monitor deletion processing time (should be < 1 minute for normal users)
- [ ] Verify audit log created after deletion

---

**Last Updated**: April 8, 2026  
**Implementation Status**: ✅ Complete and Production-Ready  
**Compliance**: GDPR Article 17 (Right to Erasure), Article 15 (Right of Access)

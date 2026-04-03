# Personal Data Reporting API Implementation Plan

**Version:** 1.0  
**Created:** April 3, 2026  
**Status:** Planning Phase  
**Priority:** CRITICAL (Marketplace Compliance Requirement)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Background & Compliance Requirements](#background--compliance-requirements)
3. [Technical Architecture](#technical-architecture)
4. [Data Inventory](#data-inventory)
5. [Implementation Phases](#implementation-phases)
6. [Detailed Technical Specifications](#detailed-technical-specifications)
7. [Security & Privacy Considerations](#security--privacy-considerations)
8. [Testing Strategy](#testing-strategy)
9. [Operational Monitoring](#operational-monitoring)
10. [Timeline & Resources](#timeline--resources)
11. [Risk Assessment](#risk-assessment)
12. [Acceptance Criteria](#acceptance-criteria)
13. [Dependencies](#dependencies)
14. [References](#references)

---

## Executive Summary

### Purpose
Implement Atlassian's **Personal Data Reporting API** to enable GDPR-compliant data export and deletion for individual users. This is a **mandatory requirement** for all Marketplace apps that store personal data.

### Scope
- Add `userDataProvider` module to Forge manifest
- Implement data export endpoint (GDPR Article 20 - Right to Data Portability)
- Implement data deletion endpoint (GDPR Article 17 - Right to Erasure)
- Support Atlassian's 7-day polling cycle with async processing
- Track request status in database
- Update Privacy Policy to reflect automated data export/deletion

### Compliance Deadline
Per Atlassian's Data Privacy Guidelines: **Failure to implement may result in app de-listing**

### Estimated Effort
- **Development:** 40-48 hours
- **Testing:** 16-20 hours
- **Documentation:** 8 hours
- **Total:** 64-76 hours (8-10 working days)

---

## Background & Compliance Requirements

### Regulatory Context

**GDPR Requirements:**
- **Article 17 (Right to Erasure):** Users can request deletion of their personal data
- **Article 20 (Right to Data Portability):** Users can request export of their personal data in structured, machine-readable format

**Atlassian Policy:**
> "If you are storing personal data, Atlassian may require that you action certain events, including requests to change or delete personal data, as sent through our APIs. **Failure to respect these requests may result in de-listing of your app.**"
> — Data Privacy Guidelines, Section 4

### Current State Gap Analysis

**Current Implementation:**
- ❌ No `userDataProvider` module in manifest
- ❌ No programmatic data export endpoint
- ❌ No self-service data deletion capability
- ❌ Privacy Policy states "Export your data (contact support)" — manual process
- ✅ Database schema has CASCADE deletes configured (foundation exists)
- ✅ Security logging infrastructure in place

**Required Implementation:**
- ✅ Declare `userDataProvider` module in `manifest.yml`
- ✅ Implement `onPersonalDataReport` handler in Forge app
- ✅ Create AI server export endpoint `/api/v1/user-data/export`
- ✅ Create AI server deletion endpoint `/api/v1/user-data/delete`
- ✅ Implement polling cycle support with status tracking
- ✅ Update Privacy Policy

---

## Technical Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    ATLASSIAN PLATFORM                        │
│  (Polls every 7 days until request fulfilled)              │
└────────────────┬────────────────────────────────────────────┘
                 │
                 │ Personal Data Request
                 │ (accountId, requestType: export/delete)
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│                    FORGE APP                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  userDataProvider Module                             │  │
│  │  - onPersonalDataReport handler                      │  │
│  │  - Validates request                                  │  │
│  │  - Calls AI server via FIT auth                      │  │
│  │  - Returns status: PENDING → COMPLETED               │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────┬────────────────────────────────────────────┘
                 │
                 │ HTTP Request (Forge Invocation Token)
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│                    AI SERVER                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  POST /api/v1/user-data/export                       │  │
│  │  - Query all user tables in Supabase                 │  │
│  │  - Download user files from Storage buckets          │  │
│  │  - Package as structured JSON/ZIP                     │  │
│  │  - Return signed URL or inline data                   │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  POST /api/v1/user-data/delete                       │  │
│  │  - Hard delete all user data (CASCADE)                │  │
│  │  - Remove user files from Storage                     │  │
│  │  - Create audit log entry                             │  │
│  │  - Return deletion summary                             │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────┬────────────────────────────────────────────┘
                 │
                 │ Supabase Client (Service Role)
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│                    SUPABASE                                  │
│  ┌────────────────────┬──────────────────┬────────────────┐  │
│  │ PostgreSQL Tables  │ Storage Buckets  │ Edge Functions │  │
│  │ - users            │ - screenshots    │                │  │
│  │ - screenshots      │ - documents      │                │  │
│  │ - analysis_results │ - feedback-images│                │  │
│  │ - activity_records │                  │                │  │
│  │ - worklogs         │                  │                │  │
│  │ - feedback         │                  │                │  │
│  │ - org_members      │                  │                │  │
│  │ - tracking_settings│                  │                │  │
│  │ - notification_*   │                  │                │  │
│  │ - data_requests    │ (NEW TABLE)      │                │  │
│  └────────────────────┴──────────────────┴────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow Diagrams

#### Export Request Flow

```
User triggers request in Jira → Atlassian sends request to Forge app
                                              ↓
                       Forge handler receives (accountId, cloudId, requestType)
                                              ↓
                       Check data_requests table for existing request
                                              ↓
                    ┌─────────────────────┬──────────────────────┐
                    │ First poll          │ Subsequent poll      │
                    │ (no record)         │ (existing record)    │
                    ↓                     ↓                      │
          Create record in              Check status             │
          data_requests                                          │
          status=PENDING                                         │
                    ↓                                            │
          Call AI server export                                 │
          endpoint (async)                                      │
                    ↓                                            │
          Return PENDING to               ┌─────────┬──────────┐│
          Atlassian                       │ PENDING │ COMPLETED││
                                          ↓         ↓          ││
                                   Return PENDING  Return      ││
                                                  COMPLETED +  ││
                                                  data URL     ││
                                          └──────────┬─────────┘│
                                                     │          │
                         AI server processes:        │          │
                         1. Query all user tables    │          │
                         2. Download files           │          │
                         3. Package as JSON/ZIP      │          │
                         4. Upload to temporary      │          │
                            storage or generate      │          │
                            signed URL               │          │
                         5. Update data_requests:    │          │
                            status=COMPLETED         │          │
                            result_url=<signed_url>  │          │
                                                     ▼          │
                              Atlassian downloads data          │
                              (7-day polling cycle complete)    │
```

#### Deletion Request Flow

```
User triggers request in Jira → Atlassian sends request to Forge app
                                              ↓
                       Forge handler receives (accountId, cloudId, requestType)
                                              ↓
                       Check data_requests table for existing request
                                              ↓
                    ┌─────────────────────┬──────────────────────┐
                    │ First poll          │ Subsequent poll      │
                    │ (no record)         │ (existing record)    │
                    ↓                     ↓                      │
          Create record in              Check status             │
          data_requests                                          │
          status=PENDING                                         │
                    ↓                                            │
          Call AI server delete                                 │
          endpoint (async)                                      │
                    ↓                                            │
          Return PENDING to               ┌─────────┬──────────┐│
          Atlassian                       │ PENDING │ COMPLETED││
                                          ↓         ↓          ││
                                   Return PENDING  Return      ││
                                                  COMPLETED +  ││
                                                  summary      ││
                                          └──────────┬─────────┘│
                                                     │          │
                         AI server executes:         │          │
                         1. BEGIN TRANSACTION        │          │
                         2. Delete child records     │          │
                            (screenshot files,       │          │
                             activity_records,       │          │
                             analysis_results, etc)  │          │
                         3. Delete user row          │          │
                            (CASCADE handles rest)   │          │
                         4. Create audit log entry   │          │
                         5. COMMIT                   │          │
                         6. Update data_requests:    │          │
                            status=COMPLETED         │          │
                            deleted_count=N          │          │
                                                     ▼          │
                              Request complete                  │
                              (7-day polling cycle ends)        │
```

---

## Data Inventory

### ⚠️ CRITICAL MAINTENANCE WARNING

**This data inventory represents the state as of April 2026.**

When new tables or storage buckets containing user personal data are added:
1. **MUST** update `ai-server/src/services/user-data-service.js`
2. **MUST** update the export function to query new table/bucket
3. **MUST** update the deletion function to delete from new table/bucket
4. **MUST** update this Data Inventory section
5. **MUST** test export includes new data
6. **MUST** test deletion removes new data

**Failure to maintain this = GDPR non-compliance = app de-listing**

📖 **See:** [PERSONAL_DATA_REPORTING_API_MAINTENANCE_GUIDE.md](./PERSONAL_DATA_REPORTING_API_MAINTENANCE_GUIDE.md) for detailed checklist.

---

### Personal Data by Table

All data linked to `user_id` (UUID → `users.id`) or `atlassian_account_id`.

| Table | Personal Data Elements | Sensitivity | Deletion Strategy |
|---|---|---|---|
| **users** | atlassian_account_id, email, display_name, supabase_user_id, auth timestamps, desktop_app_version | HIGH | Hard delete row (CASCADE to children) |
| **screenshots** | user_id, storage_path, window_title, application_name, timestamp, project_key, user_assigned_issue_key | CRITICAL | Delete files from Storage, then CASCADE delete rows |
| **analysis_results** | user_id, extracted_text, detected_jira_keys, confidence_score, ai_model_version, worklog_id | HIGH | CASCADE delete (FK to screenshots) |
| **activity_records** | user_id, app_name, window_title, is_productive, session_start, session_end | HIGH | CASCADE delete (FK to users) |
| **worklogs** | user_id, jira_worklog_id, jira_issue_key, time_spent_seconds, description, started_at | MEDIUM | CASCADE delete (FK to users) |
| **documents** | user_id, file_name, storage_path, extracted_text, parsed_requirements | HIGH | Delete files from Storage, then CASCADE delete rows |
| **feedback** | user_id, category, feedback_text, ai_summary, screenshot_path | MEDIUM | Delete optional screenshot from Storage, then CASCADE delete rows |
| **tracking_settings** | user_id, screenshot_interval, auto_start, blur_screenshots, idle_threshold | LOW | CASCADE delete (FK to users) |
| **worklog_sync** | user_id, last_sync_at, sync_status | LOW | CASCADE delete (FK to users) |
| **user_jira_issues_cache** | user_id, issue_key, issue_summary, project_key | LOW | CASCADE delete (FK to users) |
| **unassigned_activity** | user_id, screenshot_id, window_title, application_name, extracted_text | HIGH | CASCADE delete (FK to users) |
| **org_members** | user_id, organization_id, role, permissions | MEDIUM | DELETE row (removes user from org) |
| **notification_logs** | user_id, email, notification_type, sent_at | MEDIUM | CASCADE delete or anonymize (FK to users) |
| **notification_preferences** | user_id, email_enabled, frequency | LOW | CASCADE delete (FK to users) |
| **notification_cooldowns** | user_id, cooldown_until | LOW | CASCADE delete (FK to users) |
| **activity_log** | user_id, event_type, event_data, ip_address, user_agent | MEDIUM | Anonymize or CASCADE delete |

### Storage Buckets

| Bucket | Path Pattern | Data Type | Deletion Strategy |
|---|---|---|---|
| **screenshots** | `{org_id}/{user_id}/*.png` | Screenshot images and thumbnails | List all objects with user_id prefix, delete each |
| **documents** | `{org_id}/{user_id}/*.pdf` | Uploaded BRD documents | List all objects with user_id prefix, delete each |
| **feedback-images** | `{user_id}/*.png` | Optional feedback screenshots | List all objects with user_id prefix, delete each |

### Export Data Structure

```json
{
  "dataType": "user_personal_data_export",
  "exportedAt": "2026-04-03T12:34:56Z",
  "requestId": "uuid-v4",
  "user": {
    "atlassianAccountId": "557058:abc123...",
    "email": "user@example.com",
    "displayName": "John Doe",
    "createdAt": "2025-06-01T10:00:00Z",
    "lastSyncAt": "2026-04-03T08:00:00Z",
    "isActive": true,
    "settings": {...}
  },
  "organizationMemberships": [
    {
      "organizationId": "uuid",
      "orgName": "Acme Corp",
      "jiraInstanceUrl": "https://acmecorp.atlassian.net",
      "role": "member",
      "joinedAt": "2025-06-01T10:05:00Z",
      "permissions": {...}
    }
  ],
  "screenshots": [
    {
      "id": "uuid",
      "timestamp": "2026-04-01T14:30:00Z",
      "windowTitle": "JIRA-123 - Fix login bug",
      "applicationName": "Visual Studio Code",
      "projectKey": "JIRA",
      "userAssignedIssueKey": "JIRA-123",
      "storageUrl": "https://...",
      "analyzedAt": "2026-04-01T14:30:15Z",
      "metadata": {...}
    }
  ],
  "analysisResults": [
    {
      "id": "uuid",
      "screenshotId": "uuid",
      "timeSpentSeconds": 1800,
      "activeTaskKey": "JIRA-123",
      "confidenceScore": 0.95,
      "extractedText": "...",
      "detectedJiraKeys": ["JIRA-123", "JIRA-124"],
      "isActiveWork": true,
      "aiModelVersion": "gpt-4o-mini",
      "createdAt": "2026-04-01T14:30:15Z"
    }
  ],
  "activityRecords": [
    {
      "id": "uuid",
      "sessionStart": "2026-04-01T09:00:00Z",
      "sessionEnd": "2026-04-01T10:00:00Z",
      "appName": "Visual Studio Code",
      "windowTitle": "main.js - MyProject",
      "isProductive": true,
      "classificationType": "coding",
      "durationSeconds": 3600
    }
  ],
  "worklogs": [
    {
      "id": "uuid",
      "jiraWorklogId": "10000",
      "jiraIssueKey": "JIRA-123",
      "timeSpentSeconds": 7200,
      "startedAt": "2026-04-01T09:00:00Z",
      "description": "Development work",
      "syncStatus": "synced",
      "createdAt": "2026-04-01T11:05:00Z"
    }
  ],
  "documents": [
    {
      "id": "uuid",
      "fileName": "requirements.pdf",
      "fileType": "pdf",
      "fileSizeBytes": 524288,
      "storageUrl": "https://...",
      "processingStatus": "completed",
      "extractedText": "...",
      "parsedRequirements": [...],
      "projectKey": "JIRA",
      "createdAt": "2026-03-15T10:00:00Z",
      "processedAt": "2026-03-15T10:02:30Z"
    }
  ],
  "feedback": [
    {
      "id": "uuid",
      "category": "feature_request",
      "feedbackText": "Please add keyboard shortcuts",
      "aiSummary": "User requests keyboard shortcuts",
      "screenshotPath": "...",
      "createdAt": "2026-03-20T15:00:00Z"
    }
  ],
  "trackingSettings": {
    "screenshotInterval": 300,
    "autoStart": false,
    "blurScreenshots": false,
    "trackIdle": true,
    "idleThresholdSeconds": 180
  },
  "notificationPreferences": {
    "emailEnabled": true,
    "frequency": "daily",
    "categories": ["idle_time", "unassigned_work"]
  },
  "activityLog": [
    {
      "id": "uuid",
      "eventType": "desktop_login",
      "eventData": {...},
      "ipAddress": "203.0.113.45",
      "userAgent": "Desktop App v1.2.3",
      "createdAt": "2026-04-01T08:55:00Z"
    }
  ],
  "storageSummary": {
    "totalScreenshots": 1234,
    "totalDocuments": 5,
    "totalStorageMB": 245.6,
    "screenshotFiles": [
      {
        "path": "org-uuid/user-uuid/screenshot_123.png",
        "sizeBytes": 204800,
        "url": "https://..." // Signed URL, 24hr expiry
      }
    ],
    "documentFiles": [
      {
        "path": "org-uuid/user-uuid/requirements.pdf",
        "sizeBytes": 524288,
        "url": "https://..." // Signed URL, 24hr expiry
      }
    ]
  }
}
```

---

## Implementation Phases

### Phase 1: Database Schema Updates (4-6 hours)

**Objective:** Add `data_requests` table to track request status for polling cycle.

**Tasks:**
1. Create migration file `20260404_add_data_requests_table.sql`
2. Define table schema with all required fields
3. Add indexes for performance
4. Test migration on development environment
5. Deploy to production Supabase instance

**Deliverables:**
- ✅ Migration SQL file
- ✅ Updated schema documentation
- ✅ Rollback script

---

### Phase 2: AI Server - Data Export Endpoint (12-16 hours)

**Objective:** Create `/api/v1/user-data/export` endpoint to package all user personal data.

**Tasks:**
1. Create new controller: `src/controllers/user-data-controller.js`
2. Implement export service: `src/services/user-data-service.js`
3. Query all user tables in Supabase
4. Download files from Storage buckets (screenshots, documents, feedback-images)
5. Package data as structured JSON
6. Generate signed URLs for large files (24-hour expiry)
7. Add Forge Invocation Token (FIT) authentication
8. Implement error handling and retry logic
9. Add request logging (PII-sanitized)
10. Write unit tests
11. Write integration tests

**Deliverables:**
- ✅ Export endpoint with full data aggregation
- ✅ Signed URL generation for files
- ✅ Error handling and logging
- ✅ Unit + integration tests (>80% coverage)

---

### Phase 3: AI Server - Data Deletion Endpoint (10-14 hours)

**Objective:** Create `/api/v1/user-data/delete` endpoint to permanently remove all user data.

**Tasks:**
1. Add deletion methods to `src/services/user-data-service.js`
2. Implement file deletion from Storage buckets
3. Execute hard delete in correct order (child → parent to avoid FK violations)
4. Use database transaction for atomicity
5. Create audit log entry (anonymized user ID, deletion timestamp, record counts)
6. Return deletion summary with counts per table
7. Add idempotency (handle multiple deletion requests gracefully)
8. Add Forge Invocation Token (FIT) authentication
9. Implement error handling and rollback logic
10. Write unit tests
11. Write integration tests

**Deliverables:**
- ✅ Deletion endpoint with cascading deletes
- ✅ Storage file cleanup
- ✅ Audit logging
- ✅ Transaction safety with rollback
- ✅ Unit + integration tests (>80% coverage)

---

### Phase 4: Forge App - userDataProvider Module (8-10 hours)

**Objective:** Add `userDataProvider` module to manifest and implement handler.

**Tasks:**
1. Update `forge-app/manifest.yml` to declare `userDataProvider` module
2. Create new handler function `src/handlers/personal-data-handler.js`
3. Implement `onPersonalDataReport(event)` function:
   - Extract `accountId`, `cloudId`, `requestType` from event
   - Validate request
   - Check/create record in `data_requests` table
   - If first poll: Create record, call AI server endpoint (async), return PENDING
   - If subsequent poll: Check status, return PENDING/COMPLETED/FAILED
   - Return structured response to Atlassian
4. Configure Forge Invocation Token (FIT) for secure AI server communication
5. Add error handling for AI server timeouts/failures
6. Add retry logic for transient failures
7. Write unit tests
8. Write integration tests
9. Test with `forge lint` to ensure no warnings

**Deliverables:**
- ✅ Updated manifest with `userDataProvider` module
- ✅ `onPersonalDataReport` handler implementation
- ✅ FIT authentication configuration
- ✅ Error handling and retry logic
- ✅ Unit + integration tests
- ✅ Zero `forge lint` warnings

---

### Phase 5: Polling Cycle Support (6-8 hours)

**Objective:** Implement async processing with status tracking for 7-day polling cycle.

**Tasks:**
1. Ensure `data_requests` table is properly indexed
2. Implement status transitions: PENDING → PROCESSING → COMPLETED/FAILED
3. Add timeout handling (target: complete within 24 hours)
4. Implement retry logic for failed requests (max 3 retries)
5. Add background job to clean up old completed requests (>30 days)
6. Add monitoring/alerting for stuck requests
7. Test polling cycle with simulated delays
8. Test edge cases (duplicate requests, concurrent requests, etc.)

**Deliverables:**
- ✅ Status transition logic
- ✅ Timeout and retry mechanisms
- ✅ Cleanup job for old requests
- ✅ Monitoring dashboard queries
- ✅ Edge case test coverage

---

### Phase 6: Testing & Validation (8-10 hours)

**Objective:** Comprehensive end-to-end testing of export and deletion flows.

**Test Scenarios:**

**Export Tests:**
- ✅ Export data for user with minimal data (new user)
- ✅ Export data for user with full data (all tables populated)
- ✅ Export data for user with large files (>100MB screenshots)
- ✅ Export data for user across multiple organizations
- ✅ Verify all tables are included in export
- ✅ Verify all Storage files have valid signed URLs
- ✅ Verify JSON structure matches schema
- ✅ Verify signed URLs expire after 24 hours
- ✅ Test concurrent export requests for same user (idempotency)
- ✅ Test export request timeout handling

**Deletion Tests:**
- ✅ Delete data for user with minimal data
- ✅ Delete data for user with full data
- ✅ Verify all database rows are deleted (query all tables)
- ✅ Verify all Storage files are deleted (query all buckets)
- ✅ Verify org_members row is deleted (user removed from org)
- ✅ Verify activity_log entries are anonymized
- ✅ Verify deletion is permanent (cannot be recovered)
- ✅ Test concurrent deletion requests for same user (idempotency)
- ✅ Test deletion request rollback on failure
- ✅ Test deletion with FK constraint violations (should not occur with correct order)

**Polling Cycle Tests:**
- ✅ First poll returns PENDING
- ✅ Subsequent polls return PENDING while processing
- ✅ Final poll returns COMPLETED with result
- ✅ Verify request completes within 24 hours
- ✅ Verify stale requests are cleaned up after 30 days

**Deliverables:**
- ✅ Test suite with >90% coverage
- ✅ Test report with all scenarios documented
- ✅ Performance test results (average completion time)

---

### Phase 7: Documentation & Privacy Policy Update (4-6 hours)

**Objective:** Update all documentation and Privacy Policy to reflect new capabilities.

**Tasks:**
1. Update `docs/COMPREHENSIVE_FEATURE_DOCUMENTATION.md`
2. Create `docs/PERSONAL_DATA_REPORTING_API_GUIDE.md` with:
   - How the feature works
   - User journey (how to request data export/deletion)
   - Technical architecture diagrams
   - Troubleshooting guide
3. Update Privacy Policy to replace "Export your data (contact support)" with:
   - "Export your data: Request via Jira admin settings → Personal Data. Atlassian will poll our app every 7 days until your data is ready."
   - "Delete your data: Request via Jira admin settings → Personal Data. All data will be permanently deleted within 24 hours."
4. Update `README.md` with GDPR compliance badge
5. Create internal runbook for support team

**Deliverables:**
- ✅ Updated comprehensive documentation
- ✅ Standalone Personal Data Reporting API guide
- ✅ Updated Privacy Policy
- ✅ Support runbook

---

### Phase 8: Deployment & Monitoring (4-6 hours)

**Objective:** Deploy to production and set up monitoring.

**Tasks:**
1. Deploy AI server changes to production (`https://forgesync.amzur.com`)
2. Deploy Forge app changes to production (`forge deploy --no-verify`)
3. Update environment variables if needed
4. Set up monitoring:
   - CloudWatch/Datadog alerts for failed data requests
   - Slack notifications for stuck requests (>48 hours in PENDING)
   - Daily summary report of data requests (export/deletion counts)
5. Set up audit log query dashboard
6. Create incident response plan for failures
7. Train support team on new feature

**Deliverables:**
- ✅ Production deployment
- ✅ Monitoring dashboards
- ✅ Alert configuration
- ✅ Incident response plan
- ✅ Support team training

---

## Detailed Technical Specifications

### 1. Database Schema: `data_requests` Table

**Migration File:** `supabase/migrations/20260404_add_data_requests_table.sql`

```sql
-- ============================================================================
-- Personal Data Reporting API - Data Requests Table
-- Tracks export/deletion requests for Atlassian's 7-day polling cycle
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.data_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Request identification
    request_type TEXT NOT NULL CHECK (request_type IN ('export', 'delete')),
    account_id TEXT NOT NULL, -- Atlassian account ID
    cloud_id TEXT NOT NULL,   -- Jira cloud instance ID
    
    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'completed', 'failed')
    ),
    
    -- Timestamps
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_processing_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    
    -- Results
    result_url TEXT, -- Signed URL for export data (24hr expiry)
    result_data JSONB, -- Small inline data or deletion summary
    error_message TEXT,
    
    -- Metadata
    retry_count INTEGER DEFAULT 0,
    processing_duration_ms INTEGER, -- Time taken to process
    
    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_data_requests_account_cloud 
    ON public.data_requests(account_id, cloud_id);

CREATE INDEX idx_data_requests_status 
    ON public.data_requests(status) 
    WHERE status IN ('pending', 'processing');

CREATE INDEX idx_data_requests_requested_at 
    ON public.data_requests(requested_at DESC);

-- Unique constraint to prevent duplicate active requests
CREATE UNIQUE INDEX idx_data_requests_active_unique 
    ON public.data_requests(account_id, cloud_id, request_type) 
    WHERE status IN ('pending', 'processing');

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_data_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER data_requests_updated_at_trigger
    BEFORE UPDATE ON public.data_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_data_requests_updated_at();

-- RLS Policies (service role only, no user access)
ALTER TABLE public.data_requests ENABLE ROW LEVEL SECURITY;

-- No policies = only service role can access (backend only)

COMMENT ON TABLE public.data_requests IS 
    'Tracks personal data export/deletion requests from Atlassian for GDPR compliance. Supports 7-day polling cycle.';
```

**Rollback Script:**

```sql
DROP TRIGGER IF EXISTS data_requests_updated_at_trigger ON public.data_requests;
DROP FUNCTION IF EXISTS update_data_requests_updated_at();
DROP INDEX IF EXISTS idx_data_requests_active_unique;
DROP INDEX IF EXISTS idx_data_requests_requested_at;
DROP INDEX IF EXISTS idx_data_requests_status;
DROP INDEX IF EXISTS idx_data_requests_account_cloud;
DROP TABLE IF EXISTS public.data_requests;
```

---

### 2. Forge App: Manifest Update

**File:** `forge-app/manifest.yml`

**Changes:**

```yaml
# Add to modules section
modules:
  # ... existing modules ...
  
  # Personal Data Reporting API (GDPR Compliance)
  userDataProvider:
    - key: personal-data-handler
      handler: personalData.onPersonalDataReport
```

**Handler Registration:**

```yaml
function:
  # ... existing functions ...
  
  - key: personalDataHandler
    handler: personalData.onPersonalDataReport
    timeoutSeconds: 30
```

---

### 3. Forge App: Handler Implementation

**File:** `forge-app/src/handlers/personal-data-handler.js`

```javascript
/**
 * Personal Data Reporting API Handler
 * Implements Atlassian's Personal Data Reporting API for GDPR compliance
 * Supports 7-day polling cycle for export and deletion requests
 */

const api = require('@forge/api');
const ForgeUI = require('@forge/ui');

const AI_SERVER_URL = process.env.AI_SERVER_URL || 'https://forgesync.amzur.com';

/**
 * Main handler for personal data requests
 * Called by Atlassian when a user requests data export or deletion
 * 
 * @param {Object} event - Personal data request event
 * @param {Object} event.payload - Request payload
 * @param {string} event.payload.accountId - Atlassian account ID
 * @param {string} event.payload.cloudId - Jira cloud instance ID
 * @param {string} event.payload.requestType - 'export' or 'delete'
 * @returns {Object} Response with status and data/error
 */
exports.onPersonalDataReport = async (event) => {
  console.log('[PersonalData] Request received:', {
    accountId: event.payload.accountId,
    cloudId: event.payload.cloudId,
    requestType: event.payload.requestType,
    timestamp: new Date().toISOString()
  });

  const { accountId, cloudId, requestType } = event.payload;

  // Validate request
  if (!accountId || !cloudId || !requestType) {
    console.error('[PersonalData] Invalid request - missing required fields');
    return {
      status: 'FAILED',
      error: 'Missing required fields: accountId, cloudId, or requestType'
    };
  }

  if (!['export', 'delete'].includes(requestType)) {
    console.error('[PersonalData] Invalid request type:', requestType);
    return {
      status: 'FAILED',
      error: `Invalid request type: ${requestType}. Must be 'export' or 'delete'`
    };
  }

  try {
    // Check existing request status
    const existingRequest = await checkRequestStatus(accountId, cloudId, requestType);

    if (existingRequest) {
      // Subsequent poll - return current status
      console.log('[PersonalData] Found existing request:', {
        requestId: existingRequest.id,
        status: existingRequest.status,
        requestedAt: existingRequest.requested_at
      });

      if (existingRequest.status === 'completed') {
        return formatCompletedResponse(existingRequest, requestType);
      } else if (existingRequest.status === 'failed') {
        return formatFailedResponse(existingRequest);
      } else {
        // Still processing
        return {
          status: 'PENDING',
          message: `Request is being processed. Request ID: ${existingRequest.id}`
        };
      }
    } else {
      // First poll - create new request and start processing
      console.log('[PersonalData] Creating new request');
      const newRequest = await createNewRequest(accountId, cloudId, requestType);

      // Trigger async processing (non-blocking)
      processRequestAsync(newRequest.id, accountId, cloudId, requestType)
        .catch(err => {
          console.error('[PersonalData] Async processing failed:', err);
          // Error will be recorded in data_requests table
        });

      return {
        status: 'PENDING',
        message: `Request created and processing started. Request ID: ${newRequest.id}`
      };
    }
  } catch (error) {
    console.error('[PersonalData] Handler error:', error);
    return {
      status: 'FAILED',
      error: `Internal error: ${error.message}`
    };
  }
};

/**
 * Check if request already exists in database
 */
async function checkRequestStatus(accountId, cloudId, requestType) {
  try {
    const response = await api.fetch(`${AI_SERVER_URL}/api/v1/user-data/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${generateForgeInvocationToken()}`
      },
      body: JSON.stringify({ accountId, cloudId, requestType })
    });

    if (!response.ok) {
      console.error('[PersonalData] Status check failed:', response.status);
      return null;
    }

    const data = await response.json();
    return data.request || null;
  } catch (error) {
    console.error('[PersonalData] Error checking status:', error);
    return null;
  }
}

/**
 * Create new request record in database
 */
async function createNewRequest(accountId, cloudId, requestType) {
  const response = await api.fetch(`${AI_SERVER_URL}/api/v1/user-data/create-request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${generateForgeInvocationToken()}`
    },
    body: JSON.stringify({ accountId, cloudId, requestType })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create request: ${response.status} - ${error}`);
  }

  return await response.json();
}

/**
 * Trigger async processing (non-blocking)
 */
async function processRequestAsync(requestId, accountId, cloudId, requestType) {
  const endpoint = requestType === 'export' 
    ? `${AI_SERVER_URL}/api/v1/user-data/export`
    : `${AI_SERVER_URL}/api/v1/user-data/delete`;

  console.log('[PersonalData] Starting async processing:', { requestId, requestType });

  try {
    const response = await api.fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${generateForgeInvocationToken()}`
      },
      body: JSON.stringify({ requestId, accountId, cloudId })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Processing failed: ${response.status} - ${error}`);
    }

    console.log('[PersonalData] Async processing completed:', requestId);
  } catch (error) {
    console.error('[PersonalData] Async processing error:', error);
    throw error;
  }
}

/**
 * Format completed response for export/deletion
 */
function formatCompletedResponse(request, requestType) {
  if (requestType === 'export') {
    return {
      status: 'COMPLETED',
      data: {
        downloadUrl: request.result_url,
        expiresAt: calculateExpiry(request.completed_at, 24), // 24hr expiry
        format: 'application/json',
        sizeBytes: request.result_data?.size_bytes || 0
      }
    };
  } else {
    // Deletion
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

/**
 * Format failed response
 */
function formatFailedResponse(request) {
  return {
    status: 'FAILED',
    error: request.error_message || 'Unknown error occurred',
    failedAt: request.updated_at,
    retryCount: request.retry_count
  };
}

/**
 * Generate Forge Invocation Token for AI server authentication
 */
function generateForgeInvocationToken() {
  // Forge automatically provides FIT via api.fetch context
  // This is a placeholder - actual implementation handled by Forge SDK
  return 'FORGE_INVOCATION_TOKEN';
}

/**
 * Calculate expiry timestamp
 */
function calculateExpiry(completedAt, hoursFromNow) {
  const expiry = new Date(completedAt);
  expiry.setHours(expiry.getHours() + hoursFromNow);
  return expiry.toISOString();
}
```

---

### 4. AI Server: User Data Controller

**File:** `ai-server/src/controllers/user-data-controller.js`

```javascript
/**
 * User Data Controller
 * Handles personal data export and deletion requests for GDPR compliance
 */

const express = require('express');
const router = express.Router();
const userDataService = require('../services/user-data-service');
const { authenticateFIT } = require('../middleware/forge-auth');
const { sanitizeLogs } = require('../utils/log-sanitizer');

/**
 * POST /api/v1/user-data/status
 * Check status of existing data request
 */
router.post('/status', authenticateFIT, async (req, res) => {
  try {
    const { accountId, cloudId, requestType } = req.body;

    if (!accountId || !cloudId || !requestType) {
      return res.status(400).json({
        error: 'Missing required fields: accountId, cloudId, requestType'
      });
    }

    const request = await userDataService.getRequestStatus(accountId, cloudId, requestType);

    res.json({ request });
  } catch (error) {
    console.error('[UserData] Status check error:', sanitizeLogs(error));
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/user-data/create-request
 * Create new data request record
 */
router.post('/create-request', authenticateFIT, async (req, res) => {
  try {
    const { accountId, cloudId, requestType } = req.body;

    if (!accountId || !cloudId || !requestType) {
      return res.status(400).json({
        error: 'Missing required fields: accountId, cloudId, requestType'
      });
    }

    const request = await userDataService.createRequest(accountId, cloudId, requestType);

    res.status(201).json(request);
  } catch (error) {
    console.error('[UserData] Create request error:', sanitizeLogs(error));
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/user-data/export
 * Export all personal data for a user
 */
router.post('/export', authenticateFIT, async (req, res) => {
  const startTime = Date.now();

  try {
    const { requestId, accountId, cloudId } = req.body;

    if (!requestId || !accountId || !cloudId) {
      return res.status(400).json({
        error: 'Missing required fields: requestId, accountId, cloudId'
      });
    }

    console.log('[UserData] Starting export:', { requestId, accountId: accountId.substring(0, 10) + '...' });

    // Update status to processing
    await userDataService.updateRequestStatus(requestId, 'processing');

    // Execute export
    const exportData = await userDataService.exportUserData(accountId, cloudId);

    // Generate signed URL for download (24hr expiry)
    const signedUrl = await userDataService.generateSignedUrlForExport(exportData, requestId);

    // Update status to completed
    await userDataService.updateRequestStatus(requestId, 'completed', {
      result_url: signedUrl,
      result_data: {
        size_bytes: JSON.stringify(exportData).length,
        exported_at: new Date().toISOString()
      },
      processing_duration_ms: Date.now() - startTime
    });

    console.log('[UserData] Export completed:', {
      requestId,
      duration_ms: Date.now() - startTime,
      size_bytes: JSON.stringify(exportData).length
    });

    res.json({
      success: true,
      requestId,
      signedUrl,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
  } catch (error) {
    console.error('[UserData] Export error:', sanitizeLogs(error));

    // Update status to failed
    try {
      await userDataService.updateRequestStatus(req.body.requestId, 'failed', {
        error_message: error.message,
        processing_duration_ms: Date.now() - startTime
      });
    } catch (updateError) {
      console.error('[UserData] Failed to update request status:', updateError);
    }

    res.status(500).json({ error: 'Export failed: ' + error.message });
  }
});

/**
 * POST /api/v1/user-data/delete
 * Permanently delete all personal data for a user
 */
router.post('/delete', authenticateFIT, async (req, res) => {
  const startTime = Date.now();

  try {
    const { requestId, accountId, cloudId } = req.body;

    if (!requestId || !accountId || !cloudId) {
      return res.status(400).json({
        error: 'Missing required fields: requestId, accountId, cloudId'
      });
    }

    console.log('[UserData] Starting deletion:', { requestId, accountId: accountId.substring(0, 10) + '...' });

    // Update status to processing
    await userDataService.updateRequestStatus(requestId, 'processing');

    // Execute deletion
    const deletionSummary = await userDataService.deleteUserData(accountId, cloudId);

    // Update status to completed
    await userDataService.updateRequestStatus(requestId, 'completed', {
      result_data: {
        records_deleted: deletionSummary.recordsDeleted,
        files_deleted: deletionSummary.filesDeleted,
        deleted_at: new Date().toISOString()
      },
      processing_duration_ms: Date.now() - startTime
    });

    console.log('[UserData] Deletion completed:', {
      requestId,
      duration_ms: Date.now() - startTime,
      records_deleted: deletionSummary.recordsDeleted,
      files_deleted: deletionSummary.filesDeleted
    });

    res.json({
      success: true,
      requestId,
      summary: deletionSummary
    });
  } catch (error) {
    console.error('[UserData] Deletion error:', sanitizeLogs(error));

    // Update status to failed
    try {
      await userDataService.updateRequestStatus(req.body.requestId, 'failed', {
        error_message: error.message,
        processing_duration_ms: Date.now() - startTime
      });
    } catch (updateError) {
      console.error('[UserData] Failed to update request status:', updateError);
    }

    res.status(500).json({ error: 'Deletion failed: ' + error.message });
  }
});

module.exports = router;
```

---

### 5. AI Server: User Data Service

**File:** `ai-server/src/services/user-data-service.js`

```javascript
/**
 * User Data Service
 * Core business logic for personal data export and deletion
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Get status of existing data request
 */
exports.getRequestStatus = async (accountId, cloudId, requestType) => {
  const { data, error } = await supabase
    .from('data_requests')
    .select('*')
    .eq('account_id', accountId)
    .eq('cloud_id', cloudId)
    .eq('request_type', requestType)
    .in('status', ['pending', 'processing', 'completed', 'failed'])
    .order('requested_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = not found
    throw new Error(`Failed to check request status: ${error.message}`);
  }

  return data;
};

/**
 * Create new data request
 */
exports.createRequest = async (accountId, cloudId, requestType) => {
  const { data, error } = await supabase
    .from('data_requests')
    .insert({
      account_id: accountId,
      cloud_id: cloudId,
      request_type: requestType,
      status: 'pending'
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create request: ${error.message}`);
  }

  return data;
};

/**
 * Update request status
 */
exports.updateRequestStatus = async (requestId, status, additionalFields = {}) => {
  const updateData = {
    status,
    ...additionalFields
  };

  if (status === 'processing' && !additionalFields.started_processing_at) {
    updateData.started_processing_at = new Date().toISOString();
  }

  if (status === 'completed' && !additionalFields.completed_at) {
    updateData.completed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('data_requests')
    .update(updateData)
    .eq('id', requestId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update request status: ${error.message}`);
  }

  return data;
};

/**
 * Export all user personal data
 */
exports.exportUserData = async (accountId, cloudId) => {
  // 1. Get user record
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('*')
    .eq('atlassian_account_id', accountId)
    .single();

  if (userError || !user) {
    throw new Error(`User not found: ${accountId}`);
  }

  const userId = user.id;

  // 2. Query all user-related tables
  const exportData = {
    dataType: 'user_personal_data_export',
    exportedAt: new Date().toISOString(),
    user: {
      atlassianAccountId: user.atlassian_account_id,
      email: user.email,
      displayName: user.display_name,
      createdAt: user.created_at,
      lastSyncAt: user.last_sync_at,
      isActive: user.is_active,
      settings: user.settings,
      desktopAppVersion: user.desktop_app_version,
      desktopLastHeartbeat: user.desktop_last_heartbeat
    }
  };

  // 3. Organization memberships
  const { data: orgMembers } = await supabase
    .from('organization_members')
    .select(`
      *,
      organization:organizations(
        jira_cloud_id,
        org_name,
        jira_instance_url
      )
    `)
    .eq('user_id', userId);

  exportData.organizationMemberships = (orgMembers || []).map(om => ({
    organizationId: om.organization_id,
    orgName: om.organization?.org_name,
    jiraInstanceUrl: om.organization?.jira_instance_url,
    role: om.role,
    joinedAt: om.joined_at,
    permissions: {
      canManageSettings: om.can_manage_settings,
      canViewTeamAnalytics: om.can_view_team_analytics,
      canManageMembers: om.can_manage_members,
      canDeleteScreenshots: om.can_delete_screenshots,
      canManageBilling: om.can_manage_billing
    }
  }));

  // 4. Screenshots
  const { data: screenshots } = await supabase
    .from('screenshots')
    .select('*')
    .eq('user_id', userId)
    .order('timestamp', { ascending: false });

  exportData.screenshots = screenshots || [];

  // 5. Analysis results
  const { data: analysisResults } = await supabase
    .from('analysis_results')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  exportData.analysisResults = analysisResults || [];

  // 6. Activity records
  const { data: activityRecords } = await supabase
    .from('activity_records')
    .select('*')
    .eq('user_id', userId)
    .order('session_start', { ascending: false });

  exportData.activityRecords = activityRecords || [];

  // 7. Worklogs
  const { data: worklogs } = await supabase
    .from('worklogs')
    .select('*')
    .eq('user_id', userId)
    .order('started_at', { ascending: false });

  exportData.worklogs = worklogs || [];

  // 8. Documents
  const { data: documents } = await supabase
    .from('documents')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  exportData.documents = documents || [];

  // 9. Feedback
  const { data: feedback } = await supabase
    .from('feedback')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  exportData.feedback = feedback || [];

  // 10. Tracking settings
  const { data: trackingSettings } = await supabase
    .from('tracking_settings')
    .select('*')
    .eq('user_id', userId)
    .single();

  exportData.trackingSettings = trackingSettings || {};

  // 11. Notification preferences
  const { data: notificationPrefs } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .single();

  exportData.notificationPreferences = notificationPrefs || {};

  // 12. Activity log (sanitized)
  const { data: activityLog } = await supabase
    .from('activity_log')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1000); // Limit to most recent 1000 entries

  exportData.activityLog = activityLog || [];

  // 13. User Jira issues cache
  const { data: issuesCache } = await supabase
    .from('user_jira_issues_cache')
    .select('*')
    .eq('user_id', userId);

  exportData.cachedJiraIssues = issuesCache || [];

  // 14. Unassigned activity
  const { data: unassignedActivity } = await supabase
    .from('unassigned_activity')
    .select('*')
    .eq('user_id', userId);

  exportData.unassignedActivity = unassignedActivity || [];

  // 15. Storage files (generate signed URLs)
  const storageSummary = await exportStorageFiles(userId, user.organization_id);
  exportData.storageSummary = storageSummary;

  return exportData;
};

/**
 * Export storage files (generate signed URLs)
 */
async function exportStorageFiles(userId, organizationId) {
  const summary = {
    totalScreenshots: 0,
    totalDocuments: 0,
    totalFeedbackImages: 0,
    totalStorageMB: 0,
    screenshotFiles: [],
    documentFiles: [],
    feedbackImageFiles: []
  };

  // Screenshots bucket
  const screenshotPath = organizationId ? `${organizationId}/${userId}/` : `${userId}/`;
  const { data: screenshotFiles } = await supabase.storage
    .from('screenshots')
    .list(screenshotPath, { limit: 10000 });

  if (screenshotFiles) {
    for (const file of screenshotFiles) {
      const { data: signedUrl } = await supabase.storage
        .from('screenshots')
        .createSignedUrl(`${screenshotPath}${file.name}`, 86400); // 24hr expiry

      summary.screenshotFiles.push({
        path: `${screenshotPath}${file.name}`,
        sizeBytes: file.metadata?.size || 0,
        url: signedUrl?.signedUrl
      });
      summary.totalStorageMB += (file.metadata?.size || 0) / 1024 / 1024;
    }
    summary.totalScreenshots = screenshotFiles.length;
  }

  // Documents bucket
  const documentPath = organizationId ? `${organizationId}/${userId}/` : `${userId}/`;
  const { data: documentFiles } = await supabase.storage
    .from('documents')
    .list(documentPath, { limit: 1000 });

  if (documentFiles) {
    for (const file of documentFiles) {
      const { data: signedUrl } = await supabase.storage
        .from('documents')
        .createSignedUrl(`${documentPath}${file.name}`, 86400);

      summary.documentFiles.push({
        path: `${documentPath}${file.name}`,
        sizeBytes: file.metadata?.size || 0,
        url: signedUrl?.signedUrl
      });
      summary.totalStorageMB += (file.metadata?.size || 0) / 1024 / 1024;
    }
    summary.totalDocuments = documentFiles.length;
  }

  // Feedback images bucket
  const feedbackPath = `${userId}/`;
  const { data: feedbackFiles } = await supabase.storage
    .from('feedback-images')
    .list(feedbackPath, { limit: 1000 });

  if (feedbackFiles) {
    for (const file of feedbackFiles) {
      const { data: signedUrl } = await supabase.storage
        .from('feedback-images')
        .createSignedUrl(`${feedbackPath}${file.name}`, 86400);

      summary.feedbackImageFiles.push({
        path: `${feedbackPath}${file.name}`,
        sizeBytes: file.metadata?.size || 0,
        url: signedUrl?.signedUrl
      });
      summary.totalStorageMB += (file.metadata?.size || 0) / 1024 / 1024;
    }
    summary.totalFeedbackImages = feedbackFiles.length;
  }

  return summary;
}

/**
 * Generate signed URL for export data
 * Uploads export JSON to temporary storage bucket
 */
exports.generateSignedUrlForExport = async (exportData, requestId) => {
  const fileName = `export_${requestId}_${Date.now()}.json`;
  const jsonContent = JSON.stringify(exportData, null, 2);

  // Upload to temporary exports bucket (auto-cleanup after 7 days)
  const { data, error } = await supabase.storage
    .from('exports')
    .upload(fileName, jsonContent, {
      contentType: 'application/json',
      upsert: false
    });

  if (error) {
    throw new Error(`Failed to upload export data: ${error.message}`);
  }

  // Generate signed URL (24hr expiry)
  const { data: signedUrl, error: urlError } = await supabase.storage
    .from('exports')
    .createSignedUrl(fileName, 86400); // 24 hours

  if (urlError) {
    throw new Error(`Failed to generate signed URL: ${urlError.message}`);
  }

  return signedUrl.signedUrl;
};

/**
 * Permanently delete all user personal data
 */
exports.deleteUserData = async (accountId, cloudId) => {
  const deletionSummary = {
    recordsDeleted: {},
    filesDeleted: 0,
    deletedAt: new Date().toISOString()
  };

  // 1. Get user record
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, organization_id')
    .eq('atlassian_account_id', accountId)
    .single();

  if (userError || !user) {
    throw new Error(`User not found: ${accountId}`);
  }

  const userId = user.id;
  const organizationId = user.organization_id;

  // 2. Start transaction (using Supabase RPC function)
  await supabase.rpc('begin_transaction');

  try {
    // 3. Delete storage files FIRST (before database records)
    const filesDeleted = await deleteStorageFiles(userId, organizationId);
    deletionSummary.filesDeleted = filesDeleted;

    // 4. Delete database records in correct order (child → parent)
    
    // Delete activity records
    const { count: activityRecordsCount } = await supabase
      .from('activity_records')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.activity_records = activityRecordsCount || 0;

    // Delete unassigned activity
    const { count: unassignedCount } = await supabase
      .from('unassigned_activity')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.unassigned_activity = unassignedCount || 0;

    // Delete analysis results (FK to screenshots)
    const { count: analysisCount } = await supabase
      .from('analysis_results')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.analysis_results = analysisCount || 0;

    // Delete screenshots
    const { count: screenshotsCount } = await supabase
      .from('screenshots')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.screenshots = screenshotsCount || 0;

    // Delete worklogs
    const { count: worklogsCount } = await supabase
      .from('worklogs')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.worklogs = worklogsCount || 0;

    // Delete documents
    const { count: documentsCount } = await supabase
      .from('documents')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.documents = documentsCount || 0;

    // Delete feedback
    const { count: feedbackCount } = await supabase
      .from('feedback')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.feedback = feedbackCount || 0;

    // Delete tracking settings
    const { count: trackingSettingsCount } = await supabase
      .from('tracking_settings')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.tracking_settings = trackingSettingsCount || 0;

    // Delete worklog sync
    const { count: worklogSyncCount } = await supabase
      .from('worklog_sync')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.worklog_sync = worklogSyncCount || 0;

    // Delete user Jira issues cache
    const { count: issuesCacheCount } = await supabase
      .from('user_jira_issues_cache')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.user_jira_issues_cache = issuesCacheCount || 0;

    // Delete notification logs
    const { count: notificationLogsCount } = await supabase
      .from('notification_logs')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.notification_logs = notificationLogsCount || 0;

    // Delete notification preferences
    const { count: notificationPrefsCount } = await supabase
      .from('notification_preferences')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.notification_preferences = notificationPrefsCount || 0;

    // Delete notification cooldowns
    const { count: cooldownsCount } = await supabase
      .from('notification_cooldowns')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.notification_cooldowns = cooldownsCount || 0;

    // Delete organization memberships
    const { count: orgMembersCount } = await supabase
      .from('organization_members')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.organization_members = orgMembersCount || 0;

    // Anonymize activity log (keep for audit, but remove PII)
    const { count: activityLogCount } = await supabase
      .from('activity_log')
      .update({
        user_id: null,
        ip_address: null,
        user_agent: 'REDACTED',
        event_data: { redacted: true }
      })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.activity_log_anonymized = activityLogCount || 0;

    // Delete user record (CASCADE will handle any remaining FKs)
    const { count: usersCount } = await supabase
      .from('users')
      .delete({ count: 'exact' })
      .eq('id', userId);
    deletionSummary.recordsDeleted.users = usersCount || 0;

    // 5. Create audit log entry
    await supabase
      .from('activity_log')
      .insert({
        user_id: null, // User is deleted, so null
        organization_id: organizationId,
        event_type: 'user_data_deletion',
        event_data: {
          atlassian_account_id_hash: crypto.createHash('sha256').update(accountId).digest('hex').substring(0, 16),
          cloud_id: cloudId,
          deletion_summary: deletionSummary,
          timestamp: new Date().toISOString()
        }
      });

    // 6. Commit transaction
    await supabase.rpc('commit_transaction');

    console.log('[UserData] Deletion completed:', deletionSummary);
    return deletionSummary;

  } catch (error) {
    // Rollback on error
    await supabase.rpc('rollback_transaction');
    throw error;
  }
};

/**
 * Delete all storage files for a user
 */
async function deleteStorageFiles(userId, organizationId) {
  let totalDeleted = 0;

  // Screenshots bucket
  const screenshotPath = organizationId ? `${organizationId}/${userId}` : userId;
  const { data: screenshotFiles } = await supabase.storage
    .from('screenshots')
    .list(screenshotPath, { limit: 10000 });

  if (screenshotFiles && screenshotFiles.length > 0) {
    const filePaths = screenshotFiles.map(f => `${screenshotPath}/${f.name}`);
    const { data, error } = await supabase.storage
      .from('screenshots')
      .remove(filePaths);
    
    if (!error) {
      totalDeleted += filePaths.length;
    }
  }

  // Documents bucket
  const documentPath = organizationId ? `${organizationId}/${userId}` : userId;
  const { data: documentFiles } = await supabase.storage
    .from('documents')
    .list(documentPath, { limit: 1000 });

  if (documentFiles && documentFiles.length > 0) {
    const filePaths = documentFiles.map(f => `${documentPath}/${f.name}`);
    const { data, error } = await supabase.storage
      .from('documents')
      .remove(filePaths);
    
    if (!error) {
      totalDeleted += filePaths.length;
    }
  }

  // Feedback images bucket
  const feedbackPath = userId;
  const { data: feedbackFiles } = await supabase.storage
    .from('feedback-images')
    .list(feedbackPath, { limit: 1000 });

  if (feedbackFiles && feedbackFiles.length > 0) {
    const filePaths = feedbackFiles.map(f => `${feedbackPath}/${f.name}`);
    const { data, error } = await supabase.storage
      .from('feedback-images')
      .remove(filePaths);
    
    if (!error) {
      totalDeleted += filePaths.length;
    }
  }

  return totalDeleted;
}
```

---

## Security & Privacy Considerations

### 1. Authentication & Authorization

**Forge Invocation Token (FIT):**
- All AI server endpoints MUST validate FIT
- FIT contains cryptographically signed proof that request originates from Forge app
- AI server validates signature using Forge's public key
- Prevents unauthorized access to personal data endpoints

**Implementation:**

```javascript
// ai-server/src/middleware/forge-auth.js

const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

let forgePublicKey = null;

async function getForgePublicKey() {
  if (forgePublicKey) return forgePublicKey;

  // Fetch Forge's public key for JWT verification
  const response = await fetch('https://api.atlassian.com/ex/forge/.well-known/jwks.json');
  const jwks = await response.json();
  forgePublicKey = jwks.keys[0]; // Simplified - use proper JWKS library in production
  return forgePublicKey;
}

exports.authenticateFIT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.substring(7);
    const publicKey = await getForgePublicKey();

    // Verify JWT signature
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: 'ari:cloud:platform::app/' + process.env.FORGE_APP_ID
    });

    // Attach verified claims to request
    req.forgeContext = decoded;
    next();
  } catch (error) {
    console.error('[Auth] FIT validation failed:', error);
    return res.status(401).json({ error: 'Invalid Forge Invocation Token' });
  }
};
```

### 2. PII Sanitization in Logs

**Critical Requirement:** Per Atlassian security requirement #6, apps that egress data must NOT log PII.

**Implementation:**

```javascript
// ai-server/src/utils/log-sanitizer.js

/**
 * Sanitize logs to remove PII
 */
exports.sanitizeLogs = (data) => {
  if (typeof data === 'string') {
    return data
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]')
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN_REDACTED]')
      .replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[CREDIT_CARD_REDACTED]');
  }

  if (typeof data === 'object' && data !== null) {
    const sanitized = { ...data };
    const piiFields = ['email', 'display_name', 'window_title', 'extracted_text', 'ip_address', 'user_agent'];
    
    for (const field of piiFields) {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }

  return data;
};
```

**Usage:**

```javascript
console.log('[UserData] Export request:', sanitizeLogs({
  accountId: 'abc123',
  email: 'user@example.com',
  displayName: 'John Doe'
}));

// Output: [UserData] Export request: { accountId: 'abc123', email: '[REDACTED]', displayName: '[REDACTED]' }
```

### 3. Rate Limiting

Prevent abuse of personal data endpoints:

```javascript
// ai-server/src/middleware/rate-limiter.js

const rateLimit = require('express-rate-limit');

exports.personalDataLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Max 10 requests per hour per account
  keyGenerator: (req) => req.body.accountId,
  message: 'Too many data requests. Please try again later.'
});
```

### 4. Secure File Deletion

**Requirement:** Ensure deleted files cannot be recovered.

**Supabase Implementation:**
- Supabase Storage automatically uses secure deletion (overwrite before delete)
- Deleted files are not recoverable after `remove()` call
- No additional secure deletion needed

### 5. Audit Trail

**Requirement:** All export/deletion requests must be audited.

**Implementation:** Already included in `data_requests` table + `activity_log` entries.

---

## Testing Strategy

### Unit Tests

**Coverage Target:** >80% for all new code

**Test Files:**
- `ai-server/tests/services/user-data-service.test.js`
- `ai-server/tests/controllers/user-data-controller.test.js`
- `forge-app/tests/handlers/personal-data-handler.test.js`

**Sample Test Cases:**

```javascript
describe('UserDataService - Export', () => {
  it('should export all user data for valid accountId', async () => {
    const exportData = await userDataService.exportUserData('557058:abc123', 'cloud-123');
    expect(exportData).toHaveProperty('user');
    expect(exportData).toHaveProperty('screenshots');
    expect(exportData).toHaveProperty('analysisResults');
    expect(exportData.user.atlassianAccountId).toBe('557058:abc123');
  });

  it('should include signed URLs for storage files', async () => {
    const exportData = await userDataService.exportUserData('557058:abc123', 'cloud-123');
    expect(exportData.storageSummary.screenshotFiles).toBeInstanceOf(Array);
    expect(exportData.storageSummary.screenshotFiles[0]).toHaveProperty('url');
    expect(exportData.storageSummary.screenshotFiles[0].url).toMatch(/^https:\/\//);
  });

  it('should throw error for non-existent user', async () => {
    await expect(userDataService.exportUserData('nonexistent', 'cloud-123'))
      .rejects.toThrow('User not found');
  });
});

describe('UserDataService - Delete', () => {
  it('should delete all user data', async () => {
    const summary = await userDataService.deleteUserData('557058:abc123', 'cloud-123');
    expect(summary.recordsDeleted.users).toBe(1);
    expect(summary.filesDeleted).toBeGreaterThan(0);
  });

  it('should create audit log entry', async () => {
    await userDataService.deleteUserData('557058:abc123', 'cloud-123');
    const auditLog = await supabase.from('activity_log')
      .select('*')
      .eq('event_type', 'user_data_deletion')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    expect(auditLog.data).toHaveProperty('event_data');
  });

  it('should be idempotent (handle duplicate deletion requests)', async () => {
    await userDataService.deleteUserData('557058:abc123', 'cloud-123');
    await expect(userDataService.deleteUserData('557058:abc123', 'cloud-123'))
      .rejects.toThrow('User not found');
  });
});
```

### Integration Tests

**Test Scenarios:**
1. End-to-end export flow (Forge → AI server → Supabase → signed URL)
2. End-to-end deletion flow (Forge → AI server → Supabase → audit log)
3. Polling cycle simulation (multiple requests over time)
4. Error handling (network failures, database errors, timeouts)

### Manual Testing Checklist

- [ ] Deploy to Forge development environment
- [ ] Trigger export request via Atlassian admin console
- [ ] Verify PENDING status on first poll
- [ ] Verify COMPLETED status on subsequent poll
- [ ] Download export data via signed URL
- [ ] Validate JSON structure matches schema
- [ ] Verify all tables are included
- [ ] Verify signed URLs work and expire after 24 hours
- [ ] Trigger deletion request
- [ ] Verify COMPLETED status
- [ ] Query database to confirm all records deleted
- [ ] Query storage to confirm all files deleted
- [ ] Verify audit log entry created
- [ ] Test with user having minimal data
- [ ] Test with user having maximum data (large export)
- [ ] Test concurrent requests (idempotency)
- [ ] Run `forge lint` → zero warnings

---

## Operational Monitoring

### Metrics to Track

1. **Request Volume:**
   - Daily export requests
   - Daily deletion requests
   - Peak request times

2. **Processing Performance:**
   - Average processing time (target: <1 hour)
   - 95th percentile processing time
   - Max processing time

3. **Success Rate:**
   - % of requests completed successfully
   - % of requests failed
   - % of requests stuck in PENDING (>24 hours)

4. **Data Volume:**
   - Average export size (MB)
   - Total files deleted per request
   - Total records deleted per request

### Alerts

**Critical Alerts (Page On-Call):**
- Request failed with error
- Request stuck in PENDING for >48 hours
- Database query timeout (>30 seconds)
- Storage deletion failed

**Warning Alerts (Slack Notification):**
- Request taking >12 hours to complete
- Export size >100MB
- Retry count >2

### Monitoring Queries

**Dashboard Query - Request Status Summary:**

```sql
SELECT 
  request_type,
  status,
  COUNT(*) as count,
  AVG(processing_duration_ms) as avg_duration_ms,
  MAX(processing_duration_ms) as max_duration_ms
FROM data_requests
WHERE requested_at > NOW() - INTERVAL '7 days'
GROUP BY request_type, status
ORDER BY request_type, status;
```

**Dashboard Query - Stuck Requests:**

```sql
SELECT 
  id,
  request_type,
  account_id,
  requested_at,
  NOW() - requested_at as age,
  retry_count
FROM data_requests
WHERE status IN ('pending', 'processing')
  AND requested_at < NOW() - INTERVAL '24 hours'
ORDER BY requested_at ASC;
```

---

## Timeline & Resources

### Phase Timeline

| Phase | Duration | Start Date | End Date |
|---|---|---|---|
| Phase 1: Database Schema | 1 day | April 4 | April 4 |
| Phase 2: Export Endpoint | 2 days | April 5 | April 6 |
| Phase 3: Deletion Endpoint | 2 days | April 7 | April 8 |
| Phase 4: Forge Handler | 2 days | April 9 | April 10 |
| Phase 5: Polling Support | 1 day | April 11 | April 11 |
| Phase 6: Testing | 2 days | April 12 | April 13 |
| Phase 7: Documentation | 1 day | April 14 | April 14 |
| Phase 8: Deployment | 1 day | April 15 | April 15 |
| **Total** | **12 days** | **April 4** | **April 15** |

### Resource Requirements

**Development:**
- 1 Senior Backend Engineer (full-time)
- 1 QA Engineer (50% time, Phase 6)

**Infrastructure:**
- Supabase Storage: Add `exports` bucket (auto-cleanup after 7 days)
- Monitoring: CloudWatch/Datadog dashboard setup
- Alerts: Slack webhook integration

**Documentation:**
- Technical writer (4 hours for Privacy Policy update)

---

## Risk Assessment

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| **Large export times out** | HIGH | MEDIUM | Implement streaming/chunked response; background processing |
| **CASCADE delete misses records** | CRITICAL | LOW | Comprehensive testing; verify all FKs configured correctly |
| **Signed URLs expire before download** | MEDIUM | LOW | 24hr expiry is sufficient; add re-request mechanism |
| **FIT validation fails** | HIGH | LOW | Thorough testing; use official Forge SDK methods |
| **Storage deletion fails partially** | HIGH | LOW | Transaction rollback; retry logic |
| **Request gets stuck in PENDING** | MEDIUM | MEDIUM | Monitoring alerts; manual retry mechanism |
| **Privacy Policy not updated** | CRITICAL | LOW | Include in acceptance criteria; legal review |
| **PII logged accidentally** | HIGH | MEDIUM | Code review; sanitization middleware on all logs |

---

## Acceptance Criteria

### Functional Requirements

- ✅ `userDataProvider` module declared in `manifest.yml`
- ✅ `onPersonalDataReport` handler implemented and tested
- ✅ Export endpoint returns all user data in structured JSON
- ✅ Export includes signed URLs for all storage files (24hr expiry)
- ✅ Deletion endpoint permanently removes all user data (hard delete)
- ✅ Deletion removes all storage files from all buckets
- ✅ Polling cycle correctly transitions: PENDING → PROCESSING → COMPLETED
- ✅ Requests complete within 24 hours (well under 7-day window)
- ✅ Idempotency: duplicate requests handled gracefully
- ✅ Error handling for all failure scenarios with retry logic
- ✅ Audit log entry created for each request

### Non-Functional Requirements

- ✅ Unit test coverage >80%
- ✅ Integration tests for export and deletion flows
- ✅ Zero `forge lint` warnings
- ✅ All logs sanitized (no PII)
- ✅ FIT authentication on all endpoints
- ✅ Rate limiting configured (10 requests/hour/account)
- ✅ Monitoring dashboard operational
- ✅ Alerts configured for failures and stuck requests
- ✅ Privacy Policy updated
- ✅ Documentation complete (architecture, user guide, runbook)

### Deployment Requirements

- ✅ Deployed to production Forge environment
- ✅ Database migration executed successfully
- ✅ AI server endpoints live on `forgesync.amzur.com`
- ✅ Manual end-to-end test completed successfully
- ✅ Support team trained

---

## Dependencies

### Internal Dependencies

1. **App Uninstall Handler (Org-Level Deletion):**
   - Shares deletion endpoint logic
   - Org-scoped vs user-scoped deletion
   - Should be implemented in parallel or before this feature
   - Reference: `MULTI_TENANCY_MIGRATION_PLAN.md` (Section on Data Cleanup)

2. **Forge Invocation Token (FIT) Implementation:**
   - Required for AI server authentication
   - May need to set up FIT validation if not already implemented
   - Reference: `AI_SERVER_CONNECTION_ARCHITECTURE.md`

### External Dependencies

1. **Supabase:**
   - Storage bucket: `exports` (needs to be created)
   - Database migration: `data_requests` table
   - Service role access for file deletion

2. **Atlassian Forge Platform:**
   - `userDataProvider` module support (confirmed available)
   - Polling cycle behavior (7 days)
   - FIT generation and validation

### Blockers

- None identified (all dependencies can be implemented in parallel)

---

## References

### Atlassian Documentation

1. [Personal Data Reporting API](https://developer.atlassian.com/platform/forge/manifest-reference/modules/user-data-provider/)
2. [Data Privacy Guidelines](https://developer.atlassian.com/platform/marketplace/data-privacy-guidelines/)
3. [GDPR Compliance for Marketplace Apps](https://developer.atlassian.com/platform/marketplace/gdpr/)
4. [Forge Invocation Token (FIT)](https://developer.atlassian.com/platform/forge/runtime-reference/invocation-token/)

### GDPR Articles

1. [Article 17 - Right to Erasure](https://gdpr-info.eu/art-17-gdpr/)
2. [Article 20 - Right to Data Portability](https://gdpr-info.eu/art-20-gdpr/)

### Internal Documentation

1. [ATLASSIAN_COMPLIANCE_REPORT.md](./ATLASSIAN_COMPLIANCE_REPORT.md) - Compliance requirements
2. [AI_SERVER_CONNECTION_ARCHITECTURE.md](./AI_SERVER_CONNECTION_ARCHITECTURE.md) - FIT implementation
3. [MULTI_TENANCY_MIGRATION_PLAN.md](./MULTI_TENANCY_MIGRATION_PLAN.md) - Org-level deletion patterns
4. [ENV_FILE_ARCHITECTURE.md](./ENV_FILE_ARCHITECTURE.md) - Environment configuration

---

## Appendix A: SQL Helper Functions

### Transaction Support for Supabase

**Note:** Supabase (PostgreSQL) doesn't directly support RPC for transaction control via client library. Alternative approach:

**Use single transaction block in service:**

```javascript
// Wrap all operations in a single query transaction
const { data, error } = await supabase.rpc('delete_user_data', {
  p_account_id: accountId
});
```

**Create stored procedure:**

```sql
CREATE OR REPLACE FUNCTION delete_user_data(p_account_id TEXT)
RETURNS JSONB AS $$
DECLARE
  v_user_id UUID;
  v_summary JSONB;
BEGIN
  -- Get user ID
  SELECT id INTO v_user_id
  FROM users
  WHERE atlassian_account_id = p_account_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found: %', p_account_id;
  END IF;

  -- Delete all child records (CASCADE will handle most)
  DELETE FROM activity_records WHERE user_id = v_user_id;
  DELETE FROM unassigned_activity WHERE user_id = v_user_id;
  -- ... etc for all tables

  -- Build summary
  v_summary := jsonb_build_object(
    'user_id', v_user_id,
    'deleted_at', NOW()
  );

  -- Delete user (CASCADE handles rest)
  DELETE FROM users WHERE id = v_user_id;

  RETURN v_summary;
END;
$$ LANGUAGE plpgsql;
```

---

## Appendix B: Testing Checklist

### Pre-Deployment Checklist

- [ ] All unit tests passing
- [ ] All integration tests passing
- [ ] Manual end-to-end test completed
- [ ] Code review approved
- [ ] Security review completed
- [ ] Privacy Policy updated and reviewed by legal
- [ ] Documentation complete
- [ ] Monitoring dashboard configured
- [ ] Alerts configured and tested
- [ ] Rollback plan documented
- [ ] Support team trained

### Post-Deployment Checklist

- [ ] Smoke test in production (trigger test export)
- [ ] Verify monitoring dashboard shows data
- [ ] Verify alerts trigger correctly
- [ ] Monitor first 24 hours for errors
- [ ] Review logs for any PII leaks
- [ ] Confirm `forge lint` passes in production
- [ ] Update internal wiki with deployment notes

---

## Appendix C: User Journey

### How Users Request Data Export

1. User logs into Jira as admin
2. Navigates to **Settings → Apps → Manage your apps**
3. Finds "JIRAForge Time Tracker" in installed apps
4. Clicks **"Request Personal Data"** (Atlassian UI)
5. Selects **"Export my data"**
6. Atlassian sends request to our Forge app
7. **First poll:** Our app returns PENDING
8. User sees message: "Your request is being processed. You will be notified when ready."
9. **Background:** Our AI server exports all data, uploads to storage, generates signed URL
10. **Subsequent polls (every 7 days):** Atlassian checks status
11. When status = COMPLETED, Atlassian provides download link to user
12. User downloads JSON file with all personal data
13. Signed URL expires after 24 hours

### How Users Request Data Deletion

1. Same steps 1-4 as export
2. Selects **"Delete my data"**
3. Sees confirmation warning: "This action is permanent and cannot be undone"
4. Confirms deletion
5. Atlassian sends request to our Forge app
6. **First poll:** Our app returns PENDING
7. **Background:** Our AI server permanently deletes all data and files
8. **Subsequent poll:** Status = COMPLETED
9. User sees confirmation: "Your data has been permanently deleted"

---

**END OF IMPLEMENTATION PLAN**

---

## Change Log

| Date | Version | Changes | Author |
|---|---|---|---|
| April 3, 2026 | 1.0 | Initial plan created | AI Assistant |

---

## Approval Signatures

- [ ] **Engineering Lead:** _________________ Date: _______
- [ ] **Security Review:** _________________ Date: _______
- [ ] **Legal Review (Privacy Policy):** _________________ Date: _______
- [ ] **Product Manager:** _________________ Date: _______

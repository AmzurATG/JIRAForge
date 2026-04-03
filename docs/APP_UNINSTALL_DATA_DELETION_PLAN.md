# App Uninstall Data Deletion - Implementation Plan

## Executive Summary

This document provides a detailed implementation plan for adding full data deletion functionality when the BRD Time Tracker app is uninstalled from a Jira Cloud site. This is **required for Privacy Policy compliance** and GDPR adherence.

**Current State:** No lifecycle handler exists for app uninstall events. Data remains in Supabase indefinitely after uninstallation.

**Target State:** Automatic, comprehensive data deletion within a 30-day grace period when an organization uninstalls the app.

**Estimated Effort:** 5-7 days (3 days development, 2 days testing, 1-2 days deployment & documentation)

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Data Deletion Scope](#data-deletion-scope)
3. [Implementation Phases](#implementation-phases)
4. [Detailed Implementation Steps](#detailed-implementation-steps)
5. [Testing Strategy](#testing-strategy)
6. [Rollback Plan](#rollback-plan)
7. [Privacy Policy Compliance](#privacy-policy-compliance)
8. [Timeline & Dependencies](#timeline--dependencies)

---

## Architecture Overview

### Current Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Jira Cloud Site                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Forge App (forge-app/)                                    │  │
│  │  - Modules (UI panels, scheduled triggers)                │  │
│  │  - Resolvers (API handlers)                               │  │
│  │  - KVS (Key-Value Storage for caching)                    │  │
│  │  - Communicates with AI server via invokeRemote()        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                            ↓ invokeRemote()
                            ↓ (authenticated via FIT token)
┌─────────────────────────────────────────────────────────────────┐
│ AI Server (ai-server/) - https://forgesync.amzur.com           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Express.js API                                            │  │
│  │  - /api/forge/* endpoints (Forge-authenticated)           │  │
│  │  - Controllers handle Supabase operations                 │  │
│  │  - forgeAuthMiddleware validates FIT tokens               │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                            ↓ Supabase Client SDK
┌─────────────────────────────────────────────────────────────────┐
│ Supabase                                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ PostgreSQL Database                                      │   │
│  │  - organizations (13 tables total)                       │   │
│  │  - users, screenshots, analysis_results, worklogs, etc.  │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Storage Buckets                                          │   │
│  │  - screenshots/                                          │   │
│  │  - documents/                                            │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Proposed Uninstall Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User Uninstalls App from Jira Site                           │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Atlassian Fires: avi:forge:uninstalled:app Event            │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Forge Trigger Handler (uninstalledHandler)                   │
│    - Receives context.cloudId                                    │
│    - Logs uninstall event                                        │
│    - Calls AI server via invokeRemote()                         │
│    - Clears all Forge KVS entries for this site                 │
└─────────────────────────────────────────────────────────────────┘
                            ↓ invokeRemote()
┌─────────────────────────────────────────────────────────────────┐
│ 4. AI Server: POST /api/forge/uninstall                         │
│    - Validates FIT token (ensures request from Forge)           │
│    - Identifies organization by cloudId                          │
│    - Marks organization for deletion (soft delete)              │
│    - Sets scheduled_deletion_at = NOW() + 30 days               │
│    - Logs audit trail                                            │
│    - Returns confirmation                                        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Scheduled Cleanup Job (runs daily)                           │
│    - Queries organizations with:                                 │
│      • status = 'pending_deletion'                              │
│      • scheduled_deletion_at <= NOW()                           │
│    - For each expired org:                                       │
│      a. Delete all child table records                          │
│      b. Delete all storage bucket files                         │
│      c. Delete organization record                              │
│      d. Log completion                                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Deletion Scope

### Supabase Tables (13 tables)

All records scoped to `organization_id` must be deleted:

| Table | Deletion Strategy | Notes |
|-------|-------------------|-------|
| `users` | DELETE WHERE organization_id = X | User records tied to org |
| `organization_members` | DELETE WHERE organization_id = X | Membership records |
| `organization_settings` | DELETE WHERE organization_id = X | Org configuration |
| `screenshots` | DELETE WHERE organization_id = X | Screenshot metadata |
| `analysis_results` | DELETE WHERE organization_id = X | AI analysis data |
| `worklogs` | DELETE WHERE organization_id = X | Worklog records |
| `activity_log` | DELETE WHERE organization_id = X | Audit trail |
| `created_issues_log` | DELETE WHERE organization_id = X | Created issue records |
| `documents` | DELETE WHERE organization_id = X | BRD document metadata |
| `unassigned_work_groups` | DELETE WHERE organization_id = X | Clustered activity data |
| `unassigned_group_members` | CASCADE via group deletion | Child table |
| `feedback` | DELETE WHERE organization_id = X | User feedback records |
| `tracking_settings` | DELETE WHERE organization_id = X | User tracking preferences |
| `organizations` | DELETE WHERE id = X | **Last** - parent record |

**Additional Tables Not Org-Scoped** (but may contain org data):
- `user_jira_issues_cache` - Has organization_id, should be deleted
- `daily_time_summary`, `weekly_time_summary`, `project_time_summary` - Check if org-scoped

### Supabase Storage Buckets

#### 1. `screenshots` Bucket
**Structure:** `{userId}/{timestamp}_screenshot.png`

**Deletion Logic:**
```javascript
1. Query all user IDs for the organization
2. For each user:
   - List all files in screenshots/{userId}/
   - Delete each file
3. Verify bucket cleanup (optional prefix check)
```

#### 2. `documents` Bucket
**Structure:** `{organizationId}/{documentId}_{filename}.pdf`

**Deletion Logic:**
```javascript
1. Use organization_id as prefix
2. List files: documents/{organizationId}/
3. Delete each file
```

### Forge KVS (Key-Value Storage)

**Keys to Clear:**
```
analytics:perms:{accountId}        # Cached Jira permissions
org:{cloudId}                      # Cached organization record
user:{accountId}:{cloudId}         # Cached user records
```

**Deletion Strategy:**
- Enumerate all keys with KVS (not possible in Forge)
- Instead, clear known key patterns based on org's users
- Alternative: Keys will expire naturally (24-hour TTL)

**Recommended Approach:** Clear critical keys during uninstall handler, allow others to expire.

---

## Implementation Phases

### Phase 1: Database Schema Updates (Day 1)
- Add `status` column to `organizations` table
- Add `scheduled_deletion_at` column
- Create database indexes for deletion queries
- Create audit log table for deletion events

### Phase 2: Forge App Changes (Days 2-3)
- Add uninstall lifecycle trigger to `manifest.yml`
- Create `src/services/lifecycleService.js`
- Implement uninstall handler function
- Add KVS cleanup logic
- Add logging and error handling

### Phase 3: AI Server Endpoint (Days 2-3, parallel)
- Create `/api/forge/uninstall` endpoint
- Implement soft-delete logic
- Add validation and auth checks
- Implement scheduled cleanup job
- Add comprehensive logging

### Phase 4: Cleanup Job Implementation (Day 4)
- Create scheduled deletion service
- Implement cascading delete logic
- Add storage bucket cleanup
- Implement retry logic for failures
- Add monitoring and alerting

### Phase 5: Testing & Validation (Days 5-6)
- Unit tests for all components
- Integration tests for full flow
- Manual testing in sandbox
- Performance testing (large orgs)
- Security review

### Phase 6: Deployment & Documentation (Day 7)
- Deploy AI server changes
- Deploy Forge app update
- Update Privacy Policy (if needed)
- Update documentation
- Monitor production rollout

---

## Detailed Implementation Steps

### Step 1: Database Schema Updates

**File:** `supabase/migrations/YYYYMMDD_add_deletion_lifecycle.sql`

```sql
-- ============================================================================
-- Add Deletion Lifecycle Columns to Organizations Table
-- ============================================================================

-- Add status column (active, pending_deletion, deleted)
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'
CHECK (status IN ('active', 'pending_deletion', 'deleted'));

-- Add scheduled deletion timestamp
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ;

-- Add uninstalled timestamp (audit trail)
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS uninstalled_at TIMESTAMPTZ;

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_orgs_pending_deletion
ON public.organizations (status, scheduled_deletion_at)
WHERE status = 'pending_deletion';

-- ============================================================================
-- Create Deletion Audit Log Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.deletion_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    jira_cloud_id TEXT NOT NULL,
    org_name TEXT NOT NULL,
    initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scheduled_for TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
    deletion_summary JSONB DEFAULT '{}'::jsonb,
    error_details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for monitoring
CREATE INDEX idx_deletion_audit_status
ON public.deletion_audit_log (status, scheduled_for);

COMMENT ON TABLE public.deletion_audit_log IS 'Audit trail for organization data deletion operations';
COMMENT ON COLUMN public.deletion_audit_log.deletion_summary IS 'JSON summary of deleted records (e.g., {users: 10, screenshots: 500})';

-- ============================================================================
-- Create Function to Discover Org-Scoped Tables
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_org_scoped_tables()
RETURNS TABLE(table_name TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT c.table_name::TEXT
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.column_name = 'organization_id'
    AND c.table_name NOT IN ('organizations', 'deletion_audit_log')  -- Exclude these
    AND c.table_name NOT LIKE 'pg_%'  -- Exclude PostgreSQL system tables
    AND c.table_name NOT LIKE 'sql_%'  -- Exclude SQL standard tables
  ORDER BY c.table_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.get_org_scoped_tables() IS 
  'Discovers all tables with organization_id column for automatic deletion. 
   Called by deletion service to ensure new tables are automatically included.';

-- Grant execute permission to service role
GRANT EXECUTE ON FUNCTION public.get_org_scoped_tables() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_org_scoped_tables() TO authenticated;

-- ============================================================================
-- Create Function to Discover Org-Scoped Materialized Views
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_org_scoped_materialized_views()
RETURNS TABLE(matview_name TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT mv.matviewname::TEXT
  FROM pg_matviews mv
  WHERE mv.schemaname = 'public'
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = mv.matviewname
        AND c.column_name = 'organization_id'
    )
  ORDER BY mv.matviewname;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.get_org_scoped_materialized_views() IS 
  'Discovers all materialized views with organization_id column.
   These should be refreshed or dropped during org deletion.';

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_org_scoped_materialized_views() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_org_scoped_materialized_views() TO authenticated;
```

### Step 2: Forge App - Update Manifest

**File:** `forge-app/manifest.yml`

```yaml
modules:
  # ... existing modules ...

  trigger:
    # Existing triggers
    - key: issue-cache-trigger
      function: issueCacheSync
      events:
        - avi:jira:updated:issue

    # NEW: Lifecycle events
    - key: app-installed-trigger
      function: lifecycleHandler
      events:
        - avi:forge:installed:app

    - key: app-uninstalled-trigger
      function: lifecycleHandler
      events:
        - avi:forge:uninstalled:app
```

**Note:** The event names are:
- `avi:forge:installed:app` (when app is installed)
- `avi:forge:uninstalled:app` (when app is uninstalled)

Reference: https://developer.atlassian.com/platform/forge/manifest-reference/modules/trigger/

### Step 3: Forge App - Lifecycle Service

**File:** `forge-app/src/services/lifecycleService.js`

```javascript
/**
 * Lifecycle Service
 * Handles app installation and uninstallation events
 */

import { remoteRequest } from '../utils/remote.js';
import { kvs } from '@forge/kvs';

/**
 * Handle app installation
 * Called when the app is installed on a Jira site
 * @param {Object} event - Installation event data
 * @param {Object} context - Forge context
 */
export async function handleAppInstalled(event, context) {
  const { cloudId, installationId } = context;

  console.log('[Lifecycle] App installed', {
    cloudId,
    installationId,
    timestamp: new Date().toISOString()
  });

  try {
    // Notify AI server of installation (creates org record if needed)
    await remoteRequest('/api/forge/organization', {
      body: { cloudId }
    });

    console.log('[Lifecycle] Installation recorded successfully');
  } catch (error) {
    console.error('[Lifecycle] Failed to record installation:', error);
    // Don't throw - installation should succeed even if tracking fails
  }
}

/**
 * Handle app uninstallation
 * Called when the app is uninstalled from a Jira site
 * Triggers data deletion workflow with 30-day grace period
 * @param {Object} event - Uninstallation event data
 * @param {Object} context - Forge context
 */
export async function handleAppUninstalled(event, context) {
  const { cloudId, installationId } = context;

  console.log('[Lifecycle] App uninstalled', {
    cloudId,
    installationId,
    timestamp: new Date().toISOString()
  });

  try {
    // Step 1: Call AI server to mark organization for deletion
    const result = await remoteRequest('/api/forge/uninstall', {
      body: {
        cloudId,
        installationId,
        uninstalledAt: new Date().toISOString()
      }
    });

    console.log('[Lifecycle] Data deletion scheduled:', result);

    // Step 2: Clear Forge KVS cache for this site
    await clearSiteCache(cloudId);

    console.log('[Lifecycle] Uninstallation handled successfully');
  } catch (error) {
    console.error('[Lifecycle] Failed to handle uninstallation:', error);
    // Still throw to trigger Forge retry mechanism
    throw error;
  }
}

/**
 * Clear all cached KVS entries for a site
 * @param {string} cloudId - Jira Cloud ID
 */
async function clearSiteCache(cloudId) {
  try {
    // Clear known cache keys
    const keysToDelete = [
      `org:${cloudId}`,
      // Note: User-specific keys will expire naturally (24h TTL)
    ];

    const deletePromises = keysToDelete.map(key =>
      kvs.delete(key).catch(err =>
        console.warn(`[Lifecycle] Failed to delete KVS key ${key}:`, err)
      )
    );

    await Promise.allSettled(deletePromises);
    console.log(`[Lifecycle] Cleared ${keysToDelete.length} KVS cache entries`);
  } catch (error) {
    console.error('[Lifecycle] Error clearing site cache:', error);
    // Don't throw - cache cleanup is not critical
  }
}
```

### Step 4: Forge App - Update Index

**File:** `forge-app/src/index.js`

```javascript
// ... existing imports ...
import { handleAppInstalled, handleAppUninstalled } from './services/lifecycleService.js';

// ... existing resolver setup ...

// Export handler for Forge
export const handler = resolver.getDefinitions();

// Export scheduled trigger handler for worklog sync
export const scheduledWorklogSyncHandler = async () => {
  return await runScheduledWorklogSync();
};

// Export issue cache trigger handler — fires on avi:jira:updated:issue
export const issueCacheSyncHandler = async (event, context) => {
  return await handleIssueUpdateEvent(event, context);
};

// NEW: Export lifecycle handler — fires on install/uninstall events
export const lifecycleHandler = async (event, context) => {
  const eventType = event?.eventType;

  console.log(`[Lifecycle] Event triggered: ${eventType}`);

  try {
    if (eventType === 'avi:forge:installed:app') {
      return await handleAppInstalled(event, context);
    } else if (eventType === 'avi:forge:uninstalled:app') {
      return await handleAppUninstalled(event, context);
    } else {
      console.warn(`[Lifecycle] Unknown event type: ${eventType}`);
      return { success: false, error: 'Unknown event type' };
    }
  } catch (error) {
    console.error(`[Lifecycle] Handler failed for ${eventType}:`, error);
    throw error; // Trigger Forge retry
  }
};
```

### Step 5: AI Server - Uninstall Endpoint

**File:** `ai-server/src/controllers/uninstall-controller.js`

```javascript
/**
 * Uninstall Controller
 * Handles app uninstallation and data deletion workflow
 */

const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');

/**
 * Handle app uninstallation
 * POST /api/forge/uninstall (Forge-authenticated)
 * 
 * Marks the organization for deletion with a 30-day grace period
 * Actual deletion is performed by scheduled cleanup job
 */
exports.handleUninstall = async (req, res) => {
  const { cloudId, installationId, uninstalledAt } = req.body;
  const forgeCloudId = req.forgeContext?.cloudId;

  // Security: Verify cloudId from body matches FIT token
  if (cloudId !== forgeCloudId) {
    logger.error('[Uninstall] CloudId mismatch', { bodyCloudId: cloudId, fitCloudId: forgeCloudId });
    return res.status(403).json({
      success: false,
      error: 'CloudId mismatch - possible authentication issue'
    });
  }

  const supabase = getClient();

  try {
    logger.info('[Uninstall] Processing app uninstallation', { cloudId, installationId });

    // Step 1: Find organization by cloudId
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('id, org_name, jira_cloud_id')
      .eq('jira_cloud_id', cloudId)
      .single();

    if (orgError || !org) {
      logger.warn('[Uninstall] Organization not found', { cloudId, error: orgError?.message });
      return res.status(404).json({
        success: false,
        error: 'Organization not found'
      });
    }

    // Step 2: Calculate deletion date (30 days from now)
    const gracePeriodDays = 30;
    const scheduledDeletionAt = new Date();
    scheduledDeletionAt.setDate(scheduledDeletionAt.getDate() + gracePeriodDays);

    // Step 3: Mark organization for deletion (soft delete)
    const { error: updateError } = await supabase
      .from('organizations')
      .update({
        status: 'pending_deletion',
        scheduled_deletion_at: scheduledDeletionAt.toISOString(),
        uninstalled_at: uninstalledAt || new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', org.id);

    if (updateError) {
      logger.error('[Uninstall] Failed to mark organization for deletion', {
        orgId: org.id,
        error: updateError
      });
      return res.status(500).json({
        success: false,
        error: 'Failed to schedule deletion'
      });
    }

    // Step 4: Create audit log entry
    const { error: auditError } = await supabase
      .from('deletion_audit_log')
      .insert({
        organization_id: org.id,
        jira_cloud_id: org.jira_cloud_id,
        org_name: org.org_name,
        initiated_at: new Date().toISOString(),
        scheduled_for: scheduledDeletionAt.toISOString(),
        status: 'pending',
        deletion_summary: {}
      });

    if (auditError) {
      logger.error('[Uninstall] Failed to create audit log', { error: auditError });
      // Don't fail the request - audit log is not critical
    }

    logger.info('[Uninstall] Organization marked for deletion', {
      orgId: org.id,
      orgName: org.org_name,
      scheduledFor: scheduledDeletionAt.toISOString(),
      gracePeriodDays
    });

    res.json({
      success: true,
      data: {
        organizationId: org.id,
        organizationName: org.org_name,
        status: 'pending_deletion',
        scheduledDeletionAt: scheduledDeletionAt.toISOString(),
        gracePeriodDays
      }
    });

  } catch (error) {
    logger.error('[Uninstall] Unhandled error during uninstall', {
      cloudId,
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error during uninstall'
    });
  }
};
```

### Step 6: AI Server - Deletion Service

**File:** `ai-server/src/services/deletion-service.js`

```javascript
/**
 * Deletion Service
 * Handles scheduled deletion of organization data
 * Called by scheduled job (cron or manual trigger)
 * 
 * IMPORTANT FOR FUTURE DEVELOPMENT:
 * This service automatically discovers tables with organization_id column.
 * When adding new tables, ensure they have organization_id if org-scoped.
 * The service will automatically include them in deletion.
 */

const logger = require('../utils/logger');
const { getClient } = require('./db/supabase-client');

/**
 * Discover all tables with organization_id column
 * This ensures new tables added in the future are automatically included
 * @returns {Promise<string[]>} Array of table names
 */
async function discoverOrgScopedTables() {
  const supabase = getClient();

  try {
    // Query PostgreSQL information_schema to find all tables with organization_id
    const { data, error } = await supabase.rpc('get_org_scoped_tables');

    if (error) {
      logger.error('[Deletion] Failed to discover org-scoped tables, using fallback list', {
        error: error.message
      });
      // Fallback to known tables if discovery fails
      return getFallbackTableList();
    }

    const tables = data.map(row => row.table_name);
    logger.info('[Deletion] Discovered org-scoped tables', { count: tables.length, tables });

    return tables;
  } catch (error) {
    logger.error('[Deletion] Exception discovering tables, using fallback', {
      error: error.message
    });
    return getFallbackTableList();
  }
}

/**
 * Fallback table list if automatic discovery fails
 * MAINTENANCE: Update this list when adding new org-scoped tables
 */
function getFallbackTableList() {
  return [
    'unassigned_group_members',
    'analysis_results',
    'screenshots',
    'worklogs',
    'activity_log',
    'created_issues_log',
    'documents',
    'unassigned_work_groups',
    'feedback',
    'tracking_settings',
    'user_jira_issues_cache',
    'daily_time_summary',
    'weekly_time_summary',
    'project_time_summary',
    'organization_members',
    'organization_settings',
    'users'
  ];
}

/**
 * Get deletion order for tables (respecting foreign key dependencies)
 * Tables with FK dependencies should be deleted first
 * @param {string[]} tables - List of table names
 * @returns {string[]} Ordered table list
 */
function getTableDeletionOrder(tables) {
  // Known FK dependencies (child -> parent)
  const dependencies = {
    'unassigned_group_members': ['unassigned_work_groups'],  // Has FK to groups
    'analysis_results': ['screenshots'],  // May have FK to screenshots
    'organization_members': ['users'],  // Has FK to users
    'organization_settings': ['organizations'],  // Has FK to organizations
    'screenshots': [],
    'worklogs': [],
    'activity_log': [],
    'created_issues_log': [],
    'documents': [],
    'unassigned_work_groups': [],
    'feedback': [],
    'tracking_settings': [],
    'user_jira_issues_cache': [],
    'daily_time_summary': [],
    'weekly_time_summary': [],
    'project_time_summary': [],
    'users': []  // Should be deleted last
  };

  // Sort tables: children first, then parents
  const ordered = [...tables].sort((a, b) => {
    // Users should always be last
    if (a === 'users') return 1;
    if (b === 'users') return -1;

    // Tables with no dependencies come first
    const aDeps = dependencies[a] || [];
    const bDeps = dependencies[b] || [];

    if (aDeps.length === 0 && bDeps.length > 0) return -1;
    if (bDeps.length === 0 && aDeps.length > 0) return 1;

    return 0;
  });

  return ordered;
}

/**
 * Execute deletion for a single organization
 * Deletes all data in the correct cascading order
 * @param {Object} org - Organization record with deletion info
 * @returns {Promise<Object>} Deletion summary
 */
async function deleteOrganizationData(org) {
  const supabase = getClient();
  const organizationId = org.organization_id;
  const summary = {};

  logger.info('[Deletion] Starting data deletion', {
    orgId: organizationId,
    orgName: org.org_name,
    cloudId: org.jira_cloud_id
  });

  try {
    // Update audit log status
    await supabase
      .from('deletion_audit_log')
      .update({
        status: 'in_progress',
        updated_at: new Date().toISOString()
      })
      .eq('organization_id', organizationId)
      .eq('status', 'pending');

    // Step 1: Discover all org-scoped tables dynamically
    const discoveredTables = await discoverOrgScopedTables();
    const tablesToDelete = getTableDeletionOrder(discoveredTables);

    logger.info('[Deletion] Tables to delete', {
      count: tablesToDelete.length,
      tables: tablesToDelete
    });

    // Step 2: Delete child table records (order matters for FKs)
    for (const table of tablesToDelete) {
      try {
        const { data, error } = await supabase
          .from(table)
          .delete()
          .eq('organization_id', organizationId)
          .select('id');  // Count deleted records

        if (error) {
          logger.error(`[Deletion] Failed to delete from ${table}`, {
            orgId: organizationId,
            error: error.message
          });
          summary[table] = { deleted: 0, error: error.message };
        } else {
          const count = data?.length || 0;
          summary[table] = { deleted: count };
          logger.info(`[Deletion] Deleted ${count} records from ${table}`);
        }
      } catch (error) {
        logger.error(`[Deletion] Exception deleting from ${table}`, {
          orgId: organizationId,
          error: error.message
        });
        summary[table] = { deleted: 0, error: error.message };
      }
    }

    // Step 2b: Delete/Refresh materialized views with org data
    const matViewSummary = await cleanupMaterializedViews(organizationId);
    if (matViewSummary.count > 0) {
      summary.materialized_views = matViewSummary;
    }

    // Step 3: Delete storage bucket files
    const storageSummary = await deleteStorageFiles(organizationId);
    summary.storage = storageSummary;

    // Step 4: Verify no orphaned records remain
    const orphanCheck = await verifyCompleteCleanup(organizationId);
    if (orphanCheck.hasOrphans) {
      logger.warn('[Deletion] Found orphaned records after deletion', orphanCheck);
      summary.orphans = orphanCheck;
    }

    // Step 5: Delete organization record (parent)
    const { error: orgDeleteError } = await supabase
      .from('organizations')
      .delete()
      .eq('id', organizationId);

    if (orgDeleteError) {
      logger.error('[Deletion] Failed to delete organization record', {
        orgId: organizationId,
        error: orgDeleteError.message
      });
      summary.organization = { deleted: 0, error: orgDeleteError.message };
    } else {
      summary.organization = { deleted: 1 };
      logger.info('[Deletion] Organization record deleted');
    }

    // Step 4: Update audit log with completion
    await supabase
      .from('deletion_audit_log')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        deletion_summary: summary,
        updated_at: new Date().toISOString()
      })
      .eq('organization_id', organizationId);

    logger.info('[Deletion] Data deletion completed', {
      orgId: organizationId,
      summary
    });

    return { success: true, summary };

  } catch (error) {
    logger.error('[Deletion] Unhandled error during deletion', {
      orgId: organizationId,
      error: error.message,
      stack: error.stack
    });

    // Update audit log with failure
    await supabase
      .from('deletion_audit_log')
      .update({
        status: 'failed',
        error_details: { message: error.message, stack: error.stack },
        updated_at: new Date().toISOString()
      })
      .eq('organization_id', organizationId)
      .eq('status', 'in_progress');

    return { success: false, error: error.message, summary };
  }
}

/**
 * Get all storage buckets (cached for performance)
 * @returns {Promise<string[]>} Array of bucket names
 */
let cachedBuckets = null;
async function getAllStorageBuckets() {
  if (cachedBuckets) return cachedBuckets;

  const supabase = getClient();
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) {
      logger.warn('[Deletion] Failed to list storage buckets, using defaults', {
        error: error.message
      });
      return ['screenshots', 'documents'];  // Fallback to known buckets
    }
    cachedBuckets = buckets.map(b => b.name);
    return cachedBuckets;
  } catch (error) {
    logger.warn('[Deletion] Exception listing buckets, using defaults', {
      error: error.message
    });
    return ['screenshots', 'documents'];
  }
}

/**
 * Delete all storage files for an organization
 * AUTO-DISCOVERS all storage buckets and deletes org-scoped files
 * @param {string} organizationId - Organization UUID
 * @returns {Promise<Object>} Deletion summary
 */
async function deleteStorageFiles(organizationId) {
  const supabase = getClient();
  const storageSummary = {};

  try {
    // Get all user IDs for this organization (for user-scoped buckets)
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', organizationId);

    if (usersError) {
      logger.error('[Deletion] Failed to fetch users for storage cleanup', {
        orgId: organizationId,
        error: usersError.message
      });
      return storageSummary;
    }

    const userIds = (users || []).map(u => u.id);
    logger.info('[Deletion] Found users for storage cleanup', {
      orgId: organizationId,
      userCount: userIds.length
    });

    // Auto-discover all storage buckets
    const buckets = await getAllStorageBuckets();
    logger.info('[Deletion] Discovered storage buckets', { buckets });

    // Process each bucket
    for (const bucket of buckets) {
      storageSummary[bucket] = { deleted: 0, errors: 0 };

      try {
        // Strategy 1: Try org-scoped deletion (organizationId/*)
        const { data: orgFiles, error: orgListError } = await supabase
          .storage
          .from(bucket)
          .list(organizationId);

        if (!orgListError && orgFiles && orgFiles.length > 0) {
          // Bucket uses org-scoped folder structure
          const orgPaths = orgFiles.map(file => `${organizationId}/${file.name}`);
          const { error: deleteOrgError } = await supabase
            .storage
            .from(bucket)
            .remove(orgPaths);

          if (deleteOrgError) {
            logger.error(`[Deletion] Failed to delete org-scoped files from ${bucket}`, {
              orgId: organizationId,
              count: orgPaths.length,
              error: deleteOrgError.message
            });
            storageSummary[bucket].errors++;
          } else {
            storageSummary[bucket].deleted += orgPaths.length;
            logger.info(`[Deletion] Deleted ${orgPaths.length} org-scoped files from ${bucket}`);
          }
        }

        // Strategy 2: Try user-scoped deletion (userId/*)
        for (const userId of userIds) {
          const { data: userFiles, error: userListError } = await supabase
            .storage
            .from(bucket)
            .list(userId);

          if (userListError || !userFiles || userFiles.length === 0) {
            continue;  // No files for this user in this bucket
          }

          // Bucket uses user-scoped folder structure
          const userPaths = userFiles.map(file => `${userId}/${file.name}`);
          const { error: deleteUserError } = await supabase
            .storage
            .from(bucket)
            .remove(userPaths);

          if (deleteUserError) {
            logger.error(`[Deletion] Failed to delete user-scoped files from ${bucket}`, {
              userId,
              count: userPaths.length,
              error: deleteUserError.message
            });
            storageSummary[bucket].errors++;
          } else {
            storageSummary[bucket].deleted += userPaths.length;
            logger.info(`[Deletion] Deleted ${userPaths.length} user-scoped files from ${bucket} for user ${userId}`);
          }
        }

      } catch (error) {
        logger.error(`[Deletion] Exception processing bucket ${bucket}`, {
          orgId: organizationId,
          error: error.message
        });
        storageSummary[bucket].errors++;
      }
    }

  } catch (error) {
    logger.error('[Deletion] Unhandled error during storage cleanup', {
      orgId: organizationId,
      error: error.message
    });
  }

  return storageSummary;
}

/**
 * Verify complete cleanup - check for orphaned records
 * This is a safety check to ensure all org-scoped data was deleted
 * @param {string} organizationId - Organization UUID
 * @returns {Promise<Object>} Orphan check result
 */
async function verifyCompleteCleanup(organizationId) {
  const supabase = getClient();
  const orphans = {};
  let hasOrphans = false;

  try {
    // Re-query all tables to check for remaining records
    const tables = await discoverOrgScopedTables();

    for (const table of tables) {
      try {
        const { data, error } = await supabase
          .from(table)
          .select('id')
          .eq('organization_id', organizationId)
          .limit(10);  // Just check if any exist

        if (!error && data && data.length > 0) {
          orphans[table] = data.length;
          hasOrphans = true;
          logger.warn(`[Deletion] Found ${data.length} orphaned records in ${table}`);
        }
      } catch (error) {
        // Ignore errors (table might not exist or have been deleted)
      }
    }
  } catch (error) {
    logger.error('[Deletion] Error during orphan check', {
      orgId: organizationId,
      error: error.message
    });
  }Clean up materialized views containing org data
 * Options: DELETE rows, DROP view, or REFRESH MATERIALIZED VIEW
 * @param {string} organizationId - Organization UUID
 * @returns {Promise<Object>} Cleanup summary
 */
async function cleanupMaterializedViews(organizationId) {
  const supabase = getClient();
  const summary = { count: 0, refreshed: [], dropped: [], errors: [] };

  try {
    // Discover materialized views with organization_id
    const { data: matViews, error } = await supabase.rpc('get_org_scoped_materialized_views');

    if (error || !matViews || matViews.length === 0) {
      return summary;
    }

    summary.count = matViews.length;

    for (const row of matViews) {
      const viewName = row.matview_name;

      try {
        // Option 1: Try to delete rows from the materialized view
        // (works if the view is writable, which is rare)
        const { error: deleteError } = await supabase
          .from(viewName)
          .delete()
          .eq('organization_id', organizationId);

        if (!deleteError) {
          summary.refreshed.push(viewName);
          logger.info(`[Deletion] Deleted rows from materialized view ${viewName}`);
        } else {
          // Option 2: Refresh the entire materialized view
          // This is safe - the view will just exclude the deleted org's data
          await supabase.rpc('refresh_matview', { view_name: viewName });
          summary.refreshed.push(viewName);
          logger.info(`[Deletion] Refreshed materialized view ${viewName}`);
        }
      } catch (error) {
        logger.warn(`[Deletion] Could not clean materialized view ${viewName}`, {
          error: error.message
        });
        summary.errors.push({ view: viewName, error: error.message });
      }
    }

  } catch (error) {
    logger.error('[Deletion] Error during materialized view cleanup', {
      orgId: organizationId,
      error: error.message
    });
  }

  return summary;
}

/**
 * 

  return { hasOrphans, orphans };
}

/**
 * Process all organizations pending deletion
 * Called by scheduled job
 */
exports.processScheduledDeletions = async () => {
  const supabase = getClient();

  try {
    logger.info('[Deletion] Starting scheduled deletion check');

    // Find all organizations pending deletion with expired grace period
    const { data: pendingOrgs, error: queryError } = await supabase
      .from('deletion_audit_log')
      .select('organization_id, org_name, jira_cloud_id, scheduled_for')
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString());

    if (queryError) {
      logger.error('[Deletion] Failed to query pending deletions', {
        error: queryError.message
      });
      return { success: false, error: queryError.message };
    }

    if (!pendingOrgs || pendingOrgs.length === 0) {
      logger.info('[Deletion] No organizations pending deletion');
      return { success: true, processed: 0 };
    }

    logger.info('[Deletion] Found organizations to delete', {
      count: pendingOrgs.le,
  verifyCompleteCleanup,
  discoverOrgScopedTables  // Export for testing
};
```

**IMPORTANT: Database Function Required**

This service requires a PostgreSQL function to discover org-scoped tables.
Add this to your Supabase migration:
    // Process each organization
    const results = [];
    for (const org of pendingOrgs) {
      const result = await deleteOrganizationData(org);
      results.push({ orgId: org.organization_id, ...result });

      // Add delay between deletions to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    logger.info('[Deletion] Scheduled deletion completed', {
      total: pendingOrgs.length,
      succeeded: successCount,
      failed: failureCount
    });

    return {
      success: true,
      processed: pendingOrgs.length,
      succeeded: successCount,
      failed: failureCount,
      results
    };

  } catch (error) {
    logger.error('[Deletion] Unhandled error in scheduled deletion', {
      error: error.message,
      stack: error.stack
    });
    return { success: false, error: error.message };
  }
};

module.exports = {
  deleteOrganizationData,
  deleteStorageFiles,
  processScheduledDeletions
};
```

### Step 7: AI Server - Register Routes

**File:** `ai-server/src/index.js`

Add the uninstall endpoint after other Forge routes:

```javascript
// ... existing Forge routes ...

// Uninstall handler (Forge-authenticated)
const uninstallController = require('./controllers/uninstall-controller');
app.post('/api/forge/uninstall', ...forgeMiddleware, uninstallController.handleUninstall);

// Manual deletion trigger (Admin-only - for testing/recovery)
app.post('/api/admin/process-deletions', authMiddleware, async (req, res) => {
  const { processScheduledDeletions } = require('./services/deletion-service');
  const result = await processScheduledDeletions();
  res.json(result);
});
```

### Step 8: Scheduled Cleanup Job

**Option A: Supabase Edge Function (Recommended)**

**File:** `supabase/functions/scheduled-deletion/index.ts`

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

serve(async (req) => {
  try {
    // Call AI server to process deletions
    const response = await fetch('https://forgesync.amzur.com/api/admin/process-deletions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('ADMIN_API_KEY')}`,
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    return new Response(
      JSON.stringify(result),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
})
```

**Schedule using pg_cron:**

```sql
-- Schedule edge function to run daily at 2 AM UTC
SELECT cron.schedule(
  'scheduled-deletion-job',
  '0 2 * * *',  -- Daily at 2 AM
  $$
  SELECT net.http_post(
    url := 'https://your-project.supabase.co/functions/v1/scheduled-deletion',
    headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
  );
  $$
);
```

**Option B: Node.js Cron Job in AI Server**

```javascript
// In ai-server/src/index.js
const cron = require('node-cron');
const { processScheduledDeletions } = require('./services/deletion-service');

// Run daily at 2 AM UTC
cron.schedule('0 2 * * *', async () => {
  logger.info('[Cron] Starting scheduled deletion job');
  try {
    await processScheduledDeletions();
  } catch (error) {
    logger.error('[Cron] Scheduled deletion job failed', { error: error.message });
  }
});
```

---

## Testing Strategy

### 1. Unit Tests

**Test File:** `forge-app/src/services/__tests__/lifecycleService.test.js`

```javascript
import { describe, it, expect, jest } from '@jest/globals';
import { handleAppUninstalled } from '../lifecycleService.js';
import * as remote from '../../utils/remote.js';
import { kvs } from '@forge/kvs';

jest.mock('../../utils/remote.js');
jest.mock('@forge/kvs');

describe('lifecycleService', () => {
  describe('handleAppUninstalled', () => {
    it('should call AI server uninstall endpoint', async () => {
      const mockContext = {
        cloudId: 'test-cloud-id',
        installationId: 'test-installation-id'
      };

      jest.spyOn(remote, 'remoteRequest').mockResolvedValue({
        success: true,
        organizationId: 'org-123',
        scheduledDeletionAt: '2026-05-01T00:00:00Z'
      });

      await handleAppUninstalled({}, mockContext);

      expect(remote.remoteRequest).toHaveBeenCalledWith(
        '/api/forge/uninstall',
        expect.objectContaining({
          body: expect.objectContaining({
            cloudId: 'test-cloud-id'
          })
        })
      );
    });

    it('should clear KVS cache', async () => {
      const mockContext = {
        cloudId: 'test-cloud-id',
        installationId: 'test-installation-id'
      };

      jest.spyOn(remote, 'remoteRequest').mockResolvedValue({ success: true });
      jest.spyOn(kvs, 'delete').mockResolvedValue(undefined);

      await handleAppUninstalled({}, mockContext);

      expect(kvs.delete).toHaveBeenCalledWith('org:test-cloud-id');
    });
  });
});
```

**Test File:** `ai-server/src/services/__tests__/deletion-service.test.js`

```javascript
const { deleteOrganizationData, processScheduledDeletions } = require('../deletion-service');
const { getClient } = require('../db/supabase-client');

jest.mock('../db/supabase-client');

describe('deletion-service', () => {
  describe('deleteOrganizationData', () => {
    it('should delete all organization data in correct order', async () => {
      // Mock Supabase client
      const mockDelete = jest.fn().mockReturnThis();
      const mockEq = jest.fn().mockResolvedValue({ data: [], error: null });

      getClient.mockReturnValue({
        from: jest.fn().mockReturnValue({
          delete: mockDelete,
          update: jest.fn().mockReturnThis(),
          eq: mockEq
        }),
        storage: {
          from: jest.fn().mockReturnValue({
            list: jest.fn().mockResolvedValue({ data: [], error: null }),
            remove: jest.fn().mockResolvedValue({ error: null })
          })
        }
      });

      const org = {
        organization_id: 'org-123',
        org_name: 'Test Org',
        jira_cloud_id: 'cloud-123'
      };

      const result = await deleteOrganizationData(org);

      expect(result.success).toBe(true);
      expect(result.summary).toHaveProperty('users');
      expect(result.summary).toHaveProperty('screenshots');
    });
  });
});
```

### 2. Integration Tests

**Test Scenario: Full Uninstall Flow**

```javascript
// forge-app/tests/integration/uninstall.test.js
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createTestOrganization, cleanupTestData } from './test-helpers.js';

describe('Uninstall Integration Test', () => {
  let testOrg;

  beforeAll(async () => {
    // Create test organization with sample data
    testOrg = await createTestOrganization({
      cloudId: 'test-cloud-id-integration',
      users: 2,
      screenshots: 10,
      worklogs: 20
    });
  });

  afterAll(async () => {
    await cleanupTestData(testOrg.id);
  });

  it('should complete full uninstall workflow', async () => {
    // 1. Trigger uninstall
    const uninstallResponse = await callUninstallEndpoint(testOrg.cloudId);
    expect(uninstallResponse.status).toBe('pending_deletion');

    // 2. Verify organization marked for deletion
    const org = await getOrganization(testOrg.id);
    expect(org.status).toBe('pending_deletion');
    expect(org.scheduled_deletion_at).toBeDefined();

    // 3. Manually trigger deletion (bypass 30-day wait)
    await processScheduledDeletions();

    // 4. Verify all data deleted
    const users = await queryUsers(testOrg.id);
    expect(users).toHaveLength(0);

    const screenshots = await queryScreenshots(testOrg.id);
    expect(screenshots).toHaveLength(0);

    const orgExists = await getOrganization(testOrg.id);
    expect(orgExists).toBeNull();
  });
});
```

### 3. Manual Testing Checklist

#### Pre-Deployment Tests (Sandbox Environment)

- [ ] Install app in test Jira site
- [ ] Create test organization with sample data
  - [ ] 3 users
  - [ ] 50 screenshots
  - [ ] 100 worklogs
  - [ ] 10 documents
- [ ] Uninstall app from Jira site
- [ ] Verify lifecycle event triggered in logs
- [ ] Verify organization marked as `pending_deletion`
- [ ] Verify `scheduled_deletion_at` is 30 days in future
- [ ] Verify audit log entry created
- [ ] Manually advance deletion date to NOW()
- [ ] Run deletion job manually
- [ ] Verify all data deleted:
  - [ ] Users deleted
  - [ ] Screenshots metadata deleted
  - [ ] Screenshot files deleted from storage
  - [ ] Documents metadata deleted
  - [ ] Document files deleted from storage
  - [ ] Worklogs deleted
  - [ ] Activity logs deleted
  - [ ] Organization deleted
- [ ] Verify audit log marked as `completed`
- [ ] Check for orphaned records in database
- [ ] Check for orphaned files in storage buckets

#### Performance Tests

- [ ] Test deletion with large organization (1000+ screenshots)
- [ ] Monitor deletion job execution time
- [ ] Verify no timeouts or rate limits hit
- [ ] Test concurrent deletions (multiple orgs)

#### Error Handling Tests

- [ ] Test deletion with missing organization
- [ ] Test deletion with partial data (some tables empty)
- [ ] Test deletion with storage errors (simulate bucket access failure)
- [ ] Verify failed deletions marked in audit log
- [ ] Verify retry logic works

---

## Rollback Plan

### If Issues Found After Deployment

**Critical Issues (Data Loss Risk):**
1. Immediately disable lifecycle trigger in Forge manifest
2. Deploy hotfix to prevent new deletions
3. Restore from Supabase backups if needed

**Non-Critical Issues (Logging, Performance):**
1. Monitor deletion audit logs
2. Fix issues in next deployment
3. Manually complete failed deletions

### Emergency Data Recovery

**Scenario:** Organization accidentally uninstalled app

**Solution:**
1. Within 30-day grace period:
   ```sql
   -- Reactivate organization
   UPDATE organizations
   SET status = 'active',
       scheduled_deletion_at = NULL,
       uninstalled_at = NULL
   WHERE id = 'org-id-here';
   
   -- Cancel deletion audit log
   UPDATE deletion_audit_log
   SET status = 'cancelled',
       updated_at = NOW()
   WHERE organization_id = 'org-id-here'
     AND status = 'pending';
   ```

2. After 30 days (data deleted):
   - Restore from Supabase point-in-time recovery (if enabled)
   - Otherwise, data is permanently deleted (as per Privacy Policy)

---

## Privacy Policy Compliance

### Current Privacy Policy Statement

> "Upon organization uninstallation, all organization data is marked for deletion."

### Implementation Compliance

Our implementation **exceeds** the Privacy Policy requirements by:

1. **Immediate Action:** Organization is immediately marked for deletion upon uninstall
2. **Grace Period:** 30-day grace period allows accidental uninstalls to be reversed
3. **Complete Deletion:** All data (database + storage) is deleted when grace period expires
4. **Audit Trail:** Full audit log of deletion operations
5. **Automatic Process:** No manual intervention required

### Privacy Policy Updates (Optional)

Consider updating Privacy Policy to be more specific:

**Current:**
> "Upon organization uninstallation, all organization data is marked for deletion."

**Suggested Update:**
> "Upon organization uninstallation, all organization data is scheduled for deletion. Data is retained for a 30-day grace period to allow for accidental uninstalls, after which all data (user profiles, screenshots, worklogs, documents, and analytics) is permanently deleted. This includes both database records and file storage."

---✅ Add `organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE` column
   - ✅ Deletion service automatically discovers and deletes records
   - ✅ No code changes needed!

2. **New Storage Bucket:**
   - ✅ Use org-scoped folder structure: `{organizationId}/...` OR user-scoped: `{userId}/...`
   - ✅ Deletion service automatically discovers all buckets via Storage API
   - ✅ No code changes needed if using standard folder structure!
   - ⚠️ Manual update needed only if using custom folder structure

3. **New Materialized View:**
   - ✅ Include `organization_id` column in the view definition
   - ✅ Deletion service automatically discovers and refreshes the view
   - ✅ No code changes needed!

4. **Regular Database View:**
   - ✅ No action needed - views don't store data, they're just queries
   - ✅ After org deletion, the view will return empty results for that org

5. **New Cached Data (Forge KVS):**
   - ⚠️ Manual update needed - Forge API doesn't support key enumeration
   - Update `clearSiteCache()` in lifecycle service
   - Add key pattern: `kvs.delete('your-key-pattern:${cloudId}')`

6. **Database Functions/Triggers:**
   - ✅ Usually safe - they operate on table data, not stored state
   - Review if function stores state outside tables
   - If state is in tables with organization_id, it's auto-deletedrge CLI access
3. **Testing Environment:** Sandbox Jira site for manual testing
4. **Monitoring:** Logging infrastructure for audit trail

### Deployment Order

1. **Database MigratioONLY Needed For:

| Item | Action Required | Why Manual? |
|------|-----------------|-------------|
| **Forge KVS cache keys** | Update `clearSiteCache()` | Forge API has no `listKeys()` or `enumerate()` function |
| **Custom storage folder structures** | Update `deleteStorageFiles()` | Only if NOT using `{orgId}/` or `{userId}/` pattern |
| **Cross-org tables** | Design separate logic | Tables without org_id need custom handling |
| **External services** | Add cleanup endpoint | Data stored outside Supabase (e.g., S3, Redis) |

**Everything else is automatic!** 🎉
3. **Forge App** (Atlassian)
   - Update manifest with lifecycle triggers
   - Deploy new version
   - Test in sandbox environment

4. **Scheduled Job** (Supabase or AI Server)
   - Deploy edge function OR enable cron job
   - Verify first run

5. **Monitoring**
   - Set up alerts for deletion failures
   - Monitor audit logs

--- ] All data deleted completely:
  - [ ] 13+ database tables (auto-discovered) column to new table
2. ✅ Test deletion service discovers it: `SELECT * FROM get_org_scoped_tables()`
3. ✅ If storage files: Update `deleteStorageFiles()`
4. ✅ If KVS cache: Update `clearSiteCache()`
5. ✅ Update unit tests to verify new table deletion
6. ✅ Run integration test to confirm complete cleanup

---

##  ] All data deleted completely:
  - [ ] 13 database tables
  - [ ] Screenshot files
  - [ ] Document files
  - [ ] Forge KVS cache
- [ ] Audit log records all deletions
- [ ] Failed deletions are logged and retryable

### Non-Functional Requirements

- [ ] Deletion completes within 5 minutes for typical org (100 users)
- [ ] No data leakage (all org data fully deleted)
- [ ] Graceful error handling (partial failures don't block others)
- [ ] Monitoring and alerting in place
- [ ] Documentation complete

### Compliance Requirements

- [ ] Privacy Policy compliance verified
- [ ] GDPR "right to erasure" satisfied
- [ ] Audit trail for all deletions
- [ ] 30-day grace period documented

---

## Additional Considerations

### 1. Reinstallation Handling

**Scenario:** Organization uninstalls, then reinstalls within 30 days

**Solution:**
```javascript
// In handleAppInstalled()
if (existingOrg && existingOrg.status === 'pending_deletion') {
  // Reactivate organization
  await supabase
    .from('organizations')
    .update({
      status: 'active',
      scheduled_deletion_at: null,
      uninstalled_at: null
    })
    .eq('id', existingOrg.id);
}
```

### 2. Partial Deletion Failures

**Scenario:** Storage deletion fails but database deletion succeeds

**Solution:**
- Deletion service catches errors per-table/per-bucket
- Audit log records partial success
- Manual cleanup script for orphaned files

### 3. Large Organization Performance

**Scenario:** Organization with 10,000+ screenshots

**Solution:**
- Implement batched deletion (1000 records at a time)
- Add progress updates to audit log
- Consider async queue for very large orgs

### 4. Detecting Undiscovered Tables

**Scenario:** A table has org data but doesn't have `organization_id` column

**Solution:**
Create a monitoring query to detect potential data leaks:

```sql
-- Run weekly to find tables that might contain org data
-- but weren't discovered by automatic discovery
SELECT 
  table_name,
  column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    column_name LIKE '%cloud_id%'
    OR column_name LIKE '%jira%'
    OR column_name LIKE '%tenant%'
  )
  AND table_name NOT IN (
    SELECT table_name FROM get_org_scoped_tables()
  );
```

### 5. Database Objects Beyond Tables

**Views, Materialized Views, Functions:**

```sql
-- Add to migration if you have org-scoped views
DROP VIEW IF EXISTS org_analytics_view CASCADE;
DROP MATERIALIZED VIEW IF EXISTS org_summary_mv CASCADE;

-- Functions and triggers are usually safe (operate on table data)
-- But verify any functions storing state
```

### 6. Data Export Before Deletion

**Future Enhancement:**
- Offer data export before uninstallation
- Send email notification with download link
- Retain export for 30 days

---

## Appendix

### A. Useful SQL Queries

**List organizations pending deletion:**
```sql
SELECT 
  o.id,
  o.org_name,
  o.jira_cloud_id,
  o.scheduled_deletion_at,
  dal.status AS audit_status,
  EXTRACT(DAY FROM (o.scheduled_deletion_at - NOW())) AS days_remaining
FROM organizations o
LEFT JOIN deletion_audit_log dal ON dal.organization_id = o.id
WHERE o.status = 'pending_deletion'
ORDER BY o.scheduled_deletion_at ASC;
```

**Count records per table for an organization:**
```sql
SELECT 
  'users' AS table_name,
  COUNT(*) AS record_count
FROM users
WHERE organization_id = 'org-id-here'

UNION ALL

SELECT 
  'screenshots',
  COUNT(*)
FROM screenshots
WHERE organization_id = 'org-id-here'

-- ... Maintenance Queries

**Verify automatic table discovery is working:**
```sql
-- Tables that will be deleted
SELECT * FROM get_org_scoped_tables();

-- Expected count (should be 17+ as of 2026-04-03)
SELECT COUNT(*) FROM get_org_scoped_tables();
```

**Find tables that might need organization_id:**
```sql
-- Tables that reference users or orgs but aren't auto-discovered
SELECT DISTINCT
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND (ccu.table_name = 'organizations' OR ccu.table_name = 'users')
  AND tc.table_name NOT IN (
    SELECT table_name FROM get_org_scoped_tables()
  );
```

**Check for orphaned data after deletion test:**
```sql
-- Replace 'deleted-org-id' with an org you just deleted
WITH org_id AS (SELECT 'deleted-org-id'::uuid AS id)
SELECT 
  'users' AS table_name,
  COUNT(*) AS orphan_count
FROM users, org_id
WHERE organization_id = org_id.id

UNION ALL

SELECT 'screenshots', COUNT(*)
FROM screenshots, org_id
WHERE organization_id = org_id.id

-- Add more tables as needed
;
```

### D. References

- [Forge Lifecycle Events](https://developer.atlassian.com/platform/forge/manifest-reference/modules/trigger/)
- [Forge invokeRemote Documentation](https://developer.atlassian.com/platform/forge/runtime-reference/remote-api/)
- [Supabase Storage API](https://supabase.com/docs/reference/javascript/storage)
- [GDPR Right to Erasure](https://gdpr-info.eu/art-17-gdpr/)
- [PostgreSQL Information Schema](https://www.postgresql.org/docs/current/information-schema.htmlabase
-- Run via Supabase Storage API or CLI
```

### B. Monitoring Queries

**Daily deletion summary:**
```sql
SELECT 
  DATE(completed_at) AS deletion_date,
  COUNT(*) AS orgs_deleted,
  SUM((deletion_summary->>'users')::int) AS total_users_deleted,
  SUM((deletion_summary->>'screenshots')::int) AS total_screenshots_deleted
FROM deletion_audit_log
WHERE status = 'completed'
  AND completed_at >= NOW() - INTERVAL '7 days'
GROUP BY DATE(completed_at)
ORDER BY deletion_date DESC;
```

**Failed deletions:**
```sql
SELECT 
  organization_id,
  org_name,
  jira_cloud_id,
  error_details,
  updated_at
FROM deletion_audit_log
WHERE status = 'failed'
ORDER BY updated_at DESC;
```

### C. References

- [Forge Lifecycle Events](https://developer.atlassian.com/platform/forge/manifest-reference/modules/trigger/)
- [Forge invokeRemote Documentation](https://developer.atlassian.com/platform/forge/runtime-reference/remote-api/)
- [Supabase Storage API](https://supabase.com/docs/reference/javascript/storage)
- [GDPR Right to Erasure](https://gdpr-info.eu/art-17-gdpr/)

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-04-03 | AI Assistant | Initial implementation plan |


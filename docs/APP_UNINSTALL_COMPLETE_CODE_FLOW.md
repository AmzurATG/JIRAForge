# App Uninstallation Feature - Complete Code Flow & Implementation

**Date Created:** April 8, 2026  
**Feature:** Automatic data deletion when app is uninstalled from Jira  
**Compliance:** GDPR Right to Erasure, Atlassian Privacy Guidelines

---

## Table of Contents
1. [Overview](#overview)
2. [Does Atlassian Poll for Hard Delete?](#does-atlassian-poll-for-hard-delete)
3. [Complete Code Changes](#complete-code-changes)
4. [Step-by-Step Flow](#step-by-step-flow)
5. [Soft Delete Process](#soft-delete-process)
6. [Hard Delete Process](#hard-delete-process)
7. [Reactivation Process](#reactivation-process)
8. [All Endpoints](#all-endpoints)

---

## Overview

When an admin uninstalls the app from **Jira → Settings → Apps → Uninstall**, the following happens:

1. **Immediate (Soft Delete):** Organization marked `pending_deletion`, 30-day grace period starts
2. **After 30 Days (Hard Delete):** All data permanently deleted via scheduled job
3. **Reinstallation:** If reinstalled within 30 days, all data is reactivated

---

## Does Atlassian Poll for Hard Delete?

**❌ NO - Atlassian does NOT poll for app uninstallation completion.**

### Why No Polling?

The app uninstallation lifecycle event (`avi:forge:uninstalled:app`) is a **one-time event**, not a polling-based request:

1. **One-Time Event:** Atlassian fires the event once when admin clicks "Uninstall"
2. **No Callback:** Atlassian does NOT poll to check if data deletion completed
3. **Fire and Forget:** Your app is responsible for handling deletion asynchronously

### What About the 30-Day Delay?

The 30-day grace period is **YOUR implementation choice** for data retention, not an Atlassian requirement. You manage this internally:

- **Your scheduled job** checks daily for expired organizations
- **Your admin endpoint** `/api/admin/process-deletions` can trigger manual deletion
- **No external polling** from Atlassian

### Contrast with Personal Data API

**The Personal Data API (GDPR user data export/deletion) IS polled by Atlassian:**
- Atlassian polls every ~7 days for individual user data requests
- Different from app uninstallation
- See `PERSONAL_DATA_REPORTING_API_README.md` for that flow

---

## Complete Code Changes

### 1. Database Migration

**File:** `supabase/migrations/20260403_add_deletion_lifecycle.sql`

```sql
-- ============================================================================
-- PART 1: Add columns to organizations table
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
CREATE INDEX idx_orgs_pending_deletion
ON public.organizations (status, scheduled_deletion_at)
WHERE status = 'pending_deletion';

-- ============================================================================
-- PART 2: Create deletion audit log table
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
        CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    deletion_summary JSONB DEFAULT '{}'::jsonb,
    error_details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deletion_audit_status
ON public.deletion_audit_log (status, scheduled_for);

-- ============================================================================
-- PART 3: Auto-discovery function for org-scoped tables
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_org_scoped_tables()
RETURNS TABLE(table_name TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT c.table_name::TEXT
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.column_name = 'organization_id'
    AND c.table_name NOT IN ('organizations', 'deletion_audit_log')
  GROUP BY c.table_name
  ORDER BY c.table_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- PART 4: Auto-discovery function for materialized views
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_org_scoped_materialized_views()
RETURNS TABLE(matview_name TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT mv.matviewname::TEXT
  FROM pg_matviews mv
  WHERE mv.schemaname = 'public'
    AND EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = mv.matviewname
        AND c.column_name = 'organization_id'
    )
  ORDER BY mv.matviewname;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- PART 5: Helper function to refresh materialized views
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refresh_matview(view_name TEXT)
RETURNS VOID AS $$
BEGIN
  EXECUTE format('REFRESH MATERIALIZED VIEW %I', view_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**What Changed:**
- ✅ Added 3 columns to `organizations` table for tracking deletion lifecycle
- ✅ Created `deletion_audit_log` table for audit trail
- ✅ Created 3 PostgreSQL functions for auto-discovering tables/views to delete
- ✅ Added indexes for query performance

---

### 2. Forge App Manifest

**File:** `forge-app/manifest.yml`

```yaml
trigger:
  # ... existing triggers ...
  
  # NEW: App installation trigger
  - key: app-installed-trigger
    function: lifecycleHandler
    events:
      - avi:forge:installed:app
  
  # NEW: App uninstallation trigger
  - key: app-uninstalled-trigger
    function: lifecycleHandler
    events:
      - avi:forge:uninstalled:app
```

**What Changed:**
- ✅ Added lifecycle event triggers for install/uninstall
- ✅ Both events call the same `lifecycleHandler` function

---

### 3. Forge App - Index (Entry Point)

**File:** `forge-app/src/index.js`

```javascript
import { handleAppInstalled, handleAppUninstalled } from './services/lifecycleService.js';

// NEW: Export lifecycle handler — fires on app install/uninstall events
// Handles data deletion workflow when app is uninstalled
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

**What Changed:**
- ✅ Added new export `lifecycleHandler`
- ✅ Routes to install/uninstall handlers based on event type

---

### 4. Forge App - Lifecycle Service (NEW FILE)

**File:** `forge-app/src/services/lifecycleService.js`

```javascript
import { remoteRequest } from '../utils/remote.js';
import { kvs } from '@forge/kvs';

/**
 * Handle app installation
 * Called when the app is installed on a Jira site
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
    const result = await remoteRequest('/api/forge/organization', {
      body: { cloudId }
    });

    console.log('[Lifecycle] Installation recorded successfully', {
      organizationId: result.id,
      organizationName: result.org_name
    });

    // Check if this is a reinstallation after pending deletion
    if (result.status === 'pending_deletion') {
      console.log('[Lifecycle] Reinstallation detected - organization was pending deletion', {
        organizationId: result.id,
        scheduledDeletionAt: result.scheduled_deletion_at
      });
      // The AI server's getOrCreateOrganization should have already reactivated it
    }

    return { success: true, organizationId: result.id };
  } catch (error) {
    console.error('[Lifecycle] Failed to record installation:', error);
    // Don't throw - installation should succeed even if tracking fails
    return { success: false, error: error.message };
  }
}

/**
 * Handle app uninstallation
 * Called when the app is uninstalled from a Jira site
 * Triggers data deletion workflow with 30-day grace period
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

    console.log('[Lifecycle] Data deletion scheduled:', {
      organizationId: result.organizationId,
      organizationName: result.organizationName,
      status: result.status,
      scheduledDeletionAt: result.scheduledDeletionAt,
      gracePeriodDays: result.gracePeriodDays
    });

    // Step 2: Clear Forge KVS cache for this site
    await clearSiteCache(cloudId);

    console.log('[Lifecycle] Uninstallation handled successfully');
    
    return { 
      success: true, 
      organizationId: result.organizationId,
      scheduledDeletionAt: result.scheduledDeletionAt
    };
  } catch (error) {
    console.error('[Lifecycle] Failed to handle uninstallation:', error);
    // Still throw to trigger Forge retry mechanism
    throw error;
  }
}

/**
 * Clear all cached KVS entries for a site
 * Note: Forge KVS doesn't support key enumeration, so we can only
 * delete known key patterns. User-specific keys will expire naturally
 * via their 24-hour TTL.
 */
async function clearSiteCache(cloudId) {
  try {
    const keysToDelete = [
      `org:${cloudId}`,
      // Note: User-specific keys will expire naturally (24h TTL)
    ];

    const deletePromises = keysToDelete.map(key =>
      kvs.delete(key).catch(err =>
        console.warn(`[Lifecycle] Failed to delete KVS key ${key}:`, err.message)
      )
    );

    await Promise.allSettled(deletePromises);
    
    console.log(`[Lifecycle] Cleared ${keysToDelete.length} KVS cache entries`, {
      keys: keysToDelete
    });
  } catch (error) {
    console.error('[Lifecycle] Error clearing site cache:', error);
    // Don't throw - cache cleanup is not critical
  }
}
```

**What Changed:**
- ✅ NEW FILE - Contains all lifecycle event handling logic
- ✅ `handleAppInstalled()` - Registers installation, detects reinstallations
- ✅ `handleAppUninstalled()` - Triggers soft delete, clears cache
- ✅ `clearSiteCache()` - Removes Forge KVS cached data

---

### 5. AI Server - Uninstall Controller (NEW FILE)

**File:** `ai-server/src/controllers/uninstall-controller.js`

```javascript
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
    logger.error('[Uninstall] CloudId mismatch', { 
      bodyCloudId: cloudId, 
      fitCloudId: forgeCloudId 
    });
    return res.status(403).json({
      success: false,
      error: 'CloudId mismatch - possible authentication issue'
    });
  }

  const supabase = getClient();

  try {
    logger.info('[Uninstall] Processing app uninstallation', { 
      cloudId, 
      installationId 
    });

    // Step 1: Find organization by cloudId
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('id, org_name, jira_cloud_id, status')
      .eq('jira_cloud_id', cloudId)
      .single();

    if (orgError || !org) {
      logger.warn('[Uninstall] Organization not found', { 
        cloudId, 
        error: orgError?.message 
      });
      return res.status(404).json({
        success: false,
        error: 'Organization not found'
      });
    }

    // Check if already marked for deletion
    if (org.status === 'pending_deletion') {
      logger.info('[Uninstall] Organization already pending deletion', {
        orgId: org.id,
        orgName: org.org_name
      });
      
      // Return existing deletion info
      const { data: auditLog } = await supabase
        .from('deletion_audit_log')
        .select('scheduled_for')
        .eq('organization_id', org.id)
        .eq('status', 'pending')
        .single();

      return res.json({
        success: true,
        data: {
          organizationId: org.id,
          organizationName: org.org_name,
          status: 'pending_deletion',
          scheduledDeletionAt: auditLog?.scheduled_for,
          gracePeriodDays: 30,
          message: 'Organization already scheduled for deletion'
        }
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
        error: updateError.message
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
      logger.error('[Uninstall] Failed to create audit log', { 
        orgId: org.id,
        error: auditError.message 
      });
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

**What Changed:**
- ✅ NEW FILE - Handles uninstall POST request from Forge app
- ✅ Validates FIT token authentication
- ✅ Marks organization with `pending_deletion` status
- ✅ Creates audit log entry
- ✅ Returns deletion schedule info back to Forge app

---

### 6. AI Server - Deletion Service (NEW FILE)

**File:** `ai-server/src/services/deletion-service.js` (Key Functions)

```javascript
const logger = require('../utils/logger');
const { getClient } = require('./db/supabase-client');

/**
 * Discover all tables with organization_id column
 * Auto-discovers new tables added in the future
 */
async function discoverOrgScopedTables() {
  const supabase = getClient();

  try {
    // Query PostgreSQL function to find all tables with organization_id
    const { data, error } = await supabase.rpc('get_org_scoped_tables');

    if (error) {
      logger.error('[Deletion] Failed to discover tables, using fallback');
      return getFallbackTableList();
    }

    const tables = data.map(row => row.table_name);
    logger.info('[Deletion] Discovered org-scoped tables', { 
      count: tables.length, 
      tables 
    });

    return tables;
  } catch (error) {
    logger.error('[Deletion] Exception discovering tables');
    return getFallbackTableList();
  }
}

/**
 * Delete all storage files for an organization
 * Handles nested folder structures: organizationId/userId/*, etc.
 */
async function deleteStorageFiles(organizationId) {
  const supabase = getClient();
  const storageSummary = {};

  try {
    // Get all user IDs for this organization
    const { data: users } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', organizationId);

    const userIds = (users || []).map(u => u.id);

    // Auto-discover all storage buckets
    const buckets = await getAllStorageBuckets();

    // Process each bucket
    for (const bucket of buckets) {
      storageSummary[bucket] = { deleted: 0, errors: 0 };

      try {
        // Delete org-scoped files (including nested folders)
        const orgDeleted = await deleteFilesRecursively(
          supabase, bucket, organizationId
        );
        storageSummary[bucket].deleted += orgDeleted;

        // Delete user-scoped files
        for (const userId of userIds) {
          const userDeleted = await deleteFilesRecursively(
            supabase, bucket, userId
          );
          storageSummary[bucket].deleted += userDeleted;
        }
      } catch (error) {
        logger.error(`[Deletion] Error processing bucket ${bucket}`);
        storageSummary[bucket].errors++;
      }
    }
  } catch (error) {
    logger.error('[Deletion] Unhandled error during storage cleanup');
  }

  return storageSummary;
}

/**
 * Delete a single organization's data
 */
async function deleteOrganizationData(org) {
  const supabase = getClient();
  const organizationId = org.organization_id;
  const summary = {};

  logger.info('[Deletion] Starting data deletion', {
    orgId: organizationId,
    orgName: org.org_name
  });

  try {
    // Update audit log status to in_progress
    await supabase
      .from('deletion_audit_log')
      .update({ status: 'in_progress' })
      .eq('organization_id', organizationId)
      .eq('status', 'pending');

    // Step 1: Auto-discover tables
    const discoveredTables = await discoverOrgScopedTables();
    const tablesToDelete = getTableDeletionOrder(discoveredTables);

    // Step 2: Delete database records
    for (const table of tablesToDelete) {
      try {
        const { count, error } = await supabase
          .from(table)
          .delete({ count: 'exact' })
          .eq('organization_id', organizationId);

        summary[table] = error 
          ? { deleted: 0, error: error.message }
          : { deleted: count || 0 };

        if (count > 0) {
          logger.info(`[Deletion] Deleted ${count} records from ${table}`);
        }
      } catch (error) {
        summary[table] = { deleted: 0, error: error.message };
      }
    }

    // Step 3: Delete/Refresh materialized views
    const matViewSummary = await cleanupMaterializedViews(organizationId);
    if (matViewSummary.count > 0) {
      summary.materialized_views = matViewSummary;
    }

    // Step 4: Delete storage files
    const storageSummary = await deleteStorageFiles(organizationId);
    summary.storage = storageSummary;

    // Step 5: Delete organization record
    const { error: orgDeleteError } = await supabase
      .from('organizations')
      .delete()
      .eq('id', organizationId);

    summary.organization = orgDeleteError
      ? { deleted: 0, error: orgDeleteError.message }
      : { deleted: 1 };

    // Step 6: Update audit log with completion
    await supabase
      .from('deletion_audit_log')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        deletion_summary: summary
      })
      .eq('organization_id', organizationId);

    logger.info('[Deletion] Data deletion completed', { summary });

    return { success: true, summary };

  } catch (error) {
    logger.error('[Deletion] Unhandled error during deletion');

    // Update audit log with failure
    await supabase
      .from('deletion_audit_log')
      .update({
        status: 'failed',
        error_details: { message: error.message }
      })
      .eq('organization_id', organizationId);

    return { success: false, error: error.message, summary };
  }
}

/**
 * Process all organizations pending deletion
 * Called by scheduled job or manual trigger
 */
async function processScheduledDeletions() {
  const supabase = getClient();

  try {
    logger.info('[Deletion] Starting scheduled deletion check');

    // Find all organizations with expired grace period
    const { data: pendingOrgs, error: queryError } = await supabase
      .from('deletion_audit_log')
      .select('organization_id, org_name, jira_cloud_id, scheduled_for')
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString());

    if (queryError) {
      logger.error('[Deletion] Failed to query pending deletions');
      return { success: false, error: queryError.message };
    }

    if (!pendingOrgs || pendingOrgs.length === 0) {
      logger.info('[Deletion] No organizations pending deletion');
      return { success: true, processed: 0 };
    }

    logger.info('[Deletion] Found organizations to delete', {
      count: pendingOrgs.length
    });

    // Process each organization
    const results = [];
    for (const org of pendingOrgs) {
      const result = await deleteOrganizationData(org);
      results.push({ orgId: org.organization_id, ...result });

      // Delay between deletions to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const successCount = results.filter(r => r.success).length;

    logger.info('[Deletion] Scheduled deletion completed', {
      total: pendingOrgs.length,
      succeeded: successCount
    });

    return {
      success: true,
      processed: pendingOrgs.length,
      succeeded: successCount,
      results
    };

  } catch (error) {
    logger.error('[Deletion] Unhandled error in scheduled deletion');
    return { success: false, error: error.message };
  }
}

module.exports = {
  deleteOrganizationData,
  processScheduledDeletions
};
```

**What Changed:**
- ✅ NEW FILE - Contains all hard delete logic
- ✅ Auto-discovers tables with `organization_id`
- ✅ Deletes database records in FK-aware order
- ✅ Recursively deletes storage files
- ✅ Updates audit log with completion status

---

### 7. AI Server - Forge Proxy Controller (REACTIVATION)

**File:** `ai-server/src/controllers/forge-proxy-controller.js`

```javascript
/**
 * Handle reinstallation after pending deletion
 */
async function resolveExistingOrg(supabase, existingOrg, orgName, jiraUrl, cloudId) {
  // Handle reinstallation after pending deletion
  if (existingOrg.status === 'pending_deletion') {
    logger.info('[ForgeProxy] Reinstallation detected - reactivating organization', {
      id: existingOrg.id,
      orgName: existingOrg.org_name,
      scheduledDeletionAt: existingOrg.scheduled_deletion_at
    });

    // Reactivate the organization
    const { data: reactivatedOrg, error: reactivateError } = await supabase
      .from('organizations')
      .update({
        status: 'active',
        scheduled_deletion_at: null,
        uninstalled_at: null,
        updated_at: getUTCISOString()
      })
      .eq('id', existingOrg.id)
      .select()
      .single();

    if (reactivateError) {
      logger.error('[ForgeProxy] Failed to reactivate organization', {
        id: existingOrg.id,
        error: reactivateError.message
      });
    } else {
      // Cancel the deletion audit log
      await supabase
        .from('deletion_audit_log')
        .update({
          status: 'cancelled',
          updated_at: getUTCISOString()
        })
        .eq('organization_id', existingOrg.id)
        .eq('status', 'pending');

      logger.info('[ForgeProxy] Organization reactivated successfully', {
        id: existingOrg.id
      });

      return reactivatedOrg;
    }
  }

  // ... rest of function (normal org lookup logic)
}
```

**What Changed:**
- ✅ MODIFIED - Added reactivation logic to existing function
- ✅ Checks if org has `pending_deletion` status
- ✅ Reactivates org by setting status back to `active`
- ✅ Clears deletion timestamps
- ✅ Cancels audit log entry

---

### 8. AI Server - Index (Route Registration)

**File:** `ai-server/src/index.js`

```javascript
const uninstallController = require('./controllers/uninstall-controller');
const { processScheduledDeletions } = require('./services/deletion-service');

// Uninstall endpoint (Forge-authenticated)
app.post('/api/forge/uninstall', ...forgeMiddleware, uninstallController.handleUninstall);

// Manual deletion trigger (Admin-only)
app.post('/api/admin/process-deletions', authMiddleware, async (req, res) => {
  try {
    const result = await processScheduledDeletions();
    res.json(result);
  } catch (error) {
    logger.error('[Admin] Failed to process deletions', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});
```

**What Changed:**
- ✅ Added `/api/forge/uninstall` endpoint (called by Forge app)
- ✅ Added `/api/admin/process-deletions` endpoint (manual trigger for testing/recovery)

---

## Step-by-Step Flow

### Complete Execution Flow with Input/Output

```
┌─────────────────────────────────────────────────────────────────┐
│ STEP 1: Admin Uninstalls App from Jira                          │
│ Location: Jira → Settings → Apps → Manage Apps → Uninstall     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 2: Atlassian Fires Event (ONE TIME ONLY - NOT POLLED)     │
│ Event: avi:forge:uninstalled:app                                │
│ Input: { eventType, context: { cloudId, installationId } }     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3: Forge Lifecycle Handler Receives Event                 │
│ File: forge-app/src/index.js                                    │
│ Function: lifecycleHandler(event, context)                      │
│                                                                  │
│ INPUT:                                                           │
│   {                                                              │
│     eventType: "avi:forge:uninstalled:app",                    │
│     context: {                                                   │
│       cloudId: "b1a2c3d4-e5f6-7890-abcd-ef1234567890",        │
│       installationId: "ari:cloud:jira::app/..."                │
│     }                                                            │
│   }                                                              │
│                                                                  │
│ LOGIC: Routes to handleAppUninstalled() based on eventType     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 4: Uninstall Handler Processes Event                      │
│ File: forge-app/src/services/lifecycleService.js               │
│ Function: handleAppUninstalled(event, context)                  │
│                                                                  │
│ INPUT: Same as Step 3                                           │
│                                                                  │
│ ACTIONS:                                                         │
│   1. Extract cloudId and installationId                         │
│   2. Log event details                                          │
│   3. Call AI server via remoteRequest()                         │
│   4. Clear Forge KVS cache                                      │
│                                                                  │
│ CALLS: remoteRequest('/api/forge/uninstall', { body })         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 5: Remote Request to AI Server                            │
│ File: forge-app/src/utils/remote.js                            │
│ Function: remoteRequest(endpoint, options)                      │
│                                                                  │
│ INPUT:                                                           │
│   endpoint: "/api/forge/uninstall"                             │
│   options: {                                                     │
│     body: {                                                      │
│       cloudId: "b1a2c3d4-...",                                 │
│       installationId: "ari:cloud:jira::app/...",               │
│       uninstalledAt: "2026-04-08T10:30:00.000Z"                │
│     }                                                            │
│   }                                                              │
│                                                                  │
│ LOGIC:                                                           │
│   - Uses invokeRemote() with FIT token authentication          │
│   - Adds Authorization header automatically                     │
│   - Makes POST request to AI server                            │
│                                                                  │
│ OUTPUT TO AI SERVER:                                            │
│   POST https://forgesync.amzur.com/api/forge/uninstall        │
│   Headers: { Authorization: "Bearer <FIT_TOKEN>" }             │
│   Body: { cloudId, installationId, uninstalledAt }             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 6: AI Server Receives Request                             │
│ File: ai-server/src/middleware/forge-auth.js                   │
│ Function: forgeAuthMiddleware(req, res, next)                   │
│                                                                  │
│ INPUT:                                                           │
│   req.headers.authorization: "Bearer <FIT_TOKEN>"              │
│   req.body: { cloudId, installationId, uninstalledAt }        │
│                                                                  │
│ AUTHENTICATION PROCESS:                                         │
│   1. Extract JWT token from Authorization header               │
│   2. Verify JWT signature using Atlassian's JWKS               │
│   3. Validate token audience matches FORGE_APP_ID              │
│   4. Extract cloudId and accountId from token payload          │
│   5. Attach to req.forgeContext                                │
│                                                                  │
│ OUTPUT:                                                          │
│   req.forgeContext = {                                          │
│     cloudId: "b1a2c3d4-...",                                   │
│     accountId: "5c8d9e0f1a2b3c4d5e6f7890"                      │
│   }                                                              │
│                                                                  │
│ NEXT: Calls next() → Routes to uninstallController             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 7: Uninstall Controller Processes Request (SOFT DELETE)   │
│ File: ai-server/src/controllers/uninstall-controller.js        │
│ Function: handleUninstall(req, res)                             │
│                                                                  │
│ INPUT:                                                           │
│   req.body: { cloudId, installationId, uninstalledAt }        │
│   req.forgeContext: { cloudId, accountId }                     │
│                                                                  │
│ SECURITY CHECK:                                                 │
│   ✓ Verify req.body.cloudId === req.forgeContext.cloudId      │
│     (Prevents token reuse attack)                               │
│                                                                  │
│ DATABASE QUERY 1: Find Organization                            │
│   SELECT * FROM organizations                                   │
│   WHERE jira_cloud_id = 'b1a2c3d4-...'                         │
│   LIMIT 1                                                       │
│                                                                  │
│ RESULT:                                                          │
│   {                                                              │
│     id: "12345678-abcd-efgh-ijkl-1234567890ab",                │
│     org_name: "Acme Corp",                                      │
│     jira_cloud_id: "b1a2c3d4-...",                             │
│     status: "active"                                            │
│   }                                                              │
│                                                                  │
│ CALCULATE DELETION DATE:                                        │
│   const gracePeriodDays = 30;                                  │
│   scheduledDeletionAt = new Date();                            │
│   scheduledDeletionAt.setDate(scheduledDeletionAt.getDate() + 30);│
│   // Result: "2026-05-08T10:30:00.000Z"                        │
│                                                                  │
│ DATABASE UPDATE: Mark for Deletion                             │
│   UPDATE organizations                                          │
│   SET                                                            │
│     status = 'pending_deletion',                               │
│     scheduled_deletion_at = '2026-05-08T10:30:00.000Z',       │
│     uninstalled_at = '2026-04-08T10:30:00.000Z',              │
│     updated_at = '2026-04-08T10:30:00.000Z'                   │
│   WHERE id = '12345678-abcd-efgh-ijkl-1234567890ab'           │
│                                                                  │
│ DATABASE INSERT: Create Audit Log                              │
│   INSERT INTO deletion_audit_log (                             │
│     organization_id,                                            │
│     jira_cloud_id,                                              │
│     org_name,                                                   │
│     initiated_at,                                               │
│     scheduled_for,                                              │
│     status,                                                     │
│     deletion_summary                                            │
│   ) VALUES (                                                    │
│     '12345678-abcd-efgh-ijkl-1234567890ab',                   │
│     'b1a2c3d4-...',                                            │
│     'Acme Corp',                                                │
│     '2026-04-08T10:30:00.000Z',                               │
│     '2026-05-08T10:30:00.000Z',                               │
│     'pending',                                                  │
│     '{}'                                                        │
│   )                                                             │
│                                                                  │
│ OUTPUT (Response to Forge):                                     │
│   {                                                              │
│     success: true,                                              │
│     data: {                                                     │
│       organizationId: "12345678-abcd-...",                     │
│       organizationName: "Acme Corp",                            │
│       status: "pending_deletion",                              │
│       scheduledDeletionAt: "2026-05-08T10:30:00.000Z",        │
│       gracePeriodDays: 30                                       │
│     }                                                            │
│   }                                                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 8: Response Returns to Forge App                          │
│ File: forge-app/src/services/lifecycleService.js               │
│ Function: handleAppUninstalled() (continued)                    │
│                                                                  │
│ INPUT (from AI server):                                         │
│   result = {                                                    │
│     organizationId: "12345678-...",                            │
│     organizationName: "Acme Corp",                              │
│     status: "pending_deletion",                                │
│     scheduledDeletionAt: "2026-05-08T10:30:00.000Z",          │
│     gracePeriodDays: 30                                         │
│   }                                                              │
│                                                                  │
│ LOGGING:                                                         │
│   console.log('[Lifecycle] Data deletion scheduled:', {...})   │
│                                                                  │
│ CACHE CLEANUP:                                                  │
│   await clearSiteCache(cloudId);                               │
│   // Deletes: org:b1a2c3d4-... from Forge KVS                 │
│                                                                  │
│ OUTPUT (Return to Atlassian):                                   │
│   {                                                              │
│     success: true,                                              │
│     organizationId: "12345678-...",                            │
│     scheduledDeletionAt: "2026-05-08T10:30:00.000Z"           │
│   }                                                              │
│                                                                  │
│ NOTE: Atlassian does NOT poll or check this response           │
│       It's fire-and-forget from Atlassian's perspective        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ SOFT DELETE COMPLETE                                            │
│ Organization Status: pending_deletion                           │
│ Data: Fully intact (not deleted yet)                           │
│ Grace Period: 30 days                                           │
│ Next Step: Wait for scheduled job OR manual trigger            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Soft Delete Process

### What is Soft Delete?

**Soft delete** means marking data as "deleted" without actually removing it from the database.

### Implementation

**Database Changes:**
```sql
UPDATE organizations
SET 
  status = 'pending_deletion',
  scheduled_deletion_at = NOW() + INTERVAL '30 days',
  uninstalled_at = NOW()
WHERE jira_cloud_id = '<cloudId>';
```

**Result:**
- ✅ Data remains in database
- ✅ Organization record still exists
- ✅ All screenshots, users, worklogs remain intact
- ✅ Audit log created for tracking
- ✅ 30-day countdown begins

### Why Soft Delete First?

1. **Grace Period:** Allows reinstallation within 30 days
2. **Data Recovery:** Prevents accidental data loss
3. **Audit Trail:** Tracks when uninstall occurred
4. **Compliance:** Meets privacy policy commitments

---

## Hard Delete Process

### What is Hard Delete?

**Hard delete** means permanently removing all data from the database and storage. Data cannot be recovered.

### When Does It Execute?

**Option 1: Scheduled Job (Automatic)**
- Runs daily (recommended)
- Checks for orgs with `scheduled_deletion_at <= NOW()`
- Deletes all expired organizations

**Option 2: Manual Trigger (Testing/Recovery)**
- Admin calls `POST /api/admin/process-deletions`
- Immediately processes all expired deletions
- Useful for testing or emergency cleanup

### Complete Hard Delete Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ STEP 1: Scheduled Job Runs (30 Days After Uninstall)          │
│ Trigger: Cron job OR manual admin request                      │
│ Endpoint: POST /api/admin/process-deletions                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 2: Query Expired Organizations                            │
│ File: ai-server/src/services/deletion-service.js               │
│ Function: processScheduledDeletions()                           │
│                                                                  │
│ DATABASE QUERY:                                                 │
│   SELECT organization_id, org_name, jira_cloud_id, scheduled_for│
│   FROM deletion_audit_log                                       │
│   WHERE status = 'pending'                                      │
│     AND scheduled_for <= NOW()                                  │
│                                                                  │
│ RESULT:                                                          │
│   [                                                              │
│     {                                                            │
│       organization_id: "12345678-...",                          │
│       org_name: "Acme Corp",                                    │
│       jira_cloud_id: "b1a2c3d4-...",                           │
│       scheduled_for: "2026-05-08T10:30:00.000Z"                │
│     }                                                            │
│   ]                                                              │
│                                                                  │
│ NEXT: For each org, call deleteOrganizationData()             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3: Delete Organization Data                               │
│ File: ai-server/src/services/deletion-service.js               │
│ Function: deleteOrganizationData(org)                           │
│                                                                  │
│ INPUT:                                                           │
│   org = {                                                       │
│     organization_id: "12345678-...",                           │
│     org_name: "Acme Corp",                                      │
│     jira_cloud_id: "b1a2c3d4-..."                              │
│   }                                                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3A: Update Audit Log to In-Progress                       │
│                                                                  │
│ DATABASE UPDATE:                                                │
│   UPDATE deletion_audit_log                                     │
│   SET status = 'in_progress',                                  │
│       updated_at = NOW()                                        │
│   WHERE organization_id = '12345678-...'                       │
│     AND status = 'pending'                                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3B: Auto-Discover Tables with organization_id            │
│ Function: discoverOrgScopedTables()                             │
│                                                                  │
│ DATABASE QUERY (PostgreSQL Function):                          │
│   SELECT table_name                                             │
│   FROM information_schema.columns                               │
│   WHERE table_schema = 'public'                                 │
│     AND column_name = 'organization_id'                         │
│     AND table_name NOT IN ('organizations', 'deletion_audit_log')│
│   GROUP BY table_name                                           │
│                                                                  │
│ DISCOVERED TABLES:                                              │
│   [                                                              │
│     'unassigned_group_members',                                 │
│     'analysis_results',                                         │
│     'screenshots',                                              │
│     'worklogs',                                                 │
│     'activity_log',                                             │
│     'created_issues_log',                                       │
│     'documents',                                                │
│     'unassigned_work_groups',                                   │
│     'feedback',                                                 │
│     'tracking_settings',                                        │
│     'user_jira_issues_cache',                                   │
│     'daily_time_summary',                                       │
│     'weekly_time_summary',                                      │
│     'project_time_summary',                                     │
│     'organization_members',                                     │
│     'organization_settings',                                    │
│     'data_requests',                                            │
│     'users'                                                     │
│   ]                                                              │
│                                                                  │
│ NOTE: New tables with organization_id are automatically included!│
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3C: Sort Tables by FK Dependencies                        │
│ Function: getTableDeletionOrder(tables)                         │
│                                                                  │
│ DELETION ORDER (Child → Parent):                               │
│   1. unassigned_group_members  (has FK to unassigned_work_groups)│
│   2. analysis_results          (has FK to screenshots)          │
│   3. screenshots                                                │
│   4. worklogs                                                   │
│   5. activity_log                                               │
│   ... (middle tables)                                           │
│   17. organization_members                                      │
│   18. users                    (MUST be last - has FKs)        │
│                                                                  │
│ WHY THIS MATTERS:                                               │
│   - Foreign key constraints prevent deletion in wrong order    │
│   - Child records must be deleted before parent records        │
│   - Auto-sorted to prevent FK violations                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3D: Delete Database Records (Table by Table)              │
│                                                                  │
│ FOR EACH TABLE:                                                 │
│                                                                  │
│   DATABASE DELETE:                                              │
│     DELETE FROM <table>                                         │
│     WHERE organization_id = '12345678-...'                     │
│     RETURNING COUNT(*)                                          │
│                                                                  │
│   EXAMPLE - screenshots table:                                 │
│     DELETE FROM screenshots                                     │
│     WHERE organization_id = '12345678-...'                     │
│     // Deleted 587 records                                     │
│                                                                  │
│   EXAMPLE - users table:                                       │
│     DELETE FROM users                                           │
│     WHERE organization_id = '12345678-...'                     │
│     // Deleted 15 records                                      │
│                                                                  │
│   SUMMARY TRACKING:                                             │
│     summary = {                                                 │
│       screenshots: { deleted: 587 },                           │
│       analysis_results: { deleted: 587 },                      │
│       worklogs: { deleted: 234 },                              │
│       users: { deleted: 15 },                                  │
│       ... (all tables)                                          │
│     }                                                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3E: Refresh Materialized Views                            │
│ Function: cleanupMaterializedViews(organizationId)              │
│                                                                  │
│ AUTO-DISCOVER MATERIALIZED VIEWS:                              │
│   SELECT matviewname                                            │
│   FROM pg_matviews                                              │
│   WHERE schemaname = 'public'                                   │
│     AND EXISTS (column_name = 'organization_id')               │
│                                                                  │
│ FOR EACH MATERIALIZED VIEW:                                    │
│   REFRESH MATERIALIZED VIEW <view_name>;                       │
│   // Excludes deleted org's data from aggregated views         │
│                                                                  │
│ SUMMARY:                                                         │
│   summary.materialized_views = {                                │
│     refreshed: ['time_analytics_summary', ...],                │
│     count: 2                                                    │
│   }                                                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3F: Delete Storage Bucket Files                           │
│ Function: deleteStorageFiles(organizationId)                    │
│                                                                  │
│ SUB-STEP 1: Get All User IDs for Organization                 │
│   SELECT id FROM users                                          │
│   WHERE organization_id = '12345678-...'                       │
│   // Result: ['user-1', 'user-2', ...]                        │
│                                                                  │
│ SUB-STEP 2: Auto-Discover All Storage Buckets                 │
│   API: supabase.storage.listBuckets()                          │
│   // Result: ['screenshots', 'documents', 'exports', ...]     │
│                                                                  │
│ SUB-STEP 3: Delete Files (Org-Scoped + User-Scoped)           │
│                                                                  │
│ FOR EACH BUCKET:                                                │
│                                                                  │
│   // Strategy 1: Delete org-scoped files                       │
│   // Path: {organizationId}/*  (including nested folders)      │
│   deleteFilesRecursively(                                       │
│     bucket: "screenshots",                                      │
│     folderPath: "12345678-abcd-..."                            │
│   )                                                              │
│   // Recursively deletes:                                       │
│   //   12345678-abcd-.../user-1/file1.png                      │
│   //   12345678-abcd-.../user-1/file2.png                      │
│   //   12345678-abcd-.../user-2/file1.png                      │
│                                                                  │
│   // Strategy 2: Delete user-scoped files                      │
│   // Path: {userId}/*  (for buckets without org prefix)        │
│   FOR EACH userId:                                              │
│     deleteFilesRecursively(                                     │
│       bucket: "screenshots",                                    │
│       folderPath: userId                                        │
│     )                                                            │
│                                                                  │
│ RECURSIVE DELETION LOGIC:                                       │
│   1. List all files/folders in path                            │
│   2. Delete files at current level                             │
│   3. For each subfolder, recurse into it                       │
│   4. Repeat until all nested files deleted                     │
│                                                                  │
│ SUMMARY:                                                         │
│   summary.storage = {                                           │
│     screenshots: { deleted: 587, errors: 0 },                  │
│     documents: { deleted: 12, errors: 0 },                     │
│     exports: { deleted: 0, errors: 0 }                         │
│   }                                                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3G: Delete Organization Record                            │
│                                                                  │
│ DATABASE DELETE (Final Step):                                  │
│   DELETE FROM organizations                                     │
│   WHERE id = '12345678-...'                                    │
│                                                                  │
│ NOTE: This is done LAST after all child records deleted       │
│                                                                  │
│ SUMMARY:                                                         │
│   summary.organization = { deleted: 1 }                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3H: Update Audit Log to Completed                         │
│                                                                  │
│ DATABASE UPDATE:                                                │
│   UPDATE deletion_audit_log                                     │
│   SET                                                            │
│     status = 'completed',                                      │
│     completed_at = NOW(),                                       │
│     deletion_summary = {                                        │
│       screenshots: { deleted: 587 },                           │
│       users: { deleted: 15 },                                  │
│       ... (full summary)                                        │
│     },                                                          │
│     updated_at = NOW()                                          │
│   WHERE organization_id = '12345678-...'                       │
│                                                                  │
│ RESULT: Permanent audit trail created                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 4: Return Results                                          │
│ Function: processScheduledDeletions() (continued)               │
│                                                                  │
│ OUTPUT:                                                          │
│   {                                                              │
│     success: true,                                              │
│     processed: 1,                                               │
│     succeeded: 1,                                               │
│     failed: 0,                                                  │
│     results: [                                                  │
│       {                                                          │
│         orgId: "12345678-...",                                 │
│         success: true,                                          │
│         summary: {                                              │
│           screenshots: { deleted: 587 },                       │
│           users: { deleted: 15 },                              │
│           storage: {                                            │
│             screenshots: { deleted: 587, errors: 0 }           │
│           },                                                    │
│           organization: { deleted: 1 }                          │
│         }                                                        │
│       }                                                          │
│     ]                                                            │
│   }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

### What Gets Deleted (Comprehensive List)

**Database Tables (18 tables):**
1. `unassigned_group_members` - Clustered work session members
2. `analysis_results` - AI analysis of screenshots
3. `screenshots` - Screenshot metadata
4. `worklogs` - Time tracking worklogs
5. `activity_log` - User activity history
6. `created_issues_log` - Log of Jira issues created
7. `documents` - BRD document metadata
8. `unassigned_work_groups` - Clustered work sessions
9. `feedback` - User feedback submissions
10. `tracking_settings` - Time tracking configuration
11. `user_jira_issues_cache` - Cached Jira issue data
12. `daily_time_summary` - Daily aggregated stats
13. `weekly_time_summary` - Weekly aggregated stats
14. `project_time_summary` - Project aggregated stats
15. `organization_members` - Organization membership records
16. `organization_settings` - Organization configuration
17. `data_requests` - GDPR data export/delete requests
18. `users` - User profiles (deleted last)
19. `organizations` - Organization record (FINAL deletion)

**Storage Buckets:**
- `screenshots/` - All screenshot image files
- `documents/` - All BRD PDF/DOCX files
- `exports/` - Temporary GDPR export files
- `feedback-images/` - User-submitted feedback images

**Materialized Views:**
- Refreshed (not dropped) to exclude deleted org's data

**Forge KVS Cache:**
- `org:{cloudId}` - Cleared during soft delete
- User-specific keys expire naturally (24h TTL)

### What Does NOT Get Deleted

❌ **Deletion audit log entry** - Kept for compliance/audit trail  
❌ **Worklogs synced to Jira** - Jira controls those, outside our scope  
❌ **Anonymized analytics** - If you have aggregate stats  

---

## Reactivation Process

### When Can Reactivation Happen?

**Window:** Within 30 days after uninstall  
**Trigger:** Admin reinstalls the app in Jira

### Complete Reactivation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ STEP 1: Admin Reinstalls App                                   │
│ Location: Jira → Apps → Find Apps → Install "BRD Time Tracker" │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 2: Atlassian Fires Installation Event                     │
│ Event: avi:forge:installed:app                                  │
│ Context: { cloudId, installationId }                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3: Forge Lifecycle Handler                                │
│ File: forge-app/src/index.js                                    │
│ Function: lifecycleHandler()                                    │
│                                                                  │
│ Routes to: handleAppInstalled(event, context)                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 4: Installation Handler                                   │
│ File: forge-app/src/services/lifecycleService.js               │
│ Function: handleAppInstalled()                                  │
│                                                                  │
│ Calls: remoteRequest('/api/forge/organization', { cloudId })  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 5: Get/Create Organization Endpoint                       │
│ File: ai-server/src/controllers/forge-proxy-controller.js      │
│ Function: getOrCreateOrganization()                             │
│                                                                  │
│ DATABASE QUERY:                                                 │
│   SELECT * FROM organizations                                   │
│   WHERE jira_cloud_id = 'b1a2c3d4-...'                         │
│                                                                  │
│ RESULT:                                                          │
│   {                                                              │
│     id: "12345678-...",                                        │
│     org_name: "Acme Corp",                                      │
│     status: "pending_deletion",  ← DETECTED!                  │
│     scheduled_deletion_at: "2026-05-08T10:30:00.000Z",        │
│     uninstalled_at: "2026-04-08T10:30:00.000Z"                │
│   }                                                              │
│                                                                  │
│ NEXT: Calls resolveExistingOrg() helper function              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 6: Reactivation Logic                                     │
│ File: ai-server/src/controllers/forge-proxy-controller.js      │
│ Function: resolveExistingOrg(supabase, existingOrg, ...)       │
│                                                                  │
│ INPUT:                                                           │
│   existingOrg.status = "pending_deletion"                      │
│                                                                  │
│ DETECTION:                                                       │
│   if (existingOrg.status === 'pending_deletion') {            │
│     // REACTIVATE!                                              │
│   }                                                              │
│                                                                  │
│ LOGGING:                                                         │
│   logger.info('Reinstallation detected - reactivating', {      │
│     id: existingOrg.id,                                         │
│     scheduledDeletionAt: existingOrg.scheduled_deletion_at     │
│   });                                                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 6A: Update Organization Status                            │
│                                                                  │
│ DATABASE UPDATE:                                                │
│   UPDATE organizations                                          │
│   SET                                                            │
│     status = 'active',              ← REACTIVATED!            │
│     scheduled_deletion_at = NULL,   ← CLEARED                 │
│     uninstalled_at = NULL,          ← CLEARED                 │
│     updated_at = NOW()                                          │
│   WHERE id = '12345678-...'                                    │
│   RETURNING *                                                   │
│                                                                  │
│ RESULT:                                                          │
│   {                                                              │
│     id: "12345678-...",                                        │
│     org_name: "Acme Corp",                                      │
│     status: "active",               ← NOW ACTIVE!             │
│     scheduled_deletion_at: null,                                │
│     uninstalled_at: null                                        │
│   }                                                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 6B: Cancel Deletion Audit Log                             │
│                                                                  │
│ DATABASE UPDATE:                                                │
│   UPDATE deletion_audit_log                                     │
│   SET                                                            │
│     status = 'cancelled',           ← CANCELLED                │
│     updated_at = NOW()                                          │
│   WHERE organization_id = '12345678-...'                       │
│     AND status = 'pending'                                      │
│                                                                  │
│ RESULT: Deletion request cancelled, data preserved             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ STEP 7: Return Reactivated Organization                        │
│                                                                  │
│ OUTPUT (to Forge app):                                          │
│   {                                                              │
│     success: true,                                              │
│     data: {                                                     │
│       id: "12345678-...",                                      │
│       org_name: "Acme Corp",                                    │
│       status: "active",                                        │
│       scheduled_deletion_at: null,                              │
│       uninstalled_at: null                                      │
│     }                                                            │
│   }                                                              │
│                                                                  │
│ LOGGING (in Forge):                                             │
│   console.log('Reinstallation detected - org was pending deletion')│
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ REACTIVATION COMPLETE                                           │
│ All data restored:                                              │
│   ✅ Users can login to desktop app                            │
│   ✅ All screenshots visible                                    │
│   ✅ All worklogs accessible                                    │
│   ✅ All settings preserved                                     │
│   ✅ No data loss                                               │
└─────────────────────────────────────────────────────────────────┘
```

### What Happens to Data During Reactivation?

**✅ Data That Was Preserved:**
- All users
- All screenshots
- All analysis results
- All worklogs
- All settings
- All documents
- All storage files

**✅ What Gets Updated:**
- Organization status: `pending_deletion` → `active`
- Deletion timestamps: Cleared to `null`
- Audit log: `pending` → `cancelled`

**❌ If Reinstalled After 30 Days:**
- Data already hard deleted
- Fresh start with empty database
- Cannot recover deleted data

---

## All Endpoints

### 1. POST /api/forge/uninstall

**Purpose:** Mark organization for deletion (soft delete)  
**Called By:** Forge lifecycleHandler  
**Authentication:** Forge Invocation Token (FIT)  
**File:** `ai-server/src/controllers/uninstall-controller.js`

**Request:**
```json
POST https://forgesync.amzur.com/api/forge/uninstall
Headers: {
  "Authorization": "Bearer <FIT_TOKEN>",
  "Content-Type": "application/json"
}
Body: {
  "cloudId": "b1a2c3d4-e5f6-7890-abcd-ef1234567890",
  "installationId": "ari:cloud:jira::app/...",
  "uninstalledAt": "2026-04-08T10:30:00.000Z"
}
```

**Response Success (200):**
```json
{
  "success": true,
  "data": {
    "organizationId": "12345678-abcd-efgh-ijkl-1234567890ab",
    "organizationName": "Acme Corp",
    "status": "pending_deletion",
    "scheduledDeletionAt": "2026-05-08T10:30:00.000Z",
    "gracePeriodDays": 30
  }
}
```

**Response Already Pending (200):**
```json
{
  "success": true,
  "data": {
    "organizationId": "12345678-...",
    "organizationName": "Acme Corp",
    "status": "pending_deletion",
    "scheduledDeletionAt": "2026-05-08T10:30:00.000Z",
    "gracePeriodDays": 30,
    "message": "Organization already scheduled for deletion"
  }
}
```

**Response Not Found (404):**
```json
{
  "success": false,
  "error": "Organization not found"
}
```

**Response Auth Error (403):**
```json
{
  "success": false,
  "error": "CloudId mismatch - possible authentication issue"
}
```

---

### 2. POST /api/admin/process-deletions

**Purpose:** Manually trigger hard delete of expired organizations  
**Called By:** Admin/Cron job  
**Authentication:** Admin API token (authMiddleware)  
**File:** `ai-server/src/index.js`

**Request:**
```bash
POST https://forgesync.amzur.com/api/admin/process-deletions
Headers: {
  "Authorization": "Bearer <ADMIN_API_TOKEN>",
  "Content-Type": "application/json"
}
Body: {}  # No body required
```

**Response Success:**
```json
{
  "success": true,
  "processed": 2,
  "succeeded": 2,
  "failed": 0,
  "results": [
    {
      "orgId": "12345678-...",
      "success": true,
      "summary": {
        "screenshots": { "deleted": 587 },
        "users": { "deleted": 15 },
        "storage": {
          "screenshots": { "deleted": 587, "errors": 0 }
        },
        "organization": { "deleted": 1 }
      }
    },
    {
      "orgId": "98765432-...",
      "success": true,
      "summary": { ... }
    }
  ]
}
```

**Response No Pending Deletions:**
```json
{
  "success": true,
  "processed": 0
}
```

**Response Partial Failure:**
```json
{
  "success": true,
  "processed": 2,
  "succeeded": 1,
  "failed": 1,
  "results": [
    { "orgId": "...", "success": true, ... },
    { "orgId": "...", "success": false, "error": "..." }
  ]
}
```

---

### 3. POST /api/forge/organization

**Purpose:** Get or create organization (handles reactivation)  
**Called By:** Forge app during installation or normal operations  
**Authentication:** Forge Invocation Token (FIT)  
**File:** `ai-server/src/controllers/forge-proxy-controller.js`

**Request:**
```json
POST https://forgesync.amzur.com/api/forge/organization
Headers: {
  "Authorization": "Bearer <FIT_TOKEN>",
  "Content-Type": "application/json"
}
Body: {
  "cloudId": "b1a2c3d4-..."
}
```

**Response Normal (200):**
```json
{
  "success": true,
  "data": {
    "id": "12345678-...",
    "org_name": "Acme Corp",
    "jira_cloud_id": "b1a2c3d4-...",
    "status": "active",
    "subscription_status": "active"
  }
}
```

**Response Reactivated (200):**
```json
{
  "success": true,
  "data": {
    "id": "12345678-...",
    "org_name": "Acme Corp",
    "status": "active",  // Was "pending_deletion", now reactivated
    "scheduled_deletion_at": null,  // Cleared
    "uninstalled_at": null  // Cleared
  }
}
```

---

## Summary

### Key Implementation Points

1. **Atlassian Does NOT Poll:** The uninstall event is fire-and-forget
2. **30-Day Grace Period:** YOUR implementation choice, not Atlassian's requirement
3. **Soft Delete First:** Allows data recovery for 30 days
4. **Auto-Discovery:** New tables with `organization_id` are automatically included
5. **Reactivation:** Seamless data restore if reinstalled within 30 days
6. **Audit Trail:** Complete logging in `deletion_audit_log` table
7. **FK-Aware:** Tables deleted in correct order to prevent constraint violations

### Files Modified/Created

**Database:**
- ✅ `supabase/migrations/20260403_add_deletion_lifecycle.sql` (NEW)
- ✅ `supabase/migrations/20260403_add_deletion_lifecycle_ROLLBACK.sql` (NEW)

**Forge App:**
- ✅ `forge-app/manifest.yml` (MODIFIED)
- ✅ `forge-app/src/index.js` (MODIFIED)
- ✅ `forge-app/src/services/lifecycleService.js` (NEW)

**AI Server:**
- ✅ `ai-server/src/controllers/uninstall-controller.js` (NEW)
- ✅ `ai-server/src/services/deletion-service.js` (NEW)
- ✅ `ai-server/src/controllers/forge-proxy-controller.js` (MODIFIED - reactivation)
- ✅ `ai-server/src/index.js` (MODIFIED - route registration)

### Total Lines of Code Added

- **Database:** ~150 lines SQL
- **Forge App:** ~120 lines JavaScript
- **AI Server:** ~600 lines JavaScript
- **Total:** ~870 lines of new code

---

**End of Document**

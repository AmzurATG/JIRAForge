/**
 * Deletion Service
 * Handles scheduled deletion of organization data
 * Called by scheduled job (cron or manual trigger)
 * 
 * IMPORTANT FOR FUTURE DEVELOPMENT:
 * This service automatically discovers tables with organization_id column.
 * When adding new tables, ensure they have organization_id if org-scoped.
 * The service will automatically include them in deletion.
 * 
 * Compliance: GDPR Right to Erasure, Privacy Policy requirements
 * Related: APP_UNINSTALL_DATA_DELETION_PLAN.md
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
    // Query PostgreSQL function to find all tables with organization_id
    const { data, error } = await supabase.rpc('get_org_scoped_tables');

    if (error) {
      logger.error('[Deletion] Failed to discover org-scoped tables, using fallback list', {
        error: error.message
      });
      // Fallback to known tables if discovery fails
      return getFallbackTableList();
    }

    const tables = data.map(row => row.table_name);
    logger.info('[Deletion] Discovered org-scoped tables', { 
      count: tables.length, 
      tables 
    });

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
    // Child tables first (respect FK dependencies)
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
    'data_requests',  // GDPR data export requests
    'users'  // Delete users last (FK dependencies)
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
    'unassigned_group_members': ['unassigned_work_groups'],
    'analysis_results': ['screenshots'],
    'organization_members': ['users'],
    'organization_settings': ['organizations'],
    'data_requests': [], // No FK dependencies
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
      return ['screenshots', 'documents', 'exports', 'feedback-images'];  // Fallback
    }
    cachedBuckets = buckets.map(b => b.name);
    return cachedBuckets;
  } catch (error) {
    logger.warn('[Deletion] Exception listing buckets, using defaults', {
      error: error.message
    });
    return ['screenshots', 'documents', 'exports', 'feedback-images'];
  }
}

/**
 * Recursively delete files from a folder path in a bucket
 * Handles nested folder structures like organizationId/userId/*
 * @param {Object} supabase - Supabase client
 * @param {string} bucket - Bucket name
 * @param {string} folderPath - Folder path to delete from
 * @returns {Promise<number>} Number of files deleted
 */
async function deleteFilesRecursively(supabase, bucket, folderPath) {
  let totalDeleted = 0;
  
  try {
    // List all files in the folder
    const { data: files, error: listError } = await supabase
      .storage
      .from(bucket)
      .list(folderPath, {
        limit: 1000,
        offset: 0
      });

    if (listError || !files || files.length === 0) {
      return 0;
    }

    // Separate files and folders
    const fileItems = files.filter(f => f.id); // Files have an 'id' property
    const folderItems = files.filter(f => !f.id && f.name); // Folders don't have 'id'

    // Delete files in this level
    if (fileItems.length > 0) {
      const filePaths = fileItems.map(file => 
        folderPath ? `${folderPath}/${file.name}` : file.name
      );
      
      const { error: deleteError } = await supabase
        .storage
        .from(bucket)
        .remove(filePaths);

      if (deleteError) {
        logger.error(`[Deletion] Failed to delete files from ${bucket}/${folderPath}`, {
          error: deleteError.message
        });
      } else {
        totalDeleted += filePaths.length;
      }
    }

    // Recursively delete from subfolders
    for (const folder of folderItems) {
      const subPath = folderPath ? `${folderPath}/${folder.name}` : folder.name;
      const subDeleted = await deleteFilesRecursively(supabase, bucket, subPath);
      totalDeleted += subDeleted;
    }

  } catch (error) {
    logger.error(`[Deletion] Error deleting recursively from ${bucket}/${folderPath}`, {
      error: error.message
    });
  }

  return totalDeleted;
}

/**
 * Delete all storage files for an organization
 * AUTO-DISCOVERS all storage buckets and deletes org-scoped files
 * Handles nested folder structures: organizationId/userId/*, organizationId/*, userId/*
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
        // Strategy 1: Try org-scoped deletion (organizationId/* including nested userId folders)
        const orgDeleted = await deleteFilesRecursively(supabase, bucket, organizationId);
        if (orgDeleted > 0) {
          storageSummary[bucket].deleted += orgDeleted;
          logger.info(`[Deletion] Deleted ${orgDeleted} org-scoped files from ${bucket} (including nested folders)`);
        }

        // Strategy 2: Try user-scoped deletion (userId/* for buckets without org prefix)
        for (const userId of userIds) {
          const userDeleted = await deleteFilesRecursively(supabase, bucket, userId);
          if (userDeleted > 0) {
            storageSummary[bucket].deleted += userDeleted;
            logger.info(`[Deletion] Deleted ${userDeleted} user-scoped files from ${bucket} for user ${userId}`);
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
 * Clean up materialized views containing org data
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
        // Refresh the materialized view (safe - excludes deleted org's data)
        await supabase.rpc('refresh_matview', { view_name: viewName });
        summary.refreshed.push(viewName);
        logger.info(`[Deletion] Refreshed materialized view ${viewName}`);
      } catch (error) {
        logger.warn(`[Deletion] Could not refresh materialized view ${viewName}`, {
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
 * Delete a single organization's data
 * Deletes all data in the correct cascading order
 * @param {Object} org - Organization record from deletion_audit_log
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
        // Use count to avoid fetching full rows - more efficient for large datasets
        const { count, error } = await supabase
          .from(table)
          .delete({ count: 'exact' })
          .eq('organization_id', organizationId);

        if (error) {
          logger.error(`[Deletion] Failed to delete from ${table}`, {
            orgId: organizationId,
            error: error.message
          });
          summary[table] = { deleted: 0, error: error.message };
        } else {
          summary[table] = { deleted: count || 0 };
          if (count > 0) {
            logger.info(`[Deletion] Deleted ${count} records from ${table}`);
          }
        }
      } catch (error) {
        logger.error(`[Deletion] Exception deleting from ${table}`, {
          orgId: organizationId,
          error: error.message
        });
        summary[table] = { deleted: 0, error: error.message };
      }
    }

    // Step 3: Delete/Refresh materialized views with org data
    const matViewSummary = await cleanupMaterializedViews(organizationId);
    if (matViewSummary.count > 0) {
      summary.materialized_views = matViewSummary;
    }

    // Step 4: Delete storage bucket files
    const storageSummary = await deleteStorageFiles(organizationId);
    summary.storage = storageSummary;

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

    // Step 6: Update audit log with completion
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
 * Process all organizations pending deletion
 * Called by scheduled job
 */
async function processScheduledDeletions() {
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
      count: pendingOrgs.length
    });

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
}

module.exports = {
  deleteOrganizationData,
  deleteStorageFiles,
  processScheduledDeletions,
  cleanupMaterializedViews,
  discoverOrgScopedTables  // Export for testing
};

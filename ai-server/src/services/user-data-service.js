/**
 * User Data Service
 * Core business logic for personal data export and deletion (GDPR compliance)
 * Implements Atlassian's Personal Data Reporting API requirements
 * 
 * @module services/user-data-service
 */

'use strict';

const { getClient } = require('./db/supabase-client');
const logger = require('../utils/logger');
const crypto = require('crypto');
const userDataConfig = require('../config/user-data-config');

/**
 * Get status of existing data request
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira cloud instance ID
 * @param {string} requestType - 'export' or 'delete'
 * @returns {Promise<Object|null>} Request object or null if not found
 */
async function getRequestStatus(accountId, cloudId, requestType) {
  try {
    const supabase = getClient();
    
    const { data, error } = await supabase
      .from('data_requests')
      .select('*')
      .eq('account_id', accountId)
      .eq('cloud_id', cloudId)
      .eq('request_type', requestType)
      .in('status', ['pending', 'processing', 'completed', 'failed'])
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') { // PGRST116 = not found
      throw new Error(`Failed to check request status: ${error.message}`);
    }

    return data;
  } catch (error) {
    logger.error('[UserData] Error checking request status:', error);
    throw error;
  }
}

/**
 * Create new data request
 * Idempotent: If an active request already exists, returns it instead of failing
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira cloud instance ID
 * @param {string} requestType - 'export' or 'delete'
 * @returns {Promise<Object>} Created or existing request object
 */
async function createRequest(accountId, cloudId, requestType) {
  try {
    const supabase = getClient();
    
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
      // Check if this is a unique constraint violation (duplicate active request)
      if (error.code === '23505' || error.message?.includes('duplicate') || error.message?.includes('unique')) {
        // Fetch and return the existing active request
        logger.info('[UserData] Active request already exists, returning existing request');
        const existingRequest = await getRequestStatus(accountId, cloudId, requestType);
        if (existingRequest) {
          return existingRequest;
        }
      }
      throw new Error(`Failed to create request: ${error.message}`);
    }

    logger.info('[UserData] Created new request:', {
      requestId: data.id,
      requestType,
      accountId: accountId.substring(0, 10) + '...'
    });

    return data;
  } catch (error) {
    logger.error('[UserData] Error creating request:', error);
    throw error;
  }
}

/**
 * Update request status
 * @param {string} requestId - Request UUID
 * @param {string} status - New status ('pending', 'processing', 'completed', 'failed')
 * @param {Object} additionalFields - Additional fields to update
 * @returns {Promise<Object>} Updated request object
 */
async function updateRequestStatus(requestId, status, additionalFields = {}) {
  try {
    const supabase = getClient();
    
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

    logger.info('[UserData] Updated request status:', {
      requestId,
      status,
      hasResult: !!additionalFields.result_url || !!additionalFields.result_data
    });

    return data;
  } catch (error) {
    logger.error('[UserData] Error updating request status:', error);
    throw error;
  }
}

/**
 * Get user by Atlassian account ID
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Object>} User object
 */
async function getUserByAccountId(accountId) {
  const supabase = getClient();
  
  const { data: user, error } = await supabase
    .from('users')
    .select('id, organization_id, atlassian_account_id, email, display_name, created_at, last_sync_at, is_active, settings, desktop_app_version, desktop_last_heartbeat')
    .eq('atlassian_account_id', accountId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch user: ${error.message}`);
  }

  if (!user) {
    throw new Error(`User not found: ${accountId}`);
  }

  return user;
}

/**
 * Discover all tables with user_id column dynamically
 * 
 * ✅ DYNAMIC SOLUTION (April 2026)
 * This function automatically discovers ALL tables with user_id column.
 * When you add new tables in the future, they'll be automatically included!
 * 
 * @returns {Promise<Array<string>>} List of table names
 */
async function discoverUserDataTables() {
  try {
    const supabase = getClient();
    
    // Call the database function to discover tables
    const { data, error } = await supabase.rpc('discover_user_data_tables');
    
    if (error) {
      logger.error('[UserData] Failed to discover tables:', error);
      // Fallback to configuration if discovery fails
      return userDataConfig.deletionOrder;
    }
    
    // Extract table names and filter out excluded tables
    const tables = data
      .map(row => row.table_name)
      .filter(table => !userDataConfig.isExcluded(table));
    
    logger.info('[UserData] Discovered user data tables:', {
      count: tables.length,
      tables: tables
    });
    
    return tables;
  } catch (error) {
    logger.error('[UserData] Error in table discovery:', error);
    // Fallback to configuration
    return userDataConfig.deletionOrder;
  }
}

/**
 * Export data from a single table dynamically
 * 
 * @param {Object} supabase - Supabase client
 * @param {string} tableName - Table name to export from
 * @param {string} userId - User UUID
 * @returns {Promise<Object>} Export result { tableName, data, count }
 */
async function exportFromTable(supabase, tableName, userId) {
  try {
    const rowLimit = userDataConfig.getExportRowLimit(tableName);
    
    const { data, error, count } = await supabase
      .from(tableName)
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .limit(rowLimit);
    
    if (error) {
      logger.warn(`[UserData] Failed to export from ${tableName}:`, error.message);
      return { tableName, data: [], count: 0, error: error.message };
    }
    
    logger.info(`[UserData] Exported from ${tableName}:`, { 
      rows: data?.length || 0,
      total: count 
    });
    
    return { 
      tableName, 
      data: data || [], 
      count: data?.length || 0,
      totalAvailable: count 
    };
  } catch (error) {
    logger.error(`[UserData] Error exporting from ${tableName}:`, error);
    return { tableName, data: [], count: 0, error: error.message };
  }
}

/**
 * Delete data from a single table dynamically
 * 
 * @param {Object} supabase - Supabase client
 * @param {string} tableName - Table name to delete from
 * @param {string} userId - User UUID
 * @returns {Promise<Object>} Deletion result { tableName, count, error? }
 */
async function deleteFromTable(supabase, tableName, userId) {
  try {
    // Check if table should be anonymized instead
    if (userDataConfig.shouldAnonymize(tableName)) {
      const anonymizeConfig = userDataConfig.anonymizeTables[tableName];
      const { count, error } = await supabase
        .from(tableName)
        .update({
          ...anonymizeConfig.anonymize,
          ...(anonymizeConfig.redactEventData ? {
            event_data: { redacted: true, reason: 'user_data_deletion' }
          } : {})
        })
        .eq('user_id', userId);
      
      if (error) {
        throw error;
      }
      
      logger.info(`[UserData] Anonymized ${tableName}:`, { rows: count });
      return { tableName, count: count || 0, action: 'anonymized' };
    }
    
    // Regular deletion
    const { count, error } = await supabase
      .from(tableName)
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    
    if (error) {
      throw error;
    }
    
    logger.info(`[UserData] Deleted from ${tableName}:`, { rows: count });
    return { tableName, count: count || 0, action: 'deleted' };
  } catch (error) {
    logger.error(`[UserData] Error deleting from ${tableName}:`, error);
    return { tableName, count: 0, error: error.message };
  }
}

/**
 * Export all user personal data (DYNAMIC VERSION)
 * 
 * ✅ NOW USES DYNAMIC TABLE DISCOVERY!
 * This function automatically detects all tables with user_id column.
 * When you add new tables, they'll be included automatically!
 * 
 * Configuration handled in: ai-server/src/config/user-data-config.js
 * - Deletion order for FK constraints
 * - Storage bucket associations
 * - Row limits for large tables
 * - Special handling rules
 * 
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira cloud instance ID
 * @returns {Promise<Object>} Export data object
 */
async function exportUserData(accountId, cloudId) {
  try {
    const supabase = getClient();
    
    // 1. Get user record
    const user = await getUserByAccountId(accountId);
    const userId = user.id;

    logger.info('[UserData] Exporting data for user:', {
      userId,
      accountId: accountId.substring(0, 10) + '...'
    });

    // 2. Build export data structure
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
      },
      tables: {},
      tableSummary: {}
    };

    // 3. Discover all tables with user_id dynamically
    const userDataTables = await discoverUserDataTables();
    logger.info('[UserData] Exporting from tables:', { count: userDataTables.length }); 

    // 4. Export from each table dynamically
    for (const tableName of userDataTables) {
      // Skip 'users' table - already exported above
      if (tableName === 'users') continue;
      
      // Handle organization_members specially (needs JOIN)
      if (tableName === 'organization_members') {
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
        
        exportData.tables.organizationMemberships = (orgMembers || []).map(om => ({
          organizationId: om.organization_id,
          orgName: om.organization?.org_name,
          jiraCloudId: om.organization?.jira_cloud_id,
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
        exportData.tableSummary.organizationMemberships = orgMembers?.length || 0;
        continue;
      }
      
      // Export from table dynamically
      const result = await exportFromTable(supabase, tableName, userId);
      exportData.tables[tableName] = result.data;
      exportData.tableSummary[tableName] = {
        count: result.count,
        totalAvailable: result.totalAvailable,
        error: result.error
      };
    }

    // 5. Storage files (generate signed URLs)
    const storageSummary = await exportStorageFiles(userId, user.organization_id);
    exportData.storageSummary = storageSummary;

    // 6. Add backward compatibility aliases for common tables
    // This ensures existing code expecting specific properties still works
    exportData.screenshots = exportData.tables.screenshots || [];
    exportData.screenshotCount = exportData.tableSummary.screenshots?.count || 0;
    exportData.analysisResults = exportData.tables.analysis_results || [];
    exportData.analysisResultCount = exportData.tableSummary.analysis_results?.count || 0;
    exportData.activityRecords = exportData.tables.activity_records || [];
    exportData.activityRecordCount = exportData.tableSummary.activity_records?.count || 0;
    exportData.worklogs = exportData.tables.worklogs || [];
    exportData.worklogCount = exportData.tableSummary.worklogs?.count || 0;
    exportData.documents = exportData.tables.documents || [];
    exportData.documentCount = exportData.tableSummary.documents?.count || 0;

    logger.info('[UserData] Export completed:', {
      userId,
      tablesExported: Object.keys(exportData.tables).length,
      totalRecords: Object.values(exportData.tableSummary).reduce((sum, t) => sum + (t.count || 0), 0),
      storageFiles: storageSummary.totalFiles
    });

    return exportData;
  } catch (error) {
    logger.error('[UserData] Export failed:', error);
    throw error;
  }
}

/**
 * Export storage files (generate signed URLs)
 * @param {string} userId - User UUID
 * @param {string|null} organizationId - Organization UUID (can be null for old users)
 * @returns {Promise<Object>} Storage summary with signed URLs
 */
async function exportStorageFiles(userId, organizationId) {
  const supabase = getClient();
  const summary = {
    totalScreenshots: 0,
    totalDocuments: 0,
    totalFeedbackImages: 0,
    totalFiles: 0,
    totalStorageMB: 0,
    screenshotFiles: [],
    documentFiles: [],
    feedbackImageFiles: []
  };

  try {
    // Screenshots bucket - handle both org-scoped and legacy user-only paths
    const screenshotPaths = [];
    if (organizationId) {
      screenshotPaths.push(`${organizationId}/${userId}`);
    }
    screenshotPaths.push(userId); // Legacy path

    for (const basePath of screenshotPaths) {
      const { data: screenshotFiles, error } = await supabase.storage
        .from('screenshots')
        .list(basePath, { limit: 10000 });

      if (!error && screenshotFiles && screenshotFiles.length > 0) {
        for (const file of screenshotFiles) {
          const fullPath = `${basePath}/${file.name}`;
          const { data: signedUrl } = await supabase.storage
            .from('screenshots')
            .createSignedUrl(fullPath, 86400); // 24hr expiry

          summary.screenshotFiles.push({
            path: fullPath,
            name: file.name,
            sizeBytes: file.metadata?.size || 0,
            url: signedUrl?.signedUrl
          });
          summary.totalStorageMB += (file.metadata?.size || 0) / 1024 / 1024;
        }
        summary.totalScreenshots += screenshotFiles.length;
      }
    }

    // Documents bucket
    const documentPaths = [];
    if (organizationId) {
      documentPaths.push(`${organizationId}/${userId}`);
    }
    documentPaths.push(userId);

    for (const basePath of documentPaths) {
      const { data: documentFiles, error } = await supabase.storage
        .from('documents')
        .list(basePath, { limit: 1000 });

      if (!error && documentFiles && documentFiles.length > 0) {
        for (const file of documentFiles) {
          const fullPath = `${basePath}/${file.name}`;
          const { data: signedUrl } = await supabase.storage
            .from('documents')
            .createSignedUrl(fullPath, 86400);

          summary.documentFiles.push({
            path: fullPath,
            name: file.name,
            sizeBytes: file.metadata?.size || 0,
            url: signedUrl?.signedUrl
          });
          summary.totalStorageMB += (file.metadata?.size || 0) / 1024 / 1024;
        }
        summary.totalDocuments += documentFiles.length;
      }
    }

    // Feedback images bucket (no org prefix)
    const { data: feedbackFiles, error: feedbackError } = await supabase.storage
      .from('feedback-images')
      .list(userId, { limit: 1000 });

    if (!feedbackError && feedbackFiles && feedbackFiles.length > 0) {
      for (const file of feedbackFiles) {
        const fullPath = `${userId}/${file.name}`;
        const { data: signedUrl } = await supabase.storage
          .from('feedback-images')
          .createSignedUrl(fullPath, 86400);

        summary.feedbackImageFiles.push({
          path: fullPath,
          name: file.name,
          sizeBytes: file.metadata?.size || 0,
          url: signedUrl?.signedUrl
        });
        summary.totalStorageMB += (file.metadata?.size || 0) / 1024 / 1024;
      }
      summary.totalFeedbackImages += feedbackFiles.length;
    }

    summary.totalFiles = summary.totalScreenshots + summary.totalDocuments + summary.totalFeedbackImages;

    logger.info('[UserData] Storage files exported:', {
      userId,
      totalFiles: summary.totalFiles,
      totalStorageMB: summary.totalStorageMB.toFixed(2)
    });

  } catch (error) {
    logger.error('[UserData] Error exporting storage files:', error);
    // Don't throw - return partial data
  }

  return summary;
}

/**
 * Generate signed URL for export data
 * Uploads export JSON to temporary exports bucket
 * @param {Object} exportData - Export data object
 * @param {string} requestId - Request UUID
 * @returns {Promise<string>} Signed URL (24hr expiry)
 */
async function generateSignedUrlForExport(exportData, requestId) {
  try {
    const supabase = getClient();
    const fileName = `export_${requestId}_${Date.now()}.json`;
    const jsonContent = JSON.stringify(exportData, null, 2);
    const contentBuffer = Buffer.from(jsonContent, 'utf-8');

    logger.info('[UserData] Uploading export data:', {
      requestId,
      fileName,
      sizeKB: (contentBuffer.length / 1024).toFixed(2)
    });

    // Upload to exports bucket (auto-cleanup configured via lifecycle policy)
    const { data, error } = await supabase.storage
      .from('exports')
      .upload(fileName, contentBuffer, {
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

    logger.info('[UserData] Export data uploaded successfully:', {
      requestId,
      signedUrl: signedUrl.signedUrl.substring(0, 50) + '...'
    });

    return signedUrl.signedUrl;
  } catch (error) {
    logger.error('[UserData] Error generating signed URL:', error);
    throw error;
  }
}

/**
 * Permanently delete all user personal data (DYNAMIC VERSION)
 * 
 * ✅ NOW USES DYNAMIC TABLE DISCOVERY!
 * This function automatically detects all tables with user_id column.
 * When you add new tables, they'll be included automatically!
 * 
 * DELETION PROCESS:
 * 1. Delete storage files first (preserves DB references for verification)
 * 2. Discover all tables with user_id dynamically
 * 3. Sort tables by configured deletion order (prevents FK violations)
 * 4. Delete from each table (some are anonymized, not deleted)
 * 5. Create audit log entry
 * 
 * Configuration handled in: ai-server/src/config/user-data-config.js
 * - deletionOrder: Defines sequence to avoid FK violations
 * - anonymizeTables: Tables to anonymize instead of delete (audit logs)
 * - storageAssociations: Which files to delete from storage
 * 
 * IMPORTANT:
 * - If you add a new table with foreign key constraints, add it to
 *   the deletionOrder array in user-data-config.js
 * - 'users' table MUST be deleted last (CASCADE cleans up stragglers)
 * 
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira cloud instance ID
 * @returns {Promise<Object>} Deletion summary
 */
async function deleteUserData(accountId, cloudId) {
  const deletionSummary = {
    recordsDeleted: {},
    filesDeleted: 0,
    deletedAt: new Date().toISOString()
  };

  try {
    const supabase = getClient();
    
    // 1. Get user record
    const user = await getUserByAccountId(accountId);
    const userId = user.id;
    const organizationId = user.organization_id;

    logger.info('[UserData] Starting deletion for user:', {
      userId,
      accountId: accountId.substring(0, 10) + '...',
      organizationId
    });

    // 2. Delete storage files FIRST (before database records to preserve references)
    const filesDeleted = await deleteStorageFiles(userId, organizationId);
    deletionSummary.filesDeleted = filesDeleted;

    // 3. Discover all tables with user_id dynamically
    const userDataTables = await discoverUserDataTables();
    
    // 4. Sort tables by deletion order (critical for FK constraints!)
    const sortedTables = userDataTables.sort((a, b) => {
      return userDataConfig.getDeletionOrderIndex(a) - userDataConfig.getDeletionOrderIndex(b);
    });
    
    logger.info('[UserData] Deleting from tables in order:', {
      tables: sortedTables
    });

    // 5. Delete from each table in order
    for (const tableName of sortedTables) {
      const result = await deleteFromTable(supabase, tableName, userId);
      
      if (result.action === 'anonymized') {
        deletionSummary.recordsDeleted[`${tableName}_anonymized`] = result.count;
      } else {
        deletionSummary.recordsDeleted[tableName] = result.count;
      }
      
      if (result.error) {
        logger.warn(`[UserData] Error deleting from ${tableName}:`, result.error);
        deletionSummary.recordsDeleted[`${tableName}_error`] = result.error;
      }
    }

    // 6. Create audit log entry (after user deletion, so user_id is null)
    await supabase
      .from('activity_log')
      .insert({
        user_id: null, // User is deleted
        organization_id: organizationId,
        event_type: 'user_data_deletion',
        event_data: {
          atlassian_account_id_hash: crypto.createHash('sha256').update(accountId).digest('hex').substring(0, 16),
          cloud_id: cloudId,
          deletion_summary: deletionSummary,
          timestamp: new Date().toISOString()
        }
      });

    logger.info('[UserData] Deletion completed:', {
      userId,
      totalRecordsDeleted: Object.values(deletionSummary.recordsDeleted).reduce((a, b) => a + b, 0),
      filesDeleted: deletionSummary.filesDeleted
    });

    return deletionSummary;

  } catch (error) {
    logger.error('[UserData] Deletion failed:', error);
    throw error;
  }
}

/**
 * Delete all storage files for a user
 * @param {string} userId - User UUID
 * @param {string|null} organizationId - Organization UUID (can be null)
 * @returns {Promise<number>} Total files deleted
 */
async function deleteStorageFiles(userId, organizationId) {
  const supabase = getClient();
  let totalDeleted = 0;

  try {
    // Screenshots bucket - handle both org-scoped and legacy paths
    const screenshotPaths = [];
    if (organizationId) {
      screenshotPaths.push(`${organizationId}/${userId}`);
    }
    screenshotPaths.push(userId); // Legacy path

    for (const basePath of screenshotPaths) {
      const { data: screenshotFiles } = await supabase.storage
        .from('screenshots')
        .list(basePath, { limit: 10000 });

      if (screenshotFiles && screenshotFiles.length > 0) {
        const filePaths = screenshotFiles.map(f => `${basePath}/${f.name}`);
        const { error } = await supabase.storage
          .from('screenshots')
          .remove(filePaths);
        
        if (!error) {
          totalDeleted += filePaths.length;
          logger.info('[UserData] Deleted screenshot files:', { count: filePaths.length, basePath });
        } else {
          logger.error('[UserData] Error deleting screenshot files:', error);
        }
      }
    }

    // Documents bucket
    const documentPaths = [];
    if (organizationId) {
      documentPaths.push(`${organizationId}/${userId}`);
    }
    documentPaths.push(userId);

    for (const basePath of documentPaths) {
      const { data: documentFiles } = await supabase.storage
        .from('documents')
        .list(basePath, { limit: 1000 });

      if (documentFiles && documentFiles.length > 0) {
        const filePaths = documentFiles.map(f => `${basePath}/${f.name}`);
        const { error } = await supabase.storage
          .from('documents')
          .remove(filePaths);
        
        if (!error) {
          totalDeleted += filePaths.length;
          logger.info('[UserData] Deleted document files:', { count: filePaths.length, basePath });
        } else {
          logger.error('[UserData] Error deleting document files:', error);
        }
      }
    }

    // Feedback images bucket (no org prefix)
    const { data: feedbackFiles } = await supabase.storage
      .from('feedback-images')
      .list(userId, { limit: 1000 });

    if (feedbackFiles && feedbackFiles.length > 0) {
      const filePaths = feedbackFiles.map(f => `${userId}/${f.name}`);
      const { error } = await supabase.storage
        .from('feedback-images')
        .remove(filePaths);
      
      if (!error) {
        totalDeleted += filePaths.length;
        logger.info('[UserData] Deleted feedback image files:', { count: filePaths.length });
      } else {
        logger.error('[UserData] Error deleting feedback image files:', error);
      }
    }

    logger.info('[UserData] Total storage files deleted:', { totalDeleted, userId });

  } catch (error) {
    logger.error('[UserData] Error deleting storage files:', error);
    // Don't throw - allow deletion to continue even if storage cleanup fails
  }

  return totalDeleted;
}

module.exports = {
  getRequestStatus,
  createRequest,
  updateRequestStatus,
  exportUserData,
  generateSignedUrlForExport,
  deleteUserData,
  deleteStorageFiles
};

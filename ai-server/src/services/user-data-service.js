/**
 * User Data Service
 * Core business logic for personal data export and deletion (GDPR compliance)
 * Implements Atlassian's Personal Data Reporting API requirements
 * 
 * @module services/user-data-service
 */

'use strict';

const { getClient } = require('./db/supabase-client');
const { deleteFile } = require('./db/storage-service');
const logger = require('../utils/logger');
const crypto = require('crypto');

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
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira cloud instance ID
 * @param {string} requestType - 'export' or 'delete'
 * @returns {Promise<Object>} Created request object
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
 * Export all user personal data
 * 
 * ⚠️ CRITICAL MAINTENANCE WARNING ⚠️
 * This function exports data from a HARDCODED list of tables.
 * When adding NEW tables with user data, you MUST update this function!
 * 
 * CURRENT TABLE LIST (as of April 2026):
 * ✓ users
 * ✓ organization_members
 * ✓ screenshots
 * ✓ analysis_results
 * ✓ activity_records
 * ✓ worklogs
 * ✓ documents
 * ✓ feedback
 * ✓ tracking_settings
 * ✓ notification_preferences
 * ✓ activity_log
 * ✓ user_jira_issues_cache
 * ✓ unassigned_activity
 * ✓ worklog_sync
 * ✓ notification_logs
 * ✓ notification_cooldowns
 * 
 * STORAGE BUCKETS:
 * ✓ screenshots (org_id/user_id/* and user_id/*)
 * ✓ documents (org_id/user_id/* and user_id/*)
 * ✓ feedback-images (user_id/*)
 * 
 * CHECKLIST WHEN ADDING NEW TABLES WITH user_id COLUMN:
 * [ ] Add export query in this function (section by section)
 * [ ] Add deletion query in deleteUserData() function
 * [ ] Update export data structure
 * [ ] Update documentation (PERSONAL_DATA_REPORTING_API_README.md)
 * [ ] Update implementation plan data coverage section
 * [ ] Test export includes new table data
 * [ ] Test deletion removes new table data
 * [ ] Update Privacy Policy if data type is new
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

    // 4. Screenshots
    const { data: screenshots } = await supabase
      .from('screenshots')
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false })
      .limit(10000); // Safety limit

    exportData.screenshots = screenshots || [];
    exportData.screenshotCount = screenshots?.length || 0;

    // 5. Analysis results
    const { data: analysisResults } = await supabase
      .from('analysis_results')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10000);

    exportData.analysisResults = analysisResults || [];
    exportData.analysisResultCount = analysisResults?.length || 0;

    // 6. Activity records
    const { data: activityRecords } = await supabase
      .from('activity_records')
      .select('*')
      .eq('user_id', userId)
      .order('session_start', { ascending: false })
      .limit(10000);

    exportData.activityRecords = activityRecords || [];
    exportData.activityRecordCount = activityRecords?.length || 0;

    // 7. Worklogs
    const { data: worklogs } = await supabase
      .from('worklogs')
      .select('*')
      .eq('user_id', userId)
      .order('started_at', { ascending: false })
      .limit(10000);

    exportData.worklogs = worklogs || [];
    exportData.worklogCount = worklogs?.length || 0;

    // 8. Documents
    const { data: documents } = await supabase
      .from('documents')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    exportData.documents = documents || [];
    exportData.documentCount = documents?.length || 0;

    // 9. Feedback
    const { data: feedback } = await supabase
      .from('feedback')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    exportData.feedback = feedback || [];
    exportData.feedbackCount = feedback?.length || 0;

    // 10. Tracking settings
    const { data: trackingSettings } = await supabase
      .from('tracking_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    exportData.trackingSettings = trackingSettings || null;

    // 11. Notification preferences
    const { data: notificationPrefs } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    exportData.notificationPreferences = notificationPrefs || null;

    // 12. Activity log (limited to last 1000 entries, sanitized)
    const { data: activityLog } = await supabase
      .from('activity_log')
      .select('id, event_type, event_data, ip_address, user_agent, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1000);

    exportData.activityLog = activityLog || [];
    exportData.activityLogCount = activityLog?.length || 0;

    // 13. User Jira issues cache
    const { data: issuesCache } = await supabase
      .from('user_jira_issues_cache')
      .select('*')
      .eq('user_id', userId);

    exportData.cachedJiraIssues = issuesCache || [];
    exportData.cachedJiraIssueCount = issuesCache?.length || 0;

    // 14. Unassigned activity
    const { data: unassignedActivity } = await supabase
      .from('unassigned_activity')
      .select('*')
      .eq('user_id', userId);

    exportData.unassignedActivity = unassignedActivity || [];
    exportData.unassignedActivityCount = unassignedActivity?.length || 0;

    // 15. Worklog sync state
    const { data: worklogSync } = await supabase
      .from('worklog_sync')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    exportData.worklogSync = worklogSync || null;

    // 16. Notification logs (last 1000)
    const { data: notificationLogs } = await supabase
      .from('notification_logs')
      .select('*')
      .eq('user_id', userId)
      .order('sent_at', { ascending: false })
      .limit(1000);

    exportData.notificationLogs = notificationLogs || [];
    exportData.notificationLogCount = notificationLogs?.length || 0;

    // 17. Notification cooldowns
    const { data: notificationCooldowns } = await supabase
      .from('notification_cooldowns')
      .select('*')
      .eq('user_id', userId);

    exportData.notificationCooldowns = notificationCooldowns || [];

    // 18. Storage files (generate signed URLs)
    const storageSummary = await exportStorageFiles(userId, user.organization_id);
    exportData.storageSummary = storageSummary;

    logger.info('[UserData] Export completed:', {
      userId,
      totalRecords: {
        screenshots: exportData.screenshotCount,
        analysisResults: exportData.analysisResultCount,
        activityRecords: exportData.activityRecordCount,
        worklogs: exportData.worklogCount,
        documents: exportData.documentCount,
        storageFiles: storageSummary.totalFiles
      }
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
 * Permanently delete all user personal data
 * 
 * ⚠️ CRITICAL MAINTENANCE WARNING ⚠️
 * This function deletes data from a HARDCODED list of tables.
 * When adding NEW tables with user data, you MUST update this function!
 * 
 * DELETION ORDER (child → parent to avoid FK violations):
 * 1. activity_records
 * 2. unassigned_activity
 * 3. analysis_results (FK to screenshots)
 * 4. screenshots
 * 5. worklogs
 * 6. documents
 * 7. feedback
 * 8. tracking_settings
 * 9. worklog_sync
 * 10. user_jira_issues_cache
 * 11. notification_logs
 * 12. notification_preferences
 * 13. notification_cooldowns
 * 14. organization_members
 * 15. activity_log (anonymize, don't delete)
 * 16. users (CASCADE handles remaining)
 * 
 * STORAGE FILES DELETED FIRST (before DB records):
 * - screenshots/* (all paths)
 * - documents/* (all paths)
 * - feedback-images/*
 * 
 * CHECKLIST WHEN ADDING NEW TABLES WITH user_id:
 * [ ] Add deletion query in correct order (child before parent)
 * [ ] Add to deletion summary recordsDeleted object
 * [ ] If table has storage files, delete in deleteStorageFiles()
 * [ ] Test deletion removes all data for user
 * [ ] Verify CASCADE relationships are correct
 * [ ] Update exportUserData() function
 * [ ] Update documentation
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

    // 3. Delete database records in correct order (child → parent to avoid FK violations)
    
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

    // Delete analysis results (FK to screenshots, so delete before screenshots)
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
        event_data: { redacted: true, reason: 'user_data_deletion' }
      })
      .eq('user_id', userId);
    deletionSummary.recordsDeleted.activity_log_anonymized = activityLogCount || 0;

    // Delete user record (CASCADE will handle any remaining FKs)
    const { count: usersCount } = await supabase
      .from('users')
      .delete({ count: 'exact' })
      .eq('id', userId);
    deletionSummary.recordsDeleted.users = usersCount || 0;

    // 4. Create audit log entry (after user deletion, so user_id is null)
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

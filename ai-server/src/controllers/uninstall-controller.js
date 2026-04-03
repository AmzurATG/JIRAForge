/**
 * Uninstall Controller
 * Handles app uninstallation and data deletion workflow
 * 
 * Routes:
 * - POST /api/forge/uninstall (Forge-authenticated)
 * 
 * Compliance: GDPR Right to Erasure, Privacy Policy requirements
 * Related: APP_UNINSTALL_DATA_DELETION_PLAN.md
 */

const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');

/**
 * Handle app uninstallation
 * POST /api/forge/uninstall (Forge-authenticated)
 * 
 * Marks the organization for deletion with a 30-day grace period
 * Actual deletion is performed by scheduled cleanup job
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
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

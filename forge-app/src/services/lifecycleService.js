/**
 * Lifecycle Service
 * Handles app installation and uninstallation events
 * 
 * Called when:
 * - App is installed on a Jira site (avi:forge:installed:app)
 * - App is uninstalled from a Jira site (avi:forge:uninstalled:app)
 * 
 * Compliance: GDPR Right to Erasure, Privacy Policy requirements
 * Related: APP_UNINSTALL_DATA_DELETION_PLAN.md
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
 * 
 * Note: Forge KVS doesn't support key enumeration, so we can only
 * delete known key patterns. User-specific keys will expire naturally
 * via their 24-hour TTL.
 * 
 * @param {string} cloudId - Jira Cloud ID
 */
async function clearSiteCache(cloudId) {
  try {
    // List of known cache key patterns for this site
    const keysToDelete = [
      `org:${cloudId}`,
      // Note: User-specific keys like `user:{accountId}:{cloudId}` and
      // `analytics:perms:{accountId}` will expire naturally (24h TTL)
      // We can't enumerate them because Forge KVS has no listKeys() API
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

import { remoteRequest } from '../utils/remote.js';
import { kvs } from '@forge/kvs';

/**
 * Handle app installation
 * Called when the app is installed on a Jira site
 */
export async function handleAppInstalled(event, context) {
  const cloudId = context?.cloudId;

  console.log('[Lifecycle] App installed', {
    cloudId,
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

    // If reinstalled within grace period, AI server reactivates the org automatically
    if (result.previousStatus === 'pending_deletion') {
      console.log('[Lifecycle] Reinstallation detected — organization was pending deletion, now reactivated', {
        organizationId: result.id
      });
    }

    return { success: true, organizationId: result.id };
  } catch (error) {
    console.error('[Lifecycle] Failed to record installation:', error);
    // Don't throw — installation should succeed even if tracking fails
    return { success: false, error: error.message };
  }
}

/**
 * Handle app uninstallation
 * Called when the app is uninstalled from a Jira site
 * Triggers data deletion workflow with 30-day grace period
 */
export async function handleAppUninstalled(event, context) {
  const cloudId = context?.cloudId;

  console.log('[Lifecycle] App uninstalled', {
    cloudId,
    timestamp: new Date().toISOString()
  });

  try {
    // Step 1: Call AI server to mark organization for deletion
    const result = await remoteRequest('/api/forge/uninstall', {
      body: {
        cloudId,
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
    // Throw to trigger Forge retry mechanism
    throw error;
  }
}

/**
 * Clear cached KVS entries for a site.
 * Forge KVS doesn't support key enumeration, so we delete known
 * key patterns. User-specific keys expire naturally via 24-hour TTL.
 */
async function clearSiteCache(cloudId) {
  try {
    const keysToDelete = [
      `org:${cloudId}`,
      `remote:org:${cloudId}`
    ];

    const deletePromises = keysToDelete.map(key =>
      kvs.delete(key).catch(err =>
        console.warn(`[Lifecycle] Failed to delete KVS key ${key}:`, err.message)
      )
    );

    await Promise.allSettled(deletePromises);

    console.log(`[Lifecycle] Cleared ${keysToDelete.length} KVS cache entries`);
  } catch (error) {
    console.error('[Lifecycle] Error clearing site cache:', error);
    // Don't throw — cache cleanup is not critical
  }
}

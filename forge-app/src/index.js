/**
 * Main entry point for the Forge app
 * This file registers all resolver functions
 */

import Resolver from '@forge/resolver';
import { registerAnalyticsResolvers } from './resolvers/analyticsResolvers.js';
import { registerWorklogResolvers } from './resolvers/worklogResolvers.js';
import { registerSettingsResolvers } from './resolvers/settingsResolvers.js';
import { registerIssueResolvers } from './resolvers/issueResolvers.js';
import { registerPermissionsResolvers } from './resolvers/permissionsResolvers.js';
import { registerUserResolvers } from './resolvers/userResolvers.js';
import { registerUnassignedWorkResolvers } from './resolvers/unassignedWorkResolvers.js';
import { registerDiagnosticResolvers } from './resolvers/diagnosticResolvers.js';
import { registerFeedbackResolvers } from './resolvers/feedbackResolvers.js';
import { registerClassificationResolvers } from './resolvers/classificationResolvers.js';
import { registerAdminUserStatusResolvers } from './resolvers/adminUserStatusResolvers.js';
import { runScheduledWorklogSync } from './services/scheduledWorklogSync.js';
import { handleIssueUpdateEvent } from './services/issueCacheService.js';
import { handleAppInstalled, handleAppUninstalled } from './services/lifecycleService.js';
import { handlePersonalDataRequest } from './services/personalDataService.js';

// Create resolver instance
const resolver = new Resolver();

// Register all resolvers
registerAnalyticsResolvers(resolver);
registerWorklogResolvers(resolver);
registerSettingsResolvers(resolver);
registerIssueResolvers(resolver);
registerPermissionsResolvers(resolver);
registerUserResolvers(resolver);
registerUnassignedWorkResolvers(resolver);
registerDiagnosticResolvers(resolver);
registerFeedbackResolvers(resolver);
registerClassificationResolvers(resolver);
registerAdminUserStatusResolvers(resolver);

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

// Export lifecycle handler — fires on app install/uninstall events
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

// Export personal data handler — Atlassian's Personal Data Reporting API (GDPR)
// Called when a user requests account deletion or data export
export const personalDataHandler = async (event) => {
  return await handlePersonalDataRequest(event);
};

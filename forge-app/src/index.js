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
import { registerApprovalResolvers } from './resolvers/approval/approvalResolvers.js';
import { registerAccuracyDashboardResolvers } from './resolvers/accuracyDashboardResolvers.js';
import { registerDescriptionResolvers } from './resolvers/descriptionResolvers.js';
import { registerDqNudgePreferenceResolvers } from './resolvers/dqNudgePreferenceResolvers.js';
import { runScheduledWorklogSync } from './services/scheduledWorklogSync.js';
import { runDescriptionQualityNudge, analyzeIssue } from './services/descriptionQualityNudge.js';
export { handler as issueCreatedHandler } from './handlers/issueCreatedHandler.js';
import { handleIssueUpdateEvent, scheduledIssueCacheRefresh } from './services/issueCacheService.js';
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
registerApprovalResolvers(resolver);
registerAccuracyDashboardResolvers(resolver);
registerDescriptionResolvers(resolver);
registerDqNudgePreferenceResolvers(resolver);

// Export handler for Forge
export const handler = resolver.getDefinitions();

// Export scheduled trigger handler for worklog sync
export const scheduledWorklogSyncHandler = async () => {
  return await runScheduledWorklogSync();
};

// Export scheduled trigger handler for description-quality nudges (Enhancement #13).
// Fires via a single frequent trigger; cadence gate enforces one run per 30 minutes.
export const descriptionQualityNudgeHandler = async (event, context) => {
  return await runDescriptionQualityNudge({ event, context, analyzer: analyzeIssue });
};

// Export issue cache trigger handler — fires on avi:jira:updated:issue
export const issueCacheSyncHandler = async (event, context) => {
  return await handleIssueUpdateEvent(event, context);
};

// Export scheduled issue cache refresh handler — refreshes caches for active users
export const scheduledIssueCacheRefreshHandler = async () => {
  return await scheduledIssueCacheRefresh();
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

export { glanceStatusHandler } from './handlers/glanceStatusHandler.js';

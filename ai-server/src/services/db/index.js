/**
 * Database Services Module - Re-exports
 * Provides a single entry point for all database-related services
 */

const supabaseClient = require('./supabase-client');
const storageService = require('./storage-service');
const userDbService = require('./user-db-service');
const clusteringDbService = require('./clustering-db-service');
const feedbackDbService = require('./feedback-db-service');

module.exports = {
  // Supabase Client
  initializeClient: supabaseClient.initializeClient,
  getClient: supabaseClient.getClient,
  isNetworkError: supabaseClient.isNetworkError,

  // Storage Service
  downloadFile: storageService.downloadFile,
  uploadFile: storageService.uploadFile,
  getPublicUrl: storageService.getPublicUrl,
  deleteFile: storageService.deleteFile,

  // User DB Service
  getUserAtlassianAccountId: userDbService.getUserAtlassianAccountId,
  getUserJiraIssues: userDbService.getUserJiraIssues,
  getUserCachedIssues: userDbService.getUserCachedIssues,
  getUserActiveIssues: userDbService.getUserActiveIssues,
  getUserById: userDbService.getUserById,

  // Clustering DB Service
  getUsersWithUnassignedWork: clusteringDbService.getUsersWithUnassignedWork,
  getUnassignedActivities: clusteringDbService.getUnassignedActivities,
  getRecentGroups: clusteringDbService.getRecentGroups,
  createUnassignedGroup: clusteringDbService.createUnassignedGroup,
  addGroupMember: clusteringDbService.addGroupMember,
  getLastClusteringRunTime: clusteringDbService.getLastClusteringRunTime,
  hasClusteringRunRecently: clusteringDbService.hasClusteringRunRecently,
  getUngroupedActivityCount: clusteringDbService.getUngroupedActivityCount,
  getUnassignedWorkGroups: clusteringDbService.getUnassignedWorkGroups,
  computeIsIdleOnly: clusteringDbService.computeIsIdleOnly,

  // Feedback DB Service
  createFeedback: feedbackDbService.createFeedback,
  getFeedbackById: feedbackDbService.getFeedbackById,
  updateFeedbackStatus: feedbackDbService.updateFeedbackStatus,
  updateFeedbackAIResults: feedbackDbService.updateFeedbackAIResults
};

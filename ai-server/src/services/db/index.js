/**
 * Database Services Module - Re-exports
 * Provides a single entry point for all database-related services
 */

const supabaseClient = require('./supabase-client');
const storageService = require('./storage-service');
const screenshotDbService = require('./screenshot-db-service');
const analysisDbService = require('./analysis-db-service');
const userDbService = require('./user-db-service');
const documentDbService = require('./document-db-service');
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

  // Screenshot DB Service
  updateScreenshotStatus: screenshotDbService.updateScreenshotStatus,
  updateScreenshotDuration: screenshotDbService.updateScreenshotDuration,
  getPendingScreenshots: screenshotDbService.getPendingScreenshots,
  getScreenshotById: screenshotDbService.getScreenshotById,
  clearStorageUrls: screenshotDbService.clearStorageUrls,
  claimScreenshotForProcessing: screenshotDbService.claimScreenshotForProcessing,
  resetStuckProcessingScreenshots: screenshotDbService.resetStuckProcessingScreenshots,

  // Analysis DB Service
  saveAnalysisResult: analysisDbService.saveAnalysisResult,
  markWorklogCreated: analysisDbService.markWorklogCreated,
  getUnassignedWork: analysisDbService.getUnassignedWork,
  assignWorkGroup: analysisDbService.assignWorkGroup,
  getUnassignedWorkCount: analysisDbService.getUnassignedWorkCount,
  getAnalysisResultByScreenshotId: analysisDbService.getAnalysisResultByScreenshotId,

  // User DB Service
  getUserAtlassianAccountId: userDbService.getUserAtlassianAccountId,
  getUserJiraIssues: userDbService.getUserJiraIssues,
  getUserCachedIssues: userDbService.getUserCachedIssues,
  getUserActiveIssues: userDbService.getUserActiveIssues,
  getUserById: userDbService.getUserById,

  // Document DB Service
  updateDocumentStatus: documentDbService.updateDocumentStatus,
  updateDocumentData: documentDbService.updateDocumentData,
  getDocumentById: documentDbService.getDocumentById,

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

  // Feedback DB Service
  createFeedback: feedbackDbService.createFeedback,
  getFeedbackById: feedbackDbService.getFeedbackById,
  updateFeedbackStatus: feedbackDbService.updateFeedbackStatus,
  updateFeedbackAIResults: feedbackDbService.updateFeedbackAIResults
};

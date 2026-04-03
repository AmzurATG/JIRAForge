/**
 * AI Services Module - Re-exports
 * Provides a single entry point for all AI-related services
 * Supports Portkey (Gemini) primary with automatic Fireworks fallback
 */

const aiClient = require('./ai-client');
const prompts = require('./prompts');

module.exports = {
  // AI Client (Portkey + Fireworks)
  initializeClient: aiClient.initializeClient,
  getClient: aiClient.getClient,
  getFireworksClient: aiClient.getFireworksClient,
  getPortkeyClient: aiClient.getPortkeyClient,
  isFireworksEnabled: aiClient.isFireworksEnabled,
  isPortkeyEnabled: aiClient.isPortkeyEnabled,
  getProviderOrder: aiClient.getProviderOrder,
  isProviderDemoted: aiClient.isProviderDemoted,
  getProviderStatus: aiClient.getProviderStatus,

  // Model getters
  getTextModel: aiClient.getTextModel,
  getFireworksModel: aiClient.getFireworksModel,
  getPortkeyModel: aiClient.getPortkeyModel,

  // Main request function with fallback
  chatCompletionWithFallback: aiClient.chatCompletionWithFallback,

  // Prompts
  formatAssignedIssues: prompts.formatAssignedIssues
};

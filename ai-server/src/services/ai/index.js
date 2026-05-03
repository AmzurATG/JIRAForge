/**
 * AI Services Module - Re-exports
 * Single entry point for all AI-related services. Routing/fallback across
 * model providers is handled by Portkey's saved Config (PORTKEY_CONFIG_ID).
 */

const aiClient = require('./ai-client');
const prompts = require('./prompts');

module.exports = {
  // AI Client (Portkey)
  initializeClient: aiClient.initializeClient,
  getClient: aiClient.getClient,
  getPortkeyClient: aiClient.getPortkeyClient,
  isPortkeyEnabled: aiClient.isPortkeyEnabled,
  isActivityAIEnabled: aiClient.isActivityAIEnabled,

  // Model getters
  getTextModel: aiClient.getTextModel,
  getPortkeyModel: aiClient.getPortkeyModel,

  // Main request function
  chatCompletionWithFallback: aiClient.chatCompletionWithFallback,

  // Prompts
  formatAssignedIssues: prompts.formatAssignedIssues
};

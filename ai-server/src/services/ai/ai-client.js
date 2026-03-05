/**
 * AI Client Module
 * Centralized AI client management with 2-tier fallback
 *
 * Flow:
 * 1. Portkey (primary) - @jira/gemini-2.0-flash (via Portkey AI Gateway)
 * 2. Fireworks AI (fallback) - Qwen2.5-VL-32B
 */

const OpenAI = require('openai');
const logger = require('../../utils/logger');
const { logLLMRequest } = require('../sheets-logger');
const { logCostTracking } = require('../cost-tracker');

// AI request timeout (default: 60 seconds)
const AI_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '60000', 10);

// Client instances
let fireworksClient = null;
let portKeyClient = null;

// Dynamic provider management
const providerState = {
  // Track failures per provider
  failures: {
    'portkey-gemini': 0,
    'fireworks': 0
  },
  // Track demoted providers and when they were demoted
  demoted: {}, // { 'portkey-gemini': { demotedAt: timestamp, originalIndex: 0 } }
  // Current provider order (will be reordered dynamically)
  order: ['portkey-gemini', 'fireworks'],
  // Original order for restoration
  originalOrder: ['portkey-gemini', 'fireworks']
};

// Configuration (with defaults)
const getFailureThreshold = () => Number.parseInt(process.env.FAILURE_THRESHOLD) || 2;
const getCooldownMinutes = () => Number.parseInt(process.env.COOLDOWN_MINUTES) || 30;

/**
 * Check if Fireworks AI is enabled via environment variable
 * @returns {boolean} True if USE_FIREWORKS is set to 'true'
 */
function isFireworksEnabled() {
  return process.env.USE_FIREWORKS === 'true';
}

/**
 * Check if Portkey is enabled via environment variable
 * @returns {boolean} True if USE_PORTKEY is set to 'true'
 */
function isPortkeyEnabled() {
  return process.env.USE_PORTKEY === 'true';
}

/**
 * Initialize the Fireworks AI client
 * @returns {OpenAI|null} Fireworks client or null if not configured
 */
function initializeFireworksClient() {
  const fireworksApiKey = process.env.FIREWORKS_API_KEY;
  const fireworksBaseUrl = process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1';

  if (!fireworksApiKey) {
    logger.warn('[AI] Fireworks API key not configured');
    return null;
  }

  try {
    fireworksClient = new OpenAI({
      apiKey: fireworksApiKey,
      baseURL: fireworksBaseUrl,
      timeout: AI_REQUEST_TIMEOUT_MS,
      maxRetries: 0
    });
    const model = getFireworksModel();
    logger.info('[AI] Fireworks initialized | Endpoint: %s | Model: %s', fireworksBaseUrl, getShortModelName(model));
    return fireworksClient;
  } catch (error) {
    logger.error('[AI] Fireworks init failed: %s', error.message);
    return null;
  }
}

/**
 * Initialize the Portkey client
 * Uses the OpenAI SDK with Portkey's gateway URL and API key header.
 * When PORTKEY_CONFIG_ID is set, routing (load balance + fallback) is
 * handled by the saved Portkey Config — no virtual key slug needed in model name.
 * @returns {OpenAI|null} Portkey client or null if not configured
 */
function initializePortkeyClient() {
  const portKeyApiKey = process.env.PORTKEY_API_KEY;
  const portKeyConfigId = process.env.PORTKEY_CONFIG_ID;

  if (!portKeyApiKey) {
    logger.warn('[AI] Portkey API key not configured');
    return null;
  }

  try {
    const defaultHeaders = {
      'x-portkey-api-key': portKeyApiKey,
    };
    if (portKeyConfigId) {
      defaultHeaders['x-portkey-config'] = portKeyConfigId;
    }

    portKeyClient = new OpenAI({
      apiKey: 'portkey',  // Not used by Portkey — auth is via x-portkey-api-key header
      baseURL: 'https://api.portkey.ai/v1',
      defaultHeaders,
      timeout: AI_REQUEST_TIMEOUT_MS,
      maxRetries: 0
    });
    const model = getPortkeyModel();
    const configNote = portKeyConfigId ? ` | Config: ${portKeyConfigId}` : '';
    logger.info('[AI] Portkey initialized | Model: %s%s', getShortModelName(model), configNote);
    return portKeyClient;
  } catch (error) {
    logger.error('[AI] Portkey init failed: %s', error.message);
    return null;
  }
}

/**
 * Initialize all clients
 * Called once at application startup
 */
function initializeClient() {
  logger.info('[AI] Initializing AI clients...');
  logger.info('[AI] Config: USE_PORTKEY=%s | USE_FIREWORKS=%s',
    process.env.USE_PORTKEY || 'false',
    process.env.USE_FIREWORKS || 'false');

  // Initialize Portkey if enabled
  if (isPortkeyEnabled()) {
    initializePortkeyClient();
  }

  // Initialize Fireworks if enabled
  if (isFireworksEnabled()) {
    initializeFireworksClient();
  }

  // Log the fallback chain
  const portKeyEnabled = isPortkeyEnabled();
  const fireworksEnabled = isFireworksEnabled();

  if (!portKeyEnabled && !fireworksEnabled) {
    logger.warn('[AI] WARNING: No AI providers enabled! AI features will not work.');
  } else {
    const chain = [];
    if (portKeyEnabled) {
      chain.push(`Portkey (${getShortModelName(getPortkeyModel())})`);
    }
    if (fireworksEnabled) {
      chain.push(`Fireworks (${getShortModelName(getFireworksModel())})`);
    }
    logger.info('[AI] Fallback Chain: %s', chain.join(' -> '));
  }

  return getClient();
}

/**
 * Get the Fireworks client instance
 * @returns {OpenAI|null} Fireworks client or null
 */
function getFireworksClient() {
  if (!fireworksClient && isFireworksEnabled() && process.env.FIREWORKS_API_KEY) {
    logger.info('[AI] getFireworksClient() lazy init');
    initializeFireworksClient();
  }
  return fireworksClient;
}

/**
 * Get the Portkey client instance
 * @returns {OpenAI|null} Portkey client or null
 */
function getPortkeyClient() {
  if (!portKeyClient && isPortkeyEnabled() && process.env.PORTKEY_API_KEY) {
    logger.info('[AI] getPortkeyClient() lazy init');
    initializePortkeyClient();
  }
  return portKeyClient;
}

/**
 * Get primary client based on current provider order
 * @returns {OpenAI|null} Primary client based on configuration
 */
function getClient() {
  const order = getProviderOrder();
  for (const providerId of order) {
    const config = getProviderConfig(providerId);
    if (config?.client) {
      return config.client;
    }
  }
  return getPortkeyClient() || getFireworksClient();
}

/**
 * Check if AI analysis is enabled for screenshots (vision-based)
 * Controlled by USE_AI_FOR_SCREENSHOTS env var
 * @returns {boolean} True if any AI client is available and screenshot AI is enabled
 */
function isAIEnabled() {
  const hasClient = getPortkeyClient() !== null || getFireworksClient() !== null;
  return hasClient && process.env.USE_AI_FOR_SCREENSHOTS !== 'false';
}

/**
 * Check if AI analysis is enabled for activity records (text-only)
 * Controlled by USE_AI_FOR_ACTIVITIES env var (defaults to enabled)
 * Separate from screenshot AI — activity analysis is text-only LLM matching
 * @returns {boolean} True if any AI client is available and activity AI is enabled
 */
function isActivityAIEnabled() {
  const hasClient = getPortkeyClient() !== null || getFireworksClient() !== null;
  return hasClient && process.env.USE_AI_FOR_ACTIVITIES !== 'false';
}

/**
 * Get human-readable provider name
 * @param {string} providerId - Provider ID
 * @returns {string} Human-readable name
 */
function getProviderDisplayName(providerId) {
  const names = {
    'portkey-gemini': 'Portkey/Gemini',
    'fireworks': 'Fireworks/Qwen'
  };
  return names[providerId] || providerId;
}

/**
 * Check and restore any demoted providers whose cooldown has expired
 */
function checkAndRestoreDemotedProviders() {
  const cooldownMs = getCooldownMinutes() * 60 * 1000;
  const now = Date.now();

  for (const [providerId, info] of Object.entries(providerState.demoted)) {
    const elapsed = now - info.demotedAt;
    if (elapsed >= cooldownMs) {
      // Cooldown complete, restore provider to its original position
      const currentIndex = providerState.order.indexOf(providerId);
      if (currentIndex !== -1) {
        providerState.order.splice(currentIndex, 1);
      }
      // Insert at original position (or beginning if original position is invalid)
      const targetIndex = Math.min(info.originalIndex, providerState.order.length);
      providerState.order.splice(targetIndex, 0, providerId);

      // Reset failure count and remove from demoted
      providerState.failures[providerId] = 0;
      delete providerState.demoted[providerId];

      logger.info('[AI] CIRCUIT BREAKER RESET - %s cooldown complete (%d min), restored to position %d',
        getProviderDisplayName(providerId), getCooldownMinutes(), targetIndex + 1);
      logger.info('[AI] Current provider order: %s', providerState.order.map(getProviderDisplayName).join(' -> '));
    }
  }
}

/**
 * Check if a specific provider is currently demoted
 * @param {string} providerId - Provider ID to check
 * @returns {boolean} True if provider is demoted
 */
function isProviderDemoted(providerId) {
  checkAndRestoreDemotedProviders(); // Check for any expired cooldowns first
  return providerId in providerState.demoted;
}

/**
 * Get the current provider order (with demoted providers moved to end)
 * @returns {string[]} Ordered list of provider IDs
 */
function getProviderOrder() {
  checkAndRestoreDemotedProviders();
  return [...providerState.order];
}

/**
 * Handle provider request failure
 * Tracks consecutive failures and demotes provider if threshold reached
 * @param {Error} error - The error that occurred
 * @param {string} providerId - The provider ID (portkey-gemini, fireworks)
 */
function handleProviderFailure(error, providerId) {
  providerState.failures[providerId] = (providerState.failures[providerId] || 0) + 1;
  const failures = providerState.failures[providerId];
  const threshold = getFailureThreshold();

  logger.warn('[AI] %s failed (%d/%d): %s',
    getProviderDisplayName(providerId), failures, threshold, error.message);

  if (failures >= threshold && !isProviderDemoted(providerId)) {
    // Demote this provider
    const currentIndex = providerState.order.indexOf(providerId);
    providerState.demoted[providerId] = {
      demotedAt: Date.now(),
      originalIndex: currentIndex
    };

    // Move provider to end of order
    if (currentIndex !== -1) {
      providerState.order.splice(currentIndex, 1);
      providerState.order.push(providerId);
    }

    const newPrimary = getProviderDisplayName(providerState.order[0]);
    logger.warn('[AI] CIRCUIT BREAKER ACTIVATED - %s demoted after %d failures',
      getProviderDisplayName(providerId), failures);
    logger.warn('[AI] %s is now PRIMARY for %d minutes',
      newPrimary, getCooldownMinutes());
    logger.info('[AI] New provider order: %s', providerState.order.map(getProviderDisplayName).join(' -> '));
  }
}

/**
 * Handle successful provider request
 * Resets failure counter for that provider
 * @param {string} providerId - The provider ID
 */
function handleProviderSuccess(providerId) {
  const previousFailures = providerState.failures[providerId] || 0;
  if (previousFailures > 0) {
    logger.info('[AI] %s recovered after %d failure(s)',
      getProviderDisplayName(providerId), previousFailures);
  }
  providerState.failures[providerId] = 0;
}

/**
 * Get remaining cooldown time for a demoted provider
 * @param {string} providerId - Provider ID
 * @returns {number} Minutes remaining, or 0 if not demoted
 */
function getRemainingCooldown(providerId) {
  if (!providerState.demoted[providerId]) return 0;
  const cooldownMs = getCooldownMinutes() * 60 * 1000;
  const elapsed = Date.now() - providerState.demoted[providerId].demotedAt;
  return Math.max(0, Math.ceil((cooldownMs - elapsed) / 60000));
}

/**
 * Get the Fireworks model name
 * @returns {string} Model name for Fireworks requests
 */
function getFireworksModel() {
  return process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/qwen2p5-vl-32b-instruct';
}

/**
 * Get the Portkey model name
 * When PORTKEY_CONFIG_ID is set, the config's override_params.model takes precedence.
 * The model here acts as a fallback hint only.
 * @returns {string} Model name for Portkey requests
 */
function getPortkeyModel() {
  return process.env.PORTKEY_MODEL || 'gemini-2.0-flash';
}

/**
 * Get short model name for logging
 * @param {string} model - Full model name
 * @returns {string} Short model name
 */
function getShortModelName(model) {
  // Portkey @slug/model format — strip the virtual key slug
  if (model.startsWith('@')) {
    const slashIdx = model.indexOf('/', 1);
    return slashIdx === -1 ? model : model.slice(slashIdx + 1);
  }
  // Fireworks models
  if (model.includes('qwen2p5-vl-32b')) return 'Qwen2.5-VL-32B';
  if (model.includes('qwen2p5-vl-72b')) return 'Qwen2.5-VL-72B';
  if (model.includes('llama-v3p2-11b-vision')) return 'Llama-11B-Vision';
  // OpenAI models
  if (model.includes('gpt-4o-mini')) return 'GPT-4o-Mini';
  if (model.includes('gpt-4o')) return 'GPT-4o';
  if (model.includes('gpt-4-turbo')) return 'GPT-4-Turbo';
  if (model.includes('gpt-4')) return 'GPT-4';
  // Gemini models
  if (model.includes('gemini-2.0-flash-lite')) return 'Gemini-2.0-Flash-Lite';
  if (model.includes('gemini-2.0-flash')) return 'Gemini-2.0-Flash';
  if (model.includes('gemini-1.5-flash')) return 'Gemini-1.5-Flash';
  if (model.includes('gemini-1.5-pro')) return 'Gemini-1.5-Pro';
  // Fallback: extract last part of model path
  return model.split('/').pop() || model;
}

/**
 * Get the configured vision model (based on current primary provider)
 * @returns {string} Model name for vision analysis
 */
function getVisionModel() {
  const order = getProviderOrder();
  const primary = order[0];
  if (primary === 'fireworks') return getFireworksModel();
  return getPortkeyModel();
}

/**
 * Get the configured text model (based on current primary provider)
 * @returns {string} Model name for text analysis
 */
function getTextModel() {
  return getVisionModel(); // Same logic
}

/**
 * Get current provider status for logging/monitoring
 * @returns {Object} Current AI provider status
 */
function getProviderStatus() {
  const order = getProviderOrder();
  return {
    portKeyEnabled: isPortkeyEnabled(),
    fireworksEnabled: isFireworksEnabled(),
    providerOrder: order,
    demotedProviders: Object.keys(providerState.demoted),
    failures: { ...providerState.failures },
    currentPrimary: order[0]
  };
}

/**
 * Get provider configuration (client, model, display name)
 * @param {string} providerId - Provider ID
 * @returns {Object|null} Provider config or null if not available
 */
function getProviderConfig(providerId) {
  switch (providerId) {
    case 'portkey-gemini':
      if (!isPortkeyEnabled()) return null;
      return {
        client: getPortkeyClient(),
        model: getPortkeyModel(),
        displayName: 'Portkey/Gemini'
      };
    case 'fireworks':
      if (!isFireworksEnabled()) return null;
      return {
        client: getFireworksClient(),
        model: getFireworksModel(),
        displayName: 'Fireworks/Qwen'
      };
    default:
      return null;
  }
}

/**
 * Log provider order when there are demoted providers
 * @param {Array} providerOrder - Current provider order
 */
function logDemotedProviders(providerOrder) {
  const demotedCount = Object.keys(providerState.demoted).length;
  if (demotedCount > 0) {
    const demotedNames = Object.keys(providerState.demoted).map(getProviderDisplayName).join(', ');
    logger.info('[AI] Provider order: %s (demoted: %s)',
      providerOrder.map(getProviderDisplayName).join(' -> '),
      demotedNames);
  }
}

/**
 * Log which provider we're attempting to use
 * @param {string} requestType - 'vision' or 'text'
 * @param {Object} config - Provider configuration
 * @param {Array} errors - Previous errors array
 */
function logRequestAttempt(requestType, config, errors) {
  const failedProviders = errors.map(e => getProviderDisplayName(e.provider)).join(', ');
  if (errors.length > 0) {
    logger.info('[AI] %s request via %s (%s failed) (%s)',
      requestType, config.displayName, failedProviders, getShortModelName(config.model));
  } else {
    logger.info('[AI] %s request via %s (%s)',
      requestType, config.displayName, getShortModelName(config.model));
  }
}

/**
 * Execute a chat completion with dynamic fallback based on provider health.
 * Providers are tried in order, with unhealthy providers automatically demoted.
 *
 * @param {Object} params - Chat completion parameters
 * @param {Array} params.messages - Messages array
 * @param {number} params.temperature - Temperature setting (default: 0.3)
 * @param {number} params.max_tokens - Max tokens (default: 800)
 * @param {boolean} params.isVision - Whether this is a vision request (default: false)
 * @param {string} params.reasoningEffort - For Gemini: 'none'|'low'|'medium'|'high'; 'none' disables thinking so output tokens go to the response (optional)
 * @param {string} params.userId - User ID for cost tracking (optional)
 * @param {string} params.organizationId - Organization ID for cost tracking (optional)
 * @param {string} params.screenshotId - Screenshot ID for cost tracking (optional)
 * @param {string} params.apiCallName - Label for the request type (e.g. 'vision-analysis', 'app-classification') (optional)
 * @returns {Promise<Object>} { response, provider, model }
 */
async function chatCompletionWithFallback({ messages, temperature = 0.3, max_tokens = 800, isVision = false, reasoningEffort = null, userId = null, organizationId = null, screenshotId = null, apiCallName = null }) {
  const errors = [];
  const requestType = isVision ? 'vision' : 'text';

  // Get current provider order (automatically checks for expired cooldowns)
  const providerOrder = getProviderOrder();

  // Log current provider order if any are demoted
  logDemotedProviders(providerOrder);

  // Try each provider in order
  for (const providerId of providerOrder) {

    // Skip demoted providers (they're in the order but shouldn't be tried)
    if (isProviderDemoted(providerId)) {
      continue;
    }

    const config = getProviderConfig(providerId);

    // Skip if provider not available
    if (!config?.client) continue;

    try {
      const startTime = Date.now();

      // Log which provider we're trying
      logRequestAttempt(requestType, config, errors);

      // Make the API call
      const requestParams = {
        model: config.model,
        messages,
        temperature,
        max_tokens
      };

      // Disable Gemini thinking for text-only (e.g. OCR) so token budget goes to the JSON response
      if (reasoningEffort && providerId === 'portkey-gemini') {
        requestParams.reasoning_effort = reasoningEffort;
      }

      const response = await config.client.chat.completions.create(requestParams);

      const duration = Date.now() - startTime;

      // Success! Reset failure count for this provider
      handleProviderSuccess(providerId);

      logger.info('[AI] %s request completed | %s | %dms', requestType, config.displayName, duration);

      // Log to Google Sheets for Fireworks (async)
      if (providerId === 'fireworks') {
        const usage = response.usage || {};
        logLLMRequest({
          apiCallName: requestType,
          provider: 'Fireworks',
          model: config.model,
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0
        }).catch(() => {});
      }

      // Log cost tracking to Sheet 2 for ALL providers (async)
      const usage = response.usage || {};
      logCostTracking({
        userId: userId,
        apiCallName: requestType,
        provider: providerId,
        model: config.model,
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        duration: duration,
        organizationId: organizationId,
        screenshotId: screenshotId
      }).catch(() => {}); // Don't fail if cost tracking fails

      return { response, provider: providerId, model: config.model };

    } catch (error) {
      // Track failure and potentially demote provider
      handleProviderFailure(error, providerId);
      errors.push({ provider: providerId, error: error.message });

      // Continue to next provider in order
    }
  }

  // All providers failed
  const errorMsg = errors.map(e => `${getProviderDisplayName(e.provider)}: ${e.error}`).join('; ');
  logger.error('[AI] All providers failed: %s', errorMsg);
  throw new Error(`All AI providers failed: ${errorMsg}`);
}

module.exports = {
  // Initialization
  initializeClient,

  // Client getters
  getClient,
  getFireworksClient,
  getPortkeyClient,

  // Status checks
  isAIEnabled,
  isActivityAIEnabled,
  isFireworksEnabled,
  isPortkeyEnabled,
  getProviderStatus,
  getProviderOrder,
  isProviderDemoted,

  // Model getters
  getVisionModel,
  getTextModel,
  getFireworksModel,
  getPortkeyModel,

  // Main request function with fallback
  chatCompletionWithFallback
};

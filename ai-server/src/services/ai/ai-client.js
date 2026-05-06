/**
 * AI Client Module
 * Single-provider Portkey gateway client. Portkey itself handles load
 * balance + provider fallback (Gemini, OpenAI, etc.) via the saved Config
 * referenced by PORTKEY_CONFIG_ID.
 */

const OpenAI = require('openai');
const logger = require('../../utils/logger');

// AI request timeout (default: 60 seconds)
const AI_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '60000', 10);

let portKeyClient = null;

/**
 * Check if Portkey is enabled via environment variable
 * @returns {boolean} True if USE_PORTKEY is set to 'true'
 */
function isPortkeyEnabled() {
  return process.env.USE_PORTKEY === 'true';
}

/**
 * Initialize the Portkey client.
 * Uses the OpenAI SDK with Portkey's gateway URL and API key header.
 * When PORTKEY_CONFIG_ID is set, routing is handled by the saved Portkey
 * Config — no virtual key slug needed in the model name.
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
    const defaultHeaders = { 'x-portkey-api-key': portKeyApiKey };
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
 * Initialize the AI client. Called once at application startup.
 */
function initializeClient() {
  logger.info('[AI] Initializing AI client...');
  logger.info('[AI] Config: USE_PORTKEY=%s', process.env.USE_PORTKEY || 'false');

  if (isPortkeyEnabled()) {
    initializePortkeyClient();
  } else {
    logger.warn('[AI] WARNING: Portkey not enabled — AI features will not work.');
  }

  return getPortkeyClient();
}

/**
 * Get the Portkey client instance (lazy-init if needed).
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
 * Get the AI client.
 * @returns {OpenAI|null}
 */
function getClient() {
  return getPortkeyClient();
}

/**
 * Check if AI analysis is enabled for activity records (text-only).
 * Controlled by USE_AI_FOR_ACTIVITIES env var (defaults to enabled).
 * @returns {boolean} True if Portkey client is available and activity AI is enabled
 */
function isActivityAIEnabled() {
  return getPortkeyClient() !== null && process.env.USE_AI_FOR_ACTIVITIES !== 'false';
}

/**
 * Get the Portkey model name.
 * When PORTKEY_CONFIG_ID is set, the config's override_params.model takes
 * precedence and the model here acts as a fallback hint only.
 * @returns {string} Model name for Portkey requests
 */
function getPortkeyModel() {
  return process.env.PORTKEY_MODEL || 'gemini-2.0-flash';
}

/**
 * Get the configured text model.
 * @returns {string} Model name for text analysis
 */
function getTextModel() {
  return getPortkeyModel();
}

/**
 * Get a short, human-readable model name for logging.
 * @param {string} model - Full model name
 * @returns {string} Short model name
 */
function getShortModelName(model) {
  // Portkey @slug/model format — strip the virtual key slug
  if (model.startsWith('@')) {
    const slashIdx = model.indexOf('/', 1);
    return slashIdx === -1 ? model : model.slice(slashIdx + 1);
  }
  // OpenAI models
  if (model.includes('gpt-5-mini')) return 'GPT-5-Mini';
  if (model.includes('gpt-5')) return 'GPT-5';
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
 * Execute a chat completion via Portkey.
 * Portkey's saved Config handles cross-provider routing/fallback internally.
 *
 * @param {Object} params - Chat completion parameters
 * @param {Array} params.messages - Messages array
 * @param {number} [params.max_tokens=800] - Max tokens (sent as max_completion_tokens)
 * @param {boolean} [params.isVision=false] - Whether this is a vision request
 * @param {number} [params.temperature] - Temperature for sampling (omitted for GPT-5/o-series)
 * @returns {Promise<{response: Object, provider: string, model: string}>}
 */
async function chatCompletionWithFallback({ messages, max_tokens = 800, isVision = false, temperature }) {
  const requestType = isVision ? 'vision' : 'text';
  const client = getPortkeyClient();
  const model = getPortkeyModel();

  if (!client) {
    const err = new Error('Portkey client not configured');
    logger.error('[AI] %s request failed: %s', requestType, err.message);
    throw err;
  }

  logger.info('[AI] %s request via Portkey (%s)', requestType, getShortModelName(model));
  const startTime = Date.now();

  try {
    // GPT-5 / o-series reject non-default temperature with a 400.
    // Only pass temperature for models that support it (Gemini, GPT-4, etc.)
    const isGpt5OrOSeries = model.includes('gpt-5') || model.includes('o1') || model.includes('o3');
    const requestParams = {
      model,
      messages,
      max_completion_tokens: max_tokens
    };
    if (!isGpt5OrOSeries) {
      requestParams.temperature = temperature !== undefined ? temperature : 0.1;
    }
    const response = await client.chat.completions.create(requestParams);
    logger.info('[AI] %s request completed | Portkey | %dms', requestType, Date.now() - startTime);
    return { response, provider: 'portkey', model };
  } catch (error) {
    logger.error('[AI] Portkey request failed: %s', error.message);
    throw error;
  }
}

module.exports = {
  initializeClient,
  getClient,
  getPortkeyClient,
  isActivityAIEnabled,
  isPortkeyEnabled,
  getTextModel,
  getPortkeyModel,
  chatCompletionWithFallback
};

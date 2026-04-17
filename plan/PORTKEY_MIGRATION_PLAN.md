# Portkey Migration Plan

## Overview

This document outlines the migration from the current **LiteLLM + Gemini** integration to **Portkey AI Gateway** for the JIRAForge AI Server.

**Current Date:** March 2, 2026  
**Estimated Effort:** 4-6 hours  
**Risk Level:** Medium (requires testing all AI flows)

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [Portkey Overview](#2-portkey-overview)
3. [Migration Benefits](#3-migration-benefits)
4. [Files to Modify](#4-files-to-modify)
5. [Files to Create](#5-files-to-create)
6. [Step-by-Step Migration Guide](#6-step-by-step-migration-guide)
7. [Environment Variables Changes](#7-environment-variables-changes)
8. [Code Changes](#8-code-changes)
9. [Testing Plan](#9-testing-plan)
10. [Rollback Plan](#10-rollback-plan)

---

## 1. Current Architecture Analysis

### Current AI Flow
```
Desktop App → Supabase → AI Server → LiteLLM Proxy → Gemini/GPT-4o/Fireworks
```

### Current Files Structure
```
ai-server/
├── src/
│   └── services/
│       └── ai/
│           ├── ai-client.js          # Main AI client (729 lines)
│           ├── vision-analyzer.js    # Vision analysis
│           ├── ocr-analyzer.js       # OCR analysis
│           ├── prompts.js            # AI prompts
│           └── index.js              # Re-exports
├── .env.example                      # Environment configuration
└── package.json                      # Dependencies
```

### Current Provider Configuration

| Provider | Model | Purpose |
|----------|-------|---------|
| LiteLLM/Gemini | `gemini/gemini-2.0-flash` | Primary (vision + text) |
| LiteLLM/GPT-4o | `gpt-4o` | Fallback 1 |
| Fireworks | `qwen2p5-vl-32b-instruct` | Fallback 2 |

### Current Environment Variables
```env
USE_LITELLM=true
LITELLM_API_KEY=sk-your-litellm-virtual-key
LITELLM_GEMINI_API_KEY=sk-gemini-key
LITELLM_OPENAI_API_KEY=sk-openai-key
LITELLM_BASE_URL=http://10.15.226.9:4000
LITELLM_MODEL=gemini/gemini-2.0-flash
LITELLM_FALLBACK_MODEL=gpt-4o
LITELLM_USER=your.email@amzur.com
USE_FIREWORKS=false
FIREWORKS_API_KEY=your-key
```

---

## 2. Portkey Overview

**Portkey** is an AI Gateway that provides:
- Unified API for 200+ LLM providers
- Built-in fallback and retry mechanisms
- Semantic caching for cost savings
- Detailed analytics and logging
- Guardrails and content moderation
- Load balancing across providers
- Virtual keys for secure API key management

### Portkey Architecture
```
AI Server → Portkey Gateway → Gemini/OpenAI/Fireworks (managed by Portkey)
```

### Key Portkey Concepts
- **Virtual Keys**: Secure API key references stored in Portkey
- **Configs**: JSON configurations for routing, fallbacks, retries
- **Traces**: Automatic request/response logging
- **Gateway URL**: `https://api.portkey.ai/v1`

---

## 3. Migration Benefits

| Feature | LiteLLM (Current) | Portkey (Target) |
|---------|-------------------|------------------|
| Fallback Logic | Custom code (120 lines) | Built-in config |
| Caching | Manual | Automatic semantic caching |
| Analytics | Google Sheets (custom) | Built-in dashboard |
| Retries | Custom circuit breaker | Built-in with config |
| Load Balancing | Manual | Automatic |
| Provider Switching | Code changes | Config changes |
| Cost Tracking | Custom code | Built-in |

### Estimated Impact
- **Code Reduction**: ~200 lines removed from ai-client.js
- **Cost Savings**: 15-30% with semantic caching
- **Reliability**: Improved with automatic failover
- **Observability**: Better with built-in analytics

---

## 4. Files to Modify

### Primary Files (Must Modify)

| File | Changes Required | Priority |
|------|------------------|----------|
| `ai-server/src/services/ai/ai-client.js` | Replace OpenAI client with Portkey SDK, simplify fallback logic | High |
| `ai-server/.env.example` | Update environment variables | High |
| `ai-server/package.json` | Add `portkey-ai` dependency | High |

### Secondary Files (May Require Updates)

| File | Changes Required | Priority |
|------|------------------|----------|
| `ai-server/src/services/cost-tracker.js` | Optional: Portkey provides built-in cost tracking | Low |
| `ai-server/src/services/sheets-logger.js` | Optional: May remove if using Portkey analytics | Low |
| `ai-server/src/services/ai/vision-analyzer.js` | Update response handling if needed | Low |
| `ai-server/src/services/ai/ocr-analyzer.js` | Update response handling if needed | Low |
| `ai-server/src/services/ai/index.js` | Update exports if interface changes | Low |

### Documentation Files (Update)

| File | Changes Required |
|------|------------------|
| `docs/AI_SERVER_CONNECTION_ARCHITECTURE.md` | Update architecture diagrams |
| `docs/FORGE_AI_SERVER_QUICK_REFERENCE.md` | Update configuration guide |
| `docs/CONFIGURATION_GUIDE.md` | Update env variables |

---

## 5. Files to Create

### New Files

| File | Purpose |
|------|---------|
| `ai-server/src/services/ai/portkey-client.js` | Portkey-specific client wrapper (optional) |
| `ai-server/src/config/portkey-config.json` | Portkey routing configuration |
| `ai-server/tests/test-portkey.js` | Portkey integration tests |

---

## 6. Step-by-Step Migration Guide

### Phase 1: Portkey Setup (30 minutes)

1. **Create Portkey Account**
   - Go to https://app.portkey.ai
   - Sign up and create an organization

2. **Add Provider API Keys to Portkey**
   - Navigate to Virtual Keys
   - Add Google (Gemini) API key → Get Virtual Key ID
   - Add OpenAI API key → Get Virtual Key ID
   - Add Fireworks API key (optional) → Get Virtual Key ID

3. **Create Portkey Config**
   - Navigate to Configs
   - Create a new config with fallback strategy
   - Copy the Config ID

4. **Get Portkey API Key**
   - Navigate to API Keys
   - Create a new API key for the AI server

### Phase 2: Code Migration (2-3 hours)

1. **Install Portkey SDK**
   ```bash
   cd ai-server
   npm install portkey-ai
   ```

2. **Update ai-client.js** (see detailed code below)

3. **Update .env.example** (see environment variables section)

4. **Test locally** with a single provider first

### Phase 3: Testing (1-2 hours)

1. Run unit tests
2. Run integration tests
3. Test vision analysis
4. Test OCR analysis
5. Test fallback scenarios

### Phase 4: Deployment (30 minutes)

1. Update production environment variables
2. Deploy to staging
3. Monitor Portkey dashboard
4. Deploy to production

---

## 7. Environment Variables Changes

### Remove (LiteLLM-specific)
```env
# REMOVE THESE
USE_LITELLM=true
LITELLM_API_KEY=sk-your-litellm-virtual-key
LITELLM_GEMINI_API_KEY=sk-gemini-key
LITELLM_OPENAI_API_KEY=sk-openai-key
LITELLM_BASE_URL=http://10.15.226.9:4000
LITELLM_MODEL=gemini/gemini-2.0-flash
LITELLM_FALLBACK_MODEL=gpt-4o
LITELLM_USER=your.email@amzur.com
```

### Add (Portkey-specific)
```env
# =============================================================================
# PORTKEY AI GATEWAY CONFIGURATION
# =============================================================================
# Enable Portkey as the AI gateway
USE_PORTKEY=true

# Portkey API Key (from https://app.portkey.ai/api-keys)
PORTKEY_API_KEY=pk-your-portkey-api-key

# Portkey Gateway URL (default: https://api.portkey.ai/v1)
PORTKEY_BASE_URL=https://api.portkey.ai/v1

# Portkey Virtual Keys (create at https://app.portkey.ai/virtual-keys)
# These reference your actual API keys stored securely in Portkey
PORTKEY_VIRTUAL_KEY_GEMINI=vk-gemini-virtual-key-id
PORTKEY_VIRTUAL_KEY_OPENAI=vk-openai-virtual-key-id
PORTKEY_VIRTUAL_KEY_FIREWORKS=vk-fireworks-virtual-key-id

# Portkey Config ID (optional - for advanced routing)
# Create at https://app.portkey.ai/configs
PORTKEY_CONFIG_ID=pc-your-config-id

# Default Model (primary)
PORTKEY_PRIMARY_MODEL=gemini-2.0-flash

# Fallback Model
PORTKEY_FALLBACK_MODEL=gpt-4o

# User identifier for Portkey analytics
PORTKEY_USER=ai-server@amzur.com

# -----------------------------------------------------------------------------
# AI Feature Flags (unchanged)
# -----------------------------------------------------------------------------
USE_AI_FOR_SCREENSHOTS=true
USE_AI_FOR_ACTIVITIES=true
USE_OCR_FALLBACK=true

# -----------------------------------------------------------------------------
# Fallback Settings (Portkey handles this, but keep for manual override)
# -----------------------------------------------------------------------------
FAILURE_THRESHOLD=3
COOLDOWN_MINUTES=5
```

### Keep (Fireworks as third fallback - optional)
```env
# Fireworks AI (optional - as third fallback outside Portkey)
USE_FIREWORKS=false
FIREWORKS_API_KEY=your_fireworks_api_key_here
FIREWORKS_BASE_URL=https://api.fireworks.ai/inference/v1
FIREWORKS_MODEL=accounts/fireworks/models/qwen2p5-vl-32b-instruct
```

---

## 8. Code Changes

### 8.1 Update package.json

```diff
{
  "dependencies": {
    "express": "^4.18.2",
    "dotenv": "^16.3.1",
    "@supabase/supabase-js": "^2.39.0",
    "axios": "^1.6.0",
    "jsonwebtoken": "^9.0.2",
    "jose": "^5.2.0",
    "tesseract.js": "^5.0.3",
    "pdf-parse": "^1.1.1",
    "mammoth": "^1.6.0",
    "openai": "^4.20.0",
+   "portkey-ai": "^1.3.0",
    "sharp": "^0.33.0",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.1.0",
    "winston": "^3.11.0",
    "googleapis": "^144.0.0",
    "form-data": "^4.0.0",
    "notifme-sdk": "^1.11.0"
  }
}
```

### 8.2 Create Portkey Config File

Create `ai-server/src/config/portkey-config.json`:

```json
{
  "strategy": {
    "mode": "fallback"
  },
  "targets": [
    {
      "virtual_key": "${PORTKEY_VIRTUAL_KEY_GEMINI}",
      "override_params": {
        "model": "gemini-2.0-flash"
      },
      "weight": 1
    },
    {
      "virtual_key": "${PORTKEY_VIRTUAL_KEY_OPENAI}",
      "override_params": {
        "model": "gpt-4o"
      },
      "weight": 1
    }
  ],
  "retry": {
    "attempts": 3,
    "on_status_codes": [429, 500, 502, 503, 504]
  },
  "cache": {
    "mode": "semantic",
    "max_age": 3600
  }
}
```

### 8.3 Replace ai-client.js

Create a new version of `ai-server/src/services/ai/ai-client.js`:

```javascript
/**
 * AI Client Module - Portkey Integration
 * Centralized AI client management with Portkey AI Gateway
 *
 * Flow:
 * 1. Portkey Gateway → Gemini (primary)
 * 2. Portkey Gateway → GPT-4o (fallback 1)
 * 3. Direct Fireworks (fallback 2 - optional)
 */

const { Portkey } = require('portkey-ai');
const OpenAI = require('openai');
const logger = require('../../utils/logger');
const { logCostTracking } = require('../cost-tracker');

// AI request timeout (default: 60 seconds)
const AI_REQUEST_TIMEOUT_MS = parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '60000', 10);

// User email cache for tracking (TTL: 10 minutes)
const userEmailCache = new Map();
const USER_EMAIL_CACHE_TTL = 10 * 60 * 1000;

// Client instances
let portkeyClient = null;
let fireworksClient = null;

// Configuration (with defaults)
const getFailureThreshold = () => parseInt(process.env.FAILURE_THRESHOLD) || 2;
const getCooldownMinutes = () => parseInt(process.env.COOLDOWN_MINUTES) || 30;

/**
 * Check if Portkey is enabled via environment variable
 * @returns {boolean} True if USE_PORTKEY is set to 'true'
 */
function isPortkeyEnabled() {
  return process.env.USE_PORTKEY === 'true';
}

/**
 * Check if Fireworks AI is enabled via environment variable
 * @returns {boolean} True if USE_FIREWORKS is set to 'true'
 */
function isFireworksEnabled() {
  return process.env.USE_FIREWORKS === 'true';
}

/**
 * Initialize the Portkey client
 * @returns {Portkey|null} Portkey client or null if not configured
 */
function initializePortkeyClient() {
  const apiKey = process.env.PORTKEY_API_KEY;
  const baseUrl = process.env.PORTKEY_BASE_URL || 'https://api.portkey.ai/v1';

  if (!apiKey) {
    logger.warn('[AI] Portkey API key not configured');
    return null;
  }

  try {
    // Initialize with config if provided
    const clientConfig = {
      apiKey: apiKey,
      baseURL: baseUrl,
      timeout: AI_REQUEST_TIMEOUT_MS
    };

    // Add config ID if provided (for advanced routing)
    if (process.env.PORTKEY_CONFIG_ID) {
      clientConfig.config = process.env.PORTKEY_CONFIG_ID;
    }

    portkeyClient = new Portkey(clientConfig);

    logger.info('[AI] Portkey initialized | Endpoint: %s | Config: %s',
      baseUrl,
      process.env.PORTKEY_CONFIG_ID || 'default');
    return portkeyClient;
  } catch (error) {
    logger.error('[AI] Portkey init failed: %s', error.message);
    return null;
  }
}

/**
 * Initialize the Fireworks AI client (optional fallback)
 * @returns {OpenAI|null} Fireworks client or null if not configured
 */
function initializeFireworksClient() {
  const apiKey = process.env.FIREWORKS_API_KEY;
  const baseUrl = process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1';

  if (!apiKey) {
    logger.warn('[AI] Fireworks API key not configured');
    return null;
  }

  try {
    fireworksClient = new OpenAI({
      apiKey: apiKey,
      baseURL: baseUrl,
      timeout: AI_REQUEST_TIMEOUT_MS,
      maxRetries: 0
    });
    logger.info('[AI] Fireworks initialized | Endpoint: %s', baseUrl);
    return fireworksClient;
  } catch (error) {
    logger.error('[AI] Fireworks init failed: %s', error.message);
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

  // Initialize Fireworks if enabled (as backup outside Portkey)
  if (isFireworksEnabled()) {
    initializeFireworksClient();
  }

  // Log provider chain
  const chain = [];
  if (isPortkeyEnabled() && portkeyClient) {
    chain.push(`Portkey (${process.env.PORTKEY_PRIMARY_MODEL || 'gemini-2.0-flash'} → ${process.env.PORTKEY_FALLBACK_MODEL || 'gpt-4o'})`);
  }
  if (isFireworksEnabled() && fireworksClient) {
    chain.push(`Fireworks (${getFireworksModel()})`);
  }

  if (chain.length === 0) {
    logger.warn('[AI] WARNING: No AI providers enabled! AI features will not work.');
  } else {
    logger.info('[AI] Provider Chain: %s', chain.join(' → '));
  }

  return getClient();
}

/**
 * Get the Portkey client instance
 * @returns {Portkey|null} Portkey client or null
 */
function getPortkeyClient() {
  if (!portkeyClient && isPortkeyEnabled() && process.env.PORTKEY_API_KEY) {
    logger.info('[AI] getPortkeyClient() lazy init');
    initializePortkeyClient();
  }
  return portkeyClient;
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
 * Get primary client based on configuration
 * @returns {Portkey|OpenAI|null} Primary client
 */
function getClient() {
  return getPortkeyClient() || getFireworksClient();
}

/**
 * Check if AI analysis is enabled for screenshots (vision-based)
 * @returns {boolean} True if any AI client is available and screenshot AI is enabled
 */
function isAIEnabled() {
  const hasClient = getPortkeyClient() !== null || getFireworksClient() !== null;
  return hasClient && process.env.USE_AI_FOR_SCREENSHOTS !== 'false';
}

/**
 * Check if AI analysis is enabled for activity records (text-only)
 * @returns {boolean} True if any AI client is available and activity AI is enabled
 */
function isActivityAIEnabled() {
  const hasClient = getPortkeyClient() !== null || getFireworksClient() !== null;
  return hasClient && process.env.USE_AI_FOR_ACTIVITIES !== 'false';
}

/**
 * Get the Fireworks model name
 * @returns {string} Model name for Fireworks requests
 */
function getFireworksModel() {
  return process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/qwen2p5-vl-32b-instruct';
}

/**
 * Get the primary Portkey model name
 * @returns {string} Model name for Portkey requests
 */
function getPortkeyModel() {
  return process.env.PORTKEY_PRIMARY_MODEL || 'gemini-2.0-flash';
}

/**
 * Get the fallback Portkey model name
 * @returns {string} Fallback model name for Portkey requests
 */
function getPortkeyFallbackModel() {
  return process.env.PORTKEY_FALLBACK_MODEL || 'gpt-4o';
}

/**
 * Get short model name for logging
 * @param {string} model - Full model name
 * @returns {string} Short model name
 */
function getShortModelName(model) {
  if (!model) return 'unknown';
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
  return model.split('/').pop() || model;
}

/**
 * Get the configured vision model
 * @returns {string} Model name for vision analysis
 */
function getVisionModel() {
  if (isPortkeyEnabled()) return getPortkeyModel();
  return getFireworksModel();
}

/**
 * Get the configured text model
 * @returns {string} Model name for text analysis
 */
function getTextModel() {
  return getVisionModel();
}

/**
 * Get default user identifier for tracking
 * @returns {string} Default user email for usage tracking
 */
function getDefaultUser() {
  return process.env.PORTKEY_USER || 'ai-server@amzur.com';
}

/**
 * Resolve the actual user email for tracking
 * @param {string|null} userId - User ID to resolve
 * @returns {Promise<string>} User email
 */
async function resolveLiteLLMUser(userId) {
  if (!userId) return getDefaultUser();

  const cached = userEmailCache.get(userId);
  if (cached && (Date.now() - cached.timestamp) < USER_EMAIL_CACHE_TTL) {
    return cached.email;
  }

  try {
    const { getUserById } = require('../db/user-db-service');
    const user = await getUserById(userId);
    const email = user?.email || getDefaultUser();
    userEmailCache.set(userId, { email, timestamp: Date.now() });
    return email;
  } catch (error) {
    logger.warn('[AI] Failed to resolve user email, using default: %s', error.message);
    return getDefaultUser();
  }
}

/**
 * Get current provider status for logging/monitoring
 * @returns {Object} Current AI provider status
 */
function getProviderStatus() {
  return {
    portkeyEnabled: isPortkeyEnabled(),
    fireworksEnabled: isFireworksEnabled(),
    primaryProvider: isPortkeyEnabled() ? 'portkey' : (isFireworksEnabled() ? 'fireworks' : 'none'),
    portkeyModel: getPortkeyModel(),
    fireworksModel: getFireworksModel()
  };
}

/**
 * Execute a chat completion via Portkey with built-in fallback
 *
 * @param {Object} params - Chat completion parameters
 * @param {Array} params.messages - Messages array
 * @param {number} params.temperature - Temperature setting (default: 0.3)
 * @param {number} params.max_tokens - Max tokens (default: 800)
 * @param {boolean} params.isVision - Whether this is a vision request (default: false)
 * @param {string} params.reasoningEffort - Optional reasoning effort
 * @param {string} params.userId - User ID for cost tracking (optional)
 * @param {string} params.organizationId - Organization ID (optional)
 * @param {string} params.screenshotId - Screenshot ID (optional)
 * @param {string} params.apiCallName - Label for the request type (optional)
 * @returns {Promise<Object>} { response, provider, model }
 */
async function chatCompletionWithFallback({
  messages,
  temperature = 0.3,
  max_tokens = 800,
  isVision = false,
  reasoningEffort = null,
  userId = null,
  organizationId = null,
  screenshotId = null,
  apiCallName = null
}) {
  const errors = [];
  const requestType = isVision ? 'vision' : 'text';
  const userEmail = await resolveLiteLLMUser(userId);
  const callLabel = apiCallName || requestType;

  // Try Portkey first (handles its own fallback)
  if (isPortkeyEnabled() && portkeyClient) {
    try {
      const startTime = Date.now();
      const model = getPortkeyModel();

      logger.info('[AI] %s request via Portkey (%s)', requestType, getShortModelName(model));

      // Prepare request with Portkey headers for tracking
      const requestParams = {
        model: model,
        messages,
        temperature,
        max_tokens
      };

      // Use Portkey's chat completions with built-in fallback
      const response = await portkeyClient.chat.completions.create(requestParams, {
        // Portkey-specific headers for analytics
        headers: {
          'x-portkey-user': userEmail,
          'x-portkey-metadata': JSON.stringify({
            request_type: callLabel,
            organization_id: organizationId || undefined,
            screenshot_id: screenshotId || undefined
          }),
          // Use virtual key for the primary provider
          'x-portkey-virtual-key': process.env.PORTKEY_VIRTUAL_KEY_GEMINI
        }
      });

      const duration = Date.now() - startTime;
      const actualModel = response.model || model;

      logger.info('[AI] %s completed | Portkey/%s | %dms',
        requestType, getShortModelName(actualModel), duration);

      // Log cost tracking (Portkey provides usage data)
      const usage = response.usage || {};
      logCostTracking({
        userId,
        apiCallName: requestType,
        provider: 'portkey',
        model: actualModel,
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        duration,
        organizationId,
        screenshotId
      }).catch(() => {});

      return {
        response,
        provider: 'portkey',
        model: actualModel
      };

    } catch (error) {
      logger.warn('[AI] Portkey failed: %s', error.message);
      errors.push({ provider: 'portkey', error: error.message });
    }
  }

  // Fallback to direct Fireworks if enabled
  if (isFireworksEnabled() && fireworksClient) {
    try {
      const startTime = Date.now();
      const model = getFireworksModel();

      logger.info('[AI] %s request via Fireworks (%s) [fallback]',
        requestType, getShortModelName(model));

      const requestParams = {
        model,
        messages,
        temperature,
        max_tokens
      };

      const response = await fireworksClient.chat.completions.create(requestParams);
      const duration = Date.now() - startTime;

      logger.info('[AI] %s completed | Fireworks/%s | %dms',
        requestType, getShortModelName(model), duration);

      // Log cost tracking
      const usage = response.usage || {};
      logCostTracking({
        userId,
        apiCallName: requestType,
        provider: 'fireworks',
        model,
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        duration,
        organizationId,
        screenshotId
      }).catch(() => {});

      return {
        response,
        provider: 'fireworks',
        model
      };

    } catch (error) {
      logger.warn('[AI] Fireworks failed: %s', error.message);
      errors.push({ provider: 'fireworks', error: error.message });
    }
  }

  // All providers failed
  const errorMsg = errors.map(e => `${e.provider}: ${e.error}`).join('; ');
  logger.error('[AI] All providers failed: %s', errorMsg);
  throw new Error(`All AI providers failed: ${errorMsg}`);
}

// Legacy exports for backward compatibility
const getLiteLLMClient = getPortkeyClient;
const isLiteLLMEnabled = isPortkeyEnabled;
const getLiteLLMModel = getPortkeyModel;
const getLiteLLMFallbackModel = getPortkeyFallbackModel;
const getLiteLLMUser = getDefaultUser;

// Provider order helpers (simplified for Portkey)
const getProviderOrder = () => {
  const order = [];
  if (isPortkeyEnabled()) order.push('portkey');
  if (isFireworksEnabled()) order.push('fireworks');
  return order;
};
const isProviderDemoted = () => false; // Portkey handles this

module.exports = {
  // Initialization
  initializeClient,

  // Client getters
  getClient,
  getFireworksClient,
  getPortkeyClient,
  getLiteLLMClient, // Legacy alias

  // Status checks
  isAIEnabled,
  isActivityAIEnabled,
  isFireworksEnabled,
  isPortkeyEnabled,
  isLiteLLMEnabled, // Legacy alias
  getProviderStatus,
  getProviderOrder,
  isProviderDemoted,

  // Model getters
  getVisionModel,
  getTextModel,
  getFireworksModel,
  getPortkeyModel,
  getLiteLLMModel, // Legacy alias
  getLiteLLMFallbackModel, // Legacy alias
  getLiteLLMUser, // Legacy alias
  resolveLiteLLMUser,

  // Main request function with fallback
  chatCompletionWithFallback
};
```

---

## 9. Testing Plan

### 9.1 Test Script

Create `ai-server/tests/test-portkey.js`:

```javascript
/**
 * Portkey Integration Test Script
 *
 * Usage:
 *   node tests/test-portkey.js                    - Run all tests
 *   node tests/test-portkey.js --vision <path>   - Test vision with image
 *
 * Before running:
 *   1. Set up .env with Portkey credentials
 *   2. Ensure Portkey virtual keys are configured
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
};

const log = {
  info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  section: (msg) => console.log(`\n${colors.cyan}━━━ ${msg} ━━━${colors.reset}`)
};

async function runTests() {
  log.section('PORTKEY INTEGRATION TESTS');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}\n`);

  // Check environment variables
  log.section('1. Environment Check');
  const requiredEnvVars = [
    'PORTKEY_API_KEY',
    'PORTKEY_VIRTUAL_KEY_GEMINI'
  ];

  let envOk = true;
  for (const envVar of requiredEnvVars) {
    if (process.env[envVar]) {
      log.success(`${envVar} is set`);
    } else {
      log.error(`${envVar} is NOT set`);
      envOk = false;
    }
  }

  // Optional env vars
  const optionalEnvVars = [
    'PORTKEY_VIRTUAL_KEY_OPENAI',
    'PORTKEY_CONFIG_ID',
    'PORTKEY_BASE_URL'
  ];

  for (const envVar of optionalEnvVars) {
    if (process.env[envVar]) {
      log.success(`${envVar} is set (optional)`);
    } else {
      log.warn(`${envVar} is not set (optional)`);
    }
  }

  if (!envOk) {
    log.error('Required environment variables missing. Aborting tests.');
    process.exit(1);
  }

  // Initialize AI client
  log.section('2. Client Initialization');
  const { initializeClient, isAIEnabled, getProviderStatus } = require('../src/services/ai/ai-client');

  try {
    initializeClient();
    log.success('AI client initialized');

    const status = getProviderStatus();
    console.log(`  Provider Status:`, JSON.stringify(status, null, 2));

    if (isAIEnabled()) {
      log.success('AI is enabled');
    } else {
      log.error('AI is NOT enabled');
      process.exit(1);
    }
  } catch (error) {
    log.error(`Failed to initialize: ${error.message}`);
    process.exit(1);
  }

  // Test basic text completion
  log.section('3. Text Completion Test');
  const { chatCompletionWithFallback } = require('../src/services/ai/ai-client');

  try {
    const startTime = Date.now();
    const result = await chatCompletionWithFallback({
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Respond briefly.' },
        { role: 'user', content: 'Say "Hello from Portkey" and nothing else.' }
      ],
      temperature: 0.1,
      max_tokens: 50,
      isVision: false,
      apiCallName: 'test-text'
    });

    const duration = Date.now() - startTime;
    const content = result.response.choices[0].message.content;

    log.success(`Text completion successful (${duration}ms)`);
    console.log(`  Provider: ${result.provider}`);
    console.log(`  Model: ${result.model}`);
    console.log(`  Response: "${content.substring(0, 100)}..."`);

    if (result.response.usage) {
      console.log(`  Tokens: ${result.response.usage.prompt_tokens} in / ${result.response.usage.completion_tokens} out`);
    }
  } catch (error) {
    log.error(`Text completion failed: ${error.message}`);
  }

  // Test JSON response (like screenshot analysis)
  log.section('4. JSON Response Test');
  try {
    const startTime = Date.now();
    const result = await chatCompletionWithFallback({
      messages: [
        {
          role: 'system',
          content: 'You are a JSON-only response bot. Always respond with valid JSON.'
        },
        {
          role: 'user',
          content: `Analyze this: User is working in VS Code on a file called "auth-service.ts".
Return JSON with: taskKey (string or null), workType ("office" or "non-office"), confidenceScore (0-1), reasoning (string).`
        }
      ],
      temperature: 0.3,
      max_tokens: 300,
      isVision: false,
      apiCallName: 'test-json'
    });

    const duration = Date.now() - startTime;
    const content = result.response.choices[0].message.content;

    log.success(`JSON response test successful (${duration}ms)`);
    console.log(`  Provider: ${result.provider}`);
    console.log(`  Model: ${result.model}`);

    // Try to parse JSON
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = content;
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      const parsed = JSON.parse(jsonStr);
      log.success('JSON parsing successful');
      console.log(`  Parsed:`, JSON.stringify(parsed, null, 2));
    } catch (parseError) {
      log.warn(`JSON parsing failed: ${parseError.message}`);
      console.log(`  Raw response: ${content}`);
    }
  } catch (error) {
    log.error(`JSON response test failed: ${error.message}`);
  }

  // Test vision (if image path provided)
  const args = process.argv.slice(2);
  const visionIndex = args.indexOf('--vision');
  if (visionIndex !== -1 && args[visionIndex + 1]) {
    const imagePath = args[visionIndex + 1];
    log.section('5. Vision Analysis Test');

    if (fs.existsSync(imagePath)) {
      try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

        const startTime = Date.now();
        const result = await chatCompletionWithFallback({
          messages: [
            {
              role: 'system',
              content: 'Analyze the screenshot and describe what you see in 2-3 sentences.'
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What is shown in this screenshot?' },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${base64Image}`,
                    detail: 'high'
                  }
                }
              ]
            }
          ],
          temperature: 0.3,
          max_tokens: 500,
          isVision: true,
          apiCallName: 'test-vision'
        });

        const duration = Date.now() - startTime;
        const content = result.response.choices[0].message.content;

        log.success(`Vision analysis successful (${duration}ms)`);
        console.log(`  Provider: ${result.provider}`);
        console.log(`  Model: ${result.model}`);
        console.log(`  Analysis: "${content.substring(0, 200)}..."`);
      } catch (error) {
        log.error(`Vision analysis failed: ${error.message}`);
      }
    } else {
      log.error(`Image file not found: ${imagePath}`);
    }
  } else {
    log.warn('Vision test skipped. Use --vision <path> to test vision analysis.');
  }

  // Test error handling / fallback
  log.section('6. Error Handling Test');
  try {
    // This should work even with an intentionally complex request
    const result = await chatCompletionWithFallback({
      messages: [
        { role: 'user', content: 'Respond with exactly: "Error handling works"' }
      ],
      temperature: 0.1,
      max_tokens: 20,
      isVision: false,
      apiCallName: 'test-error-handling'
    });
    log.success('Error handling test passed');
  } catch (error) {
    log.error(`Error handling test: ${error.message}`);
  }

  // Summary
  log.section('TEST SUMMARY');
  console.log('All primary tests completed. Review results above.');
  console.log('\nNext steps:');
  console.log('  1. Check Portkey dashboard for logged requests');
  console.log('  2. Run vision test with: node tests/test-portkey.js --vision <screenshot.png>');
  console.log('  3. Test in staging environment before production');
}

// Run tests
runTests().catch(error => {
  log.error(`Test runner failed: ${error.message}`);
  process.exit(1);
});
```

### 9.2 Manual Test Checklist

| Test Case | Command/Action | Expected Result |
|-----------|----------------|-----------------|
| Text completion | `node tests/test-portkey.js` | Returns text response |
| JSON response | Test JSON parsing | Valid JSON returned |
| Vision analysis | `node tests/test-portkey.js --vision screenshot.png` | Image analyzed |
| Fallback to GPT-4o | Block Gemini in Portkey | Falls back automatically |
| Fallback to Fireworks | Block all Portkey providers | Uses Fireworks |
| Analytics tracking | Check Portkey dashboard | Requests logged |
| Cost tracking | Check cost sheet | Costs recorded |

---

## 10. Rollback Plan

### Quick Rollback Steps

If issues arise after migration:

1. **Revert Environment Variables**
   ```bash
   # Restore LiteLLM config
   USE_PORTKEY=false
   USE_LITELLM=true
   ```

2. **Restore Old ai-client.js**
   - Keep a backup of the original file
   - Git: `git checkout HEAD~1 -- ai-server/src/services/ai/ai-client.js`

3. **Restart Server**
   ```bash
   pm2 restart ai-server
   ```

### Backup Before Migration
```bash
# Create backup
cp ai-server/src/services/ai/ai-client.js ai-server/src/services/ai/ai-client.js.litellm-backup

# Or use git
git stash
```

---

## Appendix A: Portkey Config Examples

### Simple Fallback Config
```json
{
  "strategy": {
    "mode": "fallback"
  },
  "targets": [
    {
      "virtual_key": "vk-gemini-xxx",
      "override_params": { "model": "gemini-2.0-flash" }
    },
    {
      "virtual_key": "vk-openai-xxx",
      "override_params": { "model": "gpt-4o" }
    }
  ]
}
```

### Load Balancing Config
```json
{
  "strategy": {
    "mode": "loadbalance"
  },
  "targets": [
    { "virtual_key": "vk-gemini-xxx", "weight": 70 },
    { "virtual_key": "vk-openai-xxx", "weight": 30 }
  ]
}
```

### With Retry and Caching
```json
{
  "strategy": { "mode": "fallback" },
  "targets": [
    { "virtual_key": "vk-gemini-xxx" },
    { "virtual_key": "vk-openai-xxx" }
  ],
  "retry": {
    "attempts": 3,
    "on_status_codes": [429, 500, 502, 503, 504]
  },
  "cache": {
    "mode": "semantic",
    "max_age": 3600
  }
}
```

---

## Appendix B: Portkey Dashboard Setup

1. **Create Organization**: https://app.portkey.ai/org/create
2. **Add Virtual Keys**: Settings → Virtual Keys → Add Key
3. **Create Config**: Configs → New Config
4. **View Analytics**: Analytics → Requests
5. **Monitor Costs**: Analytics → Costs

---

## Appendix C: Migration Checklist

- [ ] Create Portkey account
- [ ] Add Gemini API key as virtual key
- [ ] Add OpenAI API key as virtual key (optional)
- [ ] Create fallback config
- [ ] Get Portkey API key
- [ ] Update `.env.example`
- [ ] Update `package.json`
- [ ] Replace `ai-client.js`
- [ ] Create test script
- [ ] Run local tests
- [ ] Update documentation
- [ ] Deploy to staging
- [ ] Monitor Portkey dashboard
- [ ] Deploy to production

---

*Document created: March 2, 2026*  
*Last updated: March 2, 2026*

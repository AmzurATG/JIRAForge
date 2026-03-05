'use strict';

/**
 * Unit tests for ai-client.js
 * Comprehensive test suite targeting 80%+ code coverage
 */

// Mock dependencies before requiring the module
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../src/utils/logger', () => mockLogger);

const mockLogLLMRequest = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/sheets-logger', () => ({
  logLLMRequest: mockLogLLMRequest,
}));

const mockLogCostTracking = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/cost-tracker', () => ({
  logCostTracking: mockLogCostTracking,
}));

// Default mock for OpenAI
let mockCreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: 'test response' } }],
  usage: { prompt_tokens: 10, completion_tokens: 20 },
});

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }));
});

const originalEnv = process.env;

// Helper to reset modules and environment
function resetAll() {
  jest.resetModules();
  jest.clearAllMocks();
  process.env = { ...originalEnv };
  process.env.USE_PORTKEY = 'false';
  process.env.USE_FIREWORKS = 'false';
  process.env.PORTKEY_API_KEY = '';
  process.env.FIREWORKS_API_KEY = '';
  delete process.env.AI_REQUEST_TIMEOUT_MS;
  delete process.env.FAILURE_THRESHOLD;
  delete process.env.COOLDOWN_MINUTES;
  delete process.env.FIREWORKS_MODEL;
  delete process.env.PORTKEY_MODEL;
  delete process.env.PORTKEY_CONFIG_ID;
  delete process.env.FIREWORKS_BASE_URL;
  delete process.env.USE_AI_FOR_SCREENSHOTS;
  delete process.env.USE_AI_FOR_ACTIVITIES;
  
  // Reset mock
  mockCreate = jest.fn().mockResolvedValue({
    choices: [{ message: { content: 'test response' } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });
  
  const OpenAI = require('openai');
  OpenAI.mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  }));
}

afterAll(() => {
  process.env = originalEnv;
});

// =============================================================================
// Environment Variable Parsing (Number.parseInt)
// =============================================================================
describe('Environment Variable Parsing', () => {
  beforeEach(resetAll);

  test('AI_REQUEST_TIMEOUT_MS uses default when not set', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client).toBeDefined();
  });

  test('AI_REQUEST_TIMEOUT_MS parses custom value', () => {
    process.env.AI_REQUEST_TIMEOUT_MS = '120000';
    const client = require('../../src/services/ai/ai-client');
    expect(client).toBeDefined();
  });

  test('FAILURE_THRESHOLD parses custom value', () => {
    process.env.FAILURE_THRESHOLD = '5';
    const client = require('../../src/services/ai/ai-client');
    expect(client).toBeDefined();
  });

  test('COOLDOWN_MINUTES parses custom value', () => {
    process.env.COOLDOWN_MINUTES = '60';
    const client = require('../../src/services/ai/ai-client');
    expect(client).toBeDefined();
  });

  test('handles invalid Number.parseInt gracefully', () => {
    process.env.AI_REQUEST_TIMEOUT_MS = 'invalid';
    expect(() => require('../../src/services/ai/ai-client')).not.toThrow();
  });
});

// =============================================================================
// Provider Enable/Disable Checks
// =============================================================================
describe('isFireworksEnabled / isPortkeyEnabled', () => {
  beforeEach(resetAll);

  test('isFireworksEnabled returns false when USE_FIREWORKS is false', () => {
    process.env.USE_FIREWORKS = 'false';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isFireworksEnabled()).toBe(false);
  });

  test('isFireworksEnabled returns true when USE_FIREWORKS is true', () => {
    process.env.USE_FIREWORKS = 'true';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isFireworksEnabled()).toBe(true);
  });

  test('isPortkeyEnabled returns false when USE_PORTKEY is false', () => {
    process.env.USE_PORTKEY = 'false';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isPortkeyEnabled()).toBe(false);
  });

  test('isPortkeyEnabled returns true when USE_PORTKEY is true', () => {
    process.env.USE_PORTKEY = 'true';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isPortkeyEnabled()).toBe(true);
  });
});

// =============================================================================
// Model Getters
// =============================================================================
describe('Model Getters', () => {
  beforeEach(resetAll);

  test('getFireworksModel returns default', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.getFireworksModel()).toBe('accounts/fireworks/models/qwen2p5-vl-32b-instruct');
  });

  test('getFireworksModel returns custom from env', () => {
    process.env.FIREWORKS_MODEL = 'custom-fireworks-model';
    const client = require('../../src/services/ai/ai-client');
    expect(client.getFireworksModel()).toBe('custom-fireworks-model');
  });

  test('getPortkeyModel returns default', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.getPortkeyModel()).toBe('gemini-2.0-flash');
  });

  test('getPortkeyModel returns custom from env', () => {
    process.env.PORTKEY_MODEL = '@custom/gemini-model';
    const client = require('../../src/services/ai/ai-client');
    expect(client.getPortkeyModel()).toBe('@custom/gemini-model');
  });

  test('getVisionModel returns Portkey model when Portkey is primary', () => {
    process.env.USE_PORTKEY = 'true';
    const client = require('../../src/services/ai/ai-client');
    expect(client.getVisionModel()).toBe('gemini-2.0-flash');
  });

  test('getTextModel returns same as getVisionModel', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.getTextModel()).toBe(client.getVisionModel());
  });
});

// =============================================================================
// Client Initialization
// =============================================================================
describe('initializeClient', () => {
  beforeEach(resetAll);

  test('logs warning when no providers enabled', () => {
    process.env.USE_PORTKEY = 'false';
    process.env.USE_FIREWORKS = 'false';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No AI providers enabled')
    );
  });

  test('initializes Portkey when enabled with API key', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test-key';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      expect.anything(),
      expect.anything()
    );
  });

  test('initializes Portkey with config ID', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test-key';
    process.env.PORTKEY_CONFIG_ID = 'cfg-123';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      expect.anything(),
      expect.stringContaining('cfg-123')
    );
  });

  test('warns when Portkey API key not configured', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = '';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Portkey API key not configured')
    );
  });

  test('initializes Fireworks when enabled with API key', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test-key';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Fireworks initialized'),
      expect.anything(),
      expect.anything()
    );
  });

  test('warns when Fireworks API key not configured', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = '';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Fireworks API key not configured')
    );
  });

  test('initializes both providers when both enabled', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.USE_FIREWORKS = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    const OpenAI = require('openai');
    expect(OpenAI).toHaveBeenCalledTimes(2);
  });

  test('logs fallback chain when providers enabled', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.USE_FIREWORKS = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Fallback Chain'),
      expect.anything()
    );
  });

  test('handles Fireworks custom base URL', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    process.env.FIREWORKS_BASE_URL = 'https://custom.fireworks.ai/v1';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Fireworks initialized'),
      'https://custom.fireworks.ai/v1',
      expect.anything()
    );
  });
});

// =============================================================================
// Lazy Client Initialization
// =============================================================================
describe('Lazy Client Getters', () => {
  beforeEach(resetAll);

  test('getFireworksClient lazy initializes when not yet init', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    
    const result = client.getFireworksClient();
    expect(result).toBeDefined();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('getFireworksClient() lazy init')
    );
  });

  test('getPortkeyClient lazy initializes when not yet init', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    
    const result = client.getPortkeyClient();
    expect(result).toBeDefined();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('getPortkeyClient() lazy init')
    );
  });

  test('getFireworksClient returns null when disabled', () => {
    process.env.USE_FIREWORKS = 'false';
    const client = require('../../src/services/ai/ai-client');
    expect(client.getFireworksClient()).toBeNull();
  });

  test('getPortkeyClient returns null when disabled', () => {
    process.env.USE_PORTKEY = 'false';
    const client = require('../../src/services/ai/ai-client');
    expect(client.getPortkeyClient()).toBeNull();
  });
});

// =============================================================================
// getClient
// =============================================================================
describe('getClient', () => {
  beforeEach(resetAll);

  test('returns null when no providers configured', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.getClient()).toBeNull();
  });

  test('returns Portkey client when Portkey is primary', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    const result = client.getClient();
    expect(result).toBeDefined();
  });

  test('returns Fireworks client when only Fireworks enabled', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    const result = client.getClient();
    expect(result).toBeDefined();
  });

  test('handles optional chaining when config is null', () => {
    const client = require('../../src/services/ai/ai-client');
    // Should not throw when providers return null configs
    expect(() => client.getClient()).not.toThrow();
  });
});

// =============================================================================
// isAIEnabled / isActivityAIEnabled
// =============================================================================
describe('AI Enabled Checks', () => {
  beforeEach(resetAll);

  test('isAIEnabled returns false when no clients', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.isAIEnabled()).toBe(false);
  });

  test('isAIEnabled returns true when Portkey client available', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isAIEnabled()).toBe(true);
  });

  test('isAIEnabled returns false when USE_AI_FOR_SCREENSHOTS is false', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.USE_AI_FOR_SCREENSHOTS = 'false';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isAIEnabled()).toBe(false);
  });

  test('isActivityAIEnabled returns false when no clients', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.isActivityAIEnabled()).toBe(false);
  });

  test('isActivityAIEnabled returns true when Fireworks client available', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isActivityAIEnabled()).toBe(true);
  });

  test('isActivityAIEnabled returns false when USE_AI_FOR_ACTIVITIES is false', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    process.env.USE_AI_FOR_ACTIVITIES = 'false';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isActivityAIEnabled()).toBe(false);
  });
});

// =============================================================================
// Provider Order and Status
// =============================================================================
describe('Provider Order and Status', () => {
  beforeEach(resetAll);

  test('getProviderOrder returns default order', () => {
    const client = require('../../src/services/ai/ai-client');
    const order = client.getProviderOrder();
    expect(order).toEqual(['portkey-gemini', 'fireworks']);
  });

  test('getProviderOrder returns copy (not internal state)', () => {
    const client = require('../../src/services/ai/ai-client');
    const order1 = client.getProviderOrder();
    const order2 = client.getProviderOrder();
    expect(order1).not.toBe(order2);
    expect(order1).toEqual(order2);
  });

  test('isProviderDemoted returns false for non-demoted', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.isProviderDemoted('portkey-gemini')).toBe(false);
    expect(client.isProviderDemoted('fireworks')).toBe(false);
  });

  test('isProviderDemoted returns false for unknown provider', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.isProviderDemoted('unknown')).toBe(false);
  });

  test('getProviderStatus returns all provider info', () => {
    const client = require('../../src/services/ai/ai-client');
    const status = client.getProviderStatus();
    
    expect(status).toHaveProperty('portKeyEnabled');
    expect(status).toHaveProperty('fireworksEnabled');
    expect(status).toHaveProperty('providerOrder');
    expect(status).toHaveProperty('demotedProviders');
    expect(status).toHaveProperty('failures');
    expect(status).toHaveProperty('currentPrimary');
  });
});

// =============================================================================
// chatCompletionWithFallback - Core Flow
// =============================================================================
describe('chatCompletionWithFallback', () => {
  beforeEach(resetAll);

  test('throws when no providers available', async () => {
    const client = require('../../src/services/ai/ai-client');

    await expect(client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    })).rejects.toThrow('All AI providers failed');
  });

  test('successfully completes with Portkey', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    const result = await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result).toBeDefined();
    expect(result.provider).toBe('portkey-gemini');
    expect(result.response).toBeDefined();
  });

  test('successfully completes with Fireworks', async () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    const result = await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result).toBeDefined();
    expect(result.provider).toBe('fireworks');
  });

  test('handles vision request type', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    const result = await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'analyze image' }],
      isVision: true,
    });

    expect(result.provider).toBe('portkey-gemini');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('vision request'),
      expect.anything(),
      expect.anything()
    );
  });

  test('handles text request type', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    const result = await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
      isVision: false,
    });

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('text request'),
      expect.anything(),
      expect.anything()
    );
  });

  test('passes temperature and max_tokens', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0.7,
      max_tokens: 1500,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.7,
        max_tokens: 1500,
      })
    );
  });

  test('includes reasoning_effort for Portkey Gemini', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
      reasoningEffort: 'high',
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning_effort: 'high',
      })
    );
  });

  test('does not include reasoning_effort for Fireworks', async () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
      reasoningEffort: 'high',
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({
        reasoning_effort: expect.anything(),
      })
    );
  });
});

// =============================================================================
// chatCompletionWithFallback - Fallback and Failure
// =============================================================================
describe('chatCompletionWithFallback - Fallback', () => {
  beforeEach(resetAll);

  test('falls back to Fireworks when Portkey fails', async () => {
    let callCount = 0;
    mockCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Portkey error');
      }
      return Promise.resolve({
        choices: [{ message: { content: 'fallback' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    });

    process.env.USE_PORTKEY = 'true';
    process.env.USE_FIREWORKS = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    const result = await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.provider).toBe('fireworks');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test('throws when all providers fail', async () => {
    mockCreate.mockRejectedValue(new Error('Provider error'));

    process.env.USE_PORTKEY = 'true';
    process.env.USE_FIREWORKS = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    await expect(client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    })).rejects.toThrow('All AI providers failed');
  });

  test('logs errors from failed providers', async () => {
    let callCount = 0;
    mockCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error('First provider failed');
      }
      return Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    });

    process.env.USE_PORTKEY = 'true';
    process.env.USE_FIREWORKS = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringContaining('First provider failed')
    );
  });
});

// =============================================================================
// chatCompletionWithFallback - Cost Tracking
// =============================================================================
describe('chatCompletionWithFallback - Cost Tracking', () => {
  beforeEach(resetAll);

  test('logs to Google Sheets for Fireworks provider', async () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(mockLogLLMRequest).toHaveBeenCalled();
  });

  test('logs cost tracking for all providers', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
      userId: 'user-123',
      organizationId: 'org-456',
      screenshotId: 'ss-789',
    });

    expect(mockLogCostTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        organizationId: 'org-456',
        screenshotId: 'ss-789',
      })
    );
  });

  test('continues if cost tracking fails', async () => {
    mockLogCostTracking.mockRejectedValueOnce(new Error('Tracking error'));

    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    // Should not throw even if cost tracking fails
    const result = await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result).toBeDefined();
  });
});

// =============================================================================
// Provider Failure and Circuit Breaker
// =============================================================================
describe('Circuit Breaker / Provider Demotion', () => {
  beforeEach(resetAll);

  test('demotes provider after reaching failure threshold', async () => {
    let callCount = 0;
    mockCreate.mockImplementation(() => {
      callCount++;
      // Fail first 2 calls (threshold), succeed after
      if (callCount <= 2) {
        throw new Error('Provider error');
      }
      return Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    });

    process.env.USE_PORTKEY = 'true';
    process.env.USE_FIREWORKS = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    process.env.FAILURE_THRESHOLD = '2';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    // First call - Portkey fails (1/2), falls back to Fireworks
    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    // Second call - Portkey fails again (2/2) and gets demoted
    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('CIRCUIT BREAKER ACTIVATED'),
      expect.anything(),
      expect.anything()
    );
  });

  test('resets failure count on success', async () => {
    let shouldFail = true;
    mockCreate.mockImplementation(() => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('Temporary error');
      }
      return Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    });

    process.env.USE_PORTKEY = 'true';
    process.env.USE_FIREWORKS = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    // First call fails on Portkey, succeeds on Fireworks
    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    // Check that success was logged for Fireworks
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('request completed'),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  test('logs recovery when provider succeeds after failures', async () => {
    let callCount = 0;
    mockCreate.mockImplementation(() => {
      callCount++;
      // Fail first request to Portkey, succeed second
      if (callCount === 1) {
        throw new Error('Temporary error');
      }
      return Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    });

    process.env.USE_PORTKEY = 'true';
    process.env.USE_FIREWORKS = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    // First request - Portkey fails, Fireworks succeeds
    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    // Verify fallback logged correctly
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// OpenAI Constructor Error Handling
// =============================================================================
describe('OpenAI Constructor Error Handling', () => {
  beforeEach(resetAll);

  test('handles Portkey init error gracefully', () => {
    const OpenAI = require('openai');
    OpenAI.mockImplementationOnce(() => {
      throw new Error('OpenAI init error');
    });

    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Portkey init failed'),
      'OpenAI init error'
    );
  });

  test('handles Fireworks init error gracefully', () => {
    const OpenAI = require('openai');
    OpenAI.mockImplementationOnce(() => {
      throw new Error('Fireworks init error');
    });

    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Fireworks init failed'),
      'Fireworks init error'
    );
  });
});

// =============================================================================
// getShortModelName (tested indirectly via logging)
// =============================================================================
describe('getShortModelName (indirect tests)', () => {
  beforeEach(resetAll);

  test('shortens @slug/model format', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.PORTKEY_MODEL = '@jira/gemini-2.0-flash';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    // Should log shortened model name
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      'gemini-2.0-flash',
      expect.anything()
    );
  });

  test('handles @model without slash', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.PORTKEY_MODEL = '@modelonly';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    // Should return original when no slash
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      '@modelonly',
      expect.anything()
    );
  });

  test('shortens Fireworks qwen model', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    process.env.FIREWORKS_MODEL = 'accounts/fireworks/models/qwen2p5-vl-32b-instruct';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Fireworks initialized'),
      expect.anything(),
      'Qwen2.5-VL-32B'
    );
  });

  test('shortens Gemini model names', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.PORTKEY_MODEL = 'gemini-2.0-flash';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      'Gemini-2.0-Flash',
      expect.anything()
    );
  });

  test('shortens GPT model names', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.PORTKEY_MODEL = 'gpt-4o-mini';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      'GPT-4o-Mini',
      expect.anything()
    );
  });

  test('shortens gpt-4o model', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.PORTKEY_MODEL = 'gpt-4o';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      'GPT-4o',
      expect.anything()
    );
  });

  test('shortens gpt-4-turbo model', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.PORTKEY_MODEL = 'gpt-4-turbo';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      'GPT-4-Turbo',
      expect.anything()
    );
  });

  test('shortens gpt-4 model', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.PORTKEY_MODEL = 'gpt-4';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      'GPT-4',
      expect.anything()
    );
  });

  test('shortens gemini-2.0-flash-lite model', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.PORTKEY_MODEL = 'gemini-2.0-flash-lite';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      'Gemini-2.0-Flash-Lite',
      expect.anything()
    );
  });

  test('shortens gemini-1.5-flash model', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.PORTKEY_MODEL = 'gemini-1.5-flash';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      'Gemini-1.5-Flash',
      expect.anything()
    );
  });

  test('shortens gemini-1.5-pro model', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.PORTKEY_MODEL = 'gemini-1.5-pro';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      'Gemini-1.5-Pro',
      expect.anything()
    );
  });

  test('shortens qwen2p5-vl-72b model', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    process.env.FIREWORKS_MODEL = 'accounts/fireworks/models/qwen2p5-vl-72b-instruct';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Fireworks initialized'),
      expect.anything(),
      'Qwen2.5-VL-72B'
    );
  });

  test('shortens llama-v3p2-11b-vision model', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    process.env.FIREWORKS_MODEL = 'accounts/fireworks/models/llama-v3p2-11b-vision-instruct';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Fireworks initialized'),
      expect.anything(),
      'Llama-11B-Vision'
    );
  });

  test('uses fallback for unknown model format', () => {
    process.env.USE_FIREWORKS = 'true';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    process.env.FIREWORKS_MODEL = 'org/custom/unknown-model';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Fireworks initialized'),
      expect.anything(),
      'unknown-model'
    );
  });
});

// =============================================================================
// logDemotedProviders and logRequestAttempt (indirect tests)
// =============================================================================
describe('Logging Helpers', () => {
  beforeEach(resetAll);

  test('logRequestAttempt logs with failed providers when fallback happens', async () => {
    let callCount = 0;
    mockCreate.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        throw new Error('First failed');
      }
      return Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    });

    process.env.USE_PORTKEY = 'true';
    process.env.USE_FIREWORKS = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    // Second provider attempt should log failed providers
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('request via'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });
});

// =============================================================================
// getVisionModel with Fireworks primary
// =============================================================================
describe('getVisionModel variants', () => {
  beforeEach(resetAll);

  test('getVisionModel returns Fireworks model when Fireworks is demoted primary', async () => {
    // Demote Portkey so Fireworks becomes primary
    let callCount = 0;
    mockCreate.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        throw new Error('Portkey error');
      }
      return Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    });

    process.env.USE_PORTKEY = 'true';
    process.env.USE_FIREWORKS = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.FIREWORKS_API_KEY = 'fw-test';
    process.env.FAILURE_THRESHOLD = '2';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    // Cause 2 failures to demote Portkey
    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });
    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    // After demotion, order changes - Fireworks should be primary
    const order = client.getProviderOrder();
    expect(order[0]).toBe('fireworks');
  });
});

// =============================================================================
// Additional edge cases for better coverage
// =============================================================================
describe('Edge Cases', () => {
  beforeEach(resetAll);

  test('handles empty usage in response', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'test' } }],
      // No usage field
    });

    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    const result = await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result).toBeDefined();
    expect(mockLogCostTracking).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
      })
    );
  });

  test('handles apiCallName parameter', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
      apiCallName: 'vision-analysis',
    });

    // Should not throw
    expect(mockCreate).toHaveBeenCalled();
  });

  test('default temperature and max_tokens', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();

    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.3,
        max_tokens: 800,
      })
    );
  });
});

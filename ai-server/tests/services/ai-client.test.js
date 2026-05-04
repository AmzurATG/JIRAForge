'use strict';

/**
 * Unit tests for ai-client.js (Portkey-only).
 */

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../src/utils/logger', () => mockLogger);

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

function resetAll() {
  jest.resetModules();
  jest.clearAllMocks();
  process.env = { ...originalEnv };
  process.env.USE_PORTKEY = 'false';
  process.env.PORTKEY_API_KEY = '';
  delete process.env.AI_REQUEST_TIMEOUT_MS;
  delete process.env.PORTKEY_MODEL;
  delete process.env.PORTKEY_CONFIG_ID;
  delete process.env.USE_AI_FOR_ACTIVITIES;

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
// isPortkeyEnabled
// =============================================================================
describe('isPortkeyEnabled', () => {
  beforeEach(resetAll);

  test('returns false when USE_PORTKEY is false', () => {
    process.env.USE_PORTKEY = 'false';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isPortkeyEnabled()).toBe(false);
  });

  test('returns true when USE_PORTKEY is true', () => {
    process.env.USE_PORTKEY = 'true';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isPortkeyEnabled()).toBe(true);
  });
});

// =============================================================================
// Model getters
// =============================================================================
describe('getPortkeyModel / getTextModel', () => {
  beforeEach(resetAll);

  test('getPortkeyModel returns default', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.getPortkeyModel()).toBe('gemini-2.0-flash');
  });

  test('getPortkeyModel returns custom from env', () => {
    process.env.PORTKEY_MODEL = 'gpt-5-mini';
    const client = require('../../src/services/ai/ai-client');
    expect(client.getPortkeyModel()).toBe('gpt-5-mini');
  });

  test('getTextModel mirrors getPortkeyModel', () => {
    process.env.PORTKEY_MODEL = 'custom-model';
    const client = require('../../src/services/ai/ai-client');
    expect(client.getTextModel()).toBe('custom-model');
  });
});

// =============================================================================
// initializeClient
// =============================================================================
describe('initializeClient', () => {
  beforeEach(resetAll);

  test('initializes Portkey when enabled with API key', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test-key';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Portkey initialized'),
      expect.any(String),
      expect.any(String)
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

  test('warns when Portkey not enabled', () => {
    process.env.USE_PORTKEY = 'false';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Portkey not enabled')
    );
  });

  test('attaches x-portkey-config header when PORTKEY_CONFIG_ID is set', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test-key';
    process.env.PORTKEY_CONFIG_ID = 'pc-test-config';
    const OpenAI = require('openai');
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();
    const ctorArgs = OpenAI.mock.calls[OpenAI.mock.calls.length - 1][0];
    expect(ctorArgs.defaultHeaders['x-portkey-config']).toBe('pc-test-config');
  });

  test('handles Portkey init error gracefully', () => {
    const OpenAI = require('openai');
    OpenAI.mockImplementationOnce(() => {
      throw new Error('Portkey init error');
    });
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    client.initializeClient();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Portkey init failed'),
      'Portkey init error'
    );
  });
});

// =============================================================================
// getPortkeyClient / getClient
// =============================================================================
describe('getPortkeyClient / getClient', () => {
  beforeEach(resetAll);

  test('getPortkeyClient lazy-initializes when not yet init', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    const result = client.getPortkeyClient();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('getPortkeyClient() lazy init')
    );
    expect(result).not.toBeNull();
  });

  test('getPortkeyClient returns null when disabled', () => {
    process.env.USE_PORTKEY = 'false';
    const client = require('../../src/services/ai/ai-client');
    expect(client.getPortkeyClient()).toBeNull();
  });

  test('getClient returns the Portkey client', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    expect(client.getClient()).not.toBeNull();
  });

  test('getClient returns null when nothing configured', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.getClient()).toBeNull();
  });
});

// =============================================================================
// isActivityAIEnabled
// =============================================================================
describe('isActivityAIEnabled', () => {
  beforeEach(resetAll);

  test('returns false when no client available', () => {
    const client = require('../../src/services/ai/ai-client');
    expect(client.isActivityAIEnabled()).toBe(false);
  });

  test('returns true when Portkey client is available', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isActivityAIEnabled()).toBe(true);
  });

  test('returns false when USE_AI_FOR_ACTIVITIES=false', () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    process.env.USE_AI_FOR_ACTIVITIES = 'false';
    const client = require('../../src/services/ai/ai-client');
    expect(client.isActivityAIEnabled()).toBe(false);
  });
});

// =============================================================================
// chatCompletionWithFallback
// =============================================================================
describe('chatCompletionWithFallback', () => {
  beforeEach(resetAll);

  test('throws when Portkey client is not configured', async () => {
    const client = require('../../src/services/ai/ai-client');
    await expect(
      client.chatCompletionWithFallback({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow('Portkey client not configured');
  });

  test('successfully completes via Portkey', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    const result = await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
    });
    expect(result.provider).toBe('portkey');
    expect(result.response.choices[0].message.content).toBe('test response');
  });

  test('sends max_completion_tokens (not max_tokens) to the SDK', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1234,
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const sentBody = mockCreate.mock.calls[0][0];
    expect(sentBody.max_completion_tokens).toBe(1234);
    expect(sentBody.max_tokens).toBeUndefined();
  });

  test('does not send temperature to the SDK', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'hi' }],
    });
    const sentBody = mockCreate.mock.calls[0][0];
    expect(sentBody.temperature).toBeUndefined();
  });

  test('default max_tokens is 800', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'hi' }],
    });
    const sentBody = mockCreate.mock.calls[0][0];
    expect(sentBody.max_completion_tokens).toBe(800);
  });

  test('rethrows SDK errors', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    mockCreate = jest.fn().mockRejectedValue(new Error('boom'));
    const OpenAI = require('openai');
    OpenAI.mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }));
    const client = require('../../src/services/ai/ai-client');
    await expect(
      client.chatCompletionWithFallback({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow('boom');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Portkey request failed'),
      'boom'
    );
  });

  test('logs vision request type when isVision=true', async () => {
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'pk-test';
    const client = require('../../src/services/ai/ai-client');
    await client.chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'hi' }],
      isVision: true,
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('%s request via Portkey'),
      'vision',
      expect.any(String)
    );
  });
});

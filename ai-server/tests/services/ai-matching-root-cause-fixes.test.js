/**
 * AI Issue Matching Root Cause Fix Tests
 * Tests for:
 * - RC4: Issue cap increased from 30 to 50
 * - RC8: Temperature parameter in chatCompletionWithFallback
 * - RC5: Previous match context in batch prompt
 * - RC6: Default batch size increased to 60
 */

'use strict';

const mockCreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: '[]' } }]
});

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } }
  }));
});

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/services/db/activity-db-service', () => ({
  updateActivityRecordAnalysis: jest.fn(),
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({ select: jest.fn(), insert: jest.fn(), update: jest.fn(), delete: jest.fn() }))
  }))
}));

// --- RC4 Tests: Issue cap increase ---
const { formatAssignedIssues } = require('../../src/services/ai/prompts');

describe('RC4 — formatAssignedIssues issue cap', () => {
  it('should return up to 50 issues (not 30)', () => {
    const issues = Array.from({ length: 55 }, (_, i) => ({
      key: `PROJ-${i}`,
      summary: `Task ${i}`,
      status: 'In Progress',
      updated: new Date(Date.now() - i * 86400000).toISOString()
    }));
    const result = formatAssignedIssues(issues);
    const keys = result.match(/PROJ-\d+/g);
    expect(keys.length).toBe(50);
  });

  it('should still sort by recency before truncating at 50', () => {
    const issues = Array.from({ length: 55 }, (_, i) => ({
      key: `PROJ-${i}`,
      summary: `Task ${i}`,
      status: 'In Progress',
      updated: new Date(Date.now() - i * 86400000).toISOString()
    }));
    const result = formatAssignedIssues(issues);
    // PROJ-0 (newest) should appear before PROJ-49
    expect(result.indexOf('PROJ-0')).toBeLessThan(result.indexOf('PROJ-49'));
    // PROJ-50 and above should NOT appear (truncated)
    expect(result).not.toContain('PROJ-50');
    expect(result).not.toContain('PROJ-54');
  });
});

// --- RC8 Tests: Temperature parameter ---
describe('RC8 — temperature parameter in chatCompletionWithFallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.USE_PORTKEY = 'true';
    process.env.PORTKEY_API_KEY = 'test-key';
    process.env.PORTKEY_VIRTUAL_KEY = 'test-vkey';
    process.env.PORTKEY_MODEL = 'gemini-2.0-flash';
  });

  afterEach(() => {
    delete process.env.USE_PORTKEY;
    delete process.env.PORTKEY_API_KEY;
    delete process.env.PORTKEY_VIRTUAL_KEY;
    delete process.env.PORTKEY_MODEL;
  });

  it('should accept temperature parameter', async () => {
    const { chatCompletionWithFallback, initializeClient } = require('../../src/services/ai/ai-client');
    initializeClient();

    await chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0.1
    });

    expect(mockCreate).toHaveBeenCalled();
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.temperature).toBe(0.1);
  });

  it('should default temperature to 0.1 for Gemini models when not specified', async () => {
    const { chatCompletionWithFallback, initializeClient } = require('../../src/services/ai/ai-client');
    initializeClient();

    await chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }]
    });

    expect(mockCreate).toHaveBeenCalled();
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.temperature).toBe(0.1);
  });

  it('should omit temperature for GPT-5 models', async () => {
    process.env.PORTKEY_MODEL = 'gpt-5';
    const { chatCompletionWithFallback, initializeClient } = require('../../src/services/ai/ai-client');
    initializeClient();

    await chatCompletionWithFallback({
      messages: [{ role: 'user', content: 'test' }],
      temperature: 0.1
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.temperature).toBeUndefined();
  });
});

// --- RC5 Tests: Previous match context ---
describe('RC5 — previous match context in batch prompt', () => {
  const { _buildBatchAnalysisPrompt: buildBatchAnalysisPrompt } = require('../../src/services/activity-service');

  const mockRecord = {
    id: 'rec-1',
    application_name: 'Code.exe',
    window_title: 'auth.js - project',
    total_time_seconds: 300,
    start_time: '2026-04-16T09:00:00Z',
    end_time: '2026-04-16T09:05:00Z',
    ocr_text: 'function authenticate() { return true; }',
  };

  it('should include previous match context when provided', () => {
    const previousContext = {
      taskKey: 'PROJ-45',
      confidenceScore: 0.75,
      minutesAgo: 5
    };
    const prompt = buildBatchAnalysisPrompt([mockRecord], 'PROJ-45: Auth work', previousContext);
    expect(prompt).toContain('PROJ-45');
    expect(prompt).toContain('Previous session');
  });

  it('should work without previous match context (backward compatible)', () => {
    const prompt = buildBatchAnalysisPrompt([mockRecord], 'PROJ-45: Auth work');
    expect(prompt).toContain('Activity Records');
    expect(prompt).not.toContain('Previous session');
  });
});

// --- RC6 Tests: Default batch size ---
describe('RC6 — default batch size increased', () => {
  it('should default batch size to 60', () => {
    delete process.env.ACTIVITY_POLLING_BATCH_SIZE;
    const service = require('../../src/services/activity-polling-service');
    expect(service.batchSize).toBe(60);
  });
});

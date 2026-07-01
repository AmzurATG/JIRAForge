'use strict';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../../src/services/ai/ai-client', () => ({
  chatCompletionWithFallback: jest.fn(),
  isPortkeyEnabled: jest.fn().mockReturnValue(true)
}));

jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: jest.fn(() => null)
}));

const { batchAnalyzeDescriptions } = require('../../src/services/description-service');

describe('batchAnalyzeDescriptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should handle empty issues array', async () => {
    const result = await batchAnalyzeDescriptions({ issues: [], orgId: 'test-org', accountId: 'test-user' });
    expect(result.scores).toEqual({});
    expect(result.stats).toEqual({ cacheHits: 0, filled: 0, errors: 0 });
  });

  test('should analyze issues and apply caching stats correctly', async () => {
    // Mock runLLM to return a mock score
    const runLLM = jest.fn().mockResolvedValue({
      score: 85,
      issues: [],
      suggestions: [],
      improved_title: 'Improved Title',
      improved_description: 'Improved Description'
    });

    const issues = [
      { issueKey: 'TEST-1', title: 'Issue 1 title', description: 'Issue 1 description', issueType: 'Task', projectKey: 'TEST' },
      { issueKey: 'TEST-2', title: 'Issue 2 title', description: 'Issue 2 description', issueType: 'Bug', projectKey: 'TEST' }
    ];

    const result = await batchAnalyzeDescriptions({
      issues,
      orgId: 'test-org',
      accountId: 'test-user',
      deps: { runLLM }
    });

    expect(result.scores['TEST-1']).toBeDefined();
    expect(result.scores['TEST-1'].score).toBe(85);
    expect(result.scores['TEST-2']).toBeDefined();
    expect(result.scores['TEST-2'].score).toBe(85);
    expect(result.stats.filled).toBe(2);
    expect(result.stats.errors).toBe(0);
  });
});

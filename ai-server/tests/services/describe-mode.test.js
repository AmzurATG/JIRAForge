'use strict';

// Describe mode: when a user has NO assigned Jira issues (e.g. non-Jira Google
// SSO users), analyzeBatch must NOT match an issue — it describes the activity.

jest.mock('../../src/services/ai/ai-client', () => ({
  chatCompletionWithFallback: jest.fn(),
  isActivityAIEnabled: jest.fn(),
}));

jest.mock('../../src/services/ai/prompts', () => ({
  formatAssignedIssues: jest.fn(() => 'None - track all work'),
  buildAppIdentificationPrompt: jest.fn(),
  APP_IDENTIFICATION_SYSTEM_PROMPT: 'mock system prompt',
}));

jest.mock('../../src/services/db/activity-db-service', () => ({
  updateActivityRecordAnalysis: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
}));

const { chatCompletionWithFallback, isActivityAIEnabled } = require('../../src/services/ai/ai-client');
const activityDbService = require('../../src/services/db/activity-db-service');
const { analyzeBatch, _buildDescribeAnalysisPrompt } = require('../../src/services/activity-service');

const makeLLMResponse = (content) => ({
  response: { choices: [{ message: { content }, finish_reason: 'stop' }] },
  provider: 'portkey',
  model: 'gemini-2.0-flash',
});

const records = [
  {
    id: 'rec-1',
    application_name: 'Code.exe',
    window_title: 'onboarding.md - vscode',
    ocr_text: 'writing onboarding documentation',
    ocr_confidence: 0.9,
    total_time_seconds: 300,
    start_time: '2026-05-29T10:00:00Z',
    end_time: '2026-05-29T10:05:00Z',
  },
];

describe('activity-service describe mode (no assigned issues)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
  });

  test('describes activity and never produces a taskKey when issue list is empty', async () => {
    chatCompletionWithFallback.mockResolvedValue(makeLLMResponse(JSON.stringify([
      { recordIndex: 0, activitySummary: 'Writing onboarding documentation in VS Code', activityCategory: 'documentation', workType: 'office' }
    ])));

    const result = await analyzeBatch(records, [], 'user-1', 'org-1');

    // The AI saw the describe prompt, not the matching prompt.
    const systemPrompt = chatCompletionWithFallback.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toMatch(/summariz/i);
    expect(systemPrompt).not.toMatch(/Jira issue/i);

    // Persisted with the activity summary and NO task key.
    expect(activityDbService.updateActivityRecordAnalysis).toHaveBeenCalledTimes(1);
    const [recordId, payload] = activityDbService.updateActivityRecordAnalysis.mock.calls[0];
    expect(recordId).toBe('rec-1');
    expect(payload.taskKey == null).toBe(true);
    expect(payload.metadata.activitySummary).toBe('Writing onboarding documentation in VS Code');
    expect(payload.metadata.activityCategory).toBe('documentation');
    expect(result.recordsProcessed).toBe(1);
  });

  test('describe prompt instructs no issue/ticket keys', () => {
    const prompt = _buildDescribeAnalysisPrompt(records);
    expect(prompt).toMatch(/do not produce any issue\/ticket keys/i);
    expect(prompt).toMatch(/activitySummary/);
  });
});

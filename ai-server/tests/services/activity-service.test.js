'use strict';

jest.mock('../../src/services/ai/ai-client', () => ({
  chatCompletionWithFallback: jest.fn(),
  isActivityAIEnabled: jest.fn(),
}));

jest.mock('../../src/services/ai/prompts', () => ({
  formatAssignedIssues: jest.fn(),
  buildAppIdentificationPrompt: jest.fn(),
  APP_IDENTIFICATION_SYSTEM_PROMPT: 'mock system prompt',
}));

jest.mock('../../src/services/db/activity-db-service', () => ({
  updateActivityRecordAnalysis: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const { chatCompletionWithFallback, isActivityAIEnabled } = require('../../src/services/ai/ai-client');
const { formatAssignedIssues, buildAppIdentificationPrompt } = require('../../src/services/ai/prompts');
const activityDbService = require('../../src/services/db/activity-db-service');
const { analyzeBatch, classifyUnknownApp, identifyAppByName } = require('../../src/services/activity-service');

// Helper — builds a standard LLM response around a content string
const makeLLMResponse = (content) => ({
  response: { choices: [{ message: { content } }] },
  provider: 'portkey',
  model: 'gemini-2.0-flash',
});

// ============================================================================
// analyzeBatch
// Covers: parseAnalysisResponse, validateAnalysisKeys, persistAnalysisResults
// ============================================================================
describe('analyzeBatch', () => {
  const records = [
    {
      id: 'rec-1',
      application_name: 'VSCode',
      window_title: 'auth.js - project',
      total_time_seconds: 300,
      start_time: '2024-01-01T09:00:00Z',
      end_time: '2024-01-01T09:05:00Z',
      ocr_text: 'function authenticate() {',
    },
  ];

  const issues = [
    { key: 'ATG-123', summary: 'Implement auth' },
    { key: 'ATG-456', summary: 'Fix dashboard' },
  ];

  const validAnalysis = [
    {
      recordIndex: 0,
      taskKey: 'ATG-123',
      projectKey: 'ATG',
      confidenceScore: 0.9,
      workType: 'office',
      reasoning: 'Auth work',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
    formatAssignedIssues.mockReturnValue('ATG-123: Implement auth');
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify(validAnalysis))
    );
    activityDbService.updateActivityRecordAnalysis.mockResolvedValue({});
  });

  it('throws when AI is not enabled', async () => {
    isActivityAIEnabled.mockReturnValue(false);
    await expect(analyzeBatch(records, issues, 'user-1', 'org-1'))
      .rejects.toThrow('AI client not initialized');
  });

  it('returns analyses, recordsProcessed, provider and model on success', async () => {
    const result = await analyzeBatch(records, issues, 'user-1', 'org-1');
    expect(result.analyses).toEqual(validAnalysis);
    expect(result.recordsProcessed).toBe(1);
    expect(result.provider).toBe('portkey');
    expect(result.model).toBe('gemini-2.0-flash');
  });

  // --- parseAnalysisResponse ---

  it('parses JSON array wrapped in a markdown code block', async () => {
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse('```json\n' + JSON.stringify(validAnalysis) + '\n```')
    );
    const result = await analyzeBatch(records, issues, 'user-1', 'org-1');
    expect(result.analyses).toEqual(validAnalysis);
  });

  it('throws when the response contains no parseable JSON array', async () => {
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse('Sorry, I cannot process this.')
    );
    await expect(analyzeBatch(records, issues, 'user-1', 'org-1'))
      .rejects.toThrow('Failed to parse AI response as JSON array');
  });

  it('throws TypeError when the AI returns a JSON object instead of an array', async () => {
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse('{"key":"value"}')
    );
    await expect(analyzeBatch(records, issues, 'user-1', 'org-1'))
      .rejects.toThrow(TypeError);
  });

  it('salvages complete objects from a truncated JSON array response', async () => {
    // The array starts normally but the second object is cut off mid-way.
    // salvageTruncatedJsonArray recovers only the first complete entry.
    const truncated =
      '[{"recordIndex":0,"taskKey":"ATG-123","projectKey":"ATG","confidenceScore":0.9,"workType":"office","reasoning":"auth"},' +
      '{"recordIndex":1,"taskKey":null]';
    chatCompletionWithFallback.mockResolvedValue(makeLLMResponse(truncated));
    const result = await analyzeBatch(records, issues, 'user-1', 'org-1');
    expect(result.analyses).toHaveLength(1);
    expect(result.analyses[0].taskKey).toBe('ATG-123');
  });

  it('throws when truncated JSON array has no recoverable complete objects', async () => {
    // The brackets are present so the regex matches, JSON.parse fails, and
    // salvageTruncatedJsonArray finds no object with "recordIndex" → throws.
    const unrecoverable = '[{"taskKey":null]'; // no "recordIndex" key
    chatCompletionWithFallback.mockResolvedValue(makeLLMResponse(unrecoverable));
    await expect(analyzeBatch(records, issues, 'user-1', 'org-1'))
      .rejects.toThrow('no complete records found');
  });

  // --- validateAnalysisKeys ---

  it('clears taskKey and projectKey when AI returns a key not in assigned issues', async () => {
    const hallucinated = [
      {
        recordIndex: 0,
        taskKey: 'FAKE-999',
        projectKey: 'FAKE',
        confidenceScore: 0.8,
        workType: 'office',
        reasoning: 'Hallucinated',
      },
    ];
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify(hallucinated))
    );
    const result = await analyzeBatch(records, issues, 'user-1', 'org-1');
    expect(result.analyses[0].taskKey).toBeNull();
    expect(result.analyses[0].projectKey).toBeNull();
    expect(result.analyses[0].confidenceScore).toBeLessThanOrEqual(0.3);
  });

  it('keeps taskKey when it is present in the assigned issues list', async () => {
    const result = await analyzeBatch(records, issues, 'user-1', 'org-1');
    expect(result.analyses[0].taskKey).toBe('ATG-123');
  });

  it('keeps null taskKey without modification', async () => {
    const noKey = [{ ...validAnalysis[0], taskKey: null, projectKey: null }];
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify(noKey))
    );
    const result = await analyzeBatch(records, issues, 'user-1', 'org-1');
    expect(result.analyses[0].taskKey).toBeNull();
  });

  // --- persistAnalysisResults ---

  it('persists each analysis result to the database with correct arguments', async () => {
    await analyzeBatch(records, issues, 'user-1', 'org-1');
    expect(activityDbService.updateActivityRecordAnalysis).toHaveBeenCalledTimes(1);
    expect(activityDbService.updateActivityRecordAnalysis).toHaveBeenCalledWith(
      'rec-1',
      expect.objectContaining({
        taskKey: 'ATG-123',
        projectKey: 'ATG',
        metadata: expect.objectContaining({
          workType: 'office',
          aiProvider: 'portkey',
          aiModel: 'gemini-2.0-flash',
        }),
      })
    );
  });

  it('continues persisting remaining records if one DB update fails', async () => {
    const twoRecords = [{ ...records[0] }, { ...records[0], id: 'rec-2' }];
    const twoAnalyses = [
      { ...validAnalysis[0] },
      {
        recordIndex: 1,
        taskKey: 'ATG-456',
        projectKey: 'ATG',
        confidenceScore: 0.7,
        workType: 'office',
        reasoning: 'Dashboard',
      },
    ];
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify(twoAnalyses))
    );
    activityDbService.updateActivityRecordAnalysis
      .mockRejectedValueOnce(new Error('DB timeout'))
      .mockResolvedValueOnce({});

    const result = await analyzeBatch(twoRecords, issues, 'user-1', 'org-1');
    expect(result.analyses).toHaveLength(2);
    expect(activityDbService.updateActivityRecordAnalysis).toHaveBeenCalledTimes(2);
  });

  it('skips DB update when recordIndex is out of bounds', async () => {
    const outOfBounds = [
      { recordIndex: 99, taskKey: 'ATG-123', projectKey: 'ATG', confidenceScore: 0.9, workType: 'office', reasoning: 'x' },
    ];
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify(outOfBounds))
    );
    await analyzeBatch(records, issues, 'user-1', 'org-1');
    expect(activityDbService.updateActivityRecordAnalysis).not.toHaveBeenCalled();
  });

  it('rethrows errors from the AI provider', async () => {
    chatCompletionWithFallback.mockRejectedValue(new Error('Provider unavailable'));
    await expect(analyzeBatch(records, issues, 'user-1', 'org-1'))
      .rejects.toThrow('Provider unavailable');
  });

  it('defaults workType to office when not provided by AI', async () => {
    const noWorkType = [{ ...validAnalysis[0], workType: undefined }];
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify(noWorkType))
    );
    await analyzeBatch(records, issues, 'user-1', 'org-1');
    expect(activityDbService.updateActivityRecordAnalysis).toHaveBeenCalledWith(
      'rec-1',
      expect.objectContaining({
        metadata: expect.objectContaining({ workType: 'office' }),
      })
    );
  });
});

// ============================================================================
// classifyUnknownApp
// ============================================================================
describe('classifyUnknownApp', () => {
  const mockClassification = {
    classification: 'productive',
    confidence: 0.9,
    reasoning: 'Work IDE',
    suggestedDisplayName: 'VS Code',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify(mockClassification))
    );
  });

  it('throws when AI is not enabled', async () => {
    isActivityAIEnabled.mockReturnValue(false);
    await expect(classifyUnknownApp('code.exe', 'VS Code', ''))
      .rejects.toThrow('AI client not initialized');
  });

  it('returns classification result on successful direct parse', async () => {
    const result = await classifyUnknownApp('code.exe', 'VS Code', 'function foo() {}');
    expect(result.classification).toBe('productive');
    expect(result.confidence).toBe(0.9);
    expect(result.suggestedDisplayName).toBe('VS Code');
    expect(result.aiProvider).toBe('portkey');
  });

  it('parses JSON via regex when direct parse fails', async () => {
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse('Here is my answer: ' + JSON.stringify(mockClassification))
    );
    const result = await classifyUnknownApp('code.exe', 'VS Code', '');
    expect(result.classification).toBe('productive');
  });

  it('defaults invalid classification value to productive', async () => {
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify({ ...mockClassification, classification: 'invalid_value' }))
    );
    const result = await classifyUnknownApp('app.exe', 'App', '');
    expect(result.classification).toBe('productive');
  });

  it('returns fallback when response contains no JSON object at all', async () => {
    // Direct JSON.parse fails, regex finds no {}, else branch throws →
    // outer catch returns productive fallback with confidence 0.
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse('I cannot classify this application.')
    );
    const result = await classifyUnknownApp('app.exe', 'App', '');
    expect(result.classification).toBe('productive');
    expect(result.confidence).toBe(0);
    expect(result.error).toContain('Failed to parse AI classification response');
  });

  it('returns fallback result with zero confidence on AI failure', async () => {
    chatCompletionWithFallback.mockRejectedValue(new Error('API error'));
    const result = await classifyUnknownApp('app.exe', 'App', '');
    expect(result.classification).toBe('productive');
    expect(result.confidence).toBe(0);
    expect(result.error).toBe('API error');
  });

  it('uses fallback confidence of 0.5 when AI omits the confidence field', async () => {
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify({ classification: 'productive', reasoning: 'work tool' }))
    );
    const result = await classifyUnknownApp('app.exe', 'App', '');
    expect(result.confidence).toBe(0.5);
  });

  it('accepts all three valid classification values', async () => {
    for (const cls of ['productive', 'non_productive', 'private']) {
      chatCompletionWithFallback.mockResolvedValue(
        makeLLMResponse(JSON.stringify({ ...mockClassification, classification: cls }))
      );
      const result = await classifyUnknownApp('app.exe', 'App', '');
      expect(result.classification).toBe(cls);
    }
  });
});

// ============================================================================
// identifyAppByName
// ============================================================================
describe('identifyAppByName', () => {
  const identifiedPayload = {
    identified: true,
    identifier: 'code.exe',
    display_name: 'Visual Studio Code',
    confidence: 0.95,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    isActivityAIEnabled.mockReturnValue(true);
    buildAppIdentificationPrompt.mockReturnValue('identify: vscode');
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify(identifiedPayload))
    );
  });

  it('throws when AI is not enabled', async () => {
    isActivityAIEnabled.mockReturnValue(false);
    await expect(identifyAppByName('vscode'))
      .rejects.toThrow('AI client not initialized');
  });

  it('returns identified app with correct fields', async () => {
    const result = await identifyAppByName('vscode');
    expect(result.identified).toBe(true);
    expect(result.identifier).toBe('code.exe');
    expect(result.display_name).toBe('Visual Studio Code');
    expect(result.source).toBe('llm');
    expect(result.aiProvider).toBe('portkey');
  });

  it('returns unidentified result when LLM says app was not found', async () => {
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(JSON.stringify({ identified: false }))
    );
    const result = await identifyAppByName('unknownxyz');
    expect(result.identified).toBe(false);
    expect(result.source).toBe('llm');
  });

  it('parses JSON via regex when direct parse fails', async () => {
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse('Here is the result: ' + JSON.stringify(identifiedPayload))
    );
    const result = await identifyAppByName('vscode');
    expect(result.identified).toBe(true);
  });

  it('returns error result when response contains no JSON object', async () => {
    // Direct parse fails, regex finds no {}, else branch throws →
    // outer catch returns { identified: false, error: ... }.
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse('I cannot identify this application.')
    );
    const result = await identifyAppByName('unknownapp');
    expect(result.identified).toBe(false);
    expect(result.error).toContain('Failed to parse AI response');
  });

  it('returns error result on complete AI failure', async () => {
    chatCompletionWithFallback.mockRejectedValue(new Error('Network error'));
    const result = await identifyAppByName('vscode');
    expect(result.identified).toBe(false);
    expect(result.error).toBe('Network error');
  });

  it('uses fallback confidence of 0.7 when AI omits the confidence field', async () => {
    chatCompletionWithFallback.mockResolvedValue(
      makeLLMResponse(
        JSON.stringify({ identified: true, identifier: 'code.exe', display_name: 'VS Code' })
      )
    );
    const result = await identifyAppByName('vscode');
    expect(result.confidence).toBe(0.7);
  });
});

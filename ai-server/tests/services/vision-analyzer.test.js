'use strict';

// ---------------------------------------------------------------------------
// Mock heavy dependencies before requiring the module
// ---------------------------------------------------------------------------

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockChatCompletion = jest.fn();
const mockIsAIEnabled = jest.fn().mockReturnValue(true);

jest.mock('../../src/services/ai/ai-client', () => ({
  chatCompletionWithFallback: mockChatCompletion,
  isAIEnabled: mockIsAIEnabled,
}));

jest.mock('../../src/services/ai/prompts', () => ({
  VISION_SYSTEM_PROMPT: 'You are a vision analyzer.',
  buildVisionUserPrompt: jest.fn().mockReturnValue('Analyze this screenshot.'),
  formatAssignedIssues: jest.fn().mockReturnValue('PROJ-1: Fix bug'),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { parseAIResponse, validateAndFormatResult, analyzeWithVision } = require('../../src/services/ai/vision-analyzer');
const logger = require('../../src/utils/logger');

// ---------------------------------------------------------------------------
// parseAIResponse — exercises tryFixJsonString and replaceAll changes
// ---------------------------------------------------------------------------

describe('parseAIResponse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── valid plain JSON ──────────────────────────────────────────────────────

  it('parses a clean JSON object', () => {
    const result = parseAIResponse('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('parses a JSON object with nested fields', () => {
    const result = parseAIResponse('{"a": 1, "b": {"c": true}}');
    expect(result).toEqual({ a: 1, b: { c: true } });
  });

  it('parses a JSON array', () => {
    const result = parseAIResponse('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  // ── markdown code block stripping (replaceAll fix) ────────────────────────

  it('strips ```json\\n prefix and trailing ``` (replaceAll)', () => {
    const content = '```json\n{"status":"ok"}\n```';
    expect(parseAIResponse(content)).toEqual({ status: 'ok' });
  });

  it('strips ``` prefix without json tag and trailing ```', () => {
    const content = '```\n{"x":1}\n```';
    expect(parseAIResponse(content)).toEqual({ x: 1 });
  });

  it('strips multiple markdown blocks in the same response', () => {
    // replaceAll ensures ALL occurrences are removed, not just the first
    const content = '```json\n```json\n{"n":42}\n```\n```';
    expect(parseAIResponse(content)).toEqual({ n: 42 });
  });

  it('handles ``` without trailing newline after "json"', () => {
    const content = '```json{"val":99}```';
    expect(parseAIResponse(content)).toEqual({ val: 99 });
  });

  // ── tryFixJsonString — trailing commas ────────────────────────────────────

  it('fixes trailing comma before closing brace', () => {
    const content = '{"a":1,"b":2,}';
    expect(parseAIResponse(content)).toEqual({ a: 1, b: 2 });
  });

  it('fixes trailing comma before closing bracket', () => {
    const content = '[1,2,3,]';
    expect(parseAIResponse(content)).toEqual([1, 2, 3]);
  });

  it('fixes trailing commas in nested objects', () => {
    const content = '{"outer":{"inner":1,},}';
    expect(parseAIResponse(content)).toEqual({ outer: { inner: 1 } });
  });

  // ── tryFixJsonString — CRLF normalisation ────────────────────────────────

  it('normalises \\r\\n line endings to \\n', () => {
    const content = '{"line1":"a",\r\n"line2":"b"}';
    expect(parseAIResponse(content)).toEqual({ line1: 'a', line2: 'b' });
  });

  // ── tryFixJsonString — truncated object completion ────────────────────────

  it('completes a truncated JSON object missing one closing brace', () => {
    const content = '{"a":1';
    expect(parseAIResponse(content)).toEqual({ a: 1 });
  });

  it('completes a truncated JSON with multiple missing closing braces', () => {
    const content = '{"a":{"b":{"c":1';
    expect(parseAIResponse(content)).toEqual({ a: { b: { c: 1 } } });
  });

  // ── JSON embedded in prose ────────────────────────────────────────────────

  it('extracts JSON embedded in surrounding prose text', () => {
    const content = 'Here is the result:\n{"answer": 42}\nDone.';
    expect(parseAIResponse(content)).toEqual({ answer: 42 });
  });

  // ── sample logging on failure ─────────────────────────────────────────────

  it('throws when content cannot be parsed as JSON', () => {
    expect(() => parseAIResponse('not json at all')).toThrow('Invalid JSON response from AI');
  });

  it('logs a warning with a sample when parsing fails', () => {
    try { parseAIResponse('not json'); } catch (_) {}
    expect(logger.warn).toHaveBeenCalledWith(
      '[AI] Failed to parse response as JSON. Sample: %s',
      expect.any(String),
    );
  });

  it('truncates the log sample to 400 chars when content is long', () => {
    const longContent = 'x'.repeat(500);
    try { parseAIResponse(longContent); } catch (_) {}
    const loggedSample = logger.warn.mock.calls[0][1];
    expect(loggedSample.length).toBeLessThanOrEqual(404); // 400 + '...'
    expect(loggedSample.endsWith('...')).toBe(true);
  });

  it('does not truncate the log sample when content is ≤ 400 chars', () => {
    const shortContent = 'x'.repeat(100);
    try { parseAIResponse(shortContent); } catch (_) {}
    const loggedSample = logger.warn.mock.calls[0][1];
    expect(loggedSample.endsWith('...')).toBe(false);
  });

  it('replaces newlines in log sample with spaces (replaceAll fix)', () => {
    // All newlines in the sample should become spaces
    const content = 'line1\nline2\nline3\nno json here';
    try { parseAIResponse(content); } catch (_) {}
    const loggedSample = logger.warn.mock.calls[0][1];
    expect(loggedSample).not.toContain('\n');
    expect(loggedSample).toContain('line1 line2 line3');
  });

  // ── invalid input ─────────────────────────────────────────────────────────

  it('throws for null input', () => {
    expect(() => parseAIResponse(null)).toThrow('Invalid JSON response from AI');
  });

  it('throws for empty string input', () => {
    expect(() => parseAIResponse('')).toThrow('Invalid JSON response from AI');
  });

  it('throws for non-string input (number)', () => {
    expect(() => parseAIResponse(42)).toThrow('Invalid JSON response from AI');
  });

  it('logs a warning for empty/non-string input', () => {
    try { parseAIResponse(null); } catch (_) {}
    expect(logger.warn).toHaveBeenCalledWith('[AI] Empty or non-string response');
  });
});

// ---------------------------------------------------------------------------
// validateAndFormatResult — pure validation / formatting function
// ---------------------------------------------------------------------------

describe('validateAndFormatResult', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const BASE_RESULT = {
    workType: 'office',
    taskKey: 'PROJ-1',
    confidenceScore: 0.8,
    contentAnalysis: 'User is working in VS Code',
    reasoning: 'Active development session detected',
    projectKey: 'PROJ',
  };

  // ── workType validation ───────────────────────────────────────────────────

  it('passes through valid workType "office"', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT }, []);
    expect(result.workType).toBe('office');
  });

  it('passes through valid workType "non-office"', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, workType: 'non-office' }, []);
    expect(result.workType).toBe('non-office');
  });

  it('defaults invalid workType to "office" and logs warning', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, workType: 'unknown' }, []);
    expect(result.workType).toBe('office');
    expect(logger.warn).toHaveBeenCalledWith(
      '[AI] Invalid work_type "%s", defaulting to office',
      'unknown',
    );
  });

  it('defaults null workType to "office"', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, workType: null }, []);
    expect(result.workType).toBe('office');
  });

  // ── taskKey validation ────────────────────────────────────────────────────

  it('keeps taskKey when it is in userAssignedIssues', () => {
    const issues = [{ key: 'PROJ-1' }, { key: 'PROJ-2' }];
    const result = validateAndFormatResult({ ...BASE_RESULT, taskKey: 'PROJ-1' }, issues);
    expect(result.taskKey).toBe('PROJ-1');
  });

  it('nullifies taskKey when not in userAssignedIssues and logs warning', () => {
    const issues = [{ key: 'PROJ-2' }, { key: 'PROJ-3' }];
    const result = validateAndFormatResult({ ...BASE_RESULT, taskKey: 'PROJ-1' }, issues);
    expect(result.taskKey).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      '[AI] Task key %s not in assigned issues, setting to null',
      'PROJ-1',
    );
  });

  it('keeps taskKey when userAssignedIssues is empty', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, taskKey: 'PROJ-1' }, []);
    expect(result.taskKey).toBe('PROJ-1');
  });

  it('keeps taskKey when userAssignedIssues is null', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, taskKey: 'PROJ-1' }, null);
    expect(result.taskKey).toBe('PROJ-1');
  });

  it('returns null taskKey when aiResult.taskKey is null', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, taskKey: null }, []);
    expect(result.taskKey).toBeNull();
  });

  // ── projectKey derivation ─────────────────────────────────────────────────

  it('uses aiResult.projectKey when provided', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, projectKey: 'MYPROJ' }, []);
    expect(result.projectKey).toBe('MYPROJ');
  });

  it('derives projectKey from taskKey split on "-"', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, projectKey: null }, []);
    expect(result.projectKey).toBe('PROJ');
  });

  it('projectKey is null when no taskKey and no projectKey', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, taskKey: null, projectKey: null }, []);
    expect(result.projectKey).toBeNull();
  });

  // ── confidenceScore clamping ──────────────────────────────────────────────

  it('passes through a valid confidenceScore of 0.8', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, confidenceScore: 0.8 }, []);
    expect(result.confidenceScore).toBe(0.8);
  });

  it('clamps confidenceScore above 1 down to 1', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, confidenceScore: 1.5 }, []);
    expect(result.confidenceScore).toBe(1);
  });

  it('clamps confidenceScore below 0 up to 0', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, confidenceScore: -0.2 }, []);
    expect(result.confidenceScore).toBe(0);
  });

  it('defaults missing confidenceScore to 0.5', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, confidenceScore: undefined }, []);
    expect(result.confidenceScore).toBe(0.5);
  });

  // ── optional string fields ────────────────────────────────────────────────

  it('uses contentAnalysis from aiResult', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, contentAnalysis: 'screen text' }, []);
    expect(result.contentAnalysis).toBe('screen text');
  });

  it('defaults contentAnalysis to empty string when missing', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, contentAnalysis: undefined }, []);
    expect(result.contentAnalysis).toBe('');
  });

  it('uses reasoning from aiResult', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, reasoning: 'dev work' }, []);
    expect(result.reasoning).toBe('dev work');
  });

  it('defaults reasoning to empty string when missing', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT, reasoning: undefined }, []);
    expect(result.reasoning).toBe('');
  });

  // ── modelVersion ──────────────────────────────────────────────────────────

  it('always returns modelVersion "v3.1-vision-thorough"', () => {
    const result = validateAndFormatResult({ ...BASE_RESULT }, []);
    expect(result.modelVersion).toBe('v3.1-vision-thorough');
  });
});

// ---------------------------------------------------------------------------
// analyzeWithVision — integration of AI call, parse, and validate
// ---------------------------------------------------------------------------

describe('analyzeWithVision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAIEnabled.mockReturnValue(true);
  });

  const VALID_AI_CONTENT = JSON.stringify({
    workType: 'office',
    taskKey: 'PROJ-1',
    confidenceScore: 0.9,
    contentAnalysis: 'VS Code editor open',
    reasoning: 'Active coding session',
    projectKey: 'PROJ',
  });

  const BASE_PARAMS = {
    imageBuffer: Buffer.from('fake-image-data'),
    windowTitle: 'main.js — MyProject',
    applicationName: 'Code',
    userAssignedIssues: [{ key: 'PROJ-1' }],
    userId: 'user-123',
    organizationId: 'org-456',
    screenshotId: 'ss-789',
  };

  // ── AI disabled guard ─────────────────────────────────────────────────────

  it('throws "AI client not initialized" when isAIEnabled returns false', async () => {
    mockIsAIEnabled.mockReturnValue(false);
    await expect(analyzeWithVision(BASE_PARAMS)).rejects.toThrow('AI client not initialized');
  });

  // ── successful analysis ───────────────────────────────────────────────────

  it('returns a validated result on success', async () => {
    mockChatCompletion.mockResolvedValue({
      response: { choices: [{ message: { content: VALID_AI_CONTENT } }] },
      provider: 'fireworks',
      model: 'accounts/fireworks/models/llama-v3p1',
    });

    const result = await analyzeWithVision(BASE_PARAMS);
    expect(result.workType).toBe('office');
    expect(result.taskKey).toBe('PROJ-1');
    expect(result.confidenceScore).toBe(0.9);
    expect(result.modelVersion).toBe('v3.1-vision-thorough');
  });

  it('attaches aiProvider and aiModel to the result', async () => {
    mockChatCompletion.mockResolvedValue({
      response: { choices: [{ message: { content: VALID_AI_CONTENT } }] },
      provider: 'fireworks',
      model: 'llama-v3p1',
    });

    const result = await analyzeWithVision(BASE_PARAMS);
    expect(result.aiProvider).toBe('fireworks');
    expect(result.aiModel).toBe('llama-v3p1');
  });

  it('calls chatCompletionWithFallback with correct params', async () => {
    mockChatCompletion.mockResolvedValue({
      response: { choices: [{ message: { content: VALID_AI_CONTENT } }] },
      provider: 'fireworks',
      model: 'llama-v3p1',
    });

    await analyzeWithVision(BASE_PARAMS);

    expect(mockChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      temperature: 0.3,
      max_tokens: 1200,
      isVision: true,
      userId: 'user-123',
      organizationId: 'org-456',
      screenshotId: 'ss-789',
      apiCallName: 'vision-analysis',
    }));
  });

  it('includes base64-encoded image in the messages', async () => {
    mockChatCompletion.mockResolvedValue({
      response: { choices: [{ message: { content: VALID_AI_CONTENT } }] },
      provider: 'fireworks',
      model: 'llama-v3p1',
    });

    await analyzeWithVision(BASE_PARAMS);

    const { messages } = mockChatCompletion.mock.calls[0][0];
    const userContent = messages[1].content;
    const imageItem = userContent.find(item => item.type === 'image_url');
    expect(imageItem).toBeDefined();
    expect(imageItem.image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it('uses default values for optional params (userId, orgId, screenshotId)', async () => {
    mockChatCompletion.mockResolvedValue({
      response: { choices: [{ message: { content: VALID_AI_CONTENT } }] },
      provider: 'fireworks',
      model: 'llama-v3p1',
    });

    await analyzeWithVision({
      imageBuffer: Buffer.from('x'),
      windowTitle: 'test',
      applicationName: 'code',
    });

    expect(mockChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      userId: null,
      organizationId: null,
      screenshotId: null,
    }));
  });

  // ── error propagation ─────────────────────────────────────────────────────

  it('re-throws error from chatCompletionWithFallback', async () => {
    mockChatCompletion.mockRejectedValue(new Error('API timeout'));
    await expect(analyzeWithVision(BASE_PARAMS)).rejects.toThrow('API timeout');
  });

  it('logs error when chatCompletionWithFallback fails', async () => {
    mockChatCompletion.mockRejectedValue(new Error('Network error'));
    try { await analyzeWithVision(BASE_PARAMS); } catch (_) {}
    expect(logger.error).toHaveBeenCalledWith(
      '[AI] Vision analysis failed: %s',
      'Network error',
    );
  });

  it('logs info with provider and model on success', async () => {
    mockChatCompletion.mockResolvedValue({
      response: { choices: [{ message: { content: VALID_AI_CONTENT } }] },
      provider: 'litellm',
      model: 'gpt-4o',
    });

    await analyzeWithVision(BASE_PARAMS);
    expect(logger.info).toHaveBeenCalledWith(
      '[AI] Vision analysis done | %s (%s)',
      'litellm',
      'gpt-4o',
    );
  });
});

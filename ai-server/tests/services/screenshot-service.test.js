'use strict';

/**
 * Tests for screenshot-service.js
 * Covers analyzeActivity (all branches) and createWorklog.
 */

const mockIsAIEnabled = jest.fn();
const mockAnalyzeWithVision = jest.fn();
const mockAnalyzeWithOCRPipeline = jest.fn();

jest.mock('../../src/services/ai', () => ({
  isAIEnabled: mockIsAIEnabled,
  analyzeWithVision: mockAnalyzeWithVision,
  analyzeWithOCRPipeline: mockAnalyzeWithOCRPipeline,
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const screenshotService = require('../../src/services/screenshot-service');
const logger = require('../../src/utils/logger');

const BASE_PARAMS = {
  imageBuffer: Buffer.from('fake-image'),
  windowTitle: 'VSCode - index.js',
  applicationName: 'Code',
  timestamp: '2024-01-01T10:00:00Z',
  userId: 'user-1',
  userAssignedIssues: [],
};

const VISION_RESULT = {
  taskKey: 'ATG-42',
  projectKey: 'ATG',
  workType: 'office',
  confidenceScore: 0.95,
  reasoning: 'Working on ATG-42',
  extractedText: 'some code',
  aiProvider: 'Fireworks',
  aiModel: 'llama-v3',
  modelVersion: 'v3.1-vision-thorough',
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.USE_OCR_FALLBACK;
  delete process.env.SCREENSHOT_INTERVAL;
});

// ── analyzeActivity ──────────────────────────────────────────────────────────

describe('analyzeActivity', () => {
  describe('vision success path', () => {
    it('returns analysis from vision when AI is enabled and vision succeeds', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockResolvedValue(VISION_RESULT);

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(mockAnalyzeWithVision).toHaveBeenCalledWith(expect.objectContaining({
        imageBuffer: BASE_PARAMS.imageBuffer,
        windowTitle: BASE_PARAMS.windowTitle,
        applicationName: BASE_PARAMS.applicationName,
        userId: BASE_PARAMS.userId,
        userAssignedIssues: BASE_PARAMS.userAssignedIssues,
      }));
      expect(result.taskKey).toBe('ATG-42');
      expect(result.projectKey).toBe('ATG');
      expect(result.workType).toBe('office');
      expect(result.confidenceScore).toBe(0.95);
      expect(result.modelVersion).toBe('v3.1-vision-thorough');
      expect(result.metadata.aiEnhanced).toBe(true);
      expect(result.metadata.usedVision).toBe(true);
      expect(result.metadata.reasoning).toBe('Working on ATG-42');
      expect(result.metadata.extractedText).toBe('some code');
    });

    it('passes organizationId and screenshotId through to vision', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockResolvedValue(VISION_RESULT);

      await screenshotService.analyzeActivity({
        ...BASE_PARAMS,
        organizationId: 'org-1',
        screenshotId: 'ss-1',
      });

      expect(mockAnalyzeWithVision).toHaveBeenCalledWith(expect.objectContaining({
        organizationId: 'org-1',
        screenshotId: 'ss-1',
      }));
    });

    it('uses SCREENSHOT_INTERVAL env var for timeSpentSeconds', async () => {
      process.env.SCREENSHOT_INTERVAL = '600';
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockResolvedValue(VISION_RESULT);

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);
      expect(result.timeSpentSeconds).toBe(600);
    });

    it('defaults timeSpentSeconds to 300 when SCREENSHOT_INTERVAL not set', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockResolvedValue(VISION_RESULT);

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);
      expect(result.timeSpentSeconds).toBe(300);
    });

    it('derives projectKey from taskKey when projectKey is absent in vision result', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockResolvedValue({
        ...VISION_RESULT,
        projectKey: null,
        taskKey: 'PROJ-7',
      });

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);
      expect(result.projectKey).toBe('PROJ');
    });

    it('logs vision provider/model/task info', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockResolvedValue(VISION_RESULT);

      await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Vision analysis completed'),
        expect.objectContaining({
          provider: 'Fireworks',
          model: 'llama-v3',
          taskKey: 'ATG-42',
        })
      );
    });

    it('logs with default provider/model when not provided in vision result', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockResolvedValue({
        ...VISION_RESULT,
        aiProvider: undefined,
        aiModel: undefined,
      });

      await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Vision analysis completed'),
        expect.objectContaining({ provider: 'AI', model: 'unknown' })
      );
    });
  });

  describe('vision fail → OCR fallback path', () => {
    it('falls back to OCR when vision throws', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockRejectedValue(new Error('vision API error'));
      mockAnalyzeWithOCRPipeline.mockResolvedValue({
        ...VISION_RESULT,
        taskKey: 'ATG-10',
        aiProvider: 'LiteLLM',
        aiModel: 'gemini',
      });

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(mockAnalyzeWithOCRPipeline).toHaveBeenCalled();
      expect(result.taskKey).toBe('ATG-10');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('AI Vision analysis failed'),
        expect.objectContaining({ error: 'vision API error' })
      );
    });

    it('logs OCR provider/model info on OCR success', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockRejectedValue(new Error('fail'));
      mockAnalyzeWithOCRPipeline.mockResolvedValue({
        ...VISION_RESULT,
        aiProvider: 'LiteLLM',
        aiModel: 'gpt-4o',
      });

      await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('OCR + LiteLLM analysis completed'),
        expect.objectContaining({ provider: 'LiteLLM', model: 'gpt-4o' })
      );
    });

    it('falls back to OCR when AI is disabled and imageBuffer present', async () => {
      mockIsAIEnabled.mockReturnValue(false);
      mockAnalyzeWithOCRPipeline.mockResolvedValue(VISION_RESULT);

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(mockAnalyzeWithVision).not.toHaveBeenCalled();
      expect(mockAnalyzeWithOCRPipeline).toHaveBeenCalled();
      expect(result.taskKey).toBe('ATG-42');
    });
  });

  describe('both vision and OCR fail → basic heuristics path', () => {
    it('uses basic heuristics when both vision and OCR fail', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockRejectedValue(new Error('vision fail'));
      mockAnalyzeWithOCRPipeline.mockRejectedValue(new Error('ocr fail'));

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(result.taskKey).toBeNull();
      expect(result.projectKey).toBeNull();
      expect(result.workType).toBe('office');
      expect(result.confidenceScore).toBe(0.3);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Both Vision and OCR+AI analysis failed'),
        expect.objectContaining({ error: 'ocr fail' })
      );
    });

    it('uses "v3.1-vision-thorough" modelVersion in heuristics fallback', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockRejectedValue(new Error('fail'));
      mockAnalyzeWithOCRPipeline.mockRejectedValue(new Error('fail'));

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);
      expect(result.modelVersion).toBe('v3.1-vision-thorough');
    });
  });

  describe('OCR fallback disabled (USE_OCR_FALLBACK=false)', () => {
    it('uses basic heuristics without calling OCR when USE_OCR_FALLBACK=false and AI disabled', async () => {
      process.env.USE_OCR_FALLBACK = 'false';
      mockIsAIEnabled.mockReturnValue(false);

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(mockAnalyzeWithOCRPipeline).not.toHaveBeenCalled();
      expect(result.taskKey).toBeNull();
      expect(result.workType).toBe('office');
      expect(result.confidenceScore).toBe(0.3);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('OCR fallback disabled')
      );
    });

    it('uses basic heuristics when vision fails and USE_OCR_FALLBACK=false', async () => {
      process.env.USE_OCR_FALLBACK = 'false';
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockRejectedValue(new Error('vision fail'));

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(mockAnalyzeWithOCRPipeline).not.toHaveBeenCalled();
      expect(result.taskKey).toBeNull();
      expect(result.workType).toBe('office');
    });
  });

  describe('no imageBuffer', () => {
    it('skips vision when imageBuffer is null', async () => {
      mockIsAIEnabled.mockReturnValue(true);

      const result = await screenshotService.analyzeActivity({
        ...BASE_PARAMS,
        imageBuffer: null,
      });

      expect(mockAnalyzeWithVision).not.toHaveBeenCalled();
      expect(mockAnalyzeWithOCRPipeline).not.toHaveBeenCalled();
      expect(result.taskKey).toBeNull();
      expect(result.workType).toBe('office');
    });
  });

  describe('metadata fields', () => {
    it('includes assignedIssuesCount and usedAssignedIssues in metadata', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockResolvedValue(VISION_RESULT);
      const issues = [{ key: 'ATG-1' }, { key: 'ATG-2' }];

      const result = await screenshotService.analyzeActivity({
        ...BASE_PARAMS,
        userAssignedIssues: issues,
      });

      expect(result.metadata.assignedIssuesCount).toBe(2);
      expect(result.metadata.usedAssignedIssues).toBe(true);
    });

    it('sets usedAssignedIssues=false when no issues passed', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockResolvedValue(VISION_RESULT);

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(result.metadata.assignedIssuesCount).toBe(0);
      expect(result.metadata.usedAssignedIssues).toBe(false);
    });

    it('includes application and windowTitle in metadata', async () => {
      mockIsAIEnabled.mockReturnValue(true);
      mockAnalyzeWithVision.mockResolvedValue(VISION_RESULT);

      const result = await screenshotService.analyzeActivity(BASE_PARAMS);

      expect(result.metadata.application).toBe('Code');
      expect(result.metadata.windowTitle).toBe('VSCode - index.js');
    });
  });

  describe('error propagation', () => {
    it('throws when analyzeActivity itself throws an unexpected error', async () => {
      mockIsAIEnabled.mockImplementation(() => { throw new Error('unexpected'); });

      await expect(screenshotService.analyzeActivity(BASE_PARAMS))
        .rejects.toThrow('Failed to analyze activity: unexpected');
    });
  });
});

// ── createWorklog ────────────────────────────────────────────────────────────

describe('createWorklog', () => {
  it('returns placeholder worklog object', async () => {
    const result = await screenshotService.createWorklog({
      userId: 'user-1',
      issueKey: 'ATG-42',
      timeSpentSeconds: 300,
      startedAt: '2024-01-01T10:00:00Z',
    });

    expect(result).toEqual({ worklogId: 'placeholder', created: true });
  });

  it('logs the worklog creation request', async () => {
    await screenshotService.createWorklog({
      userId: 'user-1',
      issueKey: 'ATG-42',
      timeSpentSeconds: 300,
      startedAt: '2024-01-01T10:00:00Z',
    });

    expect(logger.info).toHaveBeenCalledWith(
      'Worklog creation requested',
      expect.objectContaining({
        userId: 'user-1',
        issueKey: 'ATG-42',
        timeSpentSeconds: 300,
      })
    );
  });
});

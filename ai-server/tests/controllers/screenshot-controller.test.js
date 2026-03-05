/**
 * Screenshot Controller Unit Tests
 */

const screenshotService = require('../../src/services/screenshot-service');
const supabaseService = require('../../src/services/supabase-service');
const logger = require('../../src/utils/logger');
const { getUTCISOString, toUTCISOString } = require('../../src/utils/datetime');

// Mock all dependencies
jest.mock('../../src/services/screenshot-service');
jest.mock('../../src/services/supabase-service');
jest.mock('../../src/utils/logger');
jest.mock('../../src/utils/datetime');

// Import controller after mocks
const screenshotController = require('../../src/controllers/screenshot-controller');

describe('Screenshot Controller', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();

    req = {
      body: {},
      params: {}
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };

    getUTCISOString.mockReturnValue('2024-01-01T12:00:00.000Z');
    toUTCISOString.mockImplementation((date) => date.toISOString());
  });

  describe('analyzeScreenshot', () => {
    const validWebhookData = {
      id: '12345678-1234-1234-1234-123456789012',
      user_id: '87654321-4321-4321-4321-210987654321',
      organization_id: 'abcdefab-abcd-abcd-abcd-abcdefabcdef',
      storage_path: 'user123/screenshot_123.png',
      storage_url: 'https://example.com/screenshot.png',
      window_title: 'VS Code - test.js',
      application_name: 'Visual Studio Code',
      timestamp: '2024-01-01T12:00:00.000Z',
      duration_seconds: 600,
      start_time: '2024-01-01T11:50:00.000Z',
      end_time: '2024-01-01T12:00:00.000Z',
      user_assigned_issues: []
    };

    it('should analyze screenshot successfully', async () => {
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image data'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-123',
        workType: 'office',
        timeSpentSeconds: 600,
        category: 'Development',
        description: 'Working on test.js'
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.claimScreenshotForProcessing).toHaveBeenCalledWith(validWebhookData.id);
      expect(supabaseService.downloadFile).toHaveBeenCalledWith('screenshots', validWebhookData.storage_path);
      expect(screenshotService.analyzeActivity).toHaveBeenCalled();
      expect(supabaseService.updateScreenshotAnalysis).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        screenshot_id: validWebhookData.id
      });
    });

    it('should handle webhook data with record wrapper', async () => {
      req.body = {
        record: { ...validWebhookData }
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image data'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-123',
        workType: 'office'
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.claimScreenshotForProcessing).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true
      }));
    });

    it('should return 400 if screenshot_id is missing', async () => {
      req.body = {
        user_id: validWebhookData.user_id,
        storage_url: validWebhookData.storage_url
      };

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Missing required fields')
      });
    });

    it('should return 400 if user_id is missing', async () => {
      req.body = {
        id: validWebhookData.id,
        storage_url: validWebhookData.storage_url
      };

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Missing required fields')
      });
    });

    it('should return 400 if storage_url is missing', async () => {
      req.body = {
        id: validWebhookData.id,
        user_id: validWebhookData.user_id
      };

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Missing required fields')
      });
    });

    it('should return 400 for invalid screenshot_id UUID format', async () => {
      req.body = {
        ...validWebhookData,
        id: 'invalid-uuid'
      };

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Invalid screenshot_id format')
      });
    });

    it('should return 400 for invalid user_id UUID format', async () => {
      req.body = {
        ...validWebhookData,
        user_id: 'not-a-uuid'
      };

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Invalid user_id format')
      });
    });

    it('should return 400 for invalid organization_id UUID format', async () => {
      req.body = {
        ...validWebhookData,
        organization_id: 'bad-org-id'
      };

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('Invalid organization_id format')
      });
    });

    it('should skip if screenshot already claimed', async () => {
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(false);

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.downloadFile).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Already processing or processed'
      });
    });

    it('should parse user_assigned_issues from JSON string', async () => {
      req.body = {
        ...validWebhookData,
        user_assigned_issues: JSON.stringify([
          { key: 'PROJ-1', summary: 'Task 1' },
          { key: 'PROJ-2', summary: 'Task 2' }
        ])
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(screenshotService.analyzeActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userAssignedIssues: [
            { key: 'PROJ-1', summary: 'Task 1' },
            { key: 'PROJ-2', summary: 'Task 2' }
          ]
        })
      );
    });

    it('should handle invalid user_assigned_issues JSON string', async () => {
      req.body = {
        ...validWebhookData,
        user_assigned_issues: 'invalid json['
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(logger.warn).toHaveBeenCalled();
      expect(screenshotService.analyzeActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userAssignedIssues: []
        })
      );
    });

    it('should resolve organization_id from screenshot record if not in webhook', async () => {
      req.body = {
        ...validWebhookData,
        organization_id: undefined
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.getScreenshotById.mockResolvedValue({
        organization_id: 'fetched-org-id'
      });
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.getScreenshotById).toHaveBeenCalledWith(validWebhookData.id);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Fetched organization_id'),
        expect.any(Object)
      );
    });

    it('should update duration if not provided in webhook', async () => {
      req.body = {
        ...validWebhookData,
        duration_seconds: null,
        start_time: null,
        end_time: null
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-1',
        timeSpentSeconds: 600
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      supabaseService.updateScreenshotDuration.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.updateScreenshotDuration).toHaveBeenCalledWith(
        validWebhookData.id,
        expect.objectContaining({
          duration_seconds: 600
        })
      );
    });

    it('should not update duration if already provided', async () => {
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.updateScreenshotDuration).not.toHaveBeenCalled();
    });

    it('should delete screenshot files after analysis if enabled', async () => {
      process.env.DELETE_SCREENSHOTS_AFTER_ANALYSIS = 'true';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      supabaseService.deleteFile.mockResolvedValue();
      supabaseService.clearStorageUrls.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.deleteFile).toHaveBeenCalledWith('screenshots', validWebhookData.storage_path);
      expect(supabaseService.clearStorageUrls).toHaveBeenCalledWith(validWebhookData.id);
    });

    it('should skip deletion if DELETE_SCREENSHOTS_AFTER_ANALYSIS is false', async () => {
      process.env.DELETE_SCREENSHOTS_AFTER_ANALYSIS = 'false';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.deleteFile).not.toHaveBeenCalled();
      expect(supabaseService.clearStorageUrls).not.toHaveBeenCalled();
    });

    it('should handle deletion errors gracefully', async () => {
      process.env.DELETE_SCREENSHOTS_AFTER_ANALYSIS = 'true';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      supabaseService.deleteFile.mockRejectedValue(new Error('Delete failed'));

      await screenshotController.analyzeScreenshot(req, res);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete screenshot'),
        expect.any(Object)
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        screenshot_id: validWebhookData.id
      });
    });

    it('should create worklog if configured and conditions met', async () => {
      process.env.AUTO_CREATE_WORKLOGS = 'true';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-123',
        workType: 'office',
        timeSpentSeconds: 600
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      screenshotService.createWorklog.mockResolvedValue();
      supabaseService.markWorklogCreated.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(screenshotService.createWorklog).toHaveBeenCalledWith({
        userId: validWebhookData.user_id,
        issueKey: 'PROJ-123',
        timeSpentSeconds: 600,
        startedAt: validWebhookData.timestamp
      });
      expect(supabaseService.markWorklogCreated).toHaveBeenCalledWith(
        validWebhookData.id,
        'PROJ-123'
      );
    });

    it('should not create worklog if AUTO_CREATE_WORKLOGS is false', async () => {
      process.env.AUTO_CREATE_WORKLOGS = 'false';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-123',
        workType: 'office'
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(screenshotService.createWorklog).not.toHaveBeenCalled();
    });

    it('should not create worklog if no taskKey', async () => {
      process.env.AUTO_CREATE_WORKLOGS = 'true';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: null,
        workType: 'office'
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(screenshotService.createWorklog).not.toHaveBeenCalled();
    });

    it('should not create worklog if workType is not office', async () => {
      process.env.AUTO_CREATE_WORKLOGS = 'true';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-123',
        workType: 'personal'
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(screenshotService.createWorklog).not.toHaveBeenCalled();
    });

    it('should handle worklog creation errors gracefully', async () => {
      process.env.AUTO_CREATE_WORKLOGS = 'true';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-123',
        workType: 'office',
        timeSpentSeconds: 600
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      screenshotService.createWorklog.mockRejectedValue(new Error('Worklog failed'));

      await screenshotController.analyzeScreenshot(req, res);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to create worklog'),
        expect.any(Object)
      );
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        screenshot_id: validWebhookData.id
      });
    });

    it('should handle analysis errors and update screenshot status', async () => {
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockRejectedValue(new Error('Download failed'));
      supabaseService.updateScreenshotStatus.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Screenshot analysis error'),
        expect.any(Object)
      );
      expect(supabaseService.updateScreenshotStatus).toHaveBeenCalledWith(
        validWebhookData.id,
        'failed',
        'Download failed'
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to analyze screenshot',
        details: process.env.NODE_ENV === 'development' ? 'Download failed' : undefined
      });
    });

    it('should handle status update errors during error handling', async () => {
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockRejectedValue(new Error('Analysis failed'));
      supabaseService.updateScreenshotStatus.mockRejectedValue(new Error('Status update failed'));

      await screenshotController.analyzeScreenshot(req, res);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update screenshot status'),
        expect.any(Error)
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to analyze screenshot',
        details: process.env.NODE_ENV === 'development' ? 'Analysis failed' : undefined
      });
    });

    it('should handle errors when screenshot_id is missing during error handling', async () => {
      // Create request body that passes validation but fails later
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      // Simulate an error after claiming
      supabaseService.downloadFile.mockRejectedValue(new Error('Storage error'));
      supabaseService.updateScreenshotStatus.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: 'Failed to analyze screenshot'
      }));
    });

    it('should handle error during screenshot analysis service call', async () => {
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image data'));
      screenshotService.analyzeActivity.mockRejectedValue(new Error('AI service unavailable'));
      supabaseService.updateScreenshotStatus.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.updateScreenshotStatus).toHaveBeenCalledWith(
        validWebhookData.id,
        'failed',
        'AI service unavailable'
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: 'Failed to analyze screenshot'
      }));
    });

    it('should handle error during saveAnalysisResult', async () => {
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image data'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-123',
        workType: 'office',
        timeSpentSeconds: 600
      });
      supabaseService.saveAnalysisResult.mockRejectedValue(new Error('Database write failed'));
      supabaseService.updateScreenshotStatus.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: 'Failed to analyze screenshot'
      }));
    });

    it('should handle null/undefined user_assigned_issues', async () => {
      req.body = {
        ...validWebhookData,
        user_assigned_issues: null
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(screenshotService.analyzeActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userAssignedIssues: []
        })
      );
    });

    it('should accept screenshot_id field instead of id', async () => {
      req.body = {
        screenshot_id: validWebhookData.id,
        user_id: validWebhookData.user_id,
        storage_url: validWebhookData.storage_url,
        storage_path: validWebhookData.storage_path
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.claimScreenshotForProcessing).toHaveBeenCalledWith(validWebhookData.id);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        screenshot_id: validWebhookData.id
      });
    });

    it('should handle missing storage_path gracefully', async () => {
      req.body = {
        ...validWebhookData,
        storage_path: null
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);

      await screenshotController.analyzeScreenshot(req, res);

      expect(logger.error).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Failed to analyze screenshot'
      });
    });

    it('should handle empty user_assigned_issues array', async () => {
      req.body = {
        ...validWebhookData,
        user_assigned_issues: []
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(screenshotService.analyzeActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userAssignedIssues: []
        })
      );
    });

    it('should handle very large duration_seconds', async () => {
      req.body = {
        ...validWebhookData,
        duration_seconds: 999999
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        screenshot_id: validWebhookData.id
      });
    });

    it('should handle negative duration_seconds', async () => {
      req.body = {
        ...validWebhookData,
        duration_seconds: -100,
        start_time: null,
        end_time: null
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-1',
        timeSpentSeconds: 600
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      supabaseService.updateScreenshotDuration.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.updateScreenshotDuration).toHaveBeenCalled();
    });

    it('should handle UUID in different case', async () => {
      req.body = {
        ...validWebhookData,
        id: validWebhookData.id.toUpperCase()
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        screenshot_id: validWebhookData.id.toUpperCase()
      });
    });

    it('should handle screenshot with only start_time missing', async () => {
      req.body = {
        ...validWebhookData,
        start_time: null,
        end_time: '2024-01-01T12:00:00.000Z',
        duration_seconds: 600
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-1',
        timeSpentSeconds: 600
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      supabaseService.updateScreenshotDuration.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.updateScreenshotDuration).toHaveBeenCalled();
    });

    it('should handle screenshot with only end_time missing', async () => {
      req.body = {
        ...validWebhookData,
        start_time: '2024-01-01T11:50:00.000Z',
        end_time: null,
        duration_seconds: 600
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-1',
        timeSpentSeconds: 600
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      supabaseService.updateScreenshotDuration.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.updateScreenshotDuration).toHaveBeenCalled();
    });

    it('should delete thumbnail even if main screenshot delete fails', async () => {
      process.env.DELETE_SCREENSHOTS_AFTER_ANALYSIS = 'true';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      supabaseService.deleteFile
        .mockRejectedValueOnce(new Error('Main delete failed'))
        .mockResolvedValueOnce(); // Thumbnail succeeds
      supabaseService.clearStorageUrls.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(supabaseService.deleteFile).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should handle clearStorageUrls failure gracefully', async () => {
      process.env.DELETE_SCREENSHOTS_AFTER_ANALYSIS = 'true';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      supabaseService.deleteFile.mockResolvedValue();
      supabaseService.clearStorageUrls.mockRejectedValue(new Error('Clear failed'));

      await screenshotController.analyzeScreenshot(req, res);

      expect(logger.warn).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        screenshot_id: validWebhookData.id
      });
    });

    it('should handle missing window_title', async () => {
      req.body = {
        ...validWebhookData,
        window_title: null
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(screenshotService.analyzeActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          windowTitle: null
        })
      );
    });

    it('should handle missing application_name', async () => {
      req.body = {
        ...validWebhookData,
        application_name: null
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(screenshotService.analyzeActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          applicationName: null
        })
      );
    });

    it('should handle organization_id fetch returning null', async () => {
      req.body = {
        ...validWebhookData,
        organization_id: undefined
      };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.getScreenshotById.mockResolvedValue(null);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({ taskKey: 'PROJ-1' });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();

      await screenshotController.analyzeScreenshot(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        screenshot_id: validWebhookData.id
      });
    });

    it('should handle markWorklogCreated failure gracefully', async () => {
      process.env.AUTO_CREATE_WORKLOGS = 'true';
      
      req.body = { ...validWebhookData };

      supabaseService.claimScreenshotForProcessing.mockResolvedValue(true);
      supabaseService.downloadFile.mockResolvedValue(Buffer.from('image'));
      screenshotService.analyzeActivity.mockResolvedValue({
        taskKey: 'PROJ-123',
        workType: 'office',
        timeSpentSeconds: 600
      });
      supabaseService.updateScreenshotAnalysis.mockResolvedValue();
      screenshotService.createWorklog.mockResolvedValue();
      supabaseService.markWorklogCreated.mockRejectedValue(new Error('Mark failed'));

      await screenshotController.analyzeScreenshot(req, res);

      expect(logger.error).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        screenshot_id: validWebhookData.id
      });
    });
  });
});

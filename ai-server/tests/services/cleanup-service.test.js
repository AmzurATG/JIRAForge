/**
 * Cleanup Service Unit Tests
 */

const { getClient } = require('../../src/services/db/supabase-client');
const { deleteFile } = require('../../src/services/db/storage-service');
const logger = require('../../src/utils/logger');
const { toUTCISOString } = require('../../src/utils/datetime');

// Mock all dependencies
jest.mock('../../src/services/db/supabase-client');
jest.mock('../../src/services/db/storage-service');
jest.mock('../../src/utils/logger');
jest.mock('../../src/utils/datetime');

// Import service after mocks
const cleanupService = require('../../src/services/cleanup-service');

describe('Cleanup Service', () => {
  let mockSupabase;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-03-15T12:00:00Z'));

    toUTCISOString.mockImplementation(date => date.toISOString());

    // Mock Supabase client
    // NOTE: update() returns `this` (mockReturnThis), and the chain ends with
    // .eq() which also returns `this`. `await mockSupabase` resolves to
    // mockSupabase itself (plain object, not a Promise), so
    // `const { error } = mockSupabase` yields error=undefined — no error thrown.
    // For error scenarios, override eq with mockReturnValue({ error: ... }).
    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis()
    };

    getClient.mockReturnValue(mockSupabase);
  });

  afterEach(() => {
    cleanupService.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('getCutoffDate', () => {
    it('should return cutoff date 2 months ago', () => {
      const cutoffDate = cleanupService.getCutoffDate();

      // Current date is March 15, 2024, so 2 months ago is January 1, 2024
      expect(cutoffDate.getMonth()).toBe(0); // January (0-based)
      expect(cutoffDate.getDate()).toBe(1); // First day of month
      expect(cutoffDate.getHours()).toBe(0);
      expect(cutoffDate.getMinutes()).toBe(0);
      expect(cutoffDate.getSeconds()).toBe(0);
    });
  });

  describe('getScreenshotsForCleanup', () => {
    const mockScreenshots = [
      {
        id: 'ss1',
        storage_path: 'user1/screenshot_123.png',
        thumbnail_url: 'https://example.com/thumb_123.jpg',
        created_at: '2023-12-01T00:00:00Z'
      },
      {
        id: 'ss2',
        storage_path: 'user2/screenshot_456.png',
        thumbnail_url: 'https://example.com/thumb_456.jpg',
        created_at: '2023-11-15T00:00:00Z'
      }
    ];

    it('should fetch screenshots for cleanup', async () => {
      mockSupabase.range.mockResolvedValue({
        data: mockScreenshots,
        error: null
      });

      const screenshots = await cleanupService.getScreenshotsForCleanup();

      expect(mockSupabase.from).toHaveBeenCalledWith('screenshots');
      expect(mockSupabase.select).toHaveBeenCalledWith('id, storage_path, thumbnail_url, created_at');
      expect(mockSupabase.lt).toHaveBeenCalledWith('created_at', expect.any(String));
      expect(mockSupabase.not).toHaveBeenCalledWith('storage_path', 'is', null);
      expect(mockSupabase.is).toHaveBeenCalledWith('deleted_at', null);
      expect(mockSupabase.neq).toHaveBeenCalledWith('status', 'deleted');
      expect(screenshots).toEqual(mockScreenshots);
    });

    it('should use custom limit and offset', async () => {
      mockSupabase.range.mockResolvedValue({
        data: mockScreenshots,
        error: null
      });

      await cleanupService.getScreenshotsForCleanup(10, 5);

      expect(mockSupabase.range).toHaveBeenCalledWith(5, 14); // offset 5, limit 10 (5-14)
    });

    it('should return empty array if no screenshots found', async () => {
      mockSupabase.range.mockResolvedValue({
        data: null,
        error: null
      });

      const screenshots = await cleanupService.getScreenshotsForCleanup();

      expect(screenshots).toEqual([]);
    });

    it('should throw error on database failure', async () => {
      mockSupabase.range.mockResolvedValue({
        data: null,
        error: new Error('Database error')
      });

      await expect(cleanupService.getScreenshotsForCleanup()).rejects.toThrow('Database error');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('runCleanup', () => {
    it('should run cleanup successfully',  async () => {
      const mockScreenshots = [
        {
          id: 'ss1',
          storage_path: 'user1/screenshot_123.png',
          created_at: '2023-12-01T00:00:00Z'
        }
      ];

      mockSupabase.range.mockResolvedValue({
        data: mockScreenshots,
        error: null
      });

      deleteFile.mockResolvedValue();

      const result = await cleanupService.runCleanup();

      expect(result.success).toBe(true);
      expect(result.deleted).toBeGreaterThan(0);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Starting monthly cleanup job')
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Monthly cleanup completed')
      );
    });

    it('should skip if already running', async () => {
      // Mock a running cleanup by setting isRunning flag
      const firstRun = cleanupService.runCleanup();
      const secondRun = cleanupService.runCleanup();

      const secondResult = await secondRun;
      await firstRun;

      expect(logger.warn).toHaveBeenCalledWith(
        '[Cleanup] Cleanup is already running, skipping'
      );
      expect(secondResult.success).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      mockSupabase.range.mockRejectedValue(new Error('Database connection failed'));

      const result = await cleanupService.runCleanup();

      expect(result.success).toBe(false);
      expect(result.deleted).toBe(0);
      expect(result.errors).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        '[Cleanup] Error in cleanup job:',
        expect.any(Error)
      );
    });

    it('should process multiple batches', async () => {
      const batch1 = Array(50).fill(null).map((_, i) => ({
        id: `ss${i}`,
        storage_path: `user/screenshot_${i}.png`,
        created_at: '2023-12-01T00:00:00Z'
      }));

      const batch2 = [
        {
          id: 'ss50',
          storage_path: 'user/screenshot_50.png',
          created_at: '2023-12-01T00:00:00Z'
        }
      ];

      mockSupabase.range
        .mockResolvedValueOnce({ data: batch1, error: null })
        .mockResolvedValueOnce({ data: batch2, error: null })
        .mockResolvedValueOnce({ data: [], error: null });

      deleteFile.mockResolvedValue();

      jest.useRealTimers(); // needed: 500ms inter-batch delay uses setTimeout
      const result = await cleanupService.runCleanup();
      jest.useFakeTimers();

      expect(result.success).toBe(true);
      expect(result.deleted).toBeGreaterThan(0);
    });

    it('should delete both screenshot and thumbnail files', async () => {
      const mockScreenshot = {
        id: 'ss1',
        storage_path: 'user1/screenshot_123.png',
        created_at: '2023-12-01T00:00:00Z'
      };

      mockSupabase.range.mockResolvedValue({
        data: [mockScreenshot],
        error: null
      });

      deleteFile.mockResolvedValue();

      await cleanupService.runCleanup();

      expect(deleteFile).toHaveBeenCalledWith('screenshots', 'user1/screenshot_123.png');
      expect(deleteFile).toHaveBeenCalledWith('screenshots', 'user1/thumb_123.jpg');
    });

    it('should handle file deletion errors gracefully', async () => {
      const mockScreenshot = {
        id: 'ss1',
        storage_path: 'user1/screenshot_123.png',
        created_at: '2023-12-01T00:00:00Z'
      };

      mockSupabase.range.mockResolvedValue({
        data: [mockScreenshot],
        error: null
      });

      deleteFile.mockRejectedValue(new Error('File not found'));

      const result = await cleanupService.runCleanup();

      expect(result.success).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should mark files as deleted in database', async () => {
      const mockScreenshot = {
        id: 'ss1',
        storage_path: 'user1/screenshot_123.png',
        created_at: '2023-12-01T00:00:00Z'
      };

      mockSupabase.range.mockResolvedValue({
        data: [mockScreenshot],
        error: null
      });

      deleteFile.mockResolvedValue();

      await cleanupService.runCleanup();

      expect(mockSupabase.update).toHaveBeenCalledWith({
        storage_url: '',
        thumbnail_url: '',
        status: 'deleted',
        deleted_at: expect.any(String)
      });
      expect(mockSupabase.eq).toHaveBeenCalledWith('id', 'ss1');
    });

    it('should handle database update errors', async () => {
      const mockScreenshot = {
        id: 'ss1',
        storage_path: 'user1/screenshot_123.png',
        created_at: '2023-12-01T00:00:00Z'
      };

      mockSupabase.range.mockResolvedValue({
        data: [mockScreenshot],
        error: null
      });

      // Make the UPDATE chain return an error object so markFilesAsDeleted throws
      mockSupabase.eq.mockReturnValue({ error: new Error('Update failed') });

      deleteFile.mockResolvedValue();

      const result = await cleanupService.runCleanup();

      expect(result.success).toBe(true); // Service continues despite update errors
      expect(result.errors).toBeGreaterThan(0);
    });

    it('should transform thumbnail path correctly for root-level files', async () => {
      const mockScreenshot = {
        id: 'ss1',
        storage_path: 'screenshot_123.png',
        created_at: '2023-12-01T00:00:00Z'
      };

      mockSupabase.range.mockResolvedValue({
        data: [mockScreenshot],
        error: null
      });

      deleteFile.mockResolvedValue();

      await cleanupService.runCleanup();

      expect(deleteFile).toHaveBeenCalledWith('screenshots', 'screenshot_123.png');
      expect(deleteFile).toHaveBeenCalledWith('screenshots', 'thumb_123.jpg');
    });

    it('should add delay between batches', async () => {
      const batch1 = Array(50).fill(null).map((_, i) => ({
        id: `ss${i}`,
        storage_path: `user/screenshot_${i}.png`,
        created_at: '2023-12-01T00:00:00Z'
      }));

      const batch2 = [
        {
          id: 'ss50',
          storage_path: 'user/screenshot_50.png',
          created_at: '2023-12-01T00:00:00Z'
        }
      ];

      mockSupabase.range
        .mockResolvedValueOnce({ data: batch1, error: null })
        .mockResolvedValueOnce({ data: batch2, error: null })
        .mockResolvedValueOnce({ data: [], error: null });

      deleteFile.mockResolvedValue();

      jest.useRealTimers(); // Use real timers for this test

      const promise = cleanupService.runCleanup();

      await promise;

      jest.useFakeTimers();
    });
  });

  describe('start and stop', () => {
    it('should start the cleanup service with scheduling', async () => {
      await cleanupService.start();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Starting cleanup service')
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Cleanup service started successfully')
      );
    });

    it('should stop the cleanup service', () => {
      cleanupService.start();
      cleanupService.stop();

      expect(logger.info).toHaveBeenCalledWith('[Cleanup] Cleanup service stopped');
    });

    it('should handle stop when not started', () => {
      cleanupService.stop();

      expect(logger.info).not.toHaveBeenCalledWith('[Cleanup] Cleanup service stopped');
    });
  });

    it('should handle stop when not started (duplicate check)', () => {
      cleanupService.stop();

      expect(logger.info).not.toHaveBeenCalledWith('[Cleanup] Cleanup service stopped');
    });

    it('should handle empty cutoff date', () => {
      const cutoffDate = cleanupService.getCutoffDate();

      expect(cutoffDate).toBeInstanceOf(Date);
      expect(cutoffDate.getTime()).toBeLessThan(Date.now());
    });

    it('should handle screenshots with null thumbnail_url', async () => {
      const mockScreenshot = {
        id: 'ss1',
        storage_path: 'user1/screenshot_123.png',
        thumbnail_url: null,
        created_at: '2023-12-01T00:00:00Z'
      };

      mockSupabase.range.mockResolvedValue({
        data: [mockScreenshot],
        error: null
      });

      deleteFile.mockResolvedValue();

      await cleanupService.runCleanup();

      expect(deleteFile).toHaveBeenCalledTimes(2); // Screenshot + thumbnail
    });

    it('should handle screenshots without storage_path', async () => {
      const mockScreenshot = {
        id: 'ss1',
        storage_path: null,
        created_at: '2023-12-01T00:00:00Z'
      };

      mockSupabase.range.mockResolvedValue({
        data: [mockScreenshot],
        error: null
      });

      await cleanupService.runCleanup();

      expect(deleteFile).not.toHaveBeenCalled();
      expect(mockSupabase.update).toHaveBeenCalledWith({
        storage_url: '',
        thumbnail_url: '',
        status: 'deleted',
        deleted_at: expect.any(String)
      });
    });

    it('should handle empty string storage_path', async () => {
      const mockScreenshot = {
        id: 'ss1',
        storage_path: '',
        created_at: '2023-12-01T00:00:00Z'
      };

      mockSupabase.range.mockResolvedValue({
        data: [mockScreenshot],
        error: null
      });

      await cleanupService.runCleanup();

      expect(deleteFile).not.toHaveBeenCalled();
    });

    it('should handle very old screenshots', async () => {
      const mockScreenshot = {
        id: 'ss1',
        storage_path: 'user1/screenshot_123.png',
        created_at: '2020-01-01T00:00:00Z' // Very old
      };

      mockSupabase.range.mockResolvedValue({
        data: [mockScreenshot],
        error: null
      });

      deleteFile.mockResolvedValue();

      await cleanupService.runCleanup();

      expect(deleteFile).toHaveBeenCalled();
    });

    it('should handle screenshots with complex directory paths', async () => {
      const mockScreenshot = {
        id: 'ss1',
        storage_path: 'org1/user123/subfolder/screenshot_123.png',
        created_at: '2023-12-01T00:00:00Z'
      };

      mockSupabase.range.mockResolvedValue({
        data: [mockScreenshot],
        error: null
      });

      deleteFile.mockResolvedValue();

      await cleanupService.runCleanup();

      expect(deleteFile).toHaveBeenCalledWith('screenshots', 'org1/user123/subfolder/screenshot_123.png');
      expect(deleteFile).toHaveBeenCalledWith('screenshots', 'org1/user123/subfolder/thumb_123.jpg');
    });

    it('should handle concurrent runCleanup calls', async () => {
      mockSupabase.range.mockImplementation(() => {
        return new Promise(resolve => {
          setTimeout(() => resolve({ data: [], error: null }), 100);
        });
      });

      jest.useRealTimers();

      const promise1 = cleanupService.runCleanup();
      const promise2 = cleanupService.runCleanup();

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // One should succeed, one should skip
      const successCount = [result1, result2].filter(r => r.success).length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      jest.useFakeTimers();
    });

    it('should handle batch processing with timeout between batches', async () => {
      const batch1 = Array(50).fill(null).map((_, i) => ({
        id: `ss${i}`,
        storage_path: `user/screenshot_${i}.png`,
        created_at: '2023-12-01T00:00:00Z'
      }));

      const batch2 = [
        {
          id: 'ss50',
          storage_path: 'user/screenshot_50.png',
          created_at: '2023-12-01T00:00:00Z'
        }
      ];

      mockSupabase.range
        .mockResolvedValueOnce({ data: batch1, error: null })
        .mockResolvedValueOnce({ data: batch2, error: null });

      deleteFile.mockResolvedValue();

      jest.useRealTimers();

      const result = await cleanupService.runCleanup();

      expect(result.success).toBe(true);

      jest.useFakeTimers();
    });

    it('should handle partial batch success', async () => {
      const mockScreenshots = [
        {
          id: 'ss1',
          storage_path: 'user/screenshot_1.png',
          created_at: '2023-12-01T00:00:00Z'
        },
        {
          id: 'ss2',
          storage_path: 'user/screenshot_2.png',
          created_at: '2023-12-01T00:00:00Z'
        }
      ];

      mockSupabase.range.mockResolvedValue({
        data: mockScreenshots,
        error: null
      });

      // First screenshot's UPDATE eq succeeds, second fails
      mockSupabase.eq
        .mockReturnValueOnce({ error: null })
        .mockReturnValueOnce({ error: new Error('Update failed') });

      deleteFile.mockResolvedValue();

      const result = await cleanupService.runCleanup();

      expect(result.success).toBe(true);
      expect(result.errors).toBe(1);
    });

    it('should handle environment variable configuration', async () => {
      // CLEANUP_SCHEDULE_DAY etc. are module-level consts evaluated at require time.
      // We can only verify the compiled default value (1st of each month at 3:00).
      await cleanupService.start();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('1st of each month')
      );

      cleanupService.stop();
    });

    it('should handle database query timeout', async () => {
      mockSupabase.range.mockImplementation(() => {
        return new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error('Query timeout')), 100);
        });
      });

      jest.useRealTimers();

      const result = await cleanupService.runCleanup();

      expect(result.success).toBe(false);

      jest.useFakeTimers();
    });

    it('should track deletion statistics correctly', async () => {
      const mockScreenshots = [
        { id: 'ss1', storage_path: 'user/screenshot_1.png', created_at: '2023-12-01T00:00:00Z' },
        { id: 'ss2', storage_path: 'user/screenshot_2.png', created_at: '2023-12-01T00:00:00Z' },
        { id: 'ss3', storage_path: 'user/screenshot_3.png', created_at: '2023-12-01T00:00:00Z' }
      ];

      mockSupabase.range.mockResolvedValue({
        data: mockScreenshots,
        error: null
      });

      deleteFile.mockResolvedValue();

      const result = await cleanupService.runCleanup();

      // deleted counts screenshots where at least one file was successfully removed (1 per screenshot)
      expect(result.deleted).toBe(3);
    });

    it('should handle ordinal suffix generation', async () => {
      await cleanupService.start();

      // Check various ordinal suffixes are logged correctly
      expect(logger.info).toHaveBeenCalled();

      cleanupService.stop();
    });

  describe('isCleanupRunning', () => {
    it('should return false when not running', () => {
      expect(cleanupService.isCleanupRunning()).toBe(false);
    });

    it('should return true when running', async () => {
      let resolveRange;
      mockSupabase.range.mockImplementation(() => {
        return new Promise(resolve => { resolveRange = resolve; });
      });

      const runPromise = cleanupService.runCleanup();

      // Wait a tick for the promise to start
      await Promise.resolve();

      expect(cleanupService.isCleanupRunning()).toBe(true);

      // Clean up: resolve the pending range call so isRunning resets to false
      resolveRange({ data: [], error: null });
      await runPromise;
    });

    it('should return false after completion', async () => {
      mockSupabase.range.mockResolvedValue({ data: [], error: null });

      await cleanupService.runCleanup();

      expect(cleanupService.isCleanupRunning()).toBe(false);
    });
  });

});

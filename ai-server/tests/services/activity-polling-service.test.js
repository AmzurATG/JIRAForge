/**
 * Activity Polling Service Unit Tests
 */

const activityService = require('../../src/services/activity-service');
const activityDbService = require('../../src/services/db/activity-db-service');
const logger = require('../../src/utils/logger');

// Mock all dependencies
jest.mock('../../src/services/activity-service');
jest.mock('../../src/services/db/activity-db-service');
jest.mock('../../src/utils/logger');

// Import service after mocks
const activityPollingService = require('../../src/services/activity-polling-service');

describe('Activity Polling Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    // Stop service before each test to ensure clean state
    if (activityPollingService.isRunning) {
      activityPollingService.stop();
    }
    activityPollingService.processing = false;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    
    // Ensure service is stopped after each test
    if (activityPollingService.isRunning) {
      activityPollingService.stop();
    }
  });

  describe('start', () => {
    it('should start the polling service', async () => {
      activityDbService.resetStuckProcessingRecords.mockResolvedValue();
      activityDbService.getPendingActivityBatches.mockResolvedValue([]);

      activityPollingService.start();

      expect(activityPollingService.isRunning).toBe(true);
      expect(activityPollingService.intervalId).not.toBeNull();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Starting activity polling service')
      );

      // Wait for initial processing
      await Promise.resolve();
    });

    it('should not start if already running', () => {
      activityPollingService.isRunning = true;

      activityPollingService.start();

      expect(logger.warn).toHaveBeenCalledWith(
        'Activity polling service is already running'
      );
    });

    it('should trigger initial processing on start', async () => {
      activityDbService.resetStuckProcessingRecords.mockResolvedValue();
      activityDbService.getPendingActivityBatches.mockResolvedValue([]);

      activityPollingService.start();

      await Promise.resolve();

      expect(activityDbService.getPendingActivityBatches).toHaveBeenCalled();
    });

    it('should set up interval for periodic polling', () => {
      activityDbService.resetStuckProcessingRecords.mockResolvedValue();
      activityDbService.getPendingActivityBatches.mockResolvedValue([]);

      activityPollingService.start();

      expect(activityPollingService.intervalId).not.toBeNull();
    });
  });

  describe('stop', () => {
    it('should stop the polling service', () => {
      activityPollingService.isRunning = true;
      activityPollingService.intervalId = setInterval(() => {}, 1000);

      activityPollingService.stop();

      expect(activityPollingService.isRunning).toBe(false);
      expect(activityPollingService.intervalId).toBeNull();
      expect(logger.info).toHaveBeenCalledWith('Activity polling service stopped');
    });

    it('should do nothing if not running', () => {
      activityPollingService.isRunning = false;
      activityPollingService.intervalId = null;

      activityPollingService.stop();

      expect(logger.info).not.toHaveBeenCalledWith('Activity polling service stopped');
    });
  });

  describe('processPendingRecords', () => {
    const mockRecords = [
      {
        id: 'record1',
        user_id: 'user1',
        organization_id: 'org1',
        window_title: 'VS Code',
        application_name: 'Code',
        ocr_text: 'test code',
        total_time_seconds: 600,
        start_time: '2024-01-01T10:00:00Z',
        end_time: '2024-01-01T10:10:00Z',
        user_assigned_issues: JSON.stringify([{key: 'PROJ-1', summary: 'Task 1'}])
      },
      {
        id: 'record2',
        user_id: 'user1',
        organization_id: 'org1',
        window_title: 'Chrome',
        application_name: 'Chrome',
        ocr_text: 'task details',
        total_time_seconds: 300,
        start_time: '2024-01-01T10:10:00Z',
        end_time: '2024-01-01T10:15:00Z',
        user_assigned_issues: null
      }
    ];

    beforeEach(() => {
      activityDbService.resetStuckProcessingRecords.mockResolvedValue();
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1', 'record2']);
      activityService.analyzeBatch.mockResolvedValue();
    });

    it('should process pending records successfully', async () => {
      activityDbService.getPendingActivityBatches.mockResolvedValue(mockRecords);

      await activityPollingService.processPendingRecords();

      expect(activityDbService.resetStuckProcessingRecords).toHaveBeenCalledWith(10);
      expect(activityDbService.getPendingActivityBatches).toHaveBeenCalledWith(
        activityPollingService.batchSize
      );
      expect(activityService.analyzeBatch).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Processing 2 pending activity record(s)')
      );
    });

    it('should skip if no pending records', async () => {
      activityDbService.getPendingActivityBatches.mockResolvedValue([]);

      await activityPollingService.processPendingRecords();

      expect(logger.debug).toHaveBeenCalledWith('No pending activity records to process');
      expect(activityService.analyzeBatch).not.toHaveBeenCalled();
    });

    it('should skip if already processing', async () => {
      activityPollingService.processing = true;

      await activityPollingService.processPendingRecords();

      expect(logger.debug).toHaveBeenCalledWith(
        'Previous activity polling cycle still running, skipping'
      );
      expect(activityDbService.getPendingActivityBatches).not.toHaveBeenCalled();
    });

    it('should group records by user ID', async () => {
      const multiUserRecords = [
        { ...mockRecords[0], user_id: 'user1' },
        { ...mockRecords[1], user_id: 'user2' }
      ];

      activityDbService.getPendingActivityBatches.mockResolvedValue(multiUserRecords);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1', 'record2']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalledTimes(2);
    });

    it('should parse user assigned issues from JSON string', async () => {
      activityDbService.getPendingActivityBatches.mockResolvedValue([mockRecords[0]]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalledWith(
        expect.any(Array),
        [{key: 'PROJ-1', summary: 'Task 1'}],
        'user1',
        'org1'
      );
    });

    it('should handle invalid user_assigned_issues JSON gracefully', async () => {
      const recordWithInvalidJson = {
        ...mockRecords[0],
        user_assigned_issues: 'invalid json['
      };

      activityDbService.getPendingActivityBatches.mockResolvedValue([recordWithInvalidJson]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);

      await activityPollingService.processPendingRecords();

      // Should log debug message for parse failure
      expect(logger.debug).toHaveBeenCalledWith(
        'Failed to parse user_assigned_issues:',
        expect.any(String)
      );
      
      // Should still process with empty issues array
      expect(activityService.analyzeBatch).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        'user1',
        'org1'
      );
    });

    it('should handle null/undefined user_assigned_issues', async () => {
      const recordWithNullIssues = {
        ...mockRecords[0],
        user_assigned_issues: null
      };

      activityDbService.getPendingActivityBatches.mockResolvedValue([recordWithNullIssues]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        'user1',
        'org1'
      );
    });

    it('should skip if records already claimed', async () => {
      activityDbService.getPendingActivityBatches.mockResolvedValue(mockRecords);
      activityDbService.claimBatchForProcessing.mockResolvedValue([]);

      await activityPollingService.processPendingRecords();

      expect(logger.info).toHaveBeenCalledWith(
        'Activity records already claimed by another process, skipping'
      );
      expect(activityService.analyzeBatch).not.toHaveBeenCalled();
    });

    it('should mark batch as failed on processing error', async () => {
      activityDbService.getPendingActivityBatches.mockResolvedValue(mockRecords);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1', 'record2']);
      activityService.analyzeBatch.mockRejectedValue(new Error('Analysis failed'));
      activityDbService.markBatchFailed.mockResolvedValue();

      await activityPollingService.processPendingRecords();

      expect(logger.error).toHaveBeenCalled();
      expect(activityDbService.markBatchFailed).toHaveBeenCalledWith(
        ['record1', 'record2'],
        'Analysis failed'
      );
    });

    it('should handle network errors gracefully', async () => {
      const networkError = new Error('fetch failed - ENOTFOUND');
      activityDbService.getPendingActivityBatches.mockRejectedValue(networkError);

      await activityPollingService.processPendingRecords();

      expect(logger.debug).toHaveBeenCalledWith(
        'Network error in activity polling (will retry on next cycle)'
      );
    });

    it('should handle ECONNREFUSED network errors', async () => {
      const networkError = new Error('ECONNREFUSED');
      activityDbService.getPendingActivityBatches.mockRejectedValue(networkError);

      await activityPollingService.processPendingRecords();

      expect(logger.debug).toHaveBeenCalledWith(
        'Network error in activity polling (will retry on next cycle)'
      );
    });

    it('should handle ETIMEDOUT network errors', async () => {
      const networkError = new Error('ETIMEDOUT');
      activityDbService.getPendingActivityBatches.mockRejectedValue(networkError);

      await activityPollingService.processPendingRecords();

      expect(logger.debug).toHaveBeenCalledWith(
        'Network error in activity polling (will retry on next cycle)'
      );
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('timeout exceeded');
      activityDbService.getPendingActivityBatches.mockRejectedValue(timeoutError);

      await activityPollingService.processPendingRecords();

      expect(logger.debug).toHaveBeenCalledWith(
        'Network error in activity polling (will retry on next cycle)'
      );
    });

    it('should handle certificate errors', async () => {
      const certError = new Error('certificate has expired');
      activityDbService.getPendingActivityBatches.mockRejectedValue(certError);

      await activityPollingService.processPendingRecords();

      expect(logger.debug).toHaveBeenCalledWith(
        'Network error in activity polling (will retry on next cycle)'
      );
    });

    it('should handle non-network errors with error log', async () => {
      const genericError = new Error('Database connection failed');
      activityDbService.getPendingActivityBatches.mockRejectedValue(genericError);

      await activityPollingService.processPendingRecords();

      expect(logger.error).toHaveBeenCalledWith(
        'Error in activity polling cycle:',
        genericError
      );
    });

    it('should reset processing flag after completion', async () => {
      activityDbService.getPendingActivityBatches.mockResolvedValue([]);

      expect(activityPollingService.processing).toBe(false);

      const processingPromise = activityPollingService.processPendingRecords();
      
      await processingPromise;

      expect(activityPollingService.processing).toBe(false);
    });

    it('should reset processing flag even on error', async () => {
      activityDbService.resetStuckProcessingRecords.mockRejectedValue(new Error('Reset failed'));

      await activityPollingService.processPendingRecords();

      expect(activityPollingService.processing).toBe(false);
    });

    it('should log completion summary with successes and failures', async () => {
      const multiUserRecords = [
        { ...mockRecords[0], user_id: 'user1' },
        { ...mockRecords[1], user_id: 'user2' }
      ];

      activityDbService.getPendingActivityBatches.mockResolvedValue(multiUserRecords);
      activityDbService.claimBatchForProcessing
        .mockResolvedValueOnce(['record1'])
        .mockResolvedValueOnce(['record2']);
      
      activityService.analyzeBatch
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('Failed'));
      
      activityDbService.markBatchFailed.mockResolvedValue();

      await activityPollingService.processPendingRecords();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('1 succeeded, 1 failed')
      );
    });

    it('should log completion summary for all successful', async () => {
      activityDbService.getPendingActivityBatches.mockResolvedValue([mockRecords[0]]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);

      await activityPollingService.processPendingRecords();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('all succeeded')
      );
    });

    it('should transform records for analysis correctly', async () => {
      activityDbService.getPendingActivityBatches.mockResolvedValue([mockRecords[0]]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalledWith(
        [{
          id: 'record1',
          window_title: 'VS Code',
          application_name: 'Code',
          ocr_text: 'test code',
          total_time_seconds: 600,
          start_time: '2024-01-01T10:00:00Z',
          end_time: '2024-01-01T10:10:00Z',
          classification: undefined
        }],
        expect.any(Array),
        'user1',
        'org1'
      );
    });

    it('should handle batch timeout', async () => {
      process.env.ACTIVITY_BATCH_TIMEOUT_MS = '100';
      
      activityDbService.getPendingActivityBatches.mockResolvedValue([mockRecords[0]]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);
      activityService.analyzeBatch.mockImplementation(
        () => new Promise(resolve => setTimeout(resolve, 1000))
      );
      activityDbService.markBatchFailed.mockResolvedValue();

      await activityPollingService.processPendingRecords();

      expect(activityDbService.markBatchFailed).toHaveBeenCalledWith(
        ['record1'],
        expect.stringContaining('timed out')
      );
    });

    it('should use first non-empty user_assigned_issues from batch', async () => {
      const recordsWithMixedIssues = [
        { ...mockRecords[0], user_assigned_issues: null },
        { ...mockRecords[1], user_assigned_issues: JSON.stringify([{key: 'PROJ-2', summary: 'Task 2'}]) }
      ];

      activityDbService.getPendingActivityBatches.mockResolvedValue(recordsWithMixedIssues);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1', 'record2']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalledWith(
        expect.any(Array),
        [{key: 'PROJ-2', summary: 'Task 2'}],
        'user1',
        'org1'
      );
    });

    it('should handle non-array user_assigned_issues', async () => {
      const recordWithObjectIssues = {
        ...mockRecords[0],
        user_assigned_issues: JSON.stringify({key: 'PROJ-1', summary: 'Task 1'})
      };

      activityDbService.getPendingActivityBatches.mockResolvedValue([recordWithObjectIssues]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        'user1',
        'org1'
      );
    });

    it('should handle already-parsed array user_assigned_issues', async () => {
      const recordWithArrayIssues = {
        ...mockRecords[0],
        user_assigned_issues: [{key: 'PROJ-1', summary: 'Task 1'}]
      };

      activityDbService.getPendingActivityBatches.mockResolvedValue([recordWithArrayIssues]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalledWith(
        expect.any(Array),
        [{key: 'PROJ-1', summary: 'Task 1'}],
        'user1',
        'org1'
      );
    });

    it('should handle empty string user_assigned_issues', async () => {
      const recordWithEmptyString = {
        ...mockRecords[0],
        user_assigned_issues: ''
      };

      activityDbService.getPendingActivityBatches.mockResolvedValue([recordWithEmptyString]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalledWith(
        expect.any(Array),
        [],
        'user1',
        'org1'
      );
    });

    it('should handle records with mixed valid/invalid issues', async () => {
      const records = [
        { ...mockRecords[0], user_assigned_issues: 'invalid[' },
        { ...mockRecords[1], user_assigned_issues: JSON.stringify([{key: 'PROJ-1'}]) }
      ];

      activityDbService.getPendingActivityBatches.mockResolvedValue(records);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1', 'record2']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalledWith(
        expect.any(Array),
        [{key: 'PROJ-1'}],
        'user1',
        'org1'
      );
    });

    it('should handle very large batches', async () => {
      const largeRecordSet = Array(100).fill(null).map((_, i) => ({
        ...mockRecords[0],
        id: `record${i}`,
        user_id: `user${i % 10}`
      }));

      activityDbService.getPendingActivityBatches.mockResolvedValue(largeRecordSet);
      activityDbService.claimBatchForProcessing.mockResolvedValue(largeRecordSet.map(r => r.id));

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalled();
    });

    it('should handle resetStuckProcessingRecords errors', async () => {
      activityDbService.resetStuckProcessingRecords.mockRejectedValue(new Error('Reset failed'));

      await activityPollingService.processPendingRecords();

      expect(logger.error).toHaveBeenCalledWith(
        'Error in activity polling cycle:',
        expect.any(Error)
      );
    });

    it('should use custom batch size from environment', () => {
      process.env.ACTIVITY_POLLING_BATCH_SIZE = '50';
      const customService = require('../../src/services/activity-polling-service');
      
      expect(customService.batchSize).toBe(50);
      
      delete process.env.ACTIVITY_POLLING_BATCH_SIZE;
    });

    it('should use custom polling interval from environment', () => {
      process.env.ACTIVITY_POLLING_INTERVAL_MS = '60000';
      const customService = require('../../src/services/activity-polling-service');
      
      expect(customService.pollInterval).toBe(60000);
      
      delete process.env.ACTIVITY_POLLING_INTERVAL_MS;
    });

    it('should handle missing organization_id in records', async () => {
      const recordWithoutOrg = {
        ...mockRecords[0],
        organization_id: null
      };

      activityDbService.getPendingActivityBatches.mockResolvedValue([recordWithoutOrg]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Array),
        'user1',
        null
      );
    });

    it('should handle records with undefined fields', async () => {
      const minimalRecord = {
        id: 'record1',
        user_id: 'user1'
      };

      activityDbService.getPendingActivityBatches.mockResolvedValue([minimalRecord]);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1']);

      await activityPollingService.processPendingRecords();

      expect(activityService.analyzeBatch).toHaveBeenCalled();
    });

    it('should handle multiple errors in different batches', async () => {
      const multiUserRecords = [
        { ...mockRecords[0], user_id: 'user1' },
        { ...mockRecords[1], user_id: 'user2' },
        { ...mockRecords[0], user_id: 'user3' }
      ];

      activityDbService.getPendingActivityBatches.mockResolvedValue(multiUserRecords);
      activityDbService.claimBatchForProcessing.mockResolvedValue(['record1', 'record2', 'record3']);
      
      activityService.analyzeBatch
        .mockRejectedValueOnce(new Error('User 1 failed'))
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('User 3 failed'));
      
      activityDbService.markBatchFailed.mockResolvedValue();

      await activityPollingService.processPendingRecords();

      expect(activityDbService.markBatchFailed).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('1 succeeded, 2 failed')
      );
    });

    it('should handle interval execution', async () => {
      activityDbService.resetStuckProcessingRecords.mockResolvedValue();
      activityDbService.getPendingActivityBatches.mockResolvedValue([]);

      activityPollingService.start();

      // Fast-forward time by poll interval
      jest.advanceTimersByTime(activityPollingService.pollInterval);

      await Promise.resolve();

      expect(activityDbService.getPendingActivityBatches).toHaveBeenCalled();
    });

    it('should handle stop during processing', async () => {
      activityPollingService.start();
      activityPollingService.stop();

      expect(activityPollingService.isRunning).toBe(false);
      expect(activityPollingService.intervalId).toBeNull();
    });
  });
});

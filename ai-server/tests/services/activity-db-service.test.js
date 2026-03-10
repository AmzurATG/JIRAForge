/**
 * Activity DB Service Unit Tests
 * Tests for database operations on activity_records table
 */

'use strict';

const { getClient, isNetworkError } = require('../../src/services/db/supabase-client');
const logger = require('../../src/utils/logger');

// Mock dependencies
jest.mock('../../src/services/db/supabase-client');
jest.mock('../../src/utils/logger');

// Import service after mocks
const {
  getPendingActivityBatches,
  claimBatchForProcessing,
  updateActivityRecordAnalysis,
  markBatchAnalyzed,
  markBatchFailed,
  resetStuckProcessingRecords
} = require('../../src/services/db/activity-db-service');

describe('Activity DB Service', () => {
  let mockSupabase;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Supabase client with chainable methods
    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      single: jest.fn()
    };

    getClient.mockReturnValue(mockSupabase);
    isNetworkError.mockReturnValue(false);
  });

  // ==========================================================================
  // getPendingActivityBatches
  // ==========================================================================
  describe('getPendingActivityBatches', () => {
    it('should return pending activity records with default batch size', async () => {
      const mockRecords = [
        { id: 'rec-1', status: 'pending', retry_count: 0 },
        { id: 'rec-2', status: 'pending', retry_count: 1 }
      ];
      mockSupabase.limit.mockResolvedValue({ data: mockRecords });

      const result = await getPendingActivityBatches();

      expect(mockSupabase.from).toHaveBeenCalledWith('activity_records');
      expect(mockSupabase.select).toHaveBeenCalledWith('*');
      expect(mockSupabase.eq).toHaveBeenCalledWith('status', 'pending');
      expect(mockSupabase.lt).toHaveBeenCalledWith('retry_count', 3);
      expect(mockSupabase.order).toHaveBeenCalledWith('created_at', { ascending: true });
      expect(mockSupabase.limit).toHaveBeenCalledWith(10);
      expect(result).toEqual(mockRecords);
    });

    it('should use custom batch size', async () => {
      mockSupabase.limit.mockResolvedValue({ data: [] });

      await getPendingActivityBatches(25);

      expect(mockSupabase.limit).toHaveBeenCalledWith(25);
    });

    it('should return empty array when data is null', async () => {
      mockSupabase.limit.mockResolvedValue({ data: null });

      const result = await getPendingActivityBatches();

      expect(result).toEqual([]);
    });

    it('should throw when Supabase client is not initialized', async () => {
      getClient.mockReturnValue(null);

      await expect(getPendingActivityBatches()).rejects.toThrow('Supabase client not initialized');
    });
  });

  // ==========================================================================
  // claimBatchForProcessing
  // ==========================================================================
  describe('claimBatchForProcessing', () => {
    const recordIds = ['rec-1', 'rec-2', 'rec-3'];

    it('should claim records by updating status to processing', async () => {
      const claimedRecords = [
        { id: 'rec-1', status: 'processing' },
        { id: 'rec-2', status: 'processing' }
      ];
      mockSupabase.select.mockResolvedValue({ data: claimedRecords, error: null });

      const result = await claimBatchForProcessing(recordIds);

      expect(mockSupabase.from).toHaveBeenCalledWith('activity_records');
      expect(mockSupabase.update).toHaveBeenCalledWith({
        status: 'processing',
        updated_at: expect.any(String)
      });
      expect(mockSupabase.in).toHaveBeenCalledWith('id', recordIds);
      expect(mockSupabase.eq).toHaveBeenCalledWith('status', 'pending');
      expect(result).toEqual(claimedRecords);
    });

    it('should return empty array when no records claimed', async () => {
      mockSupabase.select.mockResolvedValue({ data: null, error: null });

      const result = await claimBatchForProcessing(recordIds);

      expect(result).toEqual([]);
    });

    it('should throw on Supabase error', async () => {
      const dbError = new Error('Database connection failed');
      mockSupabase.select.mockResolvedValue({ data: null, error: dbError });

      await expect(claimBatchForProcessing(recordIds)).rejects.toThrow('Database connection failed');
    });

    it('should throw when Supabase client is not initialized', async () => {
      getClient.mockReturnValue(null);

      await expect(claimBatchForProcessing(recordIds)).rejects.toThrow('Supabase client not initialized');
    });
  });

  // ==========================================================================
  // updateActivityRecordAnalysis
  // ==========================================================================
  describe('updateActivityRecordAnalysis', () => {
    const recordId = 'rec-123';

    it('should update record with analysis results', async () => {
      const analysisResult = {
        taskKey: 'ATG-456',
        projectKey: 'ATG',
        metadata: { confidenceScore: 0.95 }
      };
      const updatedRecord = { id: recordId, status: 'analyzed', user_assigned_issue_key: 'ATG-456' };
      mockSupabase.select.mockResolvedValue({ data: [updatedRecord], error: null });

      const result = await updateActivityRecordAnalysis(recordId, analysisResult);

      expect(mockSupabase.from).toHaveBeenCalledWith('activity_records');
      expect(mockSupabase.update).toHaveBeenCalledWith({
        status: 'analyzed',
        user_assigned_issue_key: 'ATG-456',
        metadata: { confidenceScore: 0.95 },
        analyzed_at: expect.any(String),
        updated_at: expect.any(String),
        project_key: 'ATG'
      });
      expect(mockSupabase.eq).toHaveBeenCalledWith('id', recordId);
      expect(result).toEqual(updatedRecord);
    });

    it('should handle analysis result without taskKey', async () => {
      const analysisResult = { metadata: { workType: 'break' } };
      mockSupabase.select.mockResolvedValue({ data: [{ id: recordId }], error: null });

      await updateActivityRecordAnalysis(recordId, analysisResult);

      expect(mockSupabase.update).toHaveBeenCalledWith(
        expect.objectContaining({
          user_assigned_issue_key: null
        })
      );
    });

    it('should not override project_key when not provided in analysis', async () => {
      const analysisResult = { taskKey: 'ATG-789' };
      mockSupabase.select.mockResolvedValue({ data: [{ id: recordId }], error: null });

      await updateActivityRecordAnalysis(recordId, analysisResult);

      const updateCall = mockSupabase.update.mock.calls[0][0];
      expect(updateCall).not.toHaveProperty('project_key');
    });

    it('should return null when no data returned', async () => {
      mockSupabase.select.mockResolvedValue({ data: [], error: null });

      const result = await updateActivityRecordAnalysis(recordId, {});

      expect(result).toBeNull();
    });

    it('should throw on Supabase error', async () => {
      const dbError = new Error('Update failed');
      mockSupabase.select.mockResolvedValue({ data: null, error: dbError });

      await expect(updateActivityRecordAnalysis(recordId, {})).rejects.toThrow('Update failed');
    });

    it('should throw when Supabase client is not initialized', async () => {
      getClient.mockReturnValue(null);

      await expect(updateActivityRecordAnalysis(recordId, {})).rejects.toThrow('Supabase client not initialized');
    });
  });

  // ==========================================================================
  // markBatchAnalyzed
  // ==========================================================================
  describe('markBatchAnalyzed', () => {
    const recordIds = ['rec-1', 'rec-2'];

    it('should mark batch of records as analyzed', async () => {
      const updatedRecords = [
        { id: 'rec-1', status: 'analyzed' },
        { id: 'rec-2', status: 'analyzed' }
      ];
      mockSupabase.select.mockResolvedValue({ data: updatedRecords, error: null });

      const result = await markBatchAnalyzed(recordIds);

      expect(mockSupabase.from).toHaveBeenCalledWith('activity_records');
      expect(mockSupabase.update).toHaveBeenCalledWith({
        status: 'analyzed',
        analyzed_at: expect.any(String),
        updated_at: expect.any(String)
      });
      expect(mockSupabase.in).toHaveBeenCalledWith('id', recordIds);
      expect(result).toEqual(updatedRecords);
    });

    it('should return empty array when data is null', async () => {
      mockSupabase.select.mockResolvedValue({ data: null, error: null });

      const result = await markBatchAnalyzed(recordIds);

      expect(result).toEqual([]);
    });

    it('should throw on Supabase error', async () => {
      const dbError = new Error('Batch update failed');
      mockSupabase.select.mockResolvedValue({ data: null, error: dbError });

      await expect(markBatchAnalyzed(recordIds)).rejects.toThrow('Batch update failed');
    });

    it('should throw when Supabase client is not initialized', async () => {
      getClient.mockReturnValue(null);

      await expect(markBatchAnalyzed(recordIds)).rejects.toThrow('Supabase client not initialized');
    });
  });

  // ==========================================================================
  // markBatchFailed
  // ==========================================================================
  describe('markBatchFailed', () => {
    const recordIds = ['rec-1', 'rec-2'];
    const errorMessage = 'AI analysis failed';

    it('should increment retry_count and keep pending status when under limit', async () => {
      // Setup fresh mock for this test
      const selectMock = jest.fn();
      const updateMock = jest.fn();
      
      let selectCallCount = 0;
      let updateCallCount = 0;
      
      mockSupabase.from.mockImplementation(() => ({
        select: selectMock.mockImplementation(() => ({
          eq: jest.fn().mockImplementation(() => ({
            single: jest.fn().mockImplementation(() => {
              selectCallCount++;
              if (selectCallCount === 1) {
                return Promise.resolve({ data: { retry_count: 1, metadata: { existing: 'data' } } });
              }
              return Promise.resolve({ data: { retry_count: 0, metadata: null } });
            })
          }))
        })),
        update: updateMock.mockImplementation(() => ({
          eq: jest.fn().mockImplementation(() => {
            updateCallCount++;
            return Promise.resolve({ data: null, error: null });
          })
        }))
      }));

      await markBatchFailed(recordIds, errorMessage);

      // First record: retry_count 1 -> 2, stays pending
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          retry_count: 2,
          metadata: { existing: 'data', error: errorMessage }
        })
      );
    });

    it('should mark as failed when retry_count reaches 3', async () => {
      const updateMock = jest.fn();
      
      mockSupabase.from.mockImplementation(() => ({
        select: jest.fn().mockImplementation(() => ({
          eq: jest.fn().mockImplementation(() => ({
            single: jest.fn().mockResolvedValue({ data: { retry_count: 2, metadata: {} } })
          }))
        })),
        update: updateMock.mockImplementation(() => ({
          eq: jest.fn().mockResolvedValue({ data: null, error: null })
        }))
      }));

      await markBatchFailed(['rec-1'], errorMessage);

      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          retry_count: 3
        })
      );
    });

    it('should handle record with null metadata', async () => {
      const updateMock = jest.fn();
      
      mockSupabase.from.mockImplementation(() => ({
        select: jest.fn().mockImplementation(() => ({
          eq: jest.fn().mockImplementation(() => ({
            single: jest.fn().mockResolvedValue({ data: { retry_count: 0, metadata: null } })
          }))
        })),
        update: updateMock.mockImplementation(() => ({
          eq: jest.fn().mockResolvedValue({ data: null, error: null })
        }))
      }));

      await markBatchFailed(['rec-1'], errorMessage);

      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { error: errorMessage }
        })
      );
    });

    it('should handle missing record gracefully', async () => {
      const updateMock = jest.fn();
      
      mockSupabase.from.mockImplementation(() => ({
        select: jest.fn().mockImplementation(() => ({
          eq: jest.fn().mockImplementation(() => ({
            single: jest.fn().mockResolvedValue({ data: null })
          }))
        })),
        update: updateMock.mockImplementation(() => ({
          eq: jest.fn().mockResolvedValue({ data: null, error: null })
        }))
      }));

      await markBatchFailed(['rec-1'], errorMessage);

      // Should still attempt update with default values
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          retry_count: 1,
          status: 'pending'
        })
      );
    });

    it('should log error and continue on individual record failure', async () => {
      const dbError = new Error('Single record fetch failed');
      let callCount = 0;
      const updateMock = jest.fn();
      
      mockSupabase.from.mockImplementation(() => ({
        select: jest.fn().mockImplementation(() => ({
          eq: jest.fn().mockImplementation(() => ({
            single: jest.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.reject(dbError);
              }
              return Promise.resolve({ data: { retry_count: 0, metadata: {} } });
            })
          }))
        })),
        update: updateMock.mockImplementation(() => ({
          eq: jest.fn().mockResolvedValue({ data: null, error: null })
        }))
      }));

      await markBatchFailed(recordIds, errorMessage);

      expect(logger.error).toHaveBeenCalledWith(
        '[ActivityDB] Failed to mark record rec-1 as failed:',
        dbError
      );
      // Second record should still be processed
      expect(updateMock).toHaveBeenCalled();
    });

    it('should throw when Supabase client is not initialized', async () => {
      getClient.mockReturnValue(null);

      await expect(markBatchFailed(recordIds, errorMessage)).rejects.toThrow('Supabase client not initialized');
    });
  });

  // ==========================================================================
  // resetStuckProcessingRecords
  // ==========================================================================
  describe('resetStuckProcessingRecords', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-06-15T12:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should reset records stuck in processing with default threshold', async () => {
      const resetRecords = [
        { id: 'stuck-1', status: 'pending' },
        { id: 'stuck-2', status: 'pending' }
      ];
      mockSupabase.select.mockResolvedValue({ data: resetRecords, error: null });

      await resetStuckProcessingRecords();

      expect(mockSupabase.from).toHaveBeenCalledWith('activity_records');
      expect(mockSupabase.update).toHaveBeenCalledWith({
        status: 'pending',
        updated_at: expect.any(String)
      });
      expect(mockSupabase.eq).toHaveBeenCalledWith('status', 'processing');
      // 10 minutes threshold
      expect(mockSupabase.lt).toHaveBeenCalledWith('updated_at', '2024-06-15T11:50:00.000Z');
      expect(logger.info).toHaveBeenCalledWith('[ActivityDB] Reset 2 stuck processing records');
    });

    it('should use custom minutes threshold', async () => {
      mockSupabase.select.mockResolvedValue({ data: [], error: null });

      await resetStuckProcessingRecords(30);

      // 30 minutes threshold
      expect(mockSupabase.lt).toHaveBeenCalledWith('updated_at', '2024-06-15T11:30:00.000Z');
    });

    it('should not log when no records reset', async () => {
      mockSupabase.select.mockResolvedValue({ data: [], error: null });

      await resetStuckProcessingRecords();

      expect(logger.info).not.toHaveBeenCalled();
    });

    it('should not log when data is null', async () => {
      mockSupabase.select.mockResolvedValue({ data: null, error: null });

      await resetStuckProcessingRecords();

      expect(logger.info).not.toHaveBeenCalled();
    });

    it('should return silently when Supabase client is not initialized', async () => {
      getClient.mockReturnValue(null);

      await expect(resetStuckProcessingRecords()).resolves.toBeUndefined();
    });

    it('should log error on non-network failure', async () => {
      const dbError = new Error('Database query failed');
      mockSupabase.select.mockRejectedValue(dbError);
      isNetworkError.mockReturnValue(false);

      await resetStuckProcessingRecords();

      expect(logger.error).toHaveBeenCalledWith(
        '[ActivityDB] Error resetting stuck records:',
        dbError
      );
    });

    it('should not log error on network failure', async () => {
      const networkError = new Error('ETIMEDOUT');
      mockSupabase.select.mockRejectedValue(networkError);
      isNetworkError.mockReturnValue(true);

      await resetStuckProcessingRecords();

      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});

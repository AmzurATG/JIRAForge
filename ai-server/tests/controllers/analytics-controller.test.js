'use strict';

const analyticsController = require('../../src/controllers/analytics-controller');
const aggregationService = require('../../src/services/db/aggregation-service');
const logger = require('../../src/utils/logger');

jest.mock('../../src/services/db/aggregation-service');
jest.mock('../../src/utils/logger');

describe('Analytics Controller', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
  });

  describe('getDailyTotal', () => {
    test('returns 400 when required parameters are missing', async () => {
      req = { query: {} };
      
      await analyticsController.getDailyTotal(req, res);
      
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Missing required parameters: org_id, user_id, date'
        })
      );
    });
    
    test('returns daily total with formatted response', async () => {
      req = {
        query: {
          org_id: 'org-123',
          user_id: 'user-456',
          date: '2026-05-07',
          timezone: 'America/New_York'
        }
      };
      
      aggregationService.getDailyTotal.mockResolvedValue(7200); // 2 hours
      
      await analyticsController.getDailyTotal(req, res);
      
      expect(aggregationService.getDailyTotal).toHaveBeenCalledWith(
        'org-123',
        'user-456',
        '2026-05-07',
        'America/New_York'
      );
      
      expect(res.json).toHaveBeenCalledWith({
        date: '2026-05-07',
        total_seconds: 7200,
        hours: '2.00',
        timezone: 'America/New_York'
      });
    });
    
    test('defaults timezone to UTC when not provided', async () => {
      req = {
        query: {
          org_id: 'org-123',
          user_id: 'user-456',
          date: '2026-05-07'
        }
      };
      
      aggregationService.getDailyTotal.mockResolvedValue(3600);
      
      await analyticsController.getDailyTotal(req, res);
      
      expect(aggregationService.getDailyTotal).toHaveBeenCalledWith(
        'org-123',
        'user-456',
        '2026-05-07',
        'UTC'
      );
      
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          timezone: 'UTC'
        })
      );
    });
    
    test('returns 500 on service error', async () => {
      req = {
        query: {
          org_id: 'org-123',
          user_id: 'user-456',
          date: '2026-05-07'
        }
      };
      
      aggregationService.getDailyTotal.mockRejectedValue(new Error('Database error'));
      
      await analyticsController.getDailyTotal(req, res);
      
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('getWeeklyTotal', () => {
    test('returns 400 when required parameters are missing', async () => {
      req = { query: { org_id: 'org-123' } };
      
      await analyticsController.getWeeklyTotal(req, res);
      
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Missing required parameters: org_id, user_id, week_start'
        })
      );
    });
    
    test('returns weekly total with formatted response', async () => {
      req = {
        query: {
          org_id: 'org-123',
          user_id: 'user-456',
          week_start: '2026-05-05',
          timezone: 'UTC'
        }
      };
      
      aggregationService.getWeeklyTotal.mockResolvedValue(144000); // 40 hours
      
      await analyticsController.getWeeklyTotal(req, res);
      
      expect(aggregationService.getWeeklyTotal).toHaveBeenCalledWith(
        'org-123',
        'user-456',
        '2026-05-05',
        'UTC'
      );
      
      expect(res.json).toHaveBeenCalledWith({
        week_start: '2026-05-05',
        total_seconds: 144000,
        hours: '40.00',
        timezone: 'UTC'
      });
    });
    
    test('returns 500 on service error', async () => {
      req = {
        query: {
          org_id: 'org-123',
          user_id: 'user-456',
          week_start: '2026-05-05'
        }
      };
      
      aggregationService.getWeeklyTotal.mockRejectedValue(new Error('Database error'));
      
      await analyticsController.getWeeklyTotal(req, res);
      
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
      expect(logger.error).toHaveBeenCalled();
    });
  });
});

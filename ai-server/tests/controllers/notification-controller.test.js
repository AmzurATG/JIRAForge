/**
 * Notification Controller Unit Tests
 */

const request = require('supertest');
const express = require('express');
const notificationController = require('../../src/controllers/notification-controller');
const notificationService = require('../../src/services/notifications/notification-service');
const notificationPollingService = require('../../src/services/notifications/notification-polling');
const notificationDb = require('../../src/services/db/notification-db-service');
const logger = require('../../src/utils/logger');

// Mock all dependencies
jest.mock('../../src/services/notifications/notification-service');
jest.mock('../../src/services/notifications/notification-polling');
jest.mock('../../src/services/db/notification-db-service');
jest.mock('../../src/utils/logger');
jest.mock('../../src/services/db/supabase-client');

describe('Notification Controller', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create Express app for testing
    app = express();
    app.use(express.json());
    app.use('/api/notifications', notificationController);
  });

  describe('POST /api/notifications/send', () => {
    it('should send login reminder notification', async () => {
      const mockResult = { success: true, messageId: 'msg123' };
      notificationService.sendLoginReminder.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/notifications/send')
        .send({
          type: 'login_reminder',
          userId: 'user123',
          organizationId: 'org123',
          data: { firstName: 'John' }
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResult);
      expect(notificationService.sendLoginReminder).toHaveBeenCalledWith(
        'user123',
        'org123',
        { firstName: 'John' }
      );
    });

    it('should send download reminder notification', async () => {
      const mockResult = { success: true, messageId: 'msg124' };
      notificationService.sendDownloadReminder.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/notifications/send')
        .send({
          type: 'download_reminder',
          userId: 'user123',
          organizationId: 'org123',
          data: { platform: 'macOS' }
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResult);
      expect(notificationService.sendDownloadReminder).toHaveBeenCalledWith(
        'user123',
        'org123',
        'macOS'
      );
    });

    it('should use Windows as default platform for download reminder', async () => {
      const mockResult = { success: true, messageId: 'msg125' };
      notificationService.sendDownloadReminder.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/notifications/send')
        .send({
          type: 'download_reminder',
          userId: 'user123',
          organizationId: 'org123',
          data: {}
        });

      expect(response.status).toBe(200);
      expect(notificationService.sendDownloadReminder).toHaveBeenCalledWith(
        'user123',
        'org123',
        'Windows'
      );
    });

    it('should send new version notification', async () => {
      const mockResult = { success: true, messageId: 'msg126' };
      notificationService.sendNewVersionNotification.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/notifications/send')
        .send({
          type: 'new_version',
          userId: 'user123',
          organizationId: 'org123',
          data: { version: '2.0.0' }
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResult);
      expect(notificationService.sendNewVersionNotification).toHaveBeenCalledWith(
        'user123',
        'org123',
        { version: '2.0.0' }
      );
    });

    it('should send inactivity alert notification', async () => {
      const mockResult = { success: true, messageId: 'msg127' };
      notificationService.sendInactivityAlert.mockResolvedValue(mockResult);

      const response = await request(app)
        .post('/api/notifications/send')
        .send({
          type: 'inactivity_alert',
          userId: 'user123',
          organizationId: 'org123',
          data: { days: 7 }
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResult);
      expect(notificationService.sendInactivityAlert).toHaveBeenCalledWith(
        'user123',
        'org123',
        { days: 7 }
      );
    });

    it('should return 400 for missing type', async () => {
      const response = await request(app)
        .post('/api/notifications/send')
        .send({
          userId: 'user123',
          organizationId: 'org123'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Missing required fields');
    });

    it('should return 400 for missing userId', async () => {
      const response = await request(app)
        .post('/api/notifications/send')
        .send({
          type: 'login_reminder',
          organizationId: 'org123'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 for missing organizationId', async () => {
      const response = await request(app)
        .post('/api/notifications/send')
        .send({
          type: 'login_reminder',
          userId: 'user123'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 for unknown notification type', async () => {
      const response = await request(app)
        .post('/api/notifications/send')
        .send({
          type: 'unknown_type',
          userId: 'user123',
          organizationId: 'org123'
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Unknown notification type');
    });

    it('should handle service errors', async () => {
      notificationService.sendLoginReminder.mockRejectedValue(new Error('Service error'));

      const response = await request(app)
        .post('/api/notifications/send')
        .send({
          type: 'login_reminder',
          userId: 'user123',
          organizationId: 'org123'
        });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Service error');
    });
  });

  describe('GET /api/notifications/history/:userId', () => {
    it('should get notification history with default pagination', async () => {
      const mockHistory = [
        { id: 1, type: 'login_reminder', sent_at: '2023-01-01' },
        { id: 2, type: 'download_reminder', sent_at: '2023-01-02' }
      ];
      notificationDb.getUserNotificationHistory.mockResolvedValue(mockHistory);

      const response = await request(app)
        .get('/api/notifications/history/user123');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockHistory);
      expect(response.body.pagination).toEqual({
        limit: 50,
        offset: 0,
        hasMore: false
      });
      expect(notificationDb.getUserNotificationHistory).toHaveBeenCalledWith(
        'user123',
        50,
        0,
        null
      );
    });

    it('should get notification history with custom pagination', async () => {
      const mockHistory = Array(10).fill({ type: 'login_reminder' });
      notificationDb.getUserNotificationHistory.mockResolvedValue(mockHistory);

      const response = await request(app)
        .get('/api/notifications/history/user123')
        .query({ limit: 10, offset: 20 });

      expect(response.status).toBe(200);
      expect(response.body.pagination).toEqual({
        limit: 10,
        offset: 20,
        hasMore: true
      });
      expect(notificationDb.getUserNotificationHistory).toHaveBeenCalledWith(
        'user123',
        10,
        20,
        null
      );
    });

    it('should correctly parse string limit and offset using Number.parseInt', async () => {
      // Query string values come as strings, this tests Number.parseInt conversion
      const mockHistory = [{ id: 1, type: 'test' }];
      notificationDb.getUserNotificationHistory.mockResolvedValue(mockHistory);

      const response = await request(app)
        .get('/api/notifications/history/user123')
        .query({ limit: '25', offset: '5' });

      expect(response.status).toBe(200);
      expect(response.body.pagination).toEqual({
        limit: 25,
        offset: 5,
        hasMore: false
      });
      // Verify Number.parseInt converted strings to numbers
      expect(notificationDb.getUserNotificationHistory).toHaveBeenCalledWith(
        'user123',
        25,
        5,
        null
      );
    });

    it('should filter by notification type', async () => {
      const mockHistory = [{ id: 1, type: 'login_reminder' }];
      notificationDb.getUserNotificationHistory.mockResolvedValue(mockHistory);

      const response = await request(app)
        .get('/api/notifications/history/user123')
        .query({ type: 'login_reminder' });

      expect(response.status).toBe(200);
      expect(notificationDb.getUserNotificationHistory).toHaveBeenCalledWith(
        'user123',
        50,
        0,
        'login_reminder'
      );
    });

    it('should handle database errors', async () => {
      notificationDb.getUserNotificationHistory.mockRejectedValue(new Error('DB error'));

      const response = await request(app)
        .get('/api/notifications/history/user123');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/notifications/stats/:organizationId', () => {
    it('should get organization stats without date range', async () => {
      const mockStats = {
        total_sent: 100,
        total_failed: 5,
        by_type: { login_reminder: 50, download_reminder: 50 }
      };
      notificationDb.getOrganizationStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .get('/api/notifications/stats/org123');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockStats);
      expect(notificationDb.getOrganizationStats).toHaveBeenCalledWith(
        'org123',
        null,
        null
      );
    });

    it('should get organization stats with date range', async () => {
      const mockStats = { total_sent: 50 };
      notificationDb.getOrganizationStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .get('/api/notifications/stats/org123')
        .query({ startDate: '2023-01-01', endDate: '2023-01-31' });

      expect(response.status).toBe(200);
      expect(notificationDb.getOrganizationStats).toHaveBeenCalledWith(
        'org123',
        '2023-01-01',
        '2023-01-31'
      );
    });

    it('should handle errors', async () => {
      notificationDb.getOrganizationStats.mockRejectedValue(new Error('Stats error'));

      const response = await request(app)
        .get('/api/notifications/stats/org123');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/notifications/preferences/:userId', () => {
    it('should get user preferences', async () => {
      const mockPrefs = {
        email_enabled: true,
        login_reminder_enabled: true,
        work_hours_start: '09:00:00',
        work_hours_end: '18:00:00'
      };
      notificationDb.getUserPreferences.mockResolvedValue(mockPrefs);

      const response = await request(app)
        .get('/api/notifications/preferences/user123');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockPrefs);
    });

    it('should return default preferences if none exist', async () => {
      notificationDb.getUserPreferences.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/notifications/preferences/user123');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('email_enabled', true);
      expect(response.body.data).toHaveProperty('work_hours_start', '09:00:00');
    });

    it('should handle errors', async () => {
      notificationDb.getUserPreferences.mockRejectedValue(new Error('Prefs error'));

      const response = await request(app)
        .get('/api/notifications/preferences/user123');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });

  describe('PUT /api/notifications/preferences/:userId', () => {
    it('should update user preferences', async () => {
      const { getClient } = require('../../src/services/db/supabase-client');
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        upsert: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: { user_id: 'user123', email_enabled: false },
          error: null
        })
      };
      getClient.mockReturnValue(mockSupabase);

      const response = await request(app)
        .put('/api/notifications/preferences/user123')
        .send({ email_enabled: false });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockSupabase.from).toHaveBeenCalledWith('notification_preferences');
    });

    it('should return 503 if database not available', async () => {
      const { getClient } = require('../../src/services/db/supabase-client');
      getClient.mockReturnValue(null);

      const response = await request(app)
        .put('/api/notifications/preferences/user123')
        .send({ email_enabled: false });

      expect(response.status).toBe(503);
      expect(response.body.error).toContain('Database not available');
    });

    it('should handle database errors', async () => {
      const { getClient } = require('../../src/services/db/supabase-client');
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        upsert: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({
          data: null,
          error: new Error('Update failed')
        })
      };
      getClient.mockReturnValue(mockSupabase);

      const response = await request(app)
        .put('/api/notifications/preferences/user123')
        .send({ email_enabled: false });

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/notifications/polling/status', () => {
    it('should get polling service status', async () => {
      const mockStatus = {
        isRunning: true,
        lastCheckTime: '2023-01-01T10:00:00Z',
        stats: { total: 100 }
      };
      notificationPollingService.getStatus.mockReturnValue(mockStatus);

      const response = await request(app)
        .get('/api/notifications/polling/status');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockStatus);
    });
  });

  describe('POST /api/notifications/polling/start', () => {
    it('should start polling service', async () => {
      notificationPollingService.start.mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/notifications/polling/start');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('started');
      expect(notificationPollingService.start).toHaveBeenCalled();
    });

    it('should handle start errors', async () => {
      notificationPollingService.start.mockImplementation(() => {
        throw new Error('Start failed');
      });

      const response = await request(app)
        .post('/api/notifications/polling/start');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/notifications/polling/stop', () => {
    it('should stop polling service', async () => {
      notificationPollingService.stop.mockReturnValue(undefined);

      const response = await request(app)
        .post('/api/notifications/polling/stop');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('stopped');
      expect(notificationPollingService.stop).toHaveBeenCalled();
    });

    it('should handle stop errors', async () => {
      notificationPollingService.stop.mockImplementation(() => {
        throw new Error('Stop failed');
      });

      const response = await request(app)
        .post('/api/notifications/polling/stop');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/notifications/polling/run', () => {
    it('should run all checks when no type specified', async () => {
      notificationPollingService.runAllChecks.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/notifications/polling/run')
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('All checks completed');
      expect(notificationPollingService.runAllChecks).toHaveBeenCalled();
    });

    it('should run single check when type specified', async () => {
      notificationPollingService.runSingleCheck.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/notifications/polling/run')
        .send({ type: 'login_reminder' });

      expect(response.status).toBe(200);
      expect(response.body.message).toContain('login_reminder check completed');
      expect(notificationPollingService.runSingleCheck).toHaveBeenCalledWith('login_reminder');
    });

    it('should handle run errors', async () => {
      notificationPollingService.runAllChecks.mockRejectedValue(new Error('Run failed'));

      const response = await request(app)
        .post('/api/notifications/polling/run')
        .send({});

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });

  describe('DELETE /api/notifications/cooldowns/:userId', () => {
    it('should clear all cooldowns for user', async () => {
      const { getClient } = require('../../src/services/db/supabase-client');
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        delete: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValue({ error: null })
      };
      getClient.mockReturnValue(mockSupabase);

      const response = await request(app)
        .delete('/api/notifications/cooldowns/user123');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('All cooldowns cleared');
      expect(mockSupabase.eq).toHaveBeenCalledWith('user_id', 'user123');
    });

    it('should clear specific cooldown type', async () => {
      const { getClient } = require('../../src/services/db/supabase-client');
      // Both eq() calls return this (chain). Make the object thenable so `await query` works.
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        delete: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        then: (resolve) => resolve({ error: null })
      };
      getClient.mockReturnValue(mockSupabase);

      const response = await request(app)
        .delete('/api/notifications/cooldowns/user123')
        .query({ type: 'login_reminder' });

      expect(response.status).toBe(200);
      expect(response.body.message).toContain('login_reminder cooldown cleared');
    });

    it('should return 503 if database not available', async () => {
      const { getClient } = require('../../src/services/db/supabase-client');
      getClient.mockReturnValue(null);

      const response = await request(app)
        .delete('/api/notifications/cooldowns/user123');

      expect(response.status).toBe(503);
      expect(response.body.error).toContain('Database not available');
    });

    it('should handle database errors', async () => {
      const { getClient } = require('../../src/services/db/supabase-client');
      const mockSupabase = {
        from: jest.fn().mockReturnThis(),
        delete: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValue({ error: new Error('Delete failed') })
      };
      getClient.mockReturnValue(mockSupabase);

      const response = await request(app)
        .delete('/api/notifications/cooldowns/user123');

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });
});

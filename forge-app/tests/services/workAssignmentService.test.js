/**
 * Unit tests for workAssignmentService.js
 * Tests shared work assignment logic used across idle, unassigned, and timeline conversions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as workAssignmentService from '../../src/services/workAssignmentService.js';

// Mock dependencies
vi.mock('@forge/api', () => ({
  default: {
    asUser: () => ({
      requestJira: vi.fn()
    })
  },
  route: (strings) => strings.join('')
}));

vi.mock('../../src/services/settingsService.js', () => ({
  getTrackingSettings: vi.fn()
}));

vi.mock('../../src/utils/supabase.js', () => ({
  supabaseRequest: vi.fn()
}));

vi.mock('../../src/utils/formatters.js', () => ({
  formatDuration: (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
}));

vi.mock('../../src/utils/validators.js', () => ({
  sanitizeUUIDArray: (arr) => arr.filter(item => typeof item === 'string' && item.length > 0),
  isValidUUID: (val) => typeof val === 'string' && val.length > 0
}));

describe('workAssignmentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createWorklogIfNeeded', () => {
    it('should skip worklog when auto-sync is enabled', async () => {
      const result = await workAssignmentService.createWorklogIfNeeded({
        issueKey: 'PROJ-123',
        timeToLog: 3600,
        sessionCount: 2,
        autoSyncEnabled: true
      });

      expect(result.worklogSkipped).toBe(true);
      expect(result.worklogSkippedReason).toContain('auto-sync');
    });

    it('should skip worklog when time to log is zero or negative', async () => {
      const result = await workAssignmentService.createWorklogIfNeeded({
        issueKey: 'PROJ-123',
        timeToLog: 0,
        sessionCount: 1,
        autoSyncEnabled: false
      });

      expect(result.worklogSkipped).toBe(true);
      expect(result.worklogSkippedReason).toContain('no time');
    });

    it('should defer sub-minute worklogs (< 60 seconds)', async () => {
      const result = await workAssignmentService.createWorklogIfNeeded({
        issueKey: 'PROJ-123',
        timeToLog: 45,
        sessionCount: 1,
        autoSyncEnabled: false
      });

      expect(result.worklogSkipped).toBe(true);
      expect(result.worklogSkippedReason).toContain('under');
      expect(result.worklogSkippedReason).toContain('60s');
    });

    it('should attempt to create worklog for >= 60 second times', async () => {
      const mockApiResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'wl-123' })
      };

      const api = await import('@forge/api');
      api.default.asUser().requestJira.mockResolvedValue(mockApiResponse);

      const result = await workAssignmentService.createWorklogIfNeeded({
        issueKey: 'PROJ-123',
        timeToLog: 3600,
        sessionCount: 2,
        autoSyncEnabled: false,
        customComment: 'Test comment'
      });

      expect(result.worklogSkipped).toBe(false);
      expect(result.worklog).toBeDefined();
      expect(result.worklog.id).toBe('wl-123');
    });
  });

  describe('updateActivityRecordsWithIssueAssignment', () => {
    it('should return 0 when no session IDs provided', async () => {
      const result = await workAssignmentService.updateActivityRecordsWithIssueAssignment(
        {},
        [],
        'PROJ-123',
        'user-123'
      );

      expect(result).toBe(0);
    });

    it('should update activity records with issue key', async () => {
      const { supabaseRequest } = await import('../../src/utils/supabase.js');
      supabaseRequest.mockResolvedValue([
        { id: 'ar-1', user_assigned_issue_key: 'PROJ-123' },
        { id: 'ar-2', user_assigned_issue_key: 'PROJ-123' }
      ]);

      const result = await workAssignmentService.updateActivityRecordsWithIssueAssignment(
        { url: 'test' },
        ['ar-1', 'ar-2'],
        'PROJ-123',
        'user-123'
      );

      expect(result).toBe(2);
    });
  });

  describe('removeConvertedSessionsFromGroups', () => {
    it('should return empty result when no sessions provided', async () => {
      const result = await workAssignmentService.removeConvertedSessionsFromGroups(
        {},
        [],
        'user-123'
      );

      expect(result.removedCount).toBe(0);
      expect(result.updatedGroupIds).toHaveLength(0);
    });

    it('should remove sessions from group and recalculate aggregates', async () => {
      const { supabaseRequest } = await import('../../src/utils/supabase.js');

      // Mock group members query
      supabaseRequest.mockResolvedValueOnce([
        { id: 'gm-1', group_id: 'group-123' },
        { id: 'gm-2', group_id: 'group-123' }
      ]);

      // Mock remaining members count
      supabaseRequest.mockResolvedValueOnce([
        { id: 'gm-3' },
        { id: 'gm-4' }
      ]);

      // Mock remaining activity records
      supabaseRequest.mockResolvedValueOnce([
        { activity_record_id: 'ar-3' },
        { activity_record_id: 'ar-4' }
      ]);

      // Mock activity record lookup
      supabaseRequest.mockResolvedValueOnce([
        { duration_seconds: 600 },
        { duration_seconds: 1200 }
      ]);

      const result = await workAssignmentService.removeConvertedSessionsFromGroups(
        { url: 'test' },
        ['ar-1', 'ar-2'],
        'user-123'
      );

      expect(result.removedCount).toBe(2);
      expect(result.updatedGroupIds).toContain('group-123');
    });

    it('should mark group as assigned when no members remain', async () => {
      const { supabaseRequest } = await import('../../src/utils/supabase.js');

      // Mock group members query
      supabaseRequest.mockResolvedValueOnce([
        { id: 'gm-1', group_id: 'group-123' }
      ]);

      // Mock remaining members count (empty)
      supabaseRequest.mockResolvedValueOnce([]);

      const result = await workAssignmentService.removeConvertedSessionsFromGroups(
        { url: 'test' },
        ['ar-1'],
        'user-123'
      );

      expect(result.removedCount).toBe(1);
      expect(result.updatedGroupIds).toContain('group-123');
    });
  });

  describe('isAutoSyncEnabled', () => {
    it('should return tracking settings auto-sync status', async () => {
      const { getTrackingSettings } = await import('../../src/services/settingsService.js');
      getTrackingSettings.mockResolvedValue({ jiraWorklogSyncEnabled: true });

      const result = await workAssignmentService.isAutoSyncEnabled('account-id', 'cloud-id');

      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      const { getTrackingSettings } = await import('../../src/services/settingsService.js');
      getTrackingSettings.mockRejectedValue(new Error('Settings error'));

      const result = await workAssignmentService.isAutoSyncEnabled('account-id', 'cloud-id');

      expect(result).toBe(false);
    });
  });
});

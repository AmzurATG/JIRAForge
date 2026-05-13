'use strict';

/**
 * Integration Test: Unassigned Work Cache Staleness
 * 
 * Tests the fix for the bug where unassigned work sessions don't appear
 * for some users due to cache staleness after organization recreation.
 * 
 * Scenario: Organization is deleted and recreated with the same cloudId.
 * Expected: User should still see their unassigned work after recreation.
 */

const { getOrCreateOrganization, getOrCreateUser } = require('../../src/utils/remote.js');

// Mock the Forge API
jest.mock('@forge/api', () => ({
  invokeRemote: jest.fn(),
  default: {
    asApp: jest.fn(() => ({
      requestJira: jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          baseUrl: 'https://test.atlassian.net',
          serverTitle: 'Test Org'
        })
      })
    }))
  },
  route: (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), ''),
}));

const forgeApi = require('@forge/api');
const { invokeRemote } = forgeApi;

describe('Unassigned Work - Organization Recreation Scenario', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch fresh organization ID after recreation', async () => {
    // Simulate AI server responses
    invokeRemote
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          success: true,
          data: { id: 'org-uuid-1', jira_cloud_id: 'cloud-123' }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          success: true,
          data: { id: 'org-uuid-2', jira_cloud_id: 'cloud-123' }  // Same cloudId, new UUID
        })
      });

    // First request: Original organization
    const org1 = await getOrCreateOrganization('cloud-123');
    expect(org1.id).toBe('org-uuid-1');
    expect(invokeRemote).toHaveBeenCalledTimes(1);

    // Second request: Organization recreated (same cloudId, new UUID)
    const org2 = await getOrCreateOrganization('cloud-123');
    expect(org2.id).toBe('org-uuid-2');  // Different UUID
    expect(invokeRemote).toHaveBeenCalledTimes(2);  // Fetched fresh, not cached
  });

  it('should fetch fresh user ID when organization changes', async () => {
    invokeRemote
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          success: true,
          data: { userId: 'user-uuid-1' }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          success: true,
          data: { userId: 'user-uuid-2' }  // Different user ID for new org
        })
      });

    // First request: Original organization
    const userId1 = await getOrCreateUser('acc-123', 'org-uuid-1');
    expect(userId1).toBe('user-uuid-1');
    expect(invokeRemote).toHaveBeenCalledTimes(1);

    // Second request: New organization (recreated)
    const userId2 = await getOrCreateUser('acc-123', 'org-uuid-2');
    expect(userId2).toBe('user-uuid-2');  // Different user ID
    expect(invokeRemote).toHaveBeenCalledTimes(2);  // Fetched fresh
  });

  it('should not cache across multiple calls', async () => {
    invokeRemote.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        success: true,
        data: { userId: 'user-uuid' }
      })
    });

    // Make 3 consecutive calls
    await getOrCreateUser('acc-123', 'org-uuid');
    await getOrCreateUser('acc-123', 'org-uuid');
    await getOrCreateUser('acc-123', 'org-uuid');

    // All 3 should hit the remote API
    expect(invokeRemote).toHaveBeenCalledTimes(3);
  });
});

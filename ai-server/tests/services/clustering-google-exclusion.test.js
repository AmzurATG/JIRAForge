'use strict';

/**
 * Google (non-Jira) users must be excluded from unassigned-work clustering.
 *
 * Clustering only prepares Jira worklogs (suggests Jira issues, filters to Jira's
 * 60s minimum, surfaced in the in-Jira Forge UI), so it is meaningless for Google
 * SSO users and would burn LLM tokens nightly. Two layers enforce this:
 *   1. getUsersWithUnassignedWork() bulk-filters Google users out of the loop.
 *   2. processUserUnassignedWork() guards per-user (covers the single-user
 *      /api/trigger-clustering path that bypasses the entry-point list).
 * Both fail OPEN: a provider-lookup error must never skip a real Jira user.
 */

// --- Mocks (declared before requires, per repo convention) ------------------
jest.mock('../../src/services/supabase-service', () => ({
  getUnassignedActivities: jest.fn(),
  getUserActiveIssues: jest.fn(),
}));

jest.mock('../../src/services/db', () => ({
  getUserById: jest.fn(),
}));

jest.mock('../../src/services/clustering-service', () => ({
  clusterUnassignedWork: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const supabaseService = require('../../src/services/supabase-service');
const dbService = require('../../src/services/db');
const clusteringService = require('../../src/services/clustering-service');
const { processUserUnassignedWork } = require('../../src/services/clustering-polling-service');

describe('processUserUnassignedWork — Google user exclusion (per-user guard)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('skips a google user BEFORE fetching any sessions (no clustering work done)', async () => {
    dbService.getUserById.mockResolvedValue({ id: 'g-1', auth_provider: 'google' });

    await processUserUnassignedWork('g-1', 'org-1');

    // Guard returns before touching sessions / issues / the LLM.
    expect(dbService.getUserById).toHaveBeenCalledWith('g-1');
    expect(supabaseService.getUnassignedActivities).not.toHaveBeenCalled();
    expect(supabaseService.getUserActiveIssues).not.toHaveBeenCalled();
    expect(clusteringService.clusterUnassignedWork).not.toHaveBeenCalled();
  });

  test('proceeds for an atlassian user (fetches sessions)', async () => {
    dbService.getUserById.mockResolvedValue({ id: 'a-1', auth_provider: 'atlassian' });
    supabaseService.getUnassignedActivities.mockResolvedValue([]); // <2 sessions → stops after fetch

    await processUserUnassignedWork('a-1', 'org-1');

    // Did NOT skip at the guard — it went on to fetch this user's sessions.
    expect(supabaseService.getUnassignedActivities).toHaveBeenCalledWith('a-1', 'org-1');
  });

  test('fails OPEN: when getUserById throws, clustering still proceeds (no real Jira user is skipped)', async () => {
    dbService.getUserById.mockRejectedValue(new Error('db down'));
    supabaseService.getUnassignedActivities.mockResolvedValue([]);

    await processUserUnassignedWork('x-1', 'org-1');

    expect(supabaseService.getUnassignedActivities).toHaveBeenCalledWith('x-1', 'org-1');
  });

  test('proceeds when getUserById returns null (unknown user → fail open)', async () => {
    dbService.getUserById.mockResolvedValue(null);
    supabaseService.getUnassignedActivities.mockResolvedValue([]);

    await processUserUnassignedWork('u-1', 'org-1');

    expect(supabaseService.getUnassignedActivities).toHaveBeenCalledWith('u-1', 'org-1');
  });
});

'use strict';

jest.mock('axios', () => ({
  post: jest.fn()
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../src/services/db/description-quality-notifications-repo', () => ({
  listPendingDesktopNudges: jest.fn(),
  acknowledgeNudges: jest.fn(),
  getIssueScoresFromCache: jest.fn(),
  listLowScoreCandidates: jest.fn(),
  insertNotification: jest.fn(),
  isWithinCooldown: jest.fn(),
  ensurePreferenceRow: jest.fn(),
  hasRecentUnassignedWork: jest.fn()
}));

jest.mock('../../src/services/db/user-db-service', () => ({
  getUserById: jest.fn(),
  getOrganizationById: jest.fn(),
  getUserAtlassianAccountId: jest.fn(),
  getUserCachedIssues: jest.fn()
}));

jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: jest.fn(() => ({}))
}));

jest.mock('../../src/services/description-service', () => ({
  analyzeDescription: jest.fn()
}));

const repo = require('../../src/services/db/description-quality-notifications-repo');
const userDb = require('../../src/services/db/user-db-service');
const descriptionService = require('../../src/services/description-service');
const supabaseClient = require('../../src/services/db/supabase-client');
const axios = require('axios');
const router = require('../../src/controllers/desktop-dq-nudges-controller');

const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use(express.json());
  // Stub authentication — set a supabase user on every request.
  app.use((req, _res, next) => {
    req.supabaseUser = { sub: 'user-uuid-1' };
    next();
  });
  app.use('/api/desktop/description-quality-nudges', router);
  return app;
}

function buildAppWithJwtAtlassianClaim() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.supabaseUser = { atlassian_account_id: 'acct-123' };
    next();
  });
  app.use('/api/desktop/description-quality-nudges', router);
  return app;
}

function buildAtlassianApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.supabaseUser = { sub: 'user-uuid-1' };
    req.atlassianToken = 'atl-token-123';
    next();
  });
  app.use('/api/desktop/description-quality-nudges', router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  repo.listPendingDesktopNudges.mockResolvedValue([]);
  repo.isWithinCooldown.mockResolvedValue(false);
  repo.hasRecentUnassignedWork.mockResolvedValue(true);
  repo.getIssueScoresFromCache.mockResolvedValue(new Map());
  userDb.getUserById.mockResolvedValue({
    id: 'user-uuid-1',
    organization_id: 'org-uuid-1',
    atlassian_account_id: 'acct-123'
  });
  userDb.getOrganizationById.mockResolvedValue({
    id: 'org-uuid-1',
    jira_cloud_id: 'cloud-xyz',
    jira_instance_url: 'https://example.atlassian.net'
  });
  userDb.getUserCachedIssues.mockResolvedValue([
    { issue_key: 'PROJ-1', issue_summary: 'Issue one', description: 'Desc one', project_key: 'PROJ' },
    { issue_key: 'PROJ-2', issue_summary: 'Issue two', description: 'Desc two', project_key: 'PROJ' }
  ]);
  descriptionService.analyzeDescription.mockResolvedValue({ score: 55 });
});

describe('GET /api/desktop/description-quality-nudges', () => {
  test('returns mapped pending nudges', async () => {
    repo.listPendingDesktopNudges.mockResolvedValue([
      {
        id: 7,
        issue_key: 'PROJ-7',
        score_at_notify: 42,
        payload: {
          summary: 'Fix login',
          issueUrl: 'https://example.atlassian.net/browse/PROJ-7',
          appUrl: 'https://example.atlassian.net/jira/apps/x'
        },
        notified_at: '2026-06-05T12:00:00Z'
      }
    ]);
    const res = await request(buildApp()).get('/api/desktop/description-quality-nudges');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nudges).toHaveLength(1);
    expect(res.body.nudges[0]).toEqual({
      id: 7,
      issueKey: 'PROJ-7',
      score: 42,
      summary: 'Fix login',
      issueUrl: 'https://example.atlassian.net/browse/PROJ-7',
      appUrl: 'https://example.atlassian.net/jira/apps/x',
      notifiedAt: '2026-06-05T12:00:00Z'
    });
    expect(repo.listPendingDesktopNudges).toHaveBeenCalledWith({
      orgId: 'cloud-xyz',
      accountId: 'acct-123',
      limit: 5
    });
  });

  test('returns 404 when user cannot be resolved', async () => {
    userDb.getUserById.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/desktop/description-quality-nudges');
    expect(res.status).toBe(404);
  });

  test('returns 500 on repo failure', async () => {
    repo.listPendingDesktopNudges.mockRejectedValue(new Error('db down'));
    const res = await request(buildApp()).get('/api/desktop/description-quality-nudges');
    expect(res.status).toBe(500);
  });

  test('supports JWT fast path using atlassian_account_id claim', async () => {
    supabaseClient.getClient.mockReturnValue({
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'user-uuid-1',
                organization_id: 'org-uuid-1',
                atlassian_account_id: 'acct-123'
              },
              error: null
            })
          })
        })
      })
    });
    repo.listPendingDesktopNudges.mockResolvedValue([]);
    const res = await request(buildAppWithJwtAtlassianClaim()).get('/api/desktop/description-quality-nudges');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, nudges: [] });
  });

  test('falls back to sub-based caller resolution when fast path throws', async () => {
    supabaseClient.getClient.mockImplementation(() => {
      throw new Error('getClient is not defined');
    });
    repo.listPendingDesktopNudges.mockResolvedValue([]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.supabaseUser = { sub: 'user-uuid-1', atlassian_account_id: 'acct-123' };
      next();
    });
    app.use('/api/desktop/description-quality-nudges', router);

    const res = await request(app).get('/api/desktop/description-quality-nudges');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, nudges: [] });
  });

  test('prefers live cache score over score_at_notify in response', async () => {
    repo.listPendingDesktopNudges.mockResolvedValue([
      {
        id: 12,
        issue_key: 'PROJ-12',
        score_at_notify: 5,
        payload: { summary: 'Improve docs' },
        notified_at: '2026-06-05T12:00:00Z'
      }
    ]);
    repo.getIssueScoresFromCache.mockResolvedValue(new Map([['PROJ-12', 77]]));

    const res = await request(buildApp()).get('/api/desktop/description-quality-nudges');
    expect(res.status).toBe(200);
    expect(res.body.nudges).toHaveLength(1);
    expect(res.body.nudges[0].score).toBe(77);
  });

  test('filters stale rows when live score is >= 80 and auto-acks them', async () => {
    repo.listPendingDesktopNudges.mockResolvedValue([
      {
        id: 21,
        issue_key: 'PROJ-21',
        score_at_notify: 0,
        payload: { summary: 'Old low score' },
        notified_at: '2026-06-05T12:00:00Z'
      }
    ]);
    repo.getIssueScoresFromCache.mockResolvedValue(new Map([['PROJ-21', 100]]));
    repo.acknowledgeNudges.mockResolvedValue(1);

    const res = await request(buildApp()).get('/api/desktop/description-quality-nudges');
    expect(res.status).toBe(200);
    expect(res.body.nudges).toEqual([]);
    expect(repo.acknowledgeNudges).toHaveBeenCalledWith({
      orgId: 'cloud-xyz',
      accountId: 'acct-123',
      nudgeIds: [21],
      action: 'dismissed',
      snoozeUntil: null
    });
  });

  test('uses live Jira issues for Atlassian-authenticated requests and inserts missing rows', async () => {
    axios.post.mockResolvedValue({
      data: {
        issues: [
          {
            key: 'PROJ-92',
            fields: {
              summary: 'Fresh bad issue',
              description: 'short desc',
              issuetype: { name: 'Bug' },
              project: { key: 'PROJ' }
            }
          }
        ]
      }
    });
    descriptionService.analyzeDescription.mockResolvedValue({ score: 15 });
    repo.insertNotification.mockResolvedValue({
      id: 92,
      issue_key: 'PROJ-92',
      score_at_notify: 15,
      payload: { summary: 'Fresh bad issue', issueUrl: 'https://example.atlassian.net/browse/PROJ-92', appUrl: null },
      notified_at: '2026-06-09T10:00:00Z'
    });

    const res = await request(buildAtlassianApp()).get('/api/desktop/description-quality-nudges');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nudges).toHaveLength(1);
    expect(res.body.nudges[0]).toEqual({
      id: 92,
      issueKey: 'PROJ-92',
      score: 15,
      summary: 'Fresh bad issue',
      issueUrl: 'https://example.atlassian.net/browse/PROJ-92',
      appUrl: null,
      notifiedAt: '2026-06-09T10:00:00Z'
    });
    expect(axios.post).toHaveBeenCalled();
    expect(repo.insertNotification).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'cloud-xyz',
      accountId: 'acct-123',
      issueKey: 'PROJ-92',
      scoreAtNotify: 15,
      channel: 'desktop'
    }));
  });
});

describe('POST /api/desktop/description-quality-nudges/ack', () => {
  test('rejects empty nudgeIds', async () => {
    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/ack')
      .send({ nudgeIds: [], action: 'viewed' });
    expect(res.status).toBe(400);
  });

  test('rejects unknown action', async () => {
    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/ack')
      .send({ nudgeIds: [1], action: 'frobnicate' });
    expect(res.status).toBe(400);
  });

  test('rejects snoozed without snoozeUntil', async () => {
    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/ack')
      .send({ nudgeIds: [1], action: 'snoozed' });
    expect(res.status).toBe(400);
  });

  test('rejects past snoozeUntil', async () => {
    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/ack')
      .send({ nudgeIds: [1], action: 'snoozed', snoozeUntil: '2000-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
  });

  test('rejects non-integer ids', async () => {
    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/ack')
      .send({ nudgeIds: ['a'], action: 'viewed' });
    expect(res.status).toBe(400);
  });

  test('acknowledges and forwards to repo with caller scoping', async () => {
    repo.acknowledgeNudges.mockResolvedValue(2);
    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/ack')
      .send({ nudgeIds: [1, 2], action: 'dismissed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, acknowledged: 2 });
    expect(repo.acknowledgeNudges).toHaveBeenCalledWith({
      orgId: 'cloud-xyz',
      accountId: 'acct-123',
      nudgeIds: [1, 2],
      action: 'dismissed',
      snoozeUntil: null
    });
  });

  test('forwards snoozeUntil for snooze action', async () => {
    repo.acknowledgeNudges.mockResolvedValue(1);
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/ack')
      .send({ nudgeIds: [9], action: 'snoozed', snoozeUntil: future });
    expect(res.status).toBe(200);
    expect(repo.acknowledgeNudges).toHaveBeenCalledWith(expect.objectContaining({
      snoozeUntil: future, action: 'snoozed'
    }));
  });
});

describe('POST /api/desktop/description-quality-nudges/sync-recent-unassigned', () => {
  test('returns no-recent-unassigned when user has no work in the window', async () => {
    repo.hasRecentUnassignedWork.mockResolvedValue(false);

    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/sync-recent-unassigned')
      .send({ windowMinutes: 30, limit: 5, force: false });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.generated).toBe(0);
    expect(res.body.nudges).toEqual([]);
    expect(res.body.reason).toBe('no-recent-unassigned');
    expect(repo.hasRecentUnassignedWork).toHaveBeenCalledWith({
      userId: 'user-uuid-1',
      organizationId: 'org-uuid-1',
      windowMinutes: 30
    });
    expect(descriptionService.analyzeDescription).not.toHaveBeenCalled();
  });

  test('generates nudges when recent unassigned work exists and scores are low', async () => {
    repo.hasRecentUnassignedWork.mockResolvedValue(true);
    descriptionService.analyzeDescription.mockResolvedValue({ score: 35 });
    repo.insertNotification.mockResolvedValue({
      id: 77,
      issue_key: 'PROJ-1',
      score_at_notify: 35,
      payload: { summary: 'Issue one' },
      notified_at: '2026-06-10T10:00:00Z'
    });

    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/sync-recent-unassigned')
      .send({ windowMinutes: 30, limit: 2, force: false });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.generated).toBeGreaterThan(0);
    expect(Array.isArray(res.body.nudges)).toBe(true);
    expect(repo.insertNotification).toHaveBeenCalled();
  });

  test('respects cooldown unless force=true', async () => {
    repo.hasRecentUnassignedWork.mockResolvedValue(true);
    descriptionService.analyzeDescription.mockResolvedValue({ score: 20 });
    repo.isWithinCooldown.mockResolvedValue(true);

    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/sync-recent-unassigned')
      .send({ windowMinutes: 30, limit: 5, force: false });

    expect(res.status).toBe(200);
    expect(res.body.generated).toBe(0);
    expect(res.body.skippedCooldown).toBeGreaterThan(0);
    expect(repo.insertNotification).not.toHaveBeenCalled();
  });
});

describe('POST /api/desktop/description-quality-nudges/trigger', () => {
  test('generates desktop rows from low-score assigned issues', async () => {
    repo.getIssueScoresFromCache.mockResolvedValue(new Map());
    descriptionService.analyzeDescription.mockImplementation(async ({ issueKey }) => {
      if (issueKey === 'PROJ-1') return { score: 42 };
      if (issueKey === 'PROJ-2') return { score: 61 };
      return { score: 90 };
    });
    repo.insertNotification.mockResolvedValue({ id: 1 });

    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/trigger')
      .send({ limit: 2, force: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.generated).toBe(2);
    expect(res.body.reason).toBeNull();
    expect(res.body.skippedCooldown).toBe(0);
    expect(repo.ensurePreferenceRow).toHaveBeenCalledWith({
      orgId: 'cloud-xyz',
      accountId: 'acct-123'
    });
    expect(repo.getIssueScoresFromCache).toHaveBeenCalledWith({
      orgId: 'cloud-xyz',
      issueKeys: ['PROJ-1', 'PROJ-2']
    });
    expect(repo.insertNotification).toHaveBeenCalledTimes(2);
    expect(repo.insertNotification).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'cloud-xyz',
      accountId: 'acct-123',
      cloudId: 'cloud-xyz',
      issueKey: 'PROJ-1',
      scoreAtNotify: 42,
      channel: 'desktop'
    }));
    expect(descriptionService.analyzeDescription).toHaveBeenCalled();
    expect(descriptionService.analyzeDescription).toHaveBeenCalledWith(expect.objectContaining({
      issueKey: 'PROJ-1',
      title: 'Issue one',
      description: 'Desc one',
      projectKey: 'PROJ',
      orgId: 'cloud-xyz',
      accountId: 'acct-123'
    }));
  });

  test('returns success with zero generation when no cached issue keys', async () => {
    userDb.getUserCachedIssues.mockResolvedValue([]);

    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/trigger')
      .send({ limit: 5, force: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.generated).toBe(0);
    expect(res.body.reason).toBe('no-cached-issues');
    expect(repo.getIssueScoresFromCache).not.toHaveBeenCalled();
  });

  test('returns no-low-scores reason when cached issues exist but none below threshold', async () => {
    descriptionService.analyzeDescription.mockResolvedValue({ score: 95 });
    repo.getIssueScoresFromCache.mockResolvedValue(new Map([
      ['PROJ-1', 92],
      ['PROJ-2', 94]
    ]));

    const res = await request(buildApp())
      .post('/api/desktop/description-quality-nudges/trigger')
      .send({ limit: 5, force: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.generated).toBe(0);
    expect(res.body.reason).toBe('no-low-scores');
  });

  test('uses live Jira issues instead of cached issue rows for Atlassian-authenticated trigger', async () => {
    axios.post.mockResolvedValue({
      data: {
        issues: [
          {
            key: 'PROJ-92',
            fields: {
              summary: 'Fresh bad issue',
              description: 'short desc',
              issuetype: { name: 'Bug' },
              project: { key: 'PROJ' }
            }
          }
        ]
      }
    });
    descriptionService.analyzeDescription.mockResolvedValue({ score: 15 });
    repo.insertNotification.mockResolvedValue({
      id: 100,
      issue_key: 'PROJ-92',
      score_at_notify: 15,
      payload: { summary: 'Fresh bad issue' },
      notified_at: '2026-06-09T10:00:00Z'
    });

    const res = await request(buildAtlassianApp())
      .post('/api/desktop/description-quality-nudges/trigger')
      .send({ limit: 5, force: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.generated).toBe(1);
    expect(res.body.candidates).toBe(1);
    expect(res.body.issueCount).toBe(1);
    expect(userDb.getUserCachedIssues).not.toHaveBeenCalled();
    expect(repo.getIssueScoresFromCache).not.toHaveBeenCalled();
    expect(descriptionService.analyzeDescription).toHaveBeenCalledWith(expect.objectContaining({
      issueKey: 'PROJ-92',
      title: 'Fresh bad issue',
      description: 'short desc',
      projectKey: 'PROJ',
      orgId: 'cloud-xyz',
      accountId: 'acct-123'
    }));
  });
});

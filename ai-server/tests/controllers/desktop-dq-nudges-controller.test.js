'use strict';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../src/services/db/description-quality-notifications-repo', () => ({
  listPendingDesktopNudges: jest.fn(),
  acknowledgeNudges: jest.fn()
}));

jest.mock('../../src/services/db/user-db-service', () => ({
  getUserById: jest.fn(),
  getOrganizationById: jest.fn(),
  getUserAtlassianAccountId: jest.fn()
}));

jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: jest.fn(() => ({}))
}));

const repo = require('../../src/services/db/description-quality-notifications-repo');
const userDb = require('../../src/services/db/user-db-service');
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

beforeEach(() => {
  jest.clearAllMocks();
  userDb.getUserById.mockResolvedValue({
    id: 'user-uuid-1',
    organization_id: 'org-uuid-1',
    atlassian_account_id: 'acct-123'
  });
  userDb.getOrganizationById.mockResolvedValue({
    id: 'org-uuid-1',
    jira_cloud_id: 'cloud-xyz'
  });
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

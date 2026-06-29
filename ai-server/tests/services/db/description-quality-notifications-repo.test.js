'use strict';

// ---------------------------------------------------------------------------
// Mocks (hoisted before requires).
// ---------------------------------------------------------------------------
jest.mock('../../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const mockSupabase = {};
jest.mock('../../../src/services/db/supabase-client', () => ({
  getClient: jest.fn(() => mockSupabase)
}));

const repo = require('../../../src/services/db/description-quality-notifications-repo');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setSupabaseFromMock({ insertReturn, selectReturn, updateReturn }) {
  // Reset to clean object then attach methods used by each call path.
  Object.keys(mockSupabase).forEach((k) => delete mockSupabase[k]);
  mockSupabase.from = jest.fn().mockImplementation(() => {
    const chain = {
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue(insertReturn || { data: null, error: null })
        })
      }),
      select: jest.fn().mockImplementation(() => {
        const sel = {
          eq: jest.fn().mockReturnThis(),
          in: jest.fn().mockReturnThis(),
          is: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue(selectReturn || { data: null, error: null }),
          // Terminal awaitable for list queries
          then: (resolve) => resolve(selectReturn || { data: [], error: null })
        };
        return sel;
      }),
      update: jest.fn().mockImplementation(() => {
        const upd = {
          in: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          select: jest.fn().mockResolvedValue(updateReturn || { data: [], error: null })
        };
        return upd;
      })
    };
    return chain;
  });
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// _sanitisePayload — privacy guardrail
// ---------------------------------------------------------------------------
describe('_sanitisePayload', () => {
  test('keeps only allow-listed keys', () => {
    const out = repo._sanitisePayload({
      summary: 'Fix login',
      score: 55,
      issueUrl: 'https://example.atlassian.net/browse/PROJ-1',
      appUrl: 'https://example.atlassian.net/jira/apps/x',
      description: 'SECRET DETAILS — must be stripped',
      foo: 'bar'
    });
    expect(out).toEqual({
      summary: 'Fix login',
      score: 55,
      issueUrl: 'https://example.atlassian.net/browse/PROJ-1',
      appUrl: 'https://example.atlassian.net/jira/apps/x'
    });
    expect(out.description).toBeUndefined();
    expect(out.foo).toBeUndefined();
  });

  test('null payload returns null', () => {
    expect(repo._sanitisePayload(null)).toBeNull();
    expect(repo._sanitisePayload(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// insertNotification validation
// ---------------------------------------------------------------------------
describe('insertNotification', () => {
  test('rejects invalid channel', async () => {
    await expect(repo.insertNotification({
      orgId: 'c1', accountId: 'a1', cloudId: 'c1', issueKey: 'X-1',
      scoreAtNotify: 50, channel: 'sms'
    })).rejects.toThrow(/Invalid channel/);
  });

  test('rejects out-of-range score', async () => {
    await expect(repo.insertNotification({
      orgId: 'c1', accountId: 'a1', cloudId: 'c1', issueKey: 'X-1',
      scoreAtNotify: 150, channel: 'desktop'
    })).rejects.toThrow(/scoreAtNotify/);
  });

  test('strips disallowed payload keys before inserting', async () => {
    setSupabaseFromMock({ insertReturn: { data: { id: 1 }, error: null } });

    await repo.insertNotification({
      orgId: 'c1', accountId: 'a1', cloudId: 'c1', issueKey: 'PROJ-9',
      scoreAtNotify: 40, channel: 'desktop',
      payload: { summary: 's', score: 40, description: 'LEAK', issueUrl: 'u', secret: 'x' }
    });

    const fromCall = mockSupabase.from.mock.results[0].value;
    const insertCall = fromCall.insert.mock.calls[0][0];
    expect(insertCall.payload).toEqual({ summary: 's', score: 40, issueUrl: 'u' });
    expect(insertCall.payload.description).toBeUndefined();
    expect(insertCall.payload.secret).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isWithinCooldown
// ---------------------------------------------------------------------------
describe('isWithinCooldown', () => {
  test('returns false when no prior notification', async () => {
    setSupabaseFromMock({ selectReturn: { data: null, error: null } });
    const result = await repo.isWithinCooldown('c1', 'a1', 'X-1');
    expect(result).toBe(false);
  });

  test('returns true when within 24h cooldown', async () => {
    const now = new Date('2026-06-05T12:00:00Z');
    const tenHoursAgo = new Date('2026-06-05T02:00:00Z').toISOString();
    setSupabaseFromMock({
      selectReturn: { data: { id: 1, channel: 'jira', notified_at: tenHoursAgo, snooze_until: null }, error: null }
    });
    const result = await repo.isWithinCooldown('c1', 'a1', 'X-1', { now });
    expect(result).toBe(true);
  });

  test('returns false when older than cooldown', async () => {
    const now = new Date('2026-06-05T12:00:00Z');
    const twoDaysAgo = new Date('2026-06-03T11:00:00Z').toISOString();
    setSupabaseFromMock({
      selectReturn: { data: { id: 1, channel: 'jira', notified_at: twoDaysAgo, snooze_until: null }, error: null }
    });
    const result = await repo.isWithinCooldown('c1', 'a1', 'X-1', { now });
    expect(result).toBe(false);
  });

  test('returns true when an active snooze covers now', async () => {
    const now = new Date('2026-06-05T12:00:00Z');
    const longAgo = new Date('2026-05-01T00:00:00Z').toISOString();
    const snoozeUntil = new Date('2026-06-05T13:00:00Z').toISOString();
    setSupabaseFromMock({
      selectReturn: {
        data: { id: 1, channel: 'desktop', notified_at: longAgo, snooze_until: snoozeUntil },
        error: null
      }
    });
    const result = await repo.isWithinCooldown('c1', 'a1', 'X-1', { now });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// acknowledgeNudges validation
// ---------------------------------------------------------------------------
describe('acknowledgeNudges', () => {
  test('throws on empty nudgeIds', async () => {
    await expect(repo.acknowledgeNudges({
      orgId: 'c1', accountId: 'a1', nudgeIds: [], action: 'viewed'
    })).rejects.toThrow(/nudgeIds/);
  });

  test('throws on invalid action', async () => {
    await expect(repo.acknowledgeNudges({
      orgId: 'c1', accountId: 'a1', nudgeIds: [1], action: 'frobnicate'
    })).rejects.toThrow(/Invalid action/);
  });

  test('throws when snoozed action lacks snoozeUntil', async () => {
    await expect(repo.acknowledgeNudges({
      orgId: 'c1', accountId: 'a1', nudgeIds: [1], action: 'snoozed'
    })).rejects.toThrow(/snoozeUntil/);
  });

  test('scopes update to org_id and account_id', async () => {
    setSupabaseFromMock({ updateReturn: { data: [{ id: 1 }, { id: 2 }], error: null } });
    const count = await repo.acknowledgeNudges({
      orgId: 'org-a', accountId: 'acct-x', nudgeIds: [1, 2], action: 'viewed'
    });
    expect(count).toBe(2);

    const fromCall = mockSupabase.from.mock.results[0].value;
    const updateChain = fromCall.update.mock.results[0].value;
    // Verify .in and .eq filters were applied
    expect(updateChain.in).toHaveBeenCalledWith('id', [1, 2]);
    expect(updateChain.eq).toHaveBeenCalledWith('org_id', 'org-a');
    expect(updateChain.eq).toHaveBeenCalledWith('account_id', 'acct-x');
  });
});

describe('getIssueScoresFromCache', () => {
  test('coerces numeric strings to numbers', async () => {
    setSupabaseFromMock({
      selectReturn: {
        data: [
          { issue_key: 'PROJ-1', score: '100' },
          { issue_key: 'PROJ-2', score: 65 },
          { issue_key: 'PROJ-3', score: 'n/a' }
        ],
        error: null
      }
    });

    const result = await repo.getIssueScoresFromCache({
      orgId: 'cloud-xyz',
      issueKeys: ['PROJ-1', 'PROJ-2', 'PROJ-3']
    });

    expect(result.get('PROJ-1')).toBe(100);
    expect(result.get('PROJ-2')).toBe(65);
    expect(result.has('PROJ-3')).toBe(false);
  });
});

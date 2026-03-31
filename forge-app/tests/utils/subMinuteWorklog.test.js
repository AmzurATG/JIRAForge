'use strict';

/**
 * Sub-minute worklog tests
 * Verifies that worklogs with < 60 seconds are rounded up to Jira's 60s minimum
 * across all creation and update paths in jira.js utilities.
 */

// ---------------------------------------------------------------------------
// Mock @forge/api — capture the body sent to Jira
// ---------------------------------------------------------------------------
const mockRequestJira = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ id: 'worklog-1', self: 'https://jira.test/worklog/1' }),
  text: () => Promise.resolve(''),
});

jest.mock('@forge/api', () => {
  const routeTag = (strings, ...values) => {
    let result = '';
    strings.forEach((str, i) => {
      result += str + (values[i] !== undefined ? values[i] : '');
    });
    return result;
  };

  return {
    __esModule: true,
    default: {
      asUser: jest.fn(() => ({ requestJira: mockRequestJira })),
      asApp: jest.fn(() => ({ requestJira: mockRequestJira })),
    },
    route: routeTag,
  };
});

jest.mock('../../src/config/constants.js', () => ({
  JQL_ACTIVE_STATUSES: ['In Progress'],
  MAX_JIRA_SEARCH_RESULTS: 50,
}));

// ---------------------------------------------------------------------------
// Import functions under test
// ---------------------------------------------------------------------------
const {
  createJiraWorklog,
  createJiraWorklogAsUser,
  createJiraWorklogAsApp,
  updateJiraWorklog,
  updateJiraWorklogAsUser,
  updateJiraWorklogAsApp,
} = require('../../src/utils/jira.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getLastBodySent() {
  const lastCall = mockRequestJira.mock.calls[mockRequestJira.mock.calls.length - 1];
  return JSON.parse(lastCall[1].body);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  mockRequestJira.mockClear();
});

describe('Sub-minute worklog rounding (< 60s → 60s)', () => {
  const ISSUE_KEY = 'ESW-5717';
  const STARTED_AT = '2026-03-27T10:00:00.000+0000';
  const ACCOUNT_ID = 'test-account-123';

  // ── createJiraWorklog ────────────────────────────────────────────────
  describe('createJiraWorklog', () => {
    it('rounds 8 seconds up to 60 seconds', async () => {
      await createJiraWorklog(ISSUE_KEY, 8, STARTED_AT);
      expect(getLastBodySent().timeSpentSeconds).toBe(60);
    });

    it('rounds 1 second up to 60 seconds', async () => {
      await createJiraWorklog(ISSUE_KEY, 1, STARTED_AT);
      expect(getLastBodySent().timeSpentSeconds).toBe(60);
    });

    it('rounds 59 seconds up to 60 seconds', async () => {
      await createJiraWorklog(ISSUE_KEY, 59, STARTED_AT);
      expect(getLastBodySent().timeSpentSeconds).toBe(60);
    });

    it('keeps 60 seconds as-is', async () => {
      await createJiraWorklog(ISSUE_KEY, 60, STARTED_AT);
      expect(getLastBodySent().timeSpentSeconds).toBe(60);
    });

    it('keeps 120 seconds as-is', async () => {
      await createJiraWorklog(ISSUE_KEY, 120, STARTED_AT);
      expect(getLastBodySent().timeSpentSeconds).toBe(120);
    });
  });

  // ── createJiraWorklogAsUser ──────────────────────────────────────────
  describe('createJiraWorklogAsUser', () => {
    it('rounds 30 seconds up to 60 seconds', async () => {
      await createJiraWorklogAsUser(ACCOUNT_ID, ISSUE_KEY, 30, STARTED_AT);
      expect(getLastBodySent().timeSpentSeconds).toBe(60);
    });

    it('keeps 90 seconds as-is', async () => {
      await createJiraWorklogAsUser(ACCOUNT_ID, ISSUE_KEY, 90, STARTED_AT);
      expect(getLastBodySent().timeSpentSeconds).toBe(90);
    });
  });

  // ── createJiraWorklogAsApp ───────────────────────────────────────────
  describe('createJiraWorklogAsApp', () => {
    it('rounds 45 seconds up to 60 seconds', async () => {
      await createJiraWorklogAsApp(ISSUE_KEY, 45, STARTED_AT);
      expect(getLastBodySent().timeSpentSeconds).toBe(60);
    });

    it('keeps 3600 seconds as-is', async () => {
      await createJiraWorklogAsApp(ISSUE_KEY, 3600, STARTED_AT);
      expect(getLastBodySent().timeSpentSeconds).toBe(3600);
    });
  });

  // ── updateJiraWorklog ────────────────────────────────────────────────
  describe('updateJiraWorklog', () => {
    it('rounds 15 seconds up to 60 seconds on update', async () => {
      await updateJiraWorklog(ISSUE_KEY, 'worklog-1', 15);
      expect(getLastBodySent().timeSpentSeconds).toBe(60);
    });

    it('keeps 300 seconds as-is on update', async () => {
      await updateJiraWorklog(ISSUE_KEY, 'worklog-1', 300);
      expect(getLastBodySent().timeSpentSeconds).toBe(300);
    });
  });

  // ── updateJiraWorklogAsUser ──────────────────────────────────────────
  describe('updateJiraWorklogAsUser', () => {
    it('rounds 5 seconds up to 60 seconds', async () => {
      await updateJiraWorklogAsUser(ACCOUNT_ID, ISSUE_KEY, 'worklog-1', 5);
      expect(getLastBodySent().timeSpentSeconds).toBe(60);
    });
  });

  // ── updateJiraWorklogAsApp ───────────────────────────────────────────
  describe('updateJiraWorklogAsApp', () => {
    it('rounds 10 seconds up to 60 seconds', async () => {
      await updateJiraWorklogAsApp(ISSUE_KEY, 'worklog-1', 10);
      expect(getLastBodySent().timeSpentSeconds).toBe(60);
    });
  });
});

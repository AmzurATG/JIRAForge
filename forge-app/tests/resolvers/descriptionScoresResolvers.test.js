'use strict';

const mockRequestJira = jest.fn();
const mockRemoteRequest = jest.fn();
const mockSupabaseQuery = jest.fn();

jest.mock('@forge/api', () => {
  const route = (strings, ...values) =>
    strings.reduce((acc, str, i) => acc + str + (values[i] !== undefined ? String(values[i]) : ''), '');
  return {
    __esModule: true,
    default: {
      asUser: () => ({ requestJira: (...args) => mockRequestJira(...args) })
    },
    route
  };
});

jest.mock('../../src/utils/remote.js', () => ({
  remoteRequest: (...args) => mockRemoteRequest(...args),
  supabaseQuery: (...args) => mockSupabaseQuery(...args)
}));

const mockInitializeRequestContext = jest.fn();

jest.mock('../../src/resolvers/unassigned/helpers.js', () => ({
  initializeRequestContext: (...args) => mockInitializeRequestContext(...args),
  handleResolverError: (error, operation) => ({ success: false, error: `${operation}: ${error.message}` })
}));

jest.mock('../../src/resolvers/descriptionResolvers.js', () => ({
  fetchIssueForAnalysis: jest.fn().mockResolvedValue({
    title: 'Test Title',
    description: 'Test Description',
    issueType: 'Bug',
    projectKey: 'PROJ',
    parentKey: null,
    rawAttachments: [],
    rawIssueLinks: []
  }),
  buildParentContext: jest.fn().mockResolvedValue(null),
  fetchImageAttachments: jest.fn().mockResolvedValue([]),
  fetchDocumentAttachments: jest.fn().mockResolvedValue([]),
  fetchLinkedIssuesContext: jest.fn().mockResolvedValue([]),
  normalizeIssueType: (t) => t || 'Task'
}));

const { registerDescriptionScoresResolvers } = require('../../src/resolvers/descriptionScoresResolvers.js');

function makeResolver() {
  const map = new Map();
  return {
    define(name, handler) { map.set(name, handler); },
    invoke(name, req) {
      const h = map.get(name);
      if (!h) throw new Error(`no resolver ${name}`);
      return h(req);
    }
  };
}

describe('descriptionScoresResolvers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInitializeRequestContext.mockResolvedValue({
      success: true,
      config: { url: 'https://example.supabase.co' },
      organization: { id: 'org-1' },
      userId: 'user-1',
      accountId: 'acct-1',
      cloudId: 'cloud-1'
    });
  });

  test('getDescriptionScores fetches cached scores', async () => {
    mockSupabaseQuery.mockResolvedValue([
      { issue_key: 'PROJ-123', score: 85, source: 'llm', updated_at: '2026-06-30' }
    ]);

    const res = makeResolver();
    registerDescriptionScoresResolvers(res);

    const out = await res.invoke('getDescriptionScores', {
      payload: { issueKeys: ['PROJ-123'] }
    });

    expect(out.success).toBe(true);
    expect(out.scores['PROJ-123']).toBeDefined();
    expect(out.scores['PROJ-123'].score).toBe(85);
  });

  test('fillDescriptionScores handles batch requests', async () => {
    mockRemoteRequest.mockResolvedValue({
      scores: {
        'PROJ-123': { score: 90, source: 'deterministic', cached: false }
      },
      stats: { cacheHits: 0, filled: 1, errors: 0 }
    });

    const res = makeResolver();
    registerDescriptionScoresResolvers(res);

    const out = await res.invoke('fillDescriptionScores', {
      payload: { issueKeys: ['PROJ-123'] }
    });

    expect(out.success).toBe(true);
    expect(out.scores['PROJ-123'].score).toBe(90);
  });
});

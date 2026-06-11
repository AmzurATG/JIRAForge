'use strict';

/**
 * Tests for descriptionResolvers.
 *
 * Mocks @forge/api so requestJira and route can be controlled, and mocks the
 * remoteRequest helper so the AI-server call shape can be asserted directly.
 */

const mockRequestJira = jest.fn();
const mockRemoteRequest = jest.fn();

jest.mock('@forge/api', () => {
  // route is used as a tagged template; return a simple stringified version
  // so the resolver can pass it to the fake requestJira mock.
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
  remoteRequest: (...args) => mockRemoteRequest(...args)
}));

const mockSupabaseRequest = jest.fn();
const mockInitializeRequestContext = jest.fn();
const mockUpdateSessionsAndAnalysis = jest.fn();
const mockMarkGroupAsAssigned = jest.fn();
const mockCreateWorklogIfNeeded = jest.fn();
const mockIsAutoSyncEnabled = jest.fn();

jest.mock('../../src/utils/supabase.js', () => ({
  supabaseRequest: (...args) => mockSupabaseRequest(...args)
}));

jest.mock('../../src/resolvers/unassigned/helpers.js', () => ({
  initializeRequestContext: (...args) => mockInitializeRequestContext(...args),
  ensureArray: (value) => (Array.isArray(value) ? value : (value ? [value] : [])),
  handleResolverError: (error, operation) => ({ success: false, error: `${operation}: ${error.message}` })
}));

jest.mock('../../src/resolvers/unassigned/assignmentResolvers.js', () => ({
  updateSessionsAndAnalysis: (...args) => mockUpdateSessionsAndAnalysis(...args),
  markGroupAsAssigned: (...args) => mockMarkGroupAsAssigned(...args)
}));

jest.mock('../../src/services/workAssignmentService.js', () => ({
  createWorklogIfNeeded: (...args) => mockCreateWorklogIfNeeded(...args),
  isAutoSyncEnabled: (...args) => mockIsAutoSyncEnabled(...args)
}));

const { registerDescriptionResolvers } = require('../../src/resolvers/descriptionResolvers.js');

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

function jsonResponse(payload, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  });
}

const SESSION_ID_1 = 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabaseRequest.mockReset();
  mockRemoteRequest.mockReset();
  mockInitializeRequestContext.mockResolvedValue({
    success: true,
    config: { url: 'https://example.supabase.co', key: 'k' },
    organization: { id: 'org-1' },
    userId: 'user-1',
    accountId: 'acct-1',
    cloudId: 'cloud-1'
  });
  mockIsAutoSyncEnabled.mockResolvedValue(false);
  mockCreateWorklogIfNeeded.mockResolvedValue({ worklog: null, worklogSkipped: true });
  mockUpdateSessionsAndAnalysis.mockResolvedValue(0);
  mockMarkGroupAsAssigned.mockResolvedValue(true);
});

describe('analyzeDescription resolver', () => {
  test('rejects an invalid issue key', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    const result = await r.invoke('analyzeDescription', { payload: { issueKey: 'bad' }, context: {} });
    expect(result.success).toBe(false);
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  test('fetches the issue and forwards a normalized payload to the AI server', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);

    mockRequestJira.mockReturnValue(jsonResponse({
      fields: {
        summary: 'Login broken',
        description: {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It does not work' }] }]
        },
        issuetype: { name: 'Bug' },
        project: { key: 'PROJ' }
      }
    }));

    mockRemoteRequest.mockResolvedValue({
      score: 45,
      source: 'llm',
      issues: ['too vague'],
      suggestions: ['add steps'],
      improved_title: 'Login: tap unresponsive on iOS',
      improved_description: '## Summary\n...'
    });

    const result = await r.invoke('analyzeDescription', {
      payload: { issueKey: 'PROJ-1', requestImprovement: true },
      context: {}
    });

    expect(result.success).toBe(true);
    expect(result.score).toBe(45);
    expect(result.improved_title).toContain('Login');
    expect(mockRemoteRequest).toHaveBeenCalledWith('/api/forge/description/analyze',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          issueKey: 'PROJ-1',
          title: 'Login broken',
          issueType: 'Bug',
          projectKey: 'PROJ',
          requestImprovement: true
        })
      })
    );
    // ADF was extracted to plain text
    const body = mockRemoteRequest.mock.calls[0][1].body;
    expect(body.description).toContain('It does not work');
  });

  test('normalizes unknown issue types to Task', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);

    mockRequestJira.mockReturnValue(jsonResponse({
      fields: {
        summary: 'X',
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'd' }] }] },
        issuetype: { name: 'CustomType' },
        project: { key: 'PROJ' }
      }
    }));
    mockRemoteRequest.mockResolvedValue({ score: 90, source: 'deterministic', issues: [], suggestions: [], improved_title: null, improved_description: null });

    await r.invoke('analyzeDescription', { payload: { issueKey: 'PROJ-2' }, context: {} });
    expect(mockRemoteRequest.mock.calls[0][1].body.issueType).toBe('Task');
  });

  test('returns failure if Jira responds non-OK', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    mockRequestJira.mockReturnValue(Promise.resolve({
      ok: false, status: 404, text: async () => 'not found', json: async () => ({})
    }));
    const result = await r.invoke('analyzeDescription', { payload: { issueKey: 'PROJ-3' }, context: {} });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Jira/);
  });
});

describe('updateDescription resolver', () => {
  test('rejects invalid issue key', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    const result = await r.invoke('updateDescription', {
      payload: { issueKey: 'bad', improvedTitle: 't', improvedDescription: 'd' }
    });
    expect(result.success).toBe(false);
  });

  test('rejects when nothing is to be updated', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    const result = await r.invoke('updateDescription', {
      payload: { issueKey: 'PROJ-1', updateTitle: false, updateDescription: false }
    });
    expect(result.success).toBe(false);
  });

  test('PUTs ADF description + summary when both are requested', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    mockRequestJira.mockReturnValue(Promise.resolve({ ok: true, status: 204, text: async () => '', json: async () => ({}) }));

    const result = await r.invoke('updateDescription', {
      payload: {
        issueKey: 'PROJ-9',
        improvedTitle: 'New title',
        improvedDescription: '## Summary\n\nBetter content here',
        updateTitle: true,
        updateDescription: true
      }
    });

    expect(result.success).toBe(true);
    expect(mockRequestJira).toHaveBeenCalled();
    // First call is GET to fetch original ADF for media preservation,
    // second call is the actual PUT update
    const putCall = mockRequestJira.mock.calls.find(([, opts]) => opts && opts.method === 'PUT');
    expect(putCall).toBeTruthy();
    const [routeArg, opts] = putCall;
    expect(routeArg).toContain('/rest/api/3/issue/PROJ-9');
    expect(opts.method).toBe('PUT');
    const body = JSON.parse(opts.body);
    expect(body.fields.summary).toBe('New title');
    expect(body.fields.description.type).toBe('doc');
    expect(body.fields.description.version).toBe(1);
    expect(Array.isArray(body.fields.description.content)).toBe(true);
  });

  test('preserves media nodes from original description when updating', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);

    const mediaNode = {
      type: 'mediaSingle',
      attrs: { layout: 'center' },
      content: [{
        type: 'media',
        attrs: { id: 'abc-123', type: 'file', collection: 'coll', width: 800, height: 600 }
      }]
    };
    const originalAdf = {
      type: 'doc', version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Original text' }] },
        mediaNode
      ]
    };

    // First call: GET to fetch original description (returns ADF with media)
    // Second call: PUT to update (succeeds)
    mockRequestJira
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ fields: { description: originalAdf } }), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '', json: async () => ({}) });

    const result = await r.invoke('updateDescription', {
      payload: {
        issueKey: 'PROJ-10',
        improvedTitle: 'Title',
        improvedDescription: '## Improved\n\nNew content',
        updateTitle: true,
        updateDescription: true
      }
    });

    expect(result.success).toBe(true);
    const putCall = mockRequestJira.mock.calls.find(([, opts]) => opts && opts.method === 'PUT');
    const body = JSON.parse(putCall[1].body);
    // The media node from the original should be appended
    const mediaNodes = body.fields.description.content.filter(n => n.type === 'mediaSingle');
    expect(mediaNodes).toHaveLength(1);
    expect(mediaNodes[0].content[0].attrs.id).toBe('abc-123');
  });

  test('rejects empty improved title when title update requested', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    const result = await r.invoke('updateDescription', {
      payload: { issueKey: 'PROJ-1', improvedTitle: '   ', updateTitle: true, updateDescription: false }
    });
    expect(result.success).toBe(false);
  });

  test('rejects oversize title', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    const result = await r.invoke('updateDescription', {
      payload: { issueKey: 'PROJ-1', improvedTitle: 'x'.repeat(300), updateTitle: true, updateDescription: false }
    });
    expect(result.success).toBe(false);
  });

  test('returns failure when Jira rejects', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    mockRequestJira.mockReturnValue(Promise.resolve({ ok: false, status: 400, text: async () => 'bad', json: async () => ({}) }));
    const result = await r.invoke('updateDescription', {
      payload: { issueKey: 'PROJ-1', improvedTitle: 't', improvedDescription: 'd' }
    });
    expect(result.success).toBe(false);
  });
});

describe('wasDescriptionChanged resolver', () => {
  test('returns true when recent history changed description', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    mockRequestJira.mockReturnValue(jsonResponse({
      values: [{ items: [{ field: 'description' }] }]
    }));
    const result = await r.invoke('wasDescriptionChanged', { payload: { issueKey: 'PROJ-1' } });
    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
  });

  test('returns false when no description history exists', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    mockRequestJira.mockReturnValue(jsonResponse({
      values: [{ items: [{ field: 'summary' }] }]
    }));
    const result = await r.invoke('wasDescriptionChanged', { payload: { issueKey: 'PROJ-1' } });
    expect(result.changed).toBe(false);
  });

  test('returns changed=false on Jira error (best-effort)', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    mockRequestJira.mockReturnValue(Promise.resolve({ ok: false, status: 500, text: async () => '', json: async () => ({}) }));
    const result = await r.invoke('wasDescriptionChanged', { payload: { issueKey: 'PROJ-1' } });
    expect(result.success).toBe(true);
    expect(result.changed).toBe(false);
  });
});

describe('recordDescriptionEvent resolver', () => {
  test('forwards event payload to AI server', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    mockRemoteRequest.mockResolvedValue({});
    const result = await r.invoke('recordDescriptionEvent', {
      payload: { issueKey: 'PROJ-1', eventType: 'accept', scoreBefore: 40, scoreAfter: 85, source: 'llm' }
    });
    expect(result.success).toBe(true);
    expect(mockRemoteRequest).toHaveBeenCalledWith('/api/forge/description/event',
      expect.objectContaining({ body: expect.objectContaining({ eventType: 'accept' }) }));
  });

  test('rejects invalid eventType', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    const result = await r.invoke('recordDescriptionEvent', {
      payload: { issueKey: 'PROJ-1', eventType: 'destroy' }
    });
    expect(result.success).toBe(false);
  });

  test('swallows remote errors (returns success)', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    mockRemoteRequest.mockRejectedValue(new Error('boom'));
    const result = await r.invoke('recordDescriptionEvent', {
      payload: { issueKey: 'PROJ-1', eventType: 'reject' }
    });
    expect(result.success).toBe(true);
  });
});

describe('syncRecentUnassignedWorkForIssue resolver', () => {
  test('assigns matched sessions returned by AI server', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    const GROUP_ID = '11111111-2222-4333-8444-555555555555';

    mockSupabaseRequest.mockImplementation(async (_config, path) => {
      if (path.startsWith('unassigned_work_groups?')) {
        return [{ id: GROUP_ID }];
      }

      if (path.includes('unassigned_group_members?') && path.includes('group_id=') && path.includes('created_at')) {
        return [{
          group_id: GROUP_ID,
          activity_record_id: SESSION_ID_1,
          unassigned_activity_id: null,
          created_at: '2026-06-10T15:10:55.843434+00:00'
        }];
      }

      if (path.includes('activity_records?id=in.(') && path.includes('user_assigned_issue_key=is.null')) {
        return [{
          id: SESSION_ID_1,
          window_title: 'login.ts',
          application_name: 'Code',
          ocr_text: 'auth bug',
          duration_seconds: 120
        }];
      }

      if (path.startsWith('unassigned_activity?id=in.(')) {
        return [];
      }

      if (path.includes('activity_records?id=in.(') && path.includes('select=duration_seconds,total_time_seconds')) {
        return [{ duration_seconds: 120 }];
      }

      return [];
    });

    mockRequestJira.mockReturnValue(jsonResponse({
      fields: {
        summary: 'Login bug',
        description: {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Broken login' }] }]
        },
        issuetype: { name: 'Bug' },
        project: { key: 'PROJ' },
        attachment: [{ filename: 'screenshot.png', mimeType: 'image/png', size: 1234 }],
        issuelinks: []
      }
    }));

    mockRemoteRequest.mockResolvedValue({ matchedSessionIds: [SESSION_ID_1] });

    const result = await r.invoke('syncRecentUnassignedWorkForIssue', {
      payload: { issueKey: 'PROJ-1' },
      context: { accountId: 'acct-1', cloudId: 'cloud-1' }
    });

    expect(result.success).toBe(true);
    expect(result.matchedCount).toBe(1);
    expect(mockRemoteRequest).toHaveBeenCalledWith(
      '/api/forge/description/sync-issue-unassigned',
      expect.objectContaining({
        body: expect.objectContaining({
          issueKey: 'PROJ-1',
          attachmentContext: expect.stringContaining('screenshot.png')
        })
      })
    );
    expect(mockUpdateSessionsAndAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ issueKey: 'PROJ-1', validSessionIds: [SESSION_ID_1] })
    );
  });

  test('returns zero when no recent unassigned sessions exist', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    mockSupabaseRequest.mockImplementation(async (_config, path) => {
      if (path.startsWith('unassigned_work_groups?')) {
        return [];
      }
      return [];
    });

    const result = await r.invoke('syncRecentUnassignedWorkForIssue', {
      payload: { issueKey: 'PROJ-1' },
      context: { accountId: 'acct-1', cloudId: 'cloud-1' }
    });

    expect(result).toEqual({ success: true, matchedCount: 0 });
    expect(mockRemoteRequest).not.toHaveBeenCalled();
  });
});

describe('syncRecentUnassignedWorkWithAllUpdatedIssues resolver', () => {
  test('groups assignments by issue and assigns each batch', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);
    const GROUP_ID = '11111111-2222-4333-8444-555555555555';

    mockSupabaseRequest.mockImplementation(async (_config, path) => {
      if (path.startsWith('unassigned_work_groups?')) {
        return [{ id: GROUP_ID }];
      }

      if (path.includes('unassigned_group_members?') && path.includes('group_id=')) {
        // Handle both URL-encoded (from URLSearchParams) and plain formats
        if (path.includes('created_at')) {
          return [{
            group_id: GROUP_ID,
            activity_record_id: SESSION_ID_1,
            unassigned_activity_id: null,
            created_at: '2026-06-10T15:10:55.843434+00:00'
          }];
        }
      }

      if (path.includes('activity_records?') && path.includes('id=') && path.includes('user_assigned_issue_key=')) {
        return [{
          id: SESSION_ID_1,
          window_title: 'api.ts',
          application_name: 'Code',
          ocr_text: 'api work',
          duration_seconds: 90
        }];
      }

      if (path.includes('unassigned_activity?') && path.includes('id=')) {
        return [];
      }

      if (path.includes('activity_records?id=in.(') && path.includes('select=duration_seconds,total_time_seconds')) {
        return [{ duration_seconds: 90 }];
      }

      if (path.startsWith('unassigned_group_members?or=(')) {
        return [];
      }

      return [];
    });

    mockRequestJira
      .mockReturnValueOnce(jsonResponse({ issues: [{ key: 'PROJ-1' }] }))
      .mockReturnValueOnce(jsonResponse({
        fields: {
          summary: 'API task',
          description: {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'API changes' }] }]
          },
          issuetype: { name: 'Task' },
          project: { key: 'PROJ' },
          attachment: [],
          issuelinks: []
        }
      }));

    mockRemoteRequest.mockResolvedValue({
      assignments: [{ sessionId: SESSION_ID_1, issueKey: 'PROJ-1' }]
    });

    const result = await r.invoke('syncRecentUnassignedWorkWithAllUpdatedIssues', {
      payload: {},
      context: { accountId: 'acct-1', cloudId: 'cloud-1' }
    });

    expect(result.success).toBe(true);
    expect(result.matchedCount).toBe(1);
    expect(mockRemoteRequest).toHaveBeenCalledWith(
      '/api/forge/description/sync-all-unassigned',
      expect.objectContaining({
        body: expect.objectContaining({
          issues: [expect.objectContaining({
            issueKey: 'PROJ-1',
            attachmentContext: expect.any(String)
          })]
        })
      })
    );
  });

  test('returns no_previous_day_sessions without calling LLM', async () => {
    const r = makeResolver();
    registerDescriptionResolvers(r);

    mockSupabaseRequest.mockImplementation(async (_config, path) => {
      if (path.startsWith('unassigned_work_groups?')) {
        return [];
      }
      return [];
    });

    mockRequestJira.mockReturnValue(jsonResponse({ issues: [{ key: 'PROJ-1' }] }));

    const result = await r.invoke('syncRecentUnassignedWorkWithAllUpdatedIssues', {
      payload: {},
      context: { accountId: 'acct-1', cloudId: 'cloud-1' }
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      matchedCount: 0,
      reason: 'no_previous_day_sessions'
    }));
    expect(mockRemoteRequest).not.toHaveBeenCalled();
  });
});

'use strict';

/**
 * Tests for getNonSprintProjectKeys() in jira.js.
 * Classifies the user's projects by projectTypeKey and returns only the keys of
 * non-sprint projects (service_desk + business) used to scope the My Focus JQL.
 */

// ---------------------------------------------------------------------------
// Mock @forge/api — capture the project/search request
// ---------------------------------------------------------------------------
const mockRequestJira = jest.fn();

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
  JQL_ACTIVE_STATUSES: 'statusCategory = "In Progress"',
  MAX_JIRA_SEARCH_RESULTS: 50,
}));

// ---------------------------------------------------------------------------
// Import function under test
// ---------------------------------------------------------------------------
const { getNonSprintProjectKeys } = require('../../src/utils/jira.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function projectSearchResponse(values) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ values, isLast: true, total: values.length }),
    text: () => Promise.resolve(''),
  };
}

beforeEach(() => {
  mockRequestJira.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('getNonSprintProjectKeys', () => {
  it('returns only service_desk and business project keys', async () => {
    mockRequestJira.mockResolvedValueOnce(projectSearchResponse([
      { key: 'SCRUM', name: 'Scrum', projectTypeKey: 'software' },
      { key: 'JSM', name: 'Service Desk', projectTypeKey: 'service_desk' },
      { key: 'OPS', name: 'Ops', projectTypeKey: 'business' },
    ]));

    const keys = await getNonSprintProjectKeys();

    expect(keys).toEqual(['JSM', 'OPS']);
  });

  it('excludes software and product_discovery projects', async () => {
    mockRequestJira.mockResolvedValueOnce(projectSearchResponse([
      { key: 'SOFT', name: 'Software', projectTypeKey: 'software' },
      { key: 'IDEAS', name: 'Discovery', projectTypeKey: 'product_discovery' },
      { key: 'BIZ', name: 'Business', projectTypeKey: 'business' },
    ]));

    const keys = await getNonSprintProjectKeys();

    expect(keys).toEqual(['BIZ']);
    expect(keys).not.toContain('SOFT');
    expect(keys).not.toContain('IDEAS');
  });

  it('returns [] when the user has only sprint-based (software) projects', async () => {
    mockRequestJira.mockResolvedValueOnce(projectSearchResponse([
      { key: 'SOFT', name: 'Software', projectTypeKey: 'software' },
    ]));

    const keys = await getNonSprintProjectKeys();

    expect(keys).toEqual([]);
  });

  it('returns [] (graceful degradation) when the project lookup throws', async () => {
    mockRequestJira.mockRejectedValueOnce(new Error('Jira unavailable'));

    const keys = await getNonSprintProjectKeys();

    expect(keys).toEqual([]);
  });
});

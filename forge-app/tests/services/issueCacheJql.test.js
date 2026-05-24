/**
 * RC2 — Forge JQL uses statusCategory instead of hardcoded status names
 */

'use strict';

jest.mock('../../src/utils/jira.js', () => ({
  getUserAssignedIssues: jest.fn(),
}));

jest.mock('../../src/utils/supabase.js', () => ({
  getSupabaseConfig: jest.fn(),
  getOrCreateUser: jest.fn(),
  getOrCreateOrganization: jest.fn(),
  supabaseRequest: jest.fn(),
}));

jest.mock('../../src/utils/adfToText.js', () => ({
  extractDescriptionText: jest.fn(d => ''),
}));

describe('RC2 — JQL_ACTIVE_STATUSES uses statusCategory', () => {
  it('should use statusCategory-based filter instead of exact status name', () => {
    // Import the actual constants — not mocked
    const { JQL_ACTIVE_STATUSES } = require('../../src/config/constants.js');

    // The value should NOT be just ['In Progress'] anymore
    // It should be a statusCategory-based value that covers all workflow variants
    expect(JQL_ACTIVE_STATUSES).not.toEqual(['In Progress']);
    // It should be a string containing 'statusCategory' for JQL usage
    expect(JQL_ACTIVE_STATUSES).toContain('statusCategory');
  });
});

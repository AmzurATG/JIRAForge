/**
 * P3 — Description truncation at 600 chars
 * P5 — Labels flow through formatAssignedIssues
 *
 * Verifies the fixes to ai-server/src/services/ai/prompts.js
 */

'use strict';

const { formatAssignedIssues } = require('../../src/services/ai/prompts');

describe('formatAssignedIssues — description truncation (P3)', () => {

  it('should include full description when under 600 chars', () => {
    const desc = 'Implement PKCE token refresh in auth/token_manager.py, failing on 401 from /api/refresh-token endpoint';
    const issues = [{
      key: 'PROJ-1',
      summary: 'Token refresh bug',
      status: 'In Progress',
      description: desc
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain(desc);
  });

  it('should truncate description at 600 chars with ellipsis', () => {
    const longDesc = 'A'.repeat(800);
    const issues = [{
      key: 'PROJ-2',
      summary: 'Long description task',
      status: 'In Progress',
      description: longDesc
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('A'.repeat(600) + '...');
    expect(result).not.toContain('A'.repeat(601));
  });

  it('should NOT truncate description at 200 chars (old limit)', () => {
    const desc = 'B'.repeat(400);
    const issues = [{
      key: 'PROJ-3',
      summary: 'Medium description task',
      status: 'In Progress',
      description: desc
    }];
    const result = formatAssignedIssues(issues);
    // All 400 chars should be present (old limit was 200, now 600)
    expect(result).toContain('B'.repeat(400));
    expect(result).not.toContain('...');
  });

  it('should handle null description gracefully', () => {
    const issues = [{
      key: 'PROJ-4',
      summary: 'No description task',
      status: 'In Progress',
      description: null
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('No description task');
    expect(result).not.toContain('Description:');
  });

  it('should handle empty string description', () => {
    const issues = [{
      key: 'PROJ-5',
      summary: 'Empty desc task',
      status: 'In Progress',
      description: ''
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('PROJ-5');
    expect(result).not.toContain('Description:');
  });

  it('should handle whitespace-only description', () => {
    const issues = [{
      key: 'PROJ-6',
      summary: 'Whitespace desc',
      status: 'In Progress',
      description: '   '
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('PROJ-6');
    expect(result).not.toContain('Description:');
  });

  it('should include description at exactly 600 chars without truncation', () => {
    const desc = 'C'.repeat(600);
    const issues = [{
      key: 'PROJ-7',
      summary: 'Boundary test',
      status: 'In Progress',
      description: desc
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('C'.repeat(600));
    expect(result).not.toContain('...');
  });

  it('should truncate description at 601 chars', () => {
    const desc = 'D'.repeat(601);
    const issues = [{
      key: 'PROJ-8',
      summary: 'Boundary+1 test',
      status: 'In Progress',
      description: desc
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('D'.repeat(600) + '...');
  });
});

describe('formatAssignedIssues — labels in prompt (P5)', () => {

  it('should include labels when present', () => {
    const issues = [{
      key: 'PROJ-10',
      summary: 'Auth service refactor',
      status: 'In Progress',
      labels: ['auth', 'backend', 'security']
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('Labels: auth, backend, security');
  });

  it('should not show label section when labels array is empty', () => {
    const issues = [{
      key: 'PROJ-11',
      summary: 'No labels task',
      status: 'In Progress',
      labels: []
    }];
    const result = formatAssignedIssues(issues);
    expect(result).not.toContain('Labels:');
  });

  it('should not show label section when labels is null', () => {
    const issues = [{
      key: 'PROJ-12',
      summary: 'Null labels task',
      status: 'In Progress',
      labels: null
    }];
    const result = formatAssignedIssues(issues);
    expect(result).not.toContain('Labels:');
  });

  it('should not show label section when labels is undefined', () => {
    const issues = [{
      key: 'PROJ-13',
      summary: 'Undefined labels task',
      status: 'In Progress'
    }];
    const result = formatAssignedIssues(issues);
    expect(result).not.toContain('Labels:');
  });

  it('should handle single label', () => {
    const issues = [{
      key: 'PROJ-14',
      summary: 'Single label task',
      status: 'In Progress',
      labels: ['api']
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('Labels: api');
  });

  it('should include both description and labels when both present', () => {
    const issues = [{
      key: 'PROJ-15',
      summary: 'Full context task',
      status: 'In Progress',
      description: 'Implement OAuth2 PKCE flow for the auth service',
      labels: ['auth', 'api']
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('Description: Implement OAuth2 PKCE flow');
    expect(result).toContain('Labels: auth, api');
  });
});

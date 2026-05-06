'use strict';

/**
 * Tests for project-scoping fix: AI should only recommend issue keys
 * from the same project as the unassigned activity.
 *
 * Covers:
 *   Fix 1 — clustering-db-service: project_key in activity_records query & mapping
 *   Fix 2 — user-db-service: getUserActiveIssues with projectKeys filtering
 *   Fix 3 — clustering-polling-service: extract project keys from sessions
 *   Fix 4 — clustering-service: project-grouped prompt with PROJECT MATCHING RULE
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockChatCompletion = jest.fn();
const mockIsActivityAIEnabled = jest.fn();

jest.mock('../../src/services/ai/ai-client', () => ({
  chatCompletionWithFallback: mockChatCompletion,
  isActivityAIEnabled: mockIsActivityAIEnabled,
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/utils/datetime', () => ({
  toUTCISOString: (d) => d.toISOString(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { clusterUnassignedWork } = require('../../src/services/clustering-service');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeAIResult(content) {
  return {
    response: { choices: [{ message: { content } }] },
    provider: 'portkey',
    model: 'gemini-2.0-flash',
  };
}

const VALID_CLUSTER_RESPONSE = JSON.stringify({
  groups: [
    {
      label: 'SCRUM - Feature Dev',
      description: 'Working on SCRUM project feature',
      session_indices: [1],
      confidence: 'high',
      recommendation: { action: 'assign_to_existing', suggested_issue_key: 'SCRUM-42', reason: 'Same project match' },
    },
  ],
});

// ==========================================================================
// Fix 1 — clustering-db-service: project_key in query & mapping
// ==========================================================================

describe('Fix 1 — clustering-db-service includes project_key', () => {
  it('should include project_key in activity_records SELECT', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/db/clustering-db-service.js'),
      'utf8'
    );

    // The activity_records query for unassigned activities must select project_key
    // Match the specific query that also selects window_title, application_name (the clustering query)
    const selectMatches = [...src.matchAll(/from\('activity_records'\)\s*\.select\(([^)]+)\)/gs)];
    const clusteringSelect = selectMatches.find(m => m[1].includes('window_title'));
    expect(clusteringSelect).toBeDefined();
    expect(clusteringSelect[1]).toContain('project_key');
  });

  it('should map project_key in activity_records session mapping', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/db/clustering-db-service.js'),
      'utf8'
    );

    // The mappedAR mapping must include project_key
    expect(src).toContain('project_key: record.project_key');
  });
});

// ==========================================================================
// Fix 2 — user-db-service: getUserActiveIssues with projectKeys
// ==========================================================================

describe('Fix 2 — getUserActiveIssues project filtering', () => {
  // We test the function signature and project prioritization logic
  // by reading the source, since the DB calls are Supabase client calls.

  it('should accept projectKeys as third parameter', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/db/user-db-service.js'),
      'utf8'
    );

    // Function signature must include projectKeys with default
    expect(src).toMatch(/async function getUserActiveIssues\(userId,\s*organizationId,\s*projectKeys\s*=\s*\[\]\)/);
  });

  it('should prioritize same-project issues when projectKeys provided', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/db/user-db-service.js'),
      'utf8'
    );

    // Must create a Set from projectKeys and partition issues
    expect(src).toContain('new Set(projectKeys)');
    expect(src).toContain('sameProject');
    expect(src).toContain('otherProject');
    expect(src).toContain('[...sameProject, ...otherProject]');
  });

  it('should apply project prioritization in both cache and fallback paths', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/db/user-db-service.js'),
      'utf8'
    );

    // The projectKeys filtering logic should appear twice (cache path + fallback path)
    const occurrences = (src.match(/\[\.\.\.\s*sameProject,\s*\.\.\.\s*otherProject\]/g) || []).length;
    expect(occurrences).toBe(2);
  });
});

// ==========================================================================
// Fix 3 — clustering-polling-service: extract and pass project keys
// ==========================================================================

describe('Fix 3 — clustering-polling-service passes project keys', () => {
  it('should extract sessionProjectKeys from sessions', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/clustering-polling-service.js'),
      'utf8'
    );

    expect(src).toContain('sessionProjectKeys');
    expect(src).toContain("sessions.map(s => s.project_key).filter(Boolean)");
  });

  it('should pass sessionProjectKeys to getUserActiveIssues', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/clustering-polling-service.js'),
      'utf8'
    );

    expect(src).toContain('getUserActiveIssues(userId, organizationId, sessionProjectKeys)');
  });
});

// ==========================================================================
// Fix 4 — clustering-service: project-grouped prompt with constraint
// ==========================================================================

describe('Fix 4 — clustering-service AI prompt project scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsActivityAIEnabled.mockReturnValue(true);
    mockChatCompletion.mockResolvedValue(makeAIResult(VALID_CLUSTER_RESPONSE));
  });

  it('should group issues by project in the prompt when userIssues have project field', async () => {
    const sessions = [
      { id: 's1', time_spent_seconds: 3600, application_name: 'code', window_title: 'main.js', project_key: 'SCRUM' },
    ];
    const userIssues = [
      { issue_key: 'SCRUM-42', summary: 'Fix login', project: 'SCRUM', description: 'Login page bug' },
      { issue_key: 'DEVOPS-10', summary: 'Deploy pipeline', project: 'DEVOPS', description: 'CI/CD setup' },
    ];

    await clusterUnassignedWork(sessions, userIssues);

    const promptContent = mockChatCompletion.mock.calls[0][0].messages[1].content;
    // Should group issues by project
    expect(promptContent).toContain('Project SCRUM');
    expect(promptContent).toContain('Project DEVOPS');
    // Same-project marker
    expect(promptContent).toContain('[SAME PROJECT AS ACTIVITY]');
  });

  it('should include PROJECT MATCHING RULE when sessions have project_key', async () => {
    const sessions = [
      { id: 's1', time_spent_seconds: 3600, application_name: 'code', window_title: 'main.js', project_key: 'SCRUM' },
    ];
    const userIssues = [
      { issue_key: 'SCRUM-42', summary: 'Fix login', project: 'SCRUM' },
    ];

    await clusterUnassignedWork(sessions, userIssues);

    const promptContent = mockChatCompletion.mock.calls[0][0].messages[1].content;
    expect(promptContent).toContain('PROJECT MATCHING RULE');
    expect(promptContent).toContain('MUST ONLY suggest issue keys from these same project(s)');
    expect(promptContent).toContain('SCRUM');
  });

  it('should NOT include PROJECT MATCHING RULE when sessions have no project_key', async () => {
    const sessions = [
      { id: 's1', time_spent_seconds: 3600, application_name: 'code', window_title: 'main.js' },
    ];
    const userIssues = [
      { issue_key: 'SCRUM-42', summary: 'Fix login', project: 'SCRUM' },
    ];

    await clusterUnassignedWork(sessions, userIssues);

    const promptContent = mockChatCompletion.mock.calls[0][0].messages[1].content;
    expect(promptContent).not.toContain('PROJECT MATCHING RULE');
  });

  it('should mark only the matching project with [SAME PROJECT AS ACTIVITY]', async () => {
    const sessions = [
      { id: 's1', time_spent_seconds: 1800, application_name: 'code', window_title: 'a.js', project_key: 'SCRUM' },
      { id: 's2', time_spent_seconds: 1800, application_name: 'chrome', window_title: 'jira', project_key: 'SCRUM' },
    ];
    const userIssues = [
      { issue_key: 'SCRUM-1', summary: 'Bug fix', project: 'SCRUM' },
      { issue_key: 'DEVOPS-5', summary: 'Infra', project: 'DEVOPS' },
      { issue_key: 'HR-3', summary: 'Onboarding', project: 'HR' },
    ];

    await clusterUnassignedWork(sessions, userIssues);

    const promptContent = mockChatCompletion.mock.calls[0][0].messages[1].content;
    // Only SCRUM should be marked
    const scrumSection = promptContent.indexOf('Project SCRUM');
    const devopsSection = promptContent.indexOf('Project DEVOPS');
    const hrSection = promptContent.indexOf('Project HR');

    expect(scrumSection).not.toBe(-1);
    expect(devopsSection).not.toBe(-1);
    expect(hrSection).not.toBe(-1);

    // SCRUM section should have the marker
    expect(promptContent).toContain('Project SCRUM [SAME PROJECT AS ACTIVITY]');
    // DEVOPS and HR should NOT have the marker
    expect(promptContent).not.toContain('Project DEVOPS [SAME PROJECT AS ACTIVITY]');
    expect(promptContent).not.toContain('Project HR [SAME PROJECT AS ACTIVITY]');
  });

  it('should instruct LLM to recommend create_new_issue instead of cross-project match', async () => {
    const sessions = [
      { id: 's1', time_spent_seconds: 3600, application_name: 'code', window_title: 'main.js', project_key: 'SCRUM' },
    ];
    const userIssues = [
      { issue_key: 'SCRUM-42', summary: 'Fix login', project: 'SCRUM' },
    ];

    await clusterUnassignedWork(sessions, userIssues);

    const promptContent = mockChatCompletion.mock.calls[0][0].messages[1].content;
    expect(promptContent).toContain('recommend "create_new_issue" instead of forcing a match from another project');
  });

  it('should include project constraint in the system prompt', async () => {
    const sessions = [
      { id: 's1', time_spent_seconds: 3600, application_name: 'code', window_title: 'main.js', project_key: 'SCRUM' },
    ];

    await clusterUnassignedWork(sessions, [{ issue_key: 'SCRUM-1', summary: 'Test', project: 'SCRUM' }]);

    const systemPrompt = mockChatCompletion.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain('ONLY suggest issue keys from the SAME project');
    expect(systemPrompt).toContain('NEVER force-match an issue from a different project');
  });

  it('should handle multiple project keys from sessions', async () => {
    const sessions = [
      { id: 's1', time_spent_seconds: 1800, application_name: 'code', window_title: 'a.js', project_key: 'SCRUM' },
      { id: 's2', time_spent_seconds: 1800, application_name: 'code', window_title: 'b.js', project_key: 'DEVOPS' },
    ];
    const userIssues = [
      { issue_key: 'SCRUM-1', summary: 'Bug', project: 'SCRUM' },
      { issue_key: 'DEVOPS-1', summary: 'Deploy', project: 'DEVOPS' },
      { issue_key: 'HR-1', summary: 'Hiring', project: 'HR' },
    ];

    await clusterUnassignedWork(sessions, userIssues);

    const promptContent = mockChatCompletion.mock.calls[0][0].messages[1].content;
    // Both SCRUM and DEVOPS should be marked as same project
    expect(promptContent).toContain('Project SCRUM [SAME PROJECT AS ACTIVITY]');
    expect(promptContent).toContain('Project DEVOPS [SAME PROJECT AS ACTIVITY]');
    expect(promptContent).not.toContain('Project HR [SAME PROJECT AS ACTIVITY]');
    // PROJECT MATCHING RULE should list both
    expect(promptContent).toContain('SCRUM, DEVOPS');
  });

  it('should still work when userIssues is empty', async () => {
    const sessions = [
      { id: 's1', time_spent_seconds: 3600, application_name: 'code', window_title: 'main.js', project_key: 'SCRUM' },
    ];

    await clusterUnassignedWork(sessions, []);

    const promptContent = mockChatCompletion.mock.calls[0][0].messages[1].content;
    // No issues context at all
    expect(promptContent).not.toContain('User\'s assigned Jira issues');
    expect(promptContent).not.toContain('PROJECT MATCHING RULE');
  });

  it('should include issue descriptions truncated to 200 chars in grouped format', async () => {
    const longDesc = 'A'.repeat(300);
    const sessions = [
      { id: 's1', time_spent_seconds: 3600, application_name: 'code', window_title: 'main.js', project_key: 'SCRUM' },
    ];
    const userIssues = [
      { issue_key: 'SCRUM-42', summary: 'Fix login', project: 'SCRUM', description: longDesc },
    ];

    await clusterUnassignedWork(sessions, userIssues);

    const promptContent = mockChatCompletion.mock.calls[0][0].messages[1].content;
    // Description should be truncated to 200 chars
    expect(promptContent).toContain('A'.repeat(200));
    expect(promptContent).not.toContain('A'.repeat(201));
  });
});

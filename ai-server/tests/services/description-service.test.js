'use strict';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../src/services/ai/ai-client', () => ({
  chatCompletionWithFallback: jest.fn(),
  isPortkeyEnabled: jest.fn().mockReturnValue(true)
}));

jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: jest.fn(() => null)
}));

const aiClient = require('../../src/services/ai/ai-client');
const {
  analyzeDescription,
  sanitizePII,
  scoreDeterministic,
  validateLLMResponse,
  parseLLMContent,
  generateContentHash,
  syncIssueUnassigned,
  syncAllUnassigned,
  filterMatchesByConfidence,
  LLM_GATE_THRESHOLD,
  MATCH_MIN_CONFIDENCE
} = require('../../src/services/description-service');

beforeEach(() => {
  jest.clearAllMocks();
  aiClient.isPortkeyEnabled.mockReturnValue(true);
});

// ---------------------------------------------------------------------------
// Deterministic scorer
// ---------------------------------------------------------------------------

describe('scoreDeterministic', () => {
  test('scores a well-formed Bug ticket at 80+', () => {
    const { score, failedCriteria } = scoreDeterministic({
      title: 'Mobile: Login button unresponsive on tap (iOS Safari)',
      description: `## Summary
Login button does not respond on tap.

## Steps to Reproduce
1. Open app on iOS Safari
2. Tap login

## Expected Result
Login form submits

## Actual Result
Nothing happens; no network request fired

## Environment
- OS: iOS 17.2
- Browser: Safari 17

We need to investigate and fix this issue.`,
      issueType: 'Bug'
    });
    expect(score).toBeGreaterThanOrEqual(80);
    expect(failedCriteria).not.toContain('steps_to_reproduce');
    expect(failedCriteria).not.toContain('expected_actual');
  });

  test('scores a minimal Bug ticket (no steps, no expected/actual) below 50', () => {
    const { score, issues } = scoreDeterministic({
      title: 'Bug',
      description: 'broken',
      issueType: 'Bug'
    });
    expect(score).toBeLessThan(50);
    expect(issues.length).toBeGreaterThan(0);
  });

  test('scores a well-formed Story with acceptance criteria at 80+', () => {
    const { score } = scoreDeterministic({
      title: 'Allow users to export team analytics as CSV',
      description: `## User Story
As a project manager, I want to export team analytics as CSV so that I can share them.

## Acceptance Criteria
- Given a project, when I click Export, then a CSV file is downloaded
- The CSV must include user, hours, date columns

Environment: production web app, Chrome and Firefox.`,
      issueType: 'Story'
    });
    expect(score).toBeGreaterThanOrEqual(80);
  });

  test('Story without acceptance criteria fails that criterion', () => {
    const { failedCriteria } = scoreDeterministic({
      title: 'Add export feature',
      description: 'We need to add an export feature to the analytics page.',
      issueType: 'Story'
    });
    expect(failedCriteria).toContain('acceptance_criteria');
  });

  test('deducts points for placeholder text TODO/TBD', () => {
    const { failedCriteria } = scoreDeterministic({
      title: 'Fix the dashboard performance issue properly',
      description: 'We need to TBD figure out why this is slow. TODO: profile it.',
      issueType: 'Task'
    });
    expect(failedCriteria).toContain('no_placeholder');
  });

  test('deducts points for very short title', () => {
    const { failedCriteria } = scoreDeterministic({
      title: 'fix',
      description: 'a'.repeat(100) + ' implement something',
      issueType: 'Task'
    });
    expect(failedCriteria).toContain('title_length');
  });

  test('deducts points for very long title', () => {
    const { failedCriteria } = scoreDeterministic({
      title: 'x'.repeat(100),
      description: 'a'.repeat(100),
      issueType: 'Task'
    });
    expect(failedCriteria).toContain('title_length');
  });

  test('deducts points for short description', () => {
    const { failedCriteria } = scoreDeterministic({
      title: 'A reasonable looking title',
      description: 'short',
      issueType: 'Task'
    });
    expect(failedCriteria).toContain('desc_length');
  });

  test('Bug-specific criteria are NOT applied to a Task', () => {
    const { applicableCriteria } = scoreDeterministic({
      title: 'Refactor activity service module',
      description: 'Implement the change in activity-service.js to improve readability.',
      issueType: 'Task'
    });
    expect(applicableCriteria).not.toContain('steps_to_reproduce');
    expect(applicableCriteria).not.toContain('expected_actual');
    expect(applicableCriteria).not.toContain('acceptance_criteria');
  });

  test('Story-specific criterion is NOT applied to a Bug', () => {
    const { applicableCriteria } = scoreDeterministic({
      title: 'Login broken',
      description: 'desc',
      issueType: 'Bug'
    });
    expect(applicableCriteria).not.toContain('acceptance_criteria');
  });

  test('handles empty description gracefully', () => {
    const { score, issues } = scoreDeterministic({
      title: 'Some title here',
      description: '',
      issueType: 'Task'
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(50);
    expect(issues.length).toBeGreaterThan(0);
  });

  test('handles missing title gracefully', () => {
    const { score } = scoreDeterministic({
      title: '',
      description: 'Some description',
      issueType: 'Task'
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// PII sanitization
// ---------------------------------------------------------------------------

describe('sanitizePII', () => {
  test('redacts email addresses', () => {
    expect(sanitizePII('Contact me at user@example.com please')).toContain('[EMAIL]');
    expect(sanitizePII('Contact me at user@example.com please')).not.toContain('user@example.com');
  });

  test('redacts OpenAI-style API keys', () => {
    const text = 'token sk-abcdefghijklmnopqrstuvwxyz123456 here';
    expect(sanitizePII(text)).toContain('[API_KEY]');
    expect(sanitizePII(text)).not.toContain('sk-abcdef');
  });

  test('redacts AWS-style API keys', () => {
    expect(sanitizePII('AKIAIOSFODNN7EXAMPLE')).toContain('[API_KEY]');
  });

  test('redacts credit card numbers', () => {
    expect(sanitizePII('Card 4111 1111 1111 1111 here')).toContain('[CREDIT_CARD]');
  });

  test('redacts phone numbers (US format)', () => {
    expect(sanitizePII('Call 555-123-4567 today')).toContain('[PHONE]');
  });

  test('redacts international phone numbers', () => {
    expect(sanitizePII('Call +442012345678 now')).toContain('[PHONE]');
  });

  test('redacts IP addresses', () => {
    expect(sanitizePII('Server at 192.168.1.100 is down')).toContain('[IP_ADDRESS]');
  });

  test('redacts JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc123def456';
    expect(sanitizePII(`Token: ${jwt}`)).toContain('[TOKEN]');
  });

  test('preserves non-PII content unchanged', () => {
    expect(sanitizePII('This is a normal sentence about Jira tickets')).toBe(
      'This is a normal sentence about Jira tickets'
    );
  });

  test('handles null / empty / non-string input', () => {
    expect(sanitizePII(null)).toBe('');
    expect(sanitizePII(undefined)).toBe('');
    expect(sanitizePII('')).toBe('');
    expect(sanitizePII(42)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// content hash + LLM response helpers
// ---------------------------------------------------------------------------

describe('generateContentHash', () => {
  test('produces a stable 64-char hex hash', () => {
    const h = generateContentHash('title', 'desc', 'Bug');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(generateContentHash('title', 'desc', 'Bug')).toBe(h);
  });

  test('differs when content changes', () => {
    const a = generateContentHash('a', 'b', 'Bug');
    const b = generateContentHash('a', 'b ', 'Bug');
    expect(a).not.toBe(b);
  });
});

describe('validateLLMResponse', () => {
  const good = {
    score: 75,
    issues: ['x'],
    suggestions: ['y'],
    improved_title: 'Better title',
    improved_description: '## Summary\nFoo'
  };

  test('accepts a well-formed response', () => {
    expect(validateLLMResponse(good)).toBe(true);
  });
  test('rejects out-of-range score', () => {
    expect(validateLLMResponse({ ...good, score: 150 })).toBe(false);
  });
  test('rejects empty issues array', () => {
    expect(validateLLMResponse({ ...good, issues: [] })).toBe(false);
  });
  test('rejects too many suggestions', () => {
    expect(validateLLMResponse({ ...good, suggestions: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBe(false);
  });
  test('rejects missing improved_title', () => {
    expect(validateLLMResponse({ ...good, improved_title: '' })).toBe(false);
  });
  test('rejects null', () => {
    expect(validateLLMResponse(null)).toBe(false);
  });
});

describe('parseLLMContent', () => {
  test('parses plain JSON', () => {
    expect(parseLLMContent('{"a":1}')).toEqual({ a: 1 });
  });
  test('parses JSON wrapped in markdown', () => {
    expect(parseLLMContent('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  test('returns null on garbage', () => {
    expect(parseLLMContent('not json')).toBe(null);
    expect(parseLLMContent('')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// analyzeDescription orchestration
// ---------------------------------------------------------------------------

describe('analyzeDescription orchestration', () => {
  const goodTicket = {
    issueKey: 'PROJ-1',
    title: 'Mobile: Login button unresponsive on tap (iOS Safari)',
    description: `## Summary
Login does not respond on tap.

## Steps to Reproduce
1. Open app on iOS Safari
2. Tap login

## Expected Result
Login submits

## Actual Result
Nothing happens; no network request fired

## Environment
iOS 17.2, Safari 17.

Investigate and fix.`,
    issueType: 'Bug'
  };

  const lowTicket = {
    issueKey: 'PROJ-2',
    title: 'bug',
    description: 'broken',
    issueType: 'Bug'
  };

  test('does NOT invoke LLM when deterministic score >= threshold', async () => {
    const runLLM = jest.fn();
    const result = await analyzeDescription({
      ...goodTicket,
      deps: { runLLM, getClient: () => null }
    });
    expect(runLLM).not.toHaveBeenCalled();
    expect(result.source).toBe('deterministic');
    expect(result.score).toBeGreaterThanOrEqual(LLM_GATE_THRESHOLD);
  });

  test('invokes LLM when deterministic score is below threshold', async () => {
    const runLLM = jest.fn().mockResolvedValue({
      score: 88,
      issues: ['Was too vague'],
      suggestions: ['Add steps'],
      improved_title: 'Login: tap is non-responsive on iOS Safari',
      improved_description: '## Summary\n...'
    });
    const result = await analyzeDescription({
      ...lowTicket,
      deps: { runLLM, getClient: () => null }
    });
    expect(runLLM).toHaveBeenCalledTimes(1);
    expect(result.source).toBe('llm');
    expect(result.score).toBe(88);
    expect(result.improved_title).toBeTruthy();
    expect(result.improved_description).toBeTruthy();
  });

  test('invokes LLM regardless of score when requestImprovement is true', async () => {
    const runLLM = jest.fn().mockResolvedValue({
      score: 90,
      issues: ['minor'],
      suggestions: ['polish'],
      improved_title: 'Better',
      improved_description: '## Summary\nx'
    });
    await analyzeDescription({
      ...goodTicket,
      requestImprovement: true,
      deps: { runLLM, getClient: () => null }
    });
    expect(runLLM).toHaveBeenCalledTimes(1);
  });

  test('does NOT lower score when requestImprovement=true on a high-scoring ticket', async () => {
    // Regression test: clicking "Improve with AI" must never produce a lower score
    // than the initial "Check quality" run on the same ticket.
    // The LLM is invoked for its improvement content, but the deterministic score
    // is kept because the LLM was not invoked for scoring purposes.
    const runLLM = jest.fn().mockResolvedValue({
      score: 55,  // LLM gives a lower score than deterministic
      issues: ['some issue'],
      suggestions: ['some suggestion'],
      improved_title: 'Better title',
      improved_description: '## Summary\nimproved'
    });
    const result = await analyzeDescription({
      ...goodTicket,
      requestImprovement: true,
      deps: { runLLM, getClient: () => null }
    });
    // Score must NOT be the LLM score (55) — it must remain the deterministic score
    expect(result.score).not.toBe(55);
    expect(result.score).toBeGreaterThanOrEqual(LLM_GATE_THRESHOLD);
    expect(result.source).toBe('deterministic');
    // But improvement content still comes from LLM
    expect(result.improved_title).toBe('Better title');
    expect(result.improved_description).toContain('improved');
    expect(result.issues).toEqual(['some issue']);
  });

  test('still adopts LLM score when det score is below gate, even with requestImprovement', async () => {
    const runLLM = jest.fn().mockResolvedValue({
      score: 72,
      issues: ['vague'],
      suggestions: ['add detail'],
      improved_title: 'Better Bug Title',
      improved_description: '## Summary\nfixed'
    });
    const result = await analyzeDescription({
      ...lowTicket,
      requestImprovement: true,
      deps: { runLLM, getClient: () => null }
    });
    // det.score for lowTicket is < gate, so LLM score IS the authoritative one
    expect(result.score).toBe(72);
    expect(result.source).toBe('llm');
  });

  test('falls back to deterministic when LLM returns null', async () => {
    const runLLM = jest.fn().mockResolvedValue(null);
    const result = await analyzeDescription({
      ...lowTicket,
      deps: { runLLM, getClient: () => null }
    });
    expect(result.source).toBe('deterministic');
  });

  test('filterMatchesByConfidence drops matches below threshold', () => {
    const filtered = filterMatchesByConfidence(
      [
        { sessionId: 'a', confidence: 0.9, issueKey: 'PROJ-1' },
        { sessionId: 'b', confidence: 0.5, issueKey: 'PROJ-1' }
      ],
      ['a', 'b'],
      ['PROJ-1']
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].sessionId).toBe('a');
    expect(MATCH_MIN_CONFIDENCE).toBe(0.7);
  });

  test('syncIssueUnassigned returns empty when no sessions', async () => {
    const result = await syncIssueUnassigned({
      issueKey: 'PROJ-1',
      title: 'Title',
      description: 'Description',
      sessions: []
    });
    expect(result.matchedSessionIds).toEqual([]);
  });

  test('syncIssueUnassigned filters low-confidence LLM matches', async () => {
    const runChat = jest.fn().mockResolvedValue({
      response: {
        choices: [{
          message: {
            content: JSON.stringify({
              matches: [
                { sessionId: 'sess-1', confidence: 0.95 },
                { sessionId: 'sess-2', confidence: 0.4 }
              ]
            })
          }
        }]
      }
    });

    const result = await syncIssueUnassigned({
      issueKey: 'PROJ-1',
      title: 'Login bug',
      description: 'Broken login flow',
      sessions: [
        { sessionId: 'sess-1', applicationName: 'Code', windowTitle: 'login.ts' },
        { sessionId: 'sess-2', applicationName: 'Slack', windowTitle: 'general' }
      ],
      deps: { runChat }
    });

    expect(result.matchedSessionIds).toEqual(['sess-1']);
  });

  test('syncIssueUnassigned forwards attachment context to matcher', async () => {
    const runChat = jest.fn().mockResolvedValue({
      response: {
        choices: [{
          message: {
            content: JSON.stringify({ matches: [] })
          }
        }]
      }
    });

    await syncIssueUnassigned({
      issueKey: 'PROJ-1',
      title: 'Login bug',
      description: 'Broken login flow',
      attachmentContext: 'screenshot.png (image/png, 1234 bytes)',
      sessions: [
        { sessionId: 'sess-1', applicationName: 'Code', windowTitle: 'login.ts' }
      ],
      deps: { runChat }
    });

    const userMessage = runChat.mock.calls[0][0].messages.find((m) => m.role === 'user');
    const payload = JSON.parse(userMessage.content);
    expect(payload.attachmentContext).toContain('screenshot.png');
  });

  test('syncAllUnassigned returns one assignment per session', async () => {
    const runChat = jest.fn().mockResolvedValue({
      response: {
        choices: [{
          message: {
            content: JSON.stringify({
              assignments: [
                { sessionId: 'sess-1', issueKey: 'PROJ-1', confidence: 0.9 },
                { sessionId: 'sess-1', issueKey: 'PROJ-2', confidence: 0.8 }
              ]
            })
          }
        }]
      }
    });

    const result = await syncAllUnassigned({
      issues: [
        { issueKey: 'PROJ-1', title: 'One', description: 'Desc one' },
        { issueKey: 'PROJ-2', title: 'Two', description: 'Desc two' }
      ],
      sessions: [{ sessionId: 'sess-1', applicationName: 'Code', windowTitle: 'proj' }],
      deps: { runChat }
    });

    expect(result.assignments).toEqual([{ sessionId: 'sess-1', issueKey: 'PROJ-1' }]);
  });

  test('syncAllUnassigned forwards description and attachment context to matcher', async () => {
    const runChat = jest.fn().mockResolvedValue({
      response: {
        choices: [{
          message: {
            content: JSON.stringify({ assignments: [] })
          }
        }]
      }
    });

    await syncAllUnassigned({
      issues: [{
        issueKey: 'PROJ-1',
        title: 'Login bug',
        description: 'Fails on Safari after SSO redirect',
        attachmentContext: 'auth-flow-diagram.png (image/png, 22131 bytes)'
      }],
      sessions: [{ sessionId: 'sess-1', applicationName: 'Code', windowTitle: 'auth.ts' }],
      deps: { runChat }
    });

    const callArg = runChat.mock.calls[0][0];
    const userMessage = callArg.messages.find((m) => m.role === 'user');
    const payload = JSON.parse(userMessage.content);
    expect(payload.issues[0].description).toContain('SSO redirect');
    expect(payload.issues[0].attachmentContext).toContain('auth-flow-diagram.png');
  });

  test('sanitizes title + description before calling LLM', async () => {
    const runLLM = jest.fn().mockResolvedValue({
      score: 80, issues: ['x'], suggestions: ['y'],
      improved_title: 'Better', improved_description: '## Summary\nx'
    });
    await analyzeDescription({
      issueKey: 'PROJ-3',
      title: 'bug from user@example.com',
      description: 'Call 555-123-4567 to repro',
      issueType: 'Bug',
      deps: { runLLM, getClient: () => null }
    });
    const arg = runLLM.mock.calls[0][0];
    expect(arg.sanitizedTitle).toContain('[EMAIL]');
    expect(arg.sanitizedTitle).not.toContain('user@example.com');
    expect(arg.sanitizedDescription).toContain('[PHONE]');
  });

});

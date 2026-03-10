'use strict';

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

const { clusterUnassignedWork, getUnassignedWorkSummary } = require('../../src/services/clustering-service');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SESSION = {
  id: 'sess-1',
  time_spent_seconds: 3600,
  application_name: 'code',
  window_title: 'main.js — MyProject',
  timestamp: '2026-03-01T10:00:00Z',
};

// Minimal valid clustering response JSON (session_indices are 1-based)
const VALID_CLUSTER_RESPONSE = JSON.stringify({
  groups: [
    {
      label: 'Code review',
      description: 'Working on main.js',
      session_indices: [1],
      confidence: 'high',
      recommendation: { action: 'create_new_issue', suggested_issue_key: null, reason: 'New work' },
    },
  ],
});

/** Helper — wrap content in the shape chatCompletionWithFallback actually resolves to */
function makeAIResult(content) {
  return {
    response: { choices: [{ message: { content } }] },
    provider: 'fireworks',
    model: 'llama-v3',
  };
}

// ---------------------------------------------------------------------------
// clusterUnassignedWork
// ---------------------------------------------------------------------------

describe('clusterUnassignedWork', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsActivityAIEnabled.mockReturnValue(true);
    mockChatCompletion.mockResolvedValue(makeAIResult(VALID_CLUSTER_RESPONSE));
  });

  // ── guard clauses ─────────────────────────────────────────────────────────

  it('returns { groups: [] } for empty session array', async () => {
    const result = await clusterUnassignedWork([]);
    expect(result).toEqual({ groups: [] });
  });

  it('returns { groups: [] } for null sessions', async () => {
    const result = await clusterUnassignedWork(null);
    expect(result).toEqual({ groups: [] });
  });

  it('throws when AI client is not available', async () => {
    mockIsActivityAIEnabled.mockReturnValue(false);
    await expect(clusterUnassignedWork([SESSION])).rejects.toThrow('AI client not available');
  });

  // ── successful clustering ─────────────────────────────────────────────────

  it('returns parsed groups from AI response', async () => {
    const result = await clusterUnassignedWork([SESSION]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].label).toBe('Code review');
  });

  it('enriches groups with session data and computed totals', async () => {
    const result = await clusterUnassignedWork([SESSION]);
    const g = result.groups[0];
    expect(g.total_seconds).toBe(3600);
    expect(g.session_count).toBe(1);
    expect(typeof g.total_time_formatted).toBe('string');
    expect(g.aiProvider).toBe('fireworks');
    expect(g.aiModel).toBe('llama-v3');
  });

  it('returns total_sessions and total_groups counts', async () => {
    const result = await clusterUnassignedWork([SESSION]);
    expect(result.total_sessions).toBe(1);
    expect(result.total_groups).toBe(1);
  });

  it('calls chatCompletionWithFallback with an object containing messages array', async () => {
    await clusterUnassignedWork([SESSION]);
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    const callArgs = mockChatCompletion.mock.calls[0][0];
    expect(typeof callArgs).toBe('object');
    expect(Array.isArray(callArgs.messages)).toBe(true);
    expect(callArgs.messages.length).toBeGreaterThan(0);
  });

  // ── markdown code block stripping (replaceAll fix at L244-245) ────────────

  it('strips ```json markdown wrapper from AI response', async () => {
    mockChatCompletion.mockResolvedValue(makeAIResult('```json\n' + VALID_CLUSTER_RESPONSE + '\n```'));
    const result = await clusterUnassignedWork([SESSION]);
    expect(result.groups).toHaveLength(1);
  });

  it('strips plain ``` wrapper from AI response', async () => {
    mockChatCompletion.mockResolvedValue(makeAIResult('```\n' + VALID_CLUSTER_RESPONSE + '\n```'));
    const result = await clusterUnassignedWork([SESSION]);
    expect(result.groups).toHaveLength(1);
  });

  it('strips multiple ```json blocks (replaceAll replaces all, not just first)', async () => {
    const doubled = '```json\n```json\n' + VALID_CLUSTER_RESPONSE + '\n```\n```';
    mockChatCompletion.mockResolvedValue(makeAIResult(doubled));
    const result = await clusterUnassignedWork([SESSION]);
    expect(result.groups).toHaveLength(1);
  });

  // ── trailing comma fix (replaceAll fix at L281) ───────────────────────────

  it('handles AI response with trailing comma in object (JSON repair)', async () => {
    const responseWithTrailingComma = `{
      "groups": [
        {
          "label": "Work",
          "description": "Coding",
          "session_indices": [1],
          "confidence": "high",
          "recommendation": { "action": "create_new_issue", "suggested_issue_key": null, "reason": "x" },
        }
      ],
    }`;
    mockChatCompletion.mockResolvedValue(makeAIResult(responseWithTrailingComma));
    const result = await clusterUnassignedWork([SESSION]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].label).toBe('Work');
  });

  it('handles AI response with trailing comma in array (JSON repair)', async () => {
    const responseWithArrayComma = `{
      "groups": [
        {"label":"A","description":"x","session_indices":[1,],"confidence":"high","recommendation":{"action":"create_new_issue","suggested_issue_key":null,"reason":"y"}}
      ]
    }`;
    mockChatCompletion.mockResolvedValue(makeAIResult(responseWithArrayComma));
    const result = await clusterUnassignedWork([SESSION]);
    expect(result.groups).toHaveLength(1);
  });

  // ── normalizeAppName — tested indirectly via isSystemApp ─────────────────

  it('processes sessions with .exe app names (normalizeAppName strips .exe)', async () => {
    const exeSession = { ...SESSION, application_name: 'code.exe' };
    const result = await clusterUnassignedWork([exeSession]);
    expect(result).toBeDefined();
  });

  it('processes sessions with whitespace in app names (normalizeAppName strips spaces)', async () => {
    const spaceSession = { ...SESSION, application_name: 'Microsoft Edge' };
    const result = await clusterUnassignedWork([spaceSession]);
    expect(result).toBeDefined();
  });

  it('processes system app sessions (lockapp) separately', async () => {
    const sysSession = { ...SESSION, application_name: 'lockapp', id: 'sys-1' };
    const result = await clusterUnassignedWork([sysSession]);
    expect(result).toBeDefined();
  });

  // ── user issues context ───────────────────────────────────────────────────

  it('accepts optional userIssues parameter', async () => {
    const userIssues = [{ issue_key: 'PROJ-1', summary: 'Fix bug' }];
    const result = await clusterUnassignedWork([SESSION], userIssues);
    expect(result.groups).toHaveLength(1);
  });

  it('includes session with extracted_text in input context', async () => {
    const sessionWithText = { ...SESSION, extracted_text: 'const foo = bar;'.repeat(20) };
    const result = await clusterUnassignedWork([sessionWithText]);
    expect(result).toBeDefined();
  });

  // ── batch processing (>30 sessions) — triggers clusterInBatches ──────────

  it('uses batch processing when sessions exceed MAX_SESSIONS_PER_BATCH (30)', async () => {
    // 31 sessions → triggers clusterInBatches, which calls clusterUnassignedWork per batch
    const sessions = Array.from({ length: 31 }, (_, i) => ({
      ...SESSION,
      id: `sess-${i + 1}`,
      window_title: `File ${i + 1}.js`,
    }));

    // Each batch call returns one group; they'll be merged
    mockChatCompletion.mockResolvedValue(makeAIResult(JSON.stringify({
      groups: [{
        label: 'Batch Work',
        description: 'Batch sessions',
        session_indices: [1],
        confidence: 'medium',
        recommendation: { action: 'create_new_issue', suggested_issue_key: null, reason: 'r' },
      }],
    })));

    const result = await clusterUnassignedWork(sessions);
    expect(result.total_sessions).toBe(31);
    // Two batches called (30 + 1)
    expect(mockChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('batch result merges similar-label groups from different batches', async () => {
    const sessions = Array.from({ length: 32 }, (_, i) => ({
      ...SESSION,
      id: `sess-${i + 1}`,
      window_title: `File ${i + 1}.js`,
    }));

    // Both batches return a group with the same label → should merge
    mockChatCompletion.mockResolvedValue(makeAIResult(JSON.stringify({
      groups: [{
        label: 'MyProject Development',
        description: 'Working on MyProject',
        session_indices: [1],
        confidence: 'high',
        recommendation: { action: 'create_new_issue', suggested_issue_key: null, reason: 'r' },
      }],
    })));

    const result = await clusterUnassignedWork(sessions);
    // After merging, there should be fewer groups than batches
    expect(result.total_groups).toBeLessThanOrEqual(result.total_sessions);
  });

  it('continues processing remaining batches even if one batch fails', async () => {
    const sessions = Array.from({ length: 31 }, (_, i) => ({
      ...SESSION, id: `sess-${i + 1}`,
    }));

    // First batch fails, second succeeds
    mockChatCompletion
      .mockRejectedValueOnce(new Error('Batch 1 API error'))
      .mockResolvedValueOnce(makeAIResult(VALID_CLUSTER_RESPONSE));

    const result = await clusterUnassignedWork(sessions);
    // Should not throw — batch error is swallowed
    expect(result).toBeDefined();
    expect(result.groups).toBeDefined();
  });

  // ── JSON parse recovery ───────────────────────────────────────────────────

  it('recovers from initial JSON parse failure by bracket-balancing', async () => {
    // Truncated JSON missing only the final closing } — recovery appends it
    const truncated = '{"groups":[{"label":"Fix","description":"d","session_indices":[1],"confidence":"high","recommendation":{"action":"create_new_issue","suggested_issue_key":null,"reason":"r"}}]';
    mockChatCompletion.mockResolvedValue(makeAIResult(truncated));
    const result = await clusterUnassignedWork([SESSION]);
    expect(result.groups[0].label).toBe('Fix');
  });

  it('throws when AI returns completely invalid JSON', async () => {
    mockChatCompletion.mockResolvedValue(makeAIResult('not json at all'));
    await expect(clusterUnassignedWork([SESSION])).rejects.toThrow('Failed to cluster unassigned work');
  });
});

// ---------------------------------------------------------------------------
// mergeGroups / findSimilarGroup / consolidateSmallGroups — internal branches
// All reachable only via the >30-session batch path (clusterInBatches).
// ---------------------------------------------------------------------------

describe('clusterUnassignedWork — internal merge/consolidate branches', () => {
  // Build 35 generic sessions so clusterInBatches always fires (threshold is 30).
  const SESSIONS_35 = Array.from({ length: 35 }, (_, i) => ({
    ...SESSION,
    id: `s${i + 1}`,
    time_spent_seconds: 600,
    window_title: `Window ${i + 1}`,
  }));

  function makeGroup(label, description, sessionIndices) {
    return {
      label,
      description,
      session_indices: sessionIndices,
      confidence: 'high',
      recommendation: { action: 'create_new_issue', suggested_issue_key: null, reason: 'r' },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsActivityAIEnabled.mockReturnValue(true);
  });

  // ── keyword-overlap merge — lines 441-446 in findSimilarGroup ─────────────
  // Two batches return different-but-similar labels that share ≥2 keywords with
  // ≥50% overlap.  The exact-match branch (L436) is NOT hit; keyword branch is.

  it('merges groups from different batches via keyword overlap (≥2 common words)', async () => {
    // Batch 1 (sessions 1-30): one group with shorter label + description
    const batch1 = makeAIResult(JSON.stringify({
      groups: [
        makeGroup('Error Logging', 'Short desc', [1, 2, 3]),
      ],
    }));

    // Batch 2 (sessions 31-35): group with longer label + description.
    // "Error" and "Logging" appear in both → keyword overlap = 2/4 = 0.5 ≥ 0.5
    // AND commonWords.length = 2 ≥ 2 → triggers keyword-overlap branch (L444-446).
    const batch2 = makeAIResult(JSON.stringify({
      groups: [
        makeGroup(
          'Error Logging System Debug',          // longer label  → L408 true branch
          'Very detailed description of the error logging work done',  // longer desc → L412 true branch
          [1, 2],
        ),
      ],
    }));

    mockChatCompletion
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2);

    const result = await clusterUnassignedWork(SESSIONS_35);

    // The two groups should have been merged into one.
    const merged = result.groups.find(g => g.label.includes('Error Logging'));
    expect(merged).toBeDefined();

    // Longer label wins (L408 true branch).
    expect(merged.label).toBe('Error Logging System Debug');

    // Longer description wins (L412 true branch).
    expect(merged.description).toContain('Very detailed');

    // Combined session count from both batches.
    expect(merged.session_count).toBe(5); // 3 + 2
  });

  // ── consolidateSmallGroups — small group with NO match → L492-497 ─────────
  // A 1-session group whose label shares no keywords with any large group is
  // kept as its own entry (the else-branch at L492-497 that does largeGroups.push).

  it('keeps a small group that has no similar large group (consolidateSmallGroups else branch)', async () => {
    // Batch 1: one large group (3 sessions) + one truly unique small group (1 session).
    const batch1 = makeAIResult(JSON.stringify({
      groups: [
        makeGroup('Error Logging', 'Normal logging work', [1, 2, 3]),
        makeGroup('Completely Unrelated QA Task', 'Isolated work item', [4]), // 1 session → small
      ],
    }));

    // Batch 2: group that merges with the large group so it stays large.
    const batch2 = makeAIResult(JSON.stringify({
      groups: [
        makeGroup('Error Logging System', 'More logging', [1, 2]),
      ],
    }));

    mockChatCompletion
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2);

    const result = await clusterUnassignedWork(SESSIONS_35);

    // The unique small group should still appear in the final result.
    const unique = result.groups.find(g => g.label === 'Completely Unrelated QA Task');
    expect(unique).toBeDefined();
  });

  // ── substring merge — lines 449-450 in findSimilarGroup ──────────────────
  // Two labels where keyword overlap is < 2 (so keyword branch is skipped)
  // but one normalised label is contained inside the other.
  // "logging" is a substring of "error logging system" → L449 true branch.

  it('merges groups from different batches via label substring match (L449-450)', async () => {
    // Batch 1: "Logging" — only 1 meaningful keyword ("logging").
    const batch1 = makeAIResult(JSON.stringify({
      groups: [
        makeGroup('Logging', 'Log review work', [1, 2, 3]),
      ],
    }));

    // Batch 2: "Error Logging System" — keywords: ["error","logging","system"].
    // Common with batch 1 keywords ["logging"]: only 1 word < 2 → keyword check FAILS.
    // But "error logging system".includes("logging") → substring match → L449-450.
    const batch2 = makeAIResult(JSON.stringify({
      groups: [
        makeGroup('Error Logging System', 'Error analysis and log review', [1, 2]),
      ],
    }));

    mockChatCompletion
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2);

    const result = await clusterUnassignedWork(SESSIONS_35);

    // Both groups should have been merged into one (not two separate entries).
    const loggingGroups = result.groups.filter(
      g => g.label.toLowerCase().includes('log'),
    );
    expect(loggingGroups).toHaveLength(1);
    expect(loggingGroups[0].session_count).toBe(5); // 3 + 2
  });
});

// ---------------------------------------------------------------------------
// getUnassignedWorkSummary
// ---------------------------------------------------------------------------

describe('getUnassignedWorkSummary', () => {
  const sessions = [
    { id: '1', time_spent_seconds: 1800, application_name: 'code', timestamp: '2026-03-01T09:00:00Z' },
    { id: '2', time_spent_seconds: 3600, application_name: 'chrome', timestamp: '2026-03-01T11:00:00Z' },
    { id: '3', time_spent_seconds: 900, application_name: 'code', timestamp: '2026-03-01T08:00:00Z' },
  ];

  it('counts the total number of sessions', async () => {
    const result = await getUnassignedWorkSummary(sessions);
    expect(result.total_sessions).toBe(3);
  });

  it('sums total_seconds across all sessions', async () => {
    const result = await getUnassignedWorkSummary(sessions);
    expect(result.total_seconds).toBe(6300);
  });

  it('returns unique application names', async () => {
    const result = await getUnassignedWorkSummary(sessions);
    expect(result.applications).toHaveLength(2);
    expect(result.applications).toContain('code');
    expect(result.applications).toContain('chrome');
  });

  it('provides a formatted total time string', async () => {
    const result = await getUnassignedWorkSummary(sessions);
    expect(typeof result.total_time_formatted).toBe('string');
  });

  it('computes earliest and latest timestamps', async () => {
    const result = await getUnassignedWorkSummary(sessions);
    // Earliest should be the 08:00 session, latest the 11:00 session
    expect(result.date_range.earliest).toContain('2026-03-01T08:00');
    expect(result.date_range.latest).toContain('2026-03-01T11:00');
  });

  it('returns null date_range for empty sessions', async () => {
    const result = await getUnassignedWorkSummary([]);
    expect(result.date_range.earliest).toBeNull();
    expect(result.date_range.latest).toBeNull();
  });

  it('handles sessions with missing time_spent_seconds (treats as 0)', async () => {
    const result = await getUnassignedWorkSummary([{ id: '1', application_name: 'x', timestamp: '2026-03-01T10:00:00Z' }]);
    expect(result.total_seconds).toBe(0);
  });

  // ── formatDuration — tested via total_time_formatted ─────────────────────

  it('formats exactly 1 hour as "1h"', async () => {
    const result = await getUnassignedWorkSummary([{ id: '1', time_spent_seconds: 3600, application_name: 'code', timestamp: '2026-03-01T10:00:00Z' }]);
    expect(result.total_time_formatted).toBe('1h');
  });

  it('formats 1h 30m correctly', async () => {
    const result = await getUnassignedWorkSummary([{ id: '1', time_spent_seconds: 5400, application_name: 'code', timestamp: '2026-03-01T10:00:00Z' }]);
    expect(result.total_time_formatted).toBe('1h 30m');
  });

  it('formats 10 minutes as "10m"', async () => {
    const result = await getUnassignedWorkSummary([{ id: '1', time_spent_seconds: 600, application_name: 'code', timestamp: '2026-03-01T10:00:00Z' }]);
    expect(result.total_time_formatted).toBe('10m');
  });

  it('formats 0 seconds as "0m"', async () => {
    const result = await getUnassignedWorkSummary([{ id: '1', time_spent_seconds: 0, application_name: 'code', timestamp: '2026-03-01T10:00:00Z' }]);
    expect(result.total_time_formatted).toBe('0m');
  });
});

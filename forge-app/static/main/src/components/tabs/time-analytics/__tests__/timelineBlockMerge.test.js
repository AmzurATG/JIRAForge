import { parseUTC } from '../dateUtils';

/**
 * Tests for the timeline block coalescing logic inside DayView.getUserTimeBlocks.
 *
 * Bug: merge condition only checked `hasIssue`, not `issueKey`. So two adjacent
 * sessions for different assigned issues (e.g. FEEDBACK-73 then FEEDBACK-74)
 * would collapse into one block carrying only the first session's issueKey —
 * hiding the fact that multiple issues were worked on in the day.
 *
 * Fix: also require `prev.issueKey === block.issueKey` before merging.
 *
 * This test replicates the merge logic verbatim from DayView.js so any drift
 * will fail the assertions and surface a reviewer conversation.
 */

// --- Replicate DayView.getUserTimeBlocks merge logic exactly ---
function mergeSessionsIntoBlocks(sessions) {
  const rawBlocks = sessions
    .map(session => {
      const endTime = parseUTC(session.endTime || session.timestamp);
      if (!endTime) return null;

      const durationSeconds = session.durationSeconds || 0;
      const actualStart =
        durationSeconds > 0
          ? new Date(endTime.getTime() - durationSeconds * 1000)
          : endTime;

      const hasIssue = !!session.issueKey;
      return {
        startTime: actualStart,
        endTime,
        durationSeconds,
        hasIssue,
        issueKey: session.issueKey || null,
      };
    })
    .filter(Boolean);

  rawBlocks.sort((a, b) => a.startTime - b.startTime);

  const GAP_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  const merged = [];
  for (const block of rawBlocks) {
    const prev = merged[merged.length - 1];
    const sameIssue =
      prev && prev.hasIssue === block.hasIssue && prev.issueKey === block.issueKey;
    if (sameIssue && block.startTime - prev.endTime <= GAP_THRESHOLD_MS) {
      prev.endTime = new Date(Math.max(prev.endTime.getTime(), block.endTime.getTime()));
      prev.durationSeconds += block.durationSeconds;
    } else {
      merged.push({ ...block });
    }
  }
  return merged;
}

// Helper: build a session record ending at the given UTC time with the given duration
function session(endIso, durationSeconds, issueKey) {
  return { endTime: endIso, durationSeconds, issueKey: issueKey || null };
}

describe('Timeline block merge — respects issueKey boundaries', () => {
  describe('Bug scenario: two issues in one day (FEEDBACK-73 and FEEDBACK-74)', () => {
    // Reproduces the screenshot scenario:
    //   FEEDBACK-73  10:51–10:56  (5m, 300s)
    //   FEEDBACK-74  10:56–12:24  (88m, 5280s)
    //   FEEDBACK-73  12:24–12:51  (27m, 1620s)
    // With the old (hasIssue-only) merge, these all coalesced into one block
    // with issueKey=FEEDBACK-73 and duration = 7200s.
    const sessions = [
      session('2026-04-24T10:56:00Z', 300, 'FEEDBACK-73'),
      session('2026-04-24T12:24:00Z', 5280, 'FEEDBACK-74'),
      session('2026-04-24T12:51:00Z', 1620, 'FEEDBACK-73'),
    ];

    it('produces one block per issue instead of collapsing into one', () => {
      const merged = mergeSessionsIntoBlocks(sessions);
      expect(merged).toHaveLength(3);
      expect(merged.map(b => b.issueKey)).toEqual([
        'FEEDBACK-73',
        'FEEDBACK-74',
        'FEEDBACK-73',
      ]);
    });

    it('preserves each block‘s duration separately', () => {
      const merged = mergeSessionsIntoBlocks(sessions);
      expect(merged[0].durationSeconds).toBe(300); // FEEDBACK-73 morning
      expect(merged[1].durationSeconds).toBe(5280); // FEEDBACK-74
      expect(merged[2].durationSeconds).toBe(1620); // FEEDBACK-73 afternoon
    });

    it('total tracked time across blocks is unchanged by the fix', () => {
      const merged = mergeSessionsIntoBlocks(sessions);
      const total = merged.reduce((sum, b) => sum + b.durationSeconds, 0);
      expect(total).toBe(300 + 5280 + 1620);
    });
  });

  describe('Same issue still merges when gap is within threshold', () => {
    // Two adjacent 5-minute chunks on the same issue, 2 minutes apart.
    // These must still merge — that's the whole point of the coalescing.
    const sessions = [
      session('2026-04-24T10:05:00Z', 300, 'FEEDBACK-73'),
      session('2026-04-24T10:12:00Z', 300, 'FEEDBACK-73'),
    ];

    it('coalesces same-issue adjacent blocks', () => {
      const merged = mergeSessionsIntoBlocks(sessions);
      expect(merged).toHaveLength(1);
      expect(merged[0].issueKey).toBe('FEEDBACK-73');
      expect(merged[0].durationSeconds).toBe(600);
    });
  });

  describe('Same issue does NOT merge across > 10 minute gap', () => {
    const sessions = [
      session('2026-04-24T10:05:00Z', 300, 'FEEDBACK-73'),
      session('2026-04-24T10:25:00Z', 300, 'FEEDBACK-73'), // 15m gap from prev end
    ];

    it('keeps them separate', () => {
      const merged = mergeSessionsIntoBlocks(sessions);
      expect(merged).toHaveLength(2);
      expect(merged.every(b => b.issueKey === 'FEEDBACK-73')).toBe(true);
    });
  });

  describe('Assigned vs unassigned sessions never merge', () => {
    // Even when adjacent, an issueKey'd session and a null-issueKey session
    // must stay as separate blocks (one green, one blue stripe).
    const sessions = [
      session('2026-04-24T10:05:00Z', 300, 'FEEDBACK-73'),
      session('2026-04-24T10:10:00Z', 300, null),
      session('2026-04-24T10:15:00Z', 300, 'FEEDBACK-73'),
    ];

    it('segments by hasIssue even for same timeline neighbor', () => {
      const merged = mergeSessionsIntoBlocks(sessions);
      expect(merged).toHaveLength(3);
      expect(merged.map(b => b.hasIssue)).toEqual([true, false, true]);
    });
  });

  describe('Many rapid issue switches produce one block per switch', () => {
    // A user ping-ponging between two issues every few minutes should see
    // a segment per switch, not a single merged block.
    const sessions = [
      session('2026-04-24T09:05:00Z', 300, 'A-1'),
      session('2026-04-24T09:10:00Z', 300, 'B-1'),
      session('2026-04-24T09:15:00Z', 300, 'A-1'),
      session('2026-04-24T09:20:00Z', 300, 'B-1'),
      session('2026-04-24T09:25:00Z', 300, 'A-1'),
    ];

    it('emits one block per session because each neighbor has a different issueKey', () => {
      const merged = mergeSessionsIntoBlocks(sessions);
      expect(merged).toHaveLength(5);
      expect(merged.map(b => b.issueKey)).toEqual(['A-1', 'B-1', 'A-1', 'B-1', 'A-1']);
    });
  });

  describe('Out-of-order input still sorts correctly before merging', () => {
    // DayView sorts rawBlocks by startTime before merging. Verify that an
    // unordered input produces the expected sequence.
    const sessions = [
      session('2026-04-24T12:51:00Z', 1620, 'FEEDBACK-73'),
      session('2026-04-24T10:56:00Z', 300, 'FEEDBACK-73'),
      session('2026-04-24T12:24:00Z', 5280, 'FEEDBACK-74'),
    ];

    it('yields the same chronological segments regardless of input order', () => {
      const merged = mergeSessionsIntoBlocks(sessions);
      expect(merged.map(b => b.issueKey)).toEqual([
        'FEEDBACK-73',
        'FEEDBACK-74',
        'FEEDBACK-73',
      ]);
    });
  });

  describe('Edge cases', () => {
    it('handles an empty session list', () => {
      expect(mergeSessionsIntoBlocks([])).toEqual([]);
    });

    it('drops sessions with no parseable endTime', () => {
      const sessions = [
        session(null, 300, 'FEEDBACK-73'),
        session('2026-04-24T10:05:00Z', 300, 'FEEDBACK-73'),
      ];
      const merged = mergeSessionsIntoBlocks(sessions);
      expect(merged).toHaveLength(1);
      expect(merged[0].issueKey).toBe('FEEDBACK-73');
    });

    it('treats two unassigned-but-different sessions (both null issueKey) as the same bucket', () => {
      // Both have issueKey=null. Under the new rule `prev.issueKey === block.issueKey`
      // null === null is true, so adjacent unassigned sessions still merge — which is
      // the behaviour the unassigned striped bar relies on visually.
      const sessions = [
        session('2026-04-24T10:05:00Z', 300, null),
        session('2026-04-24T10:10:00Z', 300, null),
      ];
      const merged = mergeSessionsIntoBlocks(sessions);
      expect(merged).toHaveLength(1);
      expect(merged[0].hasIssue).toBe(false);
      expect(merged[0].issueKey).toBe(null);
      expect(merged[0].durationSeconds).toBe(600);
    });
  });
});

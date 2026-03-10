'use strict';

/**
 * Tests for feedback-session-store.js
 * Uses jest.useFakeTimers() to control Date.now() and setInterval timing.
 * Uses jest.resetModules() + re-require to reset the module-level sessions Map
 * and restart the cleanup interval between tests.
 */

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('feedback-session-store', () => {
  let store;
  let logger;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    // Re-require after resetModules so the sessions Map and setInterval are fresh
    store = require('../../src/services/feedback-session-store');
    logger = require('../../src/utils/logger');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── createSession ────────────────────────────────────────────────────────────

  describe('createSession', () => {
    it('returns a 32-char hex session ID', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });
      expect(typeof id).toBe('string');
      expect(id).toHaveLength(32);
      expect(/^[a-f0-9]{32}$/.test(id)).toBe(true);
    });

    it('logs creation with truncated sessionId and account_id', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-abc' }
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[FeedbackSession] Created session'),
        id.substring(0, 8),
        'user-abc'
      );
    });

    it('logs "unknown" when userInfo has no account_id', () => {
      store.createSession({ atlassianToken: 'tok', cloudId: 'cloud-1', userInfo: {} });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[FeedbackSession] Created session'),
        expect.any(String),
        'unknown'
      );
    });

    it('logs "unknown" when userInfo is null', () => {
      store.createSession({ atlassianToken: 'tok', cloudId: 'cloud-1', userInfo: null });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[FeedbackSession] Created session'),
        expect.any(String),
        'unknown'
      );
    });

    it('each call returns a unique session ID', () => {
      const id1 = store.createSession({ atlassianToken: 'a', cloudId: 'c', userInfo: {} });
      const id2 = store.createSession({ atlassianToken: 'b', cloudId: 'c', userInfo: {} });
      expect(id1).not.toBe(id2);
    });
  });

  // ── getSession ───────────────────────────────────────────────────────────────

  describe('getSession', () => {
    it('returns session data for a valid session', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });
      const session = store.getSession(id);
      expect(session).not.toBeNull();
      expect(session.atlassianToken).toBe('tok');
      expect(session.cloudId).toBe('cloud-1');
      expect(session.used).toBe(false);
    });

    it('returns null for unknown session ID', () => {
      expect(store.getSession('nonexistent-id')).toBeNull();
    });

    it('returns null and deletes session when expired', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });
      // Advance time past 30-minute TTL
      jest.advanceTimersByTime(31 * 60 * 1000);
      const result = store.getSession(id);
      expect(result).toBeNull();
      expect(logger.info).toHaveBeenCalledWith(
        '[FeedbackSession] Session %s expired',
        expect.any(String)
      );
    });

    it('returns session just before expiry', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });
      // Advance to just under 30 minutes
      jest.advanceTimersByTime(29 * 60 * 1000 + 59 * 1000);
      expect(store.getSession(id)).not.toBeNull();
    });
  });

  // ── consumeSession ───────────────────────────────────────────────────────────

  describe('consumeSession', () => {
    it('returns session data on first consume and marks it used', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });
      const session = store.consumeSession(id);
      expect(session).not.toBeNull();
      expect(session.used).toBe(true);
    });

    it('returns null on second consume (already used)', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });
      store.consumeSession(id); // first use
      const second = store.consumeSession(id);
      expect(second).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        '[FeedbackSession] Session %s already used',
        expect.any(String)
      );
    });

    it('returns null for unknown session ID', () => {
      expect(store.consumeSession('bad-id')).toBeNull();
    });

    it('returns null for expired session', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });
      jest.advanceTimersByTime(31 * 60 * 1000);
      expect(store.consumeSession(id)).toBeNull();
    });
  });

  // ── deleteSession ────────────────────────────────────────────────────────────

  describe('deleteSession', () => {
    it('removes the session so getSession returns null', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });
      store.deleteSession(id);
      expect(store.getSession(id)).toBeNull();
    });

    it('is a no-op for non-existent session IDs', () => {
      expect(() => store.deleteSession('no-such-id')).not.toThrow();
    });
  });

  // ── cleanupExpiredSessions (via setInterval) ─────────────────────────────────

  describe('cleanupExpiredSessions (via periodic timer)', () => {
    it('removes expired sessions after cleanup interval fires', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });

      // Advance past TTL so the session expires, then fire the 5-minute cleanup interval
      jest.advanceTimersByTime(31 * 60 * 1000);
      // The cleanup interval is every 5 minutes; advance another tick to fire it
      jest.advanceTimersByTime(5 * 60 * 1000);

      // Session should now be gone (cleanup deleted it)
      expect(store.getSession(id)).toBeNull();
    });

    it('logs cleanup info when expired sessions are removed', () => {
      store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });

      jest.clearAllMocks();

      // Advance past both TTL and cleanup interval
      jest.advanceTimersByTime(36 * 60 * 1000);

      // logger.info should have been called by cleanup (cleaned > 0 branch)
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[FeedbackSession] Cleaned up'),
        expect.any(Number),
        expect.any(Number)
      );
    });

    it('does not log when there are no expired sessions to clean', () => {
      // Create a session that won't expire before the cleanup fires
      store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });

      jest.clearAllMocks();
      // Only advance to the cleanup interval, not past the 30-min TTL
      jest.advanceTimersByTime(5 * 60 * 1000);

      // No cleanup info log for zero cleaned sessions
      const cleanupCalls = logger.info.mock.calls.filter(args =>
        typeof args[0] === 'string' && args[0].includes('Cleaned up')
      );
      expect(cleanupCalls).toHaveLength(0);
    });

    it('keeps active sessions after cleanup', () => {
      const id = store.createSession({
        atlassianToken: 'tok',
        cloudId: 'cloud-1',
        userInfo: { account_id: 'user-1' }
      });

      // Only advance to cleanup interval (session not yet expired)
      jest.advanceTimersByTime(5 * 60 * 1000);

      // Session should still be retrievable
      expect(store.getSession(id)).not.toBeNull();
    });
  });
});

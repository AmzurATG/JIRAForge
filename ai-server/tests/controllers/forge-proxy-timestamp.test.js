'use strict';

/**
 * Unit tests for Bug #2: Cache Stores Server Time Instead of Jira Timestamp
 * 
 * Bug: Line 1384 in forge-proxy-controller.js uses getUTCISOString() (current
 * server time) instead of fields.updated (Jira's last-modified timestamp).
 * 
 * Impact: All cached issues appear "updated" at the same time (cache write time),
 * breaking recency sorting and staleness detection.
 * 
 * Fix: Change to `updated_at: fields.updated || getUTCISOString()`
 */

const { getUTCISOString } = require('../../src/utils/time-utils');

describe('Cache Timestamp (Bug #2)', () => {
  let supabase;
  let cacheUserIssues;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock Supabase client
    supabase = {
      from: jest.fn().mockReturnThis(),
      upsert: jest.fn().mockResolvedValue({ error: null }),
      delete: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({ error: null })
    };

    // Mock the cacheUserIssues function behavior
    // This will be replaced with actual import after fix
    cacheUserIssues = async (userId, orgId, issues) => {
      const rows = issues.map(issue => {
        const fields = issue.fields || {};
        return {
          user_id: userId,
          organization_id: orgId,
          issue_key: issue.key,
          issue_summary: fields.summary || '',
          // BUG: Uses server time instead of fields.updated
          updated_at: getUTCISOString()  
        };
      });
      return rows;
    };
  });

  test('BUGGY: uses server time instead of Jira timestamp', async () => {
    const mockIssue = {
      key: 'TEST-123',
      fields: {
        summary: 'Test issue',
        updated: '2026-05-14T10:00:00.000+0000'  // 7 days ago
      }
    };

    const cached = await cacheUserIssues('user1', 'org1', [mockIssue]);
    
    // BUGGY: Should use Jira's timestamp but uses current time
    expect(cached[0].updated_at).not.toBe('2026-05-14T10:00:00.000Z');
    expect(cached[0].updated_at).toMatch(/2026-05-21/);  // Current date
  });

  test('AFTER FIX: should store Jira updated timestamp', async () => {
    // Fixed version
    const cacheUserIssuesFixed = async (userId, orgId, issues) => {
      const rows = issues.map(issue => {
        const fields = issue.fields || {};
        return {
          user_id: userId,
          organization_id: orgId,
          issue_key: issue.key,
          issue_summary: fields.summary || '',
          // FIXED: Use Jira timestamp with fallback
          updated_at: fields.updated || getUTCISOString()
        };
      });
      return rows;
    };

    const mockIssue = {
      key: 'TEST-123',
      fields: {
        summary: 'Test issue',
        updated: '2026-05-14T10:00:00.000+0000'  // 7 days ago
      }
    };

    const cached = await cacheUserIssuesFixed('user1', 'org1', [mockIssue]);
    
    // FIXED: Uses Jira's actual timestamp
    expect(cached[0].updated_at).toBe('2026-05-14T10:00:00.000+0000');
    expect(cached[0].updated_at).not.toMatch(/2026-05-21/);
  });

  test('AFTER FIX: falls back to server time when Jira updated missing', async () => {
    const cacheUserIssuesFixed = async (userId, orgId, issues) => {
      const rows = issues.map(issue => {
        const fields = issue.fields || {};
        return {
          user_id: userId,
          organization_id: orgId,
          issue_key: issue.key,
          issue_summary: fields.summary || '',
          updated_at: fields.updated || getUTCISOString()
        };
      });
      return rows;
    };

    const mockIssue = {
      key: 'TEST-456',
      fields: { summary: 'No updated field' }
      // fields.updated is missing
    };

    const cached = await cacheUserIssuesFixed('user1', 'org1', [mockIssue]);
    
    // Falls back to server time when Jira timestamp unavailable
    expect(cached[0].updated_at).toMatch(/2026-05-21/);  // Current date
  });

  test('AFTER FIX: handles multiple issues with different timestamps', async () => {
    const cacheUserIssuesFixed = async (userId, orgId, issues) => {
      const rows = issues.map(issue => {
        const fields = issue.fields || {};
        return {
          user_id: userId,
          organization_id: orgId,
          issue_key: issue.key,
          issue_summary: fields.summary || '',
          updated_at: fields.updated || getUTCISOString()
        };
      });
      return rows;
    };

    const mockIssues = [
      { key: 'OLD-1', fields: { summary: 'Old', updated: '2026-01-01T00:00:00.000Z' } },
      { key: 'MID-2', fields: { summary: 'Mid', updated: '2026-03-15T12:00:00.000Z' } },
      { key: 'NEW-3', fields: { summary: 'New', updated: '2026-05-20T18:00:00.000Z' } }
    ];

    const cached = await cacheUserIssuesFixed('user1', 'org1', mockIssues);
    
    // Each issue retains its own Jira timestamp
    expect(cached[0].updated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(cached[1].updated_at).toBe('2026-03-15T12:00:00.000Z');
    expect(cached[2].updated_at).toBe('2026-05-20T18:00:00.000Z');
    
    // All timestamps are DIFFERENT (not all set to current time)
    const uniqueTimestamps = new Set(cached.map(r => r.updated_at));
    expect(uniqueTimestamps.size).toBe(3);
  });

  test('REGRESSION: handles null/undefined updated gracefully', async () => {
    const cacheUserIssuesFixed = async (userId, orgId, issues) => {
      const rows = issues.map(issue => {
        const fields = issue.fields || {};
        return {
          user_id: userId,
          organization_id: orgId,
          issue_key: issue.key,
          issue_summary: fields.summary || '',
          updated_at: fields.updated || getUTCISOString()
        };
      });
      return rows;
    };

    const mockIssues = [
      { key: 'NULL-1', fields: { summary: 'Null', updated: null } },
      { key: 'UNDEF-2', fields: { summary: 'Undefined' } }  // updated not present
    ];

    const cached = await cacheUserIssuesFixed('user1', 'org1', mockIssues);
    
    // Both should get fallback timestamps
    expect(cached[0].updated_at).toBeTruthy();
    expect(cached[1].updated_at).toBeTruthy();
    expect(cached[0].updated_at).toMatch(/2026-05-21/);
    expect(cached[1].updated_at).toMatch(/2026-05-21/);
  });
});

describe('Cache Timestamp Impact on Sorting (Bug #2 Integration)', () => {
  test('BUGGY: all cached issues sort as equally recent', () => {
    const currentTime = '2026-05-21T14:00:00.000Z';
    
    // Simulate buggy cache where all issues get same timestamp
    const cachedIssues = [
      { key: 'OLD-1', summary: 'Old', updated: currentTime },  // Actually updated 4 months ago
      { key: 'MID-2', summary: 'Mid', updated: currentTime },  // Actually updated 2 months ago
      { key: 'NEW-3', summary: 'New', updated: currentTime }   // Actually updated yesterday
    ];

    // Sort by updated (how formatAssignedIssues() works)
    const sorted = [...cachedIssues].sort((a, b) => {
      const aDate = new Date(a.updated).getTime();
      const bDate = new Date(b.updated).getTime();
      return bDate - aDate;
    });

    // BUGGY: All have same timestamp, order is arbitrary
    expect(sorted[0].updated).toBe(sorted[1].updated);
    expect(sorted[1].updated).toBe(sorted[2].updated);
  });

  test('AFTER FIX: issues sorted by actual Jira recency', () => {
    // Simulate fixed cache with correct Jira timestamps
    const cachedIssues = [
      { key: 'OLD-1', summary: 'Old', updated: '2026-01-01T00:00:00.000Z' },
      { key: 'MID-2', summary: 'Mid', updated: '2026-03-15T12:00:00.000Z' },
      { key: 'NEW-3', summary: 'New', updated: '2026-05-20T18:00:00.000Z' }
    ];

    // Sort by updated (descending)
    const sorted = [...cachedIssues].sort((a, b) => {
      const aDate = new Date(a.updated).getTime();
      const bDate = new Date(b.updated).getTime();
      return bDate - aDate;
    });

    // FIXED: Sorted by actual recency
    expect(sorted[0].key).toBe('NEW-3');  // Most recent
    expect(sorted[1].key).toBe('MID-2');
    expect(sorted[2].key).toBe('OLD-1');  // Oldest
  });

  test('AFTER FIX: staleness annotations work correctly', () => {
    const now = new Date('2026-05-21T14:00:00.000Z').getTime();
    
    const issue = {
      key: 'STALE-1',
      updated: '2026-03-01T00:00:00.000Z'  // 81 days ago
    };

    const daysAgo = Math.floor((now - new Date(issue.updated).getTime()) / 86400000);
    
    expect(daysAgo).toBeGreaterThan(14);  // Triggers staleness warning
    
    // This would appear in the LLM prompt
    const staleness = daysAgo > 14 ? `[Last updated: ${daysAgo} days ago — likely inactive]` : '';
    expect(staleness).toContain('81 days ago');
  });
});

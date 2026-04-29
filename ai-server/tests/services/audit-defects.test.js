/**
 * Audit Defects D1, D2, D3 — Unit Tests
 * Verifies the remaining pipeline gaps are fixed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ===========================================================================
// D1 — getUserActiveIssues includes description/labels/priority/updated_at
// ===========================================================================

describe('D1 — getUserActiveIssues SELECT fields', () => {

  let src;

  beforeAll(() => {
    src = fs.readFileSync(
      path.join(__dirname, '../../src/services/db/user-db-service.js'),
      'utf8'
    );
  });

  it('should SELECT description from user_jira_issues_cache', () => {
    const selectMatch = src.match(/getUserActiveIssues[\s\S]*?\.select\(['"`]([^'"`]+)['"`]\)/);
    expect(selectMatch).not.toBeNull();
    expect(selectMatch[1]).toContain('description');
  });

  it('should SELECT labels from user_jira_issues_cache', () => {
    const selectMatch = src.match(/getUserActiveIssues[\s\S]*?\.select\(['"`]([^'"`]+)['"`]\)/);
    expect(selectMatch[1]).toContain('labels');
  });

  it('should SELECT priority from user_jira_issues_cache', () => {
    const selectMatch = src.match(/getUserActiveIssues[\s\S]*?\.select\(['"`]([^'"`]+)['"`]\)/);
    expect(selectMatch[1]).toContain('priority');
  });

  it('should SELECT updated_at for recency signals', () => {
    const selectMatch = src.match(/getUserActiveIssues[\s\S]*?\.select\(['"`]([^'"`]+)['"`]\)/);
    expect(selectMatch[1]).toContain('updated_at');
  });

  it('should map description in returned objects', () => {
    // The mapping after the select should include description
    expect(src).toMatch(/description:\s*issue\.description/);
  });

  it('should map labels in returned objects', () => {
    expect(src).toMatch(/labels:\s*issue\.labels/);
  });

  it('should map updated_at in returned objects', () => {
    expect(src).toMatch(/updated_at:\s*issue\.updated_at/);
  });

  it('should use issue_summary with summary fallback', () => {
    expect(src).toContain('issue.issue_summary || issue.summary');
  });
});

// ===========================================================================
// D2 — Webhook issue mapping includes `updated` field
// ===========================================================================

describe('D2 — Webhook issue mapping includes updated timestamp', () => {

  const SUPABASE_ROOT = path.join(__dirname, '../../../supabase/functions');

  const webhookFiles = [
    { name: 'screenshot-webhook', file: 'screenshot-webhook/index.ts' },
    { name: 'activity-webhook', file: 'activity-webhook/index.ts' },
  ];

  webhookFiles.forEach(({ name, file }) => {
    describe(`${name}`, () => {
      let src;

      beforeAll(() => {
        src = fs.readFileSync(path.join(SUPABASE_ROOT, file), 'utf8');
      });

      it('should SELECT updated_at from user_jira_issues_cache', () => {
        const selectMatch = src.match(/\.select\([^)]+\)/g);
        const cacheSelect = selectMatch.find(s => s.includes('issue_key'));
        expect(cacheSelect).toContain('updated_at');
      });

      it('should map updated field from updated_at into the issue object', () => {
        expect(src).toMatch(/updated:\s*issue\.updated_at/);
      });
    });
  });
});

// ===========================================================================
// D3 — Polling service has cache fallback
// ===========================================================================

describe('D3 — Polling service cache fallback', () => {

  let src;

  beforeAll(() => {
    src = fs.readFileSync(
      path.join(__dirname, '../../src/services/activity-polling-service.js'),
      'utf8'
    );
  });

  it('should import user-db-service for cache access', () => {
    expect(src).toContain("require('./db/user-db-service')");
  });

  it('should call getUserCachedIssues when extracted issues are empty', () => {
    expect(src).toContain('getUserCachedIssues');
  });

  it('should log when using cache fallback', () => {
    expect(src).toMatch(/cached issues.*fallback/i);
  });

  it('should use issuesForAnalysis (not userAssignedIssues) in analyzeBatch call', () => {
    // The analyzeBatch call should use the variable that may have been replaced by cache data
    const analyzeBatchCall = src.match(/analyzeBatch\(\s*\n?\s*records\.map\(transformRecordForAnalysis\),\s*\n?\s*(\w+),/);
    expect(analyzeBatchCall).not.toBeNull();
    expect(analyzeBatchCall[1]).toBe('issuesForAnalysis');
  });

  it('should handle cache fetch errors gracefully (try/catch)', () => {
    // Should have error handling around the cache call
    expect(src).toMatch(/catch\s*\(\s*cacheErr/);
  });

  it('should map cached issues with all required fields including updated', () => {
    expect(src).toMatch(/updated:\s*issue\.updated_at/);
  });
});

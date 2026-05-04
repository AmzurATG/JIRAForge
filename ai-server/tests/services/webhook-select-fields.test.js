/**
 * P1 — Webhook SELECT fields contract
 *
 * Verifies that the webhook TypeScript files include the required fields
 * (description, labels, priority) in their SELECT queries and mappings.
 *
 * Since the webhooks run in Supabase Edge Functions (Deno), we test by
 * verifying the source code contains the correct SELECT and mapping patterns.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SUPABASE_ROOT = path.join(__dirname, '../../../supabase/functions');

describe('Webhook SELECT fields contract (P1)', () => {

  const webhookFiles = [
    {
      name: 'screenshot-webhook',
      file: 'screenshot-webhook/index.ts',
    },
    {
      name: 'activity-webhook',
      file: 'activity-webhook/index.ts',
    },
  ];

  webhookFiles.forEach(({ name, file }) => {
    describe(`${name}`, () => {
      let src;

      beforeAll(() => {
        src = fs.readFileSync(path.join(SUPABASE_ROOT, file), 'utf8');
      });

      it('should SELECT description from user_jira_issues_cache', () => {
        // The .select() call must include 'description'
        const selectMatch = src.match(/\.select\([^)]+\)/g);
        expect(selectMatch).not.toBeNull();

        const cacheSelect = selectMatch.find(s => s.includes('issue_key'));
        expect(cacheSelect).toBeDefined();
        expect(cacheSelect).toContain('description');
      });

      it('should SELECT labels from user_jira_issues_cache', () => {
        const selectMatch = src.match(/\.select\([^)]+\)/g);
        const cacheSelect = selectMatch.find(s => s.includes('issue_key'));
        expect(cacheSelect).toContain('labels');
      });

      it('should SELECT priority from user_jira_issues_cache', () => {
        const selectMatch = src.match(/\.select\([^)]+\)/g);
        const cacheSelect = selectMatch.find(s => s.includes('issue_key'));
        expect(cacheSelect).toContain('priority');
      });

      it('should SELECT both issue_summary and summary for column unification', () => {
        const selectMatch = src.match(/\.select\([^)]+\)/g);
        const cacheSelect = selectMatch.find(s => s.includes('issue_key'));
        expect(cacheSelect).toContain('issue_summary');
        expect(cacheSelect).toContain('summary');
      });

      it('should map description into the issue object', () => {
        expect(src).toContain('description: issue.description');
      });

      it('should map labels into the issue object', () => {
        expect(src).toContain('labels: issue.labels');
      });

      it('should use issue_summary with summary fallback', () => {
        expect(src).toContain('issue.issue_summary || issue.summary');
      });
    });
  });
});

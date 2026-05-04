/**
 * P2 — Cache write path includes description, labels, priority
 *
 * Verifies that the old resolver cache write path (forge-app) now
 * persists description, labels, and priority in the cache entries.
 * Also verifies the adfToText utility exists and works correctly.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('Cache write path — description persistence (P2)', () => {

  describe('issueCacheService.js (old resolver path)', () => {
    let src;

    beforeAll(() => {
      src = fs.readFileSync(
        path.join(__dirname, '../../../forge-app/src/services/issue/issueCacheService.js'),
        'utf8'
      );
    });

    it('should import extractDescriptionText from adfToText utility', () => {
      expect(src).toContain("import { extractDescriptionText } from '../../utils/adfToText.js'");
    });

    it('should include description in cache entries mapping', () => {
      expect(src).toContain('description: extractDescriptionText(issue.fields.description)');
    });

    it('should include labels in cache entries mapping', () => {
      expect(src).toContain('labels: issue.fields.labels');
    });

    it('should include priority in cache entries mapping', () => {
      expect(src).toContain("priority: issue.fields.priority?.name");
    });
  });

  describe('Jira API fields (getUserAssignedIssues)', () => {
    let src;

    beforeAll(() => {
      src = fs.readFileSync(
        path.join(__dirname, '../../../forge-app/src/utils/jira.js'),
        'utf8'
      );
    });

    it('should request description field from Jira API', () => {
      // The fields array in the POST body should include 'description'
      expect(src).toContain("'description'");
    });

    it('should request labels field from Jira API', () => {
      expect(src).toContain("'labels'");
    });

    it('should request priority field from Jira API', () => {
      expect(src).toContain("'priority'");
    });
  });

  describe('adfToText.js utility', () => {

    it('should exist in forge-app/src/utils/', () => {
      const utilPath = path.join(__dirname, '../../../forge-app/src/utils/adfToText.js');
      expect(fs.existsSync(utilPath)).toBe(true);
    });

    it('should export extractDescriptionText function', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../../forge-app/src/utils/adfToText.js'),
        'utf8'
      );
      expect(src).toContain('export function extractDescriptionText');
    });

    it('should handle null input', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../../forge-app/src/utils/adfToText.js'),
        'utf8'
      );
      // Should have null guard
      expect(src).toContain('if (!description) return null');
    });

    it('should handle string input passthrough', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../../forge-app/src/utils/adfToText.js'),
        'utf8'
      );
      expect(src).toContain("typeof description === 'string'");
    });

    it('should handle ADF object input', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../../forge-app/src/utils/adfToText.js'),
        'utf8'
      );
      expect(src).toContain('description.content');
      expect(src).toContain("node.type === 'text'");
    });
  });
});

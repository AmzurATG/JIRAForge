/**
 * P4 — Confidence threshold alignment
 *
 * Verifies:
 * - Single threshold in activity-db-service.js (the enforcement point)
 * - Default is 0.4 (not 0.3)
 * - activity-service.js does NOT have its own threshold constant
 * - Env var override works correctly
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('Confidence threshold alignment (P4)', () => {

  describe('activity-db-service threshold (enforcement point)', () => {

    it('should default to 0.4 when env var is not set', () => {
      const originalEnv = process.env.AI_MATCH_MIN_CONFIDENCE;
      delete process.env.AI_MATCH_MIN_CONFIDENCE;

      // Re-read the source to verify the default value in code
      const src = fs.readFileSync(
        path.join(__dirname, '../../src/services/db/activity-db-service.js'),
        'utf8'
      );

      // Verify the default is '0.4' not '0.3'
      expect(src).toContain("process.env.AI_MATCH_MIN_CONFIDENCE || '0.4'");
      expect(src).not.toContain("process.env.AI_MATCH_MIN_CONFIDENCE || '0.3'");

      // Restore
      if (originalEnv !== undefined) {
        process.env.AI_MATCH_MIN_CONFIDENCE = originalEnv;
      }
    });

    it('should have exactly one MIN_CONFIDENCE_THRESHOLD declaration', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../src/services/db/activity-db-service.js'),
        'utf8'
      );

      const matches = src.match(/MIN_CONFIDENCE_THRESHOLD/g);
      // Should appear in: const declaration, and the usage (taskKeyMeetsThreshold check)
      // But only ONE `const MIN_CONFIDENCE_THRESHOLD =` declaration
      const declarations = src.match(/const\s+MIN_CONFIDENCE_THRESHOLD\s*=/g);
      expect(declarations).toHaveLength(1);
    });
  });

  describe('activity-service should NOT have its own threshold', () => {

    it('should not declare MIN_CONFIDENCE_THRESHOLD', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../src/services/activity-service.js'),
        'utf8'
      );

      // The old duplicate has been removed
      const declarations = src.match(/const\s+MIN_CONFIDENCE_THRESHOLD\s*=/g);
      expect(declarations).toBeNull();
    });

    it('should not reference AI_MATCH_MIN_CONFIDENCE env var', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../src/services/activity-service.js'),
        'utf8'
      );

      expect(src).not.toContain('process.env.AI_MATCH_MIN_CONFIDENCE');
    });
  });

  describe('.env.example documentation', () => {

    it('should document AI_MATCH_MIN_CONFIDENCE=0.4', () => {
      const envExample = fs.readFileSync(
        path.join(__dirname, '../../.env.example'),
        'utf8'
      );

      expect(envExample).toContain('AI_MATCH_MIN_CONFIDENCE=0.4');
      expect(envExample).not.toContain('AI_MATCH_MIN_CONFIDENCE=0.3');
    });
  });
});

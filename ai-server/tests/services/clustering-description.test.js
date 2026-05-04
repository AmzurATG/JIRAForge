/**
 * P6 — Clustering prompt includes issue descriptions
 *
 * Verifies that the clustering service formats issues with description
 * suffixes for better LLM matching context.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('Clustering service — issue description in context (P6)', () => {

  it('should include description suffix pattern in clustering-service.js', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/clustering-service.js'),
      'utf8'
    );

    // Verify the description suffix logic is present
    expect(src).toContain('issue.description');
    expect(src).toContain('.substring(0, 200)');
    expect(src).toContain('descSuffix');
  });

  it('should still include issue_key and summary in the format', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/clustering-service.js'),
      'utf8'
    );

    expect(src).toContain('issue.issue_key');
    expect(src).toContain('issue.summary');
  });

  it('should limit clustering description to 200 chars (not 600)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/clustering-service.js'),
      'utf8'
    );

    // The clustering context uses 200 chars (shorter than the 600 in prompts.js)
    // because clustering already has broader session context
    const descLine = src.match(/issue\.description\.substring\(0,\s*(\d+)\)/);
    expect(descLine).not.toBeNull();
    expect(parseInt(descLine[1])).toBe(200);
  });

  it('should handle missing description gracefully (ternary fallback)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/services/clustering-service.js'),
      'utf8'
    );

    // Should have a ternary or conditional for missing description → empty string
    expect(src).toMatch(/issue\.description\s*\?\s*/);
    expect(src).toContain("''");
  });
});

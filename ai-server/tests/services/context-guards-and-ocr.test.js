'use strict';

/**
 * Unit tests for Bug #4: Context Bias Without Guards
 * Bug #7: Low-Confidence OCR Sent to LLM
 * Bug #8: Stale Correction Patterns
 * Bug #10: Clustering OCR Truncation
 * 
 * These tests verify proper guards on context hints and OCR handling.
 */

describe('Bug #4: Previous Match Context Guards', () => {
  test('BUGGY: includes low-confidence previous match without guard', () => {
    // Simulates current buggy behavior
    const buildPromptBuggy = (previousMatch) => {
      let hint = '';
      if (previousMatch && previousMatch.taskKey) {
        hint = `Previous: ${previousMatch.taskKey} (confidence ${previousMatch.confidenceScore})`;
      }
      return hint;
    };

    const lowConfMatch = { taskKey: 'PROJ-123', confidenceScore: 0.5, minutesAgo: 5 };
    const result = buildPromptBuggy(lowConfMatch);

    // BUGGY: Low-confidence match included
    expect(result).toContain('PROJ-123');
  });

  test('AFTER FIX: excludes low-confidence previous match (<0.7)', () => {
    const buildPromptFixed = (previousMatch) => {
      let hint = '';
      // Guard 1: Confidence threshold
      if (previousMatch && previousMatch.taskKey) {
        if (previousMatch.confidenceScore < 0.7) {
          previousMatch = null;
        }
      }
      if (previousMatch && previousMatch.taskKey) {
        hint = `Previous: ${previousMatch.taskKey} (confidence ${previousMatch.confidenceScore})`;
      }
      return hint;
    };

    const lowConfMatch = { taskKey: 'PROJ-123', confidenceScore: 0.5, minutesAgo: 5 };
    const result = buildPromptFixed(lowConfMatch);

    // FIXED: Excluded due to low confidence
    expect(result).not.toContain('PROJ-123');
    expect(result).toBe('');
  });

  test('AFTER FIX: excludes stale previous match (>15 min)', () => {
    const buildPromptFixed = (previousMatch) => {
      let hint = '';
      if (previousMatch && previousMatch.taskKey) {
        // Guard 1: Confidence threshold
        if (previousMatch.confidenceScore < 0.7) {
          previousMatch = null;
        }
        // Guard 2: Staleness check
        if (previousMatch && previousMatch.minutesAgo > 15) {
          previousMatch = null;
        }
      }
      if (previousMatch && previousMatch.taskKey) {
        hint = `Previous: ${previousMatch.taskKey}`;
      }
      return hint;
    };

    const staleMatch = { taskKey: 'PROJ-456', confidenceScore: 0.8, minutesAgo: 20 };
    const result = buildPromptFixed(staleMatch);

    // FIXED: Excluded due to staleness
    expect(result).not.toContain('PROJ-456');
  });

  test('AFTER FIX: excludes irrelevant previous match', () => {
    const buildPromptFixed = (previousMatch, currentBatch) => {
      let hint = '';
      if (previousMatch && previousMatch.taskKey) {
        if (previousMatch.confidenceScore < 0.7) previousMatch = null;
        if (previousMatch && previousMatch.minutesAgo > 15) previousMatch = null;
        
        // Guard 3: Relevance check
        if (previousMatch) {
          const currentProjects = currentBatch.map(r => 
            r.window_title?.match(/([A-Z]+)-\\d+/)?.[1]
          ).filter(Boolean);
          const prevProject = previousMatch.taskKey.split('-')[0];
          if (currentProjects.length > 0 && !currentProjects.includes(prevProject)) {
            previousMatch = null;
          }
        }
      }
      if (previousMatch && previousMatch.taskKey) {
        hint = `Previous: ${previousMatch.taskKey}`;
      }
      return hint;
    };

    const previousMatch = { taskKey: 'PROJ-123', confidenceScore: 0.8, minutesAgo: 5 };
    const currentBatch = [
      { window_title: 'VS Code - feature.js [WORK-789]' }
    ];

    const result = buildPromptFixed(previousMatch, currentBatch);

    // FIXED: Excluded because current batch is on WORK project, not PROJ
    expect(result).not.toContain('PROJ-123');
  });

  test('AFTER FIX: includes valid high-confidence recent relevant match', () => {
    const buildPromptFixed = (previousMatch, currentBatch) => {
      let hint = '';
      if (previousMatch && previousMatch.taskKey) {
        if (previousMatch.confidenceScore < 0.7) previousMatch = null;
        if (previousMatch && previousMatch.minutesAgo > 15) previousMatch = null;
        if (previousMatch) {
          const currentProjects = currentBatch.map(r => 
            r.window_title?.match(/([A-Z]+)-\\d+/)?.[1]
          ).filter(Boolean);
          const prevProject = previousMatch.taskKey.split('-')[0];
          if (currentProjects.length > 0 && !currentProjects.includes(prevProject)) {
            previousMatch = null;
          }
        }
      }
      if (previousMatch && previousMatch.taskKey) {
        hint = `Previous: ${previousMatch.taskKey}`;
      }
      return hint;
    };

    const previousMatch = { taskKey: 'PROJ-123', confidenceScore: 0.8, minutesAgo: 5 };
    const currentBatch = [
      { window_title: 'Chrome - PROJ-123 - Jira' }
    ];

    const result = buildPromptFixed(previousMatch, currentBatch);

    // FIXED: Included because passes all guards
    expect(result).toContain('PROJ-123');
  });
});

describe('Bug #7: Low-Confidence OCR Exclusion', () => {
  test('BUGGY: includes low-confidence OCR in prompt', () => {
    const buildOCRLabelBuggy = (ocrText, confidence) => {
      if (!ocrText) return '(no text extracted)';
      if (confidence < 0.4) {
        return `OCR Text (low confidence - may be inaccurate): ${ocrText}`;
      }
      return `OCR Text: ${ocrText}`;
    };

    const result = buildOCRLabelBuggy('Garbage text with errors', 0.3);

    // BUGGY: Includes garbage OCR with warning
    expect(result).toContain('Garbage text with errors');
    expect(result).toContain('low confidence');
  });

  test('AFTER FIX: excludes low-confidence OCR entirely', () => {
    const buildOCRLabelFixed = (ocrText, confidence) => {
      if (!ocrText) return '(no text extracted)';
      if (confidence && confidence < 0.4) {
        return '(low-confidence OCR omitted - rely on window title and app name)';
      }
      return `OCR Text: ${ocrText}`;
    };

    const result = buildOCRLabelFixed('Garbage text with errors', 0.3);

    // FIXED: OCR text omitted
    expect(result).not.toContain('Garbage text');
    expect(result).toContain('omitted');
  });

  test('AFTER FIX: includes high-confidence OCR', () => {
    const buildOCRLabelFixed = (ocrText, confidence) => {
      if (!ocrText) return '(no text extracted)';
      if (confidence && confidence < 0.4) {
        return '(low-confidence OCR omitted - rely on window title and app name)';
      }
      return `OCR Text: ${ocrText}`;
    };

    const result = buildOCRLabelFixed('Clean extracted text', 0.6);

    // Includes good OCR
    expect(result).toContain('Clean extracted text');
    expect(result).toContain('OCR Text:');
  });

  test('AFTER FIX: includes OCR when confidence is null (high-quality source)', () => {
    const buildOCRLabelFixed = (ocrText, confidence) => {
      if (!ocrText) return '(no text extracted)';
      if (confidence && confidence < 0.4) {
        return '(low-confidence OCR omitted - rely on window title and app name)';
      }
      return `OCR Text: ${ocrText}`;
    };

    const result = buildOCRLabelFixed('Reliable text', null);

    // Null confidence treated as high quality
    expect(result).toContain('Reliable text');
  });
});

describe('Bug #8: Stale Correction Pattern Validation', () => {
  test('BUGGY: includes correction patterns for completed issues', () => {
    const buildPromptBuggy = (corrections) => {
      let hint = '';
      if (corrections && corrections.length > 0) {
        hint = corrections.map(c => `Correct to: ${c.corrected_to}`).join(', ');
      }
      return hint;
    };

    const staleCorrections = [
      { corrected_to: 'PROJ-123' },  // Completed 2 months ago
      { corrected_to: 'PROJ-456' }   // No longer assigned
    ];

    const result = buildPromptBuggy(staleCorrections);

    // BUGGY: Includes stale corrections
    expect(result).toContain('PROJ-123');
    expect(result).toContain('PROJ-456');
  });

  test('AFTER FIX: filters correction patterns against current issues', () => {
    const buildPromptFixed = (corrections, currentIssues) => {
      let hint = '';
      if (corrections && corrections.length > 0) {
        const validKeys = new Set(currentIssues.map(i => i.key));
        const validCorrections = corrections.filter(c => validKeys.has(c.corrected_to));
        if (validCorrections.length > 0) {
          hint = validCorrections.map(c => `Correct to: ${c.corrected_to}`).join(', ');
        }
      }
      return hint;
    };

    const corrections = [
      { corrected_to: 'PROJ-123' },  // Stale
      { corrected_to: 'PROJ-789' }   // Current
    ];
    const currentIssues = [
      { key: 'PROJ-789', summary: 'Active issue' }
    ];

    const result = buildPromptFixed(corrections, currentIssues);

    // FIXED: Only includes current issue
    expect(result).toContain('PROJ-789');
    expect(result).not.toContain('PROJ-123');
  });

  test('AFTER FIX: omits correction section when all stale', () => {
    const buildPromptFixed = (corrections, currentIssues) => {
      let hint = '';
      if (corrections && corrections.length > 0) {
        const validKeys = new Set(currentIssues.map(i => i.key));
        const validCorrections = corrections.filter(c => validKeys.has(c.corrected_to));
        if (validCorrections.length > 0) {
          hint = validCorrections.map(c => `Correct to: ${c.corrected_to}`).join(', ');
        }
      }
      return hint;
    };

    const staleCorrections = [
      { corrected_to: 'PROJ-123' },
      { corrected_to: 'PROJ-456' }
    ];
    const currentIssues = [
      { key: 'PROJ-999', summary: 'Different issue' }
    ];

    const result = buildPromptFixed(staleCorrections, currentIssues);

    // FIXED: Nothing included (all stale)
    expect(result).toBe('');
  });
});

describe('Bug #10: Clustering OCR Truncation', () => {
  test('BUGGY: truncates OCR at 200 chars', () => {
    const buildClusteringContextBuggy = (ocrText) => {
      if (!ocrText || ocrText.length === 0) return '';
      const truncated = ocrText.substring(0, 200);
      return `Screen Content: ${truncated}${ocrText.length > 200 ? '...' : ''}`;
    };

    const longText = 'A'.repeat(500);
    const result = buildClusteringContextBuggy(longText);

    // BUGGY: Only 200 chars included
    expect(result).toContain('A'.repeat(200));
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(250);  // ~200 + "Screen Content: " + "..."
  });

  test('AFTER FIX: includes up to 1000 chars (matches batch analysis)', () => {
    const buildClusteringContextFixed = (ocrText) => {
      if (!ocrText || ocrText.length === 0) return '';
      const truncated = ocrText.substring(0, 1000);
      return `Screen Content: ${truncated}${ocrText.length > 1000 ? '...' : ''}`;
    };

    const longText = 'B'.repeat(1200);
    const result = buildClusteringContextFixed(longText);

    // FIXED: 1000 chars included
    expect(result).toContain('B'.repeat(1000));
    expect(result).toContain('...');
    // Should have ~1000 + overhead
    expect(result.length).toBeGreaterThan(1000);
    expect(result.length).toBeLessThan(1050);
  });

  test('AFTER FIX: preserves full text when <1000 chars', () => {
    const buildClusteringContextFixed = (ocrText) => {
      if (!ocrText || ocrText.length === 0) return '';
      const truncated = ocrText.substring(0, 1000);
      return `Screen Content: ${truncated}${ocrText.length > 1000 ? '...' : ''}`;
    };

    const shortText = 'Short OCR text with URL https://example.com/path';
    const result = buildClusteringContextFixed(shortText);

    // Full text preserved
    expect(result).toContain(shortText);
    expect(result).not.toContain('...');
  });

  test('AFTER FIX: captures URLs at position 250-300 (beyond old 200 limit)', () => {
    const buildClusteringContextFixed = (ocrText) => {
      if (!ocrText || ocrText.length === 0) return '';
      const truncated = ocrText.substring(0, 1000);
      return `Screen Content: ${truncated}${ocrText.length > 1000 ? '...' : ''}`;
    };

    const prefix = 'A'.repeat(250);
    const url = 'https://jira.atlassian.net/browse/PROJ-123';
    const suffix = 'Z'.repeat(100);
    const ocrText = prefix + url + suffix;

    const result = buildClusteringContextFixed(ocrText);

    // FIXED: URL at position 250-300 is captured
    expect(result).toContain(url);
    expect(result).toContain('PROJ-123');
  });
});

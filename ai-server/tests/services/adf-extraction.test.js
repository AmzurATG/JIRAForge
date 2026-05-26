'use strict';

/**
 * Unit tests for Bug #1: Non-Recursive ADF Extraction
 * Tests the correct recursive extraction of text from nested ADF structures.
 * 
 * Bug: ai-server only extracts 2 levels (doc → block → node), missing nested
 * content like bulletList → listItem → paragraph → text (3+ levels).
 * 
 * Fix: Use forge-app's recursive walk() implementation.
 */

describe('ADF Extraction (Bug #1) - Before Fix', () => {
  // This test documents the BUGGY behavior before the fix
  test('BUGGY: shallow extraction misses nested bullet list text', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Steps to reproduce:' }] },
        {
          type: 'bulletList',
          content: [
            { 
              type: 'listItem', 
              content: [{ 
                type: 'paragraph', 
                content: [{ type: 'text', text: 'Click Settings' }] 
              }] 
            },
            { 
              type: 'listItem', 
              content: [{ 
                type: 'paragraph', 
                content: [{ type: 'text', text: 'Select Database' }] 
              }] 
            }
          ]
        }
      ]
    };

    // Simulate buggy 2-level extraction
    function buggyExtract(description) {
      if (!description || !description.content) return null;
      const parts = [];
      for (const block of description.content) {
        for (const node of (block.content || [])) {
          if (node.type === 'text' && node.text) parts.push(node.text);
        }
      }
      return parts.join(' ').trim() || null;
    }

    const result = buggyExtract(adf);
    
    // BUGGY: Only extracts "Steps to reproduce:", misses list items
    expect(result).toBe('Steps to reproduce:');
    expect(result).not.toContain('Click Settings');
    expect(result).not.toContain('Select Database');
  });
});

// After fix is applied, these tests should pass
describe('ADF Extraction (Bug #1) - After Fix', () => {
  // We'll import the fixed version after implementation
  let extractDescriptionText;

  beforeAll(() => {
    // This will be updated to import from ai-server/src/utils/adfToText.js after fix
    // For now, we inline the correct implementation for testing
    function walk(node, parts) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'text' && typeof node.text === 'string' && node.text) {
        parts.push(node.text);
        return;
      }
      if (Array.isArray(node.content)) {
        for (const child of node.content) walk(child, parts);
      }
    }

    extractDescriptionText = function(description) {
      if (!description) return null;
      if (typeof description === 'string') return description;
      if (!description.content) return null;
      const parts = [];
      walk(description, parts);
      return parts.join(' ').trim() || null;
    };
  });

  test('extracts text from 4-level nested bullet list', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Steps to reproduce:' }] },
        {
          type: 'bulletList',
          content: [
            { 
              type: 'listItem', 
              content: [{ 
                type: 'paragraph', 
                content: [{ type: 'text', text: 'Click Settings' }] 
              }] 
            },
            { 
              type: 'listItem', 
              content: [{ 
                type: 'paragraph', 
                content: [{ type: 'text', text: 'Select Database' }] 
              }] 
            }
          ]
        }
      ]
    };

    const result = extractDescriptionText(adf);
    
    expect(result).toContain('Steps to reproduce:');
    expect(result).toContain('Click Settings');
    expect(result).toContain('Select Database');
  });

  test('extracts text from table structure (4+ levels)', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'table',
        content: [{
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Cell content 1' }]
              }]
            },
            {
              type: 'tableCell',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'Cell content 2' }]
              }]
            }
          ]
        }]
      }]
    };

    const result = extractDescriptionText(adf);
    
    expect(result).toContain('Cell content 1');
    expect(result).toContain('Cell content 2');
  });

  test('extracts text from panel (3 levels)', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'panel',
        attrs: { panelType: 'info' },
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'Important note in panel' }]
        }]
      }]
    };

    const result = extractDescriptionText(adf);
    
    expect(result).toBe('Important note in panel');
  });

  test('extracts code block text', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'codeBlock',
        attrs: { language: 'javascript' },
        content: [{ type: 'text', text: 'const x = 5;' }]
      }]
    };

    const result = extractDescriptionText(adf);
    
    expect(result).toBe('const x = 5;');
  });

  test('handles deeply nested ordered lists', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'First item' }]
            }]
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Second item with nested list:' }]
              },
              {
                type: 'bulletList',
                content: [{
                  type: 'listItem',
                  content: [{
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Nested bullet point' }]
                  }]
                }]
              }
            ]
          }
        ]
      }]
    };

    const result = extractDescriptionText(adf);
    
    expect(result).toContain('First item');
    expect(result).toContain('Second item with nested list:');
    expect(result).toContain('Nested bullet point');
  });

  test('REGRESSION: simple 2-level paragraphs still work', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] }
      ]
    };

    const result = extractDescriptionText(adf);
    
    expect(result).toBe('First paragraph Second paragraph');
  });

  test('returns null for empty description', () => {
    expect(extractDescriptionText(null)).toBeNull();
    expect(extractDescriptionText(undefined)).toBeNull();
    expect(extractDescriptionText({})).toBeNull();
  });

  test('handles string descriptions (legacy format)', () => {
    const result = extractDescriptionText('Plain text description');
    expect(result).toBe('Plain text description');
  });

  test('handles mixed content types', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Heading' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Paragraph text' }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'code snippet' }] },
        {
          type: 'bulletList',
          content: [{
            type: 'listItem',
            content: [{
              type: 'paragraph',
              content: [{ type: 'text', text: 'List item' }]
            }]
          }]
        }
      ]
    };

    const result = extractDescriptionText(adf);
    
    expect(result).toContain('Heading');
    expect(result).toContain('Paragraph text');
    expect(result).toContain('code snippet');
    expect(result).toContain('List item');
  });
});

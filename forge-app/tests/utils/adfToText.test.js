'use strict';

/**
 * Tests for the recursive ADF → text walker.
 *
 * Originally only walked one level deep, which silently produced empty strings
 * for the most common ADF shapes (lists, tables, panels, code blocks). This
 * suite locks the recursive behaviour in place.
 */

import { extractDescriptionText } from '../../src/utils/adfToText.js';

describe('extractDescriptionText — primitive inputs', () => {
  it('returns null for null', () => {
    expect(extractDescriptionText(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(extractDescriptionText(undefined)).toBeNull();
  });

  it('returns the input unchanged for a plain string', () => {
    expect(extractDescriptionText('plain description')).toBe('plain description');
  });

  it('returns null for an object without content', () => {
    expect(extractDescriptionText({ type: 'doc' })).toBeNull();
  });
});

describe('extractDescriptionText — flat ADF (1 level)', () => {
  it('extracts text from a single paragraph', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] },
      ],
    };
    expect(extractDescriptionText(adf)).toBe('hello world');
  });

  it('joins text nodes from multiple top-level paragraphs', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
      ],
    };
    expect(extractDescriptionText(adf)).toBe('first second');
  });
});

describe('extractDescriptionText — nested ADF (this is the bug fix)', () => {
  it('extracts text from inside a bullet list (3 levels deep)', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'item 1' }] },
              ],
            },
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'item 2' }] },
              ],
            },
          ],
        },
      ],
    };
    expect(extractDescriptionText(adf)).toBe('item 1 item 2');
  });

  it('extracts text from inside an ordered list', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'step one' }] },
              ],
            },
          ],
        },
      ],
    };
    expect(extractDescriptionText(adf)).toBe('step one');
  });

  it('extracts text from inside a panel', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'panel',
          attrs: { panelType: 'info' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'note: be careful' }] },
          ],
        },
      ],
    };
    expect(extractDescriptionText(adf)).toBe('note: be careful');
  });

  it('extracts text from inside a table (4 levels deep)', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'cell A' }] },
                  ],
                },
                {
                  type: 'tableCell',
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'cell B' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(extractDescriptionText(adf)).toBe('cell A cell B');
  });

  it('extracts text from a mixed document (paragraph + list + panel)', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'overview' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'first point' }] },
              ],
            },
          ],
        },
        {
          type: 'panel',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'warning' }] },
          ],
        },
      ],
    };
    expect(extractDescriptionText(adf)).toBe('overview first point warning');
  });

  it('skips nodes without text and never crashes on non-text leaves', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'hardBreak' }, { type: 'text', text: 'real text' }] },
        { type: 'rule' }, // horizontal rule, no text
      ],
    };
    expect(extractDescriptionText(adf)).toBe('real text');
  });

  it('handles empty content arrays without throwing', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [] },
        { type: 'paragraph' }, // no content key at all
      ],
    };
    expect(extractDescriptionText(adf)).toBeNull();
  });

  it('preserves text inside nested marks (e.g. bold within paragraph)', () => {
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'this is' },
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: 'text' },
          ],
        },
      ],
    };
    // Walker joins text nodes with spaces; downstream consumer is the LLM
    // matching prompt which tolerates extra whitespace.
    expect(extractDescriptionText(adf)).toBe('this is bold text');
  });
});

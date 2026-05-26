'use strict';

const {
  markdownToADF,
  validateADF,
  adfToText
} = require('../../src/utils/adfBuilder.js');

describe('markdownToADF', () => {
  test('returns a valid doc with an empty paragraph for empty input', () => {
    const adf = markdownToADF('');
    expect(adf.type).toBe('doc');
    expect(adf.version).toBe(1);
    expect(adf.content).toHaveLength(1);
    expect(adf.content[0].type).toBe('paragraph');
    expect(validateADF(adf)).toBe(true);
  });

  test('returns a valid doc when input is null / undefined', () => {
    expect(validateADF(markdownToADF(null))).toBe(true);
    expect(validateADF(markdownToADF(undefined))).toBe(true);
  });

  test('builds heading nodes at levels 1-3', () => {
    const adf = markdownToADF('# H1\n## H2\n### H3');
    const headings = adf.content.filter(n => n.type === 'heading');
    expect(headings).toHaveLength(3);
    expect(headings[0].attrs.level).toBe(1);
    expect(headings[1].attrs.level).toBe(2);
    expect(headings[2].attrs.level).toBe(3);
    expect(headings[0].content[0].text).toBe('H1');
  });

  test('builds paragraphs separated by blank lines', () => {
    const adf = markdownToADF('Hello world\n\nSecond paragraph');
    const paragraphs = adf.content.filter(n => n.type === 'paragraph');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].content[0].text).toBe('Hello world');
    expect(paragraphs[1].content[0].text).toBe('Second paragraph');
  });

  test('builds bullet lists from "- " and "* " prefixes', () => {
    const adf = markdownToADF('- one\n- two\n* three');
    const list = adf.content.find(n => n.type === 'bulletList');
    expect(list).toBeDefined();
    expect(list.content).toHaveLength(3);
    expect(list.content[0].type).toBe('listItem');
    expect(list.content[0].content[0].content[0].text).toBe('one');
    expect(list.content[2].content[0].content[0].text).toBe('three');
  });

  test('builds ordered lists from "1. ", "2. " prefixes', () => {
    const adf = markdownToADF('1. first\n2. second\n3. third');
    const list = adf.content.find(n => n.type === 'orderedList');
    expect(list).toBeDefined();
    expect(list.content).toHaveLength(3);
    expect(list.content[1].content[0].content[0].text).toBe('second');
  });

  test('mixed content produces multiple nodes in order', () => {
    const adf = markdownToADF('# Title\n\nIntro text.\n\n## Steps\n1. open\n2. click\n\n## Notes\n- alpha\n- beta');
    const types = adf.content.map(n => n.type);
    expect(types).toEqual(expect.arrayContaining([
      'heading', 'paragraph', 'heading', 'orderedList', 'heading', 'bulletList'
    ]));
  });

  test('produced doc is always valid', () => {
    for (const sample of ['', 'plain', '# h\n- a\n- b', '1. one\n2. two']) {
      expect(validateADF(markdownToADF(sample))).toBe(true);
    }
  });
});

describe('validateADF', () => {
  test('rejects non-objects', () => {
    expect(validateADF(null)).toBe(false);
    expect(validateADF(undefined)).toBe(false);
    expect(validateADF('string')).toBe(false);
  });

  test('rejects doc with wrong type / version', () => {
    expect(validateADF({ type: 'foo', version: 1, content: [{ type: 'p' }] })).toBe(false);
    expect(validateADF({ type: 'doc', version: 2, content: [{ type: 'p' }] })).toBe(false);
  });

  test('rejects empty content array', () => {
    expect(validateADF({ type: 'doc', version: 1, content: [] })).toBe(false);
  });
});

describe('adfToText', () => {
  test('returns empty string for null', () => {
    expect(adfToText(null)).toBe('');
  });

  test('extracts heading + paragraph text', () => {
    const adf = {
      type: 'doc', version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] }
      ]
    };
    const text = adfToText(adf);
    expect(text).toContain('## Hello');
    expect(text).toContain('World');
  });

  test('extracts list items with bullet prefix', () => {
    const adf = {
      type: 'doc', version: 1,
      content: [{
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }
        ]
      }]
    };
    const text = adfToText(adf);
    expect(text).toContain('- a');
    expect(text).toContain('- b');
  });

  test('round-trips markdown → ADF → text without losing structure', () => {
    const md = '## Summary\n\nIntro text here.\n\n## Steps\n1. open\n2. click';
    const text = adfToText(markdownToADF(md));
    expect(text).toContain('## Summary');
    expect(text).toContain('Intro text here.');
    expect(text).toContain('## Steps');
    expect(text).toContain('1. open');
    expect(text).toContain('2. click');
  });
});

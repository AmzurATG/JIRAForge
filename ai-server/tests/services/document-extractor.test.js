'use strict';

/**
 * Tests for document-extractor.js
 */

const { isSupportedDocumentType, extractText, extractAllDocuments } = require('../../src/services/document-extractor');

describe('isSupportedDocumentType', () => {
  test('returns true for PDF', () => {
    expect(isSupportedDocumentType('application/pdf')).toBe(true);
  });

  test('returns true for DOCX', () => {
    expect(isSupportedDocumentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });

  test('returns true for text/plain', () => {
    expect(isSupportedDocumentType('text/plain')).toBe(true);
  });

  test('returns true for text/markdown', () => {
    expect(isSupportedDocumentType('text/markdown')).toBe(true);
  });

  test('returns true for text/csv', () => {
    expect(isSupportedDocumentType('text/csv')).toBe(true);
  });

  test('returns false for image types', () => {
    expect(isSupportedDocumentType('image/png')).toBe(false);
    expect(isSupportedDocumentType('image/jpeg')).toBe(false);
  });

  test('returns false for unsupported types', () => {
    expect(isSupportedDocumentType('application/zip')).toBe(false);
    expect(isSupportedDocumentType('application/octet-stream')).toBe(false);
  });
});

describe('extractText', () => {
  test('returns null for unsupported mime type', async () => {
    const data = Buffer.from('hello').toString('base64');
    const result = await extractText(data, 'image/png', 'test.png');
    expect(result).toBeNull();
  });

  test('returns null for null/empty input', async () => {
    expect(await extractText(null, 'text/plain', 'test.txt')).toBeNull();
    expect(await extractText('', 'text/plain', 'test.txt')).toBeNull();
  });

  test('extracts text from plain text files', async () => {
    const content = 'Hello, this is a test document with some content.';
    const data = Buffer.from(content).toString('base64');
    const result = await extractText(data, 'text/plain', 'test.txt');
    expect(result).toBe(content);
  });

  test('extracts text from markdown files', async () => {
    const content = '# Heading\n\nSome markdown content here.\n\n- Item 1\n- Item 2';
    const data = Buffer.from(content).toString('base64');
    const result = await extractText(data, 'text/markdown', 'readme.md');
    expect(result).toContain('# Heading');
    expect(result).toContain('Item 1');
  });

  test('extracts text from CSV files', async () => {
    const content = 'Name,Value\nAlpha,100\nBeta,200';
    const data = Buffer.from(content).toString('base64');
    const result = await extractText(data, 'text/csv', 'data.csv');
    expect(result).toContain('Name,Value');
    expect(result).toContain('Alpha,100');
  });

  test('truncates long text to MAX_EXTRACTED_TEXT limit', async () => {
    const content = 'x'.repeat(5000);
    const data = Buffer.from(content).toString('base64');
    const result = await extractText(data, 'text/plain', 'long.txt');
    expect(result.length).toBe(3000);
  });

  test('returns null for empty content after extraction', async () => {
    const content = '   \n  \n   ';
    const data = Buffer.from(content).toString('base64');
    const result = await extractText(data, 'text/plain', 'empty.txt');
    expect(result).toBeNull();
  });
});

describe('extractAllDocuments', () => {
  test('returns empty array for null/empty input', async () => {
    expect(await extractAllDocuments(null)).toEqual([]);
    expect(await extractAllDocuments([])).toEqual([]);
  });

  test('extracts text from multiple text documents', async () => {
    const docs = [
      { data: Buffer.from('Document A content').toString('base64'), mimeType: 'text/plain', filename: 'a.txt' },
      { data: Buffer.from('Document B content').toString('base64'), mimeType: 'text/markdown', filename: 'b.md' }
    ];
    const results = await extractAllDocuments(docs);
    expect(results).toHaveLength(2);
    expect(results[0].filename).toBe('a.txt');
    expect(results[0].text).toContain('Document A content');
    expect(results[1].filename).toBe('b.md');
    expect(results[1].text).toContain('Document B content');
  });

  test('skips documents that fail extraction', async () => {
    const docs = [
      { data: Buffer.from('Good content').toString('base64'), mimeType: 'text/plain', filename: 'good.txt' },
      { data: 'not-valid-base64!!!', mimeType: 'application/pdf', filename: 'bad.pdf' }
    ];
    const results = await extractAllDocuments(docs);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].filename).toBe('good.txt');
  });
});

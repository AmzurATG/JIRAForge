'use strict';

/**
 * Document Extractor
 *
 * Extracts plain text from common document formats (PDF, DOCX, plain text).
 * Used by the description quality service to include attached document content
 * as LLM context when analyzing Jira ticket descriptions.
 *
 * Supported formats:
 *   - application/pdf → pdf-parse
 *   - application/vnd.openxmlformats-officedocument.wordprocessingml.document → mammoth
 *   - text/plain, text/markdown, text/csv → direct UTF-8 decode
 */

const logger = require('../utils/logger');

const MAX_EXTRACTED_TEXT = 3000; // characters per document

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv'
]);

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ...TEXT_MIME_TYPES
]);

/**
 * Check if a MIME type is supported for text extraction.
 * @param {string} mimeType
 * @returns {boolean}
 */
function isSupportedDocumentType(mimeType) {
  return SUPPORTED_MIME_TYPES.has(mimeType);
}

/**
 * Extract text from a base64-encoded document.
 *
 * @param {string} base64Data - base64-encoded document content
 * @param {string} mimeType - MIME type of the document
 * @param {string} filename - original filename (for logging)
 * @returns {Promise<string|null>} Extracted text (truncated to MAX_EXTRACTED_TEXT), or null on failure
 */
async function extractText(base64Data, mimeType, filename) {
  if (!base64Data || !mimeType) return null;
  if (!isSupportedDocumentType(mimeType)) return null;

  try {
    const buffer = Buffer.from(base64Data, 'base64');
    let text = '';

    if (mimeType === 'application/pdf') {
      text = await extractFromPDF(buffer, filename);
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      text = await extractFromDocx(buffer, filename);
    } else if (TEXT_MIME_TYPES.has(mimeType)) {
      text = buffer.toString('utf-8');
    }

    if (!text || text.trim().length === 0) {
      logger.debug('[DocumentExtractor] No text extracted from %s (%s)', filename, mimeType);
      return null;
    }

    // Truncate to limit and clean up excessive whitespace
    const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return cleaned.slice(0, MAX_EXTRACTED_TEXT);
  } catch (err) {
    logger.warn('[DocumentExtractor] Failed to extract text from %s (%s): %s', filename, mimeType, err.message);
    return null;
  }
}

/**
 * Extract text from a PDF buffer using pdf-parse.
 */
async function extractFromPDF(buffer, filename) {
  const pdfParse = require('pdf-parse');
  const result = await pdfParse(buffer, {
    // Limit page count to prevent DoS on huge PDFs
    max: 20
  });
  logger.debug('[DocumentExtractor] PDF %s: %d pages, %d chars extracted', filename, result.numpages, (result.text || '').length);
  return result.text || '';
}

/**
 * Extract text from a DOCX buffer using mammoth.
 */
async function extractFromDocx(buffer, filename) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  logger.debug('[DocumentExtractor] DOCX %s: %d chars extracted', filename, (result.value || '').length);
  return result.value || '';
}

/**
 * Process an array of document attachments and extract text from each.
 * Returns an array of { filename, text } objects for successfully extracted docs.
 *
 * @param {Array<{data: string, mimeType: string, filename: string}>} documents
 * @returns {Promise<Array<{filename: string, text: string}>>}
 */
async function extractAllDocuments(documents) {
  if (!Array.isArray(documents) || documents.length === 0) return [];

  const results = [];
  for (const doc of documents) {
    const text = await extractText(doc.data, doc.mimeType, doc.filename || 'unknown');
    if (text) {
      results.push({
        filename: doc.filename || 'document',
        text
      });
    }
  }
  return results;
}

module.exports = {
  isSupportedDocumentType,
  extractText,
  extractAllDocuments,
  SUPPORTED_MIME_TYPES,
  MAX_EXTRACTED_TEXT
};

/**
 * Batch Analysis Prompt Tests
 * Tests for buildBatchAnalysisPrompt changes:
 * - Fix 2: Session continuity hint
 * - Fix 6: OCR text limit 1000
 * - Fix 8: Low-confidence OCR flagging
 * - Fix 11: Idle review record support
 */

'use strict';

// Don't mock prompts — we need the real implementation for prompt generation
jest.mock('../../src/services/ai/ai-client', () => ({
  chatCompletionWithFallback: jest.fn(),
  isActivityAIEnabled: jest.fn(),
}));

jest.mock('../../src/services/db/activity-db-service', () => ({
  updateActivityRecordAnalysis: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const { _buildBatchAnalysisPrompt: buildBatchAnalysisPrompt } = require('../../src/services/activity-service');

const mockRecord = {
  id: 'rec-1',
  application_name: 'Code.exe',
  window_title: 'auth.js - project',
  total_time_seconds: 300,
  start_time: '2026-04-16T09:00:00Z',
  end_time: '2026-04-16T09:05:00Z',
  ocr_text: 'function authenticate() { return true; }',
};

describe('buildBatchAnalysisPrompt', () => {
  // Fix 2: Session continuity
  describe('session continuity in prompt', () => {
    it('should include SESSION CONTINUITY instruction in batch prompt', () => {
      const prompt = buildBatchAnalysisPrompt([mockRecord], 'ATG-123: Test issue');
      expect(prompt).toContain('SESSION CONTINUITY');
      expect(prompt).toContain('chronological order');
    });

    it('should include session inheritance guidance', () => {
      const prompt = buildBatchAnalysisPrompt([mockRecord], 'ATG-123: Test issue');
      expect(prompt).toContain('inherit that match');
      expect(prompt).toContain('switching between IDE, browser, and terminal');
    });
  });

  // Fix 6: OCR text limit 1000
  describe('OCR text limit in prompt', () => {
    it('should include up to 1000 chars of OCR text', () => {
      const longText = 'A'.repeat(1500);
      const records = [{ ...mockRecord, ocr_text: longText }];
      const prompt = buildBatchAnalysisPrompt(records, 'None');
      expect(prompt).toContain('A'.repeat(1000));
      expect(prompt).not.toContain('A'.repeat(1001));
    });

    it('should handle null OCR text gracefully', () => {
      const records = [{ ...mockRecord, ocr_text: null }];
      const prompt = buildBatchAnalysisPrompt(records, 'None');
      expect(prompt).toContain('(no text extracted)');
    });
  });

  // Fix 8: Low-confidence OCR flagging
  describe('low-confidence OCR flagging', () => {
    it('should flag OCR text with confidence < 0.4', () => {
      const records = [{ ...mockRecord, ocr_text: 'some text', ocr_confidence: 0.2 }];
      const prompt = buildBatchAnalysisPrompt(records, 'None');
      expect(prompt).toContain('low confidence');
      expect(prompt).toContain('may be inaccurate');
    });

    it('should NOT flag OCR text with confidence >= 0.4', () => {
      const records = [{ ...mockRecord, ocr_text: 'some text', ocr_confidence: 0.8 }];
      const prompt = buildBatchAnalysisPrompt(records, 'None');
      // The per-record label should not say "low confidence" for high-confidence OCR
      expect(prompt).not.toContain('OCR Text (low confidence');
      expect(prompt).toContain('OCR Text:');
    });

    it('should NOT flag OCR text when confidence is not provided', () => {
      const records = [{ ...mockRecord, ocr_text: 'some text' }];
      const prompt = buildBatchAnalysisPrompt(records, 'None');
      // The per-record label should not say "low confidence" when no confidence is set
      expect(prompt).not.toContain('OCR Text (low confidence');
      expect(prompt).toContain('OCR Text:');
    });
  });

  // Fix 11: Idle review records
  describe('idle review record support', () => {
    it('should include IDLE REVIEW RECORDS instruction in prompt', () => {
      const prompt = buildBatchAnalysisPrompt([mockRecord], 'ATG-123: Test issue');
      expect(prompt).toContain('IDLE REVIEW RECORDS');
      expect(prompt).toContain('idle_for_llm_review');
    });

    it('should include tracking_mode for idle records', () => {
      const idleRecord = {
        ...mockRecord,
        metadata: { tracking_mode: 'idle_for_llm_review' }
      };
      const prompt = buildBatchAnalysisPrompt([idleRecord], 'ATG-123: Test issue');
      expect(prompt).toContain('Tracking Mode: idle_for_llm_review');
    });

    it('should NOT include tracking_mode for regular records', () => {
      const records = [{ ...mockRecord, metadata: {} }];
      const prompt = buildBatchAnalysisPrompt(records, 'ATG-123: Test issue');
      expect(prompt).not.toContain('Tracking Mode:');
    });
  });
});

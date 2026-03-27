'use strict';

/**
 * Unit tests for ID & PII Sanitization Fixes in activity-service.js
 *
 * Tests the new server-side patterns for:
 * 1. Atlassian Account IDs (712020:uuid)
 * 2. Atlassian ARIs (ari:cloud:...)
 * 3. UUIDs (standalone)
 * 4. Email addresses
 * 5. End-to-end prompt builder sanitization for these new types
 */

// Mock dependencies before requiring the module
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../src/utils/logger', () => mockLogger);

jest.mock('../../src/services/ai/ai-client', () => ({
  chatCompletionWithFallback: jest.fn(),
  isActivityAIEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock('../../src/services/ai/prompts', () => ({
  formatAssignedIssues: jest.fn().mockReturnValue('PROJ-1: Test issue'),
  APP_IDENTIFICATION_SYSTEM_PROMPT: 'mock prompt',
  buildAppIdentificationPrompt: jest.fn(),
}));

jest.mock('../../src/services/db/activity-db-service', () => ({
  getAssignedIssues: jest.fn(),
  updateActivityRecords: jest.fn(),
}));

const {
  sanitizeOcrText,
  _buildBatchAnalysisPrompt: buildBatchAnalysisPrompt,
  _buildClassificationPrompt: buildClassificationPrompt,
} = require('../../src/services/activity-service');

// ============================================================================
// Atlassian Account ID sanitization
// ============================================================================

describe('Atlassian Account ID sanitization', () => {
  it('should redact standard Atlassian account ID (712020:uuid)', () => {
    const text = 'User: 712020:a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = sanitizeOcrText(text);

    expect(result).toContain('[REDACTED_ATLASSIAN_ID]');
    expect(result).not.toContain('712020:a1b2c3d4');
    expect(result).not.toContain('ef1234567890');
  });

  it('should redact Atlassian ID with different 6-digit prefix', () => {
    const text = 'accountId=557058:deadbeef-1234-5678-abcd-ef9876543210';
    const result = sanitizeOcrText(text);

    expect(result).not.toContain('557058:deadbeef');
  });

  it('should redact multiple Atlassian IDs in one text', () => {
    const text =
      'Author: 712020:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee ' +
      'Reviewer: 123456:11111111-2222-3333-4444-555555555555';
    const result = sanitizeOcrText(text);

    expect(result).not.toContain('712020:aaaaaaaa');
    expect(result).not.toContain('123456:11111111');
  });

  it('should handle Atlassian ID in log-like text', () => {
    const text = '[INFO] Authenticated user 557058:c3fa0e12-9a4b-4c91-b6d3-deadbeef1234 via OAuth';
    const result = sanitizeOcrText(text);

    expect(result).toContain('[REDACTED_ATLASSIAN_ID]');
    expect(result).not.toContain('c3fa0e12');
  });
});

// ============================================================================
// Atlassian ARI sanitization
// ============================================================================

describe('Atlassian ARI sanitization', () => {
  it('should redact Jira ARI', () => {
    const text = 'Install: ari:cloud:jira::app/12345678-abcd-ef01-2345-6789abcdef01';
    const result = sanitizeOcrText(text);

    expect(result).toContain('[REDACTED_ARI]');
    expect(result).not.toContain('ari:cloud:jira');
  });

  it('should redact Confluence ARI', () => {
    const text = 'ari:cloud:confluence::site/abcdef12-3456-7890-abcd-ef1234567890';
    const result = sanitizeOcrText(text);

    expect(result).toContain('[REDACTED_ARI]');
    expect(result).not.toContain('ari:cloud:confluence');
  });

  it('should redact ARI with different resource types', () => {
    const text = 'ari:cloud:ecosystem::installation/aaa-bbb-ccc-ddd';
    const result = sanitizeOcrText(text);

    expect(result).toContain('[REDACTED_ARI]');
  });
});

// ============================================================================
// UUID sanitization
// ============================================================================

describe('UUID sanitization', () => {
  it('should redact standalone UUID', () => {
    const text = 'Cloud ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = sanitizeOcrText(text);

    expect(result).toContain('[REDACTED_UUID]');
    expect(result).not.toContain('a1b2c3d4-e5f6-7890');
  });

  it('should redact multiple UUIDs', () => {
    const text = 'org=11111111-2222-3333-4444-555555555555 user=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const result = sanitizeOcrText(text);

    expect(result).not.toContain('11111111-2222-3333');
    expect(result).not.toContain('aaaaaaaa-bbbb-cccc');
  });

  it('should not match short hex strings that are not UUIDs', () => {
    const text = 'commit abcdef12 merged into main';
    expect(sanitizeOcrText(text)).toBe(text);
  });

  it('should handle UUID in URL context', () => {
    const text = 'https://admin.atlassian.com/o/a1b2c3d4-e5f6-7890-abcd-ef1234567890/overview';
    const result = sanitizeOcrText(text);

    expect(result).not.toContain('a1b2c3d4-e5f6-7890');
  });
});

// ============================================================================
// Email address sanitization
// ============================================================================

describe('email address sanitization', () => {
  it('should redact standard email address', () => {
    const result = sanitizeOcrText('Contact: admin@example.com');
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('admin@example.com');
  });

  it('should redact email with subdomain', () => {
    const result = sanitizeOcrText('user@mail.company.co.uk');
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('user@mail.company');
  });

  it('should redact email with plus addressing', () => {
    const result = sanitizeOcrText('user+tag@company.org');
    expect(result).toContain('[REDACTED_EMAIL]');
  });

  it('should redact multiple emails in text', () => {
    const text = 'From: alice@test.com To: bob@test.com';
    const result = sanitizeOcrText(text);

    expect(result).not.toContain('alice@test.com');
    expect(result).not.toContain('bob@test.com');
  });

  it('should handle email in OCR-like admin panel text', () => {
    const text = `Jira Settings
Admin Email: john.doe@acme-corp.com
Notifications: enabled`;
    const result = sanitizeOcrText(text);

    expect(result).not.toContain('john.doe@acme-corp.com');
    expect(result).toContain('Jira Settings');
    expect(result).toContain('Notifications: enabled');
  });
});

// ============================================================================
// Pattern ordering — Atlassian ID before UUID, no double-match issues
// ============================================================================

describe('pattern ordering and overlap', () => {
  it('should use more specific Atlassian ID pattern before generic UUID', () => {
    // The Atlassian Account ID pattern is listed BEFORE the UUID pattern
    // in SANITIZATION_PATTERNS, so it should match first
    const text = 'user=712020:a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = sanitizeOcrText(text);

    // The Atlassian ID pattern should match the full compound ID
    expect(result).toContain('[REDACTED_ATLASSIAN_ID]');
  });

  it('should not leave partial UUID after Atlassian ID redaction', () => {
    const text = '712020:a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = sanitizeOcrText(text);

    // Should not have a bare UUID leftover
    expect(result).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

// ============================================================================
// Mixed realistic OCR text — comprehensive sanitization
// ============================================================================

describe('mixed OCR text with IDs and PII', () => {
  it('should sanitize all sensitive data in a realistic admin panel OCR dump', () => {
    const text = `Jira Admin Panel
User: 557058:deadbeef-1234-5678-abcd-ef9876543210
Cloud ID: b7c8d9e0-fa1b-2c3d-4e5f-a67890bcdef1
App: ari:cloud:jira::app/aaaabbbb-cccc-dddd-eeee-ffffffffffff
Email: ops@company.com
password=AdminPass123!
API_KEY=AKIAIOSFODNN7EXAMPLE
Status: Active`;

    const result = sanitizeOcrText(text);

    // All sensitive items must be gone
    expect(result).not.toContain('557058:deadbeef');
    expect(result).not.toContain('b7c8d9e0-fa1b-2c3d');
    expect(result).not.toContain('ari:cloud:jira');
    expect(result).not.toContain('ops@company.com');
    expect(result).not.toContain('AdminPass123');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');

    // Non-sensitive labels preserved
    expect(result).toContain('Jira Admin Panel');
    expect(result).toContain('Status: Active');
  });

  it('should sanitize IDs in batch analysis prompt', () => {
    const records = [
      {
        ocr_text: 'Logged in as 712020:aaaa1111-bbbb-2222-cccc-dddd3333eeee. Cloud: ff001122-3344-5566-7788-99aabbccddee',
        application_name: 'chrome.exe',
        window_title: 'Jira Admin - Chrome',
        total_time_seconds: 120,
        start_time: '2026-03-27T10:00:00Z',
        end_time: '2026-03-27T10:02:00Z',
      },
    ];
    const assignedIssues = 'PROJ-1: Admin setup';

    const prompt = buildBatchAnalysisPrompt(records, assignedIssues);

    expect(prompt).not.toContain('712020:aaaa1111');
    expect(prompt).not.toContain('ff001122-3344-5566');
  });

  it('should sanitize email in classification prompt', () => {
    const prompt = buildClassificationPrompt(
      'chrome.exe',
      'Settings - Chrome',
      'Admin email: admin@internal.corp'
    );

    expect(prompt).not.toContain('admin@internal.corp');
  });
});

// ============================================================================
// Repeated calls — regex lastIndex reset for new patterns
// ============================================================================

describe('repeated calls with new patterns', () => {
  it('should correctly sanitize Atlassian IDs across sequential calls', () => {
    const text1 = 'user=712020:aaaa1111-bbbb-2222-cccc-dddd3333eeee';
    const text2 = 'user=712020:ffff1111-eeee-2222-dddd-cccc3333bbbb';

    const r1 = sanitizeOcrText(text1);
    const r2 = sanitizeOcrText(text2);

    expect(r1).not.toContain('aaaa1111');
    expect(r2).not.toContain('ffff1111');
  });

  it('should correctly sanitize UUIDs across sequential calls', () => {
    const r1 = sanitizeOcrText('id=11111111-2222-3333-4444-555555555555');
    const r2 = sanitizeOcrText('id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const r3 = sanitizeOcrText('id=12345678-abcd-ef01-2345-6789abcdef01');

    expect(r1).not.toContain('11111111-2222');
    expect(r2).not.toContain('aaaaaaaa-bbbb');
    expect(r3).not.toContain('12345678-abcd');
  });

  it('should correctly sanitize emails across sequential calls', () => {
    const r1 = sanitizeOcrText('email: a@test.com');
    const r2 = sanitizeOcrText('email: b@test.com');

    expect(r1).not.toContain('a@test.com');
    expect(r2).not.toContain('b@test.com');
  });
});

// ============================================================================
// False positive avoidance
// ============================================================================

describe('false positive avoidance for new patterns', () => {
  it('should not redact Jira issue keys (PROJ-123)', () => {
    const text = 'Working on PROJ-123 implementation';
    expect(sanitizeOcrText(text)).toBe(text);
  });

  it('should not redact normal hex strings that are not UUIDs', () => {
    const text = 'git commit abc1234 by developer';
    expect(sanitizeOcrText(text)).toBe(text);
  });

  it('should not redact numbers that look like time ranges or IDs', () => {
    const text = 'Task completed in 300 seconds at 2026-03-27';
    expect(sanitizeOcrText(text)).toBe(text);
  });

  it('should preserve window title text', () => {
    const text = 'app.js - my-project - Visual Studio Code';
    expect(sanitizeOcrText(text)).toBe(text);
  });
});

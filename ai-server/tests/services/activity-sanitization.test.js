'use strict';

/**
 * Unit tests for OCR Data Sanitization in activity-service.js
 *
 * Tests the server-side sanitizeOcrText() defense-in-depth layer
 * and verifies that LLM prompt builders use sanitized OCR text.
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
// sanitizeOcrText() — Core Sanitization Tests
// ============================================================================

describe('sanitizeOcrText', () => {
  // ------------------------------------------------------------------
  // Edge cases
  // ------------------------------------------------------------------
  describe('edge cases', () => {
    it('should return null for null input', () => {
      expect(sanitizeOcrText(null)).toBeNull();
    });

    it('should return undefined for undefined input', () => {
      expect(sanitizeOcrText(undefined)).toBeUndefined();
    });

    it('should return empty string for empty input', () => {
      expect(sanitizeOcrText('')).toBe('');
    });

    it('should return normal text unchanged', () => {
      const text = 'This is a normal sentence about project work.';
      expect(sanitizeOcrText(text)).toBe(text);
    });

    it('should handle text with only whitespace', () => {
      expect(sanitizeOcrText('   \n\t  ')).toBe('   \n\t  ');
    });
  });

  // ------------------------------------------------------------------
  // Credential patterns: password=, pwd=, secret=, token=
  // ------------------------------------------------------------------
  describe('credential patterns', () => {
    it('should redact password=value', () => {
      const result = sanitizeOcrText('database password=SuperSecret123!');
      expect(result).toContain('[REDACTED_CREDENTIAL]');
      expect(result).not.toContain('SuperSecret123');
    });

    it('should redact pwd=value', () => {
      const result = sanitizeOcrText('pwd=mypassword123');
      expect(result).toContain('[REDACTED_CREDENTIAL]');
      expect(result).not.toContain('mypassword123');
    });

    it('should redact secret=value', () => {
      const result = sanitizeOcrText('client_secret=abc123def456');
      expect(result).toContain('[REDACTED_CREDENTIAL]');
      expect(result).not.toContain('abc123def456');
    });

    it('should redact token=value', () => {
      const result = sanitizeOcrText('access_token=eyJhbGciOi...');
      expect(result).toContain('[REDACTED_CREDENTIAL]');
      expect(result).not.toContain('eyJhbGciOi');
    });

    it('should redact password with colon separator', () => {
      const result = sanitizeOcrText('password: SuperSecret123!');
      expect(result).toContain('[REDACTED_CREDENTIAL]');
      expect(result).not.toContain('SuperSecret123');
    });

    it('should be case-insensitive for credential patterns', () => {
      expect(sanitizeOcrText('PASSWORD=test')).toContain('[REDACTED_CREDENTIAL]');
      expect(sanitizeOcrText('Password=test')).toContain('[REDACTED_CREDENTIAL]');
      expect(sanitizeOcrText('SECRET=test')).toContain('[REDACTED_CREDENTIAL]');
    });
  });

  // ------------------------------------------------------------------
  // AWS keys
  // ------------------------------------------------------------------
  describe('AWS keys', () => {
    it('should redact AWS access key (AKIA prefix)', () => {
      const result = sanitizeOcrText('AWS key: AKIAIOSFODNN7EXAMPLE');
      expect(result).toContain('[REDACTED_AWS_KEY]');
      expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('should not redact text that starts with AKIA but is wrong length', () => {
      // AKIA with fewer than 16 chars after should not match
      const result = sanitizeOcrText('AKIA1234');
      expect(result).not.toContain('[REDACTED_AWS_KEY]');
    });
  });

  // ------------------------------------------------------------------
  // GitHub tokens
  // ------------------------------------------------------------------
  describe('GitHub tokens', () => {
    it('should redact ghp_ personal access token', () => {
      const token = 'ghp_' + 'a'.repeat(36);
      const result = sanitizeOcrText(`GITHUB_TOKEN=${token}`);
      // The credential pattern (token=...) fires first, which also catches the token
      expect(result).not.toContain(token);
    });

    it('should redact ghs_ server token', () => {
      const token = 'ghs_' + 'B'.repeat(36);
      const result = sanitizeOcrText(`token: ${token}`);
      // The credential pattern (token:...) fires first
      expect(result).not.toContain(token);
    });

    it('should redact gho_ OAuth token', () => {
      const token = 'gho_' + 'c'.repeat(36);
      const result = sanitizeOcrText(token);
      expect(result).toContain('[REDACTED_GITHUB_TOKEN]');
    });

    it('should redact standalone GitHub token without credential prefix', () => {
      // Without token= prefix, the GitHub-specific pattern should fire
      const token = 'ghp_' + 'X'.repeat(36);
      const result = sanitizeOcrText(`Found ${token} in code`);
      expect(result).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(result).not.toContain(token);
    });
  });

  // ------------------------------------------------------------------
  // API keys
  // ------------------------------------------------------------------
  describe('API keys', () => {
    it('should redact api_key=value', () => {
      const result = sanitizeOcrText('api_key=sk_live_abc123def456');
      expect(result).toContain('[REDACTED_API_KEY]');
      expect(result).not.toContain('sk_live_abc123def456');
    });

    it('should redact apikey=value', () => {
      const result = sanitizeOcrText('apikey=test_key_123');
      expect(result).toContain('[REDACTED_API_KEY]');
    });

    it('should redact api-key: value', () => {
      const result = sanitizeOcrText('api-key: myapikey123');
      expect(result).toContain('[REDACTED_API_KEY]');
    });
  });

  // ------------------------------------------------------------------
  // Bearer tokens
  // ------------------------------------------------------------------
  describe('Bearer tokens', () => {
    it('should redact Bearer token', () => {
      const result = sanitizeOcrText('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9');
      expect(result).toContain('Bearer [REDACTED_TOKEN]');
      expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    });

    it('should be case-insensitive for Bearer', () => {
      const result = sanitizeOcrText('bearer eyJhbGciOiJ0ZXN0In0');
      expect(result).toContain('Bearer [REDACTED_TOKEN]');
    });
  });

  // ------------------------------------------------------------------
  // Credit card numbers
  // ------------------------------------------------------------------
  describe('credit card numbers', () => {
    it('should redact 16-digit card number', () => {
      const result = sanitizeOcrText('Card: 4111111111111111');
      expect(result).toContain('[REDACTED_CARD]');
      expect(result).not.toContain('4111111111111111');
    });

    it('should redact card number with dashes', () => {
      const result = sanitizeOcrText('Card: 4111-1111-1111-1111');
      expect(result).toContain('[REDACTED_CARD]');
    });

    it('should redact card number with spaces', () => {
      const result = sanitizeOcrText('Card: 4111 1111 1111 1111');
      expect(result).toContain('[REDACTED_CARD]');
    });
  });

  // ------------------------------------------------------------------
  // SSN (US format)
  // ------------------------------------------------------------------
  describe('SSN patterns', () => {
    it('should redact XXX-XX-XXXX SSN format', () => {
      const result = sanitizeOcrText('SSN: 123-45-6789');
      expect(result).toContain('[REDACTED_SSN]');
      expect(result).not.toContain('123-45-6789');
    });

    it('should not redact non-SSN number patterns', () => {
      // Phone numbers don't match XXX-XX-XXXX
      const result = sanitizeOcrText('Phone: 555-123-4567');
      expect(result).not.toContain('[REDACTED_SSN]');
    });
  });

  // ------------------------------------------------------------------
  // Private keys
  // ------------------------------------------------------------------
  describe('private keys', () => {
    it('should redact RSA private key block', () => {
      const key = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn...
-----END RSA PRIVATE KEY-----`;
      const result = sanitizeOcrText(`Config:\n${key}\nDone`);
      expect(result).toContain('[REDACTED_PRIVATE_KEY]');
      expect(result).not.toContain('MIIEpAIBAAKCAQEA');
    });

    it('should redact generic private key block', () => {
      const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQE...
-----END PRIVATE KEY-----`;
      const result = sanitizeOcrText(key);
      expect(result).toContain('[REDACTED_PRIVATE_KEY]');
    });
  });

  // ------------------------------------------------------------------
  // Connection strings
  // ------------------------------------------------------------------
  describe('connection strings', () => {
    it('should redact MongoDB connection string', () => {
      const result = sanitizeOcrText('mongodb://admin:secret123@db.example.com:27017/mydb');
      expect(result).toContain('[REDACTED_CONNECTION_STRING]');
      expect(result).not.toContain('secret123');
    });

    it('should redact PostgreSQL connection string', () => {
      const result = sanitizeOcrText('postgres://user:p@ssw0rd@localhost:5432/database');
      expect(result).toContain('[REDACTED_CONNECTION_STRING]');
      expect(result).not.toContain('p@ssw0rd');
    });

    it('should redact MySQL connection string', () => {
      const result = sanitizeOcrText('mysql://root:password@db.host.com/app');
      expect(result).toContain('[REDACTED_CONNECTION_STRING]');
    });

    it('should redact Redis connection string', () => {
      const result = sanitizeOcrText('redis://default:myredispassword@redis.example.com:6379');
      expect(result).toContain('[REDACTED_CONNECTION_STRING]');
    });
  });

  // ------------------------------------------------------------------
  // Multiple patterns in one text
  // ------------------------------------------------------------------
  describe('multiple patterns', () => {
    it('should redact multiple sensitive items in one text', () => {
      const text = `
Settings Panel
password=SuperSecret123!
API_KEY=AKIAIOSFODNN7EXAMPLE
SSN: 123-45-6789
Status: Connected
      `;
      const result = sanitizeOcrText(text);

      // All sensitive data should be replaced with some [REDACTED_*] tag
      expect(result).not.toContain('SuperSecret123');
      expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(result).not.toContain('123-45-6789');
      // Non-sensitive data preserved
      expect(result).toContain('Settings Panel');
      expect(result).toContain('Status: Connected');
      // Should contain at least some redaction markers
      expect(result).toMatch(/\[REDACTED_/);  
    });
  });

  // ------------------------------------------------------------------
  // No false positives on normal text
  // ------------------------------------------------------------------
  describe('false positive avoidance', () => {
    it('should not redact normal work text', () => {
      const text = 'Working on PROJ-123 in VS Code. Updated the login page component.';
      expect(sanitizeOcrText(text)).toBe(text);
    });

    it('should not redact Jira issue keys', () => {
      const text = 'JIRA-456: Implement user authentication flow';
      expect(sanitizeOcrText(text)).toBe(text);
    });

    it('should not redact normal file paths', () => {
      const text = 'Editing src/components/LoginForm.tsx';
      expect(sanitizeOcrText(text)).toBe(text);
    });
  });

  // ------------------------------------------------------------------
  // Repeated calls (regex lastIndex reset)
  // ------------------------------------------------------------------
  describe('repeated calls', () => {
    it('should work correctly across multiple sequential calls', () => {
      // This tests that global regex lastIndex is properly reset
      const text1 = 'password=secret1';
      const text2 = 'password=secret2';
      const text3 = 'password=secret3';

      const result1 = sanitizeOcrText(text1);
      const result2 = sanitizeOcrText(text2);
      const result3 = sanitizeOcrText(text3);

      expect(result1).toContain('[REDACTED_CREDENTIAL]');
      expect(result2).toContain('[REDACTED_CREDENTIAL]');
      expect(result3).toContain('[REDACTED_CREDENTIAL]');
      expect(result1).not.toContain('secret1');
      expect(result2).not.toContain('secret2');
      expect(result3).not.toContain('secret3');
    });
  });
});

// ============================================================================
// Prompt builder sanitization integration
// ============================================================================

describe('Prompt builders use sanitizeOcrText', () => {
  describe('buildBatchAnalysisPrompt', () => {
    it('should sanitize OCR text in activity records', () => {
      const records = [
        {
          ocr_text: 'password=SuperSecret123! Working on login page',
          application_name: 'Code.exe',
          window_title: 'app.js - VS Code',
          total_time_seconds: 300,
          start_time: '2026-03-24T10:00:00Z',
          end_time: '2026-03-24T10:05:00Z',
        },
      ];
      const assignedIssues = 'PROJ-1: Implement login';

      const prompt = buildBatchAnalysisPrompt(records, assignedIssues);

      expect(prompt).toContain('[REDACTED_CREDENTIAL]');
      expect(prompt).not.toContain('SuperSecret123');
      // Non-sensitive data should still be present
      expect(prompt).toContain('login page');
    });

    it('should handle records with no OCR text', () => {
      const records = [
        {
          ocr_text: null,
          application_name: 'Code.exe',
          window_title: 'file.py - VS Code',
          total_time_seconds: 60,
          start_time: '2026-03-24T10:00:00Z',
          end_time: '2026-03-24T10:01:00Z',
        },
      ];

      const prompt = buildBatchAnalysisPrompt(records, 'PROJ-1: Test');

      expect(prompt).toContain('(no text extracted)');
    });

    it('should sanitize multiple records', () => {
      const records = [
        {
          ocr_text: 'api_key=sk_live_123456789',
          application_name: 'chrome.exe',
          window_title: 'Settings - Chrome',
          total_time_seconds: 120,
          start_time: '2026-03-24T10:00:00Z',
          end_time: '2026-03-24T10:02:00Z',
        },
        {
          ocr_text: 'SSN: 123-45-6789',
          application_name: 'notepad.exe',
          window_title: 'notes.txt - Notepad',
          total_time_seconds: 60,
          start_time: '2026-03-24T10:02:00Z',
          end_time: '2026-03-24T10:03:00Z',
        },
      ];

      const prompt = buildBatchAnalysisPrompt(records, 'PROJ-1: Test');

      expect(prompt).toContain('[REDACTED_API_KEY]');
      expect(prompt).toContain('[REDACTED_SSN]');
      expect(prompt).not.toContain('sk_live_123456789');
      expect(prompt).not.toContain('123-45-6789');
    });
  });

  describe('buildClassificationPrompt', () => {
    it('should sanitize OCR text in classification prompt', () => {
      const prompt = buildClassificationPrompt(
        'Code.exe',
        'settings.json - VS Code',
        'password=db_secret_123 editing config file'
      );

      expect(prompt).toContain('[REDACTED_CREDENTIAL]');
      expect(prompt).not.toContain('db_secret_123');
      expect(prompt).toContain('editing config file');
    });

    it('should handle null OCR text gracefully', () => {
      const prompt = buildClassificationPrompt(
        'Code.exe',
        'file.py - VS Code',
        null
      );

      expect(prompt).toContain('(no text available)');
    });

    it('should handle empty OCR text gracefully', () => {
      const prompt = buildClassificationPrompt(
        'Code.exe',
        'file.py - VS Code',
        ''
      );

      expect(prompt).toContain('(no text available)');
    });
  });
});

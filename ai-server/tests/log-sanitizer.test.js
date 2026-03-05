/**
 * Unit tests for Log Sanitizer
 * 
 * Tests PII detection and redaction patterns.
 */

'use strict';

// Set test environment variables before importing
process.env.LOG_SANITIZE_ENABLED = 'true';
process.env.LOG_SANITIZE_LEVEL = 'standard';
process.env.LOG_SANITIZE_AUDIT = 'true';

const {
  sanitizeString,
  sanitizeObject,
  sanitizeLogData,
  getRedactionStats,
  resetRedactionStats,
  SANITIZATION_PATTERNS
} = require('../src/utils/log-sanitizer');

describe('LogSanitizer', () => {
  beforeEach(() => {
    resetRedactionStats();
  });

  describe('sanitizeString', () => {
    describe('Email addresses', () => {
      it('should redact email addresses', () => {
        const input = 'Sent notification to x@x.xx';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Sent notification to [EMAIL_REDACTED]');
      });

      it('should redact multiple email addresses', () => {
        const input = 'From: a@b.cc To: d@e.ff';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('From: [EMAIL_REDACTED] To: [EMAIL_REDACTED]');
      });

      it('should handle complex email formats', () => {
        const input = 'Contact: a.b+c@d.e.fg';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Contact: [EMAIL_REDACTED]');
      });
    });

    describe('UUIDs', () => {
      it('should redact standard UUIDs', () => {
        const input = 'User ID: 00000000-0000-0000-0000-000000000000';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('User ID: [UUID_REDACTED]');
      });

      it('should redact uppercase UUIDs', () => {
        const input = 'Cloud: 11111111-1111-1111-1111-111111111111';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Cloud: [UUID_REDACTED]');
      });

      it('should not redact UUIDs in minimal mode', () => {
        const input = 'User ID: 00000000-0000-0000-0000-000000000000';
        const { sanitized } = sanitizeString(input, 'minimal');
        expect(sanitized).toBe(input);
      });
    });

    describe('Atlassian Account IDs', () => {
      it('should redact Atlassian account IDs before UUID pattern', () => {
        const input = 'Account: 000000:00000000-0000-0000-0000-000000000000';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Account: [ATLASSIAN_ACCOUNT_REDACTED]');
      });
    });

    describe('Atlassian ARIs', () => {
      it('should redact app ARIs', () => {
        const input = 'App: ari:cloud:ecosystem::app/c8bab1dc-ae32-4e6f-9dbd-eb242cc6c14a';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('App: [ARI_REDACTED]');
      });

      it('should redact installation ARIs', () => {
        const input = 'Installation: ari:cloud:ecosystem::installation/ffde2508-71ac-40e2-815a-e49ebd32e23e';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Installation: [ARI_REDACTED]');
      });
    });

    describe('IP Addresses', () => {
      it('should redact IPv4 addresses', () => {
        const input = 'Request from 1.2.3.4';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Request from [IP_REDACTED]');
      });

      it('should handle edge case IPs', () => {
        const input = 'Range: 0.0.0.0 to 255.255.255.255';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Range: [IP_REDACTED] to [IP_REDACTED]');
      });
    });

    describe('JWT Tokens', () => {
      it('should redact JWT tokens', () => {
        const input = 'Token: eyJhbGciOiJ0ZXN0In0.eyJ0ZXN0IjoidGVzdCJ9.dGVzdHNpZ25hdHVyZQ';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Token: [JWT_REDACTED]');
      });
    });

    describe('API Keys', () => {
      it('should redact API keys with explicit labels', () => {
        const input = 'api_key=FAKE_TEST_KEY_00000000';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toContain('[API_KEY_REDACTED]');
      });

      it('should redact AWS access keys', () => {
        const input = 'Key: AKIATESTTESTTESTTEST';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Key: [AWS_KEY_REDACTED]');
      });

      it('should redact GitHub tokens', () => {
        const input = 'Token: ghp_000000000000000000000000000000000000';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Token: [GITHUB_TOKEN_REDACTED]');
      });
    });

    describe('Credit Cards', () => {
      it('should redact Visa card numbers', () => {
        const input = 'Card: 4000000000000000';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Card: [CREDIT_CARD_REDACTED]');
      });

      it('should redact MasterCard numbers', () => {
        const input = 'Card: 5100000000000000';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Card: [CREDIT_CARD_REDACTED]');
      });
    });

    describe('Phone Numbers', () => {
      it('should redact US phone numbers', () => {
        const input = 'Call: (555) 000-0000';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Call: [PHONE_REDACTED]');
      });

      it('should redact international format', () => {
        const input = 'Phone: +1-555-000-0000';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Phone: [PHONE_REDACTED]');
      });
    });
  });

  describe('sanitizeObject', () => {
    it('should sanitize nested objects', () => {
      const input = {
        user: {
          email: 'x@x.xx',
          name: 'Test User',
          id: '00000000-0000-0000-0000-000000000000'
        }
      };
      const { sanitized } = sanitizeObject(input, 'standard');
      expect(sanitized.user.email).toBe('[EMAIL_REDACTED]');
      expect(sanitized.user.name).toBe('Test User');
      expect(sanitized.user.id).toBe('[UUID_REDACTED]');
    });

    it('should sanitize arrays', () => {
      const input = {
        emails: ['a@b.cc', 'd@e.ff']
      };
      const { sanitized } = sanitizeObject(input, 'standard');
      expect(sanitized.emails).toEqual(['[EMAIL_REDACTED]', '[EMAIL_REDACTED]']);
    });

    it('should handle null and undefined', () => {
      const input = { a: null, b: undefined, c: 'x@y.zz' };
      const { sanitized } = sanitizeObject(input, 'standard');
      expect(sanitized.a).toBeNull();
      expect(sanitized.b).toBeUndefined();
      expect(sanitized.c).toBe('[EMAIL_REDACTED]');
    });

    it('should handle circular references', () => {
      const input = { name: 'test' };
      input.self = input;
      const { sanitized } = sanitizeObject(input, 'standard');
      expect(sanitized.self).toBe('[Circular]');
    });

    it('should preserve numbers and booleans', () => {
      const input = { count: 42, active: true, rate: 3.14 };
      const { sanitized } = sanitizeObject(input, 'standard');
      expect(sanitized).toEqual(input);
    });
  });

  describe('sanitizeLogData', () => {
    it('should sanitize Winston log info object', () => {
      const logInfo = {
        level: 'info',
        message: 'User logged in',
        userId: '00000000-0000-0000-0000-000000000000',
        email: 'x@x.xx',
        timestamp: '2026-03-05 10:00:00'
      };
      const sanitized = sanitizeLogData(logInfo);
      expect(sanitized.level).toBe('info');
      expect(sanitized.message).toBe('User logged in');
      expect(sanitized.userId).toBe('[UUID_REDACTED]');
      expect(sanitized.email).toBe('[EMAIL_REDACTED]');
      expect(sanitized.timestamp).toBe('2026-03-05 10:00:00');
    });

    it('should handle message with embedded sensitive data', () => {
      const logInfo = {
        level: 'info',
        message: '[Auth] User 000000:00000000-0000-0000-0000-000000000000 authenticated from 1.2.3.4'
      };
      const sanitized = sanitizeLogData(logInfo);
      expect(sanitized.message).toBe('[Auth] User [ATLASSIAN_ACCOUNT_REDACTED] authenticated from [IP_REDACTED]');
    });
  });

  describe('Redaction statistics', () => {
    it('should track redaction counts when audit enabled', () => {
      sanitizeString('x@x.xx', 'standard');
      sanitizeString('y@y.yy', 'standard');
      
      const stats = getRedactionStats();
      expect(stats.EMAIL).toBe(2);
    });

    it('should reset statistics correctly', () => {
      sanitizeString('x@x.xx', 'standard');
      resetRedactionStats();
      
      const stats = getRedactionStats();
      expect(stats.EMAIL).toBe(0);
    });
  });

  describe('Sanitization levels', () => {
    it('minimal level should only redact PII', () => {
      const input = 'Email: x@x.xx UUID: 00000000-0000-0000-0000-000000000000';
      const { sanitized } = sanitizeString(input, 'minimal');
      expect(sanitized).toContain('[EMAIL_REDACTED]');
      expect(sanitized).toContain('00000000-0000-0000-0000-000000000000'); // UUID not redacted
    });

    it('standard level should redact PII and identifiers', () => {
      const input = 'Email: x@x.xx UUID: 00000000-0000-0000-0000-000000000000';
      const { sanitized } = sanitizeString(input, 'standard');
      expect(sanitized).toContain('[EMAIL_REDACTED]');
      expect(sanitized).toContain('[UUID_REDACTED]');
    });

    it('strict level should redact everything including infrastructure', () => {
      const input = 'Sheet: sheets 1fgnIIUe9LLTLtZMtMNJAnpQAAm92d-1AxngPA2nJ2pM Config: pc-jira-857ce9';
      const { sanitized } = sanitizeString(input, 'strict');
      expect(sanitized).toContain('[SHEET_ID_REDACTED]');
      expect(sanitized).toContain('[PORTKEY_CONFIG_REDACTED]');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string', () => {
      const { sanitized } = sanitizeString('', 'standard');
      expect(sanitized).toBe('');
    });

    it('should handle string with no sensitive data', () => {
      const input = 'This is a normal log message with no PII';
      const { sanitized } = sanitizeString(input, 'standard');
      expect(sanitized).toBe(input);
    });

    it('should not modify non-string primitives', () => {
      const { sanitized: num } = sanitizeString(12345, 'standard');
      const { sanitized: bool } = sanitizeString(true, 'standard');
      expect(num).toBe(12345);
      expect(bool).toBe(true);
    });

    it('should handle deeply nested objects', () => {
      const input = {
        level1: {
          level2: {
            level3: {
              email: 'x@y.zz'
            }
          }
        }
      };
      const { sanitized } = sanitizeObject(input, 'standard');
      expect(sanitized.level1.level2.level3.email).toBe('[EMAIL_REDACTED]');
    });
  });
});

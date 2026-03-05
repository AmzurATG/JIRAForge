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
        const input = 'Sent notification to user@example.com';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Sent notification to [EMAIL_REDACTED]');
      });

      it('should redact multiple email addresses', () => {
        const input = 'From: admin@company.com To: user@example.org';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('From: [EMAIL_REDACTED] To: [EMAIL_REDACTED]');
      });

      it('should handle complex email formats', () => {
        const input = 'Contact: john.doe+test@sub.domain.co.uk';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Contact: [EMAIL_REDACTED]');
      });
    });

    describe('UUIDs', () => {
      it('should redact standard UUIDs', () => {
        const input = 'User ID: fa23333e-9e8f-4b13-bda9-833ca4f7c3cc';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('User ID: [UUID_REDACTED]');
      });

      it('should redact uppercase UUIDs', () => {
        const input = 'Cloud: 39B6EAB6-88FD-45B6-8BBC-DAD801BAC3BD';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Cloud: [UUID_REDACTED]');
      });

      it('should not redact UUIDs in minimal mode', () => {
        const input = 'User ID: fa23333e-9e8f-4b13-bda9-833ca4f7c3cc';
        const { sanitized } = sanitizeString(input, 'minimal');
        expect(sanitized).toBe(input);
      });
    });

    describe('Atlassian Account IDs', () => {
      it('should redact Atlassian account IDs before UUID pattern', () => {
        const input = 'Account: 712020:2e67c2ea-92ca-451d-9686-bb830a8da0af';
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
        const input = 'Request from 192.168.1.100';
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
        const input = 'Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Token: [JWT_REDACTED]');
      });
    });

    describe('API Keys', () => {
      it('should redact API keys with explicit labels', () => {
        const input = 'api_key=test_fake_key_for_unit_testing_only';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toContain('[API_KEY_REDACTED]');
      });

      it('should redact AWS access keys', () => {
        const input = 'Key: AKIAIOSFODNN7EXAMPLE';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Key: [AWS_KEY_REDACTED]');
      });

      it('should redact GitHub tokens', () => {
        const input = 'Token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Token: [GITHUB_TOKEN_REDACTED]');
      });
    });

    describe('Credit Cards', () => {
      it('should redact Visa card numbers', () => {
        const input = 'Card: 4111111111111111';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Card: [CREDIT_CARD_REDACTED]');
      });

      it('should redact MasterCard numbers', () => {
        const input = 'Card: 5500000000000004';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Card: [CREDIT_CARD_REDACTED]');
      });
    });

    describe('Phone Numbers', () => {
      it('should redact US phone numbers', () => {
        const input = 'Call: (555) 123-4567';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Call: [PHONE_REDACTED]');
      });

      it('should redact international format', () => {
        const input = 'Phone: +1-555-123-4567';
        const { sanitized } = sanitizeString(input, 'standard');
        expect(sanitized).toBe('Phone: [PHONE_REDACTED]');
      });
    });
  });

  describe('sanitizeObject', () => {
    it('should sanitize nested objects', () => {
      const input = {
        user: {
          email: 'test@example.com',
          name: 'John Doe',
          id: 'fa23333e-9e8f-4b13-bda9-833ca4f7c3cc'
        }
      };
      const { sanitized } = sanitizeObject(input, 'standard');
      expect(sanitized.user.email).toBe('[EMAIL_REDACTED]');
      expect(sanitized.user.name).toBe('John Doe');
      expect(sanitized.user.id).toBe('[UUID_REDACTED]');
    });

    it('should sanitize arrays', () => {
      const input = {
        emails: ['user1@test.com', 'user2@test.com']
      };
      const { sanitized } = sanitizeObject(input, 'standard');
      expect(sanitized.emails).toEqual(['[EMAIL_REDACTED]', '[EMAIL_REDACTED]']);
    });

    it('should handle null and undefined', () => {
      const input = { a: null, b: undefined, c: 'test@test.com' };
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
        userId: 'fa23333e-9e8f-4b13-bda9-833ca4f7c3cc',
        email: 'user@example.com',
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
        message: '[Auth] User 712020:2e67c2ea-92ca-451d-9686-bb830a8da0af authenticated from 192.168.1.1'
      };
      const sanitized = sanitizeLogData(logInfo);
      expect(sanitized.message).toBe('[Auth] User [ATLASSIAN_ACCOUNT_REDACTED] authenticated from [IP_REDACTED]');
    });
  });

  describe('Redaction statistics', () => {
    it('should track redaction counts when audit enabled', () => {
      sanitizeString('test@example.com', 'standard');
      sanitizeString('another@test.org', 'standard');
      
      const stats = getRedactionStats();
      expect(stats.EMAIL).toBe(2);
    });

    it('should reset statistics correctly', () => {
      sanitizeString('test@example.com', 'standard');
      resetRedactionStats();
      
      const stats = getRedactionStats();
      expect(stats.EMAIL).toBe(0);
    });
  });

  describe('Sanitization levels', () => {
    it('minimal level should only redact PII', () => {
      const input = 'Email: test@test.com UUID: fa23333e-9e8f-4b13-bda9-833ca4f7c3cc';
      const { sanitized } = sanitizeString(input, 'minimal');
      expect(sanitized).toContain('[EMAIL_REDACTED]');
      expect(sanitized).toContain('fa23333e-9e8f-4b13-bda9-833ca4f7c3cc'); // UUID not redacted
    });

    it('standard level should redact PII and identifiers', () => {
      const input = 'Email: test@test.com UUID: fa23333e-9e8f-4b13-bda9-833ca4f7c3cc';
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
              email: 'deep@nested.com'
            }
          }
        }
      };
      const { sanitized } = sanitizeObject(input, 'standard');
      expect(sanitized.level1.level2.level3.email).toBe('[EMAIL_REDACTED]');
    });
  });
});

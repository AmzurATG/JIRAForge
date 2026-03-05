/**
 * Log Sanitizer
 * 
 * Redacts sensitive information from log messages before they are written.
 * Implements PII protection for the AI-Server logging system.
 * 
 * @module utils/log-sanitizer
 */

'use strict';

// Configuration from environment
const SANITIZE_ENABLED = process.env.LOG_SANITIZE_ENABLED !== 'false';
const SANITIZE_LEVEL = process.env.LOG_SANITIZE_LEVEL || 'standard';
const SANITIZE_AUDIT = process.env.LOG_SANITIZE_AUDIT === 'true';

// Track redaction statistics for audit
const redactionStats = {
  EMAIL: 0,
  UUID: 0,
  ATLASSIAN_ACCOUNT: 0,
  ARI: 0,
  SHEET_ID: 0,
  JWT: 0,
  API_KEY: 0,
  IP_ADDRESS: 0,
  CREDIT_CARD: 0,
  PHONE: 0,
  PORTKEY_CONFIG: 0
};

/**
 * Sanitization pattern definitions
 * Order matters - more specific patterns should come before general ones
 */
const SANITIZATION_PATTERNS = {
  // ============================================
  // HIGH PRIORITY - PII (Always sanitized)
  // ============================================
  
  // Email addresses
  EMAIL: {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '[EMAIL_REDACTED]',
    levels: ['minimal', 'standard', 'strict']
  },
  
  // Credit card numbers (basic patterns for Visa, MasterCard, Amex)
  CREDIT_CARD: {
    pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    replacement: '[CREDIT_CARD_REDACTED]',
    levels: ['minimal', 'standard', 'strict']
  },
  
  // Phone numbers (various formats)
  PHONE: {
    pattern: /\b(?:\+?1[-.\s]?)?(?:\(?[0-9]{3}\)?[-.\s]?)?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
    replacement: '[PHONE_REDACTED]',
    levels: ['minimal', 'standard', 'strict']
  },
  
  // ============================================
  // MEDIUM PRIORITY - Account/System IDs
  // ============================================
  
  // Atlassian Account IDs (format: 712020:uuid) - Must come before UUID pattern
  ATLASSIAN_ACCOUNT: {
    pattern: /\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    replacement: '[ATLASSIAN_ACCOUNT_REDACTED]',
    levels: ['standard', 'strict']
  },
  
  // Atlassian ARIs (app IDs, installation IDs)
  ARI: {
    pattern: /ari:cloud:[a-z]+::[a-z]+\/[a-f0-9-]+/gi,
    replacement: '[ARI_REDACTED]',
    levels: ['standard', 'strict']
  },
  
  // UUIDs (user IDs, cloud IDs, org IDs)
  UUID: {
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    replacement: '[UUID_REDACTED]',
    levels: ['standard', 'strict']
  },
  
  // IP Addresses (IPv4)
  IP_ADDRESS: {
    pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    replacement: '[IP_REDACTED]',
    levels: ['standard', 'strict']
  },
  
  // ============================================
  // SECURITY - Tokens and Keys
  // ============================================
  
  // JWT Tokens (three base64 sections)
  JWT: {
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[JWT_REDACTED]',
    levels: ['minimal', 'standard', 'strict']
  },
  
  // Bearer tokens in authorization headers
  BEARER_TOKEN: {
    pattern: /(?:bearer|authorization)[\s:]+([A-Za-z0-9_-]{20,})/gi,
    replacement: 'Bearer [TOKEN_REDACTED]',
    levels: ['minimal', 'standard', 'strict']
  },
  
  // API Keys with explicit labels
  API_KEY: {
    pattern: /(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)[\s]*[=:]+[\s]*["']?([A-Za-z0-9_-]{16,})["']?/gi,
    replacement: '[API_KEY_REDACTED]',
    levels: ['minimal', 'standard', 'strict']
  },
  
  // AWS Access Key IDs
  AWS_KEY: {
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
    replacement: '[AWS_KEY_REDACTED]',
    levels: ['minimal', 'standard', 'strict']
  },
  
  // GitHub tokens
  GITHUB_TOKEN: {
    pattern: /\b(gh[ps]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]+)\b/g,
    replacement: '[GITHUB_TOKEN_REDACTED]',
    levels: ['minimal', 'standard', 'strict']
  },
  
  // Slack tokens
  SLACK_TOKEN: {
    pattern: /\b(xox[baprs]-[0-9]{10,13}-[A-Za-z0-9-]+)\b/g,
    replacement: '[SLACK_TOKEN_REDACTED]',
    levels: ['minimal', 'standard', 'strict']
  },
  
  // ============================================
  // INFRASTRUCTURE - Config IDs (Strict only)
  // ============================================
  
  // Google Sheet IDs (44 char alphanumeric)
  SHEET_ID: {
    pattern: /\b[A-Za-z0-9_-]{43,45}\b/g,
    replacement: '[SHEET_ID_REDACTED]',
    levels: ['strict'],
    contextRequired: ['sheet', 'spreadsheet', 'sheets', 'google']
  },
  
  // Portkey Config IDs (pc-xxxx-xxxxx format)
  PORTKEY_CONFIG: {
    pattern: /\bpc-[a-z]+-[a-f0-9]+\b/gi,
    replacement: '[PORTKEY_CONFIG_REDACTED]',
    levels: ['strict']
  }
};

/**
 * Check if a pattern should be applied based on sanitization level
 * @param {Object} patternConfig - Pattern configuration
 * @param {string} level - Current sanitization level
 * @returns {boolean}
 */
function shouldApplyPattern(patternConfig, level) {
  return patternConfig.levels.includes(level);
}

/**
 * Check if context is required and present
 * @param {Object} patternConfig - Pattern configuration
 * @param {string} text - Text being checked
 * @returns {boolean}
 */
function hasRequiredContext(patternConfig, text) {
  if (!patternConfig.contextRequired) return true;
  const lowerText = text.toLowerCase();
  return patternConfig.contextRequired.some(ctx => lowerText.includes(ctx));
}

/**
 * Sanitize a string value
 * @param {string} value - String to sanitize
 * @param {string} level - Sanitization level
 * @returns {Object} - { sanitized: string, redactions: Object }
 */
function sanitizeString(value, level) {
  if (typeof value !== 'string') return { sanitized: value, redactions: {} };
  
  let sanitized = value;
  const redactions = {};
  
  for (const [type, config] of Object.entries(SANITIZATION_PATTERNS)) {
    if (!shouldApplyPattern(config, level)) continue;
    if (!hasRequiredContext(config, value)) continue;
    
    // Create a new regex instance for each application
    const regex = new RegExp(config.pattern.source, config.pattern.flags);
    const matches = value.match(regex);
    
    if (matches && matches.length > 0) {
      sanitized = sanitized.replace(regex, config.replacement);
      redactions[type] = (redactions[type] || 0) + matches.length;
      
      // Update global stats if audit is enabled
      if (SANITIZE_AUDIT) {
        redactionStats[type] = (redactionStats[type] || 0) + matches.length;
      }
    }
  }
  
  return { sanitized, redactions };
}

/**
 * Recursively sanitize an object
 * @param {any} obj - Object to sanitize
 * @param {string} level - Sanitization level
 * @param {Set} seen - Set of seen objects (circular reference protection)
 * @returns {Object} - { sanitized: any, redactions: Object }
 */
function sanitizeObject(obj, level, seen = new Set()) {
  // Handle null/undefined
  if (obj === null || obj === undefined) {
    return { sanitized: obj, redactions: {} };
  }
  
  // Handle strings
  if (typeof obj === 'string') {
    return sanitizeString(obj, level);
  }
  
  // Handle primitives (numbers, booleans)
  if (typeof obj !== 'object') {
    return { sanitized: obj, redactions: {} };
  }
  
  // Circular reference protection
  if (seen.has(obj)) {
    return { sanitized: '[Circular]', redactions: {} };
  }
  seen.add(obj);
  
  // Handle arrays
  if (Array.isArray(obj)) {
    const allRedactions = {};
    const sanitizedArray = obj.map(item => {
      const { sanitized, redactions } = sanitizeObject(item, level, seen);
      mergeRedactions(allRedactions, redactions);
      return sanitized;
    });
    return { sanitized: sanitizedArray, redactions: allRedactions };
  }
  
  // Handle Error objects specially
  if (obj instanceof Error) {
    const { sanitized: sanitizedMessage, redactions: msgRedactions } = sanitizeString(obj.message, level);
    const { sanitized: sanitizedStack, redactions: stackRedactions } = sanitizeString(obj.stack || '', level);
    
    const sanitizedError = new Error(sanitizedMessage);
    sanitizedError.stack = sanitizedStack;
    sanitizedError.name = obj.name;
    
    return {
      sanitized: sanitizedError,
      redactions: mergeRedactions({}, msgRedactions, stackRedactions)
    };
  }
  
  // Handle plain objects
  const allRedactions = {};
  const sanitizedObj = {};
  
  for (const [key, value] of Object.entries(obj)) {
    // Also sanitize object keys (rare but possible)
    const { sanitized: sanitizedKey } = sanitizeString(key, level);
    const { sanitized: sanitizedValue, redactions } = sanitizeObject(value, level, seen);
    
    sanitizedObj[sanitizedKey] = sanitizedValue;
    mergeRedactions(allRedactions, redactions);
  }
  
  return { sanitized: sanitizedObj, redactions: allRedactions };
}

/**
 * Merge redaction counts
 * @param {Object} target - Target object to merge into
 * @param  {...Object} sources - Source objects
 * @returns {Object} - Merged object
 */
function mergeRedactions(target, ...sources) {
  for (const source of sources) {
    for (const [key, count] of Object.entries(source)) {
      target[key] = (target[key] || 0) + count;
    }
  }
  return target;
}

/**
 * Main sanitization function for log data
 * @param {Object} info - Winston log info object
 * @returns {Object} - Sanitized log info
 */
function sanitizeLogData(info) {
  if (!SANITIZE_ENABLED) return info;
  
  const level = SANITIZE_LEVEL;
  const { sanitized, redactions } = sanitizeObject(info, level);
  
  // Add redaction metadata if audit enabled and redactions occurred
  if (SANITIZE_AUDIT && Object.keys(redactions).length > 0) {
    sanitized._redactions = redactions;
  }
  
  return sanitized;
}

/**
 * Create a Winston format for sanitization
 * @returns {Object} - Winston format
 */
function createSanitizeFormat() {
  const winston = require('winston');
  
  return winston.format((info) => {
    return sanitizeLogData(info);
  })();
}

/**
 * Get current redaction statistics
 * @returns {Object} - Statistics object
 */
function getRedactionStats() {
  return { ...redactionStats };
}

/**
 * Reset redaction statistics
 */
function resetRedactionStats() {
  for (const key of Object.keys(redactionStats)) {
    redactionStats[key] = 0;
  }
}

/**
 * Check if sanitization is enabled
 * @returns {boolean}
 */
function isEnabled() {
  return SANITIZE_ENABLED;
}

/**
 * Get current sanitization level
 * @returns {string}
 */
function getLevel() {
  return SANITIZE_LEVEL;
}

module.exports = {
  sanitizeLogData,
  sanitizeString,
  sanitizeObject,
  createSanitizeFormat,
  getRedactionStats,
  resetRedactionStats,
  isEnabled,
  getLevel,
  SANITIZATION_PATTERNS
};

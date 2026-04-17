# Log PII Sanitization Implementation Plan

## Overview

This document outlines the implementation plan to extend PII protection to the AI-Server logging system, based on the analysis of the current log files and existing Presidio integration in the python-desktop-app.

## Current State Analysis

### Existing Presidio Integration (Python Desktop App)

Location: `python-desktop-app/privacy/`

The python-desktop-app already has a comprehensive privacy filtering system:

| Component | File | Purpose |
|-----------|------|---------|
| PresidioDetector | `detectors/presidio_detector.py` | Microsoft Presidio wrapper for PII detection |
| CustomPatternDetector | `detectors/custom_patterns.py` | Regex-based detection for secrets, API keys, passwords |
| PrivacyFilter | `filter.py` | Main coordinator combining multiple detectors |
| TextRedactor | `redactors.py` | Handles redaction with configurable strategies |

**Note:** This is Python-based and cannot be directly used in the Node.js ai-server.

### AI-Server Logging Architecture (Node.js)

Location: `ai-server/src/utils/logger.js`

- Uses **Winston** for logging
- JSON format with timestamps
- Outputs to both files (`logs/error.log`, `logs/combined.log`) and console
- **No current sanitization or PII redaction**

## Identified Sensitive Information in Logs

Based on analysis of `AI Analysis Serve logs.txt`:

### 1. Personally Identifiable Information (PII)

| Category | Example | Log Location |
|----------|---------|--------------|
| Email Addresses | `solutions.atg@amzur.com` | Notification service logs |
| User UUIDs | `fa23333e-9e8f-4b13-bda9-833ca4f7c3cc` | Activity, notification, user-related logs |
| Atlassian Account IDs | `712020:2e67c2ea-92ca-451d-9686-bb830a8da0af` | Auth and FIT token logs |

### 2. System & Security Information

| Category | Example | Risk Level |
|----------|---------|------------|
| Cloud IDs | `39b6eab6-88fd-45b6-8bbc-dad801bac3bd` | Medium |
| Installation IDs | `ari:cloud:ecosystem::installation/ffde2508-...` | Medium |
| App IDs | `ari:cloud:ecosystem::app/c8bab1dc-ae32-4e6f-...` | Low |
| Google Sheet IDs | `1fgnIIUe9LLTLtZMtMNJAnpQAAm92d-1AxngPA2nJ2pM` | Medium |
| Security Warnings | Exposed query patterns to sensitive tables | High |

### 3. Infrastructure Details

| Category | Example | Risk Level |
|----------|---------|------------|
| AI Model Names | `Gemini-2.0-Flash`, `Qwen2.5-VL-32B` | Low |
| API Configurations | `USE_PORTKEY=true`, `USE_FIREWORKS=true` | Medium |
| Portkey Config IDs | `pc-jira-857ce9` | Medium |
| Version Information | `current=1.0.0`, `latest=1.2.1` | Low |

## Implementation Plan

### Phase 1: Create Winston Log Sanitizer (High Priority)

**Goal:** Add a Winston format transformer that sanitizes sensitive data before logging.

#### 1.1 Create Log Sanitizer Utility

Create new file: `ai-server/src/utils/log-sanitizer.js`

```javascript
/**
 * Log Sanitizer
 * 
 * Redacts sensitive information from log messages before they are written.
 * Similar approach to python-desktop-app/privacy but implemented in Node.js.
 */

// Patterns to detect and redact
const SANITIZATION_PATTERNS = [
  // Email addresses
  { 
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '[EMAIL_REDACTED]',
    type: 'EMAIL'
  },
  
  // UUIDs (user IDs, cloud IDs, org IDs)
  {
    pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    replacement: '[UUID_REDACTED]',
    type: 'UUID'
  },
  
  // Atlassian Account IDs (format: 712020:uuid)
  {
    pattern: /\d{6}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    replacement: '[ATLASSIAN_ACCOUNT_REDACTED]',
    type: 'ATLASSIAN_ACCOUNT'
  },
  
  // Atlassian ARIs (app IDs, installation IDs)
  {
    pattern: /ari:cloud:[a-z]+::[a-z]+\/[a-f0-9-]+/gi,
    replacement: '[ARI_REDACTED]',
    type: 'ARI'
  },
  
  // Google Sheet IDs (long alphanumeric strings)
  {
    pattern: /\b[A-Za-z0-9_-]{40,}\b/g,
    replacement: '[SHEET_ID_REDACTED]',
    type: 'SHEET_ID',
    context: ['sheet', 'spreadsheet', 'sheets']
  },
  
  // JWT Tokens
  {
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[JWT_REDACTED]',
    type: 'JWT'
  },
  
  // API Keys (generic long alphanumeric)
  {
    pattern: /(?:api[_-]?key|secret|token)[=:]["']?([A-Za-z0-9_-]{20,})["']?/gi,
    replacement: '[API_KEY_REDACTED]',
    type: 'API_KEY'
  },
  
  // IP Addresses
  {
    pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    replacement: '[IP_REDACTED]',
    type: 'IP_ADDRESS'
  }
];

// Export sanitization function
```

#### 1.2 Update Winston Logger Configuration

Update: `ai-server/src/utils/logger.js`

```javascript
const winston = require('winston');
const { sanitizeLogData } = require('./log-sanitizer');

// Add sanitization format
const sanitizeFormat = winston.format((info) => {
  return sanitizeLogData(info);
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    sanitizeFormat(),  // Add sanitization before JSON formatting
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  // ... rest of config
});
```

### Phase 2: Environment-Based Sanitization Control

**Goal:** Allow configurable sanitization levels for different environments.

#### 2.1 Configuration Options

Add to `.env`:
```bash
# Log Sanitization Settings
LOG_SANITIZE_ENABLED=true
LOG_SANITIZE_LEVEL=standard  # minimal, standard, strict
LOG_SANITIZE_AUDIT=false     # Log redaction statistics
```

#### 2.2 Sanitization Levels

| Level | What's Redacted |
|-------|-----------------|
| `minimal` | Only PII (emails, SSN, credit cards) |
| `standard` | PII + UUIDs + Account IDs + IPs |
| `strict` | All patterns + partial UUID masking + infrastructure details |

### Phase 3: Selective Field-Level Sanitization

**Goal:** Allow specific log calls to bypass or enforce sanitization.

#### 3.1 Logger Extensions

```javascript
// Log with explicit sanitization
logger.infoSafe('[Auth] User authenticated', { userId: 'xxx' });

// Log with audit trail (tracks what was redacted)
logger.infoAudit('[Security] Access attempt', { data, audit: true });

// Log raw (for debugging, only in development)
logger.infoRaw('[Debug] Raw data', { data }, { bypassSanitize: true });
```

### Phase 4: Migration of Existing Log Calls

**Goal:** Review and update existing log calls for sensitive data handling.

#### 4.1 High-Priority Files to Update

| File | Issue | Action |
|------|-------|--------|
| `middleware/forge-auth.js` | Logs full context with accountId, cloudId | Remove/mask sensitive fields |
| `controllers/forge-proxy-controller.js` | Logs security warnings with identifiers | Mask identifiers in warnings |
| `services/notifications/*.js` | Logs email addresses | Mask emails |
| `services/activity-service.js` | Logs user UUIDs | Mask UUIDs |
| `services/sheets-logger.js` | Logs sheet IDs | Already internal, consider masking |

#### 4.2 Refactoring Pattern

**Before:**
```javascript
logger.info('[FIT] Extracted context:', context);
```

**After:**
```javascript
logger.info('[FIT] Request authenticated', {
  cloudId: context.cloudId ? '[PRESENT]' : '[MISSING]',
  hasAccountId: !!context.accountId,
  path: req.path
});
```

### Phase 5: Audit and Compliance Logging

**Goal:** Track what was redacted for compliance purposes.

#### 5.1 Redaction Audit Log

- Separate audit log file: `logs/sanitization-audit.log`
- Records: timestamp, redaction type, count, log source
- Does NOT record actual sensitive values

#### 5.2 Metrics Export

```javascript
// Expose sanitization metrics via /health endpoint
{
  "sanitization": {
    "enabled": true,
    "level": "standard",
    "redactions_24h": {
      "EMAIL": 45,
      "UUID": 234,
      "ATLASSIAN_ACCOUNT": 89
    }
  }
}
```

## File Structure After Implementation

```
ai-server/src/
├── utils/
│   ├── logger.js                    # Updated with sanitization
│   ├── log-sanitizer.js             # NEW: Core sanitization logic
│   ├── log-sanitizer.config.js      # NEW: Pattern definitions
│   └── log-sanitizer.test.js        # NEW: Unit tests
├── middleware/
│   ├── forge-auth.js                # Updated: reduce logged fields
│   └── ...
├── services/
│   ├── notifications/
│   │   └── *.js                     # Updated: mask emails
│   └── ...
└── ...
```

## Testing Strategy

### Unit Tests

```javascript
describe('LogSanitizer', () => {
  it('should redact email addresses', () => {
    const input = { message: 'Sent to user@example.com' };
    const output = sanitize(input);
    expect(output.message).toBe('Sent to [EMAIL_REDACTED]');
  });

  it('should redact UUIDs', () => {
    const input = { userId: 'fa23333e-9e8f-4b13-bda9-833ca4f7c3cc' };
    const output = sanitize(input);
    expect(output.userId).toBe('[UUID_REDACTED]');
  });

  it('should handle nested objects', () => {
    const input = { user: { email: 'test@test.com', name: 'John' } };
    const output = sanitize(input);
    expect(output.user.email).toBe('[EMAIL_REDACTED]');
    expect(output.user.name).toBe('John');
  });
});
```

### Integration Tests

1. Verify log files contain no raw PII
2. Test sanitization across all log transports
3. Performance benchmarking (sanitization overhead)

## Rollout Plan

### Week 1: Core Implementation
- [ ] Create `log-sanitizer.js` with basic patterns
- [ ] Update `logger.js` with sanitization format
- [ ] Add environment configuration
- [ ] Write unit tests

### Week 2: Pattern Refinement & Migration
- [ ] Review all log calls in codebase
- [ ] Update high-priority files (forge-auth, notifications)
- [ ] Add context-aware pattern matching
- [ ] Test in development environment

### Week 3: Testing & Validation
- [ ] Integration testing
- [ ] Performance testing
- [ ] Security review of patterns
- [ ] Audit log implementation

### Week 4: Deployment & Monitoring
- [ ] Deploy to staging
- [ ] Monitor sanitization metrics
- [ ] Fine-tune patterns based on real logs
- [ ] Deploy to production

## Security Considerations

1. **Default to Secure**: Sanitization enabled by default
2. **No Bypass in Production**: `bypassSanitize` only works in development
3. **Pattern Updates**: Establish process for adding new patterns
4. **Audit Trail**: Keep record of what types of data were redacted
5. **Defense in Depth**: Sanitization is last line of defense; fix source first

## Comparison: Python Presidio vs Proposed Node.js Solution

| Feature | Python Presidio | Node.js Log Sanitizer |
|---------|-----------------|----------------------|
| NLP-based detection | Yes (spaCy) | No (regex only) |
| Custom patterns | Yes | Yes |
| Performance | Heavier | Lightweight |
| Maintenance | External dependency | In-house |
| False positives | Lower (ML-based) | Higher (regex) |
| Integration | Python apps | Node.js logger |

## Future Enhancements

1. **ML-Based Detection**: Integrate with cloud-based PII detection APIs for improved accuracy
2. **Real-time Alerts**: Alert on unusual redaction patterns (potential data breach)
3. **Log Replay**: Tool to sanitize historical logs
4. **Cross-Service**: Share patterns with python-desktop-app

## References

- [Microsoft Presidio](https://github.com/microsoft/presidio)
- [Winston Formats](https://github.com/winstonjs/winston#formats)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- Existing implementation: `python-desktop-app/privacy/`

---

**Document Version:** 1.0  
**Created:** March 5, 2026  
**Author:** AI Analysis  
**Status:** Planning

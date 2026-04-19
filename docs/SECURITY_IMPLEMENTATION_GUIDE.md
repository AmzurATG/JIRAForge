# Security Implementation Guide
**Date:** April 3, 2026  
**Purpose:** Step-by-step guide to implement DDoS protection improvements

---

## Quick Start: High Priority Fixes (30 minutes)

### 1. Update axios Version (5 minutes)

```bash
cd /home/appuser/root/JIRAForge/ai-server

# Check current version
npm list axios

# Update to latest
npm install axios@latest

# Verify installation
npm list axios

# Run tests to ensure compatibility
npm test
```

**Risk Mitigated:** Known CVEs in older axios versions

---

### 2. Implement Safe JSON Parser (10 minutes)

The safe JSON parser has been created at:
- `/ai-server/src/utils/safe-json-parser.js`

**Update existing code to use safe parser:**

#### Example 1: screenshot-controller.js

```javascript
// BEFORE
const parsed = JSON.parse(userAssignedIssues);

// AFTER
const { safeJSONParseByContext } = require('../utils/safe-json-parser');
const parsed = safeJSONParseByContext(userAssignedIssues, 'user-assigned-issues');
```

#### Example 2: polling-service.js

```javascript
// BEFORE
parsed = JSON.parse(parsed);

// AFTER
const { safeJSONParseByContext } = require('../utils/safe-json-parser');
parsed = safeJSONParseByContext(parsed, 'ai-response') || [];
```

#### Example 3: clustering-service.js

```javascript
// BEFORE
clusteringResult = JSON.parse(cleanedResponse);

// AFTER
const { safeJSONParseByContext } = require('../utils/safe-json-parser');
clusteringResult = safeJSONParseByContext(cleanedResponse, 'ai-response');
```

**Files to Update:**
1. `/ai-server/src/controllers/screenshot-controller.js` (line 30)
2. `/ai-server/src/services/polling-service.js` (line 263)
3. `/ai-server/src/services/clustering-service.js` (line 263, 289)
4. `/ai-server/src/services/activity-service.js` (lines 240, 305, 335, 346, 508, 514, 601, 608)
5. `/ai-server/src/services/ai/vision-analyzer.js` (line 198)
6. `/ai-server/src/services/feedback-service.js` (line 62)
7. `/ai-server/src/middleware/forge-auth.js` (line 57)

**Risk Mitigated:** CPU exhaustion from parsing maliciously large JSON

---

### 3. Add Request ID Middleware (10 minutes)

The request ID middleware has been created at:
- `/ai-server/src/middleware/request-id.js`

**Update index.js to use request ID middleware:**

```javascript
// File: /ai-server/src/index.js

// Add import at top
const { requestIdMiddleware, rateLimitHandler } = require('./middleware/request-id');

// Add middleware BEFORE routes (after helmet/cors)
app.use(helmet());
app.use(cors(corsOptions));
app.use(requestIdMiddleware);  // ✅ Add this line
app.use(express.json({ limit: '1mb' }));

// Update rate limiters to use enhanced handler
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,  // ✅ Add this line
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  }
});

// Apply same to other rate limiters (authLimiter, feedbackLimiter, etc.)
```

**Risk Mitigated:** Inability to trace DDoS attack sources

---

### 4. Add Clustering User Limit (5 minutes)

**Update clustering-polling-service.js:**

```javascript
// File: /ai-server/src/services/clustering-polling-service.js

// Add at top with other constants
const MAX_USERS_PER_RUN = Number.parseInt(process.env.CLUSTERING_MAX_USERS || '1000', 10);

// Inside runClustering() function, after getting usersWithUnassigned:
if (usersWithUnassigned.length === 0) {
  logger.info('[Clustering] No users with unassigned work found');
  return true;
}

// ✅ Add this block
if (usersWithUnassigned.length > MAX_USERS_PER_RUN) {
  logger.warn('[Clustering] %d users found, limiting to %d per run (set CLUSTERING_MAX_USERS to increase)', 
    usersWithUnassigned.length, MAX_USERS_PER_RUN);
  usersWithUnassigned = usersWithUnassigned.slice(0, MAX_USERS_PER_RUN);
}

logger.info(`[Clustering] Found ${usersWithUnassigned.length} users with unassigned work`);
```

**Add to .env file:**

```bash
# Clustering limits (DDoS protection)
CLUSTERING_MAX_USERS=1000
```

**Risk Mitigated:** Unbounded memory usage during clustering

---

## Medium Priority Fixes (1 hour)

### 5. Increase Upload Timeout for Large Files (10 minutes)

**Update feedback-service.js:**

```javascript
// File: /ai-server/src/services/feedback-service.js

// Find the attachSingleImage function
await axios.post(attachmentUrl, formData, {
  headers: {
    'Authorization': `Basic ${basicAuth}`,
    'X-Atlassian-Token': 'no-check',
    ...formData.getHeaders()
  },
  maxBodyLength: 10 * 1024 * 1024,
  maxContentLength: 10 * 1024 * 1024,
  maxRedirects: 5,
  timeout: 90000  // ✅ Changed from 30000 (30s) to 90000 (90s)
});
```

**Also update in createJiraIssue function:**

```javascript
const retryResponse = await axios.post(apiUrl, requestBody, {
  headers,
  timeout: 60000,  // ✅ Changed from 30000 to 60000 for API calls
  maxContentLength: 5 * 1024 * 1024,
  maxBodyLength: 5 * 1024 * 1024,
  maxRedirects: 5
});
```

**Risk Mitigated:** Upload timeouts causing request queuing

---

### 6. Monitor Polling Cycle Skips (15 minutes)

**Update polling-service.js:**

```javascript
// File: /ai-server/src/services/polling-service.js

class PollingService {
  isRunning = false;
  intervalId = null;
  pollInterval = Number.parseInt(process.env.POLLING_INTERVAL_MS || '180000', 10);
  batchSize = Number.parseInt(process.env.POLLING_BATCH_SIZE || '10', 10);
  processing = false;
  skippedCycles = 0;  // ✅ Add this property

  async processPendingScreenshots() {
    // Skip if already processing (prevent overlapping runs)
    if (this.processing) {
      this.skippedCycles++;  // ✅ Add this
      
      // ✅ Add this block
      if (this.skippedCycles > 5) {
        logger.error('[Polling] ALERT: Service falling behind - %d consecutive cycles skipped', this.skippedCycles, {
          warning: 'Polling interval may be too short or processing is too slow',
          suggestion: 'Increase POLLING_INTERVAL_MS or reduce POLLING_BATCH_SIZE'
        });
      } else {
        logger.warn('[Polling] Previous cycle still running, skipping cycle #%d', this.skippedCycles);
      }
      
      return;
    }

    this.skippedCycles = 0;  // ✅ Add this (reset on successful cycle)
    this.processing = true;
    
    // ... rest of the function
  }
}
```

**Add monitoring alert in .env:**

```bash
# Polling monitoring
POLLING_CYCLE_SKIP_ALERT_THRESHOLD=5
```

**Risk Mitigated:** Silent polling backlog building up

---

### 7. Add Promise.all() Validation (10 minutes)

**Update feedback-controller.js:**

```javascript
// File: /ai-server/src/controllers/feedback-controller.js

// In submitFeedback function, before Promise.all:
const MAX_CONCURRENT_UPLOADS = 3;

if (uploadPromises.length > MAX_CONCURRENT_UPLOADS) {
  logger.error('[Feedback] Too many images', {
    count: uploadPromises.length,
    max: MAX_CONCURRENT_UPLOADS
  });
  throw new Error(`Maximum ${MAX_CONCURRENT_UPLOADS} images allowed`);
}

const results = await Promise.all(uploadPromises);
```

**Risk Mitigated:** Unbounded concurrent operations

---

### 8. Add Axios Response Size Validation (15 minutes)

**Create new utility:** `/ai-server/src/utils/axios-helpers.js`

```javascript
/**
 * Axios Helpers
 * Enhanced axios wrappers with automatic size/timeout protection
 */

const axios = require('axios');
const logger = require('./logger');

// Default limits
const DEFAULT_TIMEOUT = 10000;           // 10s
const DEFAULT_MAX_CONTENT_LENGTH = 1024 * 1024;  // 1MB
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Safe axios GET request with automatic limits
 */
async function safeGet(url, options = {}) {
  const config = {
    timeout: options.timeout || DEFAULT_TIMEOUT,
    maxContentLength: options.maxContentLength || DEFAULT_MAX_CONTENT_LENGTH,
    maxBodyLength: options.maxBodyLength || DEFAULT_MAX_CONTENT_LENGTH,
    maxRedirects: options.maxRedirects || DEFAULT_MAX_REDIRECTS,
    ...options
  };

  logger.debug('[SafeAxios GET]', { url, timeout: config.timeout });
  
  return axios.get(url, config);
}

/**
 * Safe axios POST request with automatic limits
 */
async function safePost(url, data, options = {}) {
  const config = {
    timeout: options.timeout || DEFAULT_TIMEOUT,
    maxContentLength: options.maxContentLength || DEFAULT_MAX_CONTENT_LENGTH,
    maxBodyLength: options.maxBodyLength || DEFAULT_MAX_CONTENT_LENGTH,
    maxRedirects: options.maxRedirects || DEFAULT_MAX_REDIRECTS,
    ...options
  };

  logger.debug('[SafeAxios POST]', { url, timeout: config.timeout });
  
  return axios.post(url, data, config);
}

module.exports = {
  safeGet,
  safePost,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_REDIRECTS
};
```

**Risk Mitigated:** Unbounded response sizes from external APIs

---

### 9. Add Environment Variable Validation (10 minutes)

**Create new file:** `/ai-server/src/utils/env-validator.js`

```javascript
/**
 * Environment Variable Validator
 * Validates required env vars and security configurations on startup
 */

const logger = require('./logger');

const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'AI_SERVER_URL',
  'ATLASSIAN_CLIENT_ID',
  'ATLASSIAN_CLIENT_SECRET',
  'JWT_SECRET'
];

const SECURITY_ENV_VARS = {
  'POLLING_INTERVAL_MS': { min: 60000, max: 600000, default: 180000 },  // 1-10 min
  'POLLING_BATCH_SIZE': { min: 1, max: 50, default: 10 },
  'CLUSTERING_MAX_USERS': { min: 10, max: 10000, default: 1000 },
  'CLUSTERING_CONCURRENCY': { min: 1, max: 20, default: 5 },
  'AI_REQUEST_TIMEOUT_MS': { min: 10000, max: 300000, default: 60000 }
};

function validateEnvironment() {
  logger.info('[EnvValidator] Validating environment configuration...');
  
  let hasErrors = false;

  // Check required variables
  for (const envVar of REQUIRED_ENV_VARS) {
    if (!process.env[envVar]) {
      logger.error(`[EnvValidator] Missing required environment variable: ${envVar}`);
      hasErrors = true;
    }
  }

  // Validate security-critical numeric variables
  for (const [envVar, config] of Object.entries(SECURITY_ENV_VARS)) {
    const value = Number.parseInt(process.env[envVar]);
    
    if (process.env[envVar] && (isNaN(value) || value < config.min || value > config.max)) {
      logger.warn(`[EnvValidator] ${envVar}=${process.env[envVar]} is outside recommended range [${config.min}, ${config.max}]`);
      logger.warn(`[EnvValidator] Using default: ${config.default}`);
    }
  }

  if (hasErrors) {
    logger.error('[EnvValidator] Environment validation failed - server may not function correctly');
    process.exit(1);
  }

  logger.info('[EnvValidator] Environment validation passed ✓');
}

module.exports = { validateEnvironment };
```

**Update index.js to validate on startup:**

```javascript
// File: /ai-server/src/index.js

// Add at top
const { validateEnvironment } = require('./utils/env-validator');

// Add before app.listen()
validateEnvironment();

const server = app.listen(PORT, () => {
  logger.info(`AI Server running on port ${PORT}`);
});
```

**Risk Mitigated:** Misconfiguration leading to security vulnerabilities

---

## Testing the Implementations

### 1. Test Safe JSON Parser

```bash
cd /home/appuser/root/JIRAForge/ai-server

# Create test file
cat > test-safe-json-parser.js << 'EOF'
const { safeJSONParse, safeJSONParseByContext } = require('./src/utils/safe-json-parser');

// Test 1: Normal parsing
console.log('Test 1: Normal JSON parsing');
const normal = safeJSONParse('{"key": "value"}');
console.log('Result:', normal);

// Test 2: Large JSON (should fail)
console.log('\nTest 2: Large JSON (should fail)');
const large = 'x'.repeat(2 * 1024 * 1024); // 2MB
const result = safeJSONParse(`{"data": "${large}"}`, { maxSize: 1024 * 1024 });
console.log('Result:', result); // Should be null

// Test 3: Context-based parsing
console.log('\nTest 3: Context-based parsing');
const issues = safeJSONParseByContext('{"issues": []}', 'user-assigned-issues');
console.log('Result:', issues);

console.log('\n✅ All tests completed');
EOF

node test-safe-json-parser.js
```

### 2. Test Request ID Middleware

```bash
# Start the server
npm start

# In another terminal, test the request ID
curl -v http://localhost:3001/health

# You should see X-Request-ID in response headers
```

### 3. Load Test Rate Limiting

```bash
# Install Apache Bench (if not installed)
sudo apt-get install apache2-utils

# Test rate limiting
ab -n 200 -c 10 http://localhost:3001/health

# Check logs for rate limit warnings
tail -f logs/combined.log | grep RateLimit
```

---

## Environment Variables Reference

Add these to your `.env` file:

```bash
# ============================================================================
# DDOS PROTECTION & SECURITY
# ============================================================================

# Polling Service Limits
POLLING_INTERVAL_MS=180000           # 3 minutes (default)
POLLING_BATCH_SIZE=10                # Process 10 screenshots per cycle
SCREENSHOT_PROCESSING_TIMEOUT_MS=90000  # 90s timeout per screenshot

# Clustering Limits
CLUSTERING_MAX_USERS=1000            # Max users to process per clustering run
CLUSTERING_CONCURRENCY=5             # Concurrent user processing
CLUSTERING_SCHEDULE_HOUR=2           # Run at 2 AM daily
CLUSTERING_SCHEDULE_MINUTE=0

# AI Request Limits
AI_REQUEST_TIMEOUT_MS=60000          # 60s timeout for AI requests
USE_OCR_FALLBACK=true                # Enable OCR fallback

# Rate Limiting (Redis - recommended for production)
# REDIS_URL=redis://localhost:6379
# RATE_LIMIT_REDIS_PREFIX=rl:

# Monitoring & Alerts
POLLING_CYCLE_SKIP_ALERT_THRESHOLD=5  # Alert after 5 skipped cycles
LOG_LEVEL=info                        # info, debug, warn, error
```

---

## Deployment Checklist

Before deploying to production:

- [ ] Update axios to latest version
- [ ] Implement safe JSON parser in all locations
- [ ] Add request ID middleware
- [ ] Set clustering user limit
- [ ] Increase upload timeouts
- [ ] Add polling cycle monitoring
- [ ] Validate Promise.all() limits
- [ ] Add environment variable validation
- [ ] Configure Redis for rate limiting (production)
- [ ] Set up monitoring dashboard
- [ ] Configure alerting for security events
- [ ] Run load tests
- [ ] Review logs for anomalies
- [ ] Update documentation

---

## Monitoring & Alerting

### Key Metrics to Track

```javascript
// Example Prometheus metrics (add prometheus-client)
const prometheus = require('prom-client');

const requestDuration = new prometheus.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code']
});

const rateLimitHits = new prometheus.Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['endpoint', 'ip']
});

const pollingCyclesSkipped = new prometheus.Counter({
  name: 'polling_cycles_skipped_total',
  help: 'Total number of skipped polling cycles'
});
```

### Alert Rules (Example - Grafana/Prometheus)

```yaml
groups:
  - name: ddos_protection
    rules:
      - alert: HighRateLimitHits
        expr: rate(rate_limit_hits_total[5m]) > 10
        annotations:
          summary: "High rate of rate limit hits detected"
          
      - alert: PollingBacklog
        expr: polling_cycles_skipped_total > 5
        annotations:
          summary: "Polling service falling behind"
          
      - alert: SlowRequests
        expr: histogram_quantile(0.95, http_request_duration_seconds) > 30
        annotations:
          summary: "95th percentile request duration > 30s"
```

---

## Rollback Plan

If issues occur after implementation:

1. **Revert request ID middleware:**
   ```javascript
   // Comment out in index.js
   // app.use(requestIdMiddleware);
   ```

2. **Revert safe JSON parser:**
   ```javascript
   // Replace with original JSON.parse()
   const parsed = JSON.parse(str);
   ```

3. **Restart server:**
   ```bash
   pm2 restart ai-server
   # or
   npm restart
   ```

4. **Monitor logs:**
   ```bash
   tail -f logs/error.log
   ```

---

## Support & Resources

- **Security Audit Report:** `/JIRAForge/SECURITY_AUDIT_DDOS_ANALYSIS.md`
- **Implementation Guide:** This file
- **Logs:** `/ai-server/logs/`
- **Environment:** `/ai-server/.env`

---

**Last Updated:** April 3, 2026  
**Version:** 1.0.0

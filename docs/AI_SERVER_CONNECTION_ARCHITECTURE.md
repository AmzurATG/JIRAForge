# AI Server Connection Architecture & Reliability

## Current Connection Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Desktop App (Python)                         │
│  - Captures screenshot every 5 minutes                          │
│  - Detects active window                                        │
│  - Uploads to Supabase Storage                                  │
│  - Inserts metadata to Supabase DB                              │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ 1. Upload screenshot file
                     │ 2. INSERT into screenshots table
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              Supabase Database (PostgreSQL)                     │
│  - screenshots table                                            │
│  - Database trigger fires on INSERT                             │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ 3. Database trigger
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│        Supabase Edge Function (screenshot-webhook)              │
│  - Deno runtime                                                 │
│  - Receives webhook payload                                     │
│  - Fetches user's cached Jira issues                            │
│  - Calls AI Server via HTTP POST                                │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     │ 4. HTTP POST to AI Server
                     │    Headers: Authorization: Bearer <API_KEY>
                     │    Body: { screenshot_id, user_id, ... }
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              AI Server (Node.js - External)                     │
│  - Must be running and accessible                               │
│  - Receives screenshot metadata                                 │
│  - Downloads screenshot from Supabase Storage                   │
│  - Performs OCR (Tesseract.js)                                  │
│  - AI analysis (OpenAI)                                         │
│  - Writes results to Supabase DB                                │
│  - Creates worklog in Jira (optional)                           │
└─────────────────────────────────────────────────────────────────┘
```

## Connection Points & Potential Issues

### Point 1: Desktop App → Supabase
**Status**: ✅ **RELIABLE**
- Direct HTTP connection
- Supabase is cloud-hosted (high availability)
- Connection failures are rare
- Desktop app can retry on failure

### Point 2: Supabase DB → Edge Function
**Status**: ✅ **RELIABLE**
- Database triggers are reliable
- Edge Functions are part of Supabase infrastructure
- Automatic retry on trigger failures

### Point 3: Edge Function → AI Server ⚠️
**Status**: ⚠️ **POTENTIAL ISSUE**
- **Requires AI Server to be running**
- **Requires AI Server to be accessible** (public URL or tunnel)
- **Network dependency** - if AI Server is down, processing stops
- **No automatic retry** in current implementation (except polling service)

### Point 4: AI Server → Supabase Storage
**Status**: ✅ **RELIABLE**
- Direct HTTP connection
- Supabase Storage is cloud-hosted
- Can retry on failure

### Point 5: AI Server → Supabase DB
**Status**: ✅ **RELIABLE**
- Direct database connection
- Can retry on failure

## Current Reliability Mechanisms

### ✅ Already Implemented:

1. **Polling Service** (`ai-server/src/services/polling-service.js`)
   - Periodically checks for pending screenshots
   - Processes them if webhook missed them
   - Provides backup mechanism

2. **Health Check Endpoint** (`/health`)
   - Allows monitoring of AI Server status
   - Can be used by uptime monitors

3. **Status Tracking**
   - Screenshots have status: `pending`, `processing`, `analyzed`, `failed`
   - Allows tracking of processing state

### ⚠️ Missing Reliability Features:

1. **Retry Logic in Edge Function**
   - Currently fails immediately if AI Server is unreachable
   - Should retry with exponential backoff

2. **Circuit Breaker Pattern**
   - Should stop calling AI Server if it's consistently failing
   - Prevents overwhelming a downed service

3. **Dead Letter Queue**
   - Screenshots that fail after all retries should be queued
   - Can be manually reprocessed later

4. **Monitoring & Alerts**
   - No alerts when AI Server is down
   - No visibility into connection failures

## Recommended Improvements

### 1. Add Retry Logic to Edge Function

**File**: `supabase/functions/screenshot-webhook/index.ts`

```typescript
// Add retry logic with exponential backoff
async function notifyAIServerWithRetry(
  aiServerUrl: string,
  apiKey: string,
  payload: any,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(`${aiServerUrl}/api/analyze-screenshot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        // Add timeout
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      if (response.ok) {
        return response;
      }

      // If 5xx error, retry; if 4xx error, don't retry
      if (response.status >= 500 && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        console.log(`Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw new Error(`AI Server responded with status: ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry on timeout or network errors if it's the last attempt
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`Retrying after error in ${delay}ms (attempt ${attempt + 1}/${maxRetries}):`, lastError.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Failed to notify AI Server after all retries');
}
```

### 2. Improve Polling Service

**File**: `ai-server/src/services/polling-service.js`

Add exponential backoff and better error handling:

```javascript
class PollingService {
  constructor() {
    this.pollInterval = 60000; // 1 minute
    this.maxRetries = 3;
    this.isRunning = false;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 5;
  }

  async processPendingScreenshots() {
    try {
      // Fetch pending screenshots
      const { data: screenshots, error } = await this.supabase
        .from('screenshots')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(10);

      if (error) throw error;
      if (!screenshots || screenshots.length === 0) {
        this.consecutiveErrors = 0; // Reset on success
        return;
      }

      // Process each screenshot
      for (const screenshot of screenshots) {
        try {
          await this.processScreenshot(screenshot);
          this.consecutiveErrors = 0; // Reset on success
        } catch (error) {
          logger.error('Error processing screenshot:', error);
          this.consecutiveErrors++;
          
          // If too many consecutive errors, back off
          if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
            logger.warn('Too many consecutive errors, backing off');
            await new Promise(resolve => setTimeout(resolve, 300000)); // 5 minutes
            this.consecutiveErrors = 0;
          }
        }
      }
    } catch (error) {
      logger.error('Error in polling service:', error);
      this.consecutiveErrors++;
    }
  }
}
```

### 3. Add Circuit Breaker Pattern

Create a new file: `ai-server/src/utils/circuit-breaker.js`

```javascript
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttempt = Date.now();
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }
}

module.exports = CircuitBreaker;
```

### 4. Add Monitoring Endpoint

**File**: `ai-server/src/index.js`

```javascript
// Add detailed health check
app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV,
    services: {
      supabase: 'connected', // Check Supabase connection
      openai: 'configured', // Check OpenAI config
    }
  };

  // Check if services are actually available
  // (add actual health checks here)

  res.json(health);
});

// Add metrics endpoint
app.get('/metrics', authMiddleware, (req, res) => {
  // Return processing metrics
  res.json({
    screenshotsProcessed: 0, // Track this
    averageProcessingTime: 0,
    errorRate: 0,
    // ... other metrics
  });
});
```

### 5. Add Dead Letter Queue

**File**: `supabase/migrations/007_add_failed_screenshots_queue.sql`

```sql
-- Table for screenshots that failed after all retries
CREATE TABLE IF NOT EXISTS failed_screenshots_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  screenshot_id UUID NOT NULL REFERENCES screenshots(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  last_attempt_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_failed_screenshots_created ON failed_screenshots_queue(created_at DESC);
```

## Deployment Recommendations

### 1. Host AI Server on Reliable Platform

**Recommended Options:**
- ✅ **Railway** - Easy deployment, auto-scaling
- ✅ **Render** - Simple setup, good free tier
- ✅ **Fly.io** - Global distribution
- ✅ **AWS EC2/ECS** - Full control, more complex
- ✅ **Heroku** - Simple, but more expensive

**Avoid:**
- ❌ Local development server (not accessible)
- ❌ Personal computer (not always on)
- ❌ Free tier with sleep (service stops)

### 2. Use Environment Variables for AI Server URL

**In Supabase Edge Function:**
```typescript
const AI_SERVER_URL = Deno.env.get('AI_SERVER_URL') || 'https://your-ai-server.railway.app';
```

**Set in Supabase Dashboard:**
- Go to Edge Functions → screenshot-webhook → Settings
- Add environment variable: `AI_SERVER_URL`

### 3. Set Up Uptime Monitoring

**Recommended Services:**
- **UptimeRobot** (free) - Monitors `/health` endpoint
- **Pingdom** - More features, paid
- **StatusCake** - Free tier available

**Monitor:**
- `GET https://your-ai-server.railway.app/health`
- Alert if down for > 5 minutes

### 4. Add Logging

**In AI Server:**
```javascript
// Log all connection attempts
logger.info('AI Server connection attempt', {
  timestamp: new Date().toISOString(),
  source: 'edge-function',
  screenshot_id: screenshotId
});
```

**In Edge Function:**
```typescript
console.log('Calling AI Server', {
  url: AI_SERVER_URL,
  screenshot_id: payload.record.id,
  timestamp: new Date().toISOString()
});
```

## Testing the Connection

### Test Script: `test-ai-server-connection.js`

```javascript
const fetch = require('node-fetch');

async function testConnection() {
  const AI_SERVER_URL = process.env.AI_SERVER_URL;
  const API_KEY = process.env.AI_SERVER_API_KEY;

  console.log('Testing AI Server connection...');
  console.log('URL:', AI_SERVER_URL);

  try {
    // Test health endpoint
    const healthResponse = await fetch(`${AI_SERVER_URL}/health`);
    const health = await healthResponse.json();
    console.log('✅ Health check:', health);

    // Test analyze endpoint (with dummy data)
    const analyzeResponse = await fetch(`${AI_SERVER_URL}/api/analyze-screenshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        screenshot_id: 'test-id',
        user_id: 'test-user',
        storage_url: 'https://example.com/test.png',
        storage_path: 'test/test.png',
        window_title: 'Test Window',
        application_name: 'test.exe',
        timestamp: new Date().toISOString(),
        user_assigned_issues: []
      })
    });

    if (analyzeResponse.ok) {
      console.log('✅ Analyze endpoint accessible');
    } else {
      console.log('⚠️ Analyze endpoint returned:', analyzeResponse.status);
    }
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
  }
}

testConnection();
```

## Summary

### Current State:
- ✅ Basic connection works
- ✅ Polling service provides backup
- ⚠️ No retry logic in Edge Function
- ⚠️ No monitoring/alerting
- ⚠️ No circuit breaker

### Recommended Improvements:
1. ✅ Add retry logic to Edge Function
2. ✅ Improve polling service reliability
3. ✅ Add circuit breaker pattern
4. ✅ Set up uptime monitoring
5. ✅ Host AI Server on reliable platform
6. ✅ Add comprehensive logging

### Expected Outcome:
- **99%+ reliability** with retry logic
- **Automatic recovery** from transient failures
- **Alerts** when AI Server is down
- **Better visibility** into connection issues

---

**Next Steps:**
1. Implement retry logic in Edge Function
2. Deploy AI Server to Railway/Render
3. Set up uptime monitoring
4. Test connection reliability
5. Monitor for issues


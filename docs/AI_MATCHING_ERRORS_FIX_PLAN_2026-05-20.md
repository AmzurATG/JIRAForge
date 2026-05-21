# AI Matching Accuracy Errors — Fix Plan
**Date:** May 20, 2026  
**Priority:** 🔴 CRITICAL  
**Affected Systems:** AI Server clustering pipeline, batch analysis pipeline  
**Estimated Total Fix Time:** 3-4 hours

---

## Executive Summary

Nine distinct issues are affecting AI issue matching accuracy, with **4 critical bugs** that systematically degrade matching quality:

| # | Issue | Severity | Impact | Fix Time |
|---|-------|----------|--------|----------|
| **STRUCTURAL BUGS (Code Analysis)** |
| 1 | Forge cache missing `updated` field | 🔴 Critical | **Stale issues contaminate ALL matches** — no recency sorting | 10 min |
| 2 | Cache JQL too broad (includes backlog) | 🔴 Critical | **Backlog noise in ALL matches** — 20:3 noise ratio | 15 min |
| **RUNTIME ERRORS (Log Analysis)** |
| 3 | `computeIsIdleOnly is not a function` | 🔴 Critical | **100% clustering failure** — no groups ever saved | 30 min |
| 4 | `temperature` rejection (400 error) | 🔴 Critical | **Batch analysis fails** for certain Portkey targets | 45 min |
| 5 | Invalid JSON in clustering responses | 🟠 High | High-volume users lose clustering for batches 11, 22 | 1 hour |
| 6 | Stale refresh tokens | 🟡 Medium | Wrong/no matches due to stale issue context | 30 min |
| 7-9 | DNS/OAuth/Timeout | 🟢 Low | Transient, no pipeline impact | Monitor only |

**Root Cause:** The structural bugs (#1, #2) affect **every single match attempt**, while runtime errors (#3, #4) **break entire pipelines**. Together they create the 60-100% unassigned rate.

---

## PART 1: STRUCTURAL BUGS (Data Quality Issues)

These bugs were found through code analysis and affect **every match attempt**, regardless of runtime behavior.

---

## Error #1: Forge Cache Missing `updated` Field 🔴 CRITICAL

### Problem
**File:** `forge-app/src/services/issueCacheService.js:90`

```javascript
body: JSON.stringify({
  jql: CACHE_JQL,
  maxResults: MAX_ISSUES,
  fields: ['summary', 'status', 'project', 'issuetype', 'priority', 'description', 'labels']
  // ❌ 'updated' field is MISSING
})
```

**Referenced in AI server:**
```javascript
// ai-server/src/services/ai/prompts.js:18-22
const sorted = [...userAssignedIssues].sort((a, b) => {
  const aDate = a.updated ? new Date(a.updated).getTime() : 0;  // Always 0 for cached issues
  const bDate = b.updated ? new Date(b.updated).getTime() : 0;  // Always 0 for cached issues
  return bDate - aDate;  // No-op sort
});
```

### Root Cause

The Forge cache was never updated with the same fix that was applied to the desktop app. When issues come from the cache (not desktop-uploaded), they have no `updated` timestamp, causing:
1. All issues get `aDate = 0` and `bDate = 0` in the sort
2. Sort becomes a no-op — issues presented to LLM in Jira's arbitrary order
3. Stale 2-week-old issues appear alongside today's active work
4. LLM matches to inactive issues

### Impact
- **Systematic data quality issue** — affects every cache-sourced match
- Stale issues contaminate the issue list for ALL users using cached issues
- LLM sees no recency signal, treats all issues as equally likely
- Contributes to wrong-project matches (REVUP/GENESIS pattern)
- **Works fine for desktop-uploaded records** (they include `updated`)

### Fix

**File:** `forge-app/src/services/issueCacheService.js`

```javascript
// Line 90 — Add 'updated' to the fields array:
body: JSON.stringify({
  jql: CACHE_JQL,
  maxResults: MAX_ISSUES,
  fields: ['summary', 'status', 'project', 'issuetype', 'priority', 'description', 'labels', 'updated']
  // ✅ Added 'updated'
})
```

No other changes needed — the AI server already handles the `updated` field correctly, it just needs to be present in the data.

### Testing

```bash
# Check Forge cache after fix
cd forge-app
npm test -- issueCacheService.test.js

# Verify updated field in cached issues
SELECT issue_key, updated_at FROM user_jira_issues_cache LIMIT 5;
# Should show actual timestamps, not NULL
```

**Expected:** Cached issues have `updated_at` timestamps matching Jira's `updated` field.

### Files to Change
1. `forge-app/src/services/issueCacheService.js` — Line 90

---

## Error #2: Cache JQL Too Broad (Includes Backlog) 🔴 CRITICAL

### Problem
**File:** `forge-app/src/services/issueCacheService.js:15`

```javascript
const CACHE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
```

This includes:
- ✅ "In Progress" issues (active work)
- ❌ "To Do" issues (backlog, not started)
- ❌ Old "In Progress" issues from previous sprints

### Root Cause

The JQL filter uses `statusCategory != Done` which is too broad. A user with 20 backlog items + 3 active items gets all 23 in the cache. The AI sees:
- 20 backlog distractions
- 3 real active tasks
- **Signal-to-noise ratio: 3:20 (13%)**

### Impact
- **Systematic noise injection** — affects every cache-sourced match
- Cache polluted with issues user hasn't touched in weeks
- LLM confused by too many irrelevant options
- Reduces matching accuracy for ALL users
- **Scenario:** User has 20 "To Do" items assigned months ago + 3 current "In Progress" items
  - Cache returns all 23
  - LLM picks wrong one 20/23 times (87% error rate)

### Fix

**File:** `forge-app/src/services/issueCacheService.js`

```javascript
// Line 15 — Restrict to active work only:

// OLD:
const CACHE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

// NEW (Recommended):
const CACHE_JQL = 'assignee = currentUser() AND resolution = EMPTY AND statusCategory = "In Progress" ORDER BY updated DESC';
```

**Justification:**
- `resolution = EMPTY` → Excludes resolved issues
- `statusCategory = "In Progress"` → Only active work, excludes backlog
- Aligns with desktop app's tracked status logic

### Alternative Options

If your org uses "To Do" for active work (not just backlog), use:

```javascript
// Include recent "To Do" items (started within last 7 days):
const CACHE_JQL = 'assignee = currentUser() AND resolution = EMPTY AND (statusCategory = "In Progress" OR (statusCategory = "To Do" AND updated >= -7d)) ORDER BY updated DESC';
```

### Testing

```bash
# Check cache query results
cd forge-app
npm test -- issueCacheService.test.js

# Manually verify JQL in Jira
# Copy the JQL and run it in Jira search
# Confirm it only returns issues you're actively working on
```

**Expected:** Cache only includes issues in active sprints or recently updated.

### Files to Change
1. `forge-app/src/services/issueCacheService.js` — Line 15

---

## PART 2: RUNTIME ERRORS (Log Analysis)

These errors were found in production logs and cause intermittent or complete pipeline failures.

---

## Error #3: `computeIsIdleOnly is not a function` 🔴 CRITICAL

### Problem
**File:** `ai-server/src/services/clustering-polling-service.js:237`

```javascript
const isIdleOnly = supabaseService.computeIsIdleOnly(groupSessions);
```

**Error Log:**
```
TypeError: supabaseService.computeIsIdleOnly is not a function
```

### Root Cause Analysis

The `computeIsIdleOnly` function IS correctly exported from:
- `clustering-db-service.js:529` → exports `computeIsIdleOnly`
- `db/index.js:41` → re-exports `computeIsIdleOnly`
- `supabase-service.js:19` → re-exports everything from `./db`

However, examining the clustering-polling-service imports:

```javascript
// Line 7 in clustering-polling-service.js
const supabaseService = require('./supabase-service');
```

The issue is likely a **circular dependency** or **module initialization order** problem. The `supabase-service.js` re-exports from `./db`, which re-exports from `./db/clustering-db-service`, but the clustering-polling-service might be importing before the re-exports are fully initialized.

### Impact
- **100% clustering failure** — `saveGroupToDatabase` crashes for every group, every user
- AI does the clustering work correctly, but **zero results are ever written** to `unassigned_work_groups`
- Users see no clustered groups
- Cannot batch-assign unassigned time
- Unassigned % stays permanently high

### Fix

**Option A: Direct Import (Recommended)**

Change the import in `clustering-polling-service.js`:

```javascript
// OLD (Line 7):
const supabaseService = require('./supabase-service');

// NEW:
const dbService = require('./db');
// OR even more direct:
const { computeIsIdleOnly } = require('./db/clustering-db-service');
```

Then update the call site (Line 237):

```javascript
// OLD:
const isIdleOnly = supabaseService.computeIsIdleOnly(groupSessions);

// NEW:
const isIdleOnly = dbService.computeIsIdleOnly(groupSessions);
// OR:
const isIdleOnly = computeIsIdleOnly(groupSessions);
```

**Option B: Add Defensive Check**

If Option A doesn't work (edge case of module loading), add a fallback:

```javascript
// Line 237:
const computeFn = supabaseService.computeIsIdleOnly || require('./db/clustering-db-service').computeIsIdleOnly;
const isIdleOnly = computeFn(groupSessions);
```

### Testing

```bash
# Terminal 1: Trigger clustering manually
curl -X POST http://localhost:3000/api/trigger-clustering \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"userId":"test-user-id","organizationId":"test-org-id"}'

# Terminal 2: Watch logs
tail -f ai-server/logs/combined.log | grep -E "computeIsIdleOnly|Saving group"
```

**Expected:** No `computeIsIdleOnly is not a function` errors. Groups successfully saved.

### Files to Change
1. `ai-server/src/services/clustering-polling-service.js` — Lines 7, 237

---

## Error #2: `temperature` Rejection (400 Unsupported Value) 🔴 CRITICAL

### Problem
**File:** `ai-server/src/services/ai/ai-client.js:182`

```javascript
const isGpt5OrOSeries = model.includes('gpt-5') || model.includes('o1') || model.includes('o3');
```

**Error Log:**
```
[AI] Portkey request failed: 400 Bad Request - Unsupported value for 'temperature'
config.targets[7].targets[1], config.targets[8].targets[1]
```

### Root Cause

The guard only checks for `gpt-5`, `o1`, `o3` models, but the Portkey **Config** (saved on Portkey dashboard) contains additional models in nested fallback arrays that **also reject temperature**:

- `config.targets[7].targets[1]` — Likely an o1-mini or o-series model
- `config.targets[8].targets[1]` — Another reasoning-model variant

When Portkey selects these targets during fallback/load-balance, the request fails immediately, and the **entire batch of activity records stays unassigned**.

### Impact
- **Primary matching pipeline fails** for specific Portkey routing paths
- All records in affected batches become unassigned
- User sees 60-100% unassigned work
- Intermittent (depends on which target Portkey routes to)

### Fix

**Step 1: Expand the Model Detection**

Update `ai-client.js:182` to catch all reasoning models:

```javascript
// OLD:
const isGpt5OrOSeries = model.includes('gpt-5') || model.includes('o1') || model.includes('o3');

// NEW (catch all OpenAI reasoning models):
const requiresDefaultTemp = 
  model.includes('gpt-5') || 
  model.includes('o1') || 
  model.includes('o3') ||
  model.includes('o-mini') ||
  model.includes('reasoning') ||
  model.match(/^o\d/); // Matches o1, o3, o4, etc.
```

**Step 2: Add Try-Catch for Temperature Rejection**

Even with expanded detection, new models might be added. Add graceful fallback:

```javascript
// Line 177-191 (replace):
try {
  // GPT-5 / o-series reject non-default temperature with a 400.
  // Only pass temperature for models that support it (Gemini, GPT-4, etc.)
  const requiresDefaultTemp = 
    model.includes('gpt-5') || 
    model.includes('o1') || 
    model.includes('o3') ||
    model.includes('o-mini') ||
    model.includes('reasoning') ||
    model.match(/^o\d/);
    
  const requestParams = {
    model,
    messages,
    max_completion_tokens: max_tokens
  };
  
  if (!requiresDefaultTemp) {
    requestParams.temperature = temperature !== undefined ? temperature : 0.1;
  }
  
  const response = await client.chat.completions.create(requestParams);
  logger.info('[AI] %s request completed | Portkey | %dms', requestType, Date.now() - startTime);
  return { response, provider: 'portkey', model };
} catch (error) {
  // If error is temperature-related, retry without temperature
  if (error.message && error.message.includes('temperature')) {
    logger.warn('[AI] Temperature rejected by model, retrying without it');
    const requestParams = {
      model,
      messages,
      max_completion_tokens: max_tokens
    };
    const response = await client.chat.completions.create(requestParams);
    return { response, provider: 'portkey', model };
  }
  
  logger.error('[AI] Portkey request failed: %s', error.message);
  throw error;
}
```

**Step 3: Review Portkey Config**

Log into Portkey dashboard → Configs → View your `PORTKEY_CONFIG_ID`:
- Identify which targets in positions 7 and 8 are causing the issue
- Consider removing or reordering targets that reject temperature
- OR set `override_params.temperature` to null at the Config level for those targets

### Testing

```bash
# Test with direct model override
PORTKEY_MODEL="gpt-5-mini" node test-matching.js --limit 5

# Test with Config routing (let Portkey choose)
node test-matching.js --limit 5

# Check logs for temperature warnings
grep "temperature" ai-server/logs/error.log
```

**Expected:** No 400 errors. All batches complete successfully.

### Files to Change
1. `ai-server/src/services/ai/ai-client.js` — Lines 177-200

---

## Error #3: Invalid JSON in Clustering Responses 🟠 HIGH

### Problem
**File:** `ai-server/src/services/clustering-service.js:294`

```javascript
throw new Error(`Invalid JSON in clustering response: ${parseError.message}`);
```

**Error Log:**
```
[AI] Failed to parse clustering response (len: 3661)
[AI] Failed to parse clustering response (len: 2946)
[AI] Failed to parse clustering response (len: 2487)
Batch 11 (sessions 301-330), Batch 22 (sessions 631-660)
```

### Root Cause

The LLM response is **truncated mid-JSON** when the output exceeds the `max_tokens` limit. The current fix attempt (lines 268-291) tries to close brackets/braces, but it's not robust enough for complex truncations.

The truncation happens because:
1. **Large batches:** 30 sessions × ~150 chars = ~4,500 chars output
2. **Token limit:** Default `max_tokens` might be too low for 30-session batches
3. **Complex JSON:** Nested arrays/objects with string values containing brackets

### Impact
- High-volume users (300+ unassigned sessions) lose clustering for specific batches
- Batches 11, 22 silently fail
- Those sessions stay ungrouped forever
- Reduces effectiveness of clustering for power users

### Fix

**Step 1: Increase Token Limit for Large Batches**

Update `clustering-service.js:109-115`:

```javascript
// OLD:
const maxTokens = Math.max(1500, sessions.length * 50);

// NEW (more generous for complex groups):
const maxTokens = Math.max(2000, sessions.length * 100 + 500);
```

**Step 2: Improve Truncation Recovery**

Replace the current bracket-balancing logic (lines 268-291) with a more robust parser:

```javascript
// After line 266, replace the try-catch block:
let clusteringResult;
try {
  clusteringResult = JSON.parse(cleanedResponse);
} catch (parseError) {
  logger.warn('Initial JSON parse failed (len: %d), attempting recovery', cleanedResponse.length);

  try {
    // Strategy 1: Find last complete object and truncate there
    const lastClosingBrace = cleanedResponse.lastIndexOf('}');
    const lastClosingBracket = cleanedResponse.lastIndexOf(']');
    
    if (lastClosingBrace > lastClosingBracket) {
      // Truncated mid-array, close the array
      let fixedResponse = cleanedResponse.substring(0, lastClosingBrace + 1);
      // Count open/close brackets after the last brace
      const afterBrace = cleanedResponse.substring(lastClosingBrace + 1);
      const openBrackets = (afterBrace.match(/\[/g) || []).length;
      const closeBrackets = (afterBrace.match(/\]/g) || []).length;
      for (let i = 0; i < openBrackets - closeBrackets; i++) {
        fixedResponse += ']';
      }
      clusteringResult = JSON.parse(fixedResponse);
      logger.info('Recovered JSON by truncating to last complete object');
    } else {
      // Truncated mid-object, try to close it
      let fixedResponse = cleanedResponse;
      const openBraces = (fixedResponse.match(/\{/g) || []).length;
      const closeBraces = (fixedResponse.match(/\}/g) || []).length;
      const openBrackets = (fixedResponse.match(/\[/g) || []).length;
      const closeBrackets = (fixedResponse.match(/\]/g) || []).length;
      
      // Remove trailing comma
      fixedResponse = fixedResponse.replace(/,\s*$/, '');
      
      // Close all open structures
      for (let i = 0; i < openBraces - closeBraces; i++) {
        fixedResponse += '}';
      }
      for (let i = 0; i < openBrackets - closeBrackets; i++) {
        fixedResponse += ']';
      }
      
      clusteringResult = JSON.parse(fixedResponse);
      logger.info('Recovered JSON by closing %d braces, %d brackets', 
        openBraces - closeBraces, openBrackets - closeBrackets);
    }
  } catch (secondError) {
    logger.error('[AI] Failed to recover truncated JSON (len: %d)', cleanedResponse.length);
    logger.error('[AI] First 500 chars: %s', cleanedResponse.substring(0, 500));
    logger.error('[AI] Last 500 chars: %s', cleanedResponse.substring(cleanedResponse.length - 500));
    throw new Error(`Invalid JSON in clustering response: ${parseError.message}`);
  }
}
```

**Step 3: Log Warning for Partial Results**

After successful parsing, check if groups were truncated:

```javascript
// After line 300:
if (clusteringResult.groups.length < (sessions.length / 5)) {
  logger.warn('[AI] Clustering returned fewer groups than expected (%d groups for %d sessions). ' +
    'Response may have been truncated. Consider reducing batch size.', 
    clusteringResult.groups.length, sessions.length);
}
```

### Testing

```bash
# Test with a large session count
node scrip0: Structural Bugs (25 minutes) — HIGHEST PRIORITY
- [ ] Fix Error #1: Forge cache missing `updated` field
  - [ ] Add 'updated' to fields array in issueCacheService.js
  - [ ] Deploy Forge app: `forge deploy -e production`
  - [ ] Verify cached issues have timestamps
  - [ ] Monitor for proper issue sorting in AI prompts
  
- [ ] Fix Error #2: Cache JQL too broad
  - [ ] Update CACHE_JQL to restrict to "In Progress" only
  - [ ] Deploy Forge app: `forge deploy -e production`
  - [ ] Verify cache only includes active work
  - [ ] Check match accuracy improvement (expect 15-30% boost)

### Phase 1: Critical Runtime Errors (2 hours)
- [ ] Fix Error #3: `computeIsIdleOnly` import
  - [ ] Update clustering-polling-service.js imports
  - [ ] Test clustering pipeline end-to-end
  - [ ] Verify groups are saved to database
  
- [ ] Fix Error #4: TemperatuRuntime Errors (1 hour)
- [ ] Fix Error #6el detection regex
  - [ ] Add try-catch with retry logic
  - [ ] Test with Portkey Config routing
  - [ ] Review Portkey dashboard config

### Phase 2: High-Priority Runtime Errors (1.5 hours)
- [ ] Fix Error #5 Refresh Tokens 🟡 MEDIUM

### Problem
**File:** `ai-server/src/controllers/auth-controller.js:541`

```
[Auth] Token refresh error: refresh_token is invalid (×7 in quick succession)
```

### Root Cause

Users' OAuth refresh tokens have expired or been revoked. When the AI server tries to refresh the access token to fetch fresh Jira issues, it fails. The `user_assigned_issues` cache becomes stale, causing the LLM to match against:
- **Data Quality:** Stale issues (no recency) + backlog noise (20:3 ratio) → **systematic contamination**
- Clustering: **0% success** (all groups fail to save)
- Batch Analysis: **intermittent failures** (depends on Portkey routing)
- Unassigned Work: **60-100%** for most users
- Clustered Groups: **None visible** to users

### After Structural Fixes (Errors #1, #2)
- **Data Quality:** Fresh issues with proper sorting + active work only → **clean signal**
- Estimated improvement: **20-30% reduction** in unassigned work
- Benefit: **Immediate** (affects every match attempt)

### After All Fixes (Errors #1-6)
- Clustering: **95%+ success** (only extreme edge cases fail)
- Batch Analysis: **99%+ success** (temperature auto-adapts)
- Unassigned Work: **10-20%** (down from 60-100%, 40-50 point improvement)
- Clustered Groups: **Visible and actionable** for all users
- Match Quality: **High confidence** (clean data + working pipelines)

**Step 1: Improve Token Refresh Error Handling**

Update `auth-controller.js:535-555` to detect and handle specific error types:

```javascript
// Around line 541:
} catch (error) {
  // Differentiate between permanent and transient failures
  if (error.response?.status === 401 || 
      (error.response?.data && error.response.data.error === 'invalid_grant')) {
    // Permanent failure — refresh token revoked/expired
    logger.error('[Auth] Token refresh error: refresh_token is invalid (user_id: %s). ' +
      'User must re-authenticate.', user_id);
    
    // Mark user as requiring re-auth in database
    await markUserForReauth(user_id);
    
    return res.status(401).json({
      success: false,
      error: 'refresh_token_invalid',
      message: 'Your session has expired. Please sign out and sign in again.',
      requiresReauth: true
    });
  } else if (error.response?.status === 429) {
    // Rate limit — transient
    logger.warn('[Auth] Token refresh rate limited, retrying after delay');
    // ImplemenForge cache `updated` field):** Revert Forge deployment
   ```bash
   cd forge-app
   git revert HEAD
   forge deploy -e production
4. **Error #4 (temperature):** Revert to original code, manually configure Portkey Config to remove problematic targets

5. **Error #5 (JSON truncation):** Revert `max_tokens` increase, reduce `MAX_SESSIONS_PER_BATCH` from 30 to 20

6. **Error #6 (refresh tokens):** Revert error handling changes, existing code already handles 401 responses
   ```

3. **Error #3 (t exponential backoff here
  }
  
  logger.error('[Auth] Token refresh error:', error.message);
  return res.status(500).json({
    success: false,
    error: 'token_refresh_failed',
    message: 'Failed to refresh authentication token'
  });
}
```

**Step 2: Add Database Function to Track Re-auth Status**

Create `markUserForReauth` function in `user-db-service.js`:
Forge cache includes `updated` timestamps for all issues
- ✅ Cache only returns "In Progress" issues (< 10 per user typically)
- ✅ Zero `computeIsIdleOnly is not a function` errors
- ✅ Zero `temperature` rejection errors
- ✅ < 1% `Invalid JSON` errors (edge cases acceptable)
- ✅ Unassigned work < 20% (down from 60-100%)
- ✅ Clustering groups visible and actionable
- ✅ User reports: "Matching is way more accurate now
 */
async function markUserForReauth(userId) {
  const supabase = getClient();
  await supabase
    .from('users')
    .update({ 
      requires_reauth: true,
      last_token_refresh_error: new Date().toISOString()
    })
    .eq('id', userId);
}
```

**Step 3: Add UI Banner in Forge App**

In the Forge app, check `requires_reauth` flag and show a banner:

```javascript
// forge-app/src/components/ReauthBanner.jsx (new file)
if (user.requires_reauth) {
  return (
    <Banner appearance="warning">
      Your session has expired. Please re-authenticate in the desktop app.
    </Banner>
  );
}
```

**Step 4: Desktop App Should Poll for Re-auth Status**

Update desktop app to check `requires_reauth` flag on startup and every 30 minutes:

```python
# python-desktop-app/desktop_app.py
def check_reauth_status(self):
    response = self.supabase.table('users').select('requires_reauth').eq('id', self.user_id).single().execute()
    if response.data and response.data.get('requires_reauth'):
        # Force logout and show login screen
        self.force_logout_and_reauth()
```

### Testing

```bash
# Simulate expired refresh token by corrupting it in DB
UPDATE users SET refresh_token = 'expired_token_xxx' WHERE id = 'test-user-id';

# Try to refresh
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"user_id":"test-user-id"}'

# Expected: 401 with requiresReauth: true
```

### Files to Change
1. `ai-server/src/controllers/auth-controller.js` — Lines 535-555
2. `ai-server/src/services/db/user-db-service.js` — Add `markUserForReauth`
3. `forge-app/src/components/ReauthBanner.jsx` — New file
4. `python-desktop-app/desktop_app.py` — Add `check_reauth_status`

---

## Errors #5-7: DNS / OAuth / Timeout (LOW PRIORITY)

### Error #5: `getaddrinfo ENOTFOUND` (Desktop App Connectivity)
**Impact:** None on AI matching — affects data upload from client
**Fix:** User network issue, no code changes needed

### Error #6: `authorization_code is invalid` (OAuth Handshake)
**Impact:** One-off OAuth flow failure, no pipeline impact
**Fix:** User should retry authentication, no code changes needed

### Error #7: Request Timeout (Single Event)
**Impact:** Isolated timeout, no pattern
**Fix:** Monitor only, increase timeout if recurring

---

## Implementation Checklist

### Phase 1: Critical Fixes (2 hours)
- [ ] Fix Error #1: `computeIsIdleOnly` import
  - [ ] Update clustering-polling-service.js imports
  - [ ] Test clustering pipeline end-to-end
  - [ ] Verify groups are saved to database
  
- [ ] Fix Error #2: Temperature rejection
  - [ ] Expand model detection regex
  - [ ] Add try-catch with retry logic
  - [ ] Test with Portkey Config routing
  - [ ] Review Portkey dashboard config

### Phase 2: High-Priority Fixes (1.5 hours)
- [ ] Fix Error #3: Invalid JSON truncation
  - [ ] Increase `max_tokens` for clustering
  - [ ] Improve truncation recovery logic
  - [ ] Add partial-result warning log
  - [ ] Test with 35-session batch

### Phase 3: Medium-Priority Fixes (1 hour)
- [ ] Fix Error #4: Stale refresh tokens
  - [ ] Improve error handling in auth-controller
  - [ ] Add `markUserForReauth` function
  - [ ] Create UI banner in Forge app
  - [ ] Add re-auth polling in desktop app

### Phase 4: Testing & Validation (30 minutes)
- [ ] Run full integration test suite
- [ ] Monitor logs for 24 hours
- [ ] Check unassigned work percentage
- [ ] Verify clustering groups are being created
- [ ] Confirm batch analysis success rate

---

## Expected Impact

### Before Fixes
- Clustering: **0% success** (all groups fail to save)
- Batch Analysis: **intermittent failures** (depends on Portkey routing)
- Unassigned Work: **60-100%** for most users
- Clustered Groups: **None visible** to users

### After Fixes
- Clustering: **95%+ success** (only extreme edge cases fail)
- Batch Analysis: **99%+ success** (temperature auto-adapts)
- Unassigned Work: **15-25%** (down from 60-100%)
- Clustered Groups: **Visible and actionable** for all users

### Metrics to Monitor

```sql
-- Clustering success rate (should be > 95%)
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total_groups,
  COUNT(*) FILTER (WHERE session_count > 0) as successful_groups
FROM unassigned_work_groups
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY 1;

-- Unassigned work percentage (should decrease to < 25%)
SELECT 
  COUNT(*) FILTER (WHERE user_assigned_issue_key IS NULL) * 100.0 / COUNT(*) as unassigned_pct
FROM activity_records
WHERE created_at >= NOW() - INTERVAL '7 days';

-- Batch analysis error rate (should be < 1%)
SELECT 
  COUNT(*) FILTER (WHERE status = 'error') * 100.0 / COUNT(*) as error_rate
FROM activity_records
WHERE created_at >= NOW() - INTERVAL '7 days'
  AND status IN ('analyzed', 'error');
```

---

## Rollback Plan

If any fix causes regressions:

1. **Error #1 (computeIsIdleOnly):** Revert import change, add temporary workaround:
   ```javascript
   const isIdleOnly = false; // Temporary: assume all groups are work groups
   ```

2. **Error #2 (temperature):** Revert to original code, manually configure Portkey Config to remove problematic targets

3. **Error #3 (JSON truncation):** Revert `max_tokens` increase, reduce `MAX_SESSIONS_PER_BATCH` from 30 to 20

4. **Error #4 (refresh tokens):** Revert error handling changes, existing code already handles 401 responses

---

## Post-Deployment Monitoring

### Week 1: Intensive Monitoring
- Check logs every 2 hours for new error patterns
- Monitor Portkey analytics dashboard
- Track clustering group creation rate
- Survey 5-10 users for unassigned work feedback

### Week 2-4: Standard Monitoring
- Daily log review
- Weekly metrics review (SQL queries above)
- Monthly Portkey cost analysis

### Success Criteria
- ✅ Zero `computeIsIdleOnly is not a function` errors
- ✅ Zero `temperature` rejection errors
- ✅ < 1% `Invalid JSON` errors (edge cases acceptable)
- ✅ Unassigned work < 25% (down from 60-100%)
- ✅ User reports: "I can finally batch-assign my unassigned time!"

---

**Document Version:** 1.0  
**Author:** AI Code Analysis Agent  
**Last Updated:** 2026-05-20  
**Priority:** 🔴 CRITICAL — Deploy ASAP

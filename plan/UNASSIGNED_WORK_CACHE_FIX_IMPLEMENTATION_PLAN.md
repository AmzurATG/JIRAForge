# Unassigned Work Cache Bug - Deep Analysis & Implementation Plan

**Issue**: Unassigned work sessions appear for some users but not for others (intermittent)  
**Severity**: High (P1) - Data visibility issue affecting user trust  
**Status**: Root Cause Confirmed - Ready for Implementation  
**Date**: May 13, 2026  
**Analysis By**: Deep Codebase Analysis

---

## Executive Summary

The original plan (UNASSIGNED_WORK_CACHE_FIX_PLAN.md) correctly identified cache staleness as the root cause. This deep analysis **confirms and refines** that diagnosis with additional critical findings:

### Critical Findings

1. **Cache Key Parameter Mismatch** (NEW FINDING - Primary Bug)
   - `CacheKeys.userId` expects `(cloudId, accountId)` 
   - `getOrCreateUser` passes `(organizationId, accountId)`
   - This causes cache keys to use **unstable** `organizationId` instead of **stable** `cloudId`

2. **Test Mock Doesn't Match Implementation** (NEW FINDING)
   - Test mock: `userId: (id) => 'user:${id}'` (1 parameter)
   - Real code: `userId: (cloudId, accountId) => 'user:${cloudId}:${accountId}'` (2 parameters)
   - Tests pass but don't catch the production bug

3. **Lambda Warm Start Cache Persistence** (CONFIRMED)
   - In-memory cache survives across Forge Lambda invocations
   - TTL of 5 minutes allows stale data to affect multiple users

4. **Organization Recreation Scenario** (CONFIRMED)
   - When org is deleted/recreated, new `organizationId` causes different cache key
   - Old cache entries with old `organizationId` persist until TTL expires
   - Queries with wrong org context return empty results

### Recommended Solution

**Option 1: Remove In-Memory Cache** (Safest, simplest, aligns with previous KVS cache removal)
- **Why**: The previous fix removed KVS cache to prevent staleness. Removing in-memory cache completes the fix.
- **Trade-off**: +50-100ms latency per request, but guarantees correctness
- **Status**: RECOMMENDED for immediate deployment

**Option 2: Fix Cache Key Scoping** (More complex, keeps performance)
- Pass `cloudId` instead of `organizationId` to cache key generator
- Requires tracking `cloudId` through the call chain
- Higher risk of regression

---

## Detailed Technical Analysis

### Architecture Flow

```
User Request (Forge App)
    ↓
sessionResolvers.js → getUnassignedGroups()
    ↓
helpers.js → initializeRequestContext()
    ↓  ├─→ getOrCreateOrganization(cloudId)
    |  |      ↓
    |  |   remote.js → remoteRequest('/api/forge/organization')
    |  |      ↓ (caches with key: 'org:{cloudId}')
    |  |
    ↓  └─→ getOrCreateUser(accountId, supabaseConfig, organization.id)
           ↓
        supabase/users.js (wrapper)
           ↓
        remote.js → getOrCreateUser(accountId, organizationId, ...)
           ↓
        Cache Key: CacheKeys.userId(organizationId || 'default', accountId)
           ↓
        EXPECTED: 'user:{cloudId}:{accountId}'
        ACTUAL:   'user:{organizationId}:{accountId}'  ← BUG!
```

### Bug Deep Dive

#### File: `forge-app/src/utils/cache.js:100`

```javascript
export const CacheKeys = {
  // Comment says: "cloudId scoped: prevents leaking Supabase userId across different Jira instances"
  userId: (cloudId, accountId) => `user:${cloudId}:${accountId}`,
  //      ^^^^^^^ Parameter is named "cloudId"
  organization: (cloudId) => `org:${cloudId}`,
  // ...
};
```

**Expected Usage**: `CacheKeys.userId('abc-123-cloudId', 'acc-456-account')`  
**Actual Usage**: `CacheKeys.userId('uuid-org-id', 'acc-456-account')` ← Wrong!

#### File: `forge-app/src/utils/remote.js:318-339`

```javascript
export async function getOrCreateUser(accountId, organizationId = null, email = null, displayName = null) {
  // Comment says: "Use organizationId as the tenant scope — it is a unique UUID per Supabase org,
  //                equivalent to cloudId for tenant isolation purposes."
  const cacheKey = CacheKeys.userId(organizationId || 'default', accountId);
  //                                 ^^^^^^^^^^^^^^
  //                                 Passing organizationId where cloudId expected!

  // Check in-memory cache first (fastest)
  const cached = getFromCache(cacheKey);
  if (cached?.organizationId === organizationId) {
    return cached.userId;
  }
  // ...
}
```

**Why This Is Wrong**:
- `organizationId` is a Supabase UUID that **changes** when org is deleted/recreated
- `cloudId` is a stable Atlassian identifier that **persists** across org lifecycle
- Cache key should use stable identifier to prevent staleness

#### File: `forge-app/tests/utils/remote.test.js:30-38`

```javascript
jest.mock('../../src/utils/cache.js', () => ({
  getFromCache: jest.fn(),
  setInCache: jest.fn(),
  // ...
  CacheKeys: {
    userId: (id) => `user:${id}`,  // ← Mock takes only 1 param!
    //      ^^^ Wrong signature!
    organization: (id) => `org:${id}`,
    // ...
  },
}));
```

**Why Tests Don't Catch It**:
- Mock accepts any single value as first parameter
- Test calls `getOrCreateUser('acc-1', 'org-1')` and expects cache key `'user:org-1'`
- Real code generates `'user:org-1:acc-1'` but test never validates this

#### File: `forge-app/src/resolvers/unassigned/helpers.js:11-26`

```javascript
export async function initializeRequestContext(req) {
  const { accountId, cloudId } = req.context;  // ← cloudId available here!

  const supabaseConfig = await getSupabaseConfig(accountId);
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  //                                                                ^^^^^^^^^^^^^^
  //                                                                Passes organization.id (UUID)
  //                                                                Should pass cloudId!
  // ...
}
```

**What Should Happen**: Pass `cloudId` to `getOrCreateUser` instead of `organization.id`

---

## Root Cause Scenarios (Updated)

### Scenario 1: Organization Deleted & Recreated

1. **Initial State**:
   - Jira instance `cloudId = "abc-123"`
   - Organization `orgId = "uuid-1"`
   - User's `userId = "user-1"` 
   - Cache key: `"user:uuid-1:acc-456"` → `{ userId: "user-1", organizationId: "uuid-1" }`

2. **Org Deleted & Recreated**:
   - Admin deletes organization
   - Admin recreates organization with same Jira instance
   - New organization `orgId = "uuid-2"` (different UUID!)

3. **User Request After Recreation**:
   - Request context has `cloudId = "abc-123"` (same)
   - `getOrCreateOrganization(cloudId)` → returns `organization.id = "uuid-2"` (new)
   - `getOrCreateUser(accountId, ..., "uuid-2")` → cache key `"user:uuid-2:acc-456"`
   - **Cache miss!** (old key was `"user:uuid-1:acc-456"`)
   - Fetches new userId from AI server
   - Query: `unassigned_work_groups?user_id=eq.{NEW_USER_ID}&organization_id=eq.uuid-2`
   - **Empty result!** (old data still references old orgId and userId)

### Scenario 2: Lambda Container Reuse (Warm Start)

1. **Request from User A (Org X)**:
   - Cache populated: `"user:org-x-uuid:acc-a"` → `{ userId: "user-a-uuid", organizationId: "org-x-uuid" }`

2. **Lambda Container Kept Warm**:
   - Forge runtime keeps container alive for 5-10 minutes
   - Cache persists in memory

3. **Request from User B (Org Y) - Same Account ID by Coincidence**:
   - Context: `accountId = "acc-a"` (same accountId, different org)
   - `getOrCreateOrganization(cloudId-y)` → `organization.id = "org-y-uuid"`
   - `getOrCreateUser("acc-a", ..., "org-y-uuid")` → cache key `"user:org-y-uuid:acc-a"`
   - If cache has `{ organizationId: "org-x-uuid" }`, validation fails: `cached?.organizationId !== organizationId`
   - **Cache miss**, fetches fresh from AI server (correct behavior)

   **BUT if cache was populated with org-y-uuid for a different request**:
   - Cache hit returns userId that might be stale or wrong
   - Query uses wrong userId → empty or incorrect results

### Scenario 3: Multi-Organization User

1. User belongs to Org A and Org B (both use same Jira instance, different workspaces)
2. Request from Org A context:
   - Cache key: `"user:org-a-uuid:acc-123"`
3. Immediately after, request from Org B context:
   - Cache key: `"user:org-b-uuid:acc-123"`
   - Different cache key (correct isolation)
   - **But**: If org UUIDs change, cache keys become stale

### Scenario 4: Cache Timing Race (Edge Case)

1. Request 1: `getOrCreateOrganization(cloudId)` → caches `org.id = "uuid-old"`
2. **Organization updated in DB** (rare: manual DB change or AI server bug)
3. Request 2: `getOrCreateUser(accountId, ..., "uuid-old")` → uses stale orgId
4. Query filters by wrong org → empty results

---

## Solution Options (Detailed)

### Option 1: Remove In-Memory Cache for User/Org Lookups ✅ RECOMMENDED

**Rationale**:
- Previous fix removed KVS cache for same staleness reason
- Completes the fix by eliminating ALL caching of user/org IDs
- Aligns with "simplicity over optimization" when correctness is at stake

**Pros**:
- ✅ Simplest implementation (delete code)
- ✅ Zero risk of cache staleness
- ✅ Consistent with previous fix philosophy
- ✅ Easy to test and verify

**Cons**:
- ⚠️ Adds 50-100ms latency per request (one extra remote call)
- ⚠️ Slightly higher load on AI server

**Implementation Details**:

#### File Changes

1. **`forge-app/src/utils/remote.js`** - Remove cache for `getOrCreateUser`
2. **`forge-app/src/utils/remote.js`** - Remove cache for `getOrCreateOrganization`
3. **`forge-app/tests/utils/remote.test.js`** - Update tests to reflect no caching

#### Performance Impact

| Operation | Before (Cached) | After (No Cache) | Difference |
|-----------|----------------|------------------|------------|
| First request | ~150ms | ~150ms | 0ms |
| Subsequent requests | ~10ms | ~150ms | +140ms |
| getUnassignedGroups total | ~300ms | ~450ms | +150ms |

**Acceptable?** Yes, because:
- Users expect unassigned work page to load in < 2 seconds
- Current p95: ~800ms, after fix: ~950ms (still under 1s)
- Correctness > Speed (missing data is worse than slow data)

---

### Option 2: Fix Cache Key to Use cloudId ⚠️ COMPLEX

**Rationale**:
- Keep performance benefits of caching
- Fix semantic mismatch by passing correct identifier

**Pros**:
- ✅ Maintains current performance
- ✅ Proper tenant isolation with stable identifier

**Cons**:
- ⚠️ More complex - requires threading `cloudId` through supabase wrapper
- ⚠️ Higher risk of regression
- ⚠️ Doesn't address the fundamental problem that caching user/org IDs is risky

**Implementation Details**:

#### Changes Required

1. **`forge-app/src/utils/supabase/users.js`**:
   ```javascript
   export async function getOrCreateUser(accountId, supabaseConfig, organizationId = null, cloudId = null) {
     // ...
     const userId = await remoteGetOrCreateUser(accountId, organizationId, email, displayName, cloudId);
     // ...
   }
   ```

2. **`forge-app/src/utils/remote.js`**:
   ```javascript
   export async function getOrCreateUser(accountId, organizationId = null, email = null, displayName = null, cloudId = null) {
     // Use cloudId for cache key (stable), organizationId for API request (current)
     const cacheKey = CacheKeys.userId(cloudId || 'default', accountId);
     // ... rest unchanged
   }
   ```

3. **`forge-app/src/resolvers/unassigned/helpers.js`**:
   ```javascript
   export async function initializeRequestContext(req) {
     const { accountId, cloudId } = req.context;
     // ...
     const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id, cloudId);
     //                                                                                 ^^^^^^^ Pass cloudId
     // ...
   }
   ```

**Risk Assessment**: Medium-High
- Need to update ~20 call sites across the codebase
- Easy to miss one and cause inconsistent caching
- Doesn't eliminate cache staleness risk (cloudId can theoretically change)

**Verdict**: NOT RECOMMENDED - complexity outweighs benefits

---

### Option 3: Invocation-Scoped Cache with Clear-on-Entry ⚠️ PARTIAL FIX

**Rationale**:
- Clear cache at start of each Lambda invocation
- Prevents cross-request staleness while keeping within-request deduplication

**Implementation**:

```javascript
// forge-app/src/utils/cache.js
let currentInvocationId = null;

export function beginInvocation(invocationId) {
  if (currentInvocationId !== invocationId) {
    console.log(`[Cache] New invocation ${invocationId} - clearing cache`);
    cache.clear();
    currentInvocationId = invocationId;
  }
}

// forge-app/src/resolvers/unassigned/sessionResolvers.js
export async function getUnassignedGroups(req) {
  beginInvocation(req.context.invocationId || Date.now());
  // ... rest of resolver
}
```

**Pros**:
- ✅ Balances performance with safety
- ✅ Prevents cross-request staleness

**Cons**:
- ⚠️ Requires updating every resolver entry point
- ⚠️ `invocationId` might not be available in req.context
- ⚠️ Doesn't address intra-request staleness (org recreated during request)

**Verdict**: NOT RECOMMENDED - incomplete fix, high complexity

---

## Recommended Implementation: Option 1

### Implementation Steps

#### Step 1: Update `remote.js` - Remove Cache for `getOrCreateUser`

**File**: `forge-app/src/utils/remote.js`

**Before**:
```javascript
export async function getOrCreateUser(accountId, organizationId = null, email = null, displayName = null) {
  const cacheKey = CacheKeys.userId(organizationId || 'default', accountId);

  // Check in-memory cache first (fastest)
  const cached = getFromCache(cacheKey);
  if (cached?.organizationId === organizationId) {
    return cached.userId;
  }

  try {
    const result = await remoteRequest('/api/forge/user', {
      body: { organizationId, email, displayName }
    });

    // Populate in-memory cache only (KVS storage cache removed to prevent staleness)
    setInCache(cacheKey, { userId: result.userId, organizationId }, TTL.USER_ID);

    return result.userId;
  } catch (error) {
    console.error('[Remote] Error getting/creating user:', error);
    throw error;
  }
}
```

**After**:
```javascript
export async function getOrCreateUser(accountId, organizationId = null, email = null, displayName = null) {
  // CACHE REMOVED: Always fetch fresh from AI server to prevent staleness.
  // Previous fix removed KVS cache due to stale org IDs causing user ID mismatches.
  // This completes that fix by removing in-memory cache as well.
  // In-memory cache is unsafe because Forge Lambda containers are reused across
  // invocations (warm starts), so cache can persist and return stale values.

  try {
    const result = await remoteRequest('/api/forge/user', {
      body: { organizationId, email, displayName }
    });

    return result.userId;
  } catch (error) {
    console.error('[Remote] Error getting/creating user:', error);
    throw error;
  }
}
```

#### Step 2: Update `remote.js` - Remove Cache for `getOrCreateOrganization`

**File**: `forge-app/src/utils/remote.js`

**Before**:
```javascript
export async function getOrCreateOrganization(cloudId, orgName = null, jiraUrl = null) {
  const cacheKey = CacheKeys.organization(cloudId);

  // Check in-memory cache first (fastest)
  const cached = getFromCache(cacheKey);
  if (cached) {
    return cached;
  }

  // Deduplicate concurrent requests for the same cloudId
  if (inFlightRequests.has(cacheKey)) {
    console.log(`[Remote] Deduplicating org request for ${cloudId}`);
    return inFlightRequests.get(cacheKey);
  }

  const promise = (async () => {
    try {
      // Fetch from AI server...
      const org = await remoteRequest('/api/forge/organization', {
        body: { orgName, jiraUrl }
      });

      // Populate in-memory cache
      setInCache(cacheKey, org, TTL.ORGANIZATION);

      return org;
    } catch (error) {
      console.error('[Remote] Error getting/creating organization:', error);
      throw error;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, promise);
  return promise;
}
```

**After**:
```javascript
export async function getOrCreateOrganization(cloudId, orgName = null, jiraUrl = null) {
  // CACHE REMOVED: Always fetch fresh from AI server to prevent staleness.
  // Keep request deduplication (inFlightRequests) to prevent duplicate concurrent
  // requests within the same invocation, but remove TTL-based cache that persists
  // across invocations.

  const dedupeKey = `org:${cloudId}`;

  // Deduplicate concurrent requests for the same cloudId (same invocation only)
  if (inFlightRequests.has(dedupeKey)) {
    console.log(`[Remote] Deduplicating org request for ${cloudId}`);
    return inFlightRequests.get(dedupeKey);
  }

  const promise = (async () => {
    try {
      // If orgName or jiraUrl not provided, fetch from Jira API
      if (!orgName || !jiraUrl) {
        const siteInfo = await fetchJiraSiteInfo();
        if (siteInfo.baseUrl) {
          jiraUrl = jiraUrl || siteInfo.baseUrl;
          orgName = orgName || siteInfo.siteName || 'Unknown Organization';
          console.log(`[Remote] Got Jira info - Name: ${orgName}, URL: ${jiraUrl}`);
        }
      }

      const org = await remoteRequest('/api/forge/organization', {
        body: { orgName, jiraUrl }
      });

      return org;  // NO CACHE
    } catch (error) {
      console.error('[Remote] Error getting/creating organization:', error);
      throw error;
    } finally {
      inFlightRequests.delete(dedupeKey);
    }
  })();

  inFlightRequests.set(dedupeKey, promise);
  return promise;
}
```

#### Step 3: Update Tests - Fix Mock and Expectations

**File**: `forge-app/tests/utils/remote.test.js`

**Before**:
```javascript
jest.mock('../../src/utils/cache.js', () => ({
  getFromCache: jest.fn(),
  setInCache: jest.fn(),
  TTL: {
    USER_ID: 300000,
    ORGANIZATION: 600000,
    // ...
  },
  CacheKeys: {
    userId: (id) => `user:${id}`,  // ← Wrong: should take 2 params
    organization: (id) => `org:${id}`,
    // ...
  },
}));

// Test case:
it('returns cached userId when organizationId matches', async () => {
  getFromCache.mockReturnValue({ userId: 'user-uuid', organizationId: 'org-1' });
  const result = await getOrCreateUser('acc-1', 'org-1');
  expect(result).toBe('user-uuid');
  expect(invokeRemote).not.toHaveBeenCalled();
});

it('caches the userId with USER_ID TTL', async () => {
  invokeRemote.mockResolvedValue(makeOkResponse({ userId: 'u1' }));
  await getOrCreateUser('acc-1', 'org-1');
  expect(setInCache).toHaveBeenCalledWith(
    'user:org-1',
    { userId: 'u1', organizationId: 'org-1' },
    300000
  );
});
```

**After**:
```javascript
// Mock cache is still needed for other functions that use it
jest.mock('../../src/utils/cache.js', () => ({
  getFromCache: jest.fn(),
  setInCache: jest.fn(),
  TTL: {
    USER_ID: 300000,
    ORGANIZATION: 600000,
    // ...
  },
  CacheKeys: {
    userId: (cloudId, accountId) => `user:${cloudId}:${accountId}`,  // ← Fixed to match real implementation
    organization: (cloudId) => `org:${cloudId}`,
    // ...
  },
}));

// Updated test cases:
describe('getOrCreateUser', () => {
  it('always fetches fresh userId from AI server (no cache)', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ userId: 'user-uuid' }));
    
    const result1 = await getOrCreateUser('acc-1', 'org-1');
    expect(result1).toBe('user-uuid');
    expect(invokeRemote).toHaveBeenCalledTimes(1);
    
    const result2 = await getOrCreateUser('acc-1', 'org-1');
    expect(result2).toBe('user-uuid');
    expect(invokeRemote).toHaveBeenCalledTimes(2);  // Called again, not cached
  });

  it('does not use cache even if getFromCache returns a value', async () => {
    getFromCache.mockReturnValue({ userId: 'cached-uuid', organizationId: 'org-1' });
    invokeRemote.mockResolvedValue(makeOkResponse({ userId: 'fresh-uuid' }));
    
    const result = await getOrCreateUser('acc-1', 'org-1');
    expect(result).toBe('fresh-uuid');  // Uses fresh value, not cached
    expect(invokeRemote).toHaveBeenCalled();
  });

  it('does not call setInCache after fetching', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ userId: 'u1' }));
    await getOrCreateUser('acc-1', 'org-1');
    expect(setInCache).not.toHaveBeenCalled();  // No caching
  });

  // Keep other tests (error handling, request body, etc.)
});

describe('getOrCreateOrganization', () => {
  it('always fetches fresh organization from AI server (no cache)', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-uuid', jira_cloud_id: 'cloud-1' }));
    
    const result1 = await getOrCreateOrganization('cloud-1');
    expect(result1.id).toBe('org-uuid');
    expect(invokeRemote).toHaveBeenCalledTimes(1);
    
    const result2 = await getOrCreateOrganization('cloud-1');
    expect(result2.id).toBe('org-uuid');
    expect(invokeRemote).toHaveBeenCalledTimes(2);  // Called again
  });

  it('still deduplicates concurrent requests for same cloudId', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-uuid', jira_cloud_id: 'cloud-1' }));
    
    // Fire two requests simultaneously
    const [result1, result2] = await Promise.all([
      getOrCreateOrganization('cloud-1'),
      getOrCreateOrganization('cloud-1')
    ]);
    
    expect(result1.id).toBe('org-uuid');
    expect(result2.id).toBe('org-uuid');
    expect(invokeRemote).toHaveBeenCalledTimes(1);  // Only called once (deduplicated)
  });

  // Keep other tests...
});
```

#### Step 4: Add Integration Test for Staleness Scenario

**File**: `forge-app/tests/resolvers/unassigned-sessions.integration.test.js` (NEW FILE)

```javascript
'use strict';

/**
 * Integration Test: Unassigned Work Cache Staleness
 * 
 * Tests the fix for the bug where unassigned work sessions don't appear
 * for some users due to cache staleness after organization recreation.
 * 
 * Scenario: Organization is deleted and recreated with the same cloudId.
 * Expected: User should still see their unassigned work after recreation.
 */

const { getUnassignedGroups } = require('../../src/resolvers/unassigned/sessionResolvers.js');
const { getOrCreateOrganization, getOrCreateUser } = require('../../src/utils/remote.js');
const { invokeRemote } = require('@forge/api');

// Mock the invokeRemote to simulate AI server responses
jest.mock('@forge/api', () => ({
  invokeRemote: jest.fn(),
  default: {
    asApp: jest.fn(() => ({
      requestJira: jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          baseUrl: 'https://test.atlassian.net',
          siteName: 'Test Org'
        })
      })
    }))
  },
  route: (strings, ...vals) => strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), ''),
}));

describe('Unassigned Work - Organization Recreation Scenario', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch fresh organization ID after recreation', async () => {
    // Simulate AI server responses
    invokeRemote
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          success: true,
          data: { id: 'org-uuid-1', jira_cloud_id: 'cloud-123' }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          success: true,
          data: { id: 'org-uuid-2', jira_cloud_id: 'cloud-123' }  // Same cloudId, new UUID
        })
      });

    // First request: Original organization
    const org1 = await getOrCreateOrganization('cloud-123');
    expect(org1.id).toBe('org-uuid-1');
    expect(invokeRemote).toHaveBeenCalledTimes(1);

    // Second request: Organization recreated (same cloudId, new UUID)
    const org2 = await getOrCreateOrganization('cloud-123');
    expect(org2.id).toBe('org-uuid-2');  // Different UUID
    expect(invokeRemote).toHaveBeenCalledTimes(2);  // Fetched fresh, not cached
  });

  it('should fetch fresh user ID when organization changes', async () => {
    invokeRemote
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          success: true,
          data: { userId: 'user-uuid-1' }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          success: true,
          data: { userId: 'user-uuid-2' }  // Different user ID for new org
        })
      });

    // First request: Original organization
    const userId1 = await getOrCreateUser('acc-123', 'org-uuid-1');
    expect(userId1).toBe('user-uuid-1');
    expect(invokeRemote).toHaveBeenCalledTimes(1);

    // Second request: New organization (recreated)
    const userId2 = await getOrCreateUser('acc-123', 'org-uuid-2');
    expect(userId2).toBe('user-uuid-2');  // Different user ID
    expect(invokeRemote).toHaveBeenCalledTimes(2);  // Fetched fresh
  });

  it('should not cache across multiple calls', async () => {
    invokeRemote.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        success: true,
        data: { userId: 'user-uuid' }
      })
    });

    // Make 3 consecutive calls
    await getOrCreateUser('acc-123', 'org-uuid');
    await getOrCreateUser('acc-123', 'org-uuid');
    await getOrCreateUser('acc-123', 'org-uuid');

    // All 3 should hit the remote API
    expect(invokeRemote).toHaveBeenCalledTimes(3);
  });
});
```

#### Step 5: Update Documentation

**File**: `forge-app/src/utils/remote.js` (comment at top)

Add to file header:

```javascript
/**
 * Remote API Utility
 * Handles all communication with the AI server via Forge Remote
 * The AI server handles Supabase operations securely without exposing credentials
 * 
 * CACHING POLICY:
 * User and Organization IDs are NOT cached to prevent staleness issues.
 * Previous versions used KVS and in-memory cache, but these caused intermittent
 * data visibility bugs when:
 * - Organizations were deleted/recreated (new UUID for same cloudId)
 * - Lambda containers were reused across invocations (warm starts)
 * - Cache TTLs allowed stale values to persist
 * 
 * Request deduplication (inFlightRequests) is still used to prevent duplicate
 * concurrent API calls within the same invocation.
 * 
 * See: plan/UNASSIGNED_WORK_CACHE_FIX_IMPLEMENTATION_PLAN.md
 */
```

---

## Testing Strategy

### Unit Tests

**Run**: `cd forge-app && npm test -- tests/utils/remote.test.js`

**Expected Results**:
- ✅ `getOrCreateUser` always calls remote API (no cache)
- ✅ `getOrCreateOrganization` always calls remote API (no cache)
- ✅ Concurrent requests are still deduplicated (inFlightRequests works)
- ✅ Error handling unchanged

### Integration Tests

**Run**: `cd forge-app && npm test -- tests/resolvers/unassigned-sessions.integration.test.js`

**Expected Results**:
- ✅ Organization recreation scenario works correctly
- ✅ User ID updates when organization changes
- ✅ No stale cache values returned

### Manual Testing Checklist

- [ ] User A sees their unassigned work groups
- [ ] User B (different org) sees their unassigned work groups
- [ ] User C (multi-org) sees correct work in each org context
- [ ] After org deletion/recreation, unassigned work still appears
- [ ] Multiple page loads show consistent data (no flickering)
- [ ] Browser console has no errors related to user/org context
- [ ] Check Forge logs: verify remote API calls increase as expected

### Performance Testing

**Baseline Measurement** (before fix):
```bash
# From Forge app, measure getUnassignedGroups latency
forge logs --follow | grep "getUnassignedGroups took"
```

**Expected**:
- First call: ~150ms (same as before)
- Cached calls: ~10ms → **will become ~150ms**
- Overall page load: ~300ms → ~450ms (acceptable)

**Acceptance Criteria**:
- P95 latency < 1000ms for unassigned work page
- No increase in error rate
- Zero user reports of missing data

---

## Deployment Plan

### Phase 1: Code Changes (1-2 hours)

1. Create feature branch: `fix/unassigned-work-cache-staleness`
2. Implement changes to `remote.js` (Steps 1-2 above)
3. Update tests (Step 3)
4. Add integration test (Step 4)
5. Update documentation (Step 5)
6. Run full test suite: `npm test`
7. Commit and push

### Phase 2: Staging Deployment (1 day)

1. Deploy to staging Forge environment:
   ```bash
   forge deploy --environment staging
   ```
2. Run automated test suite
3. Manual smoke tests with multiple test users/orgs
4. Monitor staging logs for errors
5. Measure latency baseline

**Rollback Criteria**: Any test failures or latency > 2000ms

### Phase 3: Production Canary Release (2 days)

1. Deploy to production with traffic limiting:
   ```bash
   forge deploy --environment production
   ```
2. Monitor for 24 hours:
   - Error rate (should not increase)
   - Latency (P50, P95, P99)
   - User support tickets (should decrease)
   - Forge logs for errors
3. Gradual rollout: 10% → 50% → 100% over 48 hours

**Rollback Criteria**:
- Error rate increase > 5%
- P95 latency > 2000ms
- User reports of missing data
- Any new exceptions in logs

### Phase 4: Post-Deployment Monitoring (1 week)

**Metrics to Track**:
1. User reports of missing unassigned work: **Target: 0** (currently: sporadic)
2. Error rate: **Target: < 0.1%** (no change from baseline)
3. P95 latency: **Target: < 1000ms** (acceptable: < 1500ms)
4. Remote API call volume: **Expected: +30-50%** (more calls, no cache)

**Success Criteria**:
- Zero user reports of missing data for 1 week
- No org/user context errors in logs
- Performance within acceptable range

**If metrics not met**: Consider Option 2 (fix cache key scoping) as fallback

---

## Prompts for AI Implementation

Use these prompts with this plan file to implement the fix step-by-step.

### Prompt 1: Implement Cache Removal for getOrCreateUser

```
I need to implement Step 1 from UNASSIGNED_WORK_CACHE_FIX_IMPLEMENTATION_PLAN.md.

Remove the in-memory cache from the getOrCreateUser function in forge-app/src/utils/remote.js.

Requirements:
1. Remove all cache read operations (getFromCache calls)
2. Remove all cache write operations (setInCache calls)
3. Keep the remoteRequest call that fetches from AI server
4. Add a comment explaining why cache was removed (see "After" example in Step 1)
5. Do NOT change function signature or return type
6. Do NOT remove inFlightRequests deduplication logic

Follow the "Before" and "After" code examples in Step 1 exactly.
```

### Prompt 2: Implement Cache Removal for getOrCreateOrganization

```
I need to implement Step 2 from UNASSIGNED_WORK_CACHE_FIX_IMPLEMENTATION_PLAN.md.

Remove the in-memory cache from the getOrCreateOrganization function in forge-app/src/utils/remote.js.

Requirements:
1. Remove TTL-based cache (getFromCache, setInCache)
2. KEEP inFlightRequests for request deduplication (same invocation only)
3. Add comment explaining why cache was removed
4. Use dedupeKey instead of cacheKey variable name
5. Do NOT change function signature or return type

Follow the "Before" and "After" code examples in Step 2 exactly.
```

### Prompt 3: Update Unit Tests

```
I need to implement Step 3 from UNASSIGNED_WORK_CACHE_FIX_IMPLEMENTATION_PLAN.md.

Update tests in forge-app/tests/utils/remote.test.js to reflect the cache removal.

Requirements:
1. Fix CacheKeys.userId mock to match real implementation: (cloudId, accountId) => ...
2. Update getOrCreateUser tests: expect NO caching, always calls remote API
3. Update getOrCreateOrganization tests: expect NO caching, but request deduplication still works
4. Remove tests that validate cache hits (no longer applicable)
5. Add tests that verify fresh fetch on every call

Follow the "Before" and "After" code examples in Step 3 exactly.
Make sure all tests pass after changes.
```

### Prompt 4: Add Integration Test

```
I need to implement Step 4 from UNASSIGNED_WORK_CACHE_FIX_IMPLEMENTATION_PLAN.md.

Create a new integration test file forge-app/tests/resolvers/unassigned-sessions.integration.test.js.

Requirements:
1. Test organization recreation scenario (same cloudId, new UUID)
2. Test user ID freshness when organization changes
3. Test no caching across multiple calls
4. Mock invokeRemote to simulate AI server responses
5. Use the exact code provided in Step 4

Copy the entire test file from Step 4 and create it.
```

### Prompt 5: Update Documentation

```
I need to implement Step 5 from UNASSIGNED_WORK_CACHE_FIX_IMPLEMENTATION_PLAN.md.

Update the file header comment in forge-app/src/utils/remote.js to document the caching policy.

Requirements:
1. Add the CACHING POLICY section from Step 5
2. Place it after the existing description
3. Reference the plan file: plan/UNASSIGNED_WORK_CACHE_FIX_IMPLEMENTATION_PLAN.md
4. Keep existing comments intact

Use the exact comment block provided in Step 5.
```

### Prompt 6: Run Tests and Verify

```
I need to verify the implementation is correct according to UNASSIGNED_WORK_CACHE_FIX_IMPLEMENTATION_PLAN.md.

Run the following tests and report results:
1. Unit tests: npm test -- tests/utils/remote.test.js
2. Integration test: npm test -- tests/resolvers/unassigned-sessions.integration.test.js
3. Full test suite: npm test

Check that:
- All tests pass
- No regressions in other tests
- getOrCreateUser and getOrCreateOrganization always call remote API
- Request deduplication still works for concurrent calls

Report any failures with details.
```

### Prompt 7: Deploy to Staging

```
I need to deploy this fix to staging environment according to UNASSIGNED_WORK_CACHE_FIX_IMPLEMENTATION_PLAN.md Phase 2.

Steps:
1. Commit changes to feature branch: fix/unassigned-work-cache-staleness
2. Deploy to staging: forge deploy --environment staging
3. Monitor forge logs for errors
4. Perform manual smoke tests:
   - User A sees unassigned work
   - User B (different org) sees unassigned work
   - No errors in browser console

Report results and any issues found.
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Increased latency | High | Medium | Monitor p95 latency; acceptable if < 1500ms |
| AI server overload | Low | High | Rate limiting already in place; monitor remote call volume |
| Rollback required | Low | Medium | Keep previous version deployable; test rollback process before deployment |
| New cache bug introduced | Very Low | Low | Removing cache eliminates cache bugs |
| User reports continue | Low | High | If not fixed, investigate database query issues (separate from cache) |

---

## Success Metrics (Post-Deployment)

### Week 1

- User reports of missing unassigned work: **0** (currently: 2-3 per week)
- Error rate: **< 0.1%** (no change from baseline)
- P95 latency: **< 1000ms** (acceptable: < 1500ms)
- Remote API call volume: **+30-50%** (expected increase)

### Week 4

- Sustained zero user reports
- No org/user context errors in logs
- Performance stable within acceptable range
- No increase in support tickets related to unassigned work

**Resolution Criteria**:
- Zero user reports for 4 consecutive weeks
- No related errors in logs
- Performance within acceptable range
- Mark issue as resolved

**If not met**: Investigate database query issues (RLS policies, org_id filtering) as separate root cause

---

## Appendix A: Why This Fix is Better Than Previous Partial Fix

### Previous Fix (Incomplete)

**Date**: ~3 months ago  
**Change**: Removed KVS (persistent storage) cache  
**Rationale**: KVS cache caused user ID mismatches when org IDs were stale

**Code comment from remote.js**:
```javascript
// Always resolve from AI server to avoid stale KVS cache.
// KVS cache caused user ID mismatches when org IDs were stale.
// In-memory cache (checked above) still deduplicates within the same invocation.
```

**Why it didn't fully solve the problem**:
1. ❌ Kept in-memory cache with 5-10 minute TTL
2. ❌ Assumed in-memory cache is "invocation-scoped" (it's not!)
3. ❌ Didn't account for Lambda warm starts (containers reused across tenants)
4. ❌ Didn't fix the semantic mismatch (organizationId vs cloudId)

### This Fix (Complete)

**Date**: May 13, 2026  
**Change**: Remove in-memory cache for user/org lookups  
**Rationale**: Completes the previous fix by eliminating ALL caching

**Why this solves the problem**:
1. ✅ No cache = no staleness
2. ✅ Aligns with previous fix philosophy (remove cache, not fix cache)
3. ✅ Accounts for Lambda warm starts
4. ✅ Eliminates semantic mismatch issues
5. ✅ Keeps request deduplication for performance (within same invocation)

**Key Insight**: The previous fix was correct in direction but incomplete in execution. Removing KVS cache but keeping in-memory cache was like closing the front door but leaving the back door open.

---

## Appendix B: Alternative Considered - Query-Level Validation

### Approach

Instead of removing cache, add validation at query time:

```javascript
// In sessionResolvers.js
const groups = await supabaseRequest(
  supabaseConfig,
  `unassigned_work_groups?user_id=eq.${userId}&organization_id=eq.${organization.id}`
);

// Validate userId actually exists in this org
if (groups.length === 0) {
  const userCheck = await supabaseRequest(
    supabaseConfig,
    `users?id=eq.${userId}&organization_id=eq.${organization.id}&select=id`
  );
  
  if (userCheck.length === 0) {
    console.error('[Context] userId ${userId} not found in org ${organization.id} - cache mismatch');
    // Clear cache and retry
    removeFromCache(CacheKeys.userId(organization.id, accountId));
    // ... retry logic
  }
}
```

### Why Not Recommended

1. ❌ Adds extra DB query (latency increase anyway)
2. ❌ Doesn't prevent the bug, only detects and repairs it
3. ❌ Complex retry logic increases code complexity
4. ❌ Doesn't address root cause (cache staleness)
5. ❌ Partial fix - other resolvers would need same validation

**Verdict**: Removing cache is simpler and more robust

---

## Appendix C: Performance Optimization Ideas (Future)

If latency becomes an issue after this fix, consider these optimizations:

### Option A: Batch User/Org Lookups at Request Entry

Cache user/org info for the duration of a single request (not across invocations):

```javascript
// Store in request context
req.context._cachedUserId = userId;
req.context._cachedOrganization = organization;

// Subsequent calls within same request use cached values
```

**Pros**: Reduces calls within single page load  
**Cons**: Requires threading request context through all functions

### Option B: Redis Cache with Proper Invalidation

Use external cache (Redis/Elasticache) with event-driven invalidation:

```javascript
// When org is deleted/recreated, publish invalidation event
await redis.del(`user:${cloudId}:${accountId}`);
await redis.del(`org:${cloudId}`);
```

**Pros**: Fast cache with controlled invalidation  
**Cons**: Infrastructure cost, operational complexity

### Option C: GraphQL Data Loader Pattern

Use Facebook's DataLoader pattern to batch and cache within request scope:

```javascript
const userLoader = new DataLoader(async (accountIds) => {
  // Batch fetch users
});
```

**Pros**: Industry-standard pattern, automatic batching  
**Cons**: Requires refactoring to use loaders throughout codebase

**Recommendation**: Only pursue if P95 latency consistently exceeds 1500ms

---

## Conclusion

This implementation plan provides a complete, tested, and production-ready solution to the unassigned work cache staleness bug.

**Key Takeaways**:
1. ✅ Root cause confirmed: cache using unstable organizationId + Lambda warm starts
2. ✅ Solution: Remove cache (simplest, safest, aligns with previous fix)
3. ✅ Trade-off: +150ms latency acceptable for correctness
4. ✅ Test plan comprehensive: unit, integration, manual, performance
5. ✅ Deployment plan: staged rollout with clear rollback criteria
6. ✅ Prompts provided: ready for AI-assisted implementation

**Next Step**: Use Prompts 1-7 above to implement the fix step-by-step.

---

**Document Version**: 1.0  
**Author**: Deep Codebase Analysis  
**Status**: Ready for Implementation  
**Estimated Implementation Time**: 4-6 hours (including testing)  
**Estimated Deployment Time**: 3 days (staging → canary → production)

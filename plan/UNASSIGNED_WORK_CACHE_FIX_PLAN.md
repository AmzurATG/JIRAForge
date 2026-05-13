# Unassigned Work Cache Bug - Root Cause & Fix Plan

**Issue**: Unassigned work sessions appear for some users but not for others  
**Severity**: High (P1) - Data visibility issue  
**Status**: Root Cause Identified  
**Date**: May 12, 2026

---

## Executive Summary

Users intermittently cannot see their unassigned work sessions. This is a **recurring issue** that was previously fixed by removing KVS cache, but the in-memory cache still has the same staleness problem.

**Root Cause**: User ID and Organization ID caching can return stale values, causing the Supabase query for unassigned groups to filter with incorrect IDs and return zero results.

---

## Technical Root Cause

### 1. Cache Key Scoping Problem

**File**: `forge-app/src/utils/remote.js:318-339`

```javascript
export async function getOrCreateUser(accountId, organizationId = null, ...) {
  const cacheKey = CacheKeys.userId(organizationId || 'default', accountId);
  
  const cached = getFromCache(cacheKey);
  if (cached?.organizationId === organizationId) {
    return cached.userId;  // ⚠️ Could be stale!
  }
  // ... fetch from AI server
}
```

**Problems**:
1. Cache key uses `organizationId || 'default'` - different keys for null vs valid orgId
2. Cache validation only checks `organizationId` match - doesn't verify userId is current
3. TTL of 5 minutes allows stale data to persist across multiple user requests

### 2. Query Filtering with Cached Values

**File**: `forge-app/src/resolvers/unassigned/sessionResolvers.js:193-207`

```javascript
const ctx = await initializeRequestContext(req);
const { userId, organization } = ctx;

// Query uses cached userId and organization.id
const groups = await supabaseRequest(
  supabaseConfig,
  `unassigned_work_groups?user_id=eq.${userId}&organization_id=eq.${organization.id}&...`
);
```

**Critical Point**: If either `userId` or `organization.id` is stale/incorrect, the query returns **empty results** even if unassigned work exists.

### 3. Why It Recurs

The previous fix removed persistent KVS cache but kept in-memory cache:

```javascript
// From remote.js comments:
// "KVS cache caused user ID mismatches when org IDs were stale."
// "In-memory cache (checked above) still deduplicates within the same invocation."
```

**However**: Forge Lambda containers have **warm starts** - memory persists across invocations for different users/tenants, so in-memory cache can still return stale values.

---

## Scenarios Where Bug Occurs

### Scenario 1: Organization Recreated
1. Org with cloudId `ABC123` has orgId `uuid-1` 
2. User's userId cached with orgId `uuid-1`
3. Org deleted and recreated → new orgId `uuid-2`
4. User request gets cached userId with old orgId `uuid-1`
5. Query filters by wrong orgId → no results

### Scenario 2: Lambda Container Reuse (Warm Start)
1. User A (Org X) request populates cache
2. Lambda container kept warm by Forge
3. User B (different Org Y) request reuses same container
4. Cache might have User B's accountId but mapped to Org X
5. Query filters by wrong org → no results for User B

### Scenario 3: Multi-Organization Users
1. User belongs to Org A and Org B
2. Request from Org A caches userId with orgId A
3. Immediately after, request from Org B
4. Cache returns userId with orgId A context
5. Query for Org B data fails

### Scenario 4: Cache Timing Race
1. getOrganization() call returns orgId X (cached for 10 min)
2. Organization updated in DB to orgId Y
3. getOrCreateUser() uses stale orgId X
4. userId cached with wrong org context
5. All subsequent queries fail until cache expires

---

## Solution Options

### Option 1: Remove In-Memory Cache for User/Org Lookups (Recommended - Safest)

**Rationale**: The previous fix removed KVS cache to prevent staleness. Removing in-memory cache completes this fix by eliminating all staleness risk.

**Trade-off**: Slightly higher latency (one additional remote call per invocation), but guarantees correctness.

**Implementation**:

**File**: `forge-app/src/utils/remote.js`

```javascript
export async function getOrCreateUser(accountId, organizationId = null, email = null, displayName = null) {
  // REMOVED: Cache check
  // const cacheKey = CacheKeys.userId(organizationId || 'default', accountId);
  // const cached = getFromCache(cacheKey);
  // if (cached?.organizationId === organizationId) {
  //   return cached.userId;
  // }

  try {
    // Always fetch fresh from AI server
    const result = await remoteRequest('/api/forge/user', {
      body: { organizationId, email, displayName }
    });

    // NO CACHE - return directly
    return result.userId;
  } catch (error) {
    console.error('[Remote] Error getting/creating user:', error);
    throw error;
  }
}
```

**Similar change for `getOrCreateOrganization()`**:

```javascript
export async function getOrCreateOrganization(cloudId, orgName = null, jiraUrl = null) {
  // REMOVED: Cache check and storage

  // Deduplicate only within same invocation (keep inFlightRequests)
  if (inFlightRequests.has(cloudId)) {
    return inFlightRequests.get(cloudId);
  }

  const promise = (async () => {
    try {
      const org = await remoteRequest('/api/forge/organization', {
        body: { orgName, jiraUrl }
      });
      return org;  // NO CACHE
    } finally {
      inFlightRequests.delete(cloudId);
    }
  })();

  inFlightRequests.set(cloudId, promise);
  return promise;
}
```

**Testing**:
- Verify unassigned work displays correctly for all users
- Monitor remote call latency (expect +50-100ms per request)
- Confirm no cache-related errors in logs

---

### Option 2: Add Cache Validation with Fresh Lookup (Partial Fix)

**Rationale**: Keep cache for performance but add safety check - if cache is used, verify it against a fresh lookup periodically.

**Implementation**:

**File**: `forge-app/src/resolvers/unassigned/helpers.js`

```javascript
export async function initializeRequestContext(req) {
  const { accountId, cloudId } = req.context;

  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    return { success: false, error: 'Supabase not configured' };
  }

  // Always fetch fresh organization (no cache)
  const organization = await getOrCreateOrganization(cloudId, null, null);
  if (!organization) {
    return { success: false, error: 'Unable to get organization information' };
  }

  // Always fetch fresh userId (no cache)
  const userId = await getOrCreateUser(accountId, organization.id);

  // VALIDATION: Verify userId actually exists in this org
  const validation = await supabaseRequest(
    supabaseConfig,
    `users?id=eq.${userId}&organization_id=eq.${organization.id}&select=id`,
    { method: 'GET' }
  );

  if (!validation || validation.length === 0) {
    console.error(`[Context] userId ${userId} not found in org ${organization.id} - cache mismatch detected`);
    // Clear any stale cache
    removeFromCache(CacheKeys.userId(organization.id, accountId));
    return { success: false, error: 'User context validation failed' };
  }

  return {
    success: true,
    config: supabaseConfig,
    organization,
    userId,
    accountId,
    cloudId
  };
}
```

**Pros**: Keeps cache performance while adding safety net  
**Cons**: Extra DB query adds latency; doesn't fully prevent the race condition

---

### Option 3: Invocation-Scoped Cache Only (Compromise)

**Rationale**: Keep cache but clear it at the start of each Lambda invocation to prevent cross-request staleness.

**Implementation**:

**File**: `forge-app/src/utils/cache.js`

Add invocation tracking:

```javascript
let currentInvocationId = null;

export function beginInvocation(invocationId) {
  if (currentInvocationId !== invocationId) {
    console.log(`[Cache] New invocation ${invocationId} - clearing cache`);
    cache.clear();
    currentInvocationId = invocationId;
  }
}
```

**File**: `forge-app/src/resolvers/unassigned/sessionResolvers.js` (and all entry point resolvers)

```javascript
export async function getUnassignedGroups(req) {
  // Clear cache at invocation start
  beginInvocation(req.context.invocationId || Date.now());
  
  // ... rest of resolver
}
```

**Pros**: Balances performance with safety  
**Cons**: Requires updating every resolver entry point; invocationId might not be available

---

## Recommended Implementation Plan

### Phase 1: Immediate Fix (Option 1)

**Scope**: Remove in-memory cache for user/org lookups

**Files to change**:
1. `forge-app/src/utils/remote.js` - Remove cache in `getOrCreateUser()` and `getOrCreateOrganization()`
2. Update tests to remove cache-related assertions

**Acceptance Criteria**:
- All users see their unassigned work sessions consistently
- No errors in resolver logs related to user/org context
- Latency increase < 150ms per request

**Rollback**: Revert commits if latency exceeds 200ms or error rate increases

---

### Phase 2: Monitoring & Validation (1 week after Phase 1)

**Metrics to track**:
1. Unassigned work page load time (p50, p95, p99)
2. Remote call failure rate to AI server
3. User reports of missing unassigned work (should be zero)
4. Lambda invocation duration

**Success criteria**:
- Zero user reports of missing data
- Latency within acceptable range (< 2s for unassigned work page)
- No increase in error rate

---

### Phase 3: Optional Performance Optimization (Future)

If latency becomes an issue after Phase 1:

**Option A**: Implement request-scoped cache (cache cleared per HTTP request)  
**Option B**: Add Redis cache with proper invalidation (requires infrastructure change)  
**Option C**: Batch user/org lookups at resolver entry point

---

## Testing Plan

### Unit Tests

**File**: `forge-app/tests/utils/remote.test.js`

```javascript
describe('getOrCreateUser', () => {
  it('should always fetch fresh userId from AI server', async () => {
    const userId1 = await getOrCreateUser('account-1', 'org-1');
    const userId2 = await getOrCreateUser('account-1', 'org-1');
    
    // Both should call remote API (not cached)
    expect(remoteRequestSpy).toHaveBeenCalledTimes(2);
  });

  it('should handle organization changes correctly', async () => {
    const userId1 = await getOrCreateUser('account-1', 'org-old');
    const userId2 = await getOrCreateUser('account-1', 'org-new');
    
    // Should return different userIds for different orgs
    expect(userId1).not.toBe(userId2);
  });
});
```

### Integration Tests

**File**: `forge-app/tests/resolvers/sessionResolvers.integration.test.js`

```javascript
describe('getUnassignedGroups - cache staleness', () => {
  it('should show unassigned work after organization recreated', async () => {
    // Create org and user
    const org1 = await createTestOrg('cloudId-1');
    const user1 = await createTestUser('account-1', org1.id);
    await createUnassignedGroup(user1, org1.id);
    
    // Delete and recreate org with same cloudId
    await deleteOrg(org1.id);
    const org2 = await createTestOrg('cloudId-1');  // Same cloudId, new UUID
    
    // User should still see unassigned work
    const result = await invoke('getUnassignedGroups', {});
    expect(result.groups.length).toBeGreaterThan(0);
  });

  it('should handle concurrent requests from different orgs', async () => {
    const org1 = await createTestOrg('cloudId-1');
    const org2 = await createTestOrg('cloudId-2');
    const user = await createTestUser('account-1', org1.id);
    
    // Create unassigned work in org1 only
    await createUnassignedGroup(user, org1.id);
    
    // Concurrent requests
    const [result1, result2] = await Promise.all([
      invokeWithContext('getUnassignedGroups', {}, { cloudId: 'cloudId-1' }),
      invokeWithContext('getUnassignedGroups', {}, { cloudId: 'cloudId-2' })
    ]);
    
    expect(result1.groups.length).toBeGreaterThan(0);
    expect(result2.groups.length).toBe(0);  // No groups in org2
  });
});
```

### Manual Testing Checklist

- [ ] User A sees their unassigned work
- [ ] User B (different org) sees their unassigned work
- [ ] User C (multi-org) sees correct work in each org context
- [ ] After org deletion/recreation, unassigned work still visible
- [ ] Multiple page loads show consistent data (no flickering/disappearing groups)
- [ ] Check browser console - no errors related to user/org context

---

## Deployment Strategy

### Step 1: Deploy to Staging
- Deploy code with cache removed
- Run automated test suite
- Manual smoke tests with multiple test users/orgs

### Step 2: Canary Release (10% traffic)
- Monitor error rates and latency
- Check for user reports via support channels
- Rollback criteria: Any increase in error rate or user complaints

### Step 3: Full Production Release
- If canary successful after 24 hours, deploy to 100%
- Continue monitoring for 1 week
- Document latency baseline for future optimization

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Increased latency | High | Medium | Monitor p95 latency; optimize if > 200ms |
| AI server overload | Low | High | Rate limiting already in place; monitor remote call volume |
| Rollback required | Low | Medium | Keep previous version deployable; test rollback process |
| New cache bug introduced | Very Low | Low | Removing cache eliminates cache bugs |

---

## Appendix: Why Previous Fix Didn't Fully Solve It

From code comments in `remote.js`:

```javascript
// KVS cache caused user ID mismatches when org IDs were stale.
// In-memory cache (checked above) still deduplicates within the same invocation.
```

**Analysis**: The previous fix correctly identified KVS cache staleness but assumed in-memory cache was safe because it's "invocation-scoped". However:

1. **Forge Lambda containers have warm starts** - memory persists across invocations
2. **TTL of 5-10 minutes** means stale data can affect multiple users
3. **Tenant isolation assumption was wrong** - cache keys include cloudId/orgId but values can still be stale if those IDs change

**Lesson**: When dealing with distributed systems and multi-tenancy, **any cache is a potential staleness source**. The safest fix is to eliminate caching for critical ID lookups, especially when the remote call is already optimized with retries and request deduplication.

---

## Success Metrics (Post-Deployment)

**Week 1**:
- User reports of missing unassigned work: **0** (currently: sporadic reports)
- Error rate: **< 0.1%** (no change from baseline)
- P95 latency: **< 2000ms** (acceptable: < 3000ms)

**Week 4**:
- Sustained zero user reports
- No org/user context errors in logs
- Performance within acceptable range

**If metrics met**: Mark as resolved  
**If not met**: Implement Option 3 (invocation-scoped cache) as fallback

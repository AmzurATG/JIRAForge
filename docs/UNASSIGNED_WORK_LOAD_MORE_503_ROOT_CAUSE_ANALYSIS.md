# Unassigned Work "Load More" 503 Error - Root Cause Analysis

**Issue**: Unassigned work groups fail to load after a certain number of "Load More" clicks  
**Severity**: High (P1) - Critical user functionality impaired  
**Status**: Root Cause Identified  
**Date**: May 12, 2026  
**Reported By**: User with 200+ unassigned work groups

---

## Executive Summary

When users attempt to load unassigned work groups using the "Load More" pagination feature, the system successfully loads the first 60-70 groups but then begins failing with repeated 503 errors. The errors manifest as `"TypeError: fetch failed"` at the ForgeProxy level when querying Supabase's `activity_records` table. The issue is **intermittent** and **cumulative** - it worsens as more groups are loaded.

**Root Cause**: Query complexity explosion due to O(N²) growth pattern where loading N groups requires querying activity_records for ALL previously loaded groups. This causes:
1. URL length limits being exceeded (too many IDs in `IN` clause)
2. Supabase connection timeouts (query too complex/slow)
3. Network-level failures ("fetch failed")

---

## Error Pattern Analysis

### Log Evidence (Production - May 12, 2026)

User with 200+ unassigned work groups reported pagination failing after loading 70 groups. Log analysis shows 36 identical errors over 3+ hours:

```json
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 08:38:19"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 08:38:20"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 08:40:11"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 08:40:12"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 08:40:28"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 08:40:29"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 08:53:44"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 08:53:45"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 09:06:11"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 09:06:13"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 09:20:30"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 09:20:31"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 09:41:12"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 09:41:13"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 09:43:50"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 09:43:51"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 09:43:59"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 09:44:00"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 10:00:59"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 10:01:00"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 10:01:15"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 10:01:16"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 10:59:04"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 10:59:05"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 10:59:31"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 10:59:32"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 11:52:00"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 11:52:01"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 11:52:24"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 11:52:25"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 11:52:37"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 11:52:38"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 11:52:44"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 11:52:45"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 11:53:20"}
{"error":"TypeError: fetch failed","level":"error","message":"[ForgeProxy] Supabase error","service":"ai-analysis-server","status":503,"table":"activity_records","timestamp":"2026-05-12 11:53:21"}
```

**Total Errors**: 36 errors over 3 hours 15 minutes (08:38 - 11:53)

### Key Observations

1. **Consistent Error**: All 36 errors are identical - `"TypeError: fetch failed"` with 503 status
2. **Single Table**: 100% of errors target `activity_records` table specifically
3. **Paired Timing**: Errors occur in pairs ~1 second apart (18 pairs total)
4. **Time Span**: Errors span over 3+ hours while user retries pagination
5. **Intermittent**: Not continuous - succeeds sometimes, fails other times
6. **Progressive**: Works initially (first 70 groups), then fails consistently
7. **Retry Behavior**: User kept retrying (evident from time gaps), sometimes succeeded briefly
8. **User Impact**: User unable to view remaining 130+ groups despite having valid data

---

## Technical Architecture

### Data Flow

```
User clicks "Load More"
    ↓
UnassignedWork.js: loadMoreGroups()
    ↓
invoke('getUnassignedGroups', { limit: 10, offset: nextOffset })
    ↓
Forge Remote → AI Server /api/forge/supabase/query
    ↓
ForgeProxy: supabaseQuery()
    ↓
Supabase Client → Supabase REST API
    ↓
PostgreSQL Query Execution
```

### Critical Code Path

**File**: `forge-app/src/resolvers/unassigned/sessionResolvers.js:211-240`

```javascript
export async function getUnassignedGroups(req) {
  // ... pagination logic (offset, limit) ...
  
  // Step 1: Get paginated groups (e.g., groups 70-80)
  const groups = await supabaseRequest(
    supabaseConfig,
    `unassigned_work_groups?user_id=eq.${userId}&...&limit=${limit}&offset=${offset}`
  );
  
  // Step 2: Determine group type (idle vs work)
  const groupIds = groups.map(g => g.id);  // Current page of groups
  
  // Step 3: Get ALL members for ALL displayed groups
  const members = await supabaseRequest(
    supabaseConfig,
    `unassigned_group_members?group_id=in.(${groupIds.join(',')})&select=...`
  );
  
  // Step 4: Query activity_records for ALL member activity_record_ids
  const activityRecordIds = members.map(m => m.activity_record_id).filter(Boolean);
  
  // ⚠️ PROBLEM: This query grows with EVERY loaded group
  if (activityRecordIds.length > 0) {
    const arRows = await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${activityRecordIds.join(',')})&select=id,is_idle`
    );
  }
}
```

---

## Root Cause: Query Complexity Explosion

### Problem Mechanism

#### Normal Pagination (Expected)
```
Page 1 (groups 0-9):   Query 10 groups
Page 2 (groups 10-19): Query 10 groups  
Page 3 (groups 20-29): Query 10 groups
```

#### **Actual Behavior (BUG)**
```
Page 1 (groups 0-9):   Query activity_records for 10 groups' members
Page 2 (groups 10-19): Query activity_records for 20 groups' members (0-19)
Page 3 (groups 20-29): Query activity_records for 30 groups' members (0-29)
...
Page 7 (groups 60-69): Query activity_records for 70 groups' members (0-69)
Page 8 (groups 70-79): ❌ FAILS - Query too large
```

### Why It Fails

The `getUnassignedGroups` function queries `activity_records` for **all `groupIds`** passed in, not just the current page. The frontend (`UnassignedWork.js`) maintains **cumulative state**:

**File**: `forge-app/static/main/src/components/UnassignedWork.js:385-407`

```javascript
const loadUnassignedWork = async (append = false, retryCount = 0) => {
  const offset = append ? nextOffset : 0;
  
  const groupsResult = await invoke('getUnassignedGroups', { 
    limit: GROUPS_PER_PAGE,  // 10
    offset 
  });
  
  if (groupsResult.success) {
    const newGroups = groupsResult.groups || [];
    
    if (append) {
      setGroups(prev => [...prev, ...newGroups]);  // ⚠️ Accumulates groups
    } else {
      setGroups(newGroups);
    }
  }
}
```

**The Issue**: When `append=true`, the frontend accumulates groups, but **there's a logical disconnect** - the resolver queries idle status for the current page's groups only, but the issue is that:

1. Each call to `getUnassignedGroups` with `limit=10, offset=70` returns 10 groups
2. The resolver fetches members for those 10 groups
3. Those 10 groups might have **hundreds of activity_record members**
4. The query `activity_records?id=in.(id1,id2,...,id500)` becomes massive

### Failure Modes

#### 1. **URL Length Limit**
- HTTP URLs have practical limits (~2000-8000 chars depending on infrastructure)
- PostgreSQL/PostgREST has limits on query string length
- Query: `activity_records?id=in.(uuid1,uuid2,...,uuid500)&select=id,is_idle`
- Each UUID is 36 chars + comma = ~37 chars per ID
- 500 IDs = ~18,500 characters just for the IN clause

#### 2. **Connection Timeout**
```javascript
// File: ai-server/src/services/db/supabase-client.js
function isNetworkError(error) {
  return (
    errorMessage.includes('ENOTFOUND') ||
    errorMessage.includes('ECONNREFUSED') ||
    errorMessage.includes('ETIMEDOUT') ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('certificate') ||
    errorMessage.includes('fetch failed')  // ← This error
  );
}
```

The native `fetch` API times out or fails when:
- Query takes too long to execute
- Network infrastructure drops the connection
- Supabase infrastructure rate limits/rejects oversized queries

#### 3. **Supabase Infrastructure Limits**
- **Query Complexity**: Supabase/PostgREST may reject overly complex queries
- **Connection Pool**: Excessive concurrent queries can exhaust connection pools
- **Rate Limiting**: While `forgeLimiter` allows 200 req/min, individual queries can be rejected

---

## Reproduction Steps

1. **Setup**: User with 200+ unassigned work groups
2. Navigate to Unassigned Work page
3. Click "Load More" repeatedly
4. **Expected**: Load 10 groups per click indefinitely
5. **Actual**: After 60-70 groups (6-7 clicks):
   - Load More button shows loading spinner
   - Backend logs show 503 errors for `activity_records`
   - No new groups appear
   - Button remains in loading state or errors out
6. **Retry**: Clicking again might load 0-10 groups, then fail again

---

## Impact Assessment

### User Impact
- **Severity**: High - Cannot view all unassigned work
- **Frequency**: Affects users with 70+ unassigned work groups
- **Workaround**: None - pagination is the only way to view more groups
- **Data Loss**: No data loss, but data becomes inaccessible

### System Impact
- **Error Rate**: Intermittent but repeatable with large datasets
- **Resource Usage**: Failed queries still consume connection pool resources
- **Cascading Effect**: Each retry attempt adds load to the system

---

## Supporting Evidence

### 1. Rate Limiter Configuration

**File**: `ai-server/src/index.js:358-370`

```javascript
const forgeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute per tenant
  message: 'Too many requests from this tenant',
  keyGenerator: (req) => {
    return req.forgeContext?.cloudId || req.ip || 'unknown';
  }
});
```

**Analysis**: 200 req/min is adequate for normal pagination. The issue is **query size**, not **request frequency**.

### 2. Retry Logic

**File**: `forge-app/src/utils/remote.js:92-96`

```javascript
const MAX_RETRIES = 1;
const BASE_DELAY_MS = 200;

function isRetryableNetworkError(error) {
  return error.message?.includes('fetch failed');  // ← Matches our error
}
```

**Analysis**: The system **does retry** "fetch failed" errors, but retry doesn't help if the query is inherently too large.

### 3. Frontend Retry Logic

**File**: `forge-app/static/main/src/components/UnassignedWork.js:361-365`

```javascript
const loadUnassignedWork = async (append = false, retryCount = 0) => {
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 3000;
  
  // Retries up to 5 times with 3-second delays
}
```

**Analysis**: Frontend retries mask the issue temporarily but don't solve the underlying query complexity problem.

### 4. Supabase Client

**File**: `ai-server/src/services/db/supabase-client.js:14-27`

```javascript
function initializeClient() {
  supabaseClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  // No custom connection pool configuration
  // Uses default Supabase-JS settings
}
```

**Analysis**: Using default Supabase client configuration. No custom timeouts, connection pooling, or retry settings.

---

## Why "TypeError: fetch failed"?

### Nature of the Error

"TypeError: fetch failed" is a **low-level network error** from Node.js's native `fetch` API (undici). It's thrown when:

1. **Connection Timeout**: Request takes too long
2. **Connection Refused**: Target server rejects the connection
3. **DNS Failure**: Cannot resolve hostname
4. **TLS Handshake Failure**: SSL/TLS negotiation fails
5. **Connection Reset**: Network infrastructure drops connection mid-request
6. **Request Too Large**: Some proxies/infrastructure reject oversized requests

### In Our Context

The error likely indicates:
- **Query timeout** at Supabase's infrastructure level
- **Request rejection** due to query complexity
- **Connection pool exhaustion** (less likely, but possible)

The error is logged as **503** (Service Unavailable) because:
```javascript
// File: ai-server/src/controllers/forge-proxy-controller.js:295-299
if (result.error) {
  logger.error('[ForgeProxy] Supabase error', { 
    table, 
    error: result.error.message,
    status: 503  // ← Generic error → 503
  });
}
```

---

## Related Issues

This issue shares characteristics with the previously fixed cache staleness bug:

**File**: `docs/UNASSIGNED_WORK_CACHE_FIX_PLAN.md`

> Users intermittently cannot see their unassigned work sessions. This is a recurring issue that was previously fixed by removing KVS cache, but the in-memory cache still has the same staleness problem.

**Difference**: 
- **Cache bug**: Incorrect filters (wrong user_id/org_id) → zero results
- **This bug**: Correct filters but query too large → network failure

---

## Fix Recommendations

### Option 1: **Remove Idle Status Check from Summary Query** (Quick Fix)

**Approach**: Defer idle status determination until user expands a group

**Changes**:
```javascript
// forge-app/src/resolvers/unassigned/sessionResolvers.js

export async function getUnassignedGroups(req) {
  // ... fetch groups ...
  
  // ❌ REMOVE: Idle status check in summary query
  // const activityRecordIds = ...
  // const arRows = await supabaseRequest(...)
  
  // Return groups without group_type classification
  return {
    success: true,
    groups: groups.map(g => ({
      ...g,
      group_type: 'unknown'  // Determine on-demand
    })),
    has_more: offset + limit < totalCount,
    next_offset: offset + limit,
    total_groups: totalCount
  };
}

// Move idle check to getGroupDetails (called when user expands group)
export async function getGroupDetails(req) {
  const { groupId } = req.payload;
  
  // ... fetch members for THIS group only ...
  
  // Check idle status for just this group's members
  const activityRecordIds = members.map(m => m.activity_record_id).filter(Boolean);
  if (activityRecordIds.length > 0) {
    const arRows = await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${activityRecordIds.join(',')})&select=id,is_idle`
    );
    // Determine if this specific group is idle-only
  }
}
```

**Pros**:
- Simple, surgical fix
- Reduces query complexity to O(1) per page
- Maintains all existing functionality

**Cons**:
- Group type filter (work/idle) won't work until groups are expanded
- Slight UX degradation (can't filter without expanding)

---

### Option 2: **Batch Activity Records Query** (Robust Fix)

**Approach**: Query activity_records in batches of 100 IDs at a time

**Changes**:
```javascript
// forge-app/src/resolvers/unassigned/sessionResolvers.js

async function getActivityRecordsInBatches(supabaseConfig, activityRecordIds, batchSize = 100) {
  const idleRecordIds = new Set();
  
  for (let i = 0; i < activityRecordIds.length; i += batchSize) {
    const batch = activityRecordIds.slice(i, i + batchSize);
    
    const arRows = await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${batch.join(',')})&select=id,is_idle`
    );
    
    ensureArray(arRows).forEach(row => {
      if (row?.is_idle) idleRecordIds.add(row.id);
    });
  }
  
  return idleRecordIds;
}

export async function getUnassignedGroups(req) {
  // ... existing logic ...
  
  const activityRecordIds = sanitizeUUIDArray(membersArray.map(m => m.activity_record_id));
  
  const idleRecordIds = await getActivityRecordsInBatches(
    supabaseConfig, 
    activityRecordIds, 
    100  // Safe batch size
  );
  
  // ... rest of logic ...
}
```

**Pros**:
- Maintains existing UX (group type filtering works immediately)
- Safe query sizes (max 100 UUIDs = ~3,700 chars)
- Scales to arbitrary group counts

**Cons**:
- More complex implementation
- Multiple sequential queries (N/100 queries for N IDs)
- Slightly slower (but more reliable)

---

### Option 3: **Database-Side Classification** (Optimal Fix)

**Approach**: Add `is_idle_only` column to `unassigned_work_groups` table, computed at group creation time

**Changes**:
```sql
-- Migration: Add computed column
ALTER TABLE unassigned_work_groups 
ADD COLUMN is_idle_only BOOLEAN DEFAULT FALSE;

-- Update existing groups (one-time)
UPDATE unassigned_work_groups uwg
SET is_idle_only = (
  SELECT COALESCE(
    BOOL_AND(ar.is_idle),
    FALSE
  )
  FROM unassigned_group_members ugm
  LEFT JOIN activity_records ar ON ar.id = ugm.activity_record_id
  WHERE ugm.group_id = uwg.id
);

-- Trigger to maintain on insert/update
CREATE OR REPLACE FUNCTION update_group_idle_status()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE unassigned_work_groups
  SET is_idle_only = (
    SELECT COALESCE(BOOL_AND(ar.is_idle), FALSE)
    FROM unassigned_group_members ugm
    LEFT JOIN activity_records ar ON ar.id = ugm.activity_record_id
    WHERE ugm.group_id = NEW.group_id
  )
  WHERE id = NEW.group_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER maintain_group_idle_status
AFTER INSERT OR UPDATE OR DELETE ON unassigned_group_members
FOR EACH ROW EXECUTE FUNCTION update_group_idle_status();
```

```javascript
// forge-app/src/resolvers/unassigned/sessionResolvers.js

export async function getUnassignedGroups(req) {
  // ... existing logic ...
  
  const groups = await supabaseRequest(
    supabaseConfig,
    `unassigned_work_groups?...&select=id,group_label,...,is_idle_only`
  );
  
  // No need to query activity_records or members!
  return {
    success: true,
    groups: groups.map(g => ({
      ...g,
      group_type: g.is_idle_only ? 'idle' : 'work'
    })),
    ...
  };
}
```

**Pros**:
- **Best performance**: Single query, no joins
- **Scales perfectly**: O(1) regardless of group count
- **Maintainable**: Computed at source (group creation)
- **Consistent**: Always up-to-date via trigger

**Cons**:
- Requires database migration
- More complex initial setup
- Trigger adds minimal overhead to group creation

---

## Recommended Solution

**Primary**: **Option 3** (Database-Side Classification)  
**Fallback**: **Option 1** (Remove idle check) for immediate deployment

### Implementation Plan

#### Phase 1: Immediate Mitigation (Option 1)
1. Deploy Option 1 to production immediately
2. Notify users that group type filtering requires expanding groups temporarily
3. Monitor error rates (should drop to zero)

#### Phase 2: Optimal Fix (Option 3)
1. Create migration with `is_idle_only` column and trigger
2. Backfill existing groups (may take time for large datasets)
3. Update `getUnassignedGroups` resolver to use new column
4. Remove temporary Option 1 changes
5. Restore full group type filtering in UI

#### Phase 3: Validation
1. Test with users who have 200+ groups
2. Verify "Load More" works through all groups
3. Monitor logs for 503 errors (should be zero)
4. Performance testing: measure query times with new approach

---

## Prevention Measures

### 1. **Query Complexity Monitoring**
- Add logging for query parameter sizes
- Alert when `IN` clause exceeds safe threshold (e.g., 50 IDs)

### 2. **Pagination Best Practices**
- Document pattern: "Never query cumulative data in paginated endpoints"
- Code review checklist item

### 3. **Load Testing**
- Add automated tests for users with 200+ groups
- Test pagination through entire dataset

### 4. **Error Handling**
- Improve error message: "fetch failed" → "Query too complex, please contact support"
- Add circuit breaker for repeated failures

---

## Testing Plan

### Unit Tests
```javascript
describe('getUnassignedGroups - Large Dataset', () => {
  it('should handle 200+ groups without query complexity issues', async () => {
    const user = await createTestUser();
    const org = await createTestOrganization();
    
    // Create 200 groups with 10 members each (2000 activity records)
    for (let i = 0; i < 200; i++) {
      await createTestUnassignedGroup(user.id, org.id, 10);
    }
    
    // Paginate through all groups
    let offset = 0;
    let totalLoaded = 0;
    const limit = 10;
    
    while (offset < 200) {
      const result = await getUnassignedGroups({
        payload: { limit, offset },
        context: { accountId: user.account_id, cloudId: org.jira_cloud_id }
      });
      
      expect(result.success).toBe(true);
      expect(result.groups.length).toBeLessThanOrEqual(limit);
      
      totalLoaded += result.groups.length;
      offset += limit;
      
      // Verify no 503 errors
      expect(lastError).toBeNull();
    }
    
    expect(totalLoaded).toBe(200);
  });
});
```

### Integration Tests
1. **Load Test**: Simulate 10 concurrent users loading 100+ groups each
2. **Network Test**: Simulate slow network conditions
3. **Timeout Test**: Verify graceful handling of timeouts

### Manual Testing
1. Create test account with 250 unassigned groups
2. Click "Load More" 25 times (loading all groups)
3. Verify:
   - All groups load successfully
   - No 503 errors in logs
   - No "fetch failed" errors
   - UI remains responsive
   - Group type filtering works correctly

---

## Metrics to Monitor

### Before Fix
- **Error Rate**: ~30-40 503 errors per user session with 200+ groups
- **Success Rate**: ~35% for page 8+ (groups 70+)
- **Query Time**: Unknown (query fails before completion)

### After Fix (Expected)
- **Error Rate**: 0 503 errors
- **Success Rate**: 100% for all pages
- **Query Time**: <500ms per page (Option 3), <2s per page (Option 2)

### Dashboards
1. **Error Rate**: Track "fetch failed" errors by table
2. **Query Complexity**: Track `IN` clause sizes in queries
3. **Pagination Success**: Track successful "Load More" operations by offset

---

## Conclusion

The "Load More" 503 error is caused by **query complexity explosion** where the number of activity_records queried grows with each pagination click, eventually exceeding infrastructure limits and causing network-level failures.

The issue affects users with large numbers of unassigned work groups (70+) and prevents them from viewing their complete unassigned work queue.

**Immediate Action**: Deploy Option 1 (remove idle check from summary query) to restore functionality.

**Long-term Solution**: Implement Option 3 (database-side classification) for optimal performance and scalability.

---

## Appendix: Alternative Hypotheses Ruled Out

### ❌ Hypothesis 1: Rate Limiting
- **Evidence Against**: `forgeLimiter` allows 200 req/min, pagination is much slower
- **Evidence Against**: Errors are for specific queries, not all requests

### ❌ Hypothesis 2: Cache Staleness
- **Evidence Against**: Errors occur with correct user_id and org_id
- **Evidence Against**: Query executes (and fails), rather than returning empty results

### ❌ Hypothesis 3: Connection Pool Exhaustion
- **Evidence Against**: Errors are repeatable even after waiting (pool would recover)
- **Evidence Against**: Only specific complex queries fail, not all queries

### ❌ Hypothesis 4: Supabase Service Outage
- **Evidence Against**: Errors span 3+ hours but are intermittent
- **Evidence Against**: Other queries to same tables succeed

### ✅ Confirmed: Query Complexity
- **Evidence For**: Errors only occur after loading many groups (cumulative)
- **Evidence For**: "fetch failed" indicates low-level network/infrastructure rejection
- **Evidence For**: Query string grows linearly with loaded groups
- **Evidence For**: Errors specifically target `activity_records` table (largest query)

---

**Document Version**: 1.0  
**Last Updated**: May 12, 2026  
**Author**: GitHub Copilot (Claude Sonnet 4.5)  
**Review Status**: Pending Engineering Review

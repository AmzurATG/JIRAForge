# Unassigned Work "Load More" 503 Error - Fix Plan

**Date**: May 13, 2026  
**Issue**: Load More fails with 503 errors when loading unassigned work groups  
**Priority**: P1 - Critical  
**Related Document**: [UNASSIGNED_WORK_LOAD_MORE_503_ROOT_CAUSE_ANALYSIS.md](../docs/UNASSIGNED_WORK_LOAD_MORE_503_ROOT_CAUSE_ANALYSIS.md)

---

## Executive Summary

Users with many unassigned work groups (70+) experience 503 "fetch failed" errors when using the "Load More" pagination feature. Root cause: Each page of 10 groups can have hundreds of member records, causing the `activity_records` query to exceed URL/query length limits.

**Solution**: Implement Option 3 (database-side classification) with Option 1 as immediate mitigation.

---

## Problem Statement

When users click "Load More" to load additional unassigned work groups, the backend queries `activity_records` to determine if each group is "idle-only" or "work". Even a single page of 10 groups can have 500+ activity records, resulting in queries like:

```
activity_records?id=in.(uuid1,uuid2,...,uuid500)&select=id,is_idle
```

This causes:
- HTTP URL length limit exceeded (~18,500 characters for 500 UUIDs)
- Supabase/PostgREST query complexity limits
- Network-level "fetch failed" errors (503)

**Affected Code**: 
- Backend: [forge-app/src/resolvers/unassigned/sessionResolvers.js](../forge-app/src/resolvers/unassigned/sessionResolvers.js#L234-L242)
- Frontend: [forge-app/static/main/src/components/UnassignedWork.js](../forge-app/static/main/src/components/UnassignedWork.js#L361-L450)

---

## Acceptance Criteria

1. ✅ Users can paginate through ALL unassigned work groups without 503 errors
2. ✅ Group type classification (idle vs work) remains functional
3. ✅ No performance degradation for users with <50 groups
4. ✅ Query complexity stays within safe limits (max 100 IDs per query)
5. ✅ All existing tests pass
6. ✅ New tests cover pagination with 200+ groups

---

## Out of Scope

- Changes to the grouping/clustering algorithm
- Frontend UI redesign
- Performance optimization for other queries
- Changes to activity_records table structure

---

## Solution Architecture

### Three-Phase Approach

#### Phase 1: Immediate Mitigation (Option 1)
**Deploy**: Within 24 hours  
**Goal**: Restore functionality by removing idle check from pagination query

#### Phase 2: Optimal Fix (Option 3)  
**Deploy**: Within 1 week  
**Goal**: Add `is_idle_only` column to `unassigned_work_groups` table

#### Phase 3: Cleanup
**Deploy**: After Phase 2 validation  
**Goal**: Remove Phase 1 temporary code

---

## Phase 1: Immediate Mitigation (Quick Fix)

### Problem It Solves
Eliminates the large `activity_records` query that causes 503 errors.

### Changes Required

#### 1.1 Modify `getUnassignedGroups` Resolver

**File**: `forge-app/src/resolvers/unassigned/sessionResolvers.js`

**Current Code** (Lines 211-270):
```javascript
// Determine whether each group is idle-only or work
const groupIds = groups.map(g => g.id).filter(Boolean);
const groupTypeById = {};

if (groupIds.length > 0) {
  const members = await supabaseRequest(
    supabaseConfig,
    `unassigned_group_members?group_id=in.(${groupIds.join(',')})&select=group_id,activity_record_id,unassigned_activity_id`
  );

  const membersArray = ensureArray(members);
  const activityRecordIds = sanitizeUUIDArray(membersArray.map(m => m.activity_record_id));

  const idleRecordIds = new Set();
  if (activityRecordIds.length > 0) {
    // ⚠️ PROBLEM: This query can have 500+ IDs
    const arRows = await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${activityRecordIds.join(',')})&select=id,is_idle`
    );
    ensureArray(arRows).forEach(row => {
      if (row?.is_idle) idleRecordIds.add(row.id);
    });
  }

  // ... rest of logic
}
```

**New Code** (Temporary - Phase 1):
```javascript
// TEMPORARY FIX: Set all groups as 'work' type to avoid large activity_records query
// This will be removed in Phase 3 after is_idle_only column is added
const groupTypeById = {};
const groupIds = groups.map(g => g.id).filter(Boolean);
groupIds.forEach(id => {
  groupTypeById[id] = 'work';  // Temporarily classify all as work
});

// Add comment to each group for user visibility
console.log('[getUnassignedGroups] Using temporary classification (all groups as work) pending idle detection optimization');
```

**Trade-offs**:
- ❌ Group type filtering won't work (all groups shown as "work")
- ✅ Pagination works reliably for any number of groups
- ✅ Can be deployed immediately without database changes

#### 1.2 Add User-Facing Notice

**File**: `forge-app/static/main/src/components/UnassignedWork.js`

Add a temporary notice in the UI:

```javascript
// Add after line 20 (state declarations)
const [tempNoticeShown, setTempNoticeShown] = useState(
  !localStorage.getItem('unassignedWorkTempNoticeHidden')
);

// Add dismissible notice component before GroupAccordion rendering
{tempNoticeShown && (
  <div className="temp-notice">
    <p>
      ℹ️ Group type filtering is temporarily unavailable while we improve performance. 
      All groups are shown together. You can still assign or dismiss groups normally.
    </p>
    <button onClick={() => {
      setTempNoticeShown(false);
      localStorage.setItem('unassignedWorkTempNoticeHidden', 'true');
    }}>
      Dismiss
    </button>
  </div>
)}
```

#### 1.3 Deployment Steps

1. **Test Phase 1 changes locally**
   ```bash
   cd forge-app
   npm test -- sessionResolvers.test.js
   npm run build
   ```

2. **Deploy to staging**
   ```bash
   forge deploy -e staging
   ```

3. **Validate**
   - Test with account that has 200+ groups
   - Click "Load More" 20+ times
   - Verify no 503 errors in logs

4. **Deploy to production**
   ```bash
   forge deploy -e production
   ```

5. **Monitor**
   - Check error logs for "fetch failed" errors
   - Expected: Zero 503 errors on activity_records table

---

## Phase 2: Optimal Fix (Database-Side Classification)

### Problem It Solves
Permanently eliminates complex queries by precomputing group classification at creation time.

### Changes Required

#### 2.1 Database Migration

**File**: `supabase/migrations/20260513_add_is_idle_only_to_groups.sql`

```sql
-- ============================================================================
-- Migration: Add is_idle_only Column to unassigned_work_groups
-- Purpose: Precompute group type to avoid expensive activity_records queries
-- ============================================================================

-- 1. Add is_idle_only column
ALTER TABLE public.unassigned_work_groups
  ADD COLUMN IF NOT EXISTS is_idle_only BOOLEAN DEFAULT FALSE;

-- 2. Add index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_unassigned_groups_is_idle_only
  ON public.unassigned_work_groups (user_id, organization_id, is_idle_only)
  WHERE is_assigned = FALSE;

-- 3. Backfill existing groups (one-time operation)
-- This updates all existing groups based on their current members
UPDATE public.unassigned_work_groups uwg
SET is_idle_only = (
  SELECT COALESCE(
    BOOL_AND(
      COALESCE(ar.is_idle, FALSE)  -- NULL or FALSE = not idle
    ),
    FALSE
  )
  FROM public.unassigned_group_members ugm
  LEFT JOIN public.activity_records ar ON ar.id = ugm.activity_record_id
  WHERE ugm.group_id = uwg.id
    AND ugm.activity_record_id IS NOT NULL  -- Ignore legacy members
)
WHERE is_assigned = FALSE;  -- Only update unassigned groups

-- 4. Create trigger function to maintain is_idle_only on changes
CREATE OR REPLACE FUNCTION public.update_group_idle_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Update the parent group's is_idle_only flag
  UPDATE public.unassigned_work_groups
  SET is_idle_only = (
    SELECT COALESCE(
      BOOL_AND(
        COALESCE(ar.is_idle, FALSE)
      ),
      FALSE
    )
    FROM public.unassigned_group_members ugm
    LEFT JOIN public.activity_records ar ON ar.id = ugm.activity_record_id
    WHERE ugm.group_id = COALESCE(NEW.group_id, OLD.group_id)
      AND ugm.activity_record_id IS NOT NULL
  )
  WHERE id = COALESCE(NEW.group_id, OLD.group_id);
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- 5. Create trigger to maintain is_idle_only
DROP TRIGGER IF EXISTS maintain_group_idle_status ON public.unassigned_group_members;

CREATE TRIGGER maintain_group_idle_status
AFTER INSERT OR UPDATE OR DELETE ON public.unassigned_group_members
FOR EACH ROW
EXECUTE FUNCTION public.update_group_idle_status();

-- 6. Add comment for documentation
COMMENT ON COLUMN public.unassigned_work_groups.is_idle_only IS 
  'TRUE when all activity_record members have is_idle=TRUE. Updated via trigger on unassigned_group_members changes.';
```

#### 2.2 Update Clustering Service (AI Server)

**File**: `ai-server/src/services/clustering/unassigned-work-clustering-service.js`

Update the group creation logic to set `is_idle_only` immediately:

```javascript
// Find where groups are inserted (around line 200-300)
const { data: newGroup, error: groupError } = await supabase
  .from('unassigned_work_groups')
  .insert({
    user_id: userId,
    organization_id: organizationId,
    group_label: cluster.label,
    group_description: cluster.description,
    session_count: cluster.sessionIds.length,
    total_seconds: totalSeconds,
    confidence_level: cluster.confidence,
    recommended_action: recommendation.action,
    suggested_issue_key: recommendation.issueKey,
    recommendation_reason: recommendation.reason,
    // ✨ NEW: Compute is_idle_only at creation time
    is_idle_only: computeIsIdleOnly(cluster.activityRecords),
    is_assigned: false
  })
  .select('id')
  .single();

// Add helper function
function computeIsIdleOnly(activityRecords) {
  if (!activityRecords || activityRecords.length === 0) {
    return false;  // Empty group is not idle-only
  }
  
  // Check if ALL activity_records have is_idle = true
  return activityRecords.every(record => record.is_idle === true);
}
```

#### 2.3 Update `getUnassignedGroups` Resolver

**File**: `forge-app/src/resolvers/unassigned/sessionResolvers.js`

Replace the entire idle detection logic with a simple column read:

```javascript
export async function getUnassignedGroups(req) {
  const t0 = Date.now();
  try {
    const { limit: rawLimit, offset: rawOffset } = req.payload || {};
    
    // Validate pagination
    const limit = toSafeInteger(rawLimit, 10, 1, 50);
    const offset = toSafeInteger(rawOffset, 0, 0, 100000);

    const ctx = await initializeRequestContext(req, 'getUnassignedGroups');
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId } = ctx;

    const viabilityFilter = `&session_count=gt.0&total_seconds=gt.0`;

    // Get total count
    const countResult = await supabaseRequest(
      supabaseConfig,
      `unassigned_work_groups?user_id=eq.${userId}&organization_id=eq.${organization.id}&is_assigned=eq.false&is_dismissed=eq.false${viabilityFilter}&select=id`,
      { headers: { 'Prefer': 'count=exact' } }
    );
    const totalCount = ensureArray(countResult).length;

    // ✨ OPTIMIZED: Select is_idle_only directly from database
    const groups = await supabaseRequest(
      supabaseConfig,
      `unassigned_work_groups?user_id=eq.${userId}&organization_id=eq.${organization.id}&is_assigned=eq.false&is_dismissed=eq.false${viabilityFilter}&order=created_at.desc&limit=${limit}&offset=${offset}&select=id,group_label,group_description,session_count,total_seconds,confidence_level,recommended_action,suggested_issue_key,recommendation_reason,created_at,is_idle_only`
    );

    if (!groups || groups.length === 0) {
      return { success: true, groups: [], total_groups: totalCount, has_more: false };
    }

    console.log(`[getUnassignedGroups] Loaded ${groups.length} groups (offset: ${offset}, total: ${totalCount}) in ${Date.now() - t0}ms`);

    // ✨ NO MORE COMPLEX QUERIES - Just use the precomputed flag
    const enrichedGroups = groups.map((group) => {
      const totalTimeFormatted = formatDuration(group.total_seconds || 0);

      const recommendation = group.recommended_action ? {
        action: group.recommended_action,
        suggested_issue_key: group.suggested_issue_key || null,
        reason: group.recommendation_reason || ''
      } : null;

      return {
        id: group.id,
        label: group.group_label,
        description: group.group_description,
        session_count: group.session_count,
        total_time: totalTimeFormatted,
        total_seconds: group.total_seconds,
        confidence_level: group.confidence_level,
        recommendation: recommendation,
        created_at: group.created_at,
        // ✨ Use precomputed flag
        group_type: group.is_idle_only ? 'idle' : 'work'
      };
    });

    return {
      success: true,
      groups: enrichedGroups,
      has_more: offset + limit < totalCount,
      next_offset: offset + limit,
      total_groups: totalCount
    };
  } catch (error) {
    return handleResolverError(error, 'getUnassignedGroups');
  }
}
```

#### 2.4 Remove Temporary UI Notice

**File**: `forge-app/static/main/src/components/UnassignedWork.js`

Remove the temporary notice code added in Phase 1.

#### 2.5 Deployment Steps

1. **Apply database migration**
   ```bash
   cd supabase
   supabase db push
   ```

2. **Verify migration success**
   ```sql
   -- Check column exists
   SELECT column_name, data_type, is_nullable
   FROM information_schema.columns
   WHERE table_name = 'unassigned_work_groups'
     AND column_name = 'is_idle_only';

   -- Check trigger exists
   SELECT trigger_name, event_manipulation, event_object_table
   FROM information_schema.triggers
   WHERE trigger_name = 'maintain_group_idle_status';

   -- Verify backfill (should have mix of TRUE/FALSE)
   SELECT is_idle_only, COUNT(*) as count
   FROM unassigned_work_groups
   WHERE is_assigned = FALSE
   GROUP BY is_idle_only;
   ```

3. **Update AI server**
   ```bash
   cd ai-server
   npm test -- unassigned-work-clustering-service.test.js
   npm run deploy  # or restart service
   ```

4. **Update Forge app**
   ```bash
   cd forge-app
   npm test
   npm run build
   forge deploy -e staging
   ```

5. **Validate on staging**
   - Create new unassigned groups → verify `is_idle_only` is set correctly
   - Load More through 200+ groups → verify no 503 errors
   - Check group type filtering (Work/Idle tabs) → verify correct filtering

6. **Deploy to production**
   ```bash
   forge deploy -e production
   ```

7. **Monitor**
   - Query performance (should be <200ms per page)
   - Error rate (should be zero)
   - User feedback

---

## Phase 3: Cleanup

### Remove Phase 1 Temporary Code

1. Remove temporary UI notice code
2. Remove localStorage keys
3. Remove temporary comments
4. Update documentation

---

## Testing Strategy

### Unit Tests

#### 3.1 Test: Pagination Through Large Dataset

**File**: `forge-app/tests/resolvers/unassigned/sessionResolvers.test.js`

```javascript
describe('getUnassignedGroups - Large Dataset Pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should paginate through 200+ groups without errors', async () => {
    // Mock 250 groups in database
    const mockGroups = Array.from({ length: 10 }, (_, i) => ({
      id: `group-${i}`,
      group_label: `Group ${i}`,
      group_description: 'Test group',
      session_count: 5,
      total_seconds: 1800,
      confidence_level: 'high',
      is_idle_only: i % 3 === 0,  // Mix of idle and work
      created_at: new Date().toISOString()
    }));

    // Mock supabaseRequest to return paginated results
    require('../../utils/supabase').supabaseRequest
      .mockResolvedValueOnce([{ id: 'count' }])  // Count query (250 total)
      .mockResolvedValue(mockGroups);             // Groups query

    const result = await getUnassignedGroups({
      payload: { limit: 10, offset: 0 },
      context: { accountId: 'test-user', cloudId: 'test-org' }
    });

    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(10);
    expect(result.has_more).toBe(true);
    expect(result.total_groups).toBe(1);  // Based on count query mock
    
    // Verify NO activity_records query was made
    const supabaseCalls = require('../../utils/supabase').supabaseRequest.mock.calls;
    const activityRecordCalls = supabaseCalls.filter(call => 
      call[1]?.includes('activity_records')
    );
    expect(activityRecordCalls).toHaveLength(0);
  });

  it('should correctly classify groups as idle or work', async () => {
    const mockGroups = [
      { 
        id: 'idle-group',
        group_label: 'Idle Group',
        is_idle_only: true,
        session_count: 3,
        total_seconds: 900,
        created_at: new Date().toISOString()
      },
      { 
        id: 'work-group',
        group_label: 'Work Group',
        is_idle_only: false,
        session_count: 5,
        total_seconds: 1800,
        created_at: new Date().toISOString()
      }
    ];

    require('../../utils/supabase').supabaseRequest
      .mockResolvedValueOnce([{ id: '1' }, { id: '2' }])  // Count
      .mockResolvedValueOnce(mockGroups);                  // Groups

    const result = await getUnassignedGroups({
      payload: { limit: 10, offset: 0 },
      context: { accountId: 'test-user', cloudId: 'test-org' }
    });

    expect(result.success).toBe(true);
    expect(result.groups[0].group_type).toBe('idle');
    expect(result.groups[1].group_type).toBe('work');
  });
});
```

#### 3.2 Test: Database Trigger

**File**: `supabase/migrations/20260513_add_is_idle_only_to_groups.test.sql`

```sql
-- Test trigger functionality
BEGIN;

-- Setup: Create test user and org
INSERT INTO users (id, email, supabase_user_id) 
VALUES ('test-user-1', 'test@example.com', 'auth-test-1');

INSERT INTO organizations (id, jira_cloud_id, jira_base_url)
VALUES ('test-org-1', 'test-cloud-1', 'https://test.atlassian.net');

-- Create test group
INSERT INTO unassigned_work_groups (
  id, user_id, organization_id, group_label, session_count, total_seconds
) VALUES (
  'test-group-1', 'test-user-1', 'test-org-1', 'Test Group', 0, 0
);

-- Create activity records (2 idle, 1 work)
INSERT INTO activity_records (id, user_id, organization_id, is_idle, duration_seconds)
VALUES 
  ('ar-1', 'test-user-1', 'test-org-1', TRUE, 600),
  ('ar-2', 'test-user-1', 'test-org-1', TRUE, 600),
  ('ar-3', 'test-user-1', 'test-org-1', FALSE, 600);

-- Add members to group (all idle)
INSERT INTO unassigned_group_members (group_id, activity_record_id)
VALUES 
  ('test-group-1', 'ar-1'),
  ('test-group-1', 'ar-2');

-- TEST 1: Group should be idle-only (all members are idle)
SELECT is_idle_only, session_count 
FROM unassigned_work_groups 
WHERE id = 'test-group-1';
-- Expected: is_idle_only = TRUE

-- TEST 2: Add a work member → should become work group
INSERT INTO unassigned_group_members (group_id, activity_record_id)
VALUES ('test-group-1', 'ar-3');

SELECT is_idle_only 
FROM unassigned_work_groups 
WHERE id = 'test-group-1';
-- Expected: is_idle_only = FALSE

-- TEST 3: Remove work member → should become idle again
DELETE FROM unassigned_group_members 
WHERE group_id = 'test-group-1' AND activity_record_id = 'ar-3';

SELECT is_idle_only 
FROM unassigned_work_groups 
WHERE id = 'test-group-1';
-- Expected: is_idle_only = TRUE

ROLLBACK;
```

### Integration Tests

#### 3.3 Test: End-to-End Pagination

**File**: `forge-app/tests/integration/unassigned-work-pagination.test.js`

```javascript
describe('Unassigned Work Pagination - Integration', () => {
  let testUserId;
  let testOrgId;

  beforeAll(async () => {
    // Create test user and org
    testUserId = await createTestUser();
    testOrgId = await createTestOrganization();
    
    // Create 250 groups with varying member counts
    for (let i = 0; i < 250; i++) {
      const memberCount = Math.floor(Math.random() * 100) + 10;  // 10-110 members
      await createTestUnassignedGroup(testUserId, testOrgId, memberCount, {
        isIdleOnly: i % 3 === 0  // 1/3 idle, 2/3 work
      });
    }
  });

  afterAll(async () => {
    await cleanupTestData(testUserId, testOrgId);
  });

  it('should load all 250 groups without errors', async () => {
    let offset = 0;
    let totalLoaded = 0;
    const limit = 10;
    let hasMore = true;

    const startTime = Date.now();

    while (hasMore && offset < 300) {  // Safety limit
      const result = await invoke('getUnassignedGroups', { limit, offset });

      expect(result.success).toBe(true);
      expect(result.groups).toBeDefined();
      expect(result.groups.length).toBeLessThanOrEqual(limit);

      totalLoaded += result.groups.length;
      hasMore = result.has_more;
      offset = result.next_offset || (offset + limit);

      // Verify each group has required fields
      result.groups.forEach(group => {
        expect(group.id).toBeDefined();
        expect(group.label).toBeDefined();
        expect(group.group_type).toMatch(/^(idle|work)$/);
      });
    }

    const elapsed = Date.now() - startTime;

    expect(totalLoaded).toBe(250);
    expect(elapsed).toBeLessThan(60000);  // Should complete in <60s
    
    console.log(`✅ Loaded ${totalLoaded} groups in ${elapsed}ms`);
  });

  it('should correctly filter by group type', async () => {
    const allResult = await invoke('getUnassignedGroups', { 
      limit: 100, 
      offset: 0 
    });

    const idleCount = allResult.groups.filter(g => g.group_type === 'idle').length;
    const workCount = allResult.groups.filter(g => g.group_type === 'work').length;

    expect(idleCount).toBeGreaterThan(0);
    expect(workCount).toBeGreaterThan(0);
    expect(idleCount + workCount).toBe(allResult.groups.length);
  });
});
```

### Manual Testing Checklist

- [ ] Create test account with 250+ unassigned groups
- [ ] Verify Phase 1 deployment:
  - [ ] Load More works for all groups
  - [ ] No 503 errors in logs
  - [ ] Temporary notice shows in UI
- [ ] Verify Phase 2 deployment:
  - [ ] `is_idle_only` column exists in database
  - [ ] Trigger updates groups correctly
  - [ ] Load More still works for all groups
  - [ ] Group type filtering works (Work/Idle tabs)
  - [ ] No 503 errors
  - [ ] Query time <500ms per page
- [ ] Verify Phase 3 cleanup:
  - [ ] Temporary notice removed
  - [ ] No temporary code remains

---

## Monitoring & Metrics

### Pre-Fix Baseline
- **Error Rate**: ~30-40 503 errors per user session (200+ groups)
- **Success Rate**: ~35% for groups 70+
- **Query Time**: N/A (queries fail)

### Post-Fix Expected
- **Error Rate**: 0 503 errors
- **Success Rate**: 100% for all pagination
- **Query Time**: <200ms per page (Phase 2)

### Dashboards

1. **Error Rate Dashboard**
   ```sql
   -- Track "fetch failed" errors by table
   SELECT 
     DATE_TRUNC('hour', timestamp) as hour,
     COUNT(*) as error_count
   FROM logs
   WHERE message LIKE '%fetch failed%'
     AND table_name = 'activity_records'
   GROUP BY hour
   ORDER BY hour DESC;
   ```

2. **Pagination Success Rate**
   ```sql
   -- Track Load More operations
   SELECT 
     DATE_TRUNC('day', timestamp) as day,
     COUNT(*) as total_requests,
     SUM(CASE WHEN success = true THEN 1 ELSE 0 END) as successful,
     ROUND(100.0 * SUM(CASE WHEN success = true THEN 1 ELSE 0 END) / COUNT(*), 2) as success_rate
   FROM api_logs
   WHERE endpoint = 'getUnassignedGroups'
   GROUP BY day
   ORDER BY day DESC;
   ```

3. **Query Performance**
   ```sql
   -- Track query duration
   SELECT 
     PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) as p50,
     PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95,
     PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) as p99,
     MAX(duration_ms) as max
   FROM api_logs
   WHERE endpoint = 'getUnassignedGroups'
     AND timestamp > NOW() - INTERVAL '24 hours';
   ```

---

## Rollback Plan

### Phase 1 Rollback
If Phase 1 causes issues:
1. Revert `sessionResolvers.js` changes
2. Redeploy previous version
3. Investigate root cause before retry

### Phase 2 Rollback
If Phase 2 causes issues:
1. Revert resolver changes only (keep database migration)
2. Re-enable Phase 1 temporary code
3. Investigate trigger/column issues
4. Fix forward (don't drop column - it's safe to keep)

---

## Implementation Prompts

### Prompt 1: Implement Phase 1 (Immediate Mitigation)

```
Implement Phase 1 of the unassigned work load more fix:

1. Modify forge-app/src/resolvers/unassigned/sessionResolvers.js:
   - In the getUnassignedGroups function (around lines 211-270)
   - REMOVE the entire section that queries activity_records to determine group type
   - REPLACE with simple code that sets all groups to 'work' type
   - Add a comment explaining this is temporary (Phase 1)
   - Keep all other logic intact (pagination, viability filter, etc.)

2. Add a temporary user-facing notice in forge-app/static/main/src/components/UnassignedWork.js:
   - Add state for showing/hiding the notice
   - Add a dismissible notice component that explains group type filtering is temporarily unavailable
   - Store dismissal state in localStorage

3. Run tests to verify nothing broke:
   - npm test in forge-app
   - Build the app: npm run build

Follow the Spec-Driven Development Workflow from copilot-instructions.md.
Make surgical changes only - don't refactor unrelated code.
```

### Prompt 2: Create Phase 2 Database Migration

```
Create the Phase 2 database migration:

1. Create file: supabase/migrations/20260513_add_is_idle_only_to_groups.sql
2. Include:
   - ALTER TABLE to add is_idle_only column (BOOLEAN DEFAULT FALSE)
   - Index for efficient filtering
   - Backfill query to update existing groups
   - Trigger function update_group_idle_status()
   - Trigger maintain_group_idle_status on unassigned_group_members
   - Comments explaining the purpose

3. Follow the SQL migration conventions from copilot-instructions.md:
   - File naming: YYYYMMDD_description.sql
   - Add comment block at top explaining purpose
   - Every query should be idempotent (IF NOT EXISTS)

Reference the Phase 2.1 section of the plan for exact SQL.
```

### Prompt 3: Update AI Server Clustering Service

```
Update the AI server clustering service to set is_idle_only at creation time:

1. Find file: ai-server/src/services/clustering/unassigned-work-clustering-service.js
2. Locate where unassigned_work_groups are inserted into database
3. Add is_idle_only field to the insert
4. Create helper function computeIsIdleOnly(activityRecords) that:
   - Returns true only if ALL activity_records have is_idle = true
   - Returns false for empty array or mixed groups
5. Add unit test to verify is_idle_only is set correctly

Follow the Spec-Driven Development Workflow:
- Write test first
- Then implement
- Run: npm test in ai-server

Reference Phase 2.2 of the plan.
```

### Prompt 4: Update getUnassignedGroups Resolver (Phase 2)

```
Update the getUnassignedGroups resolver to use the new is_idle_only column:

1. File: forge-app/src/resolvers/unassigned/sessionResolvers.js
2. In getUnassignedGroups function:
   - Add is_idle_only to the select clause when querying unassigned_work_groups
   - REMOVE all the code that queries unassigned_group_members and activity_records
   - REMOVE the code that computes groupTypeById
   - In the enrichedGroups mapping, set group_type based on is_idle_only column:
     group_type: group.is_idle_only ? 'idle' : 'work'

3. Remove the temporary Phase 1 code and comments

4. Update tests in forge-app/tests/resolvers/unassigned/sessionResolvers.test.js:
   - Mock is_idle_only in test data
   - Verify no activity_records queries are made
   - Test both idle and work groups

Reference Phase 2.3 of the plan for exact code structure.
Follow test-first development: update tests before changing implementation.
```

### Prompt 5: Create Integration Tests

```
Create integration tests for the pagination fix:

1. File: forge-app/tests/integration/unassigned-work-pagination.test.js
2. Test scenarios:
   - Pagination through 250+ groups without errors
   - Verify group_type classification is correct
   - Measure performance (should complete in <60s)
   - Verify no 503 errors occur

3. Use the test structure from Phase 3.3 of the plan
4. Follow Jest conventions
5. Add helper functions:
   - createTestUser()
   - createTestOrganization()
   - createTestUnassignedGroup(userId, orgId, memberCount, options)
   - cleanupTestData(userId, orgId)

Run with: npm test -- unassigned-work-pagination.test.js
```

---

## Related Documents

- [UNASSIGNED_WORK_LOAD_MORE_503_ROOT_CAUSE_ANALYSIS.md](../docs/UNASSIGNED_WORK_LOAD_MORE_503_ROOT_CAUSE_ANALYSIS.md) - Detailed root cause analysis
- [IDLE_UNASSIGNED_SEPARATION_PLAN.md](./IDLE_UNASSIGNED_SEPARATION_PLAN.md) - Original idle/work separation feature
- [copilot-instructions.md](../.github/copilot-instructions.md) - Development workflow standards

---

## Sign-Off

**Author**: GitHub Copilot  
**Reviewed By**: _Pending_  
**Approved By**: _Pending_  
**Implementation Start Date**: _TBD_  
**Target Completion**: Within 1 week (Phase 1: 24h, Phase 2: 1 week)

---

**Document Version**: 1.0  
**Last Updated**: May 13, 2026

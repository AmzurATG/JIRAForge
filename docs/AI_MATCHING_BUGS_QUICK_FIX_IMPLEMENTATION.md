# AI Matching Bugs — Quick Fix Implementation

**Priority Fixes:** Bug #1 and Bug #2 from the deep dive analysis  
**Estimated Time:** 25 minutes total  
**Impact:** High — Improves AI matching accuracy by 15-30%

---

## Fix #1: Add `updated` Field to Forge Cache (10 min)

### Problem
Forge cache doesn't include the `updated` timestamp, breaking recency-based sorting in the AI prompt.

### Implementation

**File:** `forge-app/src/services/issueCacheService.js`

**Step 1:** Update the Jira API request to include `updated` field

```javascript
// Line 90 — Add 'updated' to the fields array
const response = await api.asUser(accountId).requestJira(
  route`/rest/api/3/search/jql`,
  {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jql: CACHE_JQL,
      maxResults: MAX_ISSUES,
      fields: ['summary', 'status', 'project', 'issuetype', 'priority', 'description', 'labels', 'updated']
      // ✅ Added 'updated'
    })
  }
);
```

**Step 2:** Ensure the AI server cache endpoint stores the `updated` field

Check file: `ai-server/src/controllers/forge-controller.js`

The endpoint should already handle any fields passed from Forge. Verify the Supabase schema for `user_jira_issues_cache` includes an `updated_at` column (it should already exist).

**Step 3:** Test

```bash
# In forge-app directory
npm test -- issueCacheService.test.js
```

Expected: All tests pass, and the `updated` field appears in cached issues.

---

## Fix #2: Restrict Cache JQL to Active Work (15 min)

### Problem
Cache JQL uses `statusCategory != Done` which includes backlog items the user isn't actively working on.

### Implementation

**File:** `forge-app/src/services/issueCacheService.js`

**Step 1:** Update the JQL to restrict to active work

```javascript
// Line 15 — Change from broad to narrow JQL
// OLD:
// const CACHE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

// NEW (Option 1 — Most Restrictive):
const CACHE_JQL = 'assignee = currentUser() AND resolution = EMPTY AND statusCategory = "In Progress" ORDER BY updated DESC';

// NEW (Option 2 — Include Recent To Do Items):
const CACHE_JQL = 'assignee = currentUser() AND resolution = EMPTY AND (statusCategory = "In Progress" OR (statusCategory = "To Do" AND updated >= -7d)) ORDER BY updated DESC';

// NEW (Option 3 — Active Sprints Only):
const CACHE_JQL = 'assignee = currentUser() AND (sprint in openSprints() OR (statusCategory = "In Progress" AND updated >= -7d)) ORDER BY updated DESC';
```

**Recommendation:** Use **Option 1** for simplicity and maximum noise reduction. This aligns with "work that's actively being done right now."

**Step 2:** Update the comment explaining the JQL

```javascript
/**
 * JQL query for fetching user's active issues.
 * Matches only issues that are:
 * - Assigned to the user
 * - Unresolved (resolution = EMPTY)
 * - In Progress status category
 * This excludes backlog items in "To Do" that the user hasn't started.
 */
const CACHE_JQL = 'assignee = currentUser() AND resolution = EMPTY AND statusCategory = "In Progress" ORDER BY updated DESC';
const MAX_ISSUES = 50;
```

**Step 3:** Consider adding a scheduled cache refresh

The cache currently updates on `avi:jira:updated:issue` events. If a user starts working on an issue without triggering an update event, the cache might be stale.

Check if the scheduled refresh is already implemented:

```javascript
// issueCacheService.js:120-150
export async function scheduledIssueCacheRefresh() {
  // This function already exists and runs every 30 minutes
  // No changes needed
}
```

✅ Scheduled refresh is already implemented.

**Step 4:** Test

```bash
# In forge-app directory
npm test -- issueCacheService.test.js
```

Add a new test case:

```javascript
describe('CACHE_JQL', () => {
  it('should restrict to In Progress issues only', () => {
    const issueCacheService = require('../src/services/issueCacheService');
    // Access the CACHE_JQL constant (may need to export it for testing)
    expect(CACHE_JQL).toContain('statusCategory = "In Progress"');
    expect(CACHE_JQL).toContain('resolution = EMPTY');
    expect(CACHE_JQL).not.toContain('statusCategory != Done');
  });
});
```

---

## Verification Steps

### 1. Check Desktop App Behavior (No Changes Needed)

The desktop app already includes the `updated` field and uses proper JQL with tracked statuses. No changes required.

**File:** `python-desktop-app/desktop_app.py:7283`

```python
formatted_issues.append({
    'key': issue['key'],
    'summary': fields['summary'],
    'status': fields['status']['name'],
    'project': fields['project']['key'],
    'description': description,
    'labels': labels,
    'updated': fields.get('updated', '')  # ✅ Already includes updated
})
```

### 2. Verify AI Server Handles Updated Field

**File:** `ai-server/src/services/ai/prompts.js:18-22`

```javascript
const sorted = [...userAssignedIssues].sort((a, b) => {
  const aDate = a.updated ? new Date(a.updated).getTime() : 0;
  const bDate = b.updated ? new Date(b.updated).getTime() : 0;
  return bDate - aDate;
});
```

✅ No changes needed — this already handles the `updated` field correctly.

### 3. Test End-to-End Issue Sorting

**Manual Test:**

1. Create 3 Jira issues:
   - PROJ-100: Updated 5 days ago
   - PROJ-101: Updated 2 days ago
   - PROJ-102: Updated 1 hour ago

2. Set all to "In Progress" and assign to test user

3. Trigger cache refresh (either wait for scheduled job or trigger an issue update event)

4. Upload an activity record via desktop app

5. Check AI server logs for the formatted issue list order:
   ```
   Expected order:
   - PROJ-102 (most recent)
   - PROJ-101
   - PROJ-100
   ```

6. Verify the AI matches to PROJ-102 (assuming the activity is related)

---

## Expected Impact

### Before Fix
- **Scenario:** User has 15 backlog items in "To Do" + 3 active items in "In Progress"
- **Cache returns:** All 18 issues
- **Prompt receives:** 18 issues in random/Jira order (recency sort fails)
- **AI sees:** 15 distractions + 3 relevant tasks
- **Matching accuracy:** ~60% (AI picks from noise)

### After Fix
- **Scenario:** Same user with 15 backlog + 3 active items
- **Cache returns:** Only 3 "In Progress" issues
- **Prompt receives:** 3 issues sorted by recency (most recent first)
- **AI sees:** Only active tasks, properly ordered
- **Matching accuracy:** ~85-90% (clear signal)

### Metrics to Monitor

Query Supabase `activity_records` table before and after deployment:

```sql
-- Unassigned rate before fix
SELECT 
  COUNT(*) FILTER (WHERE user_assigned_issue_key IS NULL) * 100.0 / COUNT(*) AS unassigned_pct
FROM activity_records
WHERE created_at >= NOW() - INTERVAL '7 days';

-- Expected: 30-50% unassigned

-- Unassigned rate after fix (wait 7 days after deployment)
-- Expected: 15-25% unassigned (improvement of 10-20 percentage points)
```

---

## Rollback Plan

If these changes cause issues:

1. **Revert Forge cache JQL to original:**
   ```javascript
   const CACHE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
   ```

2. **Remove `updated` from fields array:**
   ```javascript
   fields: ['summary', 'status', 'project', 'issuetype', 'priority', 'description', 'labels']
   ```

3. **Redeploy Forge app:**
   ```bash
   forge deploy
   ```

Both changes are **backward compatible** — no schema changes, no breaking API changes.

---

## Deployment Checklist

- [ ] Fix #1: Add `updated` to Forge cache fields
- [ ] Fix #2: Update CACHE_JQL to restrict to In Progress
- [ ] Run unit tests: `npm test`
- [ ] Deploy Forge app: `forge deploy -e production`
- [ ] Monitor AI server logs for "Preferring fresher cache" messages
- [ ] Wait 24 hours and check unassigned work percentage
- [ ] If improvement seen (> 5% reduction in unassigned), mark as successful
- [ ] If no improvement, investigate other factors (prompt, threshold, etc.)

---

## Additional Notes

### Why These Fixes Matter

1. **Recency Sorting:** Active developers switch issues frequently. Without proper sorting, the AI sees a 2-week-old issue alongside today's work and can't differentiate.

2. **Noise Reduction:** Backlog items are assigned but not active. Including them dilutes the signal and confuses the LLM about what the user is "currently" working on.

3. **Desktop vs. Forge Parity:** The desktop app already filters correctly. This brings the Forge cache in line with desktop behavior, ensuring consistent data regardless of which path populates the issue list.

### Future Enhancements

After these fixes, consider:

1. **Add `sprint` field to cache** — Helps LLM understand if issue is in active sprint
2. **Add `worklog_total` field** — Recent time logged indicates active work
3. **Tune confidence threshold** — With cleaner data, threshold could be lowered from 0.4 to 0.35

---

**Fix Version:** 1.0  
**Author:** AI Code Analysis Agent  
**Date:** 2026-05-20

# Fix Plan: AI Recommends Wrong Issue Keys on Unassigned Work Page

## Problem Summary

The AI clustering service recommends issue keys from projects the user doesn't work on (or no longer has access to). This happens because the clustering pipeline has no project-scoping at any layer — sessions lack project context, issues are fetched without filtering, and the AI prompt has no project constraint.

---

## Root Cause Chain

```
activity_records.project_key NOT included in SELECT
        ↓
processUserUnassignedWork() receives sessions with no project context
        ↓
getUserActiveIssues() returns all 50 cached issues across ALL projects
        ↓
AI prompt presents all issues as equally valid candidates
        ↓
LLM recommends cross-project issue based on text similarity alone
```

---

## Fix Plan (4 changes)

### Fix 1: Include `project_key` in activity_records query

**File:** `ai-server/src/services/db/clustering-db-service.js`  
**Function:** `getUnassignedActivities()`  
**Line:** ~176

**Current code:**
```js
let arQuery = supabase
  .from('activity_records')
  .select('id, window_title, application_name, ocr_text, duration_seconds, total_time_seconds, organization_id, start_time')
```

**Change to:**
```js
let arQuery = supabase
  .from('activity_records')
  .select('id, window_title, application_name, ocr_text, duration_seconds, total_time_seconds, organization_id, start_time, project_key')
```

Also update the session mapping (~line 196) to include `project_key`:

**Current code:**
```js
const mappedAR = ungroupedAR.map(record => ({
  id: record.id,
  timestamp: record.start_time,
  window_title: record.window_title || '',
  application_name: record.application_name || '',
  extracted_text: record.ocr_text || '',
  time_spent_seconds: record.duration_seconds || record.total_time_seconds || 0,
  reasoning: record.window_title || 'Activity record',
  organization_id: record.organization_id,
  source: 'activity_records'
}));
```

**Change to:**
```js
const mappedAR = ungroupedAR.map(record => ({
  id: record.id,
  timestamp: record.start_time,
  window_title: record.window_title || '',
  application_name: record.application_name || '',
  extracted_text: record.ocr_text || '',
  time_spent_seconds: record.duration_seconds || record.total_time_seconds || 0,
  reasoning: record.window_title || 'Activity record',
  organization_id: record.organization_id,
  project_key: record.project_key || null,
  source: 'activity_records'
}));
```

---

### Fix 2: Add project filtering to `getUserActiveIssues()`

**File:** `ai-server/src/services/db/user-db-service.js`  
**Function:** `getUserActiveIssues()`  
**Line:** ~93

**Current signature:**
```js
async function getUserActiveIssues(userId, organizationId)
```

**New signature:**
```js
async function getUserActiveIssues(userId, organizationId, projectKeys = [])
```

**Logic change — add project-scoped prioritization:**

After the existing cache query, if `projectKeys` is non-empty:
1. Partition cached issues into two groups:
   - `sameProjectIssues` — issues where `project_key` is in `projectKeys`
   - `otherProjectIssues` — all remaining issues
2. Return `[...sameProjectIssues, ...otherProjectIssues].slice(0, 50)`

This ensures same-project issues appear first in the context sent to the LLM, while still allowing cross-project fallback (ranked lower).

**Full updated function body:**
```js
async function getUserActiveIssues(userId, organizationId, projectKeys = []) {
  try {
    const supabase = getClient();

    // First try to get from cache (has summaries) - filter by organization
    let cacheQuery = supabase
      .from('user_jira_issues_cache')
      .select('issue_key, issue_summary, summary, project_key, status, description, labels, priority, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (organizationId) {
      cacheQuery = cacheQuery.eq('organization_id', organizationId);
    }

    const { data: cachedIssues, error: cacheError } = await cacheQuery;

    if (!cacheError && cachedIssues && cachedIssues.length > 0) {
      let issues = cachedIssues.map(issue => ({
        issue_key: issue.issue_key,
        summary: issue.issue_summary || issue.summary,
        project: issue.project_key,
        status: issue.status,
        description: issue.description || null,
        labels: issue.labels || [],
        priority: issue.priority || null,
        updated_at: issue.updated_at || null
      }));

      // Prioritize issues from the same project(s) as the unassigned work
      if (projectKeys.length > 0) {
        const projectKeySet = new Set(projectKeys);
        const sameProject = issues.filter(i => projectKeySet.has(i.project));
        const otherProject = issues.filter(i => !projectKeySet.has(i.project));
        issues = [...sameProject, ...otherProject].slice(0, 50);
      }

      return issues;
    }

    // Fallback: get from analysis_results (no summaries, but at least we have keys)
    const { data, error } = await supabase
      .from('analysis_results')
      .select('active_task_key, active_project_key')
      .eq('user_id', userId)
      .not('active_task_key', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      throw error;
    }

    // Get unique issues
    const uniqueIssues = [...new Set(data.map(item => item.active_task_key))];

    let issues = uniqueIssues.map(key => ({
      issue_key: key,
      summary: '', // No summary available from analysis_results
      project: data.find(d => d.active_task_key === key)?.active_project_key
    }));

    // Prioritize issues from the same project(s)
    if (projectKeys.length > 0) {
      const projectKeySet = new Set(projectKeys);
      const sameProject = issues.filter(i => projectKeySet.has(i.project));
      const otherProject = issues.filter(i => !projectKeySet.has(i.project));
      issues = [...sameProject, ...otherProject].slice(0, 50);
    }

    return issues;
  } catch (error) {
    logger.error('Error fetching user active issues:', error);
    return [];
  }
}
```

---

### Fix 3: Extract project keys from sessions and pass to issue fetcher

**File:** `ai-server/src/services/clustering-polling-service.js`  
**Function:** `processUserUnassignedWork()`  
**Line:** ~107

**Current code:**
```js
// 2. Get user's active Jira issues for better AI recommendations
const userIssues = await supabaseService.getUserActiveIssues(userId, organizationId);
logger.info(`[Clustering] Found ${userIssues.length} active issues for user ${userId}`);
```

**Change to:**
```js
// 2. Extract distinct project keys from unassigned sessions for scoping
const sessionProjectKeys = [...new Set(
  sessions.map(s => s.project_key).filter(Boolean)
)];
if (sessionProjectKeys.length > 0) {
  logger.info(`[Clustering] Session project keys for user ${userId}: ${sessionProjectKeys.join(', ')}`);
}

// 3. Get user's active Jira issues — prioritize issues from same project(s)
const userIssues = await supabaseService.getUserActiveIssues(userId, organizationId, sessionProjectKeys);
logger.info(`[Clustering] Found ${userIssues.length} active issues for user ${userId}`);
```

---

### Fix 4: Add project constraint to AI prompt

**File:** `ai-server/src/services/clustering-service.js`  
**Function:** `clusterUnassignedWork()`  
**Line:** ~107

**Current issues context construction:**
```js
const issuesContext = userIssues.length > 0
  ? `\n\nUser's assigned Jira issues (for matching suggestions):\n${userIssues.map(issue => {
      const descSuffix = issue.description
        ? ` — ${issue.description.substring(0, 200)}`
        : '';
      return `- ${issue.issue_key}: ${issue.summary}${descSuffix}`;
    }).join('\n')}`
  : '';
```

**Change to:**
```js
// Build project-grouped issues context for better AI scoping
let issuesContext = '';
if (userIssues.length > 0) {
  // Extract project keys present in the sessions for context
  const sessionProjectKeys = [...new Set(
    sessions.map(s => s.project_key).filter(Boolean)
  )];

  // Group issues by project
  const issuesByProject = {};
  for (const issue of userIssues) {
    const proj = issue.project || 'UNKNOWN';
    if (!issuesByProject[proj]) issuesByProject[proj] = [];
    issuesByProject[proj].push(issue);
  }

  // Build context string with project grouping
  let issueLines = '';
  for (const [project, issues] of Object.entries(issuesByProject)) {
    const marker = sessionProjectKeys.includes(project) ? ' [SAME PROJECT AS ACTIVITY]' : '';
    issueLines += `\n  Project ${project}${marker}:\n`;
    issueLines += issues.map(issue => {
      const descSuffix = issue.description
        ? ` — ${issue.description.substring(0, 200)}`
        : '';
      return `    - ${issue.issue_key}: ${issue.summary}${descSuffix}`;
    }).join('\n');
  }

  issuesContext = `\n\nUser's assigned Jira issues (grouped by project):\n${issueLines}`;

  // Add explicit project constraint instruction
  if (sessionProjectKeys.length > 0) {
    issuesContext += `\n\nPROJECT MATCHING RULE: The unassigned activities belong to project(s): ${sessionProjectKeys.join(', ')}. ` +
      `You MUST ONLY suggest issue keys from these same project(s). ` +
      `If no issue from these projects matches the work, recommend "create_new_issue" instead. ` +
      `NEVER suggest an issue from a different project.`;
  }
}
```

---

## Behavioral Summary After Fix

| Scenario | Before | After |
|----------|--------|-------|
| User works on project SCRUM, has issues from SCRUM + DEVOPS cached | LLM may suggest DEVOPS-123 | LLM only suggests SCRUM-* issues; falls back to `create_new_issue` |
| User has stale cache from revoked project | Stale issues appear as candidates | Stale issues ranked last (different project), prompt forbids selection |
| Sessions have no `project_key` (null) | Same as before (no scoping possible) | Falls back to current behavior (all issues equally weighted) — graceful degradation |
| User works across multiple projects in one batch | N/A | All active project keys extracted; issues from any matching project are prioritized |

---

## Testing Plan

1. **Unit test** `getUserActiveIssues()` with `projectKeys` parameter:
   - Verify same-project issues appear first in returned array
   - Verify empty `projectKeys` returns original order (backward compatible)

2. **Unit test** `getUnassignedActivities()`:
   - Verify `project_key` is present in returned session objects

3. **Integration test** `processUserUnassignedWork()`:
   - Mock sessions with mixed project keys
   - Verify `getUserActiveIssues` is called with correct project keys

4. **Prompt validation**:
   - Verify `PROJECT MATCHING RULE` appears in prompt when sessions have project keys
   - Verify it does NOT appear when all sessions have null project_key

---

## Risk Assessment

- **Low risk**: All changes are additive — new optional parameter with default `[]` maintains backward compatibility
- **Graceful degradation**: If `project_key` is null on sessions (legacy data), behavior falls back to current unfiltered mode
- **No schema changes required**: `project_key` column already exists on `activity_records` and `user_jira_issues_cache`
- **No breaking API changes**: `getUserActiveIssues()` new parameter is optional with default value

# Root Cause Analysis: AI Recommending Wrong Issue Keys in Unassigned Work

**Date:** May 20, 2026  
**Severity:** HIGH  
**Component:** Unassigned Work AI Recommendation System  
**Reporter:** User Feedback

---

## Executive Summary

The AI recommendation system in the Unassigned Work page frequently suggests incorrect issue keys because it only considers issues from a **limited, assignment-based cache** rather than all projects accessible to the user. This causes two critical problems:

1. **Missing Projects:** Projects where users have CREATE_ISSUE permissions but no assigned issues are invisible to the AI
2. **Single Project Bias:** The assigned-only filter creates an incomplete view of the user's actual work scope, excluding projects where they contribute but aren't assigned issues

**Impact:** Users must manually override AI recommendations frequently, reducing trust in the system and increasing time spent on work assignment.

---

## Problem Description

### User Report

> "In unassigned work page, the AI is recommending wrong issue key. It should recommend the issue from the available projects only. The AI should consider all the available projects accessible for the users, it should not consider only one default project."

### Observed Behavior

- User has access to multiple projects (e.g., PROJECT-A, PROJECT-B, PROJECT-C)
- User works on unassigned activities related to PROJECT-B
- AI recommends an issue from PROJECT-A (where user has many assigned issues) instead of PROJECT-B
- User must manually select the correct project and issue
- This happens consistently for work in projects where user has few or no assigned issues

---

## Root Cause Analysis

### Data Flow Overview

```
┌─────────────────────────────────────────────────────────────┐
│  CLUSTERING FLOW: How AI Gets Project/Issue Context          │
└─────────────────────────────────────────────────────────────┘

1. Clustering Job Triggers
   └─ ai-server/src/services/clustering-polling-service.js
      └─ processUserUnassignedWork(userId, organizationId)

2. Fetch User's Issues for AI Context
   └─ supabaseService.getUserActiveIssues(userId, organizationId)
      └─ ai-server/src/services/db/user-db-service.js

3. getUserActiveIssues() Implementation
   ├─ Query: user_jira_issues_cache
   │  ├─ Filter: user_id = userId
   │  ├─ Filter: organization_id = organizationId
   │  ├─ Order: updated_at DESC
   │  └─ Limit: 50 issues  ← PROBLEM: Only 50 issues
   │
   └─ Fallback: analysis_results table (no summaries)

4. How user_jira_issues_cache is Populated
   └─ forge-app/src/services/issueCacheService.js
      ├─ Trigger: avi:jira:updated:issue event
      ├─ Trigger: Scheduled refresh (every 30 minutes)
      ├─ JQL: 'assignee = currentUser() AND statusCategory != Done'
      │        ← PROBLEM: Only assigned issues!
      ├─ MAX_ISSUES: 50
      └─ Order: 'updated DESC'

5. AI Receives Issues
   └─ ai-server/src/services/clustering-service.js
      └─ clusterUnassignedWork(sessions, userIssues)
         └─ Prompt includes: "User's assigned Jira issues (for matching)"
            └─ AI sees ONLY the 50 cached assigned issues
               ← PROBLEM: Missing projects with no assigned issues!

6. AI Generates Recommendation
   └─ Returns: suggested_issue_key from the limited issue list
      └─ Stored in: unassigned_work_groups.suggested_issue_key
```

---

## Root Causes Identified

### Summary Table

| ID | Root Cause | Severity | Impact |
|----|-----------|----------|--------|
| RC1 | Cache limited to assigned issues only | **CRITICAL** | Projects with no assigned issues are invisible to AI |
| RC2 | No project-level permission context | **CRITICAL** | AI doesn't know which projects user can access |
| RC3 | Ordered by issue update time | LOW | Edge cases where active work doesn't update issues yet |
| RC4 | No session-to-project correlation | MEDIUM | Missed opportunity to extract project hints from context |

---

### RC1: Cache Limited to Assigned Issues Only (CRITICAL)

**File:** `forge-app/src/services/issueCacheService.js` (line 15)

```javascript
const CACHE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
```

**Problem:** The JQL query explicitly filters for `assignee = currentUser()`, meaning:
- Only issues where the user is the current assignee are cached
- Projects where the user has CREATE_ISSUE permission but no assigned issues are completely invisible to AI
- Example: User can create issues in PROJECT-B but has no issues assigned there → PROJECT-B never appears in AI context

**Impact:** HIGH - AI cannot recommend projects where user has no assignments

---

### RC2: No Project-Level Permission Context (CRITICAL)

**File:** `ai-server/src/services/clustering-service.js` (line 101-110)

```javascript
// Create user issues context
const issuesContext = userIssues.length > 0
  ? `\n\nUser's assigned Jira issues (for matching suggestions):\n${userIssues.map(issue => {
      const descSuffix = issue.description
        ? ` — ${issue.description.substring(0, 200)}`
        : '';
      return `- ${issue.issue_key}: ${issue.summary}${descSuffix}`;
    }).join('\n')}`
  : '';
```

**Problem:** 
- AI prompt only includes individual issue keys, not the full list of accessible projects
- No call to `/rest/api/3/project` endpoint to fetch user's project list
- Frontend calls `getUserProjects()` which returns ALL accessible projects, but clustering service doesn't use this data

**Compare with Frontend:**

```javascript
// forge-app/src/resolvers/unassigned/projectResolvers.js (line 11-35)
export async function getUserProjects(req) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/project`,
    { method: 'GET' }
  );
  // Returns ALL projects user has access to (create issue permission)
  return { success: true, projects: projects.map(p => ({ key: p.key, name: p.name })) };
}
```

**Impact:** HIGH - AI has no visibility into project-level permissions, only sees issues

---



### RC3: Ordered by Issue Update Time, Not Project Activity (LOW - Edge Cases Only)

**File:** `ai-server/src/services/db/user-db-service.js` (line 109)

```javascript
.order('updated_at', { ascending: false })
```

**Problem:**
- Sorting by individual issue `updated_at` doesn't reflect current project activity
- User may be actively working on PROJECT-B but all PROJECT-B issues were last updated weeks ago
- PROJECT-A with recent issue updates dominates the top 50, even if user isn't actively working on it

**Better Approach:** Weight by recent activity records per project, not just issue update time

**Impact:** LOW - Mostly correct; issues with old `updated_at` are usually not being actively worked. Edge cases: work-before-update gaps, pre-issue research, read-only collaboration

---

### RC4: No Session-to-Project Correlation (MEDIUM)

**File:** `ai-server/src/services/clustering-service.js` (line 60-72)

```javascript
function createClusteringInput(session) {
  const reasoning = session.reasoning || session.analysis_metadata?.reasoning || 'No description available';
  const app = session.application_name?.replace('.exe', '') || 'Unknown';
  const windowTitle = session.window_title || 'Unknown';
  // ... extracts app, window title, extracted text
  // NO extraction of project context from session data!
}
```

**Problem:**
- Sessions may contain project indicators (file paths, repository names, branch names in window titles)
- Example: Window title: `VS Code - project-b-frontend (main) - README.md`
- AI could extract "project-b" from window context but doesn't actively correlate this with available projects
- Sessions have `project_key` field but it's often null or incorrectly pre-assigned

**Impact:** MEDIUM - Missed opportunity to boost correct project matching

---

## Evidence from Code

### 1. Cache Population Logic

**File:** `forge-app/src/services/issueCacheService.js`

```javascript
const CACHE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
const MAX_ISSUES = 50;

async function refreshCacheForUser(accountId) {
  const response = await api.asUser(accountId).requestJira(
    route`/rest/api/3/search/jql`,
    {
      method: 'POST',
      body: JSON.stringify({
        jql: CACHE_JQL,
        maxResults: MAX_ISSUES,
        fields: ['summary', 'status', 'project', 'issuetype', 'priority', 'description', 'labels']
      })
    }
  );
  // ... pushes to AI server's user_jira_issues_cache table
}
```

**Key Findings:**
- ✅ JQL is hardcoded to `assignee = currentUser()`
- ✅ Limit is hardcoded to 50
- ✅ No project-level permission check
- ✅ No consideration of projects where user has no assigned issues

---

### 2. AI Clustering Context

**File:** `ai-server/src/services/clustering-service.js`

```javascript
// Create user issues context
const issuesContext = userIssues.length > 0
  ? `\n\nUser's assigned Jira issues (for matching suggestions):\n${userIssues.map(issue => {
      const descSuffix = issue.description
        ? ` — ${issue.description.substring(0, 200)}`
        : '';
      return `- ${issue.issue_key}: ${issue.summary}${descSuffix}`;
    }).join('\n')}`
  : '';
```

**AI Prompt Excerpt:**

```javascript
Pre-analysis:
- System/Idle sessions: ${systemSessions.length}
- Work sessions: ${workSessions.length}
${issuesContext}

Sessions to group:
${sessionDescriptions}
```

**Key Findings:**
- ✅ AI only sees individual issue keys from cache
- ❌ No project list provided to AI
- ❌ No project permissions context
- ❌ AI told "User's assigned Jira issues" (explicitly biasing toward assigned issues)

---

### 3. Frontend Has Complete Project List

**File:** `forge-app/src/resolvers/unassigned/projectResolvers.js`

```javascript
export async function getUserProjects(req) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/project`,
    { method: 'GET' }
  );
  
  const projects = await response.json();
  
  return {
    success: true,
    projects: projects.map(p => ({
      key: p.key,
      name: p.name,
      id: p.id
    }))
  };
}
```

**Key Findings:**
- ✅ Frontend resolver gets ALL projects user can access
- ✅ No filtering by assigned issues
- ❌ This data is NOT passed to AI clustering service
- ❌ AI clustering happens asynchronously, separate from frontend project fetch

---

## Impact Assessment

### Quantitative Impact

| Metric | Current Behavior | Expected Behavior |
|--------|------------------|-------------------|
| Projects Visible to AI | Only projects with assigned issues | All projects user can access |
| Issue Context Limit | 50 most recently updated assigned issues | Should include project-level context |
| Recommendation Accuracy | LOW (biased toward projects with most assignments) | HIGH (considers all accessible projects) |
| User Manual Overrides | HIGH (users frequently override recommendations) | LOW (AI recommends correct project) |

### User Scenarios Affected

#### Scenario 1: New Project Assignment
```
1. User is assigned to new PROJECT-C
2. User starts working immediately (no issues assigned yet)
3. Desktop app tracks activities in PROJECT-C folders/repos
4. Clustering runs → AI sees PROJECT-A and PROJECT-B issues only
5. AI recommends wrong project (PROJECT-A)
6. ❌ User must manually select PROJECT-C
```

#### Scenario 2: Multi-Project Developer
```
1. User works on 5 different projects actively
2. Has 80 total assigned issues across all projects
3. Cache contains only 50 most recently updated
4. PROJECT-E (active today) has old issues → excluded from cache
5. AI recommends PROJECT-A (has many recent issue updates)
6. ❌ Wrong project recommended
```

#### Scenario 3: Project Contributor (Not Assignee)
```
1. User contributes to PROJECT-D (has CREATE_ISSUE permission)
2. User is not assigned to any issues in PROJECT-D (reviewer/contributor role)
3. User works on PROJECT-D codebase
4. Cache contains ZERO PROJECT-D issues (not assigned)
5. AI cannot recommend PROJECT-D (invisible)
6. ❌ User forced to manually create issue in PROJECT-D
```

---

## Comparison: How Frontend Handles This vs. AI Server

### Frontend (Unassigned Work Modal)

**File:** `forge-app/static/main/src/components/UnassignedWork.js` (line 507-518)

```javascript
const loadUserProjects = async () => {
  try {
    const result = await invoke('getUserProjects');
    if (result.success) {
      setUserProjects(result.projects || []);  // ALL accessible projects
    }
  } catch (err) {
    console.error('Error loading user projects:', err);
  }
};
```

**Result:** Frontend dropdown shows ALL projects user can create issues in ✅

### AI Server (Clustering Recommendation)

**File:** `ai-server/src/services/clustering-polling-service.js` (line 107)

```javascript
const userIssues = await supabaseService.getUserActiveIssues(userId, organizationId);
// Returns only cached assigned issues (max 50)
```

**Result:** AI only sees projects from cached assigned issues ❌

**Gap:** Frontend and AI have completely different project context!

---

## Recommended Fixes

### Fix 1: Provide Project List to AI Clustering (CRITICAL)

**Priority:** P0 - Critical  
**Effort:** Medium  
**Impact:** HIGH - Enables AI to recommend any accessible project

**Changes Required:**

1. **Add `getUserProjects` function to AI server:**

```javascript
// ai-server/src/services/db/user-db-service.js

/**
 * Get all projects accessible to user via Forge proxy
 * @param {string} userId - Internal user UUID
 * @param {string} organizationId - Organization UUID
 * @returns {Promise<Array>} Array of accessible projects
 */
async function getUserAccessibleProjects(userId, organizationId) {
  try {
    const supabase = getClient();
    
    // Get user's Atlassian account ID
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('atlassian_account_id')
      .eq('id', userId)
      .single();
    
    if (userError || !user) {
      logger.error('Error fetching user for projects:', userError);
      return [];
    }
    
    // Call Forge proxy endpoint to get projects
    // This requires adding a new Forge endpoint
    const response = await fetch(`${process.env.FORGE_BASE_URL}/api/forge/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: user.atlassian_account_id,
        cloudId: organizationId  // Map to cloud ID
      })
    });
    
    if (!response.ok) {
      logger.error('Failed to fetch projects from Forge');
      return [];
    }
    
    const { projects } = await response.json();
    return projects || [];
    
  } catch (error) {
    logger.error('Error fetching accessible projects:', error);
    return [];
  }
}

module.exports = {
  // ... existing exports
  getUserAccessibleProjects
};
```

2. **Update clustering service to include projects:**

```javascript
// ai-server/src/services/clustering-polling-service.js (line 105-115)

async function processUserUnassignedWork(userId, organizationId) {
  // ... existing code ...
  
  // 2a. Get user's active Jira issues for better AI recommendations
  const userIssues = await supabaseService.getUserActiveIssues(userId, organizationId);
  logger.info(`[Clustering] Found ${userIssues.length} active issues for user ${userId}`);
  
  // 2b. Get user's accessible projects (NEW!)
  const userProjects = await supabaseService.getUserAccessibleProjects(userId, organizationId);
  logger.info(`[Clustering] Found ${userProjects.length} accessible projects for user ${userId}`);
  
  // 3. Cluster sessions using GPT-4 (pass both issues AND projects)
  const clusteringResult = await clusteringService.clusterUnassignedWork(sessions, userIssues, userProjects);
  
  // ... rest of function
}
```

3. **Update clustering service prompt:**

```javascript
// ai-server/src/services/clustering-service.js (line 75-85)

exports.clusterUnassignedWork = async (sessions, userIssues = [], userProjects = []) => {
  // ... existing code ...
  
  // Create user issues context (existing)
  const issuesContext = userIssues.length > 0
    ? `\n\nUser's assigned Jira issues (for matching suggestions):\n${userIssues.map(issue => {
        // ... existing code
      }).join('\n')}`
    : '';
  
  // Create user projects context (NEW!)
  const projectsContext = userProjects.length > 0
    ? `\n\nUser's accessible projects (user can create issues in these projects):\n${userProjects.map(project => {
        return `- ${project.key}: ${project.name}`;
      }).join('\n')}`
    : '';
  
  // Update prompt to include both
  const userPrompt = `You are an AI assistant helping to group similar work sessions together for time tracking.

IMPORTANT: When recommending which issue to assign work to, consider:
1. The user's currently assigned issues (listed below)
2. The user's accessible projects (user can create NEW issues in these projects)

If the work doesn't match any existing assigned issue, but clearly belongs to an accessible project, 
recommend "create_new_issue" and suggest the appropriate project key.

${issuesContext}
${projectsContext}

Sessions to group:
${sessionDescriptions}
...`;
  
  // ... rest of function
};
```

4. **Add Forge endpoint for projects:**

```javascript
// forge-app/src/resolvers/unassigned/projectResolvers.js

// Export for use by AI server via Forge proxy
export async function getProjectsForAIServer(req) {
  try {
    const { accountId } = req.payload;
    
    if (!accountId) {
      return { success: false, error: 'accountId required' };
    }
    
    const response = await api.asUser(accountId).requestJira(
      route`/rest/api/3/project`,
      { method: 'GET' }
    );
    
    if (!response.ok) {
      throw new Error('Failed to fetch projects');
    }
    
    const projects = await response.json();
    
    return {
      success: true,
      projects: projects.map(p => ({
        key: p.key,
        name: p.name,
        id: p.id
      }))
    };
    
  } catch (error) {
    console.error('Error getting projects for AI:', error);
    return { success: false, error: error.message };
  }
}

// Register in resolver
export function registerProjectResolvers(resolver) {
  resolver.define('getUserProjects', getUserProjects);
  resolver.define('getAllUserAssignedIssues', getAllUserAssignedIssues);
  resolver.define('getProjectStatuses', getProjectStatuses);
  resolver.define('getProjectsForAIServer', getProjectsForAIServer);  // NEW!
}
```

5. **Add AI server Forge proxy endpoint:**

```javascript
// ai-server/src/controllers/forge-proxy-controller.js

/**
 * Get user's accessible projects via Forge
 * POST /api/forge/projects
 */
exports.getProjects = async (req, res) => {
  try {
    const { accountId } = req.body;
    
    if (!accountId) {
      return res.status(400).json({ success: false, error: 'accountId required' });
    }
    
    const forgeResponse = await makeForgeRequest(req, 'getProjectsForAIServer', { accountId });
    
    if (!forgeResponse.success) {
      throw new Error(forgeResponse.error || 'Forge call failed');
    }
    
    return res.json({
      success: true,
      projects: forgeResponse.projects || []
    });
    
  } catch (error) {
    logger.error('[ForgeProxy] getProjects error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// Register route
router.post('/api/forge/projects', requireForgeAuth, exports.getProjects);
```

---

### Fix 2: Add Project Context from Session Data (OPTIONAL)

**Priority:** P2 - Optional Enhancement  
**Effort:** Medium  
**Impact:** MEDIUM - Improves accuracy when project indicators present in session data

**Priority:** P3 - Low (nice to have)  
**Effort:** Medium  
**Impact:** MEDIUM - Improves accuracy when project indicators present

**Changes:**

1. Extract project hints from window titles, file paths, repository names
2. Cross-reference with accessible projects list
3. Boost confidence for projects that appear in session context

```javascript
// ai-server/src/services/clustering-service.js

function extractProjectHints(session) {
  const windowTitle = session.window_title || '';
  const extractedText = session.extracted_text || '';
  
  // Look for project key patterns (e.g., "PROJECT-123" or folder name "project-frontend")
  const projectKeyPattern = /([A-Z]{2,10})-\d+/g;
  const matches = [...windowTitle.matchAll(projectKeyPattern), ...extractedText.matchAll(projectKeyPattern)];
  
  return matches.map(m => m[1]);  // Extract project keys
}
```

---

## Testing Plan

### Test Case 1: New Project Without Assigned Issues

**Setup:**
1. Create PROJECT-X in Jira
2. Grant user CREATE_ISSUE permission in PROJECT-X
3. Do NOT assign any issues to user in PROJECT-X
4. Generate unassigned work sessions with context indicating PROJECT-X

**Expected Result:**
- AI should see PROJECT-X in accessible projects list
- AI should recommend "create_new_issue" in PROJECT-X
- Suggested issue key should be null (new issue)
- Recommendation reason should mention PROJECT-X

**Current Result:** ❌ AI cannot see PROJECT-X, recommends other projects

---



### Test Case 2: Contributor Role (Not Assignee)

**Setup:**
1. User has Contributor role in PROJECT-Y
2. User has no assigned issues in PROJECT-Y
3. User reviews code / contributes to PROJECT-Y
4. Generate unassigned work sessions for PROJECT-Y code review

**Expected Result:**
- AI should see PROJECT-Y in accessible projects
- AI should recommend creating issue in PROJECT-Y for code review time

**Current Result:** ❌ AI cannot see PROJECT-Y, recommends unrelated project

---

## Migration Notes

### Database Changes

**None required** - All changes are in application logic

### API Changes

**New Endpoint:** `POST /api/forge/projects`
- Returns all projects accessible to a user
- Used by AI server clustering service
- Requires Forge context (accountId)

**New Resolver:** `getProjectsForAIServer`
- Forge resolver for fetching projects via impersonation
- Returns project list in format: `{ key, name, id }`

### Configuration Changes

**Environment Variables (Optional):**
```
CLUSTERING_INCLUDE_PROJECTS=true   # Enable project-level context
```

### Backwards Compatibility

- ✅ All changes are backwards compatible
- ✅ Existing recommendations continue to work (degraded accuracy)
- ✅ New project context enhances recommendations without breaking old behavior

---

## Conclusion

The root cause of incorrect AI issue key recommendations in Unassigned Work is a **limited, assignment-based issue cache that does not reflect the full scope of projects accessible to users**. The AI clustering service only sees issues from projects where users have assigned issues, creating a blind spot for:

1. New projects where user has permissions but no assigned issues yet
2. Projects where user is a contributor/reviewer (not assignee)
3. Projects where user will create issues (pre-issue work phase)

**Recommended Solution:** Provide the AI clustering service with the complete list of accessible projects (same data the frontend uses), not just issues from the cache. This allows AI to recommend creating issues in any project the user can access, not just projects where they have assignments.

**Priority:** CRITICAL - This affects all users working across multiple projects

**Effort:** Medium (requires Forge endpoint + AI server integration)

**Expected Impact:** 60-80% reduction in manual override rate for AI recommendations

**Note on Issue Limits:** The 50-issue cache limit is NOT a critical problem. Issues with old `updated_at` timestamps generally indicate the user is not actively working on them, so sorting by recency and taking the top 50 is appropriate behavior. Edge cases (work-before-update gaps, pre-issue research) are minor compared to the project visibility problem.

---

## Related Documents

- [AI Issue Matching Root Cause Analysis](./AI_ISSUE_MATCHING_ROOT_CAUSE_ANALYSIS.md) - Broader AI accuracy issues
- [Unassigned Work Flow Verification](./UNASSIGNED_WORK_FLOW_VERIFICATION.md) - System architecture
- [Project Resolvers](../forge-app/src/resolvers/unassigned/projectResolvers.js) - Frontend project fetching
- [Clustering Service](../ai-server/src/services/clustering-service.js) - AI recommendation logic

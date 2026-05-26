/**
 * Issue Query Service
 * Handles fetching and querying Jira issues
 */

import api, { route } from '@forge/api';
import { getUserAssignedIssues, getAllUserAssignedIssues, formatIssuesData, getNonSprintProjectKeys } from '../../utils/jira.js';
import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest } from '../../utils/supabase.js';
import { JQL_ACTIVE_STATUSES } from '../../config/constants.js';

/**
 * Get user's assigned Jira issues
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Object>} Issues data
 */
export async function getAssignedIssues(accountId) {
  const data = await getUserAssignedIssues(JQL_ACTIVE_STATUSES);

  // Format issues for AI analysis
  const issues = formatIssuesData(data.issues);

  return {
    issues,
    total: data.total || 0
  };
}

// Cap on the number of non-sprint project keys embedded in the `project in (...)`
// clause, to keep the JQL within Jira's practical length limits.
const MAX_NON_SPRINT_PROJECT_KEYS = 500;

/**
 * Build the My Focus JQL filter.
 *
 * My Focus shows:
 *   - software (sprint-based) projects → only issues in an OPEN SPRINT, and
 *   - service_desk / business (non-sprint) projects → all unresolved, non-Done issues.
 *
 * `sprint in openSprints()` is self-limiting: it only matches issues actually in an
 * open sprint, so software-project backlog (sprint unset) can never leak in via that
 * clause. The non-sprint clause is scoped to an explicit list of project keys, so
 * software-project backlog cannot leak in via that clause either. (This replaces the
 * old `sprint is EMPTY` predicate, which could not distinguish a genuinely sprint-less
 * project from a not-yet-sprinted software backlog item — the cause of the leak.)
 *
 * When there are no non-sprint projects (or the lookup failed and returned []), the
 * filter collapses to `(sprint in openSprints())`.
 *
 * The whole filter is wrapped in outer parens so the caller can safely AND it with
 * `assignee = currentUser()` without the OR detaching the assignee from one branch.
 *
 * @param {Array<string>} nonSprintProjectKeys - JSM/business project keys
 * @returns {string} JQL filter string
 */
export function buildMyFocusJql(nonSprintProjectKeys) {
  const sprintClause = '(sprint in openSprints())';

  const allKeys = nonSprintProjectKeys || [];
  const keys = allKeys.slice(0, MAX_NON_SPRINT_PROJECT_KEYS);
  if (keys.length === 0) {
    return sprintClause;
  }
  if (allKeys.length > MAX_NON_SPRINT_PROJECT_KEYS) {
    console.warn(`[buildMyFocusJql] Non-sprint project count (${allKeys.length}) exceeds cap; using first ${MAX_NON_SPRINT_PROJECT_KEYS}`);
  }

  const keyList = keys.map(k => `"${k}"`).join(',');
  const nonSprintClause = `(project in (${keyList}) AND resolution = EMPTY AND statusCategory != Done)`;
  return `(${sprintClause} OR ${nonSprintClause})`;
}

/**
 * Get user's active issues with time tracking data
 * Fetches assigned issues from Jira and enriches with time tracking from Supabase
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @returns {Promise<Object>} Issues with time tracking data
 */
export async function getActiveIssuesWithTime(accountId, cloudId) {
  // My Focus shows the user's current-sprint work plus active work from non-sprint
  // projects (JSM / business). We classify projects by type rather than using
  // `sprint is EMPTY`, because that predicate cannot tell a genuinely sprint-less
  // project's issue apart from a software-project backlog item not yet in a sprint —
  // which caused backlog items to leak into My Focus (and receive matched time).
  //
  // Resolve the non-sprint project keys and the Supabase config in parallel (both
  // independent), then build the JQL from the resolved keys.
  const [nonSprintProjectKeys, supabaseConfig] = await Promise.all([
    getNonSprintProjectKeys(),
    getSupabaseConfig(accountId)
  ]);
  const jiraData = await getAllUserAssignedIssues({
    jqlFilter: buildMyFocusJql(nonSprintProjectKeys)
  });
  console.log('[BACKEND] Jira returned issues:', jiraData.issues?.length || 0);
  const issues = jiraData.issues || [];
  if (!supabaseConfig) {
    // If Supabase not configured, return issues without time tracking
    return {
      issues: formatIssuesWithoutTime(issues),
      total: issues.length
    };
  }

  // Get or create organization first (multi-tenancy)
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    return {
      issues: formatIssuesWithoutTime(issues),
      total: issues.length
    };
  }

  // Get or create user record
  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  console.log(`[getActiveIssuesWithTime] RESOLVED IDs: accountId=${accountId}, userId=${userId}, organizationId=${organization.id}`);
  if (!userId) {
    console.log(`[getActiveIssuesWithTime] WARNING: No userId resolved for accountId=${accountId}`);
    return {
      issues: formatIssuesWithoutTime(issues),
      total: issues.length
    };
  }

  // Fetch time tracking data from activity_records (hybrid OCR / event-based tracking)
  // This is the primary source for desktop app interval-only mode
  const PAGE_SIZE = 1000;
  const allActivityRecords = [];
  let activityOffset = 0;

  // Build list of user IDs to query - start with the resolved userId
  let userIdsToQuery = [userId];

  // Check if this user has any activity records; if not, look for duplicate user records
  // This handles cases where Desktop App and Forge App created separate user records
  const firstPageCheck = await supabaseRequest(
    supabaseConfig,
    `activity_records?user_id=eq.${userId}&select=id&limit=1`
  );
  console.log(`[getActiveIssuesWithTime] Records for userId=${userId}: hasAny=${(firstPageCheck?.length || 0) > 0}`);

  if (!firstPageCheck || firstPageCheck.length === 0) {
    console.log(`[getActiveIssuesWithTime] No records for userId=${userId}, checking for other users in organization...`);
    
    // Find all users in this organization that have activity records
    const orgUsersWithRecords = await supabaseRequest(
      supabaseConfig,
      `activity_records?organization_id=eq.${organization.id}&select=user_id&limit=100`
    );
    
    if (orgUsersWithRecords && Array.isArray(orgUsersWithRecords)) {
      // Get unique user IDs that have activity records in this org
      const uniqueUserIds = [...new Set(orgUsersWithRecords.map(r => r.user_id))];
      console.log(`[getActiveIssuesWithTime] Found ${uniqueUserIds.length} users with activity in organization`);
      
      // Check if any of these users might be the same person (duplicate user records)
      // by looking up their atlassian_account_id
      for (const otherUserId of uniqueUserIds) {
        if (otherUserId === userId) continue;
        
        // Get the other user's email to compare
        const otherUser = await supabaseRequest(
          supabaseConfig,
          `users?id=eq.${otherUserId}&select=id,email,atlassian_account_id&limit=1`
        );
        
        // Get current user's email
        const currentUser = await supabaseRequest(
          supabaseConfig,
          `users?id=eq.${userId}&select=id,email,atlassian_account_id&limit=1`
        );
        
        if (otherUser?.[0] && currentUser?.[0]) {
          const otherEmail = otherUser[0].email;
          const currentEmail = currentUser[0].email;
          const otherAtlassianId = otherUser[0].atlassian_account_id;
          const currentAtlassianId = currentUser[0].atlassian_account_id;
          
          // Check if this is likely the same person (same email or related atlassian IDs)
          const sameEmail = otherEmail && currentEmail && otherEmail.toLowerCase() === currentEmail.toLowerCase();
          const relatedAtlassianId = otherAtlassianId && currentAtlassianId && 
            (otherAtlassianId.includes(currentAtlassianId) || currentAtlassianId.includes(otherAtlassianId));
          
          if (sameEmail || relatedAtlassianId) {
            console.log(`[getActiveIssuesWithTime] Found duplicate user: ${otherUserId} (email match: ${sameEmail}, atlassianId match: ${relatedAtlassianId})`);
            userIdsToQuery.push(otherUserId);
          }
        }
      }
    }
  }

  console.log(`[getActiveIssuesWithTime] Querying activity records for ${userIdsToQuery.length} user ID(s): ${userIdsToQuery.join(', ')}`);

  // Build the user filter - single user or multiple users
  const userFilter = userIdsToQuery.length === 1
    ? `user_id=eq.${userIdsToQuery[0]}`
    : `user_id=in.(${userIdsToQuery.join(',')})`;

  while (true) {
    // Fetch ALL activity records for productive work (pending, processing, or analyzed)
    // We include pending records so time shows up before AI processing completes
    const page = await supabaseRequest(
      supabaseConfig,
      `activity_records?${userFilter}&organization_id=eq.${organization.id}&status=in.(pending,processing,analyzed)&classification=in.(productive,unknown)&select=id,user_assigned_issue_key,total_time_seconds,duration_seconds,start_time,end_time,work_date,window_title,application_name,classification,project_key,approval_status,created_at&order=created_at.desc&limit=${PAGE_SIZE}&offset=${activityOffset}`
    );

    if (!page || !Array.isArray(page) || page.length === 0) {
      break;
    }

    allActivityRecords.push(...page);
    activityOffset += page.length;

    if (page.length < PAGE_SIZE) {
      break;
    }

    if (allActivityRecords.length > 50000) {
      console.warn(`[getActiveIssuesWithTime] Activity records safety limit reached`);
      break;
    }
  }

  console.log(`[getActiveIssuesWithTime] Fetched ${allActivityRecords.length} activity records`);

  // Aggregate time by issue key and build work sessions
  const timeByIssue = {};
  const lastWorkedByIssue = {};
  const sessionsByIssue = {};
  const pendingByIssue = {};

  // Process activity records
  if (allActivityRecords.length > 0) {
    // Build a set of valid issue keys from the user's current Jira issues
    // Used to validate issue keys extracted from window titles
    const validIssueKeys = new Set(issues.map(issue => issue.key));

    // Sort by start_time ascending to build sessions chronologically
    const sortedActivityData = allActivityRecords.sort((a, b) => {
      const timeA = a.start_time || a.created_at;
      const timeB = b.start_time || b.created_at;
      return new Date(timeA) - new Date(timeB);
    });

    sortedActivityData.forEach(entry => {
      // Use assigned issue key if available, otherwise try to extract from window title
      let issueKey = entry.user_assigned_issue_key;
      
      if (!issueKey && entry.window_title && entry.project_key) {
        // Fallback: extract issue key from window title (e.g. "PROJ-123 - Fix login bug - Jira")
        // Only match keys belonging to the user's current issues to avoid false positives
        const issueKeyPattern = new RegExp(`${entry.project_key}-\\d+`, 'g');
        const matches = entry.window_title.match(issueKeyPattern);
        if (matches) {
          // Prefer a match that is in the user's current issue list
          const validMatch = matches.find(m => validIssueKeys.has(m));
          if (validMatch) {
            issueKey = validMatch;
          }
        }
      }
      
      if (!issueKey) {
        // No explicit assignment and no issue key found in window title — skip.
        // This time will appear as unassigned and can be manually reassigned by the user.
        return;
      }

      // Initialize issue data
      if (!timeByIssue[issueKey]) {
        timeByIssue[issueKey] = 0;
        lastWorkedByIssue[issueKey] = entry.created_at;
        sessionsByIssue[issueKey] = [];
        pendingByIssue[issueKey] = { pendingCount: 0, pendingSeconds: 0 };
      }

      // timeByIssue (the "Time Tracked" column on All Issues / In Progress / Done)
      // counts only approved or no-approval-needed time.  Pending time is held in
      // pendingByIssue and surfaced via the Pending Review tab — approving (or
      // reassigning) a pending record promotes its time into timeByIssue on the
      // next refresh, so Approve all becomes a visibly meaningful action instead
      // of a silent no-op.
      const timeSpent = entry.total_time_seconds || entry.duration_seconds || 0;
      const isPending = entry.approval_status === 'pending_approval';

      if (isPending) {
        pendingByIssue[issueKey].pendingCount += 1;
        pendingByIssue[issueKey].pendingSeconds += timeSpent;
      } else {
        timeByIssue[issueKey] += timeSpent;
      }

      // Update last worked timestamp
      if (entry.created_at > lastWorkedByIssue[issueKey]) {
        lastWorkedByIssue[issueKey] = entry.created_at;
      }

      // Build sessions from activity records
      const startTime = entry.start_time ? new Date(entry.start_time) : new Date(entry.created_at);
      const endTime = entry.end_time ? new Date(entry.end_time) : new Date(startTime.getTime() + (timeSpent * 1000));

      // Check if this entry belongs to an existing session (within 10 minutes gap)
      const sessions = sessionsByIssue[issueKey];
      let addedToSession = false;

      if (sessions.length > 0) {
        const lastSession = sessions[sessions.length - 1];
        const timeSinceLastSession = startTime - new Date(lastSession.endTime);

        // If within 10 minutes AND same approval state, extend the session.
        // Splitting on approval-state change keeps the UI's "Approve this
        // session" action scoped to a single contiguous pending block.
        const sessionIsPending = lastSession.approvalStatus === 'pending_approval';
        if (timeSinceLastSession <= 10 * 60 * 1000 && sessionIsPending === isPending) {
          lastSession.endTime = endTime.toISOString();
          lastSession.duration += timeSpent;
          if (!lastSession.activityRecordIds) {
            lastSession.activityRecordIds = [];
          }
          lastSession.activityRecordIds.push(entry.id);
          addedToSession = true;
        }
      }

      // If not added to existing session, create new session
      if (!addedToSession) {
        const newSession = {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          duration: timeSpent,
          date: entry.work_date || startTime.toISOString().split('T')[0],
          activityRecordIds: [entry.id],
          screenshots: [],
          windowTitle: entry.window_title,
          applicationName: entry.application_name,
          approvalStatus: isPending ? 'pending_approval' : (entry.approval_status || null)
        };
        sessions.push(newSession);
      }
    });
  }

  // Log time distribution for debugging
  const issueKeysWithTime = Object.keys(timeByIssue);
  console.log(`[getActiveIssuesWithTime] Time tracked for ${issueKeysWithTime.length} issues: ${JSON.stringify(timeByIssue)}`);

  // Carryover: any key with tracked or pending time that isn't in the sprint
  // JQL result (e.g. closed-sprint or Done issues) still needs to appear in My
  // Focus.  Pre-approval this surfaces pending records so the user can act on
  // them; post-approval it keeps the row visible after pending->approved so a
  // just-approved Done/closed-sprint issue doesn't silently drop off the
  // dashboard the moment its last pending record was approved.
  //
  // Capped at 1000 — Jira Cloud's practical ceiling for an `issueKey in (...)`
  // JQL clause.  Keys past the cap are sorted out by most-recent activity, so
  // if it ever triggers we drop the oldest stragglers, not the freshest work.
  const CARRYOVER_BATCH_LIMIT = 1000;
  const issueKeysAlreadyFetched = new Set(issues.map(i => i.key));
  const carryoverKeys = Object.keys(pendingByIssue)
    .filter((k) =>
      !issueKeysAlreadyFetched.has(k) &&
      ((timeByIssue[k] || 0) > 0 || pendingByIssue[k].pendingCount > 0)
    )
    .sort((a, b) => {
      const tA = lastWorkedByIssue[a] || '';
      const tB = lastWorkedByIssue[b] || '';
      return tB.localeCompare(tA); // most-recent first
    })
    .slice(0, CARRYOVER_BATCH_LIMIT);

  if (carryoverKeys.length > 0) {
    console.log(`[getActiveIssuesWithTime] Fetching ${carryoverKeys.length} carryover issues with tracked or pending time: ${carryoverKeys.join(',')}`);
    try {
      const carryoverJql = `issueKey in (${carryoverKeys.map(k => `"${k}"`).join(',')})`;
      const carryoverResp = await api.asUser().requestJira(
        route`/rest/api/3/search/jql`,
        {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jql: carryoverJql,
            maxResults: carryoverKeys.length,
            fields: ['summary', 'status', 'project', 'issuetype', 'priority', 'updated']
          })
        }
      );
      if (carryoverResp.ok) {
        const carryoverData = await carryoverResp.json();
        for (const carryIssue of (carryoverData.issues || [])) {
          if (!issueKeysAlreadyFetched.has(carryIssue.key)) {
            issues.push(carryIssue);
            issueKeysAlreadyFetched.add(carryIssue.key);
          }
        }
      } else {
        console.warn(`[getActiveIssuesWithTime] Carryover fetch failed: ${carryoverResp.status}`);
      }
    } catch (err) {
      console.warn(`[getActiveIssuesWithTime] Carryover fetch error:`, err.message);
    }
  }

  // Enrich issues with time tracking data and sessions
  const enrichedIssues = issues.map(issue => {
    const pending = pendingByIssue[issue.key] || { pendingCount: 0, pendingSeconds: 0 };
    return {
      key: issue.key,
      summary: issue.fields.summary || '',
      status: issue.fields.status?.name || 'Unknown',
      statusCategory: issue.fields.status?.statusCategory?.key || 'new',
      priority: issue.fields.priority?.name || 'Medium',
      priorityIconUrl: issue.fields.priority?.iconUrl || '',
      issueType: issue.fields.issuetype?.name || 'Task',
      issueTypeIconUrl: issue.fields.issuetype?.iconUrl || '',
      projectKey: issue.fields.project?.key || '',
      timeTracked: timeByIssue[issue.key] || 0,
      lastWorkedOn: lastWorkedByIssue[issue.key] || null,
      sessions: sessionsByIssue[issue.key] || [],
      pendingApprovalCount: pending.pendingCount,
      pendingApprovalSeconds: pending.pendingSeconds,
      hasPendingApproval: pending.pendingCount > 0
    };
  });

  // Sort issues: In Progress first, then other statuses, then Done
  const statusOrder = (status) => {
    const lowerStatus = (status || '').toLowerCase();
    if (lowerStatus === 'in progress') return 0;
    if (lowerStatus === 'done') return 2;
    return 1; // All other statuses (To Do, etc.) in the middle
  };

  enrichedIssues.sort((a, b) => {
    const statusDiff = statusOrder(a.status) - statusOrder(b.status);
    if (statusDiff !== 0) return statusDiff;
    // Secondary sort by time tracked (most time first) within same status
    return (b.timeTracked || 0) - (a.timeTracked || 0);
  });

  return {
    issues: enrichedIssues,
    total: enrichedIssues.length
  };
}

/**
 * Format issues without time tracking data
 * @param {Array} issues - Raw Jira issues
 * @returns {Array} Formatted issues
 */
function formatIssuesWithoutTime(issues) {
  return issues.map(issue => ({
    key: issue.key,
    summary: issue.fields.summary || '',
    status: issue.fields.status?.name || 'Unknown',
    statusCategory: issue.fields.status?.statusCategory?.key || 'new',
    priority: issue.fields.priority?.name || 'Medium',
    priorityIconUrl: issue.fields.priority?.iconUrl || '',
    issueType: issue.fields.issuetype?.name || 'Task',
    issueTypeIconUrl: issue.fields.issuetype?.iconUrl || '',
    projectKey: issue.fields.project?.key || '',
    timeTracked: 0,
    lastWorkedOn: null
  }));
}
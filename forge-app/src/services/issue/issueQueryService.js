/**
 * Issue Query Service
 * Handles fetching and querying Jira issues
 */

import { getUserAssignedIssues, getAllUserAssignedIssues, formatIssuesData } from '../../utils/jira.js';
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

/**
 * Get user's active issues with time tracking data
 * Fetches assigned issues from Jira and enriches with time tracking from Supabase
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @returns {Promise<Object>} Issues with time tracking data
 */
export async function getActiveIssuesWithTime(accountId, cloudId) {
  // Fetch Jira issues and Supabase config in parallel (independent calls)
  // My Focus shows active sprint issues AND unresolved issues with no sprint assignment.
  // Sprint-based projects: active sprint issues appear, and sprint-less backlog issues can also match.
  // Non-sprint projects (JSM queues, Kanban boards) also contribute unresolved active issues via `sprint is EMPTY`.
  const [jiraData, supabaseConfig] = await Promise.all([
    getAllUserAssignedIssues({
      jqlFilter: '((sprint in openSprints()) OR (sprint is EMPTY AND resolution = EMPTY AND statusCategory != Done))'
    }),
    getSupabaseConfig(accountId)
  ]);
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
      `activity_records?${userFilter}&organization_id=eq.${organization.id}&status=in.(pending,processing,analyzed)&classification=in.(productive,unknown)&select=id,user_assigned_issue_key,total_time_seconds,duration_seconds,start_time,end_time,work_date,window_title,application_name,classification,project_key,created_at&order=created_at.desc&limit=${PAGE_SIZE}&offset=${activityOffset}`
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
      }

      // Add to total time (prefer total_time_seconds, fallback to duration_seconds)
      const timeSpent = entry.total_time_seconds || entry.duration_seconds || 0;
      timeByIssue[issueKey] += timeSpent;

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

        // If within 10 minutes, extend the session
        if (timeSinceLastSession <= 10 * 60 * 1000) {
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
          applicationName: entry.application_name
        };
        sessions.push(newSession);
      }
    });
  }

  // Log time distribution for debugging
  const issueKeysWithTime = Object.keys(timeByIssue);
  console.log(`[getActiveIssuesWithTime] Time tracked for ${issueKeysWithTime.length} issues: ${JSON.stringify(timeByIssue)}`);

  // Enrich issues with time tracking data and sessions
  const enrichedIssues = issues.map(issue => ({
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
    sessions: sessionsByIssue[issue.key] || []
  }));

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

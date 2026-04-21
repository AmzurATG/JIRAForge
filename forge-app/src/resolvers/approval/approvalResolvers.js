/**
 * Approval Resolvers — Human-in-the-loop review of AI-assigned time.
 *
 * When the AI server analyses an activity record and confidently picks a Jira
 * issue, the row is stamped `approval_status = 'pending_approval'` and blocked
 * from worklog sync (see worklogService.js). These resolvers power the
 * "Needs Review" panel: users explicitly approve, reassign, or create a new
 * issue for every pending session.
 *
 * Resolvers:
 *   - getPendingApprovalGroups        list + session-group pending rows
 *   - getPendingApprovalCount         cheap count for the sidebar badge
 *   - approveRecords                  approve as-is
 *   - reassignAndApproveRecords       move to a different existing issue
 *   - createIssueAndApproveRecords    create a brand-new issue then approve
 *   - bulkApproveByDateRange          approve everything in a date window
 */

import api, { route } from '@forge/api';
import { supabaseRequest } from '../../utils/supabase.js';
import { getIssueTransitions, transitionIssue } from '../../utils/jira.js';
import { formatDuration } from '../../utils/formatters.js';
import {
  isValidIssueKey,
  isValidProjectKey,
  isValidDate,
  sanitizeUUIDArray,
  toSafeInteger
} from '../../utils/validators.js';
import { initializeRequestContext, handleResolverError, ensureArray } from '../unassigned/helpers.js';

// ============================================================================
// Constants
// ============================================================================
const SESSION_GAP_MS = 10 * 60 * 1000; // 10 minutes — same as sessionResolvers

// Keep the per-call fetch ceiling generous but bounded. Large backlogs are
// paginated via `offset`; anything bigger than this in one call almost
// certainly means the user should use bulkApproveByDateRange instead.
const MAX_ROWS_PER_FETCH = 1000;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Pick the top-N most frequent values from an array, ignoring falsy entries.
 * Used to surface sample window titles / app names for each group card.
 */
function topFrequent(values, n) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value]) => value);
}

/**
 * Collapse a chronologically-sorted list of activity records into sessions.
 * Boundary rule: a new session starts whenever the next record either
 *   (a) has a different user_assigned_issue_key, or
 *   (b) begins more than SESSION_GAP_MS after the previous record ended.
 *
 * Mirrors sessionResolvers.getGroupWorkSessions so users see a consistent
 * grouping in both panels.
 */
function groupRecordsIntoSessions(records) {
  const sessions = [];

  for (const record of records) {
    const durationSeconds = record.duration_seconds || record.total_time_seconds || 0;
    const startMs = record.start_time ? new Date(record.start_time).getTime() : Date.now();
    const endMs = record.end_time
      ? new Date(record.end_time).getTime()
      : startMs + durationSeconds * 1000;

    const last = sessions[sessions.length - 1];
    const sameIssue = last && last.issueKey === record.user_assigned_issue_key;
    const withinGap = last && startMs - new Date(last.endTime).getTime() <= SESSION_GAP_MS;

    if (last && sameIssue && withinGap) {
      last.endTime = new Date(endMs).toISOString();
      last.totalSeconds += durationSeconds;
      last.sessionIds.push(record.id);
      last.recordCount += 1;
      if (record.window_title) last._windowTitles.push(record.window_title);
      if (record.application_name) last._apps.push(record.application_name);
      continue;
    }

    sessions.push({
      groupKey: `${record.user_assigned_issue_key || 'none'}__${new Date(startMs).toISOString()}`,
      issueKey: record.user_assigned_issue_key,
      projectKey: record.project_key,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      totalSeconds: durationSeconds,
      sessionIds: [record.id],
      recordCount: 1,
      workDate: record.work_date,
      aiConfidence: record.metadata?.confidenceScore ?? null,
      _windowTitles: record.window_title ? [record.window_title] : [],
      _apps: record.application_name ? [record.application_name] : []
    });
  }

  return sessions.map((s) => ({
    groupKey: s.groupKey,
    issueKey: s.issueKey,
    projectKey: s.projectKey,
    startTime: s.startTime,
    endTime: s.endTime,
    totalSeconds: s.totalSeconds,
    totalFormatted: formatDuration(s.totalSeconds),
    sessionIds: s.sessionIds,
    recordCount: s.recordCount,
    workDate: s.workDate,
    aiConfidence: s.aiConfidence,
    sampleWindowTitles: topFrequent(s._windowTitles, 3),
    sampleApps: topFrequent(s._apps, 2)
  }));
}

// ============================================================================
// Resolvers
// ============================================================================

/**
 * Fetch pending-approval records for the current user, grouped into sessions.
 *
 * Payload: { limit = 50, offset = 0, workDate?: 'YYYY-MM-DD', fromDate?, toDate? }
 *
 * NOTE on pagination: we page the raw rows (not groups) because the gap-based
 * grouping is stable only across a full day's worth of records. The UI uses
 * `hasMore` to know whether to show "Load more" — which re-queries from the
 * server with the next offset and merges client-side.
 */
export async function getPendingApprovalGroups(req) {
  try {
    const { limit: rawLimit, offset: rawOffset, workDate, fromDate, toDate } = req.payload || {};
    const limit = toSafeInteger(rawLimit, MAX_ROWS_PER_FETCH, 1, MAX_ROWS_PER_FETCH);
    const offset = toSafeInteger(rawOffset, 0, 0, 100000);

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;
    const { config: supabaseConfig, organization, userId } = ctx;

    // Build the date filter. Accept either a single workDate or a from/to range.
    let dateFilter = '';
    if (workDate && isValidDate(workDate)) {
      dateFilter = `&work_date=eq.${workDate}`;
    } else {
      if (fromDate && isValidDate(fromDate)) dateFilter += `&work_date=gte.${fromDate}`;
      if (toDate && isValidDate(toDate)) dateFilter += `&work_date=lte.${toDate}`;
    }

    const selectFields = [
      'id',
      'user_assigned_issue_key',
      'project_key',
      'duration_seconds',
      'total_time_seconds',
      'start_time',
      'end_time',
      'window_title',
      'application_name',
      'work_date',
      'metadata'
    ].join(',');

    // Use the partial index (idx_activity_approval_pending) implicitly — the
    // filters on user_id, organization_id, and approval_status match the
    // index predicate, so this lookup stays cheap even at scale.
    const rows = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}` +
      `&approval_status=eq.pending_approval${dateFilter}` +
      `&select=${selectFields}&order=start_time.asc&limit=${limit}&offset=${offset}`
    ));

    const groups = groupRecordsIntoSessions(rows);

    // Per-date counts for the UI date-picker. A cheap second hit that ignores
    // pagination; the partial index keeps it sub-millisecond in practice.
    const dateRows = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}` +
      `&approval_status=eq.pending_approval` +
      `&select=work_date&limit=5000`
    ));

    const pendingCountByDate = {};
    for (const r of dateRows) {
      if (!r.work_date) continue;
      pendingCountByDate[r.work_date] = (pendingCountByDate[r.work_date] || 0) + 1;
    }

    return {
      success: true,
      groups,
      hasMore: rows.length === limit,
      nextOffset: offset + rows.length,
      totalGroups: groups.length,
      pendingCountByDate
    };
  } catch (error) {
    return handleResolverError(error, 'fetching pending-approval groups');
  }
}

/**
 * Cheap count for the sidebar badge. Called on mount, polled every 60s while
 * the panel is mounted, and refreshed after every mutation.
 */
export async function getPendingApprovalCount(req) {
  try {
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;
    const { config: supabaseConfig, organization, userId } = ctx;

    // PostgREST doesn't expose HEAD via our thin wrapper, so SELECT id with a
    // generous limit + length is the simplest portable option. The partial
    // index keeps this cheap; realistic users never have >10k pending rows.
    const rows = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}` +
      `&approval_status=eq.pending_approval&select=id&limit=10000`
    ));

    return { success: true, count: rows.length };
  } catch (error) {
    return handleResolverError(error, 'counting pending approvals');
  }
}

/**
 * Approve one or more records AS-IS (no reassignment).
 *
 * The PATCH includes `&approval_status=eq.pending_approval` as a WHERE guard.
 * If the same row was already approved in another tab, zero rows match and
 * the call is a harmless no-op — no race, no double-update.
 */
export async function approveRecords(req) {
  try {
    const { sessionIds } = req.payload || {};
    const ids = sanitizeUUIDArray(sessionIds);
    if (ids.length === 0) {
      return { success: false, error: 'No valid session IDs provided' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;
    const { config: supabaseConfig, userId } = ctx;

    const now = new Date().toISOString();
    const updated = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${ids.join(',')})&user_id=eq.${userId}` +
      `&approval_status=eq.pending_approval`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: {
          approval_status: 'approved',
          approved_at: now,
          approved_by: userId,
          updated_at: now
        }
      }
    ));

    return { success: true, updated: updated.length, approved_at: now };
  } catch (error) {
    return handleResolverError(error, 'approving records');
  }
}

/**
 * Reassign the given records to a different existing issue and approve them.
 *
 * We capture the prior issue key(s) in `reassigned_from` for audit. If the
 * selection spans multiple original issue keys (uncommon but possible when
 * the user bulk-selects across cards) we fan out one PATCH per original key
 * so each row's `reassigned_from` stays accurate.
 */
export async function reassignAndApproveRecords(req) {
  try {
    const { sessionIds, newIssueKey, reason } = req.payload || {};

    const ids = sanitizeUUIDArray(sessionIds);
    if (ids.length === 0) {
      return { success: false, error: 'No valid session IDs provided' };
    }
    if (!newIssueKey || !isValidIssueKey(newIssueKey)) {
      return { success: false, error: 'Valid target issue key required' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;
    const { config: supabaseConfig, userId } = ctx;

    const newProjectKey = newIssueKey.split('-')[0];
    if (!isValidProjectKey(newProjectKey)) {
      return { success: false, error: 'Target issue key has an invalid project prefix' };
    }

    // Snapshot current keys so we can populate reassigned_from accurately.
    const existing = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${ids.join(',')})&user_id=eq.${userId}` +
      `&approval_status=eq.pending_approval&select=id,user_assigned_issue_key`
    ));

    if (existing.length === 0) {
      // Nothing to do — either already approved elsewhere or IDs don't belong
      // to this user. Idempotent return.
      return { success: true, updated: 0 };
    }

    // Group IDs by their current issue key so each PATCH carries a single,
    // accurate `reassigned_from` value.
    const byOrigin = new Map();
    for (const row of existing) {
      const key = row.user_assigned_issue_key || '';
      if (!byOrigin.has(key)) byOrigin.set(key, []);
      byOrigin.get(key).push(row.id);
    }

    const now = new Date().toISOString();
    let totalUpdated = 0;

    for (const [originalKey, originalIds] of byOrigin.entries()) {
      const updated = ensureArray(await supabaseRequest(
        supabaseConfig,
        `activity_records?id=in.(${originalIds.join(',')})&user_id=eq.${userId}` +
        `&approval_status=eq.pending_approval`,
        {
          method: 'PATCH',
          headers: { 'Prefer': 'return=representation' },
          body: {
            user_assigned_issue_key: newIssueKey,
            project_key: newProjectKey,
            reassigned_from: originalKey || null,
            reassigned_at: now,
            approval_status: 'approved',
            approved_at: now,
            approved_by: userId,
            approval_notes: reason || null,
            updated_at: now
          }
        }
      ));
      totalUpdated += updated.length;
    }

    return {
      success: true,
      updated: totalUpdated,
      new_issue_key: newIssueKey,
      approved_at: now
    };
  } catch (error) {
    return handleResolverError(error, 'reassigning and approving records');
  }
}

/**
 * Create a brand-new Jira issue, then reassign+approve the records to it.
 *
 * Mirrors the issue-creation flow from createIssueAndAssignSelection
 * (assignmentResolvers.js) — same fields, same transition best-effort, same
 * cache upsert, same created_issues_log insert — but skips the
 * unassigned_group_members bookkeeping because approval records are already
 * in activity_records directly.
 */
export async function createIssueAndApproveRecords(req) {
  try {
    const {
      sessionIds,
      issueSummary,
      issueDescription,
      projectKey,
      issueType,
      assigneeAccountId,
      assignToSelf,
      statusName
    } = req.payload || {};

    const ids = sanitizeUUIDArray(sessionIds);
    if (ids.length === 0) {
      return { success: false, error: 'No valid session IDs provided' };
    }
    if (!issueSummary) {
      return { success: false, error: 'Issue summary required' };
    }
    if (!projectKey || !isValidProjectKey(projectKey)) {
      return { success: false, error: 'Valid project key required' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;
    const { config: supabaseConfig, organization, userId, accountId } = ctx;

    // Pre-fetch the row totals so the auto-generated description is accurate
    // and the created_issues_log entry reflects real time.
    const rows = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${ids.join(',')})&user_id=eq.${userId}` +
      `&approval_status=eq.pending_approval&select=id,duration_seconds,total_time_seconds`
    ));

    if (rows.length === 0) {
      return { success: true, updated: 0, message: 'No pending records to approve' };
    }

    const totalSeconds = rows.reduce(
      (sum, r) => sum + (r.duration_seconds || r.total_time_seconds || 0),
      0
    );

    const issueFields = {
      project: { key: projectKey },
      summary: issueSummary,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: issueDescription ||
                  `Work performed across ${rows.length} record(s). ` +
                  `Total time: ${formatDuration(totalSeconds)}. ` +
                  `Created from time-tracking review.`
              }
            ]
          }
        ]
      },
      issuetype: { name: issueType || 'Task' },
      labels: ['time-tracked', 'approval-created']
    };

    if (assigneeAccountId) {
      issueFields.assignee = { accountId: assigneeAccountId };
    } else if (assignToSelf !== false) {
      issueFields.assignee = { accountId };
    }

    const createResp = await api.asUser().requestJira(
      route`/rest/api/3/issue`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: issueFields })
      }
    );

    if (!createResp.ok) {
      const errorText = await createResp.text();
      throw new Error(`Failed to create issue: ${errorText}`);
    }

    const newIssue = await createResp.json();
    const newIssueKey = newIssue.key;

    // Best-effort transition — same pattern as createIssueAndAssignSelection.
    if (statusName) {
      try {
        const transitions = await getIssueTransitions(newIssueKey);
        const target = transitions.find(
          (t) => t.to?.name?.toLowerCase() === statusName.toLowerCase()
        );
        if (target) {
          await transitionIssue(newIssueKey, target.id);
        }
      } catch (transitionError) {
        console.warn(`[createIssueAndApproveRecords] Status transition failed:`, transitionError.message);
      }
    }

    const now = new Date().toISOString();

    // Point the records at the new issue AND approve them in one PATCH.
    const updated = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${ids.join(',')})&user_id=eq.${userId}` +
      `&approval_status=eq.pending_approval`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: {
          user_assigned_issue_key: newIssueKey,
          project_key: projectKey,
          reassigned_at: now,
          approval_status: 'approved',
          approved_at: now,
          approved_by: userId,
          updated_at: now
        }
      }
    ));

    // Cache upsert so the new issue appears in pickers immediately.
    await supabaseRequest(
      supabaseConfig,
      'user_jira_issues_cache',
      {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: {
          user_id: userId,
          organization_id: organization.id,
          issue_key: newIssueKey,
          summary: issueSummary,
          status: 'To Do',
          project_key: projectKey
        }
      }
    );

    // Audit trail — same table the Unassigned Work "create issue" flow writes to.
    await supabaseRequest(
      supabaseConfig,
      'created_issues_log',
      {
        method: 'POST',
        body: {
          user_id: userId,
          organization_id: organization.id,
          issue_key: newIssueKey,
          issue_summary: issueSummary,
          session_count: rows.length,
          total_time_seconds: totalSeconds
        }
      }
    );

    return {
      success: true,
      issue_key: newIssueKey,
      issue_id: newIssue.id,
      updated: updated.length,
      total_seconds: totalSeconds,
      approved_at: now
    };
  } catch (error) {
    return handleResolverError(error, 'creating issue and approving records');
  }
}

/**
 * Bulk approve every pending-approval record within a date window.
 * Designed for users returning from leave with days of backlog.
 */
export async function bulkApproveByDateRange(req) {
  try {
    const { fromDate, toDate } = req.payload || {};
    if (!fromDate || !isValidDate(fromDate)) {
      return { success: false, error: 'Valid fromDate (YYYY-MM-DD) required' };
    }
    if (!toDate || !isValidDate(toDate)) {
      return { success: false, error: 'Valid toDate (YYYY-MM-DD) required' };
    }
    if (fromDate > toDate) {
      return { success: false, error: 'fromDate must be <= toDate' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;
    const { config: supabaseConfig, organization, userId } = ctx;

    const now = new Date().toISOString();
    const updated = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}` +
      `&approval_status=eq.pending_approval` +
      `&work_date=gte.${fromDate}&work_date=lte.${toDate}`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: {
          approval_status: 'approved',
          approved_at: now,
          approved_by: userId,
          approval_notes: 'Bulk approved by date range',
          updated_at: now
        }
      }
    ));

    return {
      success: true,
      updated: updated.length,
      from_date: fromDate,
      to_date: toDate,
      approved_at: now
    };
  } catch (error) {
    return handleResolverError(error, 'bulk approving by date range');
  }
}

/**
 * Return the individual activity records behind a set of session IDs.
 * Used by the "Details" expander to show per-record rows and enable
 * partial approval. Scoped to the caller's user_id so RLS cannot be
 * bypassed even if a foreign id leaked in.
 */
export async function getPendingApprovalRecords(req) {
  try {
    const { sessionIds } = req.payload || {};
    const ids = sanitizeUUIDArray(sessionIds);
    if (ids.length === 0) {
      return { success: true, records: [] };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;
    const { config: supabaseConfig, userId } = ctx;

    const rows = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${ids.join(',')})&user_id=eq.${userId}` +
      `&approval_status=eq.pending_approval` +
      `&select=id,start_time,end_time,duration_seconds,window_title,application_name,user_assigned_issue_key` +
      `&order=start_time.asc`
    ));

    return { success: true, records: rows };
  } catch (error) {
    return handleResolverError(error, 'loading pending approval records');
  }
}

/**
 * Register approval resolvers on the Forge Resolver instance.
 */
export function registerApprovalResolvers(resolver) {
  resolver.define('getPendingApprovalGroups', getPendingApprovalGroups);
  resolver.define('getPendingApprovalCount', getPendingApprovalCount);
  resolver.define('getPendingApprovalRecords', getPendingApprovalRecords);
  resolver.define('approveRecords', approveRecords);
  resolver.define('reassignAndApproveRecords', reassignAndApproveRecords);
  resolver.define('createIssueAndApproveRecords', createIssueAndApproveRecords);
  resolver.define('bulkApproveByDateRange', bulkApproveByDateRange);
}

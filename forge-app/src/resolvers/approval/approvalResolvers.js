/**
 * Approval Resolvers — Human-in-the-loop review of AI-assigned time.
 *
 * When the AI server analyses an activity record and confidently picks a Jira
 * issue, the row is stamped `approval_status = 'pending_approval'` and blocked
 * from worklog sync (see worklogService.js). Approval is surfaced inline in
 * the My Focus tab — these resolvers power its per-session actions.
 *
 * Resolvers:
 *   - approveRecords                  approve as-is
 *   - reassignAndApproveRecords       move to a different existing issue
 *   - createIssueAndApproveRecords    create a brand-new issue then approve
 *   - getPendingApprovalRecords       load per-record detail behind a session
 *   - getPendingApprovalForIssue      list pending sessions for a single issue
 */

import api, { route } from '@forge/api';
import { supabaseRequest } from '../../utils/supabase.js';
import { getIssueTransitions, transitionIssue } from '../../utils/jira.js';
import { formatDuration } from '../../utils/formatters.js';
import {
  isValidIssueKey,
  isValidProjectKey,
  sanitizeUUIDArray
} from '../../utils/validators.js';
import { initializeRequestContext, handleResolverError, ensureArray } from '../unassigned/helpers.js';
// REMOVABLE: AI accuracy tracking layer.
import { recordAccuracyEvents, isAccuracyTrackingEnabled } from '../../services/accuracy/accuracyTracking.js';

// ============================================================================
// Resolvers
// ============================================================================

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
    const { config: supabaseConfig, organization, userId } = ctx;

    // REMOVABLE: pre-fetch context for AI accuracy events.  Skipped entirely
    // when the layer is disabled so production cost is zero.
    let priorRows = [];
    if (isAccuracyTrackingEnabled()) {
      priorRows = ensureArray(await supabaseRequest(
        supabaseConfig,
        `activity_records?id=in.(${ids.join(',')})&user_id=eq.${userId}` +
        `&approval_status=eq.pending_approval` +
        `&select=id,user_assigned_issue_key,duration_seconds,total_time_seconds,window_title,application_name,classification,metadata`
      ));
    }

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

    // REMOVABLE: emit one accuracy event per approved record.  AI was right
    // here — same key in/out.
    if (priorRows.length > 0 && updated.length > 0) {
      const updatedIds = new Set(updated.map(r => r.id));
      const events = priorRows
        .filter(r => updatedIds.has(r.id) && r.user_assigned_issue_key)
        .map(r => ({
          organizationId: organization.id,
          userId,
          eventType: 'approved_as_is',
          activityRecordId: r.id,
          aiSuggestedIssueKey: r.user_assigned_issue_key,
          aiConfidenceScore: r.metadata?.confidenceScore ?? null,
          finalIssueKey: r.user_assigned_issue_key,
          durationSeconds: r.duration_seconds || r.total_time_seconds || 0,
          windowTitle: r.window_title,
          applicationName: r.application_name,
          classification: r.classification
        }));
      await recordAccuracyEvents(supabaseConfig, events);
    }

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
    const { config: supabaseConfig, organization, userId } = ctx;

    const newProjectKey = newIssueKey.split('-')[0];
    if (!isValidProjectKey(newProjectKey)) {
      return { success: false, error: 'Target issue key has an invalid project prefix' };
    }

    // Snapshot current keys so we can populate reassigned_from accurately.
    // Extra columns (window_title, application_name, classification, metadata,
    // duration) are pulled in only when accuracy tracking is enabled, but
    // querying them unconditionally keeps the SQL simple — the cost is one
    // extra column per row, which is negligible.
    const existing = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${ids.join(',')})&user_id=eq.${userId}` +
      `&approval_status=eq.pending_approval` +
      `&select=id,user_assigned_issue_key,duration_seconds,total_time_seconds,window_title,application_name,classification,metadata`
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
    const successfullyUpdatedIds = new Set();

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
      for (const row of updated) successfullyUpdatedIds.add(row.id);
    }

    // REMOVABLE: emit one accuracy event per reassigned record.  AI was wrong
    // here — capture both keys so the dashboard can surface the wrong→right pairs.
    if (successfullyUpdatedIds.size > 0) {
      const events = existing
        .filter(r => successfullyUpdatedIds.has(r.id))
        .map(r => ({
          organizationId: organization.id,
          userId,
          eventType: 'reassigned',
          activityRecordId: r.id,
          aiSuggestedIssueKey: r.user_assigned_issue_key || null,
          aiConfidenceScore: r.metadata?.confidenceScore ?? null,
          finalIssueKey: newIssueKey,
          durationSeconds: r.duration_seconds || r.total_time_seconds || 0,
          windowTitle: r.window_title,
          applicationName: r.application_name,
          classification: r.classification,
          metadata: reason ? { reason } : null
        }));
      await recordAccuracyEvents(supabaseConfig, events);
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
    // Extra columns (window_title, application_name, classification, metadata,
    // user_assigned_issue_key) feed the AI accuracy event log; query is a
    // simple SELECT either way, so we always pull them.
    const rows = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${ids.join(',')})&user_id=eq.${userId}` +
      `&approval_status=eq.pending_approval` +
      `&select=id,user_assigned_issue_key,duration_seconds,total_time_seconds,window_title,application_name,classification,metadata`
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

    // REMOVABLE: emit one accuracy event per record.  Treat creating a brand-
    // new issue as a "reassigned" event — the AI's suggestion was wrong enough
    // that the user spawned a new issue rather than picking an existing one.
    if (updated.length > 0) {
      const updatedIds = new Set(updated.map(r => r.id));
      const events = rows
        .filter(r => updatedIds.has(r.id))
        .map(r => ({
          organizationId: organization.id,
          userId,
          eventType: 'reassigned',
          activityRecordId: r.id,
          aiSuggestedIssueKey: r.user_assigned_issue_key || null,
          aiConfidenceScore: r.metadata?.confidenceScore ?? null,
          finalIssueKey: newIssueKey,
          durationSeconds: r.duration_seconds || r.total_time_seconds || 0,
          windowTitle: r.window_title,
          applicationName: r.application_name,
          classification: r.classification,
          metadata: { reassign_reason: 'created_new_issue' }
        }));
      await recordAccuracyEvents(supabaseConfig, events);
    }

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
 * Return pending-approval sessions for a single Jira issue.
 * Powers the issue-panel approval UI. Groups the user's pending
 * activity_records for this issue into sessions using the same 10-minute-gap
 * algorithm used elsewhere, and returns enough detail to render per-session
 * Approve buttons.
 */
export async function getPendingApprovalForIssue(req) {
  try {
    const { issueKey } = req.payload || {};
    if (!issueKey || !isValidIssueKey(issueKey)) {
      return { success: false, error: 'Valid issue key required' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;
    const { config: supabaseConfig, userId } = ctx;

    const rows = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}` +
      `&user_assigned_issue_key=eq.${issueKey}` +
      `&approval_status=eq.pending_approval` +
      `&select=id,start_time,end_time,duration_seconds,window_title,application_name,work_date,metadata` +
      `&order=start_time.asc&limit=1000`
    ));

    const SESSION_GAP_MS = 10 * 60 * 1000;
    const sessions = [];
    let current = null;

    for (const r of rows) {
      const start = new Date(r.start_time).getTime();
      const end = new Date(r.end_time || r.start_time).getTime();
      const duration = Number.isFinite(r.duration_seconds)
        ? r.duration_seconds
        : Math.max(0, Math.round((end - start) / 1000));

      if (!current || start - current.endMs > SESSION_GAP_MS) {
        current = {
          sessionIds: [r.id],
          startTime: r.start_time,
          endTime: r.end_time || r.start_time,
          endMs: end,
          totalSeconds: duration,
          recordCount: 1,
          workDate: r.work_date || null,
          windowTitles: r.window_title ? [r.window_title] : [],
          applications: r.application_name ? [r.application_name] : [],
          confidence: r.metadata?.confidenceScore ?? null
        };
        sessions.push(current);
      } else {
        current.sessionIds.push(r.id);
        current.endTime = r.end_time || r.start_time;
        current.endMs = end;
        current.totalSeconds += duration;
        current.recordCount += 1;
        if (r.window_title && !current.windowTitles.includes(r.window_title)) {
          current.windowTitles.push(r.window_title);
        }
        if (r.application_name && !current.applications.includes(r.application_name)) {
          current.applications.push(r.application_name);
        }
      }
    }

    const shaped = sessions.map(({ endMs, ...s }) => ({
      ...s,
      windowTitles: s.windowTitles.slice(0, 2),
      applications: s.applications.slice(0, 2)
    }));

    const totalSeconds = shaped.reduce((sum, s) => sum + s.totalSeconds, 0);

    return {
      success: true,
      issueKey,
      sessions: shaped,
      pendingCount: shaped.length,
      totalSeconds
    };
  } catch (error) {
    return handleResolverError(error, 'loading pending approval for issue');
  }
}

/**
 * Register approval resolvers on the Forge Resolver instance.
 */
export function registerApprovalResolvers(resolver) {
  resolver.define('getPendingApprovalRecords', getPendingApprovalRecords);
  resolver.define('getPendingApprovalForIssue', getPendingApprovalForIssue);
  resolver.define('approveRecords', approveRecords);
  resolver.define('reassignAndApproveRecords', reassignAndApproveRecords);
  resolver.define('createIssueAndApproveRecords', createIssueAndApproveRecords);
}

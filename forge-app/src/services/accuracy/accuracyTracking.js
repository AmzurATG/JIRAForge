/**
 * AI Accuracy Tracking — REMOVABLE LAYER
 *
 * Append-only event log for AI suggestion accuracy. Every public function in
 * this module is fire-and-forget: failures are logged but never thrown to the
 * caller, so production flows (approve/reassign/assign) cannot be blocked by a
 * logging hiccup.
 *
 * To disable in any environment: set ACCURACY_TRACKING_ENABLED=false.
 * To remove the layer entirely: delete this file, the migration, the dashboard
 * code in ai-server, and the call sites that invoke recordAccuracyEvent /
 * recordAccuracyEvents. See plan/AI_ACCURACY_TRACKING_IMPLEMENTATION_PLAN.md.
 *
 * Event-shape contract:
 *   {
 *     organizationId        : uuid (required)
 *     userId                : uuid (required)
 *     eventType             : 'approved_as_is' | 'reassigned' | 'manually_assigned' (required)
 *     finalIssueKey         : string (required)  -- what the user accepted
 *     activityRecordId      : uuid|null
 *     aiSuggestedIssueKey   : string|null        -- NULL only when AI gave no suggestion
 *     aiConfidenceScore     : number|null
 *     durationSeconds       : integer
 *     windowTitle           : string|null
 *     applicationName       : string|null
 *     classification        : string|null
 *     metadata              : object|null
 *   }
 */

import { supabaseRequest } from '../../utils/supabase.js';

const ENABLED = process.env.ACCURACY_TRACKING_ENABLED !== 'false';

/**
 * Map a JS event object to the ai_accuracy_events row shape.
 * Returns null if required fields are missing — the caller should drop the row
 * rather than write a malformed record.
 */
function toRow(event) {
  if (!event || !event.organizationId || !event.userId || !event.eventType || !event.finalIssueKey) {
    return null;
  }
  return {
    organization_id: event.organizationId,
    user_id: event.userId,
    event_type: event.eventType,
    activity_record_id: event.activityRecordId || null,
    ai_suggested_issue_key: event.aiSuggestedIssueKey || null,
    ai_confidence_score:
      typeof event.aiConfidenceScore === 'number' ? event.aiConfidenceScore : null,
    final_issue_key: event.finalIssueKey,
    duration_seconds: Number.isFinite(event.durationSeconds) ? event.durationSeconds : 0,
    window_title: event.windowTitle || null,
    application_name: event.applicationName || null,
    classification: event.classification || null,
    metadata: event.metadata || null
  };
}

/**
 * Record a single accuracy event.  Fire-and-forget.
 *
 * @param {Object} supabaseConfig - Supabase config (from initializeRequestContext)
 * @param {Object} event - Event object (see contract at top of file)
 */
export async function recordAccuracyEvent(supabaseConfig, event) {
  if (!ENABLED) return;
  const row = toRow(event);
  if (!row) {
    console.warn('[accuracyTracking] dropped malformed event:', event?.eventType);
    return;
  }
  try {
    await supabaseRequest(supabaseConfig, 'ai_accuracy_events', {
      method: 'POST',
      body: row
    });
  } catch (err) {
    console.warn('[accuracyTracking] write failed (non-fatal):', err.message);
  }
}

/**
 * Record many accuracy events in a single insert.  Used when one user action
 * affects N records (Approve all, Reassign all, multi-group assignment).
 * Drops malformed rows silently rather than failing the whole batch.
 *
 * @param {Object} supabaseConfig
 * @param {Array<Object>} events
 */
export async function recordAccuracyEvents(supabaseConfig, events) {
  if (!ENABLED || !Array.isArray(events) || events.length === 0) return;
  const rows = events.map(toRow).filter(Boolean);
  if (rows.length === 0) return;
  try {
    await supabaseRequest(supabaseConfig, 'ai_accuracy_events', {
      method: 'POST',
      body: rows
    });
  } catch (err) {
    console.warn(
      `[accuracyTracking] batch write failed (${rows.length} events, non-fatal):`,
      err.message
    );
  }
}

/**
 * Convenience — true when the layer is active.  Use to skip pre-fetch work
 * that only exists to populate accuracy events:
 *
 *   if (isAccuracyTrackingEnabled()) {
 *     priorRows = await fetchContextRowsForEvents(...);
 *   }
 */
export function isAccuracyTrackingEnabled() {
  return ENABLED;
}

// Activity Webhook Edge Function
// Triggered ONCE per batch insert into activity_records (FOR EACH STATEMENT).
//
// The database trigger uses a transition table to aggregate ALL inserted rows
// into a single JSON payload, so this function receives the entire batch at once
// — not one record at a time.
//
// Flow:
//   1. Receives batch payload with all pending records (pre-filtered by trigger)
//   2. Extracts user_id from the first record (all records in a batch share the same user)
//   3. Fetches user's cached Jira issues from user_jira_issues_cache
//   4. Merges with any issues embedded in the records
//   5. Sends ALL records to AI server /api/analyze-batch in ONE call
//   6. AI server makes ONE LLM call for the whole batch (efficient!)
//
// The AI server's existing analyze-batch endpoint handles:
//   - Atomic claim (pending → processing)
//   - Text-only LLM task matching
//   - Database update (status → analyzed)
//
// On transient errors records stay 'pending' for polling retry (safety net).
// On permanent errors (4xx) records are marked 'failed'.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ActivityRecord {
  id: string;
  user_id: string;
  organization_id: string;
  window_title?: string;
  application_name?: string;
  classification?: string;
  ocr_text?: string;
  total_time_seconds?: number;
  start_time?: string;
  end_time?: string;
  duration_seconds?: number;
  batch_timestamp?: string;
  work_date?: string;
  project_key?: string;
  user_assigned_issue_key?: string;
  user_assigned_issues?: string;
  status: string;
  metadata?: Record<string, unknown>;
  ocr_method?: string;
  ocr_confidence?: number;
}

interface BatchPayload {
  type: 'INSERT';
  table: 'activity_records';
  record_count: number;
  records: ActivityRecord[];
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const payload: BatchPayload = await req.json();

    console.log('Activity webhook triggered:', {
      type: payload.type,
      table: payload.table,
      record_count: payload.record_count
    });

    // Validate payload
    if (payload.type !== 'INSERT' || !payload.records || payload.records.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'Event acknowledged but not processed — no pending records',
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        }
      );
    }

    const records = payload.records;
    const AI_SERVER_URL = Deno.env.get('AI_SERVER_URL');

    if (!AI_SERVER_URL) {
      throw new Error('AI_SERVER_URL environment variable not set');
    }

    // NOTE: Do NOT update status to 'processing' here.
    // The AI server's claimBatchForProcessing() handles the atomic
    // pending → processing transition. If we set 'processing' here,
    // the AI server's claim fails (it expects 'pending'), leaving
    // records stuck at 'processing' forever.

    // All records in a batch come from the same desktop app insert,
    // so they share the same user_id and organization_id.
    const userId = records[0].user_id;
    const organizationId = records[0].organization_id;

    console.log(`Processing batch of ${records.length} records for user ${userId}`);

    // Fetch user's assigned Jira issues from cache
    const { data: cachedIssues, error: cacheError } = await supabaseClient
      .from('user_jira_issues_cache')
      .select('issue_key, summary, status, project_key, issue_type')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(50);

    let userAssignedIssues: { key: string; summary: string; status: string; project: string; issueType: string }[] = [];

    if (cachedIssues && cachedIssues.length > 0) {
      userAssignedIssues = cachedIssues.map(issue => ({
        key: issue.issue_key,
        summary: issue.summary,
        status: issue.status,
        project: issue.project_key,
        issueType: issue.issue_type
      }));

      console.log(`Fetched ${userAssignedIssues.length} cached issues for user ${userId}`);
    } else {
      if (cacheError) {
        console.warn('Error fetching cached issues:', cacheError);
      } else {
        console.log('No cached issues found for user — cache may need to be updated');
      }
    }

    // Check if any record has embedded issues (from desktop app, fresh at capture time)
    let recordIssues: unknown[] = [];
    for (const record of records) {
      if (record.user_assigned_issues) {
        try {
          const parsed = typeof record.user_assigned_issues === 'string'
            ? JSON.parse(record.user_assigned_issues)
            : record.user_assigned_issues;
          if (Array.isArray(parsed) && parsed.length > 0) {
            recordIssues = parsed;
            break; // Use the first non-empty list (all records share the same user)
          }
        } catch {
          // Ignore parse errors — try next record
        }
      }
    }

    // Priority: Merge both record-embedded (fresh) and cached issues, deduplicate by key.
    // Record-embedded issues may be hours old. Cache may have newer assignments. Merging gives widest coverage.
    const mergedIssues = [...recordIssues];
    const seenKeys = new Set(recordIssues.map((i: any) => i.key));
    for (const cached of userAssignedIssues) {
      if (!seenKeys.has((cached as any).key)) {
        mergedIssues.push(cached);
        seenKeys.add((cached as any).key);
      }
    }
    const issuesForAnalysis = mergedIssues.length > 0 ? mergedIssues : userAssignedIssues;

    console.log(`Using merged issues for analysis (${issuesForAnalysis.length} issues: ${recordIssues.length} record-embedded + ${issuesForAnalysis.length - recordIssues.length} from cache)`);

    // Send ALL records to AI server in a single /api/analyze-batch call
    try {
      const aiResponse = await fetch(`${AI_SERVER_URL}/api/analyze-batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('AI_SERVER_API_KEY')}`,
        },
        body: JSON.stringify({
          records: records.map(r => ({
            id: r.id,
            window_title: r.window_title,
            application_name: r.application_name,
            ocr_text: r.ocr_text,
            total_time_seconds: r.total_time_seconds,
            start_time: r.start_time,
            end_time: r.end_time,
            classification: r.classification
          })),
          user_assigned_issues: issuesForAnalysis,
          user_id: userId,
          organization_id: organizationId
        }),
        signal: AbortSignal.timeout(60000), // 60s timeout for batch processing
      });

      if (!aiResponse.ok) {
        throw new Error(`AI Server responded with status: ${aiResponse.status}`);
      }

      const aiResult = await aiResponse.json();
      console.log('AI Server notified successfully:', {
        recordsProcessed: aiResult.recordsProcessed,
        provider: aiResult.provider,
        model: aiResult.model
      });

      return new Response(
        JSON.stringify({
          success: true,
          message: `Batch of ${records.length} activity records queued for analysis`,
          record_count: records.length,
          record_ids: records.map(r => r.id)
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        }
      );

    } catch (aiError) {
      console.error('Error notifying AI server:', aiError);

      // Check if transient or permanent error
      const errorMessage = String(aiError);
      const isTransientError =
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('fetch failed') ||
        errorMessage.includes('network') ||
        errorMessage.includes('timeout');

      if (isTransientError) {
        // Status is still 'pending' — polling service will pick them up
        console.log(`Transient error — ${records.length} records remain pending for polling retry`);
      } else {
        // Permanent error — mark all records as failed
        // Only update those still in 'pending' (AI server may have already claimed some)
        const recordIds = records.map(r => r.id);
        await supabaseClient
          .from('activity_records')
          .update({
            status: 'failed',
            metadata: { error: errorMessage }
          })
          .in('id', recordIds)
          .eq('status', 'pending');

        console.log(`Permanent error — marked ${recordIds.length} records as failed`);
      }

      throw aiError;
    }

  } catch (error) {
    console.error('Error in activity webhook:', error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});

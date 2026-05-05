// Screenshot Webhook Edge Function
// This function is triggered when a new screenshot is uploaded
// It notifies the AI Analysis Server to process the screenshot

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ScreenshotPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: {
    id: string;
    user_id: string;
    organization_id: string;  // Multi-tenancy support
    timestamp: string;
    storage_url: string;
    storage_path: string;
    window_title?: string;
    application_name?: string;
    status: string;
    // Event-based tracking fields
    duration_seconds?: number;
    start_time?: string;
    end_time?: string;
    user_assigned_issues?: any[];
  };
  old_record?: any;
}

serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const payload: ScreenshotPayload = await req.json();

    console.log('Screenshot webhook triggered:', {
      type: payload.type,
      screenshotId: payload.record.id,
      userId: payload.record.user_id
    });

    // Only process new screenshots
    if (payload.type === 'INSERT' && payload.record.status === 'pending') {
      const AI_SERVER_URL = Deno.env.get('AI_SERVER_URL');

      if (!AI_SERVER_URL) {
        throw new Error('AI_SERVER_URL environment variable not set');
      }

      // NOTE: Do NOT update status to 'processing' here.
      // The AI server's claimScreenshotForProcessing() handles the atomic
      // pending → processing transition. If we set 'processing' here, the
      // AI server's claim fails (it expects 'pending'), leaving the
      // screenshot stuck at 'processing' forever.

      // Fetch user's assigned Jira issues from cache
      // Cache is updated periodically by Forge app's updateUserAssignedIssuesCache resolver
      const { data: cachedIssues, error: cacheError } = await supabaseClient
        .from('user_jira_issues_cache')
        .select('issue_key, issue_summary, summary, status, project_key, issue_type, description, labels, priority, updated_at')
        .eq('user_id', payload.record.user_id)
        .order('updated_at', { ascending: false })
        .limit(50);

      let userAssignedIssues: any[] = [];
      
      if (cachedIssues && cachedIssues.length > 0) {
        // Format cached issues for AI server
        userAssignedIssues = cachedIssues.map((issue: any) => ({
          key: issue.issue_key,
          summary: issue.issue_summary || issue.summary,
          status: issue.status,
          project: issue.project_key,
          issueType: issue.issue_type,
          description: issue.description || null,
          labels: issue.labels || [],
          priority: issue.priority || null,
          updated: issue.updated_at || null
        }));
        
        console.log(`Fetched ${userAssignedIssues.length} cached issues for user ${payload.record.user_id}`);
      } else {
        if (cacheError) {
          console.warn('Error fetching cached issues:', cacheError);
        } else {
          console.log('No cached issues found for user - cache may need to be updated');
        }
        // Continue with empty array - AI server will work without it but with lower accuracy
      }

      // Field-level merge so cache-only fields (updated, priority, issueType)
      // reach the AI even when an issue exists in both sources.
      //
      // The desktop app's embedded screenshot issues only contain key/summary/
      // status/project/description/labels — they have NO updated/priority/
      // issueType. Naively preferring screenshot data for duplicates throws
      // away the cache's recency/priority signals.
      //
      // Strategy: cache provides the base shape (richest); screenshot-embedded
      // values overwrite for fields the desktop app actually populates,
      // because they may be fresher for status/summary changes.
      const screenshotIssues = payload.record.user_assigned_issues || [];
      const cacheByKey = new Map<string, any>(
        userAssignedIssues.map((issue: any) => [issue.key, issue])
      );
      const screenshotByKey = new Map<string, any>(
        (screenshotIssues as any[])
          .filter((i: any) => i && typeof i.key === 'string')
          .map((i: any) => [i.key, i])
      );
      const allKeys = new Set<string>([...cacheByKey.keys(), ...screenshotByKey.keys()]);

      const mergedIssues: any[] = [];
      for (const key of allKeys) {
        const cached = cacheByKey.get(key);
        const embedded = screenshotByKey.get(key);
        const merged: any = { ...(cached || {}) };
        if (embedded) {
          for (const [field, value] of Object.entries(embedded)) {
            if (value !== null && value !== undefined && value !== '') {
              merged[field] = value;
            }
          }
          merged.key = embedded.key;
        }
        mergedIssues.push(merged);
      }

      const issuesForAnalysis = mergedIssues.length > 0 ? mergedIssues : userAssignedIssues;
      // Buckets sum to total: each key was either (a) embedded (with or
      // without a cache match) or (b) only in cache.
      const cacheOnlyCount = issuesForAnalysis.length - screenshotByKey.size;
      console.log(`Using merged issues for analysis (${issuesForAnalysis.length} total: ${screenshotByKey.size} screenshot-embedded + ${cacheOnlyCount} from cache only)`);

      // Notify AI Analysis Server
      try {
        const aiResponse = await fetch(`${AI_SERVER_URL}/api/analyze-screenshot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('AI_SERVER_API_KEY')}`,
          },
          body: JSON.stringify({
            // Send the entire record (all fields from screenshots table)
            ...payload.record,
            // Use screenshot issues (fresh) with cache as fallback
            user_assigned_issues: issuesForAnalysis,
          }),
          signal: AbortSignal.timeout(30000), // 30s timeout to prevent hanging connections
        });

        if (!aiResponse.ok) {
          throw new Error(`AI Server responded with status: ${aiResponse.status}`);
        }

        const aiResult = await aiResponse.json();
        console.log('AI Server notified successfully:', aiResult);

        return new Response(
          JSON.stringify({
            success: true,
            message: 'Screenshot queued for analysis',
            screenshot_id: payload.record.id
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        );

      } catch (aiError) {
        console.error('Error notifying AI server:', aiError);

        // Check if it's a transient error (network, timeout) vs permanent error
        const errorMessage = String(aiError);
        const isTransientError = 
          errorMessage.includes('ETIMEDOUT') ||
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('ENOTFOUND') ||
          errorMessage.includes('fetch failed') ||
          errorMessage.includes('network') ||
          errorMessage.includes('timeout');

        if (isTransientError) {
          // Status is still 'pending' (we don't change it above), so the
          // polling service will pick it up automatically on the next cycle.
          // Just log the error for debugging.
          console.log('Transient error - screenshot remains pending for polling retry');
        } else {
          // Permanent error (e.g., AI server returned 4xx) — mark as failed
          // so it doesn't get retried indefinitely.
          // Only update if status is still 'pending' (AI server may have
          // already claimed and handled it).
          await supabaseClient
            .from('screenshots')
            .update({
              status: 'failed',
              metadata: { error: errorMessage }
            })
            .eq('id', payload.record.id)
            .eq('status', 'pending');
        }

        throw aiError;
      }
    }

    // For non-INSERT events or already processed screenshots
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Event acknowledged but not processed',
        type: payload.type,
        status: payload.record.status
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('Error in screenshot webhook:', error);

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

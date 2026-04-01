// Document Processing Webhook Edge Function
// This function is triggered when a new BRD document is uploaded
// It notifies the AI Analysis Server to process the document and extract requirements

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface DocumentPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: {
    id: string;
    user_id: string;
    file_name: string;
    file_type: string;
    storage_url: string;
    storage_path: string;
    processing_status: string;
    project_key?: string;
  };
  old_record?: any;
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

    const payload: DocumentPayload = await req.json();

    console.log('Document webhook triggered:', {
      type: payload.type,
      documentId: payload.record.id,
      userId: payload.record.user_id,
      status: payload.record.processing_status
    });

    // Only process newly uploaded documents
    if (payload.type === 'INSERT' && payload.record.processing_status === 'uploaded') {
      const AI_SERVER_URL = Deno.env.get('AI_SERVER_URL');

      if (!AI_SERVER_URL) {
        throw new Error('AI_SERVER_URL environment variable not set');
      }

      // Update document status to extracting
      const { error: updateError } = await supabaseClient
        .from('documents')
        .update({ processing_status: 'extracting' })
        .eq('id', payload.record.id);

      if (updateError) {
        console.error('Error updating document status:', updateError);
      }

      // Notify AI Analysis Server to process the document
      try {
        const aiResponse = await fetch(`${AI_SERVER_URL}/process-brd`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('AI_SERVER_API_KEY')}`,
          },
          body: JSON.stringify({
            document_id: payload.record.id,
            user_id: payload.record.user_id,
            file_name: payload.record.file_name,
            file_type: payload.record.file_type,
            storage_url: payload.record.storage_url,
            storage_path: payload.record.storage_path,
            project_key: payload.record.project_key,
          }),
          signal: AbortSignal.timeout(120000), // 120s timeout to prevent hanging connections
        });

        if (!aiResponse.ok) {
          throw new Error(`AI Server responded with status: ${aiResponse.status}`);
        }

        const aiResult = await aiResponse.json();
        console.log('AI Server notified successfully for BRD processing:', aiResult);

        return new Response(
          JSON.stringify({
            success: true,
            message: 'Document queued for processing',
            document_id: payload.record.id
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200,
          }
        );

      } catch (aiError) {
        console.error('Error notifying AI server for BRD processing:', aiError);

        // Update document status to failed
        await supabaseClient
          .from('documents')
          .update({
            processing_status: 'failed',
            error_message: String(aiError)
          })
          .eq('id', payload.record.id);

        throw aiError;
      }
    }

    // For non-INSERT events or already processed documents
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Event acknowledged but not processed',
        type: payload.type,
        status: payload.record.processing_status
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('Error in document webhook:', error);

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

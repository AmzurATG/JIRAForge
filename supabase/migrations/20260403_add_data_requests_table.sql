-- ============================================================================
-- Personal Data Reporting API - Data Requests Table
-- ============================================================================
-- Tracks export/deletion requests for Atlassian's 7-day polling cycle
-- Implements GDPR compliance (Articles 17 & 20)
-- Created: April 3, 2026
-- ============================================================================

-- Create data_requests table
CREATE TABLE IF NOT EXISTS public.data_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Request identification
    request_type TEXT NOT NULL CHECK (request_type IN ('export', 'delete')),
    account_id TEXT NOT NULL, -- Atlassian account ID
    cloud_id TEXT NOT NULL,   -- Jira cloud instance ID
    
    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'processing', 'completed', 'failed')
    ),
    
    -- Timestamps
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_processing_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    
    -- Results
    result_url TEXT, -- Signed URL for export data (24hr expiry)
    result_data JSONB, -- Small inline data or deletion summary
    error_message TEXT,
    
    -- Metadata
    retry_count INTEGER DEFAULT 0,
    processing_duration_ms INTEGER, -- Time taken to process
    
    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_data_requests_account_cloud 
    ON public.data_requests(account_id, cloud_id);

CREATE INDEX idx_data_requests_status 
    ON public.data_requests(status) 
    WHERE status IN ('pending', 'processing');

CREATE INDEX idx_data_requests_requested_at 
    ON public.data_requests(requested_at DESC);

-- Unique constraint to prevent duplicate active requests
CREATE UNIQUE INDEX idx_data_requests_active_unique 
    ON public.data_requests(account_id, cloud_id, request_type) 
    WHERE status IN ('pending', 'processing');

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_data_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER data_requests_updated_at_trigger
    BEFORE UPDATE ON public.data_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_data_requests_updated_at();

-- RLS Policies (service role only, no user access)
ALTER TABLE public.data_requests ENABLE ROW LEVEL SECURITY;

-- No user-level policies = only service role can access (backend only)

-- Add table comment
COMMENT ON TABLE public.data_requests IS 
    'Tracks personal data export/deletion requests from Atlassian for GDPR compliance. Supports 7-day polling cycle.';

COMMENT ON COLUMN public.data_requests.request_type IS 
    'Type of request: export (Article 20) or delete (Article 17)';

COMMENT ON COLUMN public.data_requests.account_id IS 
    'Atlassian account ID of the user requesting data export/deletion';

COMMENT ON COLUMN public.data_requests.cloud_id IS 
    'Jira cloud instance ID where the request originated';

COMMENT ON COLUMN public.data_requests.status IS 
    'Request processing status: pending → processing → completed/failed';

COMMENT ON COLUMN public.data_requests.result_url IS 
    'Signed URL for downloading export data (24-hour expiry). NULL for delete requests.';

COMMENT ON COLUMN public.data_requests.result_data IS 
    'Export metadata or deletion summary (record counts, file counts, etc)';

COMMENT ON COLUMN public.data_requests.processing_duration_ms IS 
    'Time taken to process the request in milliseconds';

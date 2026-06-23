-- ============================================================================
-- Migration: Create user_location_log table
-- Date: 2026-06-22
--
-- Stores work-location snapshots written by the desktop app every 4 hours.
-- Location is stored here — NOT in activity_records.metadata — to avoid
-- JSONB redundancy, enable indexed queries, and simplify GDPR erasure.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_location_log (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id      UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    work_location_type   TEXT        CHECK (work_location_type IN ('office', 'remote', 'unknown')),
    work_location_source TEXT        CHECK (work_location_source IN ('ssid', 'subnet', 'ip_geo')),
    city                 TEXT,
    region               TEXT,
    country              TEXT,
    country_code         TEXT,
    ip                   TEXT
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Primary access pattern: latest location for a given user
CREATE INDEX IF NOT EXISTS idx_location_log_user_time
    ON public.user_location_log (user_id, recorded_at DESC);

-- Org-level analytics (e.g., how many users in office today)
CREATE INDEX IF NOT EXISTS idx_location_log_org_time
    ON public.user_location_log (organization_id, recorded_at DESC);

-- Portal query: filter an org's rows by location type, most recent first
-- (e.g. count office vs remote, or list everyone currently remote).
-- Uses plain columns only: a timestamptz->date cast is STABLE (timezone-
-- dependent), not IMMUTABLE, and Postgres rejects it in an index expression.
-- Date-range filters still use this via range predicates on recorded_at.
CREATE INDEX IF NOT EXISTS idx_location_log_org_date_type
    ON public.user_location_log (organization_id, work_location_type, recorded_at DESC);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.user_location_log ENABLE ROW LEVEL SECURITY;

-- Desktop app can insert its own rows
DROP POLICY IF EXISTS "location_log_insert_own" ON public.user_location_log;
CREATE POLICY "location_log_insert_own" ON public.user_location_log
    FOR INSERT
    WITH CHECK (user_id = (SELECT get_current_user_id()));

-- Users can read their own location history
DROP POLICY IF EXISTS "location_log_select_own" ON public.user_location_log;
CREATE POLICY "location_log_select_own" ON public.user_location_log
    FOR SELECT
    USING (user_id = (SELECT get_current_user_id()));

-- Org members can read all location rows in their org (for manager/portal views)
DROP POLICY IF EXISTS "location_log_select_org" ON public.user_location_log;
CREATE POLICY "location_log_select_org" ON public.user_location_log
    FOR SELECT
    USING (
        organization_id IN (
            SELECT organization_id FROM public.organization_members
            WHERE user_id = (SELECT get_current_user_id())
        )
    );

-- Service role (AI server, Edge Functions) has full access
DROP POLICY IF EXISTS "location_log_service_role" ON public.user_location_log;
CREATE POLICY "location_log_service_role" ON public.user_location_log
    FOR ALL
    USING (auth.role() = 'service_role');

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE public.user_location_log IS
    'Work-location snapshots written by the desktop app every 4 hours. '
    'Stores one row per detection cycle per device. '
    'Rows are append-only — the desktop app never UPDATEs or DELETEs rows here.';

COMMENT ON COLUMN public.user_location_log.work_location_type IS
    'Detected location type: office (SSID/subnet match), remote (IP geo), unknown (detection failed).';

COMMENT ON COLUMN public.user_location_log.work_location_source IS
    'Detection method used: ssid (WiFi SSID matched), subnet (LAN IP matched), ip_geo (ipinfo.io lookup).';

COMMENT ON COLUMN public.user_location_log.ip IS
    'Public IP address — null for office detections (ssid/subnet). '
    'Only populated when work_location_source = ip_geo to minimise PII at rest.';

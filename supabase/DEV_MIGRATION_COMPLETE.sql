-- ============================================================================
-- JIRAForge COMPLETE Development Environment Setup
-- ============================================================================
-- This script sets up the COMPLETE database schema for a new development
-- Supabase instance, including ALL:
--   1. Extensions
--   2. Tables (with all columns from production)
--   3. Indexes
--   4. Functions
--   5. Triggers
--   6. Views
--   7. Row Level Security (RLS) Policies
--   8. Storage Buckets
--   9. Storage Policies
-- 
-- Created: January 2026
-- Source: Consolidated from PRODUCTION_MIGRATION.sql and PRODUCTION_SUPPLEMENTARY.sql
-- 
-- HOW TO USE:
-- 1. Create a new Supabase project for development
-- 2. Go to SQL Editor in the new project
-- 3. Copy and paste this entire script
-- 4. Click "Run" to execute all statements
-- 5. After completion, set up Database Webhooks via Dashboard (see end of file)
-- 6. Deploy Edge Functions using Supabase CLI (see EDGE_FUNCTIONS_DEPLOYMENT.md)
-- ============================================================================

-- ============================================================================
-- PART 1: EXTENSIONS
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ============================================================================
-- PART 2: CORE TABLES
-- ============================================================================

-- ============================================================================
-- Users table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    atlassian_account_id TEXT UNIQUE NOT NULL,
    email TEXT,
    display_name TEXT,
    supabase_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    organization_id UUID, -- Will add FK constraint after organizations table
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_sync_at TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    settings JSONB DEFAULT '{}'::JSONB,
    -- Desktop App status tracking
    desktop_logged_in BOOLEAN DEFAULT FALSE,
    desktop_last_heartbeat TIMESTAMPTZ,
    desktop_app_version TEXT
);

-- ============================================================================
-- Organizations table (Multi-Tenancy)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    jira_cloud_id TEXT UNIQUE NOT NULL,
    jira_instance_url TEXT NOT NULL,
    org_name TEXT NOT NULL,
    subscription_status TEXT DEFAULT 'active' CHECK (
        subscription_status IN ('active', 'trial', 'suspended', 'cancelled')
    ),
    subscription_tier TEXT DEFAULT 'free' CHECK (
        subscription_tier IN ('free', 'pro', 'enterprise')
    ),
    settings JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT true
);

-- Add FK constraint for users.organization_id
ALTER TABLE public.users 
    ADD CONSTRAINT fk_users_organization 
    FOREIGN KEY (organization_id) 
    REFERENCES public.organizations(id) 
    ON DELETE SET NULL;

-- ============================================================================
-- Organization Members (RBAC)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.organization_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'member')),
    can_manage_settings BOOLEAN DEFAULT false,
    can_view_team_analytics BOOLEAN DEFAULT false,
    can_manage_members BOOLEAN DEFAULT false,
    can_delete_screenshots BOOLEAN DEFAULT false,
    can_manage_billing BOOLEAN DEFAULT false,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, organization_id)
);

-- ============================================================================
-- Organization Settings
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.organization_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID UNIQUE NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    ai_server_url TEXT,
    ai_server_api_key TEXT,
    screenshot_interval INTEGER DEFAULT 300,
    auto_worklog_enabled BOOLEAN DEFAULT true,
    application_whitelist TEXT[] DEFAULT ARRAY[]::TEXT[],
    application_blacklist TEXT[] DEFAULT ARRAY[]::TEXT[],
    private_sites TEXT[] DEFAULT ARRAY[]::TEXT[],
    non_work_threshold INTEGER DEFAULT 30,
    enable_non_work_warnings BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Screenshots table (with event-based tracking columns)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.screenshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    storage_url TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    thumbnail_url TEXT,
    window_title TEXT,
    application_name TEXT,
    file_size_bytes BIGINT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'analyzed', 'failed', 'deleted')),
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    analyzed_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,
    user_assigned_issue_key TEXT,
    project_key TEXT,
    -- Event-based tracking columns
    start_time TIMESTAMP WITH TIME ZONE,
    end_time TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    -- Retry tracking
    retry_count INTEGER DEFAULT 0
);

COMMENT ON COLUMN screenshots.start_time IS 'When user started this activity (window became active)';
COMMENT ON COLUMN screenshots.end_time IS 'When user ended this activity (switched to another window)';
COMMENT ON COLUMN screenshots.duration_seconds IS 'Duration of activity in seconds (end_time - start_time)';

-- ============================================================================
-- Analysis results table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.analysis_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    screenshot_id UUID NOT NULL REFERENCES public.screenshots(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    time_spent_seconds INTEGER NOT NULL DEFAULT 0,
    active_task_key TEXT,
    active_project_key TEXT,
    confidence_score DECIMAL(3, 2) CHECK (confidence_score >= 0 AND confidence_score <= 1),
    extracted_text TEXT,
    detected_jira_keys TEXT[],
    is_active_work BOOLEAN DEFAULT TRUE,
    is_idle BOOLEAN DEFAULT FALSE,
    analyzed_by TEXT DEFAULT 'ai',
    ai_model_version TEXT,
    analysis_metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    worklog_created BOOLEAN DEFAULT FALSE,
    worklog_id TEXT,
    worklog_created_at TIMESTAMP WITH TIME ZONE,
    work_type TEXT DEFAULT 'office' CHECK (work_type IN ('office', 'non_office', 'idle', 'unknown')),
    -- Additional columns for unassigned activity tracking
    manually_assigned BOOLEAN DEFAULT FALSE,
    assignment_group_id UUID
);

-- ============================================================================
-- Documents table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL CHECK (file_type IN ('pdf', 'docx', 'doc')),
    file_size_bytes BIGINT NOT NULL,
    storage_url TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    processing_status TEXT DEFAULT 'uploaded' CHECK (processing_status IN ('uploaded', 'extracting', 'analyzing', 'completed', 'failed')),
    extracted_text TEXT,
    parsed_requirements JSONB,
    project_key TEXT,
    created_issues JSONB DEFAULT '[]'::JSONB,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    ai_model_version TEXT,
    processing_metadata JSONB DEFAULT '{}'::JSONB
);

-- ============================================================================
-- Worklogs table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.worklogs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    analysis_result_id UUID REFERENCES public.analysis_results(id) ON DELETE SET NULL,
    jira_worklog_id TEXT NOT NULL,
    jira_issue_key TEXT NOT NULL,
    time_spent_seconds INTEGER NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    sync_status TEXT DEFAULT 'synced' CHECK (sync_status IN ('synced', 'pending', 'failed')),
    error_message TEXT
);

-- ============================================================================
-- Activity log table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.activity_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    event_data JSONB DEFAULT '{}'::JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- Tracking settings table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.tracking_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    screenshot_interval INTEGER DEFAULT 300,
    auto_start BOOLEAN DEFAULT false,
    blur_screenshots BOOLEAN DEFAULT false,
    track_idle BOOLEAN DEFAULT true,
    idle_threshold_seconds INTEGER DEFAULT 180,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
);

-- ============================================================================
-- User Jira Issues Cache table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.user_jira_issues_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    issue_key TEXT NOT NULL,
    issue_summary TEXT,
    project_key TEXT,
    project_name TEXT,
    issue_type TEXT,
    status TEXT,
    priority TEXT,
    description TEXT,
    labels JSONB DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    cached_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, organization_id, issue_key)
);

-- ============================================================================
-- Unassigned Activity table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.unassigned_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_result_id UUID REFERENCES public.analysis_results(id) ON DELETE CASCADE,
    screenshot_id UUID REFERENCES public.screenshots(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    timestamp TIMESTAMP WITH TIME ZONE,
    window_title TEXT,
    application_name TEXT,
    extracted_text TEXT,
    detected_jira_keys TEXT[],
    confidence_score DECIMAL(3, 2),
    time_spent_seconds INTEGER DEFAULT 0,
    reason TEXT,
    metadata JSONB DEFAULT '{}'::JSONB,
    manually_assigned BOOLEAN DEFAULT FALSE,
    assigned_task_key TEXT,
    assigned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(analysis_result_id)
);

-- ============================================================================
-- Unassigned Work Groups table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.unassigned_work_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    group_name TEXT,
    window_title_pattern TEXT,
    application_name TEXT,
    total_duration_seconds INTEGER DEFAULT 0,
    activity_count INTEGER DEFAULT 0,
    is_assigned BOOLEAN DEFAULT FALSE,
    assigned_task_key TEXT,
    assigned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Unassigned Group Members table (links activities to groups)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.unassigned_group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES public.unassigned_work_groups(id) ON DELETE CASCADE,
    unassigned_activity_id UUID NOT NULL REFERENCES public.unassigned_activity(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_id, unassigned_activity_id)
);

-- ============================================================================
-- Created Issues Log table (tracks issues created from BRD processing)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.created_issues_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
    issue_key TEXT NOT NULL,
    issue_summary TEXT,
    issue_type TEXT,
    project_key TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PART 3: INDEXES
-- ============================================================================

-- Users indexes
CREATE INDEX IF NOT EXISTS idx_users_atlassian_account_id ON public.users(atlassian_account_id);
CREATE INDEX IF NOT EXISTS idx_users_supabase_user_id ON public.users(supabase_user_id);
CREATE INDEX IF NOT EXISTS idx_users_organization_id ON public.users(organization_id);

-- Organizations indexes
CREATE INDEX IF NOT EXISTS idx_organizations_cloud_id ON public.organizations(jira_cloud_id);
CREATE INDEX IF NOT EXISTS idx_organizations_active ON public.organizations(is_active) WHERE is_active = true;

-- Organization members indexes
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON public.organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org_id ON public.organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_role ON public.organization_members(organization_id, role);

-- Organization settings index
CREATE INDEX IF NOT EXISTS idx_org_settings_org_id ON public.organization_settings(organization_id);

-- Screenshots indexes
CREATE INDEX IF NOT EXISTS idx_screenshots_user_id ON public.screenshots(user_id);
CREATE INDEX IF NOT EXISTS idx_screenshots_timestamp ON public.screenshots(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_screenshots_status ON public.screenshots(status);
CREATE INDEX IF NOT EXISTS idx_screenshots_user_timestamp ON public.screenshots(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_screenshots_organization_id ON public.screenshots(organization_id);
CREATE INDEX IF NOT EXISTS idx_screenshots_time_range ON public.screenshots(user_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_screenshots_org_time_range ON public.screenshots(organization_id, user_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_screenshots_duration ON public.screenshots(user_id, duration_seconds) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_screenshots_project_key ON public.screenshots(project_key);

-- Analysis results indexes
CREATE INDEX IF NOT EXISTS idx_analysis_results_screenshot_id ON public.analysis_results(screenshot_id);
CREATE INDEX IF NOT EXISTS idx_analysis_results_user_id ON public.analysis_results(user_id);
CREATE INDEX IF NOT EXISTS idx_analysis_results_task_key ON public.analysis_results(active_task_key);
CREATE INDEX IF NOT EXISTS idx_analysis_results_project_key ON public.analysis_results(active_project_key);
CREATE INDEX IF NOT EXISTS idx_analysis_results_worklog ON public.analysis_results(worklog_created, user_id);
CREATE INDEX IF NOT EXISTS idx_analysis_results_organization_id ON public.analysis_results(organization_id);
CREATE INDEX IF NOT EXISTS idx_analysis_results_work_type ON public.analysis_results(work_type);
CREATE INDEX IF NOT EXISTS idx_analysis_results_unassigned ON public.analysis_results(user_id, active_task_key) WHERE active_task_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_analysis_results_manual_assignment ON public.analysis_results(manually_assigned, assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_analysis_results_user_date_unassigned ON public.analysis_results(user_id, created_at DESC) WHERE active_task_key IS NULL AND work_type = 'office';
CREATE INDEX IF NOT EXISTS idx_analysis_results_assignment_group ON public.analysis_results(assignment_group_id) WHERE assignment_group_id IS NOT NULL;

-- Documents indexes
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON public.documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_status ON public.documents(processing_status);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON public.documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_project_key ON public.documents(project_key);
CREATE INDEX IF NOT EXISTS idx_documents_organization_id ON public.documents(organization_id);

-- Worklogs indexes
CREATE INDEX IF NOT EXISTS idx_worklogs_user_id ON public.worklogs(user_id);
CREATE INDEX IF NOT EXISTS idx_worklogs_issue_key ON public.worklogs(jira_issue_key);
CREATE INDEX IF NOT EXISTS idx_worklogs_started_at ON public.worklogs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_worklogs_jira_worklog_id ON public.worklogs(jira_worklog_id);
CREATE INDEX IF NOT EXISTS idx_worklogs_organization_id ON public.worklogs(organization_id);

-- Activity log indexes
CREATE INDEX IF NOT EXISTS idx_activity_log_user_id ON public.activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_event_type ON public.activity_log(event_type);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON public.activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_organization_id ON public.activity_log(organization_id);

-- Tracking settings indexes
CREATE INDEX IF NOT EXISTS idx_tracking_settings_user_id ON public.tracking_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_tracking_settings_organization_id ON public.tracking_settings(organization_id);

-- User Jira issues cache indexes
CREATE INDEX IF NOT EXISTS idx_user_issues_cache_user_id ON public.user_jira_issues_cache(user_id);
CREATE INDEX IF NOT EXISTS idx_user_issues_cache_issue_key ON public.user_jira_issues_cache(issue_key);
CREATE INDEX IF NOT EXISTS idx_user_issues_cache_project_key ON public.user_jira_issues_cache(project_key);
CREATE INDEX IF NOT EXISTS idx_user_issues_cache_organization_id ON public.user_jira_issues_cache(organization_id);
CREATE INDEX IF NOT EXISTS idx_user_jira_cache_user_updated ON public.user_jira_issues_cache(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_jira_cache_status ON public.user_jira_issues_cache(status);
CREATE INDEX IF NOT EXISTS idx_user_jira_cache_cached_at ON public.user_jira_issues_cache(cached_at);

-- Unassigned activity indexes
CREATE INDEX IF NOT EXISTS idx_unassigned_activity_user_id ON public.unassigned_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_unassigned_activity_screenshot_id ON public.unassigned_activity(screenshot_id);
CREATE INDEX IF NOT EXISTS idx_unassigned_activity_timestamp ON public.unassigned_activity(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_unassigned_activity_organization_id ON public.unassigned_activity(organization_id);
CREATE INDEX IF NOT EXISTS idx_unassigned_activity_manually_assigned ON public.unassigned_activity(manually_assigned);

-- Unassigned work groups indexes
CREATE INDEX IF NOT EXISTS idx_unassigned_groups_user_id ON public.unassigned_work_groups(user_id);
CREATE INDEX IF NOT EXISTS idx_unassigned_groups_is_assigned ON public.unassigned_work_groups(is_assigned);
CREATE INDEX IF NOT EXISTS idx_unassigned_groups_organization_id ON public.unassigned_work_groups(organization_id);
CREATE INDEX IF NOT EXISTS idx_unassigned_groups_created_at ON public.unassigned_work_groups(created_at DESC);

-- Unassigned group members indexes
CREATE INDEX IF NOT EXISTS idx_unassigned_group_members_group_id ON public.unassigned_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_unassigned_group_members_activity_id ON public.unassigned_group_members(unassigned_activity_id);

-- Created issues log indexes
CREATE INDEX IF NOT EXISTS idx_created_issues_log_user_id ON public.created_issues_log(user_id);
CREATE INDEX IF NOT EXISTS idx_created_issues_log_issue_key ON public.created_issues_log(issue_key);
CREATE INDEX IF NOT EXISTS idx_created_issues_log_organization_id ON public.created_issues_log(organization_id);

-- ============================================================================
-- PART 4: FUNCTIONS
-- ============================================================================

-- Function: Update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function: Calculate screenshot duration
CREATE OR REPLACE FUNCTION calculate_screenshot_duration()
RETURNS TRIGGER AS $$
BEGIN
    -- If start_time and end_time are set, calculate duration
    IF NEW.start_time IS NOT NULL AND NEW.end_time IS NOT NULL THEN
        NEW.duration_seconds := EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time))::INTEGER;
    END IF;

    -- Set end_time from timestamp if not provided (backward compatibility)
    IF NEW.end_time IS NULL AND NEW.timestamp IS NOT NULL THEN
        NEW.end_time := NEW.timestamp;
    END IF;

    -- Set timestamp from end_time if not provided
    IF NEW.timestamp IS NULL AND NEW.end_time IS NOT NULL THEN
        NEW.timestamp := NEW.end_time;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function: Get current user ID from auth
CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS UUID AS $$
BEGIN
    RETURN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid() LIMIT 1);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Function: Get user's organization ID
CREATE OR REPLACE FUNCTION public.get_user_organization_id(p_user_id UUID)
RETURNS UUID AS $$
BEGIN
    RETURN (
        SELECT organization_id 
        FROM public.users 
        WHERE id = p_user_id 
        LIMIT 1
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Function: Check if user belongs to organization
CREATE OR REPLACE FUNCTION public.user_belongs_to_org(p_user_id UUID, p_org_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.users 
        WHERE id = p_user_id AND organization_id = p_org_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Function: Get user's role in organization
CREATE OR REPLACE FUNCTION public.get_user_role(p_user_id UUID, p_org_id UUID)
RETURNS TEXT AS $$
BEGIN
    RETURN (
        SELECT role 
        FROM public.organization_members 
        WHERE user_id = p_user_id AND organization_id = p_org_id
        LIMIT 1
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Function: Update cached_at timestamp
CREATE OR REPLACE FUNCTION public.update_cached_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.cached_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- Function: Update unassigned_work_groups.updated_at
CREATE OR REPLACE FUNCTION public.update_unassigned_groups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

-- Function: Auto-save unassigned activity
CREATE OR REPLACE FUNCTION public.auto_save_unassigned_activity()
RETURNS TRIGGER AS $$
BEGIN
    -- Check if task_key is NULL or empty and work_type is 'office'
    IF (NEW.active_task_key IS NULL OR NEW.active_task_key = '') AND NEW.work_type = 'office' THEN
        -- Insert into unassigned_activity table
        INSERT INTO public.unassigned_activity (
            analysis_result_id,
            screenshot_id,
            user_id,
            organization_id,
            timestamp,
            window_title,
            application_name,
            extracted_text,
            detected_jira_keys,
            confidence_score,
            time_spent_seconds,
            reason,
            metadata
        )
        SELECT
            NEW.id,
            NEW.screenshot_id,
            NEW.user_id,
            NEW.organization_id,
            s.timestamp,
            s.window_title,
            s.application_name,
            NEW.extracted_text,
            NEW.detected_jira_keys,
            NEW.confidence_score,
            NEW.time_spent_seconds,
            CASE
                WHEN NEW.active_task_key IS NULL THEN 'no_task_key'
                WHEN NEW.active_task_key = '' THEN 'no_task_key'
                ELSE 'invalid_task_key'
            END,
            jsonb_build_object(
                'is_active_work', NEW.is_active_work,
                'is_idle', NEW.is_idle,
                'ai_model_version', NEW.ai_model_version,
                'active_project_key', NEW.active_project_key,
                'work_type', NEW.work_type
            )
        FROM public.screenshots s
        WHERE s.id = NEW.screenshot_id
        ON CONFLICT (analysis_result_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

COMMENT ON FUNCTION public.auto_save_unassigned_activity() IS 
  'Automatically saves analysis results with no task_key to unassigned_activity table';

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.get_current_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_organization_id(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_belongs_to_org(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_role(UUID, UUID) TO authenticated;

-- ============================================================================
-- PART 5: TRIGGERS
-- ============================================================================

-- Trigger: Update users.updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger: Update organizations.updated_at
DROP TRIGGER IF EXISTS update_organizations_updated_at ON public.organizations;
CREATE TRIGGER update_organizations_updated_at
    BEFORE UPDATE ON public.organizations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger: Update organization_settings.updated_at
DROP TRIGGER IF EXISTS update_org_settings_updated_at ON public.organization_settings;
CREATE TRIGGER update_org_settings_updated_at
    BEFORE UPDATE ON public.organization_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger: Update tracking_settings.updated_at
DROP TRIGGER IF EXISTS update_tracking_settings_updated_at ON public.tracking_settings;
CREATE TRIGGER update_tracking_settings_updated_at
    BEFORE UPDATE ON public.tracking_settings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger: Update screenshots.updated_at
DROP TRIGGER IF EXISTS update_screenshots_updated_at ON public.screenshots;
CREATE TRIGGER update_screenshots_updated_at
    BEFORE UPDATE ON public.screenshots
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger: Calculate screenshot duration
DROP TRIGGER IF EXISTS trigger_calculate_duration ON public.screenshots;
CREATE TRIGGER trigger_calculate_duration
    BEFORE INSERT OR UPDATE ON public.screenshots
    FOR EACH ROW
    EXECUTE FUNCTION calculate_screenshot_duration();

-- Trigger: Update user_jira_issues_cache.cached_at
DROP TRIGGER IF EXISTS update_user_jira_cache_cached_at ON public.user_jira_issues_cache;
CREATE TRIGGER update_user_jira_cache_cached_at
    BEFORE INSERT OR UPDATE ON public.user_jira_issues_cache
    FOR EACH ROW
    EXECUTE FUNCTION update_cached_at_column();

-- Trigger: Update unassigned_work_groups.updated_at
DROP TRIGGER IF EXISTS trigger_update_unassigned_groups_updated_at ON public.unassigned_work_groups;
CREATE TRIGGER trigger_update_unassigned_groups_updated_at
    BEFORE UPDATE ON public.unassigned_work_groups
    FOR EACH ROW
    EXECUTE FUNCTION update_unassigned_groups_updated_at();

-- Trigger: Auto-save unassigned activity (from analysis_results)
DROP TRIGGER IF EXISTS trigger_auto_save_unassigned ON public.analysis_results;
CREATE TRIGGER trigger_auto_save_unassigned
    AFTER INSERT OR UPDATE ON public.analysis_results
    FOR EACH ROW
    EXECUTE FUNCTION auto_save_unassigned_activity();

-- ============================================================================
-- PART 6: VIEWS
-- ============================================================================

-- View: Daily time summary (office work only)
CREATE OR REPLACE VIEW public.daily_time_summary AS
SELECT
    ar.user_id,
    ar.organization_id,
    u.display_name AS user_display_name,
    DATE(s.timestamp AT TIME ZONE 'UTC') AS work_date,
    ar.active_project_key AS project_key,
    ar.active_task_key AS task_key,
    ar.work_type,
    COUNT(*) AS session_count,
    SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds,
    ROUND(SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds))::NUMERIC / 3600.0, 2) AS total_hours,
    AVG(ar.confidence_score) AS avg_confidence
FROM public.analysis_results ar
JOIN public.screenshots s ON ar.screenshot_id = s.id
LEFT JOIN public.users u ON ar.user_id = u.id
WHERE s.deleted_at IS NULL
  AND ar.work_type = 'office'
GROUP BY ar.user_id, ar.organization_id, u.display_name, DATE(s.timestamp AT TIME ZONE 'UTC'), ar.active_project_key, ar.active_task_key, ar.work_type
ORDER BY work_date DESC, total_seconds DESC;

-- View: Weekly time summary (office work only)
CREATE OR REPLACE VIEW public.weekly_time_summary AS
SELECT
    ar.user_id,
    ar.organization_id,
    u.display_name AS user_display_name,
    DATE_TRUNC('week', s.timestamp AT TIME ZONE 'UTC')::DATE AS week_start,
    ar.active_project_key AS project_key,
    ar.active_task_key AS task_key,
    ar.work_type,
    COUNT(*) AS session_count,
    SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds,
    ROUND(SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds))::NUMERIC / 3600.0, 2) AS total_hours,
    AVG(ar.confidence_score) AS avg_confidence
FROM public.analysis_results ar
JOIN public.screenshots s ON ar.screenshot_id = s.id
LEFT JOIN public.users u ON ar.user_id = u.id
WHERE s.deleted_at IS NULL
  AND ar.work_type = 'office'
GROUP BY ar.user_id, ar.organization_id, u.display_name, DATE_TRUNC('week', s.timestamp AT TIME ZONE 'UTC'), ar.active_project_key, ar.active_task_key, ar.work_type
ORDER BY week_start DESC, total_seconds DESC;

-- View: Monthly time summary (office work only)
CREATE OR REPLACE VIEW public.monthly_time_summary AS
SELECT
    ar.user_id,
    ar.organization_id,
    u.display_name AS user_display_name,
    DATE_TRUNC('month', s.timestamp AT TIME ZONE 'UTC')::DATE AS month_start,
    ar.active_project_key AS project_key,
    ar.active_task_key AS task_key,
    ar.work_type,
    COUNT(*) AS session_count,
    SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds,
    ROUND(SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds))::NUMERIC / 3600.0, 2) AS total_hours,
    AVG(ar.confidence_score) AS avg_confidence
FROM public.analysis_results ar
JOIN public.screenshots s ON ar.screenshot_id = s.id
LEFT JOIN public.users u ON ar.user_id = u.id
WHERE s.deleted_at IS NULL
  AND ar.work_type = 'office'
GROUP BY ar.user_id, ar.organization_id, u.display_name, DATE_TRUNC('month', s.timestamp AT TIME ZONE 'UTC'), ar.active_project_key, ar.active_task_key, ar.work_type
ORDER BY month_start DESC, total_seconds DESC;

-- View: Project time summary (office work only)
CREATE OR REPLACE VIEW public.project_time_summary AS
SELECT
    ar.user_id,
    ar.organization_id,
    u.display_name AS user_display_name,
    ar.active_project_key AS project_key,
    SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds,
    ROUND(SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds))::NUMERIC / 3600.0, 2) AS total_hours,
    COUNT(DISTINCT ar.active_task_key) AS unique_tasks,
    COUNT(DISTINCT s.id) AS screenshot_count,
    MIN(s.timestamp) AS first_activity,
    MAX(s.timestamp) AS last_activity
FROM public.analysis_results ar
JOIN public.screenshots s ON s.id = ar.screenshot_id
LEFT JOIN public.users u ON ar.user_id = u.id
WHERE ar.active_project_key IS NOT NULL
  AND s.deleted_at IS NULL
  AND ar.work_type = 'office'
GROUP BY ar.user_id, ar.organization_id, u.display_name, ar.active_project_key;

-- View: Task time summary (office work only)
CREATE OR REPLACE VIEW public.task_time_summary AS
SELECT
    ar.user_id,
    ar.organization_id,
    u.display_name AS user_display_name,
    ar.active_task_key AS task_key,
    ar.active_project_key AS project_key,
    SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds,
    ROUND(SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds))::NUMERIC / 3600.0, 2) AS total_hours,
    COUNT(DISTINCT s.id) AS screenshot_count,
    MIN(s.timestamp) AS first_activity,
    MAX(s.timestamp) AS last_activity
FROM public.analysis_results ar
JOIN public.screenshots s ON s.id = ar.screenshot_id
LEFT JOIN public.users u ON ar.user_id = u.id
WHERE ar.active_task_key IS NOT NULL
  AND s.deleted_at IS NULL
  AND ar.work_type = 'office'
GROUP BY ar.user_id, ar.organization_id, u.display_name, ar.active_task_key, ar.active_project_key;

-- View: Unassigned activity summary
CREATE OR REPLACE VIEW public.unassigned_activity_summary AS
SELECT
    ua.user_id,
    ua.organization_id,
    u.display_name AS user_display_name,
    DATE(ua.timestamp AT TIME ZONE 'UTC') AS activity_date,
    ua.window_title,
    ua.application_name,
    COUNT(*) AS session_count,
    SUM(ua.time_spent_seconds) AS total_seconds,
    ROUND(SUM(ua.time_spent_seconds)::NUMERIC / 3600.0, 2) AS total_hours,
    AVG(ua.confidence_score) AS avg_confidence,
    array_agg(DISTINCT ua.detected_jira_keys) FILTER (WHERE ua.detected_jira_keys IS NOT NULL) AS all_detected_keys
FROM public.unassigned_activity ua
LEFT JOIN public.users u ON ua.user_id = u.id
WHERE ua.manually_assigned = false
GROUP BY ua.user_id, ua.organization_id, u.display_name, DATE(ua.timestamp AT TIME ZONE 'UTC'), ua.window_title, ua.application_name
ORDER BY activity_date DESC, total_seconds DESC;

-- ============================================================================
-- PART 7: ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.screenshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worklogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracking_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_jira_issues_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unassigned_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unassigned_work_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unassigned_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.created_issues_log ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Users Policies
-- ============================================================================
DROP POLICY IF EXISTS "users_select_own" ON public.users;
DROP POLICY IF EXISTS "users_update_own" ON public.users;
DROP POLICY IF EXISTS "users_service_role" ON public.users;

CREATE POLICY "users_select_own" ON public.users 
    FOR SELECT USING (auth.uid() = supabase_user_id);

CREATE POLICY "users_update_own" ON public.users 
    FOR UPDATE USING (auth.uid() = supabase_user_id);

CREATE POLICY "users_service_role" ON public.users 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Organizations Policies
-- ============================================================================
DROP POLICY IF EXISTS "organizations_select_member" ON public.organizations;
DROP POLICY IF EXISTS "organizations_service_role" ON public.organizations;

CREATE POLICY "organizations_select_member" ON public.organizations 
    FOR SELECT USING (
        id IN (SELECT organization_id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "organizations_service_role" ON public.organizations 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Organization Members Policies
-- ============================================================================
DROP POLICY IF EXISTS "org_members_select" ON public.organization_members;
DROP POLICY IF EXISTS "org_members_service_role" ON public.organization_members;

CREATE POLICY "org_members_select" ON public.organization_members 
    FOR SELECT USING (
        organization_id IN (SELECT organization_id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "org_members_service_role" ON public.organization_members 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Organization Settings Policies
-- ============================================================================
DROP POLICY IF EXISTS "org_settings_select" ON public.organization_settings;
DROP POLICY IF EXISTS "org_settings_service_role" ON public.organization_settings;

CREATE POLICY "org_settings_select" ON public.organization_settings 
    FOR SELECT USING (
        organization_id IN (SELECT organization_id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "org_settings_service_role" ON public.organization_settings 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Screenshots Policies
-- ============================================================================
DROP POLICY IF EXISTS "screenshots_select_own" ON public.screenshots;
DROP POLICY IF EXISTS "screenshots_insert_own" ON public.screenshots;
DROP POLICY IF EXISTS "screenshots_update_own" ON public.screenshots;
DROP POLICY IF EXISTS "screenshots_delete_own" ON public.screenshots;
DROP POLICY IF EXISTS "screenshots_service_role" ON public.screenshots;

CREATE POLICY "screenshots_select_own" ON public.screenshots 
    FOR SELECT USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "screenshots_insert_own" ON public.screenshots 
    FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "screenshots_update_own" ON public.screenshots 
    FOR UPDATE USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "screenshots_delete_own" ON public.screenshots 
    FOR DELETE USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "screenshots_service_role" ON public.screenshots 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Analysis Results Policies
-- ============================================================================
DROP POLICY IF EXISTS "analysis_results_select_own" ON public.analysis_results;
DROP POLICY IF EXISTS "analysis_results_insert_own" ON public.analysis_results;
DROP POLICY IF EXISTS "analysis_results_update_own" ON public.analysis_results;
DROP POLICY IF EXISTS "analysis_results_service_role" ON public.analysis_results;

CREATE POLICY "analysis_results_select_own" ON public.analysis_results 
    FOR SELECT USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "analysis_results_insert_own" ON public.analysis_results 
    FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "analysis_results_update_own" ON public.analysis_results 
    FOR UPDATE USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "analysis_results_service_role" ON public.analysis_results 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Documents Policies
-- ============================================================================
DROP POLICY IF EXISTS "documents_select_own" ON public.documents;
DROP POLICY IF EXISTS "documents_insert_own" ON public.documents;
DROP POLICY IF EXISTS "documents_update_own" ON public.documents;
DROP POLICY IF EXISTS "documents_delete_own" ON public.documents;
DROP POLICY IF EXISTS "documents_service_role" ON public.documents;

CREATE POLICY "documents_select_own" ON public.documents 
    FOR SELECT USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "documents_insert_own" ON public.documents 
    FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "documents_update_own" ON public.documents 
    FOR UPDATE USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "documents_delete_own" ON public.documents 
    FOR DELETE USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "documents_service_role" ON public.documents 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Worklogs Policies
-- ============================================================================
DROP POLICY IF EXISTS "worklogs_select_own" ON public.worklogs;
DROP POLICY IF EXISTS "worklogs_insert_own" ON public.worklogs;
DROP POLICY IF EXISTS "worklogs_update_own" ON public.worklogs;
DROP POLICY IF EXISTS "worklogs_service_role" ON public.worklogs;

CREATE POLICY "worklogs_select_own" ON public.worklogs 
    FOR SELECT USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "worklogs_insert_own" ON public.worklogs 
    FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "worklogs_update_own" ON public.worklogs 
    FOR UPDATE USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "worklogs_service_role" ON public.worklogs 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Activity Log Policies
-- ============================================================================
DROP POLICY IF EXISTS "activity_log_select_own" ON public.activity_log;
DROP POLICY IF EXISTS "activity_log_insert" ON public.activity_log;
DROP POLICY IF EXISTS "activity_log_service_role" ON public.activity_log;

CREATE POLICY "activity_log_select_own" ON public.activity_log 
    FOR SELECT USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "activity_log_insert" ON public.activity_log 
    FOR INSERT WITH CHECK (true);

CREATE POLICY "activity_log_service_role" ON public.activity_log 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Tracking Settings Policies
-- ============================================================================
DROP POLICY IF EXISTS "tracking_settings_select" ON public.tracking_settings;
DROP POLICY IF EXISTS "tracking_settings_service_role" ON public.tracking_settings;

CREATE POLICY "tracking_settings_select" ON public.tracking_settings 
    FOR SELECT USING (
        organization_id IN (SELECT organization_id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "tracking_settings_service_role" ON public.tracking_settings 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- User Jira Issues Cache Policies
-- ============================================================================
DROP POLICY IF EXISTS "user_issues_cache_select_own" ON public.user_jira_issues_cache;
DROP POLICY IF EXISTS "user_issues_cache_insert_own" ON public.user_jira_issues_cache;
DROP POLICY IF EXISTS "user_issues_cache_update_own" ON public.user_jira_issues_cache;
DROP POLICY IF EXISTS "user_issues_cache_delete_own" ON public.user_jira_issues_cache;
DROP POLICY IF EXISTS "user_issues_cache_service_role" ON public.user_jira_issues_cache;

CREATE POLICY "user_issues_cache_select_own" ON public.user_jira_issues_cache 
    FOR SELECT USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "user_issues_cache_insert_own" ON public.user_jira_issues_cache 
    FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "user_issues_cache_update_own" ON public.user_jira_issues_cache 
    FOR UPDATE USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "user_issues_cache_delete_own" ON public.user_jira_issues_cache 
    FOR DELETE USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "user_issues_cache_service_role" ON public.user_jira_issues_cache 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Unassigned Activity Policies
-- ============================================================================
DROP POLICY IF EXISTS "unassigned_activity_select_own" ON public.unassigned_activity;
DROP POLICY IF EXISTS "unassigned_activity_insert_own" ON public.unassigned_activity;
DROP POLICY IF EXISTS "unassigned_activity_update_own" ON public.unassigned_activity;
DROP POLICY IF EXISTS "unassigned_activity_service_role" ON public.unassigned_activity;

CREATE POLICY "unassigned_activity_select_own" ON public.unassigned_activity 
    FOR SELECT USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "unassigned_activity_insert_own" ON public.unassigned_activity 
    FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "unassigned_activity_update_own" ON public.unassigned_activity 
    FOR UPDATE USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "unassigned_activity_service_role" ON public.unassigned_activity 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Unassigned Work Groups Policies
-- ============================================================================
DROP POLICY IF EXISTS "unassigned_groups_select_own" ON public.unassigned_work_groups;
DROP POLICY IF EXISTS "unassigned_groups_insert_own" ON public.unassigned_work_groups;
DROP POLICY IF EXISTS "unassigned_groups_update_own" ON public.unassigned_work_groups;
DROP POLICY IF EXISTS "unassigned_groups_service_role" ON public.unassigned_work_groups;

CREATE POLICY "unassigned_groups_select_own" ON public.unassigned_work_groups 
    FOR SELECT USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "unassigned_groups_insert_own" ON public.unassigned_work_groups 
    FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "unassigned_groups_update_own" ON public.unassigned_work_groups 
    FOR UPDATE USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "unassigned_groups_service_role" ON public.unassigned_work_groups 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Unassigned Group Members Policies
-- ============================================================================
DROP POLICY IF EXISTS "unassigned_group_members_select" ON public.unassigned_group_members;
DROP POLICY IF EXISTS "unassigned_group_members_insert" ON public.unassigned_group_members;
DROP POLICY IF EXISTS "unassigned_group_members_service_role" ON public.unassigned_group_members;

CREATE POLICY "unassigned_group_members_select" ON public.unassigned_group_members 
    FOR SELECT USING (
        group_id IN (
            SELECT id FROM public.unassigned_work_groups 
            WHERE user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
        )
    );

CREATE POLICY "unassigned_group_members_insert" ON public.unassigned_group_members 
    FOR INSERT WITH CHECK (
        group_id IN (
            SELECT id FROM public.unassigned_work_groups 
            WHERE user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
        )
    );

CREATE POLICY "unassigned_group_members_service_role" ON public.unassigned_group_members 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- Created Issues Log Policies
-- ============================================================================
DROP POLICY IF EXISTS "created_issues_log_select_own" ON public.created_issues_log;
DROP POLICY IF EXISTS "created_issues_log_insert_own" ON public.created_issues_log;
DROP POLICY IF EXISTS "created_issues_log_service_role" ON public.created_issues_log;

CREATE POLICY "created_issues_log_select_own" ON public.created_issues_log 
    FOR SELECT USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "created_issues_log_insert_own" ON public.created_issues_log 
    FOR INSERT WITH CHECK (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "created_issues_log_service_role" ON public.created_issues_log 
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- PART 8: STORAGE BUCKETS
-- ============================================================================

-- Create screenshots bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'screenshots',
    'screenshots',
    false,
    10485760,  -- 10MB
    ARRAY['image/png', 'image/jpeg', 'image/jpg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Create documents bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'documents',
    'documents',
    false,
    52428800,  -- 50MB
    ARRAY['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- PART 9: STORAGE POLICIES
-- ============================================================================

-- Storage Policies for screenshots bucket
DROP POLICY IF EXISTS "storage_screenshots_upload" ON storage.objects;
DROP POLICY IF EXISTS "storage_screenshots_select" ON storage.objects;
DROP POLICY IF EXISTS "storage_screenshots_update" ON storage.objects;
DROP POLICY IF EXISTS "storage_screenshots_delete" ON storage.objects;
DROP POLICY IF EXISTS "storage_screenshots_service_role" ON storage.objects;

CREATE POLICY "storage_screenshots_upload" ON storage.objects 
    FOR INSERT TO authenticated 
    WITH CHECK (
        bucket_id = 'screenshots' 
        AND (storage.foldername(name))[1] = (SELECT id::text FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "storage_screenshots_select" ON storage.objects 
    FOR SELECT TO authenticated 
    USING (
        bucket_id = 'screenshots' 
        AND (storage.foldername(name))[1] = (SELECT id::text FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "storage_screenshots_update" ON storage.objects 
    FOR UPDATE TO authenticated 
    USING (
        bucket_id = 'screenshots' 
        AND (storage.foldername(name))[1] = (SELECT id::text FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "storage_screenshots_delete" ON storage.objects 
    FOR DELETE TO authenticated 
    USING (
        bucket_id = 'screenshots' 
        AND (storage.foldername(name))[1] = (SELECT id::text FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "storage_screenshots_service_role" ON storage.objects 
    FOR ALL TO service_role 
    USING (bucket_id = 'screenshots') 
    WITH CHECK (bucket_id = 'screenshots');

-- Storage Policies for documents bucket
DROP POLICY IF EXISTS "storage_documents_upload" ON storage.objects;
DROP POLICY IF EXISTS "storage_documents_select" ON storage.objects;
DROP POLICY IF EXISTS "storage_documents_update" ON storage.objects;
DROP POLICY IF EXISTS "storage_documents_delete" ON storage.objects;
DROP POLICY IF EXISTS "storage_documents_service_role" ON storage.objects;

CREATE POLICY "storage_documents_upload" ON storage.objects 
    FOR INSERT TO authenticated 
    WITH CHECK (
        bucket_id = 'documents' 
        AND (storage.foldername(name))[1] = (SELECT id::text FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "storage_documents_select" ON storage.objects 
    FOR SELECT TO authenticated 
    USING (
        bucket_id = 'documents' 
        AND (storage.foldername(name))[1] = (SELECT id::text FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "storage_documents_update" ON storage.objects 
    FOR UPDATE TO authenticated 
    USING (
        bucket_id = 'documents' 
        AND (storage.foldername(name))[1] = (SELECT id::text FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "storage_documents_delete" ON storage.objects 
    FOR DELETE TO authenticated 
    USING (
        bucket_id = 'documents' 
        AND (storage.foldername(name))[1] = (SELECT id::text FROM public.users WHERE supabase_user_id = auth.uid())
    );

CREATE POLICY "storage_documents_service_role" ON storage.objects 
    FOR ALL TO service_role 
    USING (bucket_id = 'documents') 
    WITH CHECK (bucket_id = 'documents');

-- ============================================================================
-- VERIFICATION
-- ============================================================================

SELECT '✅ JIRAForge Development Database Setup Complete!' as status;

SELECT 'Tables:' as type, count(*) as count
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

SELECT 'Functions:' as type, count(*) as count
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' AND p.prokind = 'f';

SELECT 'Triggers:' as type, count(*) as count
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public' AND NOT t.tgisinternal;

SELECT 'Views:' as type, count(*) as count
FROM information_schema.views
WHERE table_schema = 'public';

SELECT 'RLS Policies:' as type, count(*) as count
FROM pg_policies
WHERE schemaname = 'public';

SELECT 'Storage Buckets:' as type, count(*) as count
FROM storage.buckets;

SELECT 'Indexes:' as type, count(*) as count
FROM pg_indexes
WHERE schemaname = 'public';

-- ============================================================================
-- NEXT STEPS (Manual Configuration Required)
-- ============================================================================
-- 
-- 1. DATABASE WEBHOOKS (via Supabase Dashboard)
--    Go to: Database → Webhooks → Create a new webhook
--    
--    Webhook 1: screenshot-insert-webhook
--    - Table: screenshots
--    - Events: INSERT
--    - Type: Supabase Edge Function
--    - Edge Function: screenshot-webhook
--    
--    Webhook 2: document-insert-webhook
--    - Table: documents
--    - Events: INSERT  
--    - Type: Supabase Edge Function
--    - Edge Function: document-webhook
--
-- 2. DEPLOY EDGE FUNCTIONS (via Supabase CLI)
--    See the EDGE_FUNCTIONS_DEPLOYMENT.md file for detailed instructions
--
-- 3. SET EDGE FUNCTION SECRETS
--    supabase secrets set AI_SERVER_URL=<your-ai-server-url>
--    supabase secrets set AI_SERVER_API_KEY=<your-api-key>
--
-- ============================================================================

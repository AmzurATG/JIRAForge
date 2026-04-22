-- ============================================================================
-- Migration: AI Accuracy Tracking (REMOVABLE LAYER)
-- Date: 2026-04-22
--
-- Purpose: Append-only observation log to measure how often the AI's issue
-- classification is correct, plus an email allowlist for the read-only
-- dashboard that surfaces the data.
--
-- This is a TEMPORARY measurement layer. When AI accuracy is good enough that
-- the human-approval flow can be retired, drop both tables, the helper module
-- in forge-app, the dashboard middleware/controller/HTML in ai-server, and the
-- ~5 resolver call sites. See plan/AI_ACCURACY_TRACKING_IMPLEMENTATION_PLAN.md
-- for the full removal procedure.
--
-- No production tables are referenced or modified by this migration.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Table: ai_accuracy_events
--
-- One row per user decision that signals AI correctness:
--   - approved_as_is     -> AI's suggestion was accepted unchanged
--   - reassigned         -> User moved AI-suggested time to a different issue
--   - manually_assigned  -> Previously-unassigned work got an issue assigned
--
-- Append-only by convention (no UPDATE/DELETE expected).  ai_suggested_issue_key
-- is NULL only when the AI returned no suggestion at all (typical for
-- manually_assigned events on records the AI never classified). A non-null
-- value means the AI suggested something — compare it to final_issue_key to
-- see whether the user agreed.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_accuracy_events (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  user_id                 uuid NOT NULL,
  event_type              text NOT NULL CHECK (event_type IN (
    'approved_as_is',
    'reassigned',
    'manually_assigned'
  )),
  activity_record_id      uuid,
  ai_suggested_issue_key  text,
  ai_confidence_score     numeric,
  final_issue_key         text NOT NULL,
  duration_seconds        integer NOT NULL DEFAULT 0,
  window_title            text,
  application_name        text,
  classification          text,
  metadata                jsonb,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Lookups by org + time range (powers every dashboard panel)
CREATE INDEX IF NOT EXISTS idx_aae_org_created
  ON public.ai_accuracy_events (organization_id, created_at DESC);

-- Lookups by event type + time range (headline accuracy %)
CREATE INDEX IF NOT EXISTS idx_aae_event_created
  ON public.ai_accuracy_events (event_type, created_at DESC);

-- Top wrong pairs (which AI guess gets reassigned to what)
CREATE INDEX IF NOT EXISTS idx_aae_suggested_final
  ON public.ai_accuracy_events (ai_suggested_issue_key, final_issue_key)
  WHERE event_type = 'reassigned';

COMMENT ON TABLE  public.ai_accuracy_events IS
  'Append-only AI-suggestion accuracy log. REMOVABLE: drop with the rest of the AI accuracy tracking layer.';
COMMENT ON COLUMN public.ai_accuracy_events.ai_suggested_issue_key IS
  'AI''s suggested issue key. NULL only when the AI returned no suggestion.';
COMMENT ON COLUMN public.ai_accuracy_events.final_issue_key IS
  'The issue key the user actually accepted/assigned to.';

-- ----------------------------------------------------------------------------
-- Table: accuracy_dashboard_users
--
-- Email allowlist for the read-only accuracy dashboard.  Membership in this
-- table is the SOLE permission gate — Jira admin status, organization role,
-- and Forge app role are intentionally NOT checked.  This keeps the audience
-- under the product owner's explicit control.
--
-- Manage with raw SQL only (no admin UI is provided, by design — fewer
-- surfaces to remove later).
--   INSERT INTO accuracy_dashboard_users (email, added_by, notes)
--   VALUES ('person@company.com', 'bootstrap', 'product owner');
--
--   DELETE FROM accuracy_dashboard_users WHERE email = 'person@company.com';
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.accuracy_dashboard_users (
  email     text PRIMARY KEY,
  added_at  timestamptz NOT NULL DEFAULT now(),
  added_by  text,
  notes     text
);

COMMENT ON TABLE public.accuracy_dashboard_users IS
  'Email allowlist for the AI accuracy dashboard. REMOVABLE.';

-- ----------------------------------------------------------------------------
-- RLS posture: intentionally OFF on both tables.
--   - Inserts come from the Forge backend via the Supabase service-role key.
--   - Reads come from the AI server via the Supabase service-role key, gated
--     in application code by accuracy_dashboard_users.email matching.
-- The dashboard's permission boundary is the application allowlist, NOT RLS.
-- ----------------------------------------------------------------------------

ALTER TABLE public.ai_accuracy_events       DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.accuracy_dashboard_users DISABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Bootstrap: add the initial allowlist entries here, then run the migration.
-- Edit the lines below before applying — they are commented out by default so
-- the migration is safe to re-run.
-- ----------------------------------------------------------------------------

-- INSERT INTO public.accuracy_dashboard_users (email, added_by, notes) VALUES
--   ('product-owner@example.com', 'bootstrap', 'product owner'),
--   ('ai-tuner@example.com',      'bootstrap', 'prompt iteration')
-- ON CONFLICT (email) DO NOTHING;

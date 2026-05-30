-- ============================================================================
-- Migration: Non-Jira user tracking via Google SSO
-- Date: 2026-05-29
--
-- PURPOSE:
-- Allow employees WITHOUT a Jira/Atlassian account (HR, other teams) to sign in
-- to the desktop tracker with their company Google account and be tracked under
-- the same organization as that company's Jira users.
--
-- WHAT THIS CHANGES:
--   1. users.atlassian_account_id becomes NULLABLE — Google users have no
--      Atlassian identity. The existing UNIQUE constraint tolerates multiple
--      NULLs in Postgres, so many Google users coexist fine.
--   2. users.auth_provider — distinguishes 'atlassian' (existing, default) from
--      'google' (new). Existing rows backfill to 'atlassian' via the default.
--   3. users.google_sub — the stable Google subject id; the dedup key for Google
--      users (NOT email, which has no unique constraint today and may have dupes).
--   4. org_email_domains — maps a company email domain (e.g. amzur.com) to an
--      organization. Google SSO proves identity but not org membership; this
--      table both (a) routes a Google user to the right org and (b) enforces
--      "company email only" self-signup. Written server-side via the service role.
--
-- MULTI-TENANCY:
-- org_email_domains has RLS enabled and is scoped by organization_id. The
-- ai-server resolves domain -> org using the service role (bypasses RLS); the
-- per-org SELECT policy protects against direct authenticated access.
--
-- NOTE: citext is intentionally NOT used (it is not enabled in this project).
-- Domain case-insensitivity is achieved with a UNIQUE index on lower(domain),
-- matching how the codebase already normalizes emails with lower().
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. users: allow non-Atlassian identities
-- ----------------------------------------------------------------------------

-- Google users have no Atlassian account id.
ALTER TABLE public.users
  ALTER COLUMN atlassian_account_id DROP NOT NULL;

-- Distinguish the login provider. Existing rows default to 'atlassian'.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'atlassian'
    CHECK (auth_provider IN ('atlassian', 'google'));

-- Stable Google subject id (the 'sub' claim from the verified id_token).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS google_sub text;

-- Dedup key for Google users: one row per Google account. Partial so it never
-- collides with Atlassian rows (which have google_sub IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub_unique
  ON public.users (google_sub)
  WHERE auth_provider = 'google' AND google_sub IS NOT NULL;

-- Fast lookup of a user's provider within an org (e.g. polling/analytics filters).
CREATE INDEX IF NOT EXISTS idx_users_auth_provider
  ON public.users (auth_provider);

COMMENT ON COLUMN public.users.auth_provider IS
  'Login provider: atlassian (Jira OAuth, default) or google (non-Jira Google SSO).';
COMMENT ON COLUMN public.users.google_sub IS
  'Google id_token subject id. Stable per Google account; dedup key for google users.';

-- ----------------------------------------------------------------------------
-- 2. org_email_domains: company-domain -> organization mapping
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.org_email_domains (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Globally unique, case-insensitive domain (one domain -> exactly one org).
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_email_domains_domain_unique
  ON public.org_email_domains (lower(domain));

CREATE INDEX IF NOT EXISTS idx_org_email_domains_org
  ON public.org_email_domains (organization_id);

COMMENT ON TABLE public.org_email_domains IS
  'Maps a company email domain (e.g. amzur.com) to an organization for non-Jira Google SSO self-signup. Domain is globally unique (lower-cased).';

-- ----------------------------------------------------------------------------
-- 3. RLS for org_email_domains
-- ----------------------------------------------------------------------------

ALTER TABLE public.org_email_domains ENABLE ROW LEVEL SECURITY;

-- The ai-server uses the service role to resolve domain -> org at signup and to
-- write domain rows on behalf of a Forge admin. There is intentionally NO
-- user-level INSERT/UPDATE/DELETE policy: domain registration is server-side only.
CREATE POLICY org_email_domains_service_role ON public.org_email_domains
  AS PERMISSIVE FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Authenticated org members may read their own org's domains (e.g. to show the
-- configured value back in the Forge settings UI). Mirrors existing *_select_org
-- policies in the schema.
CREATE POLICY org_email_domains_select_org ON public.org_email_domains
  AS PERMISSIVE FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_members.organization_id
      FROM public.organization_members
      WHERE organization_members.user_id = (SELECT public.get_current_user_id())
    )
  );

-- ============================================================================
-- Migration: Harden AI accuracy tracking tables
-- Date: 2026-04-22
--
-- Follow-up to 20260422_ai_accuracy_tracking.sql.  Two corrections:
--
-- 1. Enable RLS on both tables (with NO policies) so only the service-role
--    key can read/write them.  Anon/authenticated keys are blocked even if
--    they leak.  The service-role key bypasses RLS by default, so the AI
--    server and Forge backend continue to work unchanged.
--
-- 2. Enforce lowercase email on accuracy_dashboard_users so the table cannot
--    accumulate case-mismatched duplicates ('Alice@x.com' vs 'alice@x.com')
--    that the middleware would treat as the same user.  Existing rows (if
--    any) are normalised first to keep the CHECK constraint from rejecting
--    them.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Enable RLS (no policies = service-role only)
-- ----------------------------------------------------------------------------

ALTER TABLE public.ai_accuracy_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accuracy_dashboard_users ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 2. Lowercase email constraint
--
-- Step a: normalise any rows that were inserted with mixed case (no-op if
--         the table is empty or already lowercase, so safe to re-run).
-- Step b: add the CHECK constraint.  Using NOT VALID + VALIDATE so we can
--         add it cheaply and validate without an exclusive lock; for a tiny
--         allowlist table this is over-engineering, but harmless.
-- ----------------------------------------------------------------------------

UPDATE public.accuracy_dashboard_users
   SET email = LOWER(email)
 WHERE email <> LOWER(email);

-- Idempotent constraint add — wrapped in a DO block so re-running the
-- migration does not error out with "constraint already exists".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'accuracy_dashboard_users_email_lowercase_chk'
       AND conrelid = 'public.accuracy_dashboard_users'::regclass
  ) THEN
    ALTER TABLE public.accuracy_dashboard_users
      ADD CONSTRAINT accuracy_dashboard_users_email_lowercase_chk
      CHECK (email = LOWER(email)) NOT VALID;

    ALTER TABLE public.accuracy_dashboard_users
      VALIDATE CONSTRAINT accuracy_dashboard_users_email_lowercase_chk;
  END IF;
END $$;

COMMENT ON CONSTRAINT accuracy_dashboard_users_email_lowercase_chk
  ON public.accuracy_dashboard_users IS
  'Prevents case-mismatched duplicates that would silently confuse the middleware allowlist lookup.';

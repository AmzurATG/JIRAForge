-- ============================================================================
-- Migration: Drop FK constraint on users.supabase_user_id + backfill
-- Date: 2026-04-01
--
-- CONTEXT:
-- The supabase_user_id column previously referenced auth.users(id) because
-- it was designed for Supabase-native auth. With custom JWT authentication
-- (Atlassian OAuth → AI server → custom Supabase JWT), we set
-- supabase_user_id = users.id so that auth.uid() in RLS policies resolves
-- correctly via get_current_user_id(). This requires removing the FK to
-- auth.users since custom JWT users are not in the auth.users table.
--
-- CHAIN OF TRUST (how RLS works after this migration):
--   1. AI server mints JWT with sub = users.id (database UUID)
--   2. Desktop app sends JWT with every request
--   3. PostgREST sets request.jwt.claims from the JWT
--   4. auth.uid() returns sub from JWT = users.id
--   5. get_current_user_id() does: SELECT id FROM users WHERE supabase_user_id = auth.uid()
--   6. Since supabase_user_id = id (from backfill), this returns the correct user
--   7. All existing RLS policies that use get_current_user_id() work without modification
-- ============================================================================

-- Step 1: Drop the FK constraint on supabase_user_id → auth.users(id)
DO $$
DECLARE
  constraint_name_var TEXT;
BEGIN
  SELECT tc.constraint_name INTO constraint_name_var
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'users'
    AND kcu.column_name = 'supabase_user_id'
    AND tc.constraint_type = 'FOREIGN KEY'
  LIMIT 1;

  IF constraint_name_var IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.users DROP CONSTRAINT ' || quote_ident(constraint_name_var);
    RAISE NOTICE 'Dropped FK constraint "%" on users.supabase_user_id', constraint_name_var;
  ELSE
    RAISE NOTICE 'No FK constraint found on users.supabase_user_id — skipping';
  END IF;
END;
$$;

-- Step 2: Backfill supabase_user_id = id for all existing users
-- This ensures all existing users work with RLS immediately after deployment
UPDATE public.users
SET supabase_user_id = id
WHERE supabase_user_id IS NULL
   OR supabase_user_id != id;

-- Step 3: Ensure the index exists for RLS performance
-- get_current_user_id() does WHERE supabase_user_id = auth.uid()
-- This index makes that lookup O(log n) instead of O(n)
CREATE INDEX IF NOT EXISTS idx_users_supabase_user_id
ON public.users USING btree (supabase_user_id);

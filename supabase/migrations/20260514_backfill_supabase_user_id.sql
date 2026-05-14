-- ============================================================================
-- Migration: Backfill supabase_user_id for RLS Compatibility
-- ============================================================================
-- Created: 2026-05-14
-- Purpose: Fix desktop app version not updating due to NULL/incorrect 
--          supabase_user_id values blocking RLS policy
--
-- Background:
-- The RLS policy requires: auth.uid() = supabase_user_id
-- JWT has sub = users.id
-- For old users, supabase_user_id is NULL or mismatched
-- This causes version updates to fail silently
--
-- This migration sets supabase_user_id = id for all users to fix RLS
-- ============================================================================

-- ============================================================================
-- SAFETY CHECKS
-- ============================================================================

DO $$
DECLARE
    v_affected_count INTEGER;
    v_null_count INTEGER;
    v_mismatch_count INTEGER;
    v_correct_count INTEGER;
BEGIN
    -- Count affected users
    SELECT 
        COUNT(*) FILTER (WHERE supabase_user_id IS NULL),
        COUNT(*) FILTER (WHERE supabase_user_id IS NOT NULL AND supabase_user_id != id),
        COUNT(*) FILTER (WHERE supabase_user_id = id),
        COUNT(*)
    INTO v_null_count, v_mismatch_count, v_correct_count, v_affected_count
    FROM public.users;
    
    -- Log the pre-migration state
    RAISE NOTICE 'Pre-migration state:';
    RAISE NOTICE '  Total users: %', v_affected_count;
    RAISE NOTICE '  NULL supabase_user_id: %', v_null_count;
    RAISE NOTICE '  Mismatched supabase_user_id: %', v_mismatch_count;
    RAISE NOTICE '  Correct supabase_user_id: %', v_correct_count;
    RAISE NOTICE '  Users to be updated: %', v_null_count + v_mismatch_count;
    
    -- Safety check: Abort if no users table exists
    IF v_affected_count = 0 THEN
        RAISE EXCEPTION 'No users found in users table. Aborting migration for safety.';
    END IF;
END $$;

-- ============================================================================
-- CREATE BACKUP TABLE (Safety measure)
-- ============================================================================

-- Create a backup of affected rows BEFORE the migration
-- This allows rollback if something goes wrong
CREATE TEMP TABLE users_backup_20260514 AS
SELECT id, supabase_user_id, updated_at
FROM public.users
WHERE supabase_user_id IS NULL 
   OR supabase_user_id != id;

-- Log backup creation
DO $$
DECLARE
    v_backup_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_backup_count FROM users_backup_20260514;
    RAISE NOTICE 'Created backup table with % rows', v_backup_count;
END $$;

-- ============================================================================
-- PERFORM MIGRATION
-- ============================================================================

-- This UPDATE only affects the users table
-- It sets supabase_user_id = id where needed
-- No other tables are touched
BEGIN;

UPDATE public.users
SET 
    supabase_user_id = id,
    updated_at = NOW()
WHERE supabase_user_id IS NULL 
   OR (supabase_user_id IS NOT NULL AND supabase_user_id != id);

-- Log the migration results
DO $$
DECLARE
    v_updated_count INTEGER;
    v_null_after INTEGER;
    v_mismatch_after INTEGER;
    v_correct_after INTEGER;
BEGIN
    -- Get the update count from the last UPDATE
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    
    -- Verify post-migration state
    SELECT 
        COUNT(*) FILTER (WHERE supabase_user_id IS NULL),
        COUNT(*) FILTER (WHERE supabase_user_id IS NOT NULL AND supabase_user_id != id),
        COUNT(*) FILTER (WHERE supabase_user_id = id)
    INTO v_null_after, v_mismatch_after, v_correct_after
    FROM public.users;
    
    RAISE NOTICE 'Migration completed:';
    RAISE NOTICE '  Rows updated: %', v_updated_count;
    RAISE NOTICE '  NULL after: % (should be 0)', v_null_after;
    RAISE NOTICE '  Mismatched after: % (should be 0)', v_mismatch_after;
    RAISE NOTICE '  Correct after: %', v_correct_after;
    
    -- Validation: Ensure no NULL or mismatched values remain
    IF v_null_after > 0 OR v_mismatch_after > 0 THEN
        RAISE EXCEPTION 'Migration validation failed: Found % NULL and % mismatched values after update', 
            v_null_after, v_mismatch_after;
    END IF;
    
    -- Log to admin_logs for audit trail
    INSERT INTO public.admin_logs (log_level, message, created_at)
    VALUES (
        'INFO',
        format('Migration 20260514_backfill_supabase_user_id: Updated %s users (fixed NULL/mismatched supabase_user_id)', 
               v_updated_count),
        NOW()
    );
END $$;

COMMIT;

-- ============================================================================
-- POST-MIGRATION VERIFICATION
-- ============================================================================

-- Final verification query
DO $$
DECLARE
    v_verification_result RECORD;
BEGIN
    SELECT 
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE supabase_user_id IS NULL) as null_count,
        COUNT(*) FILTER (WHERE supabase_user_id != id) as mismatch_count,
        COUNT(*) FILTER (WHERE supabase_user_id = id) as correct_count,
        ROUND(COUNT(*) FILTER (WHERE supabase_user_id = id) * 100.0 / COUNT(*), 2) as correct_percentage
    INTO v_verification_result
    FROM public.users;
    
    RAISE NOTICE 'Final verification:';
    RAISE NOTICE '  Total users: %', v_verification_result.total_users;
    RAISE NOTICE '  NULL supabase_user_id: %', v_verification_result.null_count;
    RAISE NOTICE '  Mismatched supabase_user_id: %', v_verification_result.mismatch_count;
    RAISE NOTICE '  Correct supabase_user_id: % (%.2f%%)', 
        v_verification_result.correct_count, 
        v_verification_result.correct_percentage;
    
    IF v_verification_result.correct_percentage = 100.00 THEN
        RAISE NOTICE '✅ Migration successful! All users have correct supabase_user_id';
    ELSE
        RAISE WARNING '⚠️ Migration incomplete. % users still have issues', 
            v_verification_result.null_count + v_verification_result.mismatch_count;
    END IF;
END $$;

-- ============================================================================
-- ROLLBACK INSTRUCTIONS (In case of issues)
-- ============================================================================

-- If you need to rollback this migration, run:
-- 
-- BEGIN;
-- UPDATE public.users u
-- SET supabase_user_id = b.supabase_user_id,
--     updated_at = b.updated_at
-- FROM users_backup_20260514 b
-- WHERE u.id = b.id;
-- COMMIT;
--
-- Note: Backup table is in TEMP tablespace and will be dropped on session end
-- ============================================================================

-- Drop the backup table (comment out if you want to keep it for a while)
-- DROP TABLE IF EXISTS users_backup_20260514;

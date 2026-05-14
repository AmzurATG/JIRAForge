-- ============================================================================
-- DRY RUN: Check what the migration would affect
-- ============================================================================
-- Run this BEFORE the actual migration to see what will be changed
-- This is 100% safe - it only reads data, makes no changes
-- ============================================================================

-- 1. Summary of affected users
SELECT 
    'Summary' as check_type,
    COUNT(*) as total_users,
    COUNT(*) FILTER (WHERE supabase_user_id IS NULL) as null_count,
    COUNT(*) FILTER (WHERE supabase_user_id IS NOT NULL AND supabase_user_id != id) as mismatch_count,
    COUNT(*) FILTER (WHERE supabase_user_id = id) as correct_count,
    COUNT(*) FILTER (WHERE supabase_user_id IS NULL OR supabase_user_id != id) as will_be_updated
FROM public.users;

-- 2. Show affected users (NULL supabase_user_id)
SELECT 
    'NULL supabase_user_id' as issue_type,
    id,
    atlassian_account_id,
    email,
    supabase_user_id,
    desktop_app_version,
    desktop_last_heartbeat,
    created_at
FROM public.users
WHERE supabase_user_id IS NULL
ORDER BY created_at DESC
LIMIT 10;

-- 3. Show affected users (mismatched supabase_user_id)
SELECT 
    'Mismatched supabase_user_id' as issue_type,
    id,
    atlassian_account_id,
    email,
    supabase_user_id,
    desktop_app_version,
    desktop_last_heartbeat,
    created_at
FROM public.users
WHERE supabase_user_id IS NOT NULL 
  AND supabase_user_id != id
ORDER BY created_at DESC
LIMIT 10;

-- 4. Show recently active users who would be affected
SELECT 
    'Recently active affected users' as category,
    id,
    atlassian_account_id,
    email,
    desktop_logged_in,
    desktop_last_heartbeat,
    desktop_app_version,
    CASE 
        WHEN supabase_user_id IS NULL THEN 'NULL'
        WHEN supabase_user_id != id THEN 'MISMATCH'
    END as issue_type
FROM public.users
WHERE (supabase_user_id IS NULL OR supabase_user_id != id)
  AND desktop_logged_in = true
  AND desktop_last_heartbeat > NOW() - INTERVAL '7 days'
ORDER BY desktop_last_heartbeat DESC;

-- 5. Check if there are any foreign key constraints that might be affected
SELECT 
    'Foreign Key Check' as check_type,
    tc.table_name, 
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc 
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' 
  AND (kcu.column_name = 'supabase_user_id' OR ccu.column_name = 'supabase_user_id')
  AND tc.table_name = 'users';

-- 6. Version distribution of affected users
SELECT 
    'Version distribution of affected users' as check_type,
    desktop_app_version,
    COUNT(*) as user_count,
    MIN(desktop_last_heartbeat) as oldest_heartbeat,
    MAX(desktop_last_heartbeat) as newest_heartbeat
FROM public.users
WHERE (supabase_user_id IS NULL OR supabase_user_id != id)
  AND desktop_logged_in = true
GROUP BY desktop_app_version
ORDER BY desktop_app_version DESC;

-- 7. Organization distribution of affected users
SELECT 
    'Organization distribution' as check_type,
    o.org_name,
    o.id as org_id,
    COUNT(u.id) as affected_users
FROM public.users u
JOIN public.organizations o ON u.organization_id = o.id
WHERE (u.supabase_user_id IS NULL OR u.supabase_user_id != u.id)
GROUP BY o.org_name, o.id
ORDER BY affected_users DESC;

-- ============================================================================
-- Expected output interpretation:
-- ============================================================================
-- 1. Summary: Shows how many users will be affected
-- 2-3. Sample affected users: Shows actual records that will be updated
-- 4. Recently active: Shows users who are currently using the app
-- 5. Foreign Key Check: Should show ONE row (users.supabase_user_id -> auth.users.id)
--    This is SAFE because we're setting supabase_user_id = users.id (self-reference fix)
-- 6. Version distribution: Shows which versions are affected
-- 7. Organization distribution: Shows which orgs have affected users
--
-- If Summary shows will_be_updated > 0, the migration is needed
-- If Summary shows will_be_updated = 0, the migration is not needed (already fixed)
-- ============================================================================

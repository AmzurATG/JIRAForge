-- ============================================================================
-- TEST: Insert a fake idle record to verify idle block rendering
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
--
-- PREREQUISITE: Run 20260325_add_idle_time_support.sql migration first!
-- ============================================================================

-- Step 1: Check if the migration has been applied
-- (If this fails, run the migration first)
SELECT column_name FROM information_schema.columns
WHERE table_name = 'activity_records' AND column_name = 'is_idle';

-- Step 2: Find your user_id and organization_id from existing records
-- (look at the output to confirm your IDs)
SELECT DISTINCT user_id, organization_id, project_key
FROM activity_records
WHERE work_date = CURRENT_DATE
ORDER BY organization_id
LIMIT 5;

-- Step 3: Insert a test idle record
-- This creates a 30-minute idle block from 5:00 PM to 5:30 PM today (IST → UTC)
-- Adjust the user_id and organization_id from Step 2 output
--
-- NOTE: Replace <USER_ID> and <ORG_ID> with actual UUIDs from Step 2!
-- The times below are in UTC. 5:00 PM IST = 11:30 AM UTC.

INSERT INTO activity_records (
  id,
  user_id,
  organization_id,
  window_title,
  application_name,
  classification,
  is_idle,
  idle_start_time,
  idle_end_time,
  start_time,
  end_time,
  duration_seconds,
  total_time_seconds,
  work_date,
  user_timezone,
  project_key,
  status,
  metadata,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  user_id,
  organization_id,
  '[Idle: idle timeout]',
  'System',
  'idle',
  TRUE,
  -- 5:00 PM IST = 11:30 UTC today
  (CURRENT_DATE + INTERVAL '11 hours 30 minutes')::timestamptz,
  -- 5:30 PM IST = 12:00 UTC today
  (CURRENT_DATE + INTERVAL '12 hours')::timestamptz,
  (CURRENT_DATE + INTERVAL '11 hours 30 minutes')::timestamptz,
  (CURRENT_DATE + INTERVAL '12 hours')::timestamptz,
  1800,  -- 30 minutes in seconds
  1800,
  CURRENT_DATE,
  'Asia/Kolkata',
  project_key,
  'analyzed',
  '{"tracking_mode": "idle_detection", "idle_reason": "idle timeout", "test_record": true}'::jsonb,
  NOW(),
  NOW()
FROM activity_records
WHERE work_date = CURRENT_DATE
LIMIT 1;

-- Step 4: Verify the idle record was inserted
SELECT id, window_title, classification, is_idle,
       idle_start_time, idle_end_time, duration_seconds
FROM activity_records
WHERE work_date = CURRENT_DATE AND is_idle = TRUE
ORDER BY created_at DESC;

-- ============================================================================
-- CLEANUP: Remove test idle record when done testing
-- Uncomment and run this to delete the test record:
--
-- DELETE FROM activity_records
-- WHERE work_date = CURRENT_DATE
--   AND is_idle = TRUE
--   AND metadata->>'test_record' = 'true';
-- ============================================================================

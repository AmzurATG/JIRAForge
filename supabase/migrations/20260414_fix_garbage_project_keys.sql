-- Fix garbage project_key values in activity_records.
--
-- Root cause: The AI was independently detecting project_key from window titles,
-- folder names, and OCR text, producing garbage values like 'JIRAForge',
-- 'TIMETRACKER', 'desktop_app', 'AmzurATG', etc. This scattered a single user's
-- time across 19+ fake "projects", causing massive time discrepancies between
-- the Time Analytics view (which sums all records) and Team Analytics (which
-- filters by project_key).
--
-- Fix: project_key is now derived solely from the matched issue key
-- (e.g., PROJ-123 → PROJ). This migration retroactively applies that logic
-- to all existing records.

-- Step 1: For analyzed records WITH a matched issue key,
-- derive project_key from user_assigned_issue_key (e.g., 'PROJ-123' → 'PROJ').
-- This corrects records where AI hallucinated a wrong project_key.
UPDATE activity_records
SET project_key = SUBSTRING(user_assigned_issue_key FROM '^([A-Z][A-Z0-9]+)-\d+$'),
    updated_at = NOW()
WHERE user_assigned_issue_key IS NOT NULL
  AND status = 'analyzed'
  AND (
    project_key IS NULL
    OR project_key != COALESCE(SUBSTRING(user_assigned_issue_key FROM '^([A-Z][A-Z0-9]+)-\d+$'), '')
  );

-- Step 2: For records WITHOUT a matched issue key, clear any garbage project_key.
-- These records will appear as "unassigned" in Team Analytics.
UPDATE activity_records
SET project_key = NULL,
    updated_at = NOW()
WHERE user_assigned_issue_key IS NULL
  AND project_key IS NOT NULL;

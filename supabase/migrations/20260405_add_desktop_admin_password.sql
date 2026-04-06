-- ============================================================================
-- Migration: Add per-org desktop admin password + notification support
-- Date: 2026-04-05
--
-- Moves the hardcoded desktop admin panel password (admin123) to a per-org
-- setting in tracking_settings. Adds notification type for 30-day reminders.
-- ============================================================================

-- Step 1: Add desktop_admin_password column to tracking_settings
ALTER TABLE public.tracking_settings
  ADD COLUMN IF NOT EXISTS desktop_admin_password TEXT DEFAULT 'admin123';

-- Step 1b: Ensure every organization has an org-level tracking_settings row
-- so the desktop_admin_password column default is always available.
-- Inserts a minimal row for orgs that don't already have one.
INSERT INTO public.tracking_settings (organization_id)
SELECT o.id
FROM public.organizations o
WHERE NOT EXISTS (
    SELECT 1 FROM public.tracking_settings ts
    WHERE ts.organization_id = o.id
      AND ts.project_key IS NULL
);

COMMENT ON COLUMN public.tracking_settings.desktop_admin_password
  IS 'Password for the local desktop admin panel (localhost:51777/admin). Org-level only (project_key IS NULL rows). Default admin123.';

-- Step 2: Update notification_logs CHECK constraint to include new type
-- Drop and recreate to add default_password_reminder
ALTER TABLE public.notification_logs
  DROP CONSTRAINT IF EXISTS valid_notification_type;

ALTER TABLE public.notification_logs
  ADD CONSTRAINT valid_notification_type CHECK (
    notification_type IN (
      'login_reminder',
      'download_reminder',
      'new_version',
      'inactivity_alert',
      'admin_inactivity_digest',
      'admin_download_digest',
      'default_password_reminder'
    )
  );

-- Step 3: Create overloaded update_notification_cooldown with custom cooldown hours
-- The existing 2-param version (UUID, TEXT) stays untouched for backward compat.
-- This new 3-param version allows callers to specify custom cooldown hours
-- (e.g., 720 hours = 30 days for the password reminder).
CREATE OR REPLACE FUNCTION public.update_notification_cooldown(
    p_user_id UUID,
    p_notification_type TEXT,
    p_cooldown_hours INTEGER
) RETURNS void AS $$
BEGIN
    INSERT INTO public.notification_cooldowns (
        user_id, notification_type, last_sent_at, cooldown_hours,
        sent_today_count, count_reset_date
    )
    VALUES (
        p_user_id, p_notification_type, NOW(), p_cooldown_hours,
        1, CURRENT_DATE
    )
    ON CONFLICT (user_id, notification_type) DO UPDATE SET
        last_sent_at = NOW(),
        cooldown_hours = p_cooldown_hours,
        sent_today_count = CASE
            WHEN notification_cooldowns.count_reset_date = CURRENT_DATE
            THEN notification_cooldowns.sent_today_count + 1
            ELSE 1
        END,
        count_reset_date = CURRENT_DATE,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = '';

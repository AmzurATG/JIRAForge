-- ============================================================================
-- Migration: Approval-digest notification support
-- Date: 2026-04-21
--
-- Two small, additive changes that let the approval-pending email digest
-- (see ai-server Phase 6) flow through the existing notification pipeline:
--
--   1. Per-user opt-out flag on notification_preferences.
--   2. Extend notification_logs.valid_notification_type CHECK to accept the
--      new 'approval_pending_digest' type, following the same DROP + recreate
--      idiom already used by 20260302 and 20260405.
--
-- No existing rows or constraints are destructively altered. Historical
-- preferences rows get approval_pending_digest_enabled = TRUE by column default,
-- which matches the "notify by default, let the user opt out" policy used
-- for every other notification type in this table.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Per-user opt-out flag for approval-pending digests
-- ----------------------------------------------------------------------------
ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS approval_pending_digest_enabled BOOLEAN DEFAULT TRUE;

COMMENT ON COLUMN public.notification_preferences.approval_pending_digest_enabled IS
  'When TRUE (default), user receives a daily email digest while they have activity records awaiting their approval.';

-- ----------------------------------------------------------------------------
-- 2. Extend notification_logs CHECK constraint to accept the new type
--    (copy of the list from 20260405 + one new entry)
-- ----------------------------------------------------------------------------
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
      'default_password_reminder',
      'approval_pending_digest'
    )
  );

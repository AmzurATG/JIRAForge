-- Migration: Add password reset columns to portal_admin_users
-- Date: 2026-05-25
-- Description: Adds reset_token and reset_token_expires_at columns for forgot password functionality

-- Add password reset columns to portal_admin_users table
ALTER TABLE portal_admin_users
  ADD COLUMN IF NOT EXISTS reset_token TEXT,
  ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP WITH TIME ZONE;

-- Create index on reset_token for faster lookups
CREATE INDEX IF NOT EXISTS idx_portal_admin_users_reset_token 
  ON portal_admin_users(reset_token) 
  WHERE reset_token IS NOT NULL;

-- Add comment
COMMENT ON COLUMN portal_admin_users.reset_token IS 'Password reset token (set when user requests password reset, cleared after use)';
COMMENT ON COLUMN portal_admin_users.reset_token_expires_at IS 'Expiration timestamp for reset token (typically 1 hour from creation)';

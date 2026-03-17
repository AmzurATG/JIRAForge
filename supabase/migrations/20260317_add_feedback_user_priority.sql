-- Add user_priority column to feedback table
-- Allows users to set priority from the feedback form (overrides AI-suggested priority)
ALTER TABLE public.feedback
ADD COLUMN IF NOT EXISTS user_priority TEXT;

COMMENT ON COLUMN public.feedback.user_priority IS 'User-selected priority from feedback form (Highest, High, Medium, Low, Lowest). Overrides AI-suggested priority when set.';

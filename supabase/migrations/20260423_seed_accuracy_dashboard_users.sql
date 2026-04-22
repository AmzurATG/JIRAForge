-- =====================================================================
-- Seed accuracy_dashboard_users with the bootstrap allowlist that used
-- to live in ACCURACY_DASHBOARD_ALLOWED_EMAILS on the AI server.
--
-- Background: when the dashboard was migrated into the Forge app, the
-- env-var allowlist + its middleware were removed. The DB table is now
-- the single source of truth. This migration ports the original env
-- entries over so the same people keep access without manual SQL.
--
-- Idempotent: re-running this migration is a no-op (ON CONFLICT DO
-- NOTHING). Removing someone is a normal DELETE — they will not
-- reappear unless this migration is re-run AND they were dropped first.
--
-- Removable layer: drop along with the rest of the AI accuracy stack
-- (controller, resolver, tab) when the feature is retired.
-- =====================================================================

INSERT INTO public.accuracy_dashboard_users (email, added_by, notes) VALUES
  ('rajesh.talari@amzur.com',       'bootstrap-migration', 'Ported from ACCURACY_DASHBOARD_ALLOWED_EMAILS env var'),
  ('iswarya.kolimalla@amzur.com',   'bootstrap-migration', 'Ported from ACCURACY_DASHBOARD_ALLOWED_EMAILS env var'),
  ('vishnu.kanthamraju@amzur.com',  'bootstrap-migration', 'Ported from ACCURACY_DASHBOARD_ALLOWED_EMAILS env var')
ON CONFLICT (email) DO NOTHING;

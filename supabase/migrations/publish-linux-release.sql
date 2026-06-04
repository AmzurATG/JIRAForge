-- ============================================================================
-- Publish a Linux release into the existing app_releases table.
--
-- The app_releases table already has a `platform` column, and the existing
-- /api/app-version/check?platform=linux endpoint already queries it.
-- NO new table or endpoint is needed.
--
-- HOW TO USE:
--   1. Build:   cd python-desktop-app && ./build.sh
--
--   2. Upload ONE file to storage:
--        dist/timetracker_<version>_amd64.deb
--
--        New users:   download .deb → double-click → Ubuntu Software → Install → done.
--        Auto-update: the running app downloads this .deb and extracts the
--                     AppImage from it automatically (no root, no dpkg needed).
--
--   3. SHA-256 is for the .deb (build.sh prints it):
--        sha256sum dist/timetracker_<version>_amd64.deb
--
--   4. Fill in the placeholders below and run this SQL in Supabase SQL editor.
--
--   5. Any running Linux desktop app will pick up the update within 1 hour
--      (or immediately if the user restarts or clicks Check Updates).
-- ============================================================================

BEGIN;

-- ── Step 1: Deactivate the previous Linux release (if any) ──────────────────
UPDATE app_releases
SET    is_latest   = FALSE,
       is_active   = FALSE
WHERE  platform    = 'linux'
  AND  is_latest   = TRUE;

-- ── Step 2: Insert the new Linux release ─────────────────────────────────────
INSERT INTO app_releases (
    platform,
    version,
    download_url,
  checksum
)
VALUES (
    'linux',
  '1.0.0',                          -- ← replace with new version
  'https://example.com/path/to/timetracker_1.0.0_amd64.deb', -- ← .deb URL (same file for new users and auto-update)
  'abc123deadbeef...'               -- ← replace with sha256sum output
);

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT version, download_url, is_latest, is_active, published_at
FROM   app_releases
WHERE  platform = 'linux'
ORDER  BY published_at DESC
LIMIT  5;

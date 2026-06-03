-- ============================================================================
-- Publish a Linux release into the existing app_releases table.
--
-- The app_releases table already has a `platform` column, and the existing
-- /api/app-version/check?platform=linux endpoint already queries it.
-- NO new table or endpoint is needed.
--
-- HOW TO USE:
--   1. Build the Linux binary:  cd python-desktop-app && ./build.sh
--   2. Upload the AppImage to a public URL (GitHub Release, S3, etc.)
--   3. Compute the SHA-256 checksum:
--        sha256sum dist/TimeTracker-v<version>-<arch>.AppImage
--      (build.sh also prints the SHA256 for the generated AppImage)
--   5. Fill in the placeholders below and run this SQL in Supabase SQL editor
--      (or via psql).
--   6. Any running Linux desktop app will pick up the update within 1 hour
--      (or immediately if the user restarts the system or clicks Check Updates).
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
  'https://example.com/path/to/TimeTracker-v1.0.2-x86_64.AppImage', -- ← replace with public download URL
  'abc123deadbeef...'               -- ← replace with sha256sum output
);

COMMIT;

-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT version, download_url, is_latest, is_active, published_at
FROM   app_releases
WHERE  platform = 'linux'
ORDER  BY published_at DESC
LIMIT  5;

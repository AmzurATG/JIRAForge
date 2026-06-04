-- ============================================================================
-- Fix: add Debian package MIME types to the `releases` storage bucket.
--
-- The bucket was originally created with only application/octet-stream and
-- application/x-executable, which rejects .deb uploads with:
--   "Mime type application/vnd.debian.binary-package is not supported"
--
-- We add both the canonical RFC MIME type and the older alias used by some
-- tools so uploads succeed regardless of which type the client sends.
-- ============================================================================

UPDATE storage.buckets
SET allowed_mime_types = (
    SELECT array_agg(DISTINCT mime)
    FROM unnest(
        allowed_mime_types || ARRAY[
            'application/vnd.debian.binary-package',
            'application/x-debian-package'
        ]
    ) AS mime
)
WHERE id = 'releases';

-- Verify
SELECT id, allowed_mime_types
FROM   storage.buckets
WHERE  id = 'releases';

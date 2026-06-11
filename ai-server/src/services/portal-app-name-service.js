/**
 * Portal App Name Service
 *
 * Pure heuristic that turns a raw captured application identifier
 * (process/executable name, e.g. "ShellExperienceHost.exe",
 * "org.gnome.Nautilus") into a human-friendly display name for the
 * portal's app-discovery and Add Application surfaces.
 *
 * Best-effort by design: opaque executables ("msrdc.exe") stay close to
 * their identifier ("Msrdc") — the raw identifier is always shown
 * alongside and the name is editable before saving. Never throws; on
 * unusable input it echoes the trimmed input back.
 *
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md (WS-A, AC-A1)
 */

'use strict';

const MAX_LENGTH = 120;
const EXTENSION_RE = /\.(exe|app|bat|cmd|com|msi|appimage)$/i;

/**
 * Clean a raw application identifier into a display name.
 *
 * @param {*} identifier - raw captured identifier (usually a process name)
 * @returns {string} cleaned display name ('' for empty input)
 */
function cleanDisplayName(identifier) {
  const raw = identifier == null ? '' : String(identifier).trim();
  if (!raw) return '';

  let base = raw.replace(EXTENSION_RE, '');

  // Reverse-DNS style ids (org.gnome.Nautilus) -> last segment. Only for 3+
  // segments so two-part values ("notion.so") are left intact.
  const segments = base.split('.').filter(Boolean);
  if (segments.length >= 3) base = segments[segments.length - 1];

  // Separators to spaces, then split camelCase word boundaries.
  base = base.replace(/[_-]+/g, ' ');
  base = base.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Drop version-ish trailing digit runs on word tokens (idea64 -> idea).
  base = base.replace(/([A-Za-z]{3,})\d+\b/g, '$1');

  const words = base
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  const result = words.join(' ').slice(0, MAX_LENGTH).trim();
  return result || raw.slice(0, MAX_LENGTH);
}

module.exports = { cleanDisplayName };

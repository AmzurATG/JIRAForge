/**
 * Working-Location Detection Service (portal-only — never surfaced to Forge)
 *
 * Derives the approximate location an employee is CURRENTLY working from, by
 * looking up the client IP of their desktop app's (already ~hourly)
 * re-authentication requests against an OFFLINE GeoIP database (geoip-lite).
 * Refreshed at most every ~3h per user. Built for a work-from-anywhere
 * workforce — there is no office assumption.
 *
 * Privacy invariants (plan §0.1):
 *   - GeoIP is offline: the IP is never sent to a third party
 *   - the full client IP is never persisted; only a truncated prefix
 *     (/24 for IPv4, /64 for IPv6) is stored for audit
 *   - granularity is city/region/country only — never GPS coordinates
 *   - no log line in this module contains a full IP
 *
 * Plan: plan/2026-06-12_cross-component_automatic-employee-location-detection.md
 */

'use strict';

const net = require('net');
const geoip = require('geoip-lite');
const db = require('./db/portal-location-detection-db-service');
const logger = require('../utils/logger');

const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000; // re-detect at most every ~3h (plan: 3-4h cadence)

// ---------------------------------------------------------------------------
// IP helpers (pure; exported for tests)
// ---------------------------------------------------------------------------

/** Strip the IPv4-mapped-IPv6 wrapper Express produces behind some proxies. */
function normalizeIp(ip) {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  const unmapped = trimmed.toLowerCase().startsWith('::ffff:') && net.isIP(trimmed.slice(7)) === 4
    ? trimmed.slice(7)
    : trimmed;
  return net.isIP(unmapped) ? unmapped : null;
}

/**
 * Private / loopback / link-local / CGNAT addresses carry no useful public
 * geolocation — skip them rather than store a meaningless reading.
 */
function isPublicIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false; // link-local
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
    return true;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return false;            // loopback
    if (lower.startsWith('fe80')) return false;   // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // unique-local
    return true;
  }
  return false;
}

/** Truncate an IP to its stored audit prefix: /24 (IPv4) or /64 (IPv6). */
function truncateIpPrefix(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const o = ip.split('.');
    return `${o[0]}.${o[1]}.${o[2]}.0/24`;
  }
  if (family === 6) {
    // Keep the first four hextets (the /64 network), zero the rest.
    const expanded = expandIpv6(ip);
    if (!expanded) return null;
    return `${expanded.slice(0, 4).join(':')}::/64`;
  }
  return null;
}

/** Expand an IPv6 string into its 8 hextet strings, or null if malformed. */
function expandIpv6(ip) {
  if (net.isIP(ip) !== 6) return null;
  const [head, tail = ''] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  let groups;
  if (ip.includes('::')) {
    const missing = 8 - headGroups.length - tailGroups.length;
    groups = [...headGroups, ...Array(Math.max(missing, 0)).fill('0'), ...tailGroups];
  } else {
    groups = headGroups;
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => (g || '0'));
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Look up + upsert the approximate working location for a user from a client
 * IP. Called fire-and-forget from the desktop auth paths — callers attach
 * .catch(); this also never throws for invalid/private input, only for
 * unexpected DB failures.
 *
 * @returns {Promise<object|null>} the work-location row, or null when skipped
 */
async function recordWorkingLocation(userId, rawIp) {
  if (!userId) return null;
  const ip = normalizeIp(rawIp);
  if (!ip || !isPublicIp(ip)) return null; // plan: private/loopback/CGNAT carry no public geo

  // Throttle: re-detect at most every ~3h (plan 3-4h cadence). Cheap single read.
  const existing = await db.getWorkLocationByUserId(userId);
  if (existing && existing.detected_at) {
    const age = Date.now() - new Date(existing.detected_at).getTime();
    if (age < REFRESH_INTERVAL_MS) return null;
  }

  const geo = geoip.lookup(ip);
  if (!geo) return null; // unknown IP (DB miss) — store nothing rather than a blank reading

  return db.upsertWorkLocation({
    userId,
    city: geo.city || null,
    region: geo.region || null,
    country: geo.country || null,
    ipPrefix: truncateIpPrefix(ip),
    source: 'geoip',
  });
}

// ---------------------------------------------------------------------------
// Portal-facing reads
// ---------------------------------------------------------------------------

/** Map of user_id -> { city, region, country, detectedAt } for the Employees list. */
async function getWorkLocationMapForUsers(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return {};
  const rows = await db.getWorkLocationsByUserIds(userIds);
  const map = {};
  for (const row of rows) {
    map[row.user_id] = {
      city: row.city,
      region: row.region,
      country: row.country,
      detectedAt: row.detected_at,
    };
  }
  return map;
}

module.exports = {
  recordWorkingLocation,
  getWorkLocationMapForUsers,
  // pure helpers exported for unit tests
  normalizeIp,
  isPublicIp,
  truncateIpPrefix,
};

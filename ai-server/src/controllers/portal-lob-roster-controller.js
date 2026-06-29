/**
 * Portal LOB Roster Controller (adoption tracking)
 *
 * Import / read / delete of a LOB's email-keyed expected-member roster.
 * Authentication is handled by portal-auth middleware (req.portalUser).
 * Authorization (mirrors the LOB member routes):
 *   - import roster / delete entry → superadmin only
 *   - read roster (union + install status) → superadmin or a head of the LOB
 *
 * Spec: plan/2026-06-26_web-productivity-portal_lob-roster-adoption.md
 */

'use strict';

const logger = require('../utils/logger');
const lobService = require('../services/portal-lob-service');
const rosterService = require('../services/portal-lob-roster-service');

function fail(res, error, prefix) {
  const status = error.status || 500;
  if (status >= 500) logger.error(`${prefix} failed`, error);
  else logger.warn(`${prefix} rejected`, { error: error.message });
  return res.status(status).json({ success: false, error: error.message });
}

function isSuperadmin(req) {
  return req.portalUser && req.portalUser.role === 'superadmin';
}

/**
 * POST /api/portal/lobs/:lobId/roster/import
 * Body: { filename, contentBase64 } — the uploaded .xlsx/.csv, base64-encoded.
 */
async function importRoster(req, res) {
  try {
    if (!isSuperadmin(req)) {
      return res.status(403).json({ success: false, error: 'Only superadmin can import a roster' });
    }
    const { filename, contentBase64 } = req.body || {};
    const summary = await rosterService.importRoster(
      req.params.lobId,
      { filename, contentBase64 },
      req.portalUser.userId
    );
    return res.json({ success: true, ...summary });
  } catch (error) {
    return fail(res, error, '[PortalLobRoster] importRoster');
  }
}

/**
 * GET /api/portal/lobs/:lobId/roster
 * Union of imported roster + existing members, each with a derived install flag.
 */
async function getRoster(req, res) {
  try {
    const { lobId } = req.params;
    const scope = await lobService.resolveScope(req.portalUser);
    if (!lobService.canAccessLob(scope, lobId)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for this LOB' });
    }
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const result = await rosterService.getRoster(lobId, { page, limit, search: req.query.search });
    return res.json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, '[PortalLobRoster] getRoster');
  }
}

/** DELETE /api/portal/lobs/:lobId/roster/:id — remove one imported roster entry. */
async function removeRosterEntry(req, res) {
  try {
    if (!isSuperadmin(req)) {
      return res.status(403).json({ success: false, error: 'Only superadmin can remove a roster entry' });
    }
    await rosterService.removeRosterEntry(req.params.lobId, req.params.id);
    return res.json({ success: true, message: 'Roster entry removed' });
  } catch (error) {
    return fail(res, error, '[PortalLobRoster] removeRosterEntry');
  }
}

module.exports = {
  importRoster,
  getRoster,
  removeRosterEntry,
};

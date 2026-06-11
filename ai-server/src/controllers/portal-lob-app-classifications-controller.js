/**
 * Portal LOB App Classifications Controller
 *
 * Per-LOB classification of catalog apps. Allowed for a superadmin (any LOB) or
 * the head of the target LOB (their own LOBs only). Scope is resolved per
 * request, so head removal revokes access immediately.
 */

'use strict';

const logger = require('../utils/logger');
const lobService = require('../services/portal-lob-service');
const portalService = require('../services/portal-service');
const appNameService = require('../services/portal-app-name-service');

/** Default discovery window (days) for "apps used but not yet classified". */
const UNLISTED_LOOKBACK_DAYS = 30;
const UNLISTED_LIMIT = 50;

function fail(res, error, prefix) {
  const status = error.status || 500;
  if (status >= 500) logger.error(`${prefix} failed`, error);
  else logger.warn(`${prefix} rejected`, { error: error.message });
  return res.status(status).json({ success: false, error: error.message });
}

/** Resolve scope and ensure the caller may manage this LOB; returns true if OK. */
async function ensureLobAccess(req, res) {
  const scope = await lobService.resolveScope(req.portalUser);
  if (!lobService.canAccessLob(scope, req.params.lobId)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions for this LOB' });
    return false;
  }
  return true;
}

async function getClassifications(req, res) {
  try {
    if (!(await ensureLobAccess(req, res))) return undefined;
    const data = await lobService.listLobClassifications(req.params.lobId, {
      search: req.query.search,
      classification: req.query.classification,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, '[PortalLobAppClass] getClassifications');
  }
}

/**
 * Add an application to this LOB (find-or-create catalog entry + set this LOB's
 * classification). Allowed for superadmin or the LOB head.
 */
async function addApp(req, res) {
  try {
    if (!(await ensureLobAccess(req, res))) return undefined;
    const { identifier, displayName, matchBy, classification } = req.body;
    const row = await lobService.addLobApp(
      req.params.lobId,
      { identifier, displayName, matchBy, classification },
      req.portalUser.userId
    );
    return res.status(201).json({ success: true, data: row });
  } catch (error) {
    return fail(res, error, '[PortalLobAppClass] addApp');
  }
}

/**
 * Apps this LOB's members actually used (recent window) that are NOT yet in the
 * catalog — so heads/superadmins can discover and classify what the seed list
 * missed. Reuses the app-usage aggregate; excludes already-cataloged identifiers.
 */
async function getUnlistedApps(req, res) {
  try {
    if (!(await ensureLobAccess(req, res))) return undefined;
    const lobId = req.params.lobId;

    const userIds = await lobService.userIdsForLobs([lobId]);
    if (!userIds.length) return res.json({ success: true, data: [] });

    // Default to the last N days unless the caller overrides from/to.
    let { from, to } = req.query;
    if (!from || !to) {
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - UNLISTED_LOOKBACK_DAYS);
      const fmt = (d) => d.toISOString().split('T')[0];
      from = from || fmt(fromDate);
      to = to || fmt(toDate);
    }

    const usage = await portalService.getApplicationUsage(req.portalUser.orgId, { from, to }, userIds);

    // Exclude anything already in the catalog (matched by identifier).
    const catalog = await lobService.listCatalog({ includeInactive: true, limit: 1000 });
    const known = new Set((catalog.data || []).map((a) => (a.identifier || '').toLowerCase()));

    const unlisted = (usage.data || [])
      .filter((u) => u.applicationName && !known.has(u.applicationName.toLowerCase()))
      .slice(0, UNLISTED_LIMIT)
      .map((u) => ({
        identifier: u.applicationName,
        displayName: appNameService.cleanDisplayName(u.applicationName),
        totalHours: u.totalHours,
        sessionCount: u.sessionCount,
        employeeCount: u.employeeCount,
      }));

    return res.json({ success: true, data: unlisted });
  } catch (error) {
    return fail(res, error, '[PortalLobAppClass] getUnlistedApps');
  }
}

async function setClassification(req, res) {
  try {
    if (!(await ensureLobAccess(req, res))) return undefined;
    const { appId, classification } = req.body;
    const row = await lobService.setLobClassification(req.params.lobId, appId, classification, req.portalUser.userId);
    return res.json({ success: true, data: row });
  } catch (error) {
    return fail(res, error, '[PortalLobAppClass] setClassification');
  }
}

async function deleteClassification(req, res) {
  try {
    if (!(await ensureLobAccess(req, res))) return undefined;
    await lobService.deleteLobClassification(req.params.lobId, req.params.appId);
    return res.json({ success: true, message: 'Classification cleared' });
  } catch (error) {
    return fail(res, error, '[PortalLobAppClass] deleteClassification');
  }
}

async function bulkSet(req, res) {
  try {
    if (!(await ensureLobAccess(req, res))) return undefined;
    const result = await lobService.bulkSetLobClassifications(req.params.lobId, req.body.items, req.portalUser.userId);
    return res.json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, '[PortalLobAppClass] bulkSet');
  }
}

module.exports = { getClassifications, addApp, getUnlistedApps, setClassification, deleteClassification, bulkSet };

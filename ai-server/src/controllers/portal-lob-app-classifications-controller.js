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

module.exports = { getClassifications, setClassification, deleteClassification, bulkSet };

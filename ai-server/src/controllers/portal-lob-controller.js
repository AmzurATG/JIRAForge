/**
 * Portal LOB Controller
 *
 * LOB CRUD + member (employee) assignment + head assignment.
 * Authentication is handled by portal-auth middleware (req.portalUser).
 * Authorization:
 *   - create/update/delete LOB, add/remove members, add/remove heads → superadmin only
 *   - list LOBs / list members → superadmin or a head of the LOB (scoped)
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

function isSuperadmin(req) {
  return req.portalUser && req.portalUser.role === 'superadmin';
}

// --- LOBs -------------------------------------------------------------------

async function getLobs(req, res) {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const scope = await lobService.resolveScope(req.portalUser);
    const lobs = await lobService.listLobsForScope(scope, { includeInactive });
    return res.json({ success: true, data: lobs });
  } catch (error) {
    return fail(res, error, '[PortalLob] getLobs');
  }
}

async function createLob(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can create LOBs' });
    const { name, description } = req.body;
    const lob = await lobService.createLob({ name, description }, req.portalUser.userId);
    return res.status(201).json({ success: true, data: lob });
  } catch (error) {
    return fail(res, error, '[PortalLob] createLob');
  }
}

async function updateLob(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can update LOBs' });
    const { name, description, isActive } = req.body;
    const lob = await lobService.updateLob(req.params.lobId, { name, description, isActive });
    return res.json({ success: true, data: lob });
  } catch (error) {
    return fail(res, error, '[PortalLob] updateLob');
  }
}

async function deleteLob(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can delete LOBs' });
    await lobService.deleteLob(req.params.lobId);
    return res.json({ success: true, message: 'LOB deleted successfully' });
  } catch (error) {
    return fail(res, error, '[PortalLob] deleteLob');
  }
}

// --- Members ----------------------------------------------------------------

async function getMembers(req, res) {
  try {
    const { lobId } = req.params;
    const scope = await lobService.resolveScope(req.portalUser);
    if (!lobService.canAccessLob(scope, lobId)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for this LOB' });
    }
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const result = await lobService.listMembers(lobId, { page, limit, search: req.query.search });
    return res.json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, '[PortalLob] getMembers');
  }
}

async function addMembers(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can assign members' });
    const { userIds } = req.body;
    const result = await lobService.addMembers(req.params.lobId, userIds, req.portalUser.userId);
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, '[PortalLob] addMembers');
  }
}

async function removeMember(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can remove members' });
    await lobService.removeMember(req.params.lobId, req.params.userId);
    return res.json({ success: true, message: 'Member removed' });
  } catch (error) {
    return fail(res, error, '[PortalLob] removeMember');
  }
}

// --- Heads ------------------------------------------------------------------

async function getHeads(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can view heads' });
    const heads = await lobService.listHeads(req.params.lobId);
    return res.json({ success: true, data: heads });
  } catch (error) {
    return fail(res, error, '[PortalLob] getHeads');
  }
}

async function addHeads(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can assign heads' });
    const { adminIds } = req.body;
    const result = await lobService.addHeads(req.params.lobId, adminIds, req.portalUser.userId);
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, '[PortalLob] addHeads');
  }
}

async function removeHead(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can remove heads' });
    await lobService.removeHead(req.params.lobId, req.params.adminId);
    return res.json({ success: true, message: 'Head removed' });
  } catch (error) {
    return fail(res, error, '[PortalLob] removeHead');
  }
}

module.exports = {
  getLobs,
  createLob,
  updateLob,
  deleteLob,
  getMembers,
  addMembers,
  removeMember,
  getHeads,
  addHeads,
  removeHead,
};

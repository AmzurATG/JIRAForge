/**
 * Portal Employee Profile Controller (WS-B — Employee Location)
 *
 * Locations: read for any authenticated portal user (filter dropdowns);
 * create/update/delete superadmin-only. Employee location assignment is
 * superadmin-only. Authentication handled by portal-auth middleware.
 *
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md (WS-B)
 */

'use strict';

const logger = require('../utils/logger');
const profileService = require('../services/portal-employee-profile-service');

function fail(res, error, prefix) {
  const status = error.status || 500;
  if (status >= 500) logger.error(`${prefix} failed`, error);
  else logger.warn(`${prefix} rejected`, { error: error.message });
  return res.status(status).json({ success: false, error: error.message });
}

function isSuperadmin(req) {
  return req.portalUser && req.portalUser.role === 'superadmin';
}

// --- Locations ---------------------------------------------------------------

async function getLocations(req, res) {
  try {
    const locations = await profileService.listLocations({
      includeInactive: req.query.includeInactive === 'true',
    });
    return res.json({
      success: true,
      data: locations.map((l) => ({ id: l.id, name: l.name, isActive: l.is_active })),
    });
  } catch (error) {
    return fail(res, error, '[PortalProfile] getLocations');
  }
}

async function createLocation(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can manage locations' });
    const location = await profileService.createLocation(req.body.name, req.portalUser.userId);
    return res.status(201).json({ success: true, data: { id: location.id, name: location.name, isActive: location.is_active } });
  } catch (error) {
    return fail(res, error, '[PortalProfile] createLocation');
  }
}

async function updateLocation(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can manage locations' });
    const { name, isActive } = req.body;
    const location = await profileService.updateLocation(req.params.id, { name, isActive });
    return res.json({ success: true, data: { id: location.id, name: location.name, isActive: location.is_active } });
  } catch (error) {
    return fail(res, error, '[PortalProfile] updateLocation');
  }
}

async function deleteLocation(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can manage locations' });
    await profileService.deleteLocation(req.params.id);
    return res.json({ success: true, message: 'Location deleted' });
  } catch (error) {
    return fail(res, error, '[PortalProfile] deleteLocation');
  }
}

// --- Employee profile ----------------------------------------------------------

async function setEmployeeProfile(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can edit employee profiles' });
    const { locationId } = req.body;
    const profile = await profileService.setEmployeeLocation(
      req.params.userId,
      locationId === undefined ? null : locationId,
      req.portalUser.userId
    );
    return res.json({ success: true, data: profile });
  } catch (error) {
    return fail(res, error, '[PortalProfile] setEmployeeProfile');
  }
}

const BULK_ASSIGN_MAX = 500;

/** Bulk location assignment (action bar / location members picker). */
async function bulkSetEmployeeProfiles(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can edit employee profiles' });
    const { userIds, locationId } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, error: 'userIds array is required' });
    }
    if (userIds.length > BULK_ASSIGN_MAX) {
      return res.status(400).json({ success: false, error: `Too many employees in one request (max ${BULK_ASSIGN_MAX})` });
    }
    const result = await profileService.setEmployeeLocations(
      userIds,
      locationId === undefined ? null : locationId,
      req.portalUser.userId
    );
    return res.json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, '[PortalProfile] bulkSetEmployeeProfiles');
  }
}

module.exports = {
  getLocations,
  createLocation,
  updateLocation,
  deleteLocation,
  setEmployeeProfile,
  bulkSetEmployeeProfiles,
};

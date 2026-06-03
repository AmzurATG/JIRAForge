/**
 * Portal App Catalog Controller
 *
 * The shared list of applications (desktop/process + browser/url). Any
 * authenticated portal user may READ the catalog (to populate pickers);
 * add / update / delete / bulk-import are superadmin-only.
 */

'use strict';

const logger = require('../utils/logger');
const lobService = require('../services/portal-lob-service');
const appSuggestService = require('../services/portal-app-suggest-service');

function fail(res, error, prefix) {
  const status = error.status || 500;
  if (status >= 500) logger.error(`${prefix} failed`, error);
  else logger.warn(`${prefix} rejected`, { error: error.message });
  return res.status(status).json({ success: false, error: error.message });
}

function isSuperadmin(req) {
  return req.portalUser && req.portalUser.role === 'superadmin';
}

async function getCatalog(req, res) {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 100;
    const result = await lobService.listCatalog({
      search: req.query.search,
      matchBy: req.query.match_by,
      includeInactive: req.query.includeInactive === 'true',
      page,
      limit,
    });
    return res.json({ success: true, data: result.data, pagination: { page, limit, totalCount: result.totalCount } });
  } catch (error) {
    return fail(res, error, '[PortalAppCatalog] getCatalog');
  }
}

async function createApp(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can add applications' });
    const { identifier, displayName, matchBy, defaultClassification } = req.body;
    const app = await lobService.createCatalogApp({ identifier, displayName, matchBy, defaultClassification }, req.portalUser.userId);
    return res.status(201).json({ success: true, data: app });
  } catch (error) {
    return fail(res, error, '[PortalAppCatalog] createApp');
  }
}

async function updateApp(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can edit applications' });
    const { displayName, defaultClassification, isActive } = req.body;
    const app = await lobService.updateCatalogApp(req.params.id, { displayName, defaultClassification, isActive });
    return res.json({ success: true, data: app });
  } catch (error) {
    return fail(res, error, '[PortalAppCatalog] updateApp');
  }
}

async function deleteApp(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can delete applications' });
    await lobService.deleteCatalogApp(req.params.id);
    return res.json({ success: true, message: 'Application deleted' });
  } catch (error) {
    return fail(res, error, '[PortalAppCatalog] deleteApp');
  }
}

async function bulkImport(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can bulk import applications' });
    const result = await lobService.bulkImportCatalog(req.body.data, req.portalUser.userId);
    return res.json({ success: true, ...result });
  } catch (error) {
    return fail(res, error, '[PortalAppCatalog] bulkImport');
  }
}

/**
 * AI-assisted suggestion for the "Add Application" modal. Any authenticated
 * portal user (superadmin or LOB head) may use it — it only proposes values.
 * Returns { available, suggestions }. When the flag is off, available=false and
 * suggestions=null so the UI can hide the AI button. Never errors the modal:
 * provider/parse failures resolve to suggestions=null.
 */
async function aiSuggest(req, res) {
  try {
    if (!appSuggestService.isEnabled()) {
      return res.json({ success: true, available: false, suggestions: null });
    }
    const { name } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    const suggestions = await appSuggestService.suggestApp(name);
    return res.json({ success: true, available: true, suggestions });
  } catch (error) {
    // Advisory feature — degrade gracefully to manual entry instead of erroring.
    logger.warn('[PortalAppCatalog] aiSuggest failed', { error: error.message });
    return res.json({ success: true, available: true, suggestions: null });
  }
}

module.exports = { getCatalog, createApp, updateApp, deleteApp, bulkImport, aiSuggest };

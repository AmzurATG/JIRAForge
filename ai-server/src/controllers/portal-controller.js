/**
 * Portal Controller
 * 
 * Handles dashboard, employees, and time logs endpoints.
 */

'use strict';

const logger = require('../utils/logger');
const portalService = require('../services/portal-service');
const lobService = require('../services/portal-lob-service');

/** LOB scoping is only enforced when the flag is on (safe rollout). */
function lobEnforced() {
  return process.env.PORTAL_LOB_ENFORCEMENT === 'on';
}

/**
 * Resolve the employee user_ids the caller may see.
 * - null  → no restriction (scoping off, or superadmin)
 * - array → restrict to these employees (empty array ⇒ sees nothing)
 * Honors an optional ?lobId filter; throws (status 403) if it's out of scope.
 */
async function resolveVisibleUserIds(req) {
  if (!lobEnforced()) return null;
  const scope = await lobService.resolveScope(req.portalUser);
  const { lobId } = req.query;
  if (lobId) {
    if (!lobService.canAccessLob(scope, lobId)) {
      const e = new Error('Insufficient permissions for this LOB');
      e.status = 403;
      throw e;
    }
    return lobService.userIdsForLobs([lobId]);
  }
  return scope.visibleUserIds;
}

/**
 * Get dashboard data (KPIs + trend chart).
 * 
 * GET /api/portal/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
async function getDashboard(req, res) {
  try {
    const { orgId } = req.portalUser;
    const { from, to } = req.query;
    
    // Validation
    if (!from || !to) {
      return res.status(400).json({ 
        success: false, 
        error: 'from and to dates are required' 
      });
    }
    
    // Get dashboard data (scoped to the caller's LOB employees when enforced)
    const visibleUserIds = await resolveVisibleUserIds(req);
    const dashboardData = await portalService.getDashboardData(orgId, from, to, visibleUserIds);

    return res.json({
      success: true,
      data: dashboardData
    });

  } catch (error) {
    logger.error('[Portal] Get dashboard failed', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Get simple employees list for dropdowns (no metrics, fast).
 * 
 * GET /api/portal/employees/list?search=
 */
async function getEmployeesList(req, res) {
  try {
    const { orgId } = req.portalUser;
    const { search } = req.query;
    
    logger.info('[Portal] getEmployeesList called', { orgId, search });
    
    const visibleUserIds = await resolveVisibleUserIds(req);
    const employees = await portalService.getEmployeesList(orgId, search, visibleUserIds);

    logger.info('[Portal] getEmployeesList success', { orgId, count: employees.length });

    return res.json({
      success: true,
      data: employees
    });

  } catch (error) {
    logger.error('[Portal] Get employees list failed', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Get employees list with filters and pagination.
 * 
 * GET /api/portal/employees?search=&productivityRange=&from=&to=&page=&limit=
 */
async function getEmployees(req, res) {
  const startTime = Date.now();
  try {
    const { orgId } = req.portalUser;
    const { search, productivityRange, from, to, page = 1, limit = 20 } = req.query;
    
    const filters = { search, productivityRange, from, to };
    const pagination = { page: parseInt(page), limit: parseInt(limit) };
    
    logger.info('[Portal] getEmployees called', { orgId, filters, pagination });

    const visibleUserIds = await resolveVisibleUserIds(req);
    const result = await portalService.getEmployees(orgId, filters, pagination, visibleUserIds);

    const duration = Date.now() - startTime;
    logger.info('[Portal] getEmployees success', { orgId, count: result.data?.length, duration: `${duration}ms` });
    
    return res.json({ 
      success: true, 
      ...result
    });
    
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('[Portal] Get employees failed', { error: error.message, duration: `${duration}ms` });
    return res.status(error.status || 500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Get employee detail with daily trend.
 * 
 * GET /api/portal/employees/:userId?from=&to=
 */
async function getEmployeeDetail(req, res) {
  try {
    const { orgId } = req.portalUser;
    const { userId } = req.params;
    const { from, to } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId is required' 
      });
    }
    
    if (!from || !to) {
      return res.status(400).json({ 
        success: false, 
        error: 'from and to dates are required' 
      });
    }
    
    // Enforce that the requested employee is within the caller's LOB scope.
    const visibleUserIds = await resolveVisibleUserIds(req);
    if (Array.isArray(visibleUserIds) && !visibleUserIds.includes(userId)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for this employee' });
    }

    const employeeDetail = await portalService.getEmployeeDetail(orgId, userId, from, to);

    return res.json({
      success: true,
      data: employeeDetail
    });

  } catch (error) {
    logger.error('[Portal] Get employee detail failed', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Get employee activity logs.
 * 
 * GET /api/portal/employees/:userId/logs?classification=&from=&to=&page=&limit=
 */
async function getEmployeeLogs(req, res) {
  try {
    const { orgId } = req.portalUser;
    const { userId } = req.params;
    const { classification, from, to, page = 1, limit = 20 } = req.query;
    
    if (!userId) {
      return res.status(400).json({ 
        success: false, 
        error: 'userId is required' 
      });
    }
    
    // Enforce that the requested employee is within the caller's LOB scope.
    const visibleUserIds = await resolveVisibleUserIds(req);
    if (Array.isArray(visibleUserIds) && !visibleUserIds.includes(userId)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for this employee' });
    }

    // Reuse getTimeLogs with employee filter
    const filters = { classification, employee: userId, from, to };
    const pagination = { page: parseInt(page), limit: parseInt(limit) };

    const result = await portalService.getTimeLogs(orgId, filters, pagination, visibleUserIds);

    return res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('[Portal] Get employee logs failed', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Get time logs for all employees with filters.
 * 
 * GET /api/portal/time-logs?classification=&employee=&app=&from=&to=&durationMin=&durationMax=&confidenceMin=&confidenceMax=&page=&limit=
 */
async function getTimeLogs(req, res) {
  try {
    const { orgId } = req.portalUser;
    const { classification, employee, app, from, to, durationMin, durationMax, confidenceMin, confidenceMax, page = 1, limit = 20 } = req.query;
    
    logger.info('[Portal] getTimeLogs called', { orgId, from, to, page, limit });
    
    const filters = { classification, employee, app, from, to, durationMin, durationMax, confidenceMin, confidenceMax };
    const pagination = { page: parseInt(page), limit: parseInt(limit) };

    const visibleUserIds = await resolveVisibleUserIds(req);
    const result = await portalService.getTimeLogs(orgId, filters, pagination, visibleUserIds);

    logger.info('[Portal] getTimeLogs success', { orgId, count: result.data?.length });

    return res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('[Portal] Get time logs failed', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message
    });
  }
}

module.exports = {
  getDashboard,
  getEmployees,
  getEmployeesList,
  getEmployeeDetail,
  getEmployeeLogs,
  getTimeLogs
};

/**
 * Portal Controller
 * 
 * Handles dashboard, employees, and time logs endpoints.
 */

'use strict';

const logger = require('../utils/logger');
const portalService = require('../services/portal-service');

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
    
    // Get dashboard data
    const dashboardData = await portalService.getDashboardData(orgId, from, to);
    
    return res.json({ 
      success: true, 
      data: dashboardData
    });
    
  } catch (error) {
    logger.error('[Portal] Get dashboard failed', error);
    return res.status(500).json({ 
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
  try {
    const { orgId } = req.portalUser;
    const { search, productivityRange, from, to, page = 1, limit = 20 } = req.query;
    
    const filters = { search, productivityRange, from, to };
    const pagination = { page: parseInt(page), limit: parseInt(limit) };
    
    const result = await portalService.getEmployees(orgId, filters, pagination);
    
    return res.json({ 
      success: true, 
      ...result
    });
    
  } catch (error) {
    logger.error('[Portal] Get employees failed', error);
    return res.status(500).json({ 
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
    
    const employeeDetail = await portalService.getEmployeeDetail(orgId, userId, from, to);
    
    return res.json({ 
      success: true, 
      data: employeeDetail
    });
    
  } catch (error) {
    logger.error('[Portal] Get employee detail failed', error);
    return res.status(500).json({ 
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
    
    // Reuse getTimeLogs with employee filter
    const filters = { classification, employee: userId, from, to };
    const pagination = { page: parseInt(page), limit: parseInt(limit) };
    
    const result = await portalService.getTimeLogs(orgId, filters, pagination);
    
    return res.json({ 
      success: true, 
      ...result
    });
    
  } catch (error) {
    logger.error('[Portal] Get employee logs failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Get time logs for all employees with filters.
 * 
 * GET /api/portal/time-logs?classification=&employee=&app=&from=&to=&page=&limit=
 */
async function getTimeLogs(req, res) {
  try {
    const { orgId } = req.portalUser;
    const { classification, employee, app, from, to, page = 1, limit = 20 } = req.query;
    
    const filters = { classification, employee, app, from, to };
    const pagination = { page: parseInt(page), limit: parseInt(limit) };
    
    const result = await portalService.getTimeLogs(orgId, filters, pagination);
    
    return res.json({ 
      success: true, 
      ...result
    });
    
  } catch (error) {
    logger.error('[Portal] Get time logs failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

module.exports = {
  getDashboard,
  getEmployees,
  getEmployeeDetail,
  getEmployeeLogs,
  getTimeLogs
};

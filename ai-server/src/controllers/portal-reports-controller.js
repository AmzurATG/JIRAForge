/**
 * Portal Reports Controller
 * 
 * Handles report generation and export (CSV/PDF).
 */

'use strict';

const logger = require('../utils/logger');
const portalService = require('../services/portal-service');

/**
 * Get report data preview (first 20 rows).
 * 
 * GET /api/portal/reports/data?type=&filters...
 */
async function getReportData(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { type, classification, employee, from, to } = req.query;
    
    // Role check: only admin/superadmin can generate reports
    if (role === 'viewer') {
      return res.status(403).json({ 
        success: false, 
        error: 'Insufficient permissions to generate reports' 
      });
    }
    
    if (!type) {
      return res.status(400).json({ 
        success: false, 
        error: 'Report type is required' 
      });
    }
    
    // Currently only support 'activity-logs' report type
    if (type !== 'activity-logs') {
      return res.status(400).json({ 
        success: false, 
        error: 'Unsupported report type. Available: activity-logs' 
      });
    }
    
    // Get preview data (20 rows)
    const filters = { classification, employee, from, to };
    const result = await portalService.getTimeLogs(orgId, filters, { page: 1, limit: 20 });
    
    return res.json({ 
      success: true, 
      data: result.data,
      totalCount: result.pagination.totalCount
    });
    
  } catch (error) {
    logger.error('[PortalReports] Get report data failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Export report as CSV.
 * 
 * GET /api/portal/reports/export/csv?type=&filters...
 */
async function exportCSV(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { type, classification, employee, from, to } = req.query;
    
    // Role check
    if (role === 'viewer') {
      return res.status(403).json({ 
        success: false, 
        error: 'Insufficient permissions to export reports' 
      });
    }
    
    if (!type) {
      return res.status(400).json({ 
        success: false, 
        error: 'Report type is required' 
      });
    }
    
    if (type !== 'activity-logs') {
      return res.status(400).json({ 
        success: false, 
        error: 'Unsupported report type. Available: activity-logs' 
      });
    }
    
    // Get all data (no pagination - max 10000 rows for safety)
    const filters = { classification, employee, from, to };
    const result = await portalService.getTimeLogs(orgId, filters, { page: 1, limit: 10000 });
    
    // Generate CSV content
    const headers = ['Employee Name', 'Employee Email', 'Start Time', 'End Time', 'Application', 'Window Title', 'Duration (seconds)', 'Classification'];
    const csvRows = [headers.join(',')];
    
    result.data.forEach(log => {
      const row = [
        `\"${log.userName || ''}\"`,
        `\"${log.userEmail || ''}\"`,
        `\"${log.startTime || ''}\"`,
        `\"${log.endTime || ''}\"`,
        `\"${log.application || ''}\"`,
        `\"${(log.windowTitle || '').replace(/\"/g, '\"\"')}\"`, // Escape quotes
        log.durationSeconds || 0,
        `\"${log.classification || ''}\"`
      ];
      csvRows.push(row.join(','));
    });
    
    const csvContent = csvRows.join('\\n');
    
    // Set headers for CSV download
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `activity-logs-${timestamp}.csv`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=\"${filename}\"`);
    res.send(csvContent);
    
  } catch (error) {
    logger.error('[PortalReports] Export CSV failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Export report as PDF.
 * 
 * GET /api/portal/reports/export/pdf?type=&filters...
 */
async function exportPDF(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { type } = req.query;
    
    // Role check
    if (role === 'viewer') {
      return res.status(403).json({ 
        success: false, 
        error: 'Insufficient permissions to export reports' 
      });
    }
    
    if (!type) {
      return res.status(400).json({ 
        success: false, 
        error: 'Report type is required' 
      });
    }
    
    // TODO: Implement PDF export
    // 1. Generate PDF with jsPDF or pdfkit
    // 2. Set headers: Content-Type: application/pdf, Content-Disposition: attachment
    // 3. Stream PDF to response
    
    return res.status(501).json({ 
      success: false, 
      error: 'PDF export not yet implemented' 
    });
    
  } catch (error) {
    logger.error('[PortalReports] Export PDF failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

module.exports = {
  getReportData,
  exportCSV,
  exportPDF
};

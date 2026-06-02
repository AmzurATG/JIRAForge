/**
 * Portal Reports Controller
 * 
 * Handles report generation and export (CSV/PDF).
 */

'use strict';

const logger = require('../utils/logger');
const portalService = require('../services/portal-service');
const lobService = require('../services/portal-lob-service');
const PDFDocument = require('pdfkit');

const SUPPORTED_REPORT_TYPES = ['activity-logs', 'daily-summary', 'employee-summary', 'application-usage'];

/** LOB scoping is only enforced when the flag is on (safe rollout). */
function lobEnforced() {
  return process.env.PORTAL_LOB_ENFORCEMENT === 'on';
}

/**
 * Resolve the employee user_ids the caller may see for reports.
 * null → no restriction; array → restrict (empty ⇒ nothing). Honors ?lobId.
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
 * Get report data based on type.
 */
async function getReportDataByType(orgId, type, filters, visibleUserIds, options = {}) {
  const { fetchAll = false } = options;
  switch (type) {
    case 'daily-summary':
      return getDailySummaryData(orgId, filters, visibleUserIds);
    case 'employee-summary':
      return getEmployeeSummaryData(orgId, filters, visibleUserIds);
    case 'application-usage':
      return getApplicationUsageData(orgId, filters, visibleUserIds);
    default: // activity-logs (raw rows)
      // fetchAll → walk pages for a complete export; otherwise one page is enough
      // for the on-screen preview (which slices to the requested page anyway).
      return fetchAll
        ? portalService.getAllTimeLogs(orgId, filters, visibleUserIds)
        : portalService.getTimeLogs(orgId, filters, { page: 1, limit: 10000 }, visibleUserIds);
  }
}

/**
 * Get daily summary data - aggregated hours per day.
 * If employee filter is provided, shows daily data for that specific employee.
 */
async function getDailySummaryData(orgId, filters, visibleUserIds) {
  const { from, to, employee } = filters;

  // Both the all-employees and single-employee cases now use the server-side
  // dashboard aggregate (which fixed the 1000-row undercount and gives a
  // consistent productive-vs-non-productive ratio). When an employee is
  // requested, scope to just that user; if they're outside the caller's LOB
  // scope, the user set is empty and the result is empty.
  let userIds = visibleUserIds;
  if (employee) {
    userIds = Array.isArray(visibleUserIds)
      ? (visibleUserIds.includes(employee) ? [employee] : [])
      : [employee];
  }

  const dashboardData = await portalService.getDashboardData(orgId, from, to, userIds);

  const data = dashboardData.dailyTrend.map(day => ({
    date: day.date,
    productiveHours: day.productiveHours,
    nonProductiveHours: day.nonProductiveHours,
    totalHours: day.productiveHours + day.nonProductiveHours,
    productivityPercentage: (day.productiveHours + day.nonProductiveHours) > 0
      ? (day.productiveHours / (day.productiveHours + day.nonProductiveHours)) * 100
      : 0
  }));

  return { data, pagination: { totalCount: data.length } };
}

/**
 * Get employee summary data - aggregated hours per employee.
 */
async function getEmployeeSummaryData(orgId, filters, visibleUserIds) {
  const { from, to, employee } = filters;
  const employeesData = await portalService.getEmployees(orgId, { from, to }, { page: 1, limit: 1000 }, visibleUserIds);
  
  let data = employeesData.data.map(emp => ({
    employeeName: emp.name,
    employeeEmail: emp.email,
    userId: emp.userId,
    productiveHours: emp.productiveHours,
    nonProductiveHours: emp.nonProductiveHours,
    totalHours: emp.productiveHours + emp.nonProductiveHours,
    productivityPercentage: emp.productivityPercentage
  }));
  
  // Filter by specific employee if provided
  if (employee) {
    data = data.filter(emp => emp.userId === employee);
  }
  
  return { data, pagination: { totalCount: data.length } };
}

/**
 * Get application usage data - time spent per application.
 */
async function getApplicationUsageData(orgId, filters, visibleUserIds) {
  // Aggregated server-side via RPC (the old getTimeLogs path hit the 1000-row
  // cap and undercounted). Returns rows already sorted by total time desc.
  return portalService.getApplicationUsage(orgId, filters, visibleUserIds);
}

/**
 * Get report data preview with pagination.
 * 
 * GET /api/portal/reports/data?type=&page=&limit=&filters...
 */
async function getReportData(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { type, classification, employee, from, to, page = '1', limit = '20' } = req.query;
    
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
    
    if (!SUPPORTED_REPORT_TYPES.includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: `Unsupported report type. Available: ${SUPPORTED_REPORT_TYPES.join(', ')}` 
      });
    }
    
    // Get report data (scoped to the caller's LOB employees when enforced)
    const filters = { classification, employee, from, to };
    const visibleUserIds = await resolveVisibleUserIds(req);
    const result = await getReportDataByType(orgId, type, filters, visibleUserIds);
    
    // Apply pagination
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;
    const paginatedData = result.data.slice(startIndex, endIndex);
    
    return res.json({ 
      success: true, 
      data: paginatedData,
      totalCount: result.pagination.totalCount,
      page: pageNum,
      limit: limitNum
    });
    
  } catch (error) {
    logger.error('[PortalReports] Get report data failed', error);
    return res.status(error.status || 500).json({
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
    
    if (!SUPPORTED_REPORT_TYPES.includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: `Unsupported report type. Available: ${SUPPORTED_REPORT_TYPES.join(', ')}` 
      });
    }
    
    // Get all data (scoped to the caller's LOB employees when enforced).
    // fetchAll → walk pages so the activity-logs CSV is complete, not capped at 1000.
    const filters = { classification, employee, from, to };
    const visibleUserIds = await resolveVisibleUserIds(req);
    const result = await getReportDataByType(orgId, type, filters, visibleUserIds, { fetchAll: true });

    // Generate CSV based on report type
    let headers, csvRows;
    
    switch (type) {
      case 'daily-summary':
        headers = ['Date', 'Productive Hours', 'Non-Productive Hours', 'Total Hours', 'Productivity %'];
        csvRows = [headers.join(',')];
        result.data.forEach(row => {
          csvRows.push([
            `"${row.date}"`,
            row.productiveHours?.toFixed(2) || '0.00',
            row.nonProductiveHours?.toFixed(2) || '0.00',
            row.totalHours?.toFixed(2) || '0.00',
            row.productivityPercentage?.toFixed(1) || '0.0'
          ].join(','));
        });
        break;
        
      case 'employee-summary':
        headers = ['Employee Name', 'Email', 'Productive Hours', 'Non-Productive Hours', 'Total Hours', 'Productivity %'];
        csvRows = [headers.join(',')];
        result.data.forEach(row => {
          csvRows.push([
            `"${row.employeeName || ''}"`,
            `"${row.employeeEmail || ''}"`,
            row.productiveHours?.toFixed(2) || '0.00',
            row.nonProductiveHours?.toFixed(2) || '0.00',
            row.totalHours?.toFixed(2) || '0.00',
            row.productivityPercentage?.toFixed(1) || '0.0'
          ].join(','));
        });
        break;
        
      case 'application-usage':
        headers = ['Application', 'Total Hours', 'Session Count', 'Employees'];
        csvRows = [headers.join(',')];
        result.data.forEach(row => {
          csvRows.push([
            `"${row.application || ''}"`,
            row.totalHours?.toFixed(2) || '0.00',
            row.sessionCount || 0,
            row.employeeCount || 0
          ].join(','));
        });
        break;
        
      default: // activity-logs
        headers = ['Employee Name', 'Employee Email', 'Start Time', 'End Time', 'Application', 'Window Title', 'Duration (seconds)', 'Classification'];
        csvRows = [headers.join(',')];
        result.data.forEach(log => {
          csvRows.push([
            `"${log.userName || ''}"`,
            `"${log.userEmail || ''}"`,
            `"${log.startTime || ''}"`,
            `"${log.endTime || ''}"`,
            `"${log.application || ''}"`,
            `"${(log.windowTitle || '').replace(/"/g, '""')}"`,
            log.durationSeconds || 0,
            `"${log.classification || ''}"`
          ].join(','));
        });
    }
    
    const csvContent = csvRows.join('\n');
    
    // Set headers for CSV download
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${type}-${timestamp}.csv`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
    
  } catch (error) {
    logger.error('[PortalReports] Export CSV failed', error);
    return res.status(error.status || 500).json({
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
    
    if (!SUPPORTED_REPORT_TYPES.includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: `Unsupported report type. Available: ${SUPPORTED_REPORT_TYPES.join(', ')}` 
      });
    }
    
    // Get all data (scoped to the caller's LOB employees when enforced)
    const filters = { classification, employee, from, to };
    const visibleUserIds = await resolveVisibleUserIds(req);
    const result = await getReportDataByType(orgId, type, filters, visibleUserIds);
    
    // Create PDF document
    const doc = new PDFDocument({ margin: 50, size: 'A4', layout: 'landscape' });
    
    // Set headers for PDF download
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${type}-${timestamp}.pdf`;
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    doc.pipe(res);
    
    // Report title
    const reportTitles = {
      'activity-logs': 'Activity Logs Report',
      'daily-summary': 'Daily Summary Report',
      'employee-summary': 'Employee Summary Report',
      'application-usage': 'Application Usage Report'
    };
    
    doc.fontSize(20).text(reportTitles[type] || 'Report', { align: 'center' });
    doc.moveDown(0.5);
    
    // Date range
    doc.fontSize(10).fillColor('#666666')
      .text(`Date Range: ${from || 'All'} to ${to || 'All'}`, { align: 'center' });
    doc.moveDown(0.5);
    doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1);
    
    // Draw horizontal line
    doc.strokeColor('#cccccc').lineWidth(1)
      .moveTo(50, doc.y)
      .lineTo(doc.page.width - 50, doc.y)
      .stroke();
    doc.moveDown(1);
    
    // Summary section
    doc.fontSize(12).fillColor('#000000').text(`Total Records: ${result.data.length}`);
    doc.moveDown(1);
    
    // Table headers and data based on report type
    const tableConfig = getTableConfigForType(type);
    const tableData = result.data.slice(0, 100); // Limit to 100 rows for PDF
    
    if (tableData.length > 0) {
      drawTable(doc, tableConfig.headers, tableData, tableConfig.columns);
    } else {
      doc.fontSize(12).text('No data available for the selected filters.', { align: 'center' });
    }
    
    // Footer note if data was truncated
    if (result.data.length > 100) {
      doc.moveDown(1);
      doc.fontSize(10).fillColor('#666666')
        .text(`Note: Showing first 100 of ${result.data.length} records. Export to CSV for full data.`);
    }
    
    doc.end();
    
  } catch (error) {
    logger.error('[PortalReports] Export PDF failed', error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message
    });
  }
}

/**
 * Get table configuration for each report type.
 */
function getTableConfigForType(type) {
  switch (type) {
    case 'daily-summary':
      return {
        headers: ['Date', 'Productive Hrs', 'Non-Prod Hrs', 'Total Hrs', 'Productivity %'],
        columns: [
          { key: 'date', width: 100 },
          { key: 'productiveHours', width: 100, format: v => v?.toFixed(2) || '0.00' },
          { key: 'nonProductiveHours', width: 100, format: v => v?.toFixed(2) || '0.00' },
          { key: 'totalHours', width: 100, format: v => v?.toFixed(2) || '0.00' },
          { key: 'productivityPercentage', width: 100, format: v => `${v?.toFixed(1) || 0}%` }
        ]
      };
    case 'employee-summary':
      return {
        headers: ['Employee', 'Email', 'Productive Hrs', 'Non-Prod Hrs', 'Total Hrs', 'Productivity %'],
        columns: [
          { key: 'employeeName', width: 120 },
          { key: 'employeeEmail', width: 150 },
          { key: 'productiveHours', width: 80, format: v => v?.toFixed(2) || '0.00' },
          { key: 'nonProductiveHours', width: 80, format: v => v?.toFixed(2) || '0.00' },
          { key: 'totalHours', width: 80, format: v => v?.toFixed(2) || '0.00' },
          { key: 'productivityPercentage', width: 80, format: v => `${v?.toFixed(1) || 0}%` }
        ]
      };
    case 'application-usage':
      return {
        headers: ['Application', 'Total Hours', 'Sessions', 'Employees'],
        columns: [
          { key: 'application', width: 200 },
          { key: 'totalHours', width: 100, format: v => v?.toFixed(2) || '0.00' },
          { key: 'sessionCount', width: 100 },
          { key: 'employeeCount', width: 100 }
        ]
      };
    default: // activity-logs
      return {
        headers: ['Employee', 'Start Time', 'Application', 'Duration', 'Classification'],
        columns: [
          { key: 'userName', width: 120 },
          { key: 'startTime', width: 140, format: v => v ? new Date(v).toLocaleString() : 'N/A' },
          { key: 'application', width: 120 },
          { key: 'durationSeconds', width: 80, format: v => formatDurationPDF(v) },
          { key: 'classification', width: 80 }
        ]
      };
  }
}

/**
 * Format duration for PDF display.
 */
function formatDurationPDF(seconds) {
  if (!seconds) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Draw a simple table in the PDF.
 */
function drawTable(doc, headers, data, columns) {
  const startX = 50;
  let y = doc.y;
  const rowHeight = 20;
  const fontSize = 9;
  
  // Calculate total width
  const totalWidth = columns.reduce((sum, col) => sum + col.width, 0);
  
  // Draw header row
  doc.fontSize(fontSize).fillColor('#ffffff');
  doc.rect(startX, y, totalWidth, rowHeight).fill('#333333');
  
  let x = startX;
  headers.forEach((header, i) => {
    doc.fillColor('#ffffff').text(header, x + 5, y + 5, { width: columns[i].width - 10, height: rowHeight });
    x += columns[i].width;
  });
  
  y += rowHeight;
  
  // Draw data rows
  doc.fillColor('#000000');
  data.forEach((row, rowIndex) => {
    // Check if we need a new page
    if (y > doc.page.height - 100) {
      doc.addPage();
      y = 50;
      
      // Redraw headers on new page
      doc.rect(startX, y, totalWidth, rowHeight).fill('#333333');
      let x = startX;
      headers.forEach((header, i) => {
        doc.fillColor('#ffffff').text(header, x + 5, y + 5, { width: columns[i].width - 10, height: rowHeight });
        x += columns[i].width;
      });
      y += rowHeight;
      doc.fillColor('#000000');
    }
    
    // Alternate row background
    if (rowIndex % 2 === 0) {
      doc.rect(startX, y, totalWidth, rowHeight).fill('#f5f5f5');
    }
    
    x = startX;
    columns.forEach(col => {
      let value = row[col.key];
      if (col.format) value = col.format(value);
      value = String(value || '').substring(0, 30); // Truncate long values
      
      doc.fillColor('#000000').text(value, x + 5, y + 5, { width: col.width - 10, height: rowHeight });
      x += col.width;
    });
    
    y += rowHeight;
  });
}

module.exports = {
  getReportData,
  exportCSV,
  exportPDF
};

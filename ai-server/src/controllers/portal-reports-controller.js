/**
 * Portal Reports Controller
 * 
 * Handles report generation and export (CSV/PDF).
 */

'use strict';

const logger = require('../utils/logger');
const portalService = require('../services/portal-service');
const lobService = require('../services/portal-lob-service');
const profileService = require('../services/portal-employee-profile-service');
const holidayService = require('../services/portal-holiday-service');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const SUPPORTED_REPORT_TYPES = ['activity-logs', 'daily-summary', 'employee-summary', 'application-usage'];

/**
 * Each activity category as a percentage of total tracked time
 * (productive + non-productive + unknown + idle), so the four sum to ~100%.
 * "unknown" is the WS-C "neutral" category (private/unclassified).
 */
function categoryPercents({ productiveHours = 0, nonProductiveHours = 0, unknownHours = 0, idleHours = 0 }) {
  const total = productiveHours + nonProductiveHours + unknownHours + idleHours;
  const pct = (h) => (total > 0 ? Math.round((h / total) * 1000) / 10 : 0);
  return {
    productivePct: pct(productiveHours),
    nonProductivePct: pct(nonProductiveHours),
    unknownPct: pct(unknownHours),
    idlePct: pct(idleHours),
  };
}

/** "5.00h (62.0%)" — combined hours+percent cell for the PDF and preview. */
function fmtHrPct(hours, pct) {
  return `${(hours || 0).toFixed(2)}h (${(pct || 0).toFixed(1)}%)`;
}

/** LOB scoping is only enforced when the flag is on (safe rollout). */
function lobEnforced() {
  return process.env.PORTAL_LOB_ENFORCEMENT === 'on';
}

/**
 * Resolve the employee user_ids the caller may see for reports.
 * null → no restriction; array → restrict (empty ⇒ nothing). Honors ?lobId
 * (403 when out of scope) and ?locationId (data filter — applies regardless
 * of PORTAL_LOB_ENFORCEMENT).
 */
async function resolveVisibleUserIds(req) {
  let visibleUserIds = null;
  if (lobEnforced()) {
    const scope = await lobService.resolveScope(req.portalUser);
    const { lobId } = req.query;
    if (lobId) {
      if (!lobService.canAccessLob(scope, lobId)) {
        const e = new Error('Insufficient permissions for this LOB');
        e.status = 403;
        throw e;
      }
      visibleUserIds = await lobService.userIdsForLobs([lobId]);
    } else {
      visibleUserIds = scope.visibleUserIds;
    }
  }
  return profileService.applyLocationScope(visibleUserIds, req.query.locationId);
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

  // Per-category hours + percentage (each category ÷ total tracked time). The
  // single Productivity % column is dropped in favour of a % per category.
  const data = dashboardData.dailyTrend.map(day => {
    const productiveHours = day.productiveHours || 0;
    const nonProductiveHours = day.nonProductiveHours || 0;
    const unknownHours = day.neutralHours || 0; // WS-C "neutral" surfaced as "Unknown"
    const idleHours = day.idleHours || 0;
    const totalHours = productiveHours + nonProductiveHours + unknownHours + idleHours;
    return {
      date: day.date,
      productiveHours,
      nonProductiveHours,
      unknownHours,
      idleHours,
      totalHours,
      ...categoryPercents({ productiveHours, nonProductiveHours, unknownHours, idleHours }),
    };
  });

  return { data, pagination: { totalCount: data.length } };
}

/**
 * Get employee summary data - aggregated hours per employee.
 */
async function getEmployeeSummaryData(orgId, filters, visibleUserIds) {
  const { from, to, employee } = filters;
  const employeesData = await portalService.getEmployees(orgId, { from, to }, { page: 1, limit: 1000 }, visibleUserIds);

  // Legal (expected) hours are identical for everyone over the selected range —
  // company-wide holidays, no per-employee leaves yet — so compute once.
  // Tracked Hours = Active time (productive + non-productive + unknown), idle
  // excluded; Attainment % = Tracked ÷ Legal.
  // Degrade to 0 if the holiday lookup fails (e.g. the portal_holidays migration
  // isn't applied yet) so the rest of the employee summary still renders instead
  // of failing the whole report.
  let legalHrs = 0;
  if (from && to) {
    try {
      legalHrs = await holidayService.legalHours(from, to);
    } catch (err) {
      logger.warn('[PortalReports] legal hours unavailable; defaulting to 0', { error: err.message });
    }
  }

  let data = employeesData.data.map(emp => {
    const productiveHours = emp.productiveHours || 0;
    const nonProductiveHours = emp.nonProductiveHours || 0;
    const unknownHours = emp.neutralHours || 0; // WS-C "neutral" surfaced as "Unknown"
    const idleHours = emp.idleHours || 0;
    const totalHours = productiveHours + nonProductiveHours + unknownHours + idleHours;
    const trackedHours = productiveHours + nonProductiveHours + unknownHours;
    const attainmentPct = legalHrs > 0 ? Math.round((trackedHours / legalHrs) * 1000) / 10 : 0;
    return {
      employeeName: emp.name,
      employeeEmail: emp.email,
      userId: emp.userId,
      productiveHours,
      nonProductiveHours,
      unknownHours,
      idleHours,
      totalHours,
      trackedHours,
      legalHours: legalHrs,
      attainmentPct,
      location: emp.location ? emp.location.name : '',
      ...categoryPercents({ productiveHours, nonProductiveHours, unknownHours, idleHours }),
    };
  });

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
        // Per-category hours + % (each category ÷ total tracked). The single
        // Productivity % column is intentionally removed (manager request);
        // exports use separate numeric Hrs/% columns so cells stay summable.
        headers = ['Date', 'Productive Hours', 'Productive %', 'Non-Productive Hours', 'Non-Productive %', 'Unknown Hours', 'Unknown %', 'Idle Hours', 'Idle %', 'Total Hours'];
        csvRows = [headers.join(',')];
        result.data.forEach(row => {
          csvRows.push([
            `"${row.date}"`,
            row.productiveHours?.toFixed(2) || '0.00',
            row.productivePct?.toFixed(1) || '0.0',
            row.nonProductiveHours?.toFixed(2) || '0.00',
            row.nonProductivePct?.toFixed(1) || '0.0',
            row.unknownHours?.toFixed(2) || '0.00',
            row.unknownPct?.toFixed(1) || '0.0',
            row.idleHours?.toFixed(2) || '0.00',
            row.idlePct?.toFixed(1) || '0.0',
            row.totalHours?.toFixed(2) || '0.00'
          ].join(','));
        });
        break;

      case 'employee-summary':
        // Per-category Hrs/% + Legal/Tracked/Attainment. Productivity % removed;
        // "Neutral" surfaced as "Unknown" (manager request).
        headers = ['Employee Name', 'Email', 'Productive Hours', 'Productive %', 'Non-Productive Hours', 'Non-Productive %', 'Unknown Hours', 'Unknown %', 'Idle Hours', 'Idle %', 'Tracked Hours', 'Legal Hours', 'Attainment %', 'Branch'];
        csvRows = [headers.join(',')];
        result.data.forEach(row => {
          csvRows.push([
            `"${row.employeeName || ''}"`,
            `"${row.employeeEmail || ''}"`,
            row.productiveHours?.toFixed(2) || '0.00',
            row.productivePct?.toFixed(1) || '0.0',
            row.nonProductiveHours?.toFixed(2) || '0.00',
            row.nonProductivePct?.toFixed(1) || '0.0',
            row.unknownHours?.toFixed(2) || '0.00',
            row.unknownPct?.toFixed(1) || '0.0',
            row.idleHours?.toFixed(2) || '0.00',
            row.idlePct?.toFixed(1) || '0.0',
            row.trackedHours?.toFixed(2) || '0.00',
            row.legalHours?.toFixed(2) || '0.00',
            row.attainmentPct?.toFixed(1) || '0.0',
            `"${row.location || ''}"`
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
 * Excel column definitions per report type. Mirrors the CSV columns exactly
 * (same order, including the appended Location/Neutral/Idle columns) but with
 * REAL numeric cells so totals are summable in Excel. `key` matches the field
 * name on the report data rows, so `sheet.addRow(row)` maps by key.
 */
function getExcelColumnsForType(type) {
  switch (type) {
    case 'daily-summary':
      return [
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Productive Hours', key: 'productiveHours', width: 16, numFmt: '0.00' },
        { header: 'Productive %', key: 'productivePct', width: 13, numFmt: '0.0' },
        { header: 'Non-Productive Hours', key: 'nonProductiveHours', width: 20, numFmt: '0.00' },
        { header: 'Non-Productive %', key: 'nonProductivePct', width: 16, numFmt: '0.0' },
        { header: 'Unknown Hours', key: 'unknownHours', width: 14, numFmt: '0.00' },
        { header: 'Unknown %', key: 'unknownPct', width: 11, numFmt: '0.0' },
        { header: 'Idle Hours', key: 'idleHours', width: 12, numFmt: '0.00' },
        { header: 'Idle %', key: 'idlePct', width: 9, numFmt: '0.0' },
        { header: 'Total Hours', key: 'totalHours', width: 12, numFmt: '0.00' },
      ];
    case 'employee-summary':
      return [
        { header: 'Employee Name', key: 'employeeName', width: 24 },
        { header: 'Email', key: 'employeeEmail', width: 28 },
        { header: 'Productive Hours', key: 'productiveHours', width: 16, numFmt: '0.00' },
        { header: 'Productive %', key: 'productivePct', width: 13, numFmt: '0.0' },
        { header: 'Non-Productive Hours', key: 'nonProductiveHours', width: 20, numFmt: '0.00' },
        { header: 'Non-Productive %', key: 'nonProductivePct', width: 16, numFmt: '0.0' },
        { header: 'Unknown Hours', key: 'unknownHours', width: 14, numFmt: '0.00' },
        { header: 'Unknown %', key: 'unknownPct', width: 11, numFmt: '0.0' },
        { header: 'Idle Hours', key: 'idleHours', width: 12, numFmt: '0.00' },
        { header: 'Idle %', key: 'idlePct', width: 9, numFmt: '0.0' },
        { header: 'Tracked Hours', key: 'trackedHours', width: 14, numFmt: '0.00' },
        { header: 'Legal Hours', key: 'legalHours', width: 12, numFmt: '0.00' },
        { header: 'Attainment %', key: 'attainmentPct', width: 13, numFmt: '0.0' },
        { header: 'Branch', key: 'location', width: 16 },
      ];
    case 'application-usage':
      return [
        { header: 'Application', key: 'application', width: 32 },
        { header: 'Total Hours', key: 'totalHours', width: 12, numFmt: '0.00' },
        { header: 'Session Count', key: 'sessionCount', width: 14 },
        { header: 'Employees', key: 'employeeCount', width: 11 },
      ];
    default: // activity-logs
      return [
        { header: 'Employee Name', key: 'userName', width: 24 },
        { header: 'Employee Email', key: 'userEmail', width: 28 },
        { header: 'Start Time', key: 'startTime', width: 22 },
        { header: 'End Time', key: 'endTime', width: 22 },
        { header: 'Application', key: 'application', width: 24 },
        { header: 'Window Title', key: 'windowTitle', width: 40 },
        { header: 'Duration (seconds)', key: 'durationSeconds', width: 18 },
        { header: 'Classification', key: 'classification', width: 15 },
      ];
  }
}

const EXCEL_SHEET_TITLES = {
  'activity-logs': 'Activity Logs',
  'daily-summary': 'Daily Summary',
  'employee-summary': 'Employee Summary',
  'application-usage': 'Application Usage',
};

/**
 * Export report as Excel (.xlsx).
 *
 * GET /api/portal/reports/export/excel?type=&filters...
 * Complete export (walks all pages like the CSV path, 50k cap).
 */
async function exportExcel(req, res) {
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

    // Get all data (scoped to the caller's LOB/location when applicable).
    const filters = { classification, employee, from, to };
    const visibleUserIds = await resolveVisibleUserIds(req);
    const result = await getReportDataByType(orgId, type, filters, visibleUserIds, { fetchAll: true });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(EXCEL_SHEET_TITLES[type] || 'Report');
    const columns = getExcelColumnsForType(type);
    sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
    sheet.getRow(1).font = { bold: true };
    columns.forEach((col, i) => {
      if (col.numFmt) sheet.getColumn(i + 1).numFmt = col.numFmt;
    });
    for (const row of result.data) {
      sheet.addRow(row);
    }

    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-${timestamp}.xlsx"`);
    const buffer = await workbook.xlsx.writeBuffer();
    return res.send(Buffer.from(buffer));

  } catch (error) {
    logger.error('[PortalReports] Export Excel failed', error);
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
      // Each category cell combines hours + % (manager request); Productivity %
      // removed, "Neutral" surfaced as "Unknown".
      return {
        headers: ['Date', 'Productive', 'Non-Productive', 'Unknown', 'Idle', 'Total Hrs'],
        columns: [
          { key: 'date', width: 80 },
          { key: 'productiveHours', width: 95, format: (v, r) => fmtHrPct(v, r.productivePct) },
          { key: 'nonProductiveHours', width: 100, format: (v, r) => fmtHrPct(v, r.nonProductivePct) },
          { key: 'unknownHours', width: 90, format: (v, r) => fmtHrPct(v, r.unknownPct) },
          { key: 'idleHours', width: 80, format: (v, r) => fmtHrPct(v, r.idlePct) },
          { key: 'totalHours', width: 80, format: v => v?.toFixed(2) || '0.00' }
        ]
      };
    case 'employee-summary':
      return {
        headers: ['Employee', 'Productive', 'Non-Productive', 'Unknown', 'Idle', 'Tracked', 'Legal', 'Attain %'],
        columns: [
          { key: 'employeeName', width: 110 },
          { key: 'productiveHours', width: 90, format: (v, r) => fmtHrPct(v, r.productivePct) },
          { key: 'nonProductiveHours', width: 95, format: (v, r) => fmtHrPct(v, r.nonProductivePct) },
          { key: 'unknownHours', width: 85, format: (v, r) => fmtHrPct(v, r.unknownPct) },
          { key: 'idleHours', width: 75, format: (v, r) => fmtHrPct(v, r.idlePct) },
          { key: 'trackedHours', width: 60, format: v => v?.toFixed(2) || '0.00' },
          { key: 'legalHours', width: 55, format: v => v?.toFixed(2) || '0.00' },
          { key: 'attainmentPct', width: 65, format: v => `${v?.toFixed(1) || 0}%` }
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
      // Pass the whole row so combined cells (e.g. "5.00h (62.0%)") can read a
      // sibling field (the percentage) alongside the keyed value.
      if (col.format) value = col.format(value, row);
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
  exportExcel,
  exportPDF
};

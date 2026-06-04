/**
 * Portal Reports Controller
 * 
 * Handles report generation and export (CSV/PDF).
 */

'use strict';

const logger = require('../utils/logger');
const portalService = require('../services/portal-service');
const { getClient } = require('../services/db/supabase-client');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');

const SUPPORTED_REPORT_TYPES = ['activity-logs', 'daily-summary', 'employee-summary', 'application-usage'];

/**
 * Get report data based on type.
 */
async function getReportDataByType(orgId, type, filters) {
  switch (type) {
    case 'daily-summary':
      return getDailySummaryData(orgId, filters);
    case 'employee-summary':
      return getEmployeeSummaryData(orgId, filters);
    case 'application-usage':
      return getApplicationUsageData(orgId, filters);
    default: // activity-logs
      return portalService.getTimeLogs(orgId, filters, { page: 1, limit: 10000 });
  }
}

/**
 * Get daily summary data - aggregated hours per day.
 * If employee filter is provided, shows daily data for that specific employee.
 * Otherwise, aggregates all employees' data by day with employee breakdown.
 */
async function getDailySummaryData(orgId, filters) {
  const { from, to, employee, classification } = filters;
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  
  // Build query to get all activity records for aggregation
  let query = supabase
    .from('activity_records')
    .select(`
      user_id,
      start_time,
      duration_seconds,
      classification,
      users!activity_records_user_id_fkey(display_name, email)
    `)
    .neq('is_idle', true);
  
  // Apply filters
  if (employee) {
    query = query.eq('user_id', employee);
  }
  
  if (classification && classification !== 'all') {
    const normalized = classification === 'productive' ? 'productive' : 
                      classification === 'non-productive' ? 'non_productive' : null;
    if (normalized) query = query.eq('classification', normalized);
  }
  
  if (from) {
    query = query.gte('start_time', `${from}T00:00:00Z`);
  }
  
  if (to) {
    query = query.lte('end_time', `${to}T23:59:59Z`);
  }
  
  // Fetch all matching records (no pagination limit for aggregation)
  const { data: logs, error } = await query.order('start_time', { ascending: true });
  
  if (error) {
    throw error;
  }
  
  // Aggregate by date
  const dailyData = {};
  const uniqueEmployees = new Set();
  
  (logs || []).forEach(log => {
    const date = log.start_time ? log.start_time.split('T')[0] : null;
    if (!date) return;
    
    const userName = log.users?.display_name || log.users?.email || 'Unknown';
    uniqueEmployees.add(userName);
    
    if (!dailyData[date]) {
      dailyData[date] = { 
        productiveSeconds: 0, 
        nonProductiveSeconds: 0,
        employees: new Set()
      };
    }
    
    dailyData[date].employees.add(userName);
    
    if (log.classification === 'productive') {
      dailyData[date].productiveSeconds += log.duration_seconds || 0;
    } else {
      dailyData[date].nonProductiveSeconds += log.duration_seconds || 0;
    }
  });
  
  const data = Object.entries(dailyData)
    .map(([date, stats]) => ({
      date,
      productiveHours: stats.productiveSeconds / 3600,
      nonProductiveHours: stats.nonProductiveSeconds / 3600,
      totalHours: (stats.productiveSeconds + stats.nonProductiveSeconds) / 3600,
      productivityPercentage: (stats.productiveSeconds + stats.nonProductiveSeconds) > 0
        ? (stats.productiveSeconds / (stats.productiveSeconds + stats.nonProductiveSeconds)) * 100
        : 0,
      employeeCount: stats.employees.size,
      employees: Array.from(stats.employees).sort().join(', ')
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  
  return { 
    data, 
    pagination: { totalCount: data.length },
    summary: {
      totalEmployees: uniqueEmployees.size,
      employeeList: Array.from(uniqueEmployees).sort()
    }
  };
}

/**
 * Get employee summary data - aggregated hours per employee.
 */
async function getEmployeeSummaryData(orgId, filters) {
  const { from, to, employee } = filters;
  const employeesData = await portalService.getEmployees(orgId, { from, to }, { page: 1, limit: 1000 });
  
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
 * Get application usage data - time spent per application with employee details.
 */
async function getApplicationUsageData(orgId, filters) {
  const { from, to, employee, classification } = filters;
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  
  // Build query to get application usage with user details
  let query = supabase
    .from('activity_records')
    .select(`
      user_id,
      application_name,
      duration_seconds,
      users!activity_records_user_id_fkey(display_name, email)
    `)
    .neq('is_idle', true);
  
  // Apply filters
  if (employee) {
    query = query.eq('user_id', employee);
  }
  
  if (classification && classification !== 'all') {
    const normalized = classification === 'productive' ? 'productive' : 
                      classification === 'non-productive' ? 'non_productive' : null;
    if (normalized) query = query.eq('classification', normalized);
  }
  
  if (from) {
    query = query.gte('start_time', `${from}T00:00:00Z`);
  }
  
  if (to) {
    query = query.lte('end_time', `${to}T23:59:59Z`);
  }
  
  const { data: logs, error } = await query.order('start_time', { ascending: true });
  
  if (error) {
    throw error;
  }
  
  const appUsage = {};
  (logs || []).forEach(log => {
    const app = log.application_name || 'Unknown';
    const userName = log.users?.display_name || log.users?.email || 'Unknown';
    
    if (!appUsage[app]) {
      appUsage[app] = { 
        totalSeconds: 0, 
        sessionCount: 0, 
        employeeNames: new Set(),
        employeeDetails: new Map()
      };
    }
    
    appUsage[app].totalSeconds += log.duration_seconds || 0;
    appUsage[app].sessionCount += 1;
    appUsage[app].employeeNames.add(userName);
    
    // Track per-employee usage for this app
    if (!appUsage[app].employeeDetails.has(userName)) {
      appUsage[app].employeeDetails.set(userName, { 
        hours: 0, 
        sessions: 0 
      });
    }
    const empData = appUsage[app].employeeDetails.get(userName);
    empData.hours += (log.duration_seconds || 0) / 3600;
    empData.sessions += 1;
  });
  
  const data = Object.entries(appUsage)
    .map(([app, stats]) => ({
      application: app,
      totalHours: stats.totalSeconds / 3600,
      sessionCount: stats.sessionCount,
      employeeCount: stats.employeeNames.size,
      employees: Array.from(stats.employeeNames).sort().join(', '),
      employeeBreakdown: Array.from(stats.employeeDetails.entries())
        .map(([name, detail]) => ({
          name,
          hours: detail.hours,
          sessions: detail.sessions
        }))
        .sort((a, b) => b.hours - a.hours)
    }))
    .sort((a, b) => b.totalHours - a.totalHours);
  
  return { data, pagination: { totalCount: data.length } };
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
    
    // Get report data
    const filters = { classification, employee, from, to };
    const result = await getReportDataByType(orgId, type, filters);
    
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
    
    if (!SUPPORTED_REPORT_TYPES.includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: `Unsupported report type. Available: ${SUPPORTED_REPORT_TYPES.join(', ')}` 
      });
    }
    
    // Get all data
    const filters = { classification, employee, from, to };
    const result = await getReportDataByType(orgId, type, filters);
    
    // Generate CSV based on report type
    let headers, csvRows;
    
    switch (type) {
      case 'daily-summary':
        headers = ['Date', 'Productive Hours', 'Non-Productive Hours', 'Total Hours', 'Productivity %', 'Employee Count', 'Employees Working'];
        csvRows = [headers.join(',')];
        result.data.forEach(row => {
          csvRows.push([
            `"${row.date}"`,
            row.productiveHours?.toFixed(2) || '0.00',
            row.nonProductiveHours?.toFixed(2) || '0.00',
            row.totalHours?.toFixed(2) || '0.00',
            row.productivityPercentage?.toFixed(1) || '0.0',
            row.employeeCount || 0,
            `"${(row.employees || '').replace(/"/g, '""')}"`
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
        headers = ['Application', 'Total Hours', 'Session Count', 'Employee Count', 'Employee Names'];
        csvRows = [headers.join(',')];
        result.data.forEach(row => {
          csvRows.push([
            `"${row.application || ''}"`,
            row.totalHours?.toFixed(2) || '0.00',
            row.sessionCount || 0,
            row.employeeCount || 0,
            `"${(row.employees || '').replace(/"/g, '""')}"`
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
    
    // Get all data
    const filters = { classification, employee, from, to };
    const result = await getReportDataByType(orgId, type, filters);

    // Resolve employee name when filtered by a specific employee
    let employeeName = null;
    let employeeEmail = null;
    if (employee) {
      try {
        const empList = await portalService.getEmployeesList(orgId);
        const found = (empList || []).find(e => e.userId === employee || e.id === employee);
        if (found) {
          employeeName = found.name || found.displayName || null;
          employeeEmail = found.email || null;
        }
      } catch (_) { /* non-fatal */ }
    }
    
    // Create PDF document
    const doc = new PDFDocument({ margin: 50, size: 'A4', layout: 'landscape' });
    
    // Set headers for PDF download
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${type}-${timestamp}.pdf`;
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    doc.pipe(res);

    const pageWidth = doc.page.width;
    const margin = 50;
    const contentWidth = pageWidth - margin * 2;

    // ── Header banner ──────────────────────────────────────────────────
    doc.rect(margin, margin, contentWidth, 60).fill('#1a56db');

    const reportTitles = {
      'activity-logs': 'Activity Logs Report',
      'daily-summary': 'Daily Summary Report',
      'employee-summary': 'Employee Summary Report',
      'application-usage': 'Application Usage Report'
    };

    doc.fontSize(18).fillColor('#ffffff')
      .text(reportTitles[type] || 'Report', margin + 16, margin + 10, { width: contentWidth - 32, align: 'left' });
    doc.fontSize(9).fillColor('rgba(255,255,255,0.8)')
      .text('Amzur Technologies · Time Tracking Portal', margin + 16, margin + 36, { width: contentWidth - 32, align: 'left' });

    doc.y = margin + 72;

    // ── Meta row ───────────────────────────────────────────────────────
    doc.fontSize(9).fillColor('#333333');

    const metaItems = [];
    if (from || to) metaItems.push(`Date Range: ${from || 'All'} to ${to || 'All'}`);
    if (employeeName) metaItems.push(`Employee: ${employeeName}${employeeEmail ? ` (${employeeEmail})` : ''}`);
    else if (result.summary && result.summary.totalEmployees) {
      metaItems.push(`Employees Included: ${result.summary.totalEmployees} employee(s)`);
    }
    metaItems.push(`Generated: ${new Date().toLocaleString()}`);
    metaItems.push(`Total Records: ${result.data.length}`);

    metaItems.forEach(item => {
      const currentY = doc.y;
      doc.fillColor('#1a56db').circle(margin + 5, currentY + 5, 2).fill();
      doc.fillColor('#333333').text(item, margin + 14, currentY, { 
        width: contentWidth - 14,
        lineBreak: true,
        continued: false
      });
      doc.moveDown(0.4);
    });

    doc.moveDown(0.5);

    // Divider
    doc.strokeColor('#e2e8f0').lineWidth(1)
      .moveTo(margin, doc.y)
      .lineTo(pageWidth - margin, doc.y)
      .stroke();
    doc.moveDown(0.8);

    // Employee list section (when All Employees is selected and we have summary data)
    if (!employee && result.summary && result.summary.employeeList && result.summary.employeeList.length > 0) {
      doc.fontSize(10).fillColor('#1a56db').text('Employees Included in Report:', margin, doc.y, { underline: true });
      doc.moveDown(0.4);
      doc.fontSize(8).fillColor('#555555');
      
      const employees = result.summary.employeeList.slice(0, 20); // Show first 20
      const employeesText = employees.join(' · ');
      doc.text(employeesText, margin, doc.y, { width: contentWidth, lineBreak: true });
      
      if (result.summary.employeeList.length > 20) {
        doc.text(`...and ${result.summary.employeeList.length - 20} more`, margin, doc.y);
      }
      
      doc.moveDown(0.8);
      doc.strokeColor('#e2e8f0').lineWidth(1)
        .moveTo(margin, doc.y)
        .lineTo(pageWidth - margin, doc.y)
        .stroke();
      doc.moveDown(0.8);
    }
    
    // Table headers and data based on report type
    const tableConfig = getTableConfigForType(type);
    const tableData = result.data.slice(0, 100); // Limit to 100 rows for PDF
    
    if (tableData.length > 0) {
      drawTable(doc, tableConfig.headers, tableData, tableConfig.columns);
    } else {
      doc.fontSize(12).fillColor('#666666').text('No data available for the selected filters.', { align: 'center' });
    }
    
    // Footer note if data was truncated
    if (result.data.length > 100) {
      doc.moveDown(1);
      doc.fontSize(9).fillColor('#888888')
        .text(`Note: Showing first 100 of ${result.data.length} records. Export to CSV for full data.`);
    }

    // ── Page footer ────────────────────────────────────────────────────
    const footerY = doc.page.height - 35;
    doc.fontSize(8).fillColor('#aaaaaa')
      .text('Amzur Technologies – Time Tracking Portal', margin, footerY, { align: 'left', width: contentWidth })
      .text(`Page 1`, margin, footerY, { align: 'right', width: contentWidth });
    
    doc.end();
    
  } catch (error) {
    logger.error('[PortalReports] Export PDF failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

/**
 * Get headers and row values for tabular report exports.
 */
function getTabularRowsForType(type, data) {
  switch (type) {
    case 'daily-summary':
      return {
        headers: ['Date', 'Productive Hours', 'Non-Productive Hours', 'Total Hours', 'Productivity %', 'Employee Count', 'Employees Working'],
        rows: data.map((row) => ([
          row.date || '',
          row.productiveHours?.toFixed(2) || '0.00',
          row.nonProductiveHours?.toFixed(2) || '0.00',
          row.totalHours?.toFixed(2) || '0.00',
          row.productivityPercentage?.toFixed(1) || '0.0',
          row.employeeCount || 0,
          row.employees || ''
        ]))
      };

    case 'employee-summary':
      return {
        headers: ['Employee Name', 'Email', 'Productive Hours', 'Non-Productive Hours', 'Total Hours', 'Productivity %'],
        rows: data.map((row) => ([
          row.employeeName || '',
          row.employeeEmail || '',
          row.productiveHours?.toFixed(2) || '0.00',
          row.nonProductiveHours?.toFixed(2) || '0.00',
          row.totalHours?.toFixed(2) || '0.00',
          row.productivityPercentage?.toFixed(1) || '0.0'
        ]))
      };

    case 'application-usage':
      return {
        headers: ['Application', 'Total Hours', 'Session Count', 'Employee Count', 'Employee Names'],
        rows: data.map((row) => ([
          row.application || '',
          row.totalHours?.toFixed(2) || '0.00',
          row.sessionCount || 0,
          row.employeeCount || 0,
          row.employees || ''
        ]))
      };

    default:
      return {
        headers: ['Employee Name', 'Employee Email', 'Start Time', 'End Time', 'Application', 'Window Title', 'Duration (seconds)', 'Classification'],
        rows: data.map((log) => ([
          log.userName || '',
          log.userEmail || '',
          log.startTime || '',
          log.endTime || '',
          log.application || '',
          log.windowTitle || '',
          log.durationSeconds || 0,
          log.classification || ''
        ]))
      };
  }
}

/**
 * Export report as XLSX.
 *
 * GET /api/portal/reports/export/xlsx?type=&filters...
 */
async function exportXLSX(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { type, classification, employee, from, to } = req.query;

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

    const filters = { classification, employee, from, to };
    const result = await getReportDataByType(orgId, type, filters);
    const { headers, rows } = getTabularRowsForType(type, result.data);

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');

    const xlsxBuffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx'
    });

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${type}-${timestamp}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xlsxBuffer);
  } catch (error) {
    logger.error('[PortalReports] Export XLSX failed', error);
    return res.status(500).json({
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
        headers: ['Date', 'Prod Hrs', 'Non-Prod', 'Total', 'Prod %', 'Emp #', 'Employees'],
        columns: [
          { key: 'date', width: 75 },
          { key: 'productiveHours', width: 60, format: v => v?.toFixed(2) || '0.00' },
          { key: 'nonProductiveHours', width: 60, format: v => v?.toFixed(2) || '0.00' },
          { key: 'totalHours', width: 55, format: v => v?.toFixed(2) || '0.00' },
          { key: 'productivityPercentage', width: 55, format: v => `${v?.toFixed(1) || 0}%` },
          { key: 'employeeCount', width: 45 },
          { key: 'employees', width: 195, format: v => {
            if (!v) return 'N/A';
            const names = String(v).split(', ');
            if (names.length <= 3) return v;
            return `${names.slice(0, 3).join(', ')}, +${names.length - 3} more`;
          }}
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
        headers: ['Application', 'Total Hrs', 'Sessions', 'Emp Count', 'Employee Names'],
        columns: [
          { key: 'application', width: 150 },
          { key: 'totalHours', width: 70, format: v => v?.toFixed(2) || '0.00' },
          { key: 'sessionCount', width: 60 },
          { key: 'employeeCount', width: 65 },
          { key: 'employees', width: 200, format: v => {
            if (!v) return 'N/A';
            const names = String(v).split(', ');
            if (names.length <= 3) return v;
            return `${names.slice(0, 3).join(', ')}, +${names.length - 3} more`;
          }}
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
  exportPDF,
  exportXLSX
};

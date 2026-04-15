import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

// ── Helpers ──

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0 && m > 0 && s > 0) return `${h}h ${m}m ${s}s`;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0 && s > 0) return `${h}h ${s}s`;
  if (h > 0) return `${h}h`;
  if (m > 0 && s > 0) return `${m}m ${s}s`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatDurationShort(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0 && s > 0) return `${m}m ${s}s`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  let h = d.getHours();
  const min = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

function formatDateFriendly(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
}

function formatDateRange(startDate, endDate) {
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate + 'T00:00:00');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${months[s.getMonth()]} ${s.getDate()}–${e.getDate()}, ${s.getFullYear()}`;
  }
  return `${months[s.getMonth()]} ${s.getDate()} – ${months[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
}

// ── Shared Styles ──

const COLORS = {
  headerBg: 'FF2C5F8A',
  headerFont: 'FFFFFFFF',
  sectionBg: 'FFDEEBFF',
  sectionFont: 'FF0052CC',
  rowEvenBg: 'FFE8F0FE',
  rowOddBg: 'FFFFFFFF',
  borderColor: 'FFB0BEC5',
  totalBg: 'FFDCEDC8',
  totalFont: 'FF1B5E20',
  titleBg: 'FF1A3E5C',
  titleFont: 'FFFFFFFF',
  pivotColors: [
    'FFFFF3E0', 'FFE8F5E9', 'FFE3F2FD', 'FFFCE4EC',
    'FFF3E5F5', 'FFEFEBE9', 'FFE0F7FA', 'FFFFF8E1',
    'FFE8EAF6', 'FFEDE7F6'
  ]
};

const thinBorder = {
  top: { style: 'thin', color: { argb: COLORS.borderColor } },
  bottom: { style: 'thin', color: { argb: COLORS.borderColor } },
  left: { style: 'thin', color: { argb: COLORS.borderColor } },
  right: { style: 'thin', color: { argb: COLORS.borderColor } }
};

function styleHeaderRow(row, colCount) {
  row.height = 30;
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { bold: true, size: 11, color: { argb: COLORS.headerFont } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder;
  });
}

function styleDataRow(row, colCount, isEven) {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { size: 10, color: { argb: 'FF172B4D' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? COLORS.rowEvenBg : COLORS.rowOddBg } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = thinBorder;
  });
}

function styleTotalRow(row, colCount) {
  row.height = 26;
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { bold: true, size: 11, color: { argb: COLORS.totalFont } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.totalBg } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = thinBorder;
  });
}

function addTitleRow(ws, text, colCount, rowNum) {
  const row = ws.getRow(rowNum);
  ws.mergeCells(rowNum, 1, rowNum, colCount);
  const cell = row.getCell(1);
  cell.value = text;
  cell.font = { bold: true, size: 14, color: { argb: COLORS.titleFont } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.titleBg } };
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
  cell.border = thinBorder;
  row.height = 32;
  return rowNum + 1;
}

function addSubtitleRow(ws, text, colCount, rowNum) {
  const row = ws.getRow(rowNum);
  ws.mergeCells(rowNum, 1, rowNum, colCount);
  const cell = row.getCell(1);
  cell.value = text;
  cell.font = { italic: true, size: 9, color: { argb: 'FF757575' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
  cell.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 20;
  return rowNum + 1;
}

/**
 * Generate and download a formatted Excel report
 * Supports both single-project and multi-project data
 */
export async function generateExcelReport(data, filename) {
  // If multi-project, delegate to multi-project generator
  if (data.isMultiProject && data.projects) {
    return generateMultiProjectExcelReport(data, filename);
  }

  return generateSingleProjectExcelReport(data, filename);
}

/**
 * Generate Excel report for a single project (original behavior)
 */
async function generateSingleProjectExcelReport(data, filename) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'JIRAForge Time Tracker';
  workbook.created = new Date();

  const memberNames = data.memberDetails.map(m => m.displayName).join(', ');
  const dateRangeStr = formatDateRange(data.startDate, data.endDate);

  // ═══════════════════════════════════════════════════
  // SHEET 1: Detailed Activity (Grouped)
  // ═══════════════════════════════════════════════════
  const ws = workbook.addWorksheet('Detailed Activity (Grouped)');

  const COL_COUNT = 6;
  ws.columns = [
    { key: 'member', width: 22 },
    { key: 'date', width: 16 },
    { key: 'issueKey', width: 18 },
    { key: 'classification', width: 16 },
    { key: 'totalTime', width: 14 },
    { key: 'timings', width: 40 }
  ];

  // Title
  let cr = addTitleRow(ws, `Team Analytics – ${data.projectKey || 'All'} Project  |  ${dateRangeStr}  |  ${memberNames}`, COL_COUNT, 1);
  // Subtitle
  cr = addSubtitleRow(ws, 'Each row = one issue on one day. Start and end times are in the last column.', COL_COUNT, cr);

  // Header row
  const hRow = ws.getRow(cr);
  hRow.values = ['Member', 'Date', 'Issue Key', 'Classification', 'Total Time', 'Time (Start - End)'];
  styleHeaderRow(hRow, COL_COUNT);
  const headerRowNum = cr;
  ws.views = [{ state: 'frozen', ySplit: cr }];
  cr++;

  // Collect all entries across all members for the pivot later
  const allEntries = [];

  for (const member of data.memberDetails) {
    // Combine productive and non-productive entries
    const productiveEntries = (member.entries || []).map(e => ({ ...e, classification: 'Productive' }));
    const npEntries = (member.nonProductiveEntries || []).map(e => ({ 
      ...e, 
      classification: e.classification === 'private' ? 'Private' : 'Non-Productive' 
    }));
    const allMemberEntries = [...productiveEntries, ...npEntries];

    const sortedEntries = allMemberEntries.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.issueKey.localeCompare(b.issueKey);
    });

    let rowIdx = 0;
    for (const entry of sortedEntries) {
      const sessions = [...entry.sessions]
        .filter(s => s.durationSeconds > 0)
        .sort((a, b) => {
          if (!a.startTime) return 1;
          if (!b.startTime) return -1;
          return new Date(a.startTime) - new Date(b.startTime);
        });

      allEntries.push({ ...entry, memberName: member.displayName });

      // Show just the first start time and last end time for the issue
      const firstStart = sessions.length > 0 ? formatTime(sessions[0].startTime) : '';
      const lastEnd = sessions.length > 0 ? formatTime(sessions[sessions.length - 1].endTime) : '';
      const timingText = firstStart && lastEnd ? `${firstStart} - ${lastEnd}` : '—';

      const row = ws.getRow(cr);
      row.values = [
        member.displayName,
        formatDateFriendly(entry.date),
        entry.issueKey,
        entry.classification || 'Productive',
        formatDuration(entry.totalSeconds),
        timingText
      ];
      styleDataRow(row, COL_COUNT, rowIdx % 2 === 0);
      row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(1).font = { size: 10, color: { argb: 'FF172B4D' } };
      row.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(2).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
      row.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(4).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(5).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
      row.getCell(6).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(6).font = { size: 10, color: { argb: 'FF37474F' } };
      row.height = 20;

      cr++;
      rowIdx++;
    }

    // Member time summary rows (Today / This Week / This Month + breakdowns)
    if (member.todaySeconds !== undefined || member.weekSeconds !== undefined || member.monthSeconds !== undefined) {
      const mSummaryRow = ws.getRow(cr);
      mSummaryRow.getCell(1).value = member.displayName;
      ws.mergeCells(cr, 2, cr, COL_COUNT);
      // Total Time = project-matched time + unassigned (NULL project_key) time
      // so this line reflects the member's actual total work time, not just the
      // portion that could be attributed to a specific issue under this project.
      const mTodayTotal = (member.todaySeconds || 0) + (member.todayUnassignedSeconds || 0);
      const mWeekTotal = (member.weekSeconds || 0) + (member.weekUnassignedSeconds || 0);
      const mMonthTotal = (member.monthSeconds || 0) + (member.monthUnassignedSeconds || 0);
      mSummaryRow.getCell(2).value = `Total Time → Today: ${formatDuration(mTodayTotal)}  |  This Week: ${formatDuration(mWeekTotal)}  |  This Month: ${formatDuration(mMonthTotal)}`;
      mSummaryRow.height = 24;
      mSummaryRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber > COL_COUNT) return;
        cell.font = { bold: true, size: 10, color: { argb: COLORS.sectionFont } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.sectionBg } };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
        cell.border = thinBorder;
      });
      cr++;

      // Breakdown row: Unassigned
      const unassignedRow = ws.getRow(cr);
      unassignedRow.getCell(1).value = '';
      ws.mergeCells(cr, 2, cr, COL_COUNT);
      unassignedRow.getCell(2).value = `⚠ Unassigned → Today: ${formatDuration(member.todayUnassignedSeconds || 0)}  |  This Week: ${formatDuration(member.weekUnassignedSeconds || 0)}  |  This Month: ${formatDuration(member.monthUnassignedSeconds || 0)}`;
      unassignedRow.height = 22;
      unassignedRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber > COL_COUNT) return;
        cell.font = { bold: true, size: 9, color: { argb: 'FF7A5700' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
        cell.border = thinBorder;
      });
      cr++;

      // Breakdown row: Non-Productive & Private
      const npRow = ws.getRow(cr);
      npRow.getCell(1).value = '';
      ws.mergeCells(cr, 2, cr, COL_COUNT);
      npRow.getCell(2).value = `✖ Non-Productive / Private → Today: ${formatDuration(member.todayNonProductiveSeconds || 0)}  |  This Week: ${formatDuration(member.weekNonProductiveSeconds || 0)}  |  This Month: ${formatDuration(member.monthNonProductiveSeconds || 0)}`;
      npRow.height = 22;
      npRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber > COL_COUNT) return;
        cell.font = { bold: true, size: 9, color: { argb: 'FF8B0000' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4EC' } };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
        cell.border = thinBorder;
      });
      cr++;
    }
  }

  // Set autoFilter to span from header row to last data row
  ws.autoFilter = { from: `A${headerRowNum}`, to: `F${cr - 1}` };

  // ═══════════════════════════════════════════════════
  // SHEET 2: Time by Issue
  // ═══════════════════════════════════════════════════
  const issueWs = workbook.addWorksheet('Time by Issue');
  const IC = 4;
  issueWs.columns = [
    { key: 'issueKey', width: 18 },
    { key: 'totalMin', width: 18 },
    { key: 'totalTime', width: 16 },
    { key: 'pct', width: 16 }
  ];

  // Aggregate time by issue from allEntries
  const issueMap = {};
  for (const entry of allEntries) {
    if (!issueMap[entry.issueKey]) {
      issueMap[entry.issueKey] = 0;
    }
    issueMap[entry.issueKey] += entry.totalSeconds;
  }
  const issueArray = Object.entries(issueMap)
    .map(([key, sec]) => ({ issueKey: key, totalSeconds: sec }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds);
  const grandTotalSec = issueArray.reduce((s, i) => s + i.totalSeconds, 0);

  // Title
  const allContrib = data.memberDetails.length > 1 ? 'All Contributors' : memberNames;
  let icr = addTitleRow(issueWs, `Time by Issue – ${allContrib}`, IC, 1);

  // Header
  const ihRow = issueWs.getRow(icr);
  ihRow.values = ['Issue Key', 'Total Time (min)', 'Total Time', '% of Total'];
  styleHeaderRow(ihRow, IC);
  issueWs.autoFilter = { from: `A${icr}`, to: `D${icr}` };
  issueWs.views = [{ state: 'frozen', ySplit: icr }];
  icr++;

  issueArray.forEach((issue, i) => {
    const totalMin = Math.round(issue.totalSeconds / 60);
    const pct = grandTotalSec > 0 ? ((issue.totalSeconds / grandTotalSec) * 100).toFixed(1) : '0.0';
    const r = issueWs.getRow(icr);
    r.values = [issue.issueKey, totalMin, formatDuration(issue.totalSeconds), `${pct}%`];
    styleDataRow(r, IC, i % 2 === 0);
    r.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
    r.getCell(2).font = { size: 10, color: { argb: 'FF172B4D' } };
    r.getCell(3).font = { size: 10, color: { argb: 'FF172B4D' } };
    icr++;
  });

  // Total
  const totalMin = Math.round(grandTotalSec / 60);
  const totalR = issueWs.getRow(icr);
  totalR.values = ['TOTAL', totalMin, formatDuration(grandTotalSec), '100.0%'];
  styleTotalRow(totalR, IC);

  // ═══════════════════════════════════════════════════
  // SHEET 3: Summary
  // ═══════════════════════════════════════════════════
  if (data.memberSummary && data.memberSummary.length > 0) {
    const summaryWs = workbook.addWorksheet('Summary');
    const SC = 7;
    summaryWs.columns = [
      { key: 'c1', width: 24 },
      { key: 'c2', width: 16 },
      { key: 'c3', width: 16 },
      { key: 'c4', width: 16 },
      { key: 'c5', width: 18 },
      { key: 'c6', width: 24 },
      { key: 'c7', width: 14 }
    ];

    let scr = addTitleRow(summaryWs, `Team Summary – ${data.projectKey || 'All'} Project  |  ${dateRangeStr}`, SC, 1);

    // Today/Week/Month = project-matched time + unassigned (NULL project_key) time so
    // the columns reflect each member's actual total work time. "Unassigned (Month)"
    // stays as an informational breakdown column (subset of "This Month").
    const effSeconds = (m, bucket) => (m[`${bucket}Seconds`] || Math.round((m[`${bucket}Hours`] || 0) * 3600)) + (m[`${bucket}UnassignedSeconds`] || 0);

    const totalMonthSeconds = data.memberSummary.reduce((s, m) => s + effSeconds(m, 'month'), 0);

    // Info rows — recompute Total Hours / Avg Hours from actual totals (project + unassigned)
    const actualTotalHours = Math.round(totalMonthSeconds / 3600 * 10) / 10;
    const actualAvgHours = data.memberSummary.length > 0 ? Math.round(totalMonthSeconds / 3600 / data.memberSummary.length * 10) / 10 : 0;
    const infoRows = [
      ['Active Members', data.summary.activeMembers],
      ['Total Hours', `${actualTotalHours}h`],
      ['Issues Worked', data.summary.issuesWorked],
      ['Avg Hours/Member', `${actualAvgHours}h`]
    ];
    infoRows.forEach((vals, i) => {
      const r = summaryWs.getRow(scr);
      r.values = [vals[0], vals[1], '', '', '', '', ''];
      styleDataRow(r, 2, i % 2 === 0);
      r.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
      r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      r.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
      scr++;
    });
    scr++; // spacer

    // Member Summary Table
    const mhRow = summaryWs.getRow(scr);
    mhRow.values = ['Member Name', 'Today', 'This Week', 'This Month', 'Unassigned (Month)', 'Non-Productive / Private (Month)', '% of Total'];
    styleHeaderRow(mhRow, SC);
    scr++;

    data.memberSummary.forEach((m, i) => {
      const memberMonthSec = effSeconds(m, 'month');
      // Recompute percentage against the new total (project + unassigned) so it matches the column values.
      const percentage = totalMonthSeconds > 0 ? Math.round((memberMonthSec / totalMonthSeconds) * 100) : 0;
      const r = summaryWs.getRow(scr);
      r.values = [
        m.displayName,
        formatDuration(effSeconds(m, 'today')),
        formatDuration(effSeconds(m, 'week')),
        formatDuration(memberMonthSec),
        formatDuration(m.monthUnassignedSeconds || 0),
        formatDuration(m.monthNonProductiveSeconds || 0),
        `${percentage}%`
      ];
      styleDataRow(r, SC, i % 2 === 0);
      r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      scr++;
    });

    // Total
    const totalTodaySeconds = data.memberSummary.reduce((s, m) => s + effSeconds(m, 'today'), 0);
    const totalWeekSeconds = data.memberSummary.reduce((s, m) => s + effSeconds(m, 'week'), 0);
    const totalUnassignedSeconds = data.memberSummary.reduce((s, m) => s + (m.monthUnassignedSeconds || 0), 0);
    const totalNpSeconds = data.memberSummary.reduce((s, m) => s + (m.monthNonProductiveSeconds || 0), 0);
    const stRow = summaryWs.getRow(scr);
    stRow.values = [
      'TOTAL',
      formatDuration(totalTodaySeconds),
      formatDuration(totalWeekSeconds),
      formatDuration(totalMonthSeconds),
      formatDuration(totalUnassignedSeconds),
      formatDuration(totalNpSeconds),
      '100%'
    ];
    styleTotalRow(stRow, SC);
  }

  // ── Generate and Download ──
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, `${filename}.xlsx`);
}

/**
 * Generate Excel report for multiple projects
 * Data is grouped by project with a Project column added to each sheet
 */
async function generateMultiProjectExcelReport(data, filename) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'JIRAForge Time Tracker';
  workbook.created = new Date();

  const projects = data.projects;
  const projectKeys = projects.map(p => p.projectKey).filter(Boolean);
  const dateRangeStr = projects.length > 0 ? formatDateRange(projects[0].startDate, projects[0].endDate) : '';

  // ═══════════════════════════════════════════════════
  // SHEET 1: Detailed Activity (Grouped by Project)
  // ═══════════════════════════════════════════════════
  const ws = workbook.addWorksheet('Detailed Activity (Grouped)');

  const COL_COUNT = 7;
  ws.columns = [
    { key: 'project', width: 16 },
    { key: 'member', width: 22 },
    { key: 'date', width: 16 },
    { key: 'issueKey', width: 18 },
    { key: 'classification', width: 16 },
    { key: 'totalTime', width: 14 },
    { key: 'timings', width: 40 }
  ];

  let cr = addTitleRow(ws, `Team Analytics – ${projectKeys.join(', ')}  |  ${dateRangeStr}`, COL_COUNT, 1);
  cr = addSubtitleRow(ws, 'Data grouped by project. Each row = one issue on one day.', COL_COUNT, cr);

  const hRow = ws.getRow(cr);
  hRow.values = ['Project', 'Member', 'Date', 'Issue Key', 'Classification', 'Total Time', 'Time (Start - End)'];
  styleHeaderRow(hRow, COL_COUNT);
  const headerRowNum = cr;
  ws.views = [{ state: 'frozen', ySplit: cr }];
  cr++;

  const allEntries = []; // { projectKey, memberName, date, issueKey, totalSeconds, sessions }

  for (const projData of projects) {
    // Project header row
    const projRow = ws.getRow(cr);
    ws.mergeCells(cr, 1, cr, COL_COUNT);
    const projCell = projRow.getCell(1);
    projCell.value = `📁  Project: ${projData.projectKey}`;
    projCell.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    projCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0052CC' } };
    projCell.alignment = { vertical: 'middle', horizontal: 'left' };
    projCell.border = thinBorder;
    projRow.height = 28;
    cr++;

    for (const member of projData.memberDetails) {
      // Combine productive and non-productive entries
      const productiveEntries = (member.entries || []).map(e => ({ ...e, classification: 'Productive' }));
      const npEntries = (member.nonProductiveEntries || []).map(e => ({ 
        ...e, 
        classification: e.classification === 'private' ? 'Private' : 'Non-Productive' 
      }));
      const allMemberEntries = [...productiveEntries, ...npEntries];

      const sortedEntries = allMemberEntries.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.issueKey.localeCompare(b.issueKey);
      });

      let rowIdx = 0;
      for (const entry of sortedEntries) {
        const sessions = [...entry.sessions]
          .filter(s => s.durationSeconds > 0)
          .sort((a, b) => {
            if (!a.startTime) return 1;
            if (!b.startTime) return -1;
            return new Date(a.startTime) - new Date(b.startTime);
          });

        allEntries.push({ ...entry, projectKey: projData.projectKey, memberName: member.displayName });

        const firstStart = sessions.length > 0 ? formatTime(sessions[0].startTime) : '';
        const lastEnd = sessions.length > 0 ? formatTime(sessions[sessions.length - 1].endTime) : '';
        const timingText = firstStart && lastEnd ? `${firstStart} - ${lastEnd}` : '—';

        const row = ws.getRow(cr);
        row.values = [
          projData.projectKey,
          member.displayName,
          formatDateFriendly(entry.date),
          entry.issueKey,
          entry.classification || 'Productive',
          formatDuration(entry.totalSeconds),
          timingText
        ];
        styleDataRow(row, COL_COUNT, rowIdx % 2 === 0);
        row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
        row.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF0052CC' } };
        row.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
        row.getCell(2).font = { size: 10, color: { argb: 'FF172B4D' } };
        row.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
        row.getCell(3).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
        row.getCell(4).alignment = { vertical: 'middle', horizontal: 'left' };
        row.getCell(5).alignment = { vertical: 'middle', horizontal: 'left' };
        row.getCell(6).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
        row.getCell(7).alignment = { vertical: 'middle', horizontal: 'left' };
        row.getCell(7).font = { size: 10, color: { argb: 'FF37474F' } };
        row.height = 20;

        cr++;
        rowIdx++;
      }

      // Member time summary rows (Today / This Week / This Month + breakdowns)
      if (member.todaySeconds !== undefined || member.weekSeconds !== undefined || member.monthSeconds !== undefined) {
        const mSummaryRow = ws.getRow(cr);
        mSummaryRow.getCell(1).value = projData.projectKey;
        mSummaryRow.getCell(2).value = member.displayName;
        ws.mergeCells(cr, 3, cr, COL_COUNT);
        // Total Time = project-matched time + unassigned (NULL project_key) time
        // so this line reflects the member's actual total work time, not just the
        // portion that could be attributed to a specific issue under this project.
        const mTodayTotal = (member.todaySeconds || 0) + (member.todayUnassignedSeconds || 0);
        const mWeekTotal = (member.weekSeconds || 0) + (member.weekUnassignedSeconds || 0);
        const mMonthTotal = (member.monthSeconds || 0) + (member.monthUnassignedSeconds || 0);
        mSummaryRow.getCell(3).value = `Total Time → Today: ${formatDuration(mTodayTotal)}  |  This Week: ${formatDuration(mWeekTotal)}  |  This Month: ${formatDuration(mMonthTotal)}`;
        mSummaryRow.height = 24;
        mSummaryRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          if (colNumber > COL_COUNT) return;
          cell.font = { bold: true, size: 10, color: { argb: COLORS.sectionFont } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.sectionBg } };
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
          cell.border = thinBorder;
        });
        cr++;

        // Breakdown row: Unassigned
        const unassignedRow = ws.getRow(cr);
        unassignedRow.getCell(1).value = '';
        unassignedRow.getCell(2).value = '';
        ws.mergeCells(cr, 3, cr, COL_COUNT);
        unassignedRow.getCell(3).value = `⚠ Unassigned → Today: ${formatDuration(member.todayUnassignedSeconds || 0)}  |  This Week: ${formatDuration(member.weekUnassignedSeconds || 0)}  |  This Month: ${formatDuration(member.monthUnassignedSeconds || 0)}`;
        unassignedRow.height = 22;
        unassignedRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          if (colNumber > COL_COUNT) return;
          cell.font = { bold: true, size: 9, color: { argb: 'FF7A5700' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } };
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
          cell.border = thinBorder;
        });
        cr++;

        // Breakdown row: Non-Productive & Private
        const npRow = ws.getRow(cr);
        npRow.getCell(1).value = '';
        npRow.getCell(2).value = '';
        ws.mergeCells(cr, 3, cr, COL_COUNT);
        npRow.getCell(3).value = `✖ Non-Productive / Private → Today: ${formatDuration(member.todayNonProductiveSeconds || 0)}  |  This Week: ${formatDuration(member.weekNonProductiveSeconds || 0)}  |  This Month: ${formatDuration(member.monthNonProductiveSeconds || 0)}`;
        npRow.height = 22;
        npRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          if (colNumber > COL_COUNT) return;
          cell.font = { bold: true, size: 9, color: { argb: 'FF8B0000' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4EC' } };
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
          cell.border = thinBorder;
        });
        cr++;
      }
    }
  }

  ws.autoFilter = { from: `A${headerRowNum}`, to: `G${cr - 1}` };

  // ═══════════════════════════════════════════════════
  // SHEET 2: Time by Issue (Grouped by Project)
  // ═══════════════════════════════════════════════════
  const issueWs = workbook.addWorksheet('Time by Issue');
  const IC = 5;
  issueWs.columns = [
    { key: 'project', width: 16 },
    { key: 'issueKey', width: 18 },
    { key: 'totalMin', width: 18 },
    { key: 'totalTime', width: 16 },
    { key: 'pct', width: 16 }
  ];

  let icr = addTitleRow(issueWs, `Time by Issue – ${projectKeys.join(', ')}`, IC, 1);

  const ihRow = issueWs.getRow(icr);
  ihRow.values = ['Project', 'Issue Key', 'Total Time (min)', 'Total Time', '% of Project Total'];
  styleHeaderRow(ihRow, IC);
  issueWs.autoFilter = { from: `A${icr}`, to: `E${icr}` };
  issueWs.views = [{ state: 'frozen', ySplit: icr }];
  icr++;

  let globalRowIdx = 0;
  for (const projData of projects) {
    // Aggregate per project
    const projEntries = allEntries.filter(e => e.projectKey === projData.projectKey);
    const issueMap = {};
    for (const entry of projEntries) {
      if (!issueMap[entry.issueKey]) issueMap[entry.issueKey] = 0;
      issueMap[entry.issueKey] += entry.totalSeconds;
    }
    const issueArray = Object.entries(issueMap)
      .map(([key, sec]) => ({ issueKey: key, totalSeconds: sec }))
      .sort((a, b) => b.totalSeconds - a.totalSeconds);
    const projTotalSec = issueArray.reduce((s, i) => s + i.totalSeconds, 0);

    issueArray.forEach((issue) => {
      const totalMin = Math.round(issue.totalSeconds / 60);
      const pct = projTotalSec > 0 ? ((issue.totalSeconds / projTotalSec) * 100).toFixed(1) : '0.0';
      const r = issueWs.getRow(icr);
      r.values = [projData.projectKey, issue.issueKey, totalMin, formatDuration(issue.totalSeconds), `${pct}%`];
      styleDataRow(r, IC, globalRowIdx % 2 === 0);
      r.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };
      r.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF0052CC' } };
      r.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
      icr++;
      globalRowIdx++;
    });

    // Subtotal per project
    const projMin = Math.round(projTotalSec / 60);
    const stRow = issueWs.getRow(icr);
    stRow.values = [`${projData.projectKey} Total`, '', projMin, formatDuration(projTotalSec), '100.0%'];
    styleTotalRow(stRow, IC);
    icr++;
    globalRowIdx++;
  }

  // Grand total
  const grandTotalSec = allEntries.reduce((s, e) => s + e.totalSeconds, 0);
  const grandMin = Math.round(grandTotalSec / 60);
  const gtRow = issueWs.getRow(icr);
  gtRow.values = ['GRAND TOTAL', '', grandMin, formatDuration(grandTotalSec), ''];
  styleTotalRow(gtRow, IC);

  // ═══════════════════════════════════════════════════
  // SHEET 3: Summary (per Project)
  // ═══════════════════════════════════════════════════
  const summaryWs = workbook.addWorksheet('Summary');
  const SC = 8;
  summaryWs.columns = [
    { key: 'c1', width: 16 },
    { key: 'c2', width: 24 },
    { key: 'c3', width: 16 },
    { key: 'c4', width: 16 },
    { key: 'c5', width: 16 },
    { key: 'c6', width: 18 },
    { key: 'c7', width: 24 },
    { key: 'c8', width: 14 }
  ];

  let scr = addTitleRow(summaryWs, `Team Summary – ${projectKeys.join(', ')}  |  ${dateRangeStr}`, SC, 1);

  // Today/Week/Month = project-matched time + unassigned (NULL project_key) time so
  // the columns reflect each member's actual total work time. "Unassigned (Month)"
  // stays as an informational breakdown column (subset of "This Month").
  const effSeconds = (m, bucket) => (m[`${bucket}Seconds`] || Math.round((m[`${bucket}Hours`] || 0) * 3600)) + (m[`${bucket}UnassignedSeconds`] || 0);

  // Per-project summary sections
  const projectMonthSeconds = []; // per-project actual total for grand total aggregation
  for (const projData of projects) {
    // Project header
    const projHeaderRow = summaryWs.getRow(scr);
    summaryWs.mergeCells(scr, 1, scr, SC);
    const projCell = projHeaderRow.getCell(1);
    projCell.value = `Project: ${projData.projectKey}`;
    projCell.font = { bold: true, size: 12, color: { argb: COLORS.sectionFont } };
    projCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.sectionBg } };
    projCell.alignment = { vertical: 'middle', horizontal: 'left' };
    projCell.border = thinBorder;
    projHeaderRow.height = 28;
    scr++;

    // Project actual totals (include unassigned)
    const projTotalMonthSeconds = (projData.memberSummary || []).reduce((s, m) => s + effSeconds(m, 'month'), 0);
    const projActualTotalHours = Math.round(projTotalMonthSeconds / 3600 * 10) / 10;
    const projMemberCount = (projData.memberSummary || []).length;
    const projActualAvgHours = projMemberCount > 0 ? Math.round(projTotalMonthSeconds / 3600 / projMemberCount * 10) / 10 : 0;
    projectMonthSeconds.push(projTotalMonthSeconds);

    // Info rows
    const infoRows = [
      ['Active Members', projData.summary.activeMembers],
      ['Total Hours', `${projActualTotalHours}h`],
      ['Issues Worked', projData.summary.issuesWorked],
      ['Avg Hours/Member', `${projActualAvgHours}h`]
    ];
    infoRows.forEach((vals, i) => {
      const r = summaryWs.getRow(scr);
      r.values = ['', vals[0], vals[1], '', '', ''];
      styleDataRow(r, 3, i % 2 === 0);
      r.getCell(2).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
      r.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
      r.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
      scr++;
    });
    scr++; // spacer

    if (projData.memberSummary && projData.memberSummary.length > 0) {
      // Member Summary Table header
      const mhRow = summaryWs.getRow(scr);
      mhRow.values = ['Project', 'Member Name', 'Today', 'This Week', 'This Month', 'Unassigned (Month)', 'Non-Productive / Private (Month)', '% of Total'];
      styleHeaderRow(mhRow, SC);
      scr++;

      projData.memberSummary.forEach((m, i) => {
        const memberMonthSec = effSeconds(m, 'month');
        // Recompute percentage against the new project total so it matches the column values.
        const percentage = projTotalMonthSeconds > 0 ? Math.round((memberMonthSec / projTotalMonthSeconds) * 100) : 0;
        const r = summaryWs.getRow(scr);
        r.values = [
          projData.projectKey,
          m.displayName,
          formatDuration(effSeconds(m, 'today')),
          formatDuration(effSeconds(m, 'week')),
          formatDuration(memberMonthSec),
          formatDuration(m.monthUnassignedSeconds || 0),
          formatDuration(m.monthNonProductiveSeconds || 0),
          `${percentage}%`
        ];
        styleDataRow(r, SC, i % 2 === 0);
        r.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF0052CC' } };
        r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
        r.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
        scr++;
      });

      // Project total
      const totalTodaySeconds = projData.memberSummary.reduce((s, m) => s + effSeconds(m, 'today'), 0);
      const totalWeekSeconds = projData.memberSummary.reduce((s, m) => s + effSeconds(m, 'week'), 0);
      const totalUnassignedSeconds = projData.memberSummary.reduce((s, m) => s + (m.monthUnassignedSeconds || 0), 0);
      const totalNpSeconds = projData.memberSummary.reduce((s, m) => s + (m.monthNonProductiveSeconds || 0), 0);
      const stRow = summaryWs.getRow(scr);
      stRow.values = [
        '',
        `${projData.projectKey} TOTAL`,
        formatDuration(totalTodaySeconds),
        formatDuration(totalWeekSeconds),
        formatDuration(projTotalMonthSeconds),
        formatDuration(totalUnassignedSeconds),
        formatDuration(totalNpSeconds),
        '100%'
      ];
      styleTotalRow(stRow, SC);
      scr++;
    }

    scr++; // spacer between projects
  }

  // Grand totals across all projects
  const grandActiveMembers = [...new Set(projects.flatMap(p => (p.memberSummary || []).map(m => m.displayName)))].length;
  const grandTotalHours = Math.round(projectMonthSeconds.reduce((s, sec) => s + sec, 0) / 3600 * 10) / 10;
  const grandIssuesWorked = projects.reduce((s, p) => s + (p.summary?.issuesWorked || 0), 0);

  const grandHeaderRow = summaryWs.getRow(scr);
  summaryWs.mergeCells(scr, 1, scr, SC);
  const grandCell = grandHeaderRow.getCell(1);
  grandCell.value = 'Grand Totals (All Projects)';
  grandCell.font = { bold: true, size: 12, color: { argb: COLORS.totalFont } };
  grandCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.totalBg } };
  grandCell.alignment = { vertical: 'middle', horizontal: 'left' };
  grandCell.border = thinBorder;
  grandHeaderRow.height = 28;
  scr++;

  const grandInfoRows = [
    ['Total Projects', projects.length],
    ['Active Members (unique)', grandActiveMembers],
    ['Total Hours', `${Math.round(grandTotalHours * 10) / 10}h`],
    ['Total Issues Worked', grandIssuesWorked]
  ];
  grandInfoRows.forEach((vals, i) => {
    const r = summaryWs.getRow(scr);
    r.values = ['', vals[0], vals[1], '', '', ''];
    styleDataRow(r, 3, i % 2 === 0);
    r.getCell(2).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
    r.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
    r.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
    scr++;
  });

  // ── Generate and Download ──
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, `${filename}.xlsx`);
}

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

function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// ── Shared Styles ──

const COLORS = {
  headerBg: 'FF0052CC',      // Jira blue
  headerFont: 'FFFFFFFF',    // White
  sectionBg: 'FFDEEBFF',     // Light blue
  sectionFont: 'FF0052CC',   // Blue
  rowEvenBg: 'FFF8F9FA',     // Very light gray
  rowOddBg: 'FFFFFFFF',      // White
  borderColor: 'FFD0D4DB',   // Light border
  totalBg: 'FFE3FCEF',       // Light green
  totalFont: 'FF006644',     // Dark green
  memberHeaderBg: 'FF4C9AFF', // Lighter blue
};

const thinBorder = {
  top: { style: 'thin', color: { argb: COLORS.borderColor } },
  bottom: { style: 'thin', color: { argb: COLORS.borderColor } },
  left: { style: 'thin', color: { argb: COLORS.borderColor } },
  right: { style: 'thin', color: { argb: COLORS.borderColor } }
};

function applyHeaderStyle(row, colCount) {
  row.height = 28;
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { bold: true, size: 11, color: { argb: COLORS.headerFont } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder;
  });
}

function applySectionStyle(row, colCount) {
  row.height = 26;
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { bold: true, size: 12, color: { argb: COLORS.sectionFont } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.sectionBg } };
    cell.alignment = { vertical: 'middle' };
    cell.border = thinBorder;
  });
}

function applyDataRowStyle(row, colCount, isEven) {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { size: 10, color: { argb: 'FF172B4D' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? COLORS.rowEvenBg : COLORS.rowOddBg } };
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.border = thinBorder;
  });
}

function applyTotalRowStyle(row, colCount) {
  row.height = 22;
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { bold: true, size: 11, color: { argb: COLORS.totalFont } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.totalBg } };
    cell.alignment = { vertical: 'middle' };
    cell.border = thinBorder;
  });
}

/**
 * Generate and download a formatted Excel report
 */
export async function generateExcelReport(data, filename) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'JIRAForge Time Tracker';
  workbook.created = new Date();

  // ═══════════════════════════════════════════
  // SHEET 1: Detailed Activity (Grouped)
  // ═══════════════════════════════════════════
  const ws = workbook.addWorksheet('Detailed Activity (Grouped)', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  const COL_COUNT = 5;
  const detailCols = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Issue Key', key: 'issueKey', width: 18 },
    { header: 'Total Time', key: 'totalTime', width: 16 },
    { header: 'Sessions', key: 'sessionCount', width: 11 },
    { header: 'Session Timings  ▼', key: 'timings', width: 44 }
  ];
  ws.columns = detailCols;
  applyHeaderStyle(ws.getRow(1), COL_COUNT);
  ws.autoFilter = { from: 'A1', to: 'E1' };

  let currentRow = 2;

  for (const member of data.memberDetails) {
    // ── Member section header ──
    const memberRow = ws.getRow(currentRow);
    ws.mergeCells(currentRow, 1, currentRow, COL_COUNT);
    memberRow.getCell(1).value = `${member.displayName}  —  Total: ${formatDuration(member.totalSeconds)}`;
    applySectionStyle(memberRow, COL_COUNT);
    currentRow++;

    // Sort entries by date → issue key
    const sortedEntries = [...member.entries].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.issueKey.localeCompare(b.issueKey);
    });

    let rowIndex = 0;
    for (const entry of sortedEntries) {
      // Sort sessions by start time, keep all sessions (show seconds)
      const validSessions = [...entry.sessions]
        .filter(s => s.durationSeconds > 0)
        .sort((a, b) => {
          if (!a.startTime) return 1;
          if (!b.startTime) return -1;
          return new Date(a.startTime) - new Date(b.startTime);
        });

      const sessionCount = validSessions.length;

      // Build session timings as multi-line string in ONE cell
      const timingsText = validSessions
        .map(s => `${formatTime(s.startTime)}  →  ${formatTime(s.endTime)}  (${formatDuration(s.durationSeconds)})`)
        .join('\n');

      // ── Data row: Date | Issue Key | Total Time ▼ | Sessions | Session Timings ──
      const dataRow = ws.getRow(currentRow);
      dataRow.values = [
        entry.date,
        entry.issueKey,
        `${formatDuration(entry.totalSeconds)}  ▼`,
        sessionCount,
        timingsText || '—'
      ];
      applyDataRowStyle(dataRow, COL_COUNT, rowIndex % 2 === 0);
      dataRow.getCell(1).alignment = { vertical: 'top', horizontal: 'center' };
      dataRow.getCell(2).alignment = { vertical: 'top', horizontal: 'left' };
      dataRow.getCell(3).font = { bold: true, size: 10, color: { argb: 'FF0052CC' } };
      dataRow.getCell(3).alignment = { vertical: 'top', horizontal: 'center' };
      dataRow.getCell(4).alignment = { vertical: 'top', horizontal: 'center' };
      dataRow.getCell(5).alignment = { vertical: 'top', wrapText: true };
      dataRow.getCell(5).font = { size: 9, color: { argb: 'FF505F79' } };
      // Auto-height based on session count
      dataRow.height = Math.max(22, sessionCount * 15);

      currentRow++;
      rowIndex++;
    }

    // Total row for this member
    const totalRow = ws.getRow(currentRow);
    totalRow.values = ['', 'TOTAL', formatDuration(member.totalSeconds), '', ''];
    applyTotalRowStyle(totalRow, COL_COUNT);
    totalRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'center' };
    currentRow++;

    // Spacer
    currentRow++;
  }

  // ── TEAM SUMMARY at bottom of same sheet ──
  currentRow++; // extra spacer

  // Team Summary Header
  const teamSumHeaderRow = ws.getRow(currentRow);
  ws.mergeCells(currentRow, 1, currentRow, COL_COUNT);
  teamSumHeaderRow.getCell(1).value = 'TEAM SUMMARY';
  applySectionStyle(teamSumHeaderRow, COL_COUNT);
  currentRow++;

  // Summary metric rows
  const summaryMetrics = [
    ['Project', data.projectKey || 'All Projects'],
    ['Period', `${data.startDate} to ${data.endDate}`],
    ['Generated', new Date(data.generatedAt).toLocaleString()],
    ['Active Members', data.summary.activeMembers],
    ['Total Hours', `${data.summary.totalHours}h`],
    ['Issues Worked', data.summary.issuesWorked],
    ['Avg Hours/Member', `${data.summary.avgHoursPerMember}h`]
  ];

  summaryMetrics.forEach((vals, i) => {
    const r = ws.getRow(currentRow);
    r.values = [vals[0], vals[1], '', '', ''];
    applyDataRowStyle(r, COL_COUNT, i % 2 === 0);
    r.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
    r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
    r.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
    currentRow++;
  });

  currentRow++; // spacer

  // Member Summary Header
  if (data.memberSummary && data.memberSummary.length > 0) {
    const memSumHeaderRow = ws.getRow(currentRow);
    ws.mergeCells(currentRow, 1, currentRow, COL_COUNT);
    memSumHeaderRow.getCell(1).value = 'MEMBER SUMMARY';
    applySectionStyle(memSumHeaderRow, COL_COUNT);
    currentRow++;

    // Column headers for member summary
    const memColHeaderRow = ws.getRow(currentRow);
    memColHeaderRow.values = ['Member Name', 'Today', 'This Week', 'This Month', '% of Total'];
    memColHeaderRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber > 5) return;
      cell.font = { bold: true, size: 10, color: { argb: COLORS.headerFont } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.memberHeaderBg } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = thinBorder;
    });
    memColHeaderRow.height = 24;
    currentRow++;

    data.memberSummary.forEach((m, i) => {
      const r = ws.getRow(currentRow);
      r.values = [m.displayName, `${m.todayHours}h`, `${m.weekHours}h`, `${m.monthHours}h`, `${m.percentage}%`];
      applyDataRowStyle(r, 5, i % 2 === 0);
      r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      for (let c = 2; c <= 5; c++) {
        r.getCell(c).alignment = { vertical: 'middle', horizontal: 'center' };
      }
      currentRow++;
    });

    // Total row
    const totalMemberHours = data.memberSummary.reduce((s, m) => s + m.monthHours, 0);
    const totalToday = data.memberSummary.reduce((s, m) => s + m.todayHours, 0);
    const totalWeek = data.memberSummary.reduce((s, m) => s + m.weekHours, 0);
    const memTotalR = ws.getRow(currentRow);
    memTotalR.values = [
      'TOTAL',
      `${Math.round(totalToday * 10) / 10}h`,
      `${Math.round(totalWeek * 10) / 10}h`,
      `${Math.round(totalMemberHours * 10) / 10}h`,
      '100%'
    ];
    applyTotalRowStyle(memTotalR, 5);
    for (let c = 1; c <= 5; c++) {
      memTotalR.getCell(c).alignment = { vertical: 'middle', horizontal: 'center' };
    }
    currentRow++;
  }

  // ═══════════════════════════════════════════
  // SHEET 2: Summary
  // ═══════════════════════════════════════════
  if (data.memberSummary && data.memberSummary.length > 0) {
    const summaryWs = workbook.addWorksheet('Summary', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    summaryWs.columns = [
      { header: 'Metric', key: 'metric', width: 22 },
      { header: 'Value', key: 'value', width: 22 }
    ];
    applyHeaderStyle(summaryWs.getRow(1), 2);
    summaryWs.autoFilter = { from: 'A1', to: 'B1' };

    const infoRows = [
      ['Project', data.projectKey || 'All Projects'],
      ['Period', `${data.startDate} to ${data.endDate}`],
      ['Generated', new Date(data.generatedAt).toLocaleString()],
      ['Active Members', data.summary.activeMembers],
      ['Total Hours', `${data.summary.totalHours}h`],
      ['Issues Worked', data.summary.issuesWorked],
      ['Avg Hours/Member', `${data.summary.avgHoursPerMember}h`]
    ];

    infoRows.forEach((vals, i) => {
      const r = summaryWs.addRow(vals);
      applyDataRowStyle(r, 2, i % 2 === 0);
      r.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
    });

    // Spacer
    summaryWs.addRow([]);

    // ── Member Summary Table ──
    const memberHeaderRow = summaryWs.addRow(['Member Name', 'Today', 'This Week', 'This Month', '% of Total']);
    memberHeaderRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber > 5) return;
      cell.font = { bold: true, size: 11, color: { argb: COLORS.headerFont } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.memberHeaderBg } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = thinBorder;
    });
    memberHeaderRow.height = 24;

    // Set wider columns for summary area
    summaryWs.getColumn(1).width = 24;
    summaryWs.getColumn(2).width = 14;
    summaryWs.getColumn(3).width = 14;
    summaryWs.getColumn(4).width = 14;
    summaryWs.getColumn(5).width = 14;

    data.memberSummary.forEach((m, i) => {
      const r = summaryWs.addRow([m.displayName, `${m.todayHours}h`, `${m.weekHours}h`, `${m.monthHours}h`, `${m.percentage}%`]);
      applyDataRowStyle(r, 5, i % 2 === 0);
      r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      for (let c = 2; c <= 5; c++) {
        r.getCell(c).alignment = { vertical: 'middle', horizontal: 'center' };
      }
    });

    // Total row
    const totalMemberHours = data.memberSummary.reduce((s, m) => s + m.monthHours, 0);
    const totalToday = data.memberSummary.reduce((s, m) => s + m.todayHours, 0);
    const totalWeek = data.memberSummary.reduce((s, m) => s + m.weekHours, 0);
    const totalR = summaryWs.addRow([
      'TOTAL',
      `${Math.round(totalToday * 10) / 10}h`,
      `${Math.round(totalWeek * 10) / 10}h`,
      `${Math.round(totalMemberHours * 10) / 10}h`,
      '100%'
    ]);
    applyTotalRowStyle(totalR, 5);
    for (let c = 1; c <= 5; c++) {
      totalR.getCell(c).alignment = { vertical: 'middle', horizontal: 'center' };
    }
  }

  // ═══════════════════════════════════════════
  // SHEET 3: Time by Issue (multi-user only)
  // ═══════════════════════════════════════════
  if (data.timeByIssue && data.timeByIssue.length > 0) {
    const issueWs = workbook.addWorksheet('Time by Issue', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    issueWs.columns = [
      { header: 'Issue Key', key: 'issueKey', width: 18 },
      { header: 'Total Time', key: 'totalTime', width: 16 },
      { header: 'Contributors', key: 'contributors', width: 34 },
      { header: '% of Total', key: 'percentage', width: 14 }
    ];
    applyHeaderStyle(issueWs.getRow(1), 4);
    issueWs.autoFilter = { from: 'A1', to: 'D1' };

    data.timeByIssue.forEach((issue, i) => {
      const r = issueWs.addRow([
        issue.issueKey,
        formatDuration(issue.totalSeconds),
        issue.contributors.join(', '),
        `${issue.percentage}%`
      ]);
      applyDataRowStyle(r, 4, i % 2 === 0);
      r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      r.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
      r.getCell(2).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
      r.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // Total
    const totalSec = data.timeByIssue.reduce((s, i) => s + i.totalSeconds, 0);
    const totalR = issueWs.addRow(['TOTAL', formatDuration(totalSec), '', '100%']);
    applyTotalRowStyle(totalR, 4);
    totalR.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
    totalR.getCell(4).alignment = { vertical: 'middle', horizontal: 'center' };
  }

  // ── Generate and Download ──
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, `${filename}.xlsx`);
}

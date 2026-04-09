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
 */
export async function generateExcelReport(data, filename) {
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
    { key: 'totalTime', width: 14 },
    { key: 'entries', width: 12 },
    { key: 'timings', width: 90 }
  ];

  // Title
  let cr = addTitleRow(ws, `Team Analytics – ${data.projectKey || 'All'} Project  |  ${dateRangeStr}  |  ${memberNames}`, COL_COUNT, 1);
  // Subtitle
  cr = addSubtitleRow(ws, 'Each row = one issue on one day. All individual time entries are in the last column.', COL_COUNT, cr);

  // Header row
  const hRow = ws.getRow(cr);
  hRow.values = ['Member', 'Date', 'Issue Key', 'Total Time', 'Entries', 'Time Breakdown (Start - End | Duration)'];
  styleHeaderRow(hRow, COL_COUNT);
  const headerRowNum = cr;
  ws.views = [{ state: 'frozen', ySplit: cr }];
  cr++;

  // Collect all entries across all members for the pivot later
  const allEntries = [];

  for (const member of data.memberDetails) {
    const sortedEntries = [...member.entries].sort((a, b) => {
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

      const breakdownParts = sessions.map(s =>
        `${formatTime(s.startTime)}-${formatTime(s.endTime)} (${formatDurationShort(s.durationSeconds)})`
      );
      const breakdownText = breakdownParts.join(' | ');

      const row = ws.getRow(cr);
      row.values = [
        member.displayName,
        formatDateFriendly(entry.date),
        entry.issueKey,
        formatDuration(entry.totalSeconds),
        sessions.length,
        breakdownText || '—'
      ];
      styleDataRow(row, COL_COUNT, rowIdx % 2 === 0);
      row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(1).font = { size: 10, color: { argb: 'FF172B4D' } };
      row.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(2).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
      row.getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
      row.getCell(4).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
      row.getCell(6).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
      row.getCell(6).font = { size: 9, color: { argb: 'FF37474F' } };
      // Auto-height: ~15px per ~120 chars
      const lineCount = Math.max(1, Math.ceil(breakdownText.length / 120));
      row.height = Math.max(20, lineCount * 16);

      cr++;
      rowIdx++;
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
  // SHEET 3: Daily Time Pivot
  // ═══════════════════════════════════════════════════
  const pivotWs = workbook.addWorksheet('Daily Time Pivot');

  // Get unique dates and issue keys
  const dateSet = new Set();
  const issueKeySet = new Set();
  for (const entry of allEntries) {
    dateSet.add(entry.date);
    issueKeySet.add(entry.issueKey);
  }
  const dates = [...dateSet].sort();
  // Sort issue keys by total time descending
  const issueKeys = issueArray.map(i => i.issueKey);
  const PC = issueKeys.length + 2; // Date + issues + Day Total

  // Set columns
  pivotWs.columns = [
    { key: 'date', width: 16 },
    ...issueKeys.map(k => ({ key: k, width: 16 })),
    { key: 'dayTotal', width: 14 }
  ];

  // Title
  let pcr = addTitleRow(pivotWs, 'Daily Time Pivot – Minutes per Issue per Day', PC, 1);

  // Header row
  const phRow = pivotWs.getRow(pcr);
  phRow.values = ['Date', ...issueKeys, 'Day Total'];
  phRow.height = 30;
  phRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > PC) return;
    cell.font = { bold: true, size: 10, color: { argb: COLORS.headerFont } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder;
  });
  pivotWs.views = [{ state: 'frozen', ySplit: pcr }];
  pcr++;

  // Build pivot data: { date -> { issueKey -> minutes } }
  const pivotData = {};
  for (const entry of allEntries) {
    if (!pivotData[entry.date]) pivotData[entry.date] = {};
    pivotData[entry.date][entry.issueKey] = (pivotData[entry.date][entry.issueKey] || 0) + Math.round(entry.totalSeconds / 60);
  }

  // Column totals
  const colTotals = {};
  issueKeys.forEach(k => { colTotals[k] = 0; });
  let grandDayTotal = 0;

  dates.forEach((date, di) => {
    const row = pivotWs.getRow(pcr);
    const dayData = pivotData[date] || {};
    let dayTotal = 0;
    const vals = [formatDateFriendly(date)];
    issueKeys.forEach(k => {
      const min = dayData[k] || 0;
      vals.push(min > 0 ? min : '–');
      colTotals[k] += min;
      dayTotal += min;
    });
    vals.push(dayTotal);
    grandDayTotal += dayTotal;
    row.values = vals;

    // Style
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber > PC) return;
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.font = { size: 10, color: { argb: 'FF172B4D' } };

      if (colNumber === 1) {
        // Date column - bold
        cell.font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: di % 2 === 0 ? 'FFE8EAF6' : 'FFFFFFFF' } };
      } else if (colNumber === PC) {
        // Day Total - bold
        cell.font = { bold: true, size: 10, color: { argb: 'FF1A237E' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBBDEFB' } };
      } else {
        // Issue columns - pastel colors
        const colorIdx = (colNumber - 2) % COLORS.pivotColors.length;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.pivotColors[colorIdx] } };
        if (cell.value === '–') {
          cell.font = { size: 10, color: { argb: 'FFBDBDBD' } };
        }
      }
    });
    row.height = 22;
    pcr++;
  });

  // TOTAL row
  const ptRow = pivotWs.getRow(pcr);
  const ptVals = ['TOTAL'];
  issueKeys.forEach(k => { ptVals.push(colTotals[k]); });
  ptVals.push(grandDayTotal);
  ptRow.values = ptVals;
  styleTotalRow(ptRow, PC);
  ptRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' };

  // ═══════════════════════════════════════════════════
  // SHEET 4: Summary
  // ═══════════════════════════════════════════════════
  if (data.memberSummary && data.memberSummary.length > 0) {
    const summaryWs = workbook.addWorksheet('Summary');
    const SC = 5;
    summaryWs.columns = [
      { key: 'c1', width: 24 },
      { key: 'c2', width: 16 },
      { key: 'c3', width: 16 },
      { key: 'c4', width: 16 },
      { key: 'c5', width: 16 }
    ];

    let scr = addTitleRow(summaryWs, `Team Summary – ${data.projectKey || 'All'} Project  |  ${dateRangeStr}`, SC, 1);

    // Info rows
    const infoRows = [
      ['Active Members', data.summary.activeMembers],
      ['Total Hours', `${data.summary.totalHours}h`],
      ['Issues Worked', data.summary.issuesWorked],
      ['Avg Hours/Member', `${data.summary.avgHoursPerMember}h`]
    ];
    infoRows.forEach((vals, i) => {
      const r = summaryWs.getRow(scr);
      r.values = [vals[0], vals[1], '', '', ''];
      styleDataRow(r, 2, i % 2 === 0);
      r.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF172B4D' } };
      r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      r.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
      scr++;
    });
    scr++; // spacer

    // Member Summary Table
    const mhRow = summaryWs.getRow(scr);
    mhRow.values = ['Member Name', 'Today', 'This Week', 'This Month', '% of Total'];
    styleHeaderRow(mhRow, SC);
    scr++;

    data.memberSummary.forEach((m, i) => {
      const r = summaryWs.getRow(scr);
      r.values = [m.displayName, `${m.todayHours}h`, `${m.weekHours}h`, `${m.monthHours}h`, `${m.percentage}%`];
      styleDataRow(r, SC, i % 2 === 0);
      r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      scr++;
    });

    // Total
    const totalMemberHours = data.memberSummary.reduce((s, m) => s + m.monthHours, 0);
    const totalToday = data.memberSummary.reduce((s, m) => s + m.todayHours, 0);
    const totalWeek = data.memberSummary.reduce((s, m) => s + m.weekHours, 0);
    const stRow = summaryWs.getRow(scr);
    stRow.values = [
      'TOTAL',
      `${Math.round(totalToday * 10) / 10}h`,
      `${Math.round(totalWeek * 10) / 10}h`,
      `${Math.round(totalMemberHours * 10) / 10}h`,
      '100%'
    ];
    styleTotalRow(stRow, SC);
  }

  // ── Generate and Download ──
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, `${filename}.xlsx`);
}

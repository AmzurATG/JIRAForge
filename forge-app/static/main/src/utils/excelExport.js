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
//
// Restricted palette (3 colors + neutrals) for a calmer, more report-grade look:
//   navy   — primary structural color (titles, headers, banners)
//   sky    — soft accent for sub-banners (per-member roll-up rows)
//   sage   — totals/grand-totals row
//   neutrals for row alternation, borders, secondary text.

const COLORS = {
  navy: 'FF1F3A5F',
  navyText: 'FFFFFFFF',
  sky: 'FFEAF1FA',
  skyText: 'FF1F3A5F',
  sage: 'FFE8F1E4',
  sageText: 'FF2C5F2D',
  rowEvenBg: 'FFFAFBFC',
  rowOddBg: 'FFFFFFFF',
  borderColor: 'FFD0D7DE',
  bodyText: 'FF1F2328',
  subtleText: 'FF6E7781',
  warnBg: 'FFFFF8E1',
  warnText: 'FF7A5700'
};

const thinBorder = {
  top: { style: 'thin', color: { argb: COLORS.borderColor } },
  bottom: { style: 'thin', color: { argb: COLORS.borderColor } },
  left: { style: 'thin', color: { argb: COLORS.borderColor } },
  right: { style: 'thin', color: { argb: COLORS.borderColor } }
};

function styleHeaderRow(row, colCount) {
  row.height = 28;
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { bold: true, size: 11, color: { argb: COLORS.navyText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder;
  });
}

function styleDataRow(row, colCount, isEven) {
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { size: 10, color: { argb: COLORS.bodyText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? COLORS.rowEvenBg : COLORS.rowOddBg } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = thinBorder;
  });
}

function styleTotalRow(row, colCount) {
  row.height = 24;
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { bold: true, size: 11, color: { argb: COLORS.sageText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.sage } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = thinBorder;
  });
}

function addTitleRow(ws, text, colCount, rowNum) {
  const row = ws.getRow(rowNum);
  ws.mergeCells(rowNum, 1, rowNum, colCount);
  const cell = row.getCell(1);
  cell.value = text;
  cell.font = { bold: true, size: 14, color: { argb: COLORS.navyText } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  cell.border = thinBorder;
  row.height = 30;
  return rowNum + 1;
}

function addSubtitleRow(ws, text, colCount, rowNum) {
  const row = ws.getRow(rowNum);
  ws.mergeCells(rowNum, 1, rowNum, colCount);
  const cell = row.getCell(1);
  cell.value = text;
  cell.font = { italic: true, size: 10, color: { argb: COLORS.subtleText } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  row.height = 18;
  return rowNum + 1;
}

/**
 * Render a project section banner (clean, no emoji — works across all systems).
 */
function addBannerRow(ws, text, colCount, rowNum) {
  const row = ws.getRow(rowNum);
  ws.mergeCells(rowNum, 1, rowNum, colCount);
  const cell = row.getCell(1);
  cell.value = text;
  cell.font = { bold: true, size: 12, color: { argb: COLORS.skyText } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.sky } };
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  cell.border = thinBorder;
  row.height = 26;
  return rowNum + 1;
}

/**
 * Render a labeled key/value pair as a row pair (label cell + value cell).
 * Used inside the executive Report Header block.
 */
function addKeyValueRow(ws, label, value, rowNum, opts = {}) {
  const row = ws.getRow(rowNum);
  const labelCell = row.getCell(1);
  labelCell.value = label;
  labelCell.font = { bold: true, size: 10, color: { argb: COLORS.subtleText } };
  labelCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.rowEvenBg } };
  labelCell.border = thinBorder;

  const valueCell = row.getCell(2);
  valueCell.value = value;
  valueCell.font = { bold: !!opts.bold, size: opts.size || 11, color: { argb: COLORS.bodyText } };
  valueCell.alignment = { vertical: 'middle', horizontal: 'left' };
  valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.rowOddBg } };
  valueCell.border = thinBorder;
  row.height = 20;
  return rowNum + 1;
}

/**
 * Build an executive "Report Header" block at the top of a sheet:
 * project list, period, generated-at, total hours, members. Self-documenting
 * even if the file is shared without context.
 */
function addReportHeader(ws, { title, projectLabel, dateRangeStr, generatedAt, totalHours, memberCount, issuesWorked }, colCount, rowNum) {
  let r = rowNum;
  r = addTitleRow(ws, title, colCount, r);

  const facts = [
    ['Project(s)', projectLabel],
    ['Period', dateRangeStr],
    ['Active Members', String(memberCount)],
    ['Issues Worked', String(issuesWorked)],
    ['Total Time (Period)', totalHours],
    ['Generated', generatedAt],
  ];
  for (const [k, v] of facts) {
    r = addKeyValueRow(ws, k, v, r);
  }
  // Spacer row
  ws.getRow(r).height = 8;
  r += 1;
  return r;
}

/**
 * Render the "Time (Start – End)" cell. When a row collapses multiple disjoint
 * sessions onto one (date, issueKey) pair, the literal "first start – last end"
 * range can look absurd (e.g. "9:54 AM – 11:15 PM" for a 2-minute total). For
 * multi-session rows, annotate with the session count so readers know the range
 * is non-contiguous.
 *
 * @param {Array<{startTime?: string|null, endTime?: string|null, durationSeconds?: number}>} sessions
 */
function formatSessionRange(sessions) {
  const valid = (sessions || [])
    .filter(s => s && (s.durationSeconds || 0) > 0 && s.startTime)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  if (valid.length === 0) return '—';
  const first = formatTime(valid[0].startTime);
  const last = formatTime(valid[valid.length - 1].endTime);
  if (valid.length === 1) return `${first} – ${last}`;
  return `${first} – ${last} (${valid.length} sessions)`;
}

/**
 * Format a "total time" duration using the same fmt as below, but null-safe.
 */
function hoursLabel(seconds) {
  if (!seconds || seconds <= 0) return '0h';
  const h = seconds / 3600;
  if (h >= 10) return `${h.toFixed(1)}h`;
  return `${formatDuration(Math.round(seconds))}`;
}

/**
 * Aggregate time-per-issue (across members) from a list of memberDetails.
 * Returns an object keyed by issueKey with the total seconds. Caller decides
 * whether to include non-productive entries; we include both by default since
 * the "Time by Issue" view should match the Detailed Activity total.
 */
function computeIssueAggregation(memberDetails) {
  const issueMap = {};
  for (const m of memberDetails || []) {
    for (const e of (m.entries || [])) {
      issueMap[e.issueKey] = (issueMap[e.issueKey] || 0) + (e.totalSeconds || 0);
    }
    for (const e of (m.nonProductiveEntries || [])) {
      issueMap[e.issueKey] = (issueMap[e.issueKey] || 0) + (e.totalSeconds || 0);
    }
  }
  return issueMap;
}

/**
 * Render a single sky-banded roll-up row after a member's detail rows,
 * showing their total time for the selected period and a productive /
 * non-productive split. Replaces three banded rows in the old format that
 * showed Today/Week/Month + Unassigned + Non-Productive — values that were
 * misleading for custom date ranges and noisy in print.
 *
 * `extraColsBefore` is for multi-project sheets where a leading "Project"
 * column shifts the layout right by one.
 */
function renderMemberRollup(ws, member, colCount, rowNum, extraColsBefore = 0) {
  const periodSec = member.totalSeconds || 0;
  const npSec = member.nonProductiveTotalSeconds || 0;
  const prodSec = Math.max(0, periodSec - npSec);

  const row = ws.getRow(rowNum);
  const labelCol = 1 + extraColsBefore;
  const valueCol = labelCol + 1;
  if (valueCol < colCount) ws.mergeCells(rowNum, valueCol, rowNum, colCount);

  row.getCell(labelCol).value = member.displayName;
  row.getCell(valueCol).value = `Period total: ${formatDuration(periodSec)}` +
    (npSec > 0 ? `  •  Productive: ${formatDuration(prodSec)}  •  Non-Productive / Private: ${formatDuration(npSec)}` : '');

  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    if (colNumber > colCount) return;
    cell.font = { bold: true, size: 10, color: { argb: COLORS.skyText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.sky } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = thinBorder;
  });
  row.height = 22;
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

  const dateRangeStr = formatDateRange(data.startDate, data.endDate);
  const activeMembers = (data.memberDetails || []).filter(m => (m.totalSeconds || 0) > 0);
  const teamPeriodSeconds = activeMembers.reduce((s, m) => s + (m.totalSeconds || 0), 0);
  const teamIssueSeconds = computeIssueAggregation(activeMembers);
  const issuesWorked = Object.keys(teamIssueSeconds).length;

  // ═══════════════════════════════════════════════════
  // SHEET 1: Detailed Activity (Grouped)
  // ═══════════════════════════════════════════════════
  const ws = workbook.addWorksheet('Detailed Activity');

  const COL_COUNT = 6;
  ws.columns = [
    { key: 'member', width: 28 },
    { key: 'date', width: 16 },
    { key: 'issueKey', width: 18 },
    { key: 'classification', width: 16 },
    { key: 'totalTime', width: 14 },
    { key: 'timings', width: 40 }
  ];

  // Executive header block — answers "what is this report?" without scrolling.
  let cr = addReportHeader(ws, {
    title: 'Team Time Tracking Report',
    projectLabel: data.projectKey || 'All Projects',
    dateRangeStr,
    generatedAt: new Date().toLocaleString(),
    totalHours: hoursLabel(teamPeriodSeconds),
    memberCount: activeMembers.length,
    issuesWorked
  }, COL_COUNT, 1);

  cr = addSubtitleRow(ws, 'Each row represents one issue worked on one day. The Time column shows the session window for that day.', COL_COUNT, cr);
  // Spacer
  ws.getRow(cr).height = 6;
  cr += 1;

  // Header row
  const hRow = ws.getRow(cr);
  hRow.values = ['Member', 'Date', 'Issue Key', 'Classification', 'Total Time', 'Time (Start – End)'];
  styleHeaderRow(hRow, COL_COUNT);
  const headerRowNum = cr;
  ws.views = [{ state: 'frozen', ySplit: cr }];
  cr++;

  // Collect all entries across all members for the per-issue aggregation later
  const allEntries = [];

  for (const member of activeMembers) {
    // Combine productive and non-productive entries
    const productiveEntries = (member.entries || []).map(e => ({ ...e, classification: 'Productive' }));
    const npEntries = (member.nonProductiveEntries || []).map(e => ({
      ...e,
      classification: e.classification === 'private' ? 'Private' : 'Non-Productive'
    }));
    const sortedEntries = [...productiveEntries, ...npEntries].sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.issueKey.localeCompare(b.issueKey);
    });

    let rowIdx = 0;
    for (const entry of sortedEntries) {
      allEntries.push({ ...entry, memberName: member.displayName });

      const row = ws.getRow(cr);
      row.values = [
        member.displayName,
        formatDateFriendly(entry.date),
        entry.issueKey,
        entry.classification || 'Productive',
        formatDuration(entry.totalSeconds),
        formatSessionRange(entry.sessions)
      ];
      styleDataRow(row, COL_COUNT, rowIdx % 2 === 0);
      row.getCell(2).font = { bold: true, size: 10, color: { argb: COLORS.bodyText } };
      row.getCell(5).font = { bold: true, size: 10, color: { argb: COLORS.bodyText } };
      row.getCell(6).font = { size: 10, color: { argb: COLORS.subtleText } };
      row.height = 20;

      cr++;
      rowIdx++;
    }

    // Per-member roll-up row: a single sky-banded row that contains the member's
    // total for the selected period. Drops the old Today/Week/Month + Unassigned +
    // NonProductive triple-banded rows, which were noisy and double-counted.
    cr = renderMemberRollup(ws, member, COL_COUNT, cr);
  }

  // Set autoFilter to span from header row to last data row (data only)
  if (cr - 1 > headerRowNum) {
    ws.autoFilter = { from: `A${headerRowNum}`, to: `F${cr - 1}` };
  }

  // ═══════════════════════════════════════════════════
  // SHEET 2: Time by Issue (period-filtered, sorted desc)
  // ═══════════════════════════════════════════════════
  const issueWs = workbook.addWorksheet('Time by Issue');
  const IC = 4;
  issueWs.columns = [
    { key: 'issueKey', width: 24 },
    { key: 'totalMin', width: 18 },
    { key: 'totalTime', width: 18 },
    { key: 'pct', width: 14 }
  ];

  const issueArray = Object.entries(teamIssueSeconds)
    .map(([key, sec]) => ({ issueKey: key, totalSeconds: sec }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds);
  const grandTotalSec = issueArray.reduce((s, i) => s + i.totalSeconds, 0);

  let icr = addTitleRow(issueWs, `Time by Issue  |  ${data.projectKey || 'All Projects'}  |  ${dateRangeStr}`, IC, 1);
  icr = addSubtitleRow(issueWs, 'Aggregated across all team members for the selected period.', IC, icr);
  issueWs.getRow(icr).height = 6;
  icr += 1;

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
    r.getCell(2).alignment = { vertical: 'middle', horizontal: 'right' };
    r.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
    r.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };
    icr++;
  });

  const totalR = issueWs.getRow(icr);
  // % column intentionally blank on the TOTAL row — a total is, by definition,
  // 100% of itself, so labelling it "100%" adds no information and reads as noise.
  totalR.values = ['TOTAL', Math.round(grandTotalSec / 60), formatDuration(grandTotalSec), ''];
  styleTotalRow(totalR, IC);
  totalR.getCell(2).alignment = { vertical: 'middle', horizontal: 'right' };
  totalR.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
  totalR.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };

  // ═══════════════════════════════════════════════════
  // SHEET 3: Team Summary (period-filtered)
  //
  // Rebuilt to be honest about the period: numbers come from memberDetails
  // (which IS the user's selected date range) instead of the rolling
  // Today/This Week/This Month buckets that don't reflect a custom range.
  // ═══════════════════════════════════════════════════
  if (activeMembers.length > 0) {
    const summaryWs = workbook.addWorksheet('Summary');
    const SC = 5;
    summaryWs.columns = [
      { key: 'c1', width: 28 },
      { key: 'c2', width: 18 },
      { key: 'c3', width: 18 },
      { key: 'c4', width: 24 },
      { key: 'c5', width: 14 },
    ];

    let scr = addTitleRow(summaryWs, `Team Summary  |  ${data.projectKey || 'All Projects'}  |  ${dateRangeStr}`, SC, 1);
    scr = addSubtitleRow(summaryWs, 'All figures are for the selected period.', SC, scr);
    summaryWs.getRow(scr).height = 6;
    scr += 1;

    // Headline KPI block
    const totalPeriodSec = activeMembers.reduce((s, m) => s + (m.totalSeconds || 0), 0);
    const totalNpSec = activeMembers.reduce((s, m) => s + (m.nonProductiveTotalSeconds || 0), 0);
    const totalProdSec = Math.max(0, totalPeriodSec - totalNpSec);
    const avgPerMember = activeMembers.length > 0 ? totalPeriodSec / activeMembers.length : 0;

    const kpis = [
      ['Active Members', String(activeMembers.length)],
      ['Issues Worked', String(issuesWorked)],
      ['Total Time', formatDuration(totalPeriodSec)],
      ['Productive', formatDuration(totalProdSec)],
      ['Non-Productive / Private', formatDuration(totalNpSec)],
      ['Avg per Member', formatDuration(Math.round(avgPerMember))],
    ];
    for (const [k, v] of kpis) scr = addKeyValueRow(summaryWs, k, v, scr);

    summaryWs.getRow(scr).height = 8;
    scr += 1;

    // Per-member table
    const mhRow = summaryWs.getRow(scr);
    mhRow.values = ['Member', 'Period Total', 'Productive', 'Non-Productive / Private', '% of Team'];
    styleHeaderRow(mhRow, SC);
    scr++;

    const sortedMembers = [...activeMembers].sort((a, b) => (b.totalSeconds || 0) - (a.totalSeconds || 0));
    sortedMembers.forEach((m, i) => {
      const periodSec = m.totalSeconds || 0;
      const npSec = m.nonProductiveTotalSeconds || 0;
      const prodSec = Math.max(0, periodSec - npSec);
      const pct = totalPeriodSec > 0 ? Math.round((periodSec / totalPeriodSec) * 100) : 0;
      const r = summaryWs.getRow(scr);
      r.values = [m.displayName, formatDuration(periodSec), formatDuration(prodSec), formatDuration(npSec), `${pct}%`];
      styleDataRow(r, SC, i % 2 === 0);
      r.getCell(2).alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' };
      scr++;
    });

    const stRow = summaryWs.getRow(scr);
    // % column intentionally blank — see TOTAL-row comment above.
    stRow.values = ['TOTAL', formatDuration(totalPeriodSec), formatDuration(totalProdSec), formatDuration(totalNpSec), ''];
    styleTotalRow(stRow, SC);
    stRow.getCell(2).alignment = { vertical: 'middle', horizontal: 'right' };
    stRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
    stRow.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };
    stRow.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' };
  }

  // ── Generate and Download ──
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, `${filename}.xlsx`);
}

/**
 * Generate Excel report for multiple projects.
 *
 * Layout per sheet:
 *   1) Detailed Activity — clean project banners, period-only roll-up rows.
 *   2) Time by Issue — per-project sections + a global Top Issues block.
 *   3) Team Summary — KPI block, per-project tables, Grand Totals.
 *
 * Projects (and the synthetic "Unassigned (All Projects)" section) with no
 * recorded activity are skipped entirely so empty sections don't dilute the
 * report. The renderer treats the synthetic Unassigned section like any other
 * project, just with a distinct banner label coming from the backend.
 */
async function generateMultiProjectExcelReport(data, filename) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'JIRAForge Time Tracker';
  workbook.created = new Date();

  // Drop projects with zero active members so the report doesn't show empty
  // "Project: TES" / "Project: TRAIN" sections.
  const rawProjects = data.projects || [];
  const projects = rawProjects
    .map(p => ({
      ...p,
      _activeMembers: (p.memberDetails || []).filter(m => (m.totalSeconds || 0) > 0)
    }))
    .filter(p => p._activeMembers.length > 0);

  const realProjectKeys = projects.filter(p => !p.isUnassignedSection).map(p => p.projectKey);
  const projectLabel = realProjectKeys.length > 0
    ? (realProjectKeys.length <= 5 ? realProjectKeys.join(', ') : `${realProjectKeys.length} projects`)
    : 'All Projects';
  const dateRangeStr = rawProjects.length > 0 ? formatDateRange(rawProjects[0].startDate, rawProjects[0].endDate) : '';

  // Cross-project totals (one record per row — no Unassigned double counting,
  // since the backend now puts NULL-project records in their own section).
  const teamPeriodSeconds = projects.reduce((s, p) =>
    s + p._activeMembers.reduce((ss, m) => ss + (m.totalSeconds || 0), 0), 0);
  // Dedup by userId so two members with the same display name are counted as
  // distinct people. Falls back to displayName for legacy payloads that don't
  // carry userId (older backend versions).
  const uniqueMembers = new Set();
  projects.forEach(p => p._activeMembers.forEach(m => uniqueMembers.add(m.userId || `name:${m.displayName}`)));
  const uniqueMemberCount = uniqueMembers.size;
  const uniqueIssueKeys = new Set();
  projects.forEach(p => Object.keys(computeIssueAggregation(p._activeMembers)).forEach(k => uniqueIssueKeys.add(`${p.projectKey}::${k}`)));

  // ═══════════════════════════════════════════════════
  // SHEET 1: Detailed Activity
  // ═══════════════════════════════════════════════════
  const ws = workbook.addWorksheet('Detailed Activity');

  const COL_COUNT = 7;
  ws.columns = [
    { key: 'project', width: 22 },
    { key: 'member', width: 28 },
    { key: 'date', width: 16 },
    { key: 'issueKey', width: 18 },
    { key: 'classification', width: 16 },
    { key: 'totalTime', width: 14 },
    { key: 'timings', width: 40 }
  ];

  let cr = addReportHeader(ws, {
    title: 'Team Time Tracking Report',
    projectLabel,
    dateRangeStr,
    generatedAt: new Date().toLocaleString(),
    totalHours: hoursLabel(teamPeriodSeconds),
    memberCount: uniqueMemberCount,
    issuesWorked: uniqueIssueKeys.size
  }, COL_COUNT, 1);

  cr = addSubtitleRow(ws, 'Activity grouped by project, then by member. Each row = one issue worked on one day.', COL_COUNT, cr);
  ws.getRow(cr).height = 6;
  cr += 1;

  const hRow = ws.getRow(cr);
  hRow.values = ['Project', 'Member', 'Date', 'Issue Key', 'Classification', 'Total Time', 'Time (Start – End)'];
  styleHeaderRow(hRow, COL_COUNT);
  const headerRowNum = cr;
  ws.views = [{ state: 'frozen', ySplit: cr }];
  cr++;

  const allEntries = []; // { projectKey, memberName, date, issueKey, totalSeconds, sessions }

  for (const projData of projects) {
    // Project banner — no emoji (avoids cross-platform mojibake), styled cleanly.
    const bannerText = projData.isUnassignedSection
      ? projData.projectKey  // e.g. "Unassigned (All Projects)"
      : `Project · ${projData.projectKey}`;
    cr = addBannerRow(ws, bannerText, COL_COUNT, cr);

    for (const member of projData._activeMembers) {
      const productiveEntries = (member.entries || []).map(e => ({ ...e, classification: 'Productive' }));
      const npEntries = (member.nonProductiveEntries || []).map(e => ({
        ...e,
        classification: e.classification === 'private' ? 'Private' : 'Non-Productive'
      }));
      const sortedEntries = [...productiveEntries, ...npEntries].sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.issueKey.localeCompare(b.issueKey);
      });

      let rowIdx = 0;
      for (const entry of sortedEntries) {
        allEntries.push({ ...entry, projectKey: projData.projectKey, memberName: member.displayName });

        const row = ws.getRow(cr);
        row.values = [
          projData.projectKey,
          member.displayName,
          formatDateFriendly(entry.date),
          entry.issueKey,
          entry.classification || 'Productive',
          formatDuration(entry.totalSeconds),
          formatSessionRange(entry.sessions)
        ];
        styleDataRow(row, COL_COUNT, rowIdx % 2 === 0);
        row.getCell(3).font = { bold: true, size: 10, color: { argb: COLORS.bodyText } };
        row.getCell(6).font = { bold: true, size: 10, color: { argb: COLORS.bodyText } };
        row.getCell(7).font = { size: 10, color: { argb: COLORS.subtleText } };
        row.height = 20;

        cr++;
        rowIdx++;
      }

      // Single, period-focused roll-up row per member.
      cr = renderMemberRollup(ws, member, COL_COUNT, cr, /* extraColsBefore */ 1);
    }
  }

  if (cr - 1 > headerRowNum) {
    ws.autoFilter = { from: `A${headerRowNum}`, to: `G${cr - 1}` };
  }

  // ═══════════════════════════════════════════════════
  // SHEET 2: Time by Issue (per project, then global Top Issues)
  // ═══════════════════════════════════════════════════
  const issueWs = workbook.addWorksheet('Time by Issue');
  const IC = 5;
  issueWs.columns = [
    { key: 'project', width: 24 },
    { key: 'issueKey', width: 22 },
    { key: 'totalMin', width: 18 },
    { key: 'totalTime', width: 18 },
    { key: 'pct', width: 14 }
  ];

  let icr = addTitleRow(issueWs, `Time by Issue  |  ${projectLabel}  |  ${dateRangeStr}`, IC, 1);
  icr = addSubtitleRow(issueWs, 'Per project, then a Top Issues view across the full report.', IC, icr);
  issueWs.getRow(icr).height = 6;
  icr += 1;

  const ihRow = issueWs.getRow(icr);
  ihRow.values = ['Project', 'Issue Key', 'Total Time (min)', 'Total Time', '% of Project'];
  styleHeaderRow(ihRow, IC);
  issueWs.autoFilter = { from: `A${icr}`, to: `E${icr}` };
  issueWs.views = [{ state: 'frozen', ySplit: icr }];
  icr++;

  // Per-project blocks
  let globalRowIdx = 0;
  for (const projData of projects) {
    const issueMap = computeIssueAggregation(projData._activeMembers);
    const issueArray = Object.entries(issueMap)
      .map(([key, sec]) => ({ issueKey: key, totalSeconds: sec }))
      .sort((a, b) => b.totalSeconds - a.totalSeconds);
    const projTotalSec = issueArray.reduce((s, i) => s + i.totalSeconds, 0);

    for (const issue of issueArray) {
      const totalMin = Math.round(issue.totalSeconds / 60);
      const pct = projTotalSec > 0 ? ((issue.totalSeconds / projTotalSec) * 100).toFixed(1) : '0.0';
      const r = issueWs.getRow(icr);
      r.values = [projData.projectKey, issue.issueKey, totalMin, formatDuration(issue.totalSeconds), `${pct}%`];
      styleDataRow(r, IC, globalRowIdx % 2 === 0);
      r.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' };
      icr++;
      globalRowIdx++;
    }

    const projMin = Math.round(projTotalSec / 60);
    const stRow = issueWs.getRow(icr);
    // % column intentionally blank on the subtotal row — see TOTAL-row comment.
    stRow.values = [`${projData.projectKey} subtotal`, '', projMin, formatDuration(projTotalSec), ''];
    styleTotalRow(stRow, IC);
    stRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
    stRow.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };
    stRow.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' };
    icr++;
    globalRowIdx++;
  }

  // Grand total row
  const grandTotalSec = allEntries.reduce((s, e) => s + (e.totalSeconds || 0), 0);
  const grandMin = Math.round(grandTotalSec / 60);
  const gtRow = issueWs.getRow(icr);
  gtRow.values = ['GRAND TOTAL', '', grandMin, formatDuration(grandTotalSec), ''];
  styleTotalRow(gtRow, IC);
  gtRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
  gtRow.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };

  // ═══════════════════════════════════════════════════
  // SHEET 3: Team Summary — KPI block + per-project tables + Grand Totals
  // ═══════════════════════════════════════════════════
  const summaryWs = workbook.addWorksheet('Summary');
  const SC = 6;
  summaryWs.columns = [
    { key: 'c1', width: 26 }, // Project — wide enough for "Unassigned (All Projects)"
    { key: 'c2', width: 28 }, // Member
    { key: 'c3', width: 16 }, // Period Total
    { key: 'c4', width: 16 }, // Productive
    { key: 'c5', width: 22 }, // Non-Productive / Private
    { key: 'c6', width: 14 }, // % of Project
  ];

  let scr = addTitleRow(summaryWs, `Team Summary  |  ${projectLabel}  |  ${dateRangeStr}`, SC, 1);
  scr = addSubtitleRow(summaryWs, 'All figures are for the selected period. Unassigned time is reported once, in its own section.', SC, scr);
  summaryWs.getRow(scr).height = 6;
  scr += 1;

  // Headline KPIs (cross-project)
  const grandProdSec = projects.reduce((s, p) =>
    s + p._activeMembers.reduce((ss, m) => ss + Math.max(0, (m.totalSeconds || 0) - (m.nonProductiveTotalSeconds || 0)), 0), 0);
  const grandNpSec = projects.reduce((s, p) =>
    s + p._activeMembers.reduce((ss, m) => ss + (m.nonProductiveTotalSeconds || 0), 0), 0);

  const kpis = [
    ['Active Projects', String(realProjectKeys.length)],
    ['Active Members (unique)', String(uniqueMemberCount)],
    ['Issues Worked (across projects)', String(uniqueIssueKeys.size)],
    ['Total Time', formatDuration(teamPeriodSeconds)],
    ['Productive', formatDuration(grandProdSec)],
    ['Non-Productive / Private', formatDuration(grandNpSec)],
  ];
  for (const [k, v] of kpis) scr = addKeyValueRow(summaryWs, k, v, scr);

  summaryWs.getRow(scr).height = 10;
  scr += 1;

  // Per-project member tables
  for (const projData of projects) {
    scr = addBannerRow(summaryWs, projData.isUnassignedSection
      ? projData.projectKey
      : `Project · ${projData.projectKey}`, SC, scr);

    const projPeriodSec = projData._activeMembers.reduce((s, m) => s + (m.totalSeconds || 0), 0);
    const projNpSec = projData._activeMembers.reduce((s, m) => s + (m.nonProductiveTotalSeconds || 0), 0);
    const projProdSec = Math.max(0, projPeriodSec - projNpSec);

    const mhRow = summaryWs.getRow(scr);
    mhRow.values = ['Project', 'Member', 'Period Total', 'Productive', 'Non-Productive / Private', '% of Project'];
    styleHeaderRow(mhRow, SC);
    scr++;

    const sortedMembers = [...projData._activeMembers].sort((a, b) => (b.totalSeconds || 0) - (a.totalSeconds || 0));
    for (let i = 0; i < sortedMembers.length; i++) {
      const m = sortedMembers[i];
      const periodSec = m.totalSeconds || 0;
      const npSec = m.nonProductiveTotalSeconds || 0;
      const prodSec = Math.max(0, periodSec - npSec);
      const pct = projPeriodSec > 0 ? Math.round((periodSec / projPeriodSec) * 100) : 0;
      const r = summaryWs.getRow(scr);
      r.values = [
        projData.projectKey,
        m.displayName,
        formatDuration(periodSec),
        formatDuration(prodSec),
        formatDuration(npSec),
        `${pct}%`
      ];
      styleDataRow(r, SC, i % 2 === 0);
      r.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' };
      r.getCell(6).alignment = { vertical: 'middle', horizontal: 'right' };
      scr++;
    }

    const stRow = summaryWs.getRow(scr);
    // % column intentionally blank on the subtotal row — see TOTAL-row comment.
    stRow.values = [
      '',
      `${projData.projectKey} subtotal`,
      formatDuration(projPeriodSec),
      formatDuration(projProdSec),
      formatDuration(projNpSec),
      ''
    ];
    styleTotalRow(stRow, SC);
    stRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
    stRow.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };
    stRow.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' };
    stRow.getCell(6).alignment = { vertical: 'middle', horizontal: 'right' };
    scr++;

    // Spacer
    summaryWs.getRow(scr).height = 8;
    scr++;
  }

  // Grand Totals banner + KPIs
  scr = addBannerRow(summaryWs, 'Grand Totals (All Sections)', SC, scr);
  const grandKpis = [
    ['Total Projects', String(realProjectKeys.length)],
    ['Active Members (unique)', String(uniqueMemberCount)],
    ['Total Time', formatDuration(teamPeriodSeconds)],
    ['Productive', formatDuration(grandProdSec)],
    ['Non-Productive / Private', formatDuration(grandNpSec)],
  ];
  for (const [k, v] of grandKpis) scr = addKeyValueRow(summaryWs, k, v, scr);

  // Notify which projects were dropped for emptiness (footer breadcrumb)
  const skippedProjectKeys = (data.projects || [])
    .filter(p => !p.isUnassignedSection && (p.memberDetails || []).every(m => (m.totalSeconds || 0) === 0))
    .map(p => p.projectKey);
  if (skippedProjectKeys.length > 0) {
    summaryWs.getRow(scr).height = 8;
    scr++;
    scr = addSubtitleRow(summaryWs, `Projects with no recorded activity in this period: ${skippedProjectKeys.join(', ')}.`, SC, scr);
  }

  // ── Generate and Download ──
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, `${filename}.xlsx`);
}

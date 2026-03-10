/**
 * Shared analytics helpers (date formatting, filtering, aggregations).
 * Used by orgAnalyticsService and teamAnalyticsService.
 */

/**
 * Format a Date as YYYY-MM-DD (UTC).
 * @param {Date} d
 * @returns {string}
 */
export function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Normalize work_date from a summary record to YYYY-MM-DD string.
 * @param {{ work_date?: string | Date }} record
 * @returns {string}
 */
export function getWorkDateStr(record) {
  if (!record || record.work_date == null) return '';
  const w = record.work_date;
  return typeof w === 'string' ? w.split('T')[0] : formatDate(new Date(w));
}

/**
 * Convert seconds to hours rounded to 1 decimal.
 * @param {number} seconds
 * @returns {number}
 */
export function secondsToHours(seconds) {
  return Math.round((seconds || 0) / 3600 * 10) / 10;
}

/**
 * Sum total_seconds from an array of daily summary records.
 * @param {Array<{ total_seconds?: number }>} data
 * @returns {number}
 */
export function sumTotalSeconds(data) {
  return (data || []).reduce((sum, d) => sum + (d.total_seconds || 0), 0);
}

/**
 * Filter daily summary records by work_date in range [startStr, endStr] (inclusive).
 * @param {Array} data
 * @param {string} startStr YYYY-MM-DD
 * @param {string} endStr YYYY-MM-DD
 * @returns {Array}
 */
export function filterByDateRange(data, startStr, endStr) {
  return (data || []).filter(d => {
    const workDate = getWorkDateStr(d);
    return workDate >= startStr && workDate <= endStr;
  });
}

/**
 * Filter daily summary records by exact work_date.
 * @param {Array} data
 * @param {string} dateStr YYYY-MM-DD
 * @returns {Array}
 */
export function filterByExactDate(data, dateStr) {
  return (data || []).filter(d => getWorkDateStr(d) === dateStr);
}

/**
 * Filter daily summary records where work_date >= startStr.
 * @param {Array} data
 * @param {string} startStr YYYY-MM-DD
 * @returns {Array}
 */
export function filterByDateFrom(data, startStr) {
  return (data || []).filter(d => getWorkDateStr(d) >= startStr);
}

/**
 * Count unique valid project keys in data.
 * @param {Array<{ project_key?: string }>} data
 * @param {Set<string>} validKeys
 * @returns {number}
 */
export function getActiveProjectCount(data, validKeys) {
  return new Set(
    (data || []).map(d => d.project_key).filter(key => key && validKeys.has(key))
  ).size;
}

/**
 * Get YYYY-MM-DD string for n days ago from now (UTC).
 * @param {Date} now
 * @param {number} days
 * @returns {string}
 */
export function daysAgoStr(now, days) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return formatDate(d);
}

/**
 * Get week start (Monday) date and YYYY-MM-DD string in UTC.
 * @param {Date} now
 * @returns {{ weekStart: Date, weekStartStr: string }}
 */
export function getWeekStartUTC(now) {
  const weekStart = new Date(now);
  const dayOfWeek = weekStart.getUTCDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  weekStart.setUTCDate(weekStart.getUTCDate() - daysToMonday);
  return { weekStart, weekStartStr: formatDate(weekStart) };
}

/**
 * Compute total hours for a user's daily data in a date range.
 * @param {Array} userDailyData
 * @param {string} startStr YYYY-MM-DD
 * @param {string} endStr YYYY-MM-DD
 * @returns {number}
 */
export function computeHoursInRange(userDailyData, startStr, endStr) {
  const filtered = filterByDateRange(userDailyData, startStr, endStr);
  return secondsToHours(sumTotalSeconds(filtered));
}

/**
 * Format a YYYY-MM-DD string as "Mon D, Y" (e.g. "Jan 15, 2026").
 * @param {string} dateStr
 * @returns {string|null}
 */
export function formatDateDisplay(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[m - 1]} ${d}, ${y}`;
}

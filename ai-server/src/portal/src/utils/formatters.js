/**
 * Formatters for display
 */

/**
 * Format seconds to human-readable duration.
 * 
 * @param {number} seconds 
 * @returns {string} "2h 30m" or "45m" or "30s"
 */
export function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0m';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  
  if (minutes > 0) {
    return `${minutes}m`;
  }
  
  return `${secs}s`;
}

/**
 * Format percentage.
 * 
 * @param {number} value 
 * @param {number} decimals 
 * @returns {string}
 */
export function formatPercentage(value, decimals = 1) {
  if (value == null || isNaN(value)) return '0%';
  return `${value.toFixed(decimals)}%`;
}

/**
 * Format date to YYYY-MM-DD using the LOCAL calendar date.
 *
 * Every caller uses this for a calendar day (today, today-N days, month
 * boundaries) in the user's own timezone. Slicing toISOString() would format
 * in UTC, rolling local midnight back a day for timezones ahead of UTC (e.g.
 * IST) — which breaks the "This/Last Month" presets and the "today" default
 * near midnight. Use local components, matching the backend's formatDate.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format timestamp to human-readable.
 *
 * @param {string} timestamp
 * @returns {string}
 */
export function formatDateTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleString();
}

/**
 * Relative "time ago" label for live activity status.
 *
 * @param {string} timestamp
 * @returns {string} "just now" | "5m ago" | "3h ago" | "2d ago"
 */
export function timeAgo(timestamp) {
  if (!timestamp) return '';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

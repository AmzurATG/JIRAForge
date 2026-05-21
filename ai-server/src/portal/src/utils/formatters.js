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
 * Format date to YYYY-MM-DD.
 * 
 * @param {Date} date 
 * @returns {string}
 */
export function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toISOString().split('T')[0];
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

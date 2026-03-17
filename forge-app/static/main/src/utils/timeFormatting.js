/**
 * Time formatting utility functions
 */

/**
 * Format seconds into a human-readable time string
 * Always includes seconds when non-zero so individual times add up to totals
 * @param {number} seconds - Time in seconds
 * @returns {string} Formatted time string (e.g., "2m 30s", "1h 8m 2s")
 */
export const formatTime = (seconds) => {
  if (!seconds || seconds < 0) return '0s';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  // Build parts array — always include non-zero components for consistency
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0) parts.push(`${secs}s`);

  return parts.length > 0 ? parts.join(' ') : '0s';
};

/**
 * Format seconds into hours with decimal
 * @param {number} seconds - Time in seconds
 * @param {number} decimals - Number of decimal places
 * @returns {string} Formatted hours (e.g., "2.5")
 */
export const formatHours = (seconds, decimals = 1) => {
  if (!seconds || seconds < 0) return '0';
  return (seconds / 3600).toFixed(decimals);
};

/**
 * Format a date for display
 * @param {string|Date} date - Date to format
 * @returns {string} Formatted date string
 */
export const formatDate = (date) => {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
};

/**
 * Format a time for display
 * @param {string|Date} date - Date/time to format
 * @returns {string} Formatted time string
 */
export const formatTimeOfDay = (date) => {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
};

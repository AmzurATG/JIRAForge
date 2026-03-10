/**
 * Input Validation Utilities
 * Centralized validation for all user-controlled inputs before query interpolation.
 * Prevents PostgREST parameter injection and ensures data integrity.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const PROJECT_KEY_REGEX = /^[A-Z][A-Z0-9_]{0,19}$/;
const ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9_]*-\d+$/;

/**
 * Validate that a value is a properly formatted UUID v4.
 * @param {*} value - Value to validate
 * @returns {boolean} True if value is a valid UUID string
 */
export function isValidUUID(value) {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

/**
 * Validate that a value is a date string in YYYY-MM-DD format
 * and represents a real calendar date.
 * @param {*} value - Value to validate
 * @returns {boolean} True if value is a valid date string
 */
export function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) {
    return false;
  }
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime());
}

/**
 * Validate that a value is an integer within optional bounds.
 * Accepts both number and numeric string types.
 * @param {*} value - Value to validate
 * @param {number} [min] - Minimum allowed value (inclusive)
 * @param {number} [max] - Maximum allowed value (inclusive)
 * @returns {boolean} True if value is a valid integer within bounds
 */
export function isValidInteger(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    return false;
  }
  if (min !== undefined && num < min) return false;
  if (max !== undefined && num > max) return false;
  return true;
}

/**
 * Parse a value as a safe integer, returning the default if invalid.
 * @param {*} value - Value to parse
 * @param {number} defaultValue - Fallback value
 * @param {number} [min] - Minimum allowed value
 * @param {number} [max] - Maximum allowed value
 * @returns {number} Validated integer or default
 */
export function toSafeInteger(value, defaultValue, min, max) {
  if (value === undefined || value === null) return defaultValue;
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) return defaultValue;
  if (min !== undefined && num < min) return defaultValue;
  if (max !== undefined && num > max) return defaultValue;
  return num;
}

/**
 * Validate a Jira project key format (e.g., "PROJ", "MY_PROJECT").
 * @param {*} value - Value to validate
 * @returns {boolean} True if value matches Jira project key format
 */
export function isValidProjectKey(value) {
  return typeof value === 'string' && PROJECT_KEY_REGEX.test(value.trim());
}

/**
 * Validate a Jira issue key format (e.g., "PROJ-123").
 * @param {*} value - Value to validate
 * @returns {boolean} True if value matches Jira issue key format
 */
export function isValidIssueKey(value) {
  return typeof value === 'string' && ISSUE_KEY_REGEX.test(value.trim());
}

/**
 * Filter an array to only valid UUID strings.
 * Returns a new array containing only elements that pass UUID validation.
 * @param {Array} arr - Array of values to filter
 * @returns {string[]} Array of valid UUID strings (trimmed)
 */
export function sanitizeUUIDArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(item => typeof item === 'string' && isValidUUID(item.trim()))
    .map(item => item.trim());
}

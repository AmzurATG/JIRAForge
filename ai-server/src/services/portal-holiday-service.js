/**
 * Portal Holiday Service
 *
 * Domain logic for the company-wide holiday list plus the work-calendar maths
 * used by the monthly (Employee Summary) report:
 *   - countWorkingDays(from, to, holidayDates) — Mon-Fri days in range minus
 *     holidays (pure; unit-tested).
 *   - legalHours(from, to) — working days x HOURS_PER_DAY.
 *
 * No Express req/res here. Validation / known errors are thrown with a numeric
 * `.status` so controllers can map them (400/404/409). Supabase access lives in
 * services/db/portal-holiday-db-service.js.
 *
 * Plan: plan/2026-06-23_web-productivity-portal_holidays-legal-hours-and-category-percentages.md
 */

'use strict';

const db = require('./db/portal-holiday-db-service');

const MAX_NAME_LENGTH = 160;

/** Standard working hours per day (env-overridable; default 9). */
function hoursPerDay() {
  const v = Number(process.env.PORTAL_LEGAL_HOURS_PER_DAY);
  return Number.isFinite(v) && v > 0 ? v : 9;
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isDuplicateError(err) {
  return err.code === '23505' || /duplicate|unique/i.test(err.message || '');
}

/** Valid YYYY-MM-DD (and a real calendar date). */
function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ---------------------------------------------------------------------------
// Work-calendar maths (pure)
// ---------------------------------------------------------------------------

/**
 * Count working days (Mon-Fri) in the inclusive range [from, to], excluding any
 * date present in `holidayDates`. All maths in UTC so it is timezone-stable.
 *
 * @param {string} from - YYYY-MM-DD
 * @param {string} to - YYYY-MM-DD
 * @param {string[]} [holidayDates] - YYYY-MM-DD strings to exclude
 * @returns {number}
 */
function countWorkingDays(from, to, holidayDates = []) {
  if (!isValidDateStr(from) || !isValidDateStr(to)) return 0;
  const holidays = new Set(holidayDates);
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let count = 0;
  while (cur <= end) {
    const dow = cur.getUTCDay(); // 0=Sun .. 6=Sat
    const ds = cur.toISOString().slice(0, 10);
    if (dow >= 1 && dow <= 5 && !holidays.has(ds)) count += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

/**
 * Legal (expected) working hours for the inclusive range, using the active
 * holiday list. Returns 0 for an invalid/empty range.
 */
async function legalHours(from, to) {
  if (!isValidDateStr(from) || !isValidDateStr(to)) return 0;
  const holidayDates = await db.getActiveHolidayDatesInRange(from, to);
  return countWorkingDays(from, to, holidayDates) * hoursPerDay();
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function listHolidays({ year, includeInactive } = {}) {
  return db.listHolidays({ year, includeInactive });
}

async function createHoliday(holidayDate, name, createdBy) {
  if (!isValidDateStr(holidayDate)) throw httpError('A valid date (YYYY-MM-DD) is required', 400);
  const trimmed = (name || '').trim();
  if (!trimmed) throw httpError('Holiday name is required', 400);
  if (trimmed.length > MAX_NAME_LENGTH) throw httpError(`Holiday name must be at most ${MAX_NAME_LENGTH} characters`, 400);
  try {
    return await db.createHoliday({ holidayDate, name: trimmed, createdBy });
  } catch (err) {
    if (isDuplicateError(err)) throw httpError('A holiday already exists on this date', 409);
    throw err;
  }
}

async function updateHoliday(id, { holidayDate, name, isActive }) {
  const updates = {};
  if (holidayDate !== undefined) {
    if (!isValidDateStr(holidayDate)) throw httpError('A valid date (YYYY-MM-DD) is required', 400);
    updates.holiday_date = holidayDate;
  }
  if (name !== undefined) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw httpError('Holiday name cannot be empty', 400);
    if (trimmed.length > MAX_NAME_LENGTH) throw httpError(`Holiday name must be at most ${MAX_NAME_LENGTH} characters`, 400);
    updates.name = trimmed;
  }
  if (isActive !== undefined) updates.is_active = !!isActive;
  if (Object.keys(updates).length === 0) throw httpError('No fields to update', 400);

  let updated;
  try {
    updated = await db.updateHoliday(id, updates);
  } catch (err) {
    if (isDuplicateError(err)) throw httpError('A holiday already exists on this date', 409);
    throw err;
  }
  if (!updated) throw httpError('Holiday not found', 404);
  return updated;
}

async function deleteHoliday(id) {
  const holiday = await db.getHolidayById(id);
  if (!holiday) throw httpError('Holiday not found', 404);
  await db.deleteHoliday(id);
}

module.exports = {
  hoursPerDay,
  countWorkingDays,
  legalHours,
  listHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
};

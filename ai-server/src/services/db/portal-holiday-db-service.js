/**
 * Portal Holiday Database Service
 *
 * Supabase queries for the company-wide portal_holidays list (superadmin CRUD).
 * Queries only — no business rules. portal_holidays is portal-owned and
 * company-wide (no org_id) by design; see the 20260623 migration header.
 *
 * Plan: plan/2026-06-23_web-productivity-portal_holidays-legal-hours-and-category-percentages.md
 */

'use strict';

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

/**
 * List holidays, optionally filtered by year and/or active state.
 * @param {{ year?: number|string, includeInactive?: boolean }} opts
 */
async function listHolidays({ year, includeInactive = false } = {}) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  let query = supabase.from('portal_holidays').select('*').order('holiday_date', { ascending: true });
  if (!includeInactive) query = query.eq('is_active', true);
  // Only apply the year filter for a sane 4-digit year — a malformed ?year=
  // would otherwise build an invalid date literal and 500.
  const y = Number.parseInt(year, 10);
  if (Number.isInteger(y) && y >= 1900 && y <= 9999) {
    query = query.gte('holiday_date', `${y}-01-01`).lte('holiday_date', `${y}-12-31`);
  }

  const { data, error } = await query;
  if (error) {
    logger.error('[PortalHolidayDB] listHolidays failed', { year, error });
    throw error;
  }
  return data || [];
}

/** Active holiday DATE strings (YYYY-MM-DD) within an inclusive range. */
async function getActiveHolidayDatesInRange(from, to) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_holidays')
    .select('holiday_date')
    .eq('is_active', true)
    .gte('holiday_date', from)
    .lte('holiday_date', to);
  if (error) {
    logger.error('[PortalHolidayDB] getActiveHolidayDatesInRange failed', { from, to, error });
    throw error;
  }
  return (data || []).map((r) => r.holiday_date);
}

async function getHolidayById(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase.from('portal_holidays').select('*').eq('id', id).single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[PortalHolidayDB] getHolidayById failed', { id, error });
    throw error;
  }
  return data;
}

async function createHoliday({ holidayDate, name, createdBy }) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_holidays')
    .insert({ holiday_date: holidayDate, name, created_by: createdBy || null })
    .select()
    .single();
  if (error) {
    logger.error('[PortalHolidayDB] createHoliday failed', { holidayDate, error });
    throw error;
  }
  return data;
}

async function updateHoliday(id, updates) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_holidays')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[PortalHolidayDB] updateHoliday failed', { id, error });
    throw error;
  }
  return data;
}

async function deleteHoliday(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase.from('portal_holidays').delete().eq('id', id).select();
  if (error) {
    logger.error('[PortalHolidayDB] deleteHoliday failed', { id, error });
    throw error;
  }
  return data && data.length > 0;
}

module.exports = {
  listHolidays,
  getActiveHolidayDatesInRange,
  getHolidayById,
  createHoliday,
  updateHoliday,
  deleteHoliday,
};

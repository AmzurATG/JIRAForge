/**
 * Portal Holiday Controller
 *
 * Company holiday list. Read: any authenticated portal user (the Reports page
 * and legal-hours need it). Create / update / delete: superadmin only.
 * Authentication is handled by portal-auth middleware (req.portalUser).
 *
 * Plan: plan/2026-06-23_web-productivity-portal_holidays-legal-hours-and-category-percentages.md
 */

'use strict';

const logger = require('../utils/logger');
const holidayService = require('../services/portal-holiday-service');

function fail(res, error, prefix) {
  const status = error.status || 500;
  if (status >= 500) logger.error(`${prefix} failed`, error);
  else logger.warn(`${prefix} rejected`, { error: error.message });
  return res.status(status).json({ success: false, error: error.message });
}

function isSuperadmin(req) {
  return req.portalUser && req.portalUser.role === 'superadmin';
}

function toDto(h) {
  return { id: h.id, date: h.holiday_date, name: h.name, isActive: h.is_active };
}

async function getHolidays(req, res) {
  try {
    const holidays = await holidayService.listHolidays({
      year: req.query.year,
      includeInactive: req.query.includeInactive === 'true',
    });
    return res.json({ success: true, data: holidays.map(toDto) });
  } catch (error) {
    return fail(res, error, '[PortalHoliday] getHolidays');
  }
}

async function createHoliday(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can manage holidays' });
    const { date, name } = req.body;
    const holiday = await holidayService.createHoliday(date, name, req.portalUser.userId);
    return res.status(201).json({ success: true, data: toDto(holiday) });
  } catch (error) {
    return fail(res, error, '[PortalHoliday] createHoliday');
  }
}

async function updateHoliday(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can manage holidays' });
    const { date, name, isActive } = req.body;
    const holiday = await holidayService.updateHoliday(req.params.id, { holidayDate: date, name, isActive });
    return res.json({ success: true, data: toDto(holiday) });
  } catch (error) {
    return fail(res, error, '[PortalHoliday] updateHoliday');
  }
}

async function deleteHoliday(req, res) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ success: false, error: 'Only superadmin can manage holidays' });
    await holidayService.deleteHoliday(req.params.id);
    return res.json({ success: true, message: 'Holiday deleted' });
  } catch (error) {
    return fail(res, error, '[PortalHoliday] deleteHoliday');
  }
}

module.exports = { getHolidays, createHoliday, updateHoliday, deleteHoliday };

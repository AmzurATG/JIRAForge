'use strict';

/**
 * Portal holiday service — work-calendar maths + CRUD validation.
 * Plan: plan/2026-06-23_web-productivity-portal_holidays-legal-hours-and-category-percentages.md
 */

jest.mock('../../src/services/db/portal-holiday-db-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const db = require('../../src/services/db/portal-holiday-db-service');
const service = require('../../src/services/portal-holiday-service');

beforeEach(() => jest.clearAllMocks());

describe('countWorkingDays (pure, AC-9)', () => {
  test('excludes weekends', () => {
    // 2026-06-01 (Mon) .. 2026-06-07 (Sun) → Mon–Fri = 5 working days
    expect(service.countWorkingDays('2026-06-01', '2026-06-07', [])).toBe(5);
  });

  test('excludes holidays that fall on weekdays', () => {
    // Same week, but 2026-06-03 (Wed) is a holiday → 4 working days
    expect(service.countWorkingDays('2026-06-01', '2026-06-07', ['2026-06-03'])).toBe(4);
  });

  test('a holiday on a weekend does not reduce the count', () => {
    // 2026-06-06 is a Saturday (already non-working)
    expect(service.countWorkingDays('2026-06-01', '2026-06-07', ['2026-06-06'])).toBe(5);
  });

  test('full month June 2026 (22 weekdays) minus 0 holidays', () => {
    expect(service.countWorkingDays('2026-06-01', '2026-06-30', [])).toBe(22);
  });

  test('inclusive single working day', () => {
    expect(service.countWorkingDays('2026-06-01', '2026-06-01', [])).toBe(1);
  });

  test('invalid range → 0', () => {
    expect(service.countWorkingDays('not-a-date', '2026-06-30', [])).toBe(0);
  });
});

describe('legalHours', () => {
  test('working days × hours/day (default 9), holidays excluded', async () => {
    db.getActiveHolidayDatesInRange.mockResolvedValue(['2026-06-03']);
    // 22 weekdays in June − 1 holiday = 21 × 9 = 189
    const hours = await service.legalHours('2026-06-01', '2026-06-30');
    expect(db.getActiveHolidayDatesInRange).toHaveBeenCalledWith('2026-06-01', '2026-06-30');
    expect(hours).toBe(189);
  });

  test('honors PORTAL_LEGAL_HOURS_PER_DAY override', async () => {
    const prev = process.env.PORTAL_LEGAL_HOURS_PER_DAY;
    process.env.PORTAL_LEGAL_HOURS_PER_DAY = '8';
    db.getActiveHolidayDatesInRange.mockResolvedValue([]);
    const hours = await service.legalHours('2026-06-01', '2026-06-07'); // 5 × 8
    expect(hours).toBe(40);
    process.env.PORTAL_LEGAL_HOURS_PER_DAY = prev;
  });

  test('invalid range → 0 without querying', async () => {
    const hours = await service.legalHours('', '2026-06-30');
    expect(hours).toBe(0);
    expect(db.getActiveHolidayDatesInRange).not.toHaveBeenCalled();
  });
});

describe('CRUD validation', () => {
  test('createHoliday: invalid date → 400', async () => {
    await expect(service.createHoliday('06-01-2026', 'X')).rejects.toMatchObject({ status: 400 });
    expect(db.createHoliday).not.toHaveBeenCalled();
  });

  test('createHoliday: empty name → 400', async () => {
    await expect(service.createHoliday('2026-06-01', '  ')).rejects.toMatchObject({ status: 400 });
  });

  test('createHoliday: duplicate date → 409', async () => {
    const dup = new Error('duplicate key value violates unique constraint');
    dup.code = '23505';
    db.createHoliday.mockRejectedValue(dup);
    await expect(service.createHoliday('2026-06-01', 'Holi')).rejects.toMatchObject({ status: 409 });
  });

  test('createHoliday: trims name and persists', async () => {
    db.createHoliday.mockResolvedValue({ id: 'h1', holiday_date: '2026-06-01', name: 'Holi', is_active: true });
    const h = await service.createHoliday('2026-06-01', '  Holi  ', 'admin1');
    expect(db.createHoliday).toHaveBeenCalledWith({ holidayDate: '2026-06-01', name: 'Holi', createdBy: 'admin1' });
    expect(h.id).toBe('h1');
  });

  test('updateHoliday: unknown id → 404; no fields → 400', async () => {
    db.updateHoliday.mockResolvedValue(null);
    await expect(service.updateHoliday('missing', { name: 'X' })).rejects.toMatchObject({ status: 404 });
    await expect(service.updateHoliday('h1', {})).rejects.toMatchObject({ status: 400 });
  });

  test('deleteHoliday: unknown id → 404', async () => {
    db.getHolidayById.mockResolvedValue(null);
    await expect(service.deleteHoliday('missing')).rejects.toMatchObject({ status: 404 });
    expect(db.deleteHoliday).not.toHaveBeenCalled();
  });
});

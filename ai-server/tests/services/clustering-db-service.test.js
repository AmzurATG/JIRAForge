'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetClient = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: mockGetClient,
}));

jest.mock('../../src/utils/logger', () => mockLogger);

jest.mock('../../src/utils/datetime', () => ({
  toUTCISOString: (d) => d.toISOString(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { computeIsIdleOnly } = require('../../src/services/db/clustering-db-service');

// ---------------------------------------------------------------------------
// computeIsIdleOnly Helper Function Tests
// ---------------------------------------------------------------------------

describe('computeIsIdleOnly', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true when ALL activity_records have is_idle = true', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true },
      { id: 'ar-2', source: 'activity_records', is_idle: true },
      { id: 'ar-3', source: 'activity_records', is_idle: true },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(true);
  });

  it('returns false when ANY activity_record has is_idle = false', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true },
      { id: 'ar-2', source: 'activity_records', is_idle: false },
      { id: 'ar-3', source: 'activity_records', is_idle: true },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns false when activity_records have mixed idle states', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true },
      { id: 'ar-2', source: 'activity_records', is_idle: null },
      { id: 'ar-3', source: 'activity_records', is_idle: undefined },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns false for empty array', () => {
    const result = computeIsIdleOnly([]);
    expect(result).toBe(false);
  });

  it('returns false for null input', () => {
    const result = computeIsIdleOnly(null);
    expect(result).toBe(false);
  });

  it('returns false for undefined input', () => {
    const result = computeIsIdleOnly(undefined);
    expect(result).toBe(false);
  });

  it('returns false when group contains legacy unassigned_activity members (no is_idle field)', () => {
    const sessions = [
      { id: 'legacy-1', source: 'unassigned_activity' },
      { id: 'legacy-2', source: 'unassigned_activity' },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns false when group contains mix of legacy and idle activity_records', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true },
      { id: 'legacy-1', source: 'unassigned_activity' },
      { id: 'ar-2', source: 'activity_records', is_idle: true },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns true when only activity_records present and all are idle (ignores other fields)', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true, window_title: 'Lock Screen', duration_seconds: 300 },
      { id: 'ar-2', source: 'activity_records', is_idle: true, window_title: 'Screensaver', duration_seconds: 600 },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(true);
  });

  it('returns false when sessions have no source field (defaults to unassigned_activity)', () => {
    const sessions = [
      { id: 'unknown-1', is_idle: true },
      { id: 'unknown-2', is_idle: true },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns false when activity_records have is_idle explicitly set to false', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: false },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns false when activity_records have is_idle = 0 (falsy but not boolean)', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: 0 },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns true when single activity_record is idle', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(true);
  });
});

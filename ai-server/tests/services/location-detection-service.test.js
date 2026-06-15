'use strict';

/**
 * Working-location detection service.
 * Plan: plan/2026-06-12_cross-component_automatic-employee-location-detection.md
 *
 * Verifies: GeoIP-derived city/region/country, ~3h refresh throttle,
 * private/loopback IPs skipped, only a truncated prefix stored (never the full
 * IP), unknown IPs leave no row, and the employees-list map shape.
 */

jest.mock('geoip-lite');
jest.mock('../../src/services/db/portal-location-detection-db-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const geoip = require('geoip-lite');
const db = require('../../src/services/db/portal-location-detection-db-service');
const service = require('../../src/services/location-detection-service');

beforeEach(() => {
  jest.clearAllMocks();
  db.getWorkLocationByUserId.mockResolvedValue(null);
  db.upsertWorkLocation.mockImplementation(async (row) => ({ ...row, detected_at: new Date().toISOString() }));
  geoip.lookup.mockReturnValue({ country: 'IN', region: 'TG', city: 'Hyderabad', ll: [17.38, 78.48] });
});

describe('pure IP helpers', () => {
  test('normalizeIp unwraps IPv4-mapped IPv6 and rejects garbage', () => {
    expect(service.normalizeIp('::ffff:49.207.10.5')).toBe('49.207.10.5');
    expect(service.normalizeIp('49.207.10.5')).toBe('49.207.10.5');
    expect(service.normalizeIp('2401:4900::1')).toBe('2401:4900::1');
    expect(service.normalizeIp('nonsense')).toBeNull();
    expect(service.normalizeIp(null)).toBeNull();
  });

  test('isPublicIp rejects private, loopback, link-local and CGNAT ranges', () => {
    expect(service.isPublicIp('49.207.10.5')).toBe(true);     // public
    expect(service.isPublicIp('10.0.0.5')).toBe(false);       // private
    expect(service.isPublicIp('192.168.1.10')).toBe(false);   // private
    expect(service.isPublicIp('172.16.4.4')).toBe(false);     // private
    expect(service.isPublicIp('127.0.0.1')).toBe(false);      // loopback
    expect(service.isPublicIp('169.254.1.1')).toBe(false);    // link-local
    expect(service.isPublicIp('100.64.0.1')).toBe(false);     // CGNAT
    expect(service.isPublicIp('::1')).toBe(false);            // v6 loopback
    expect(service.isPublicIp('fd00::1')).toBe(false);        // v6 unique-local
    expect(service.isPublicIp('2401:4900::1')).toBe(true);    // v6 public
  });

  test('truncateIpPrefix yields /24 for IPv4 and /64 for IPv6', () => {
    expect(service.truncateIpPrefix('49.207.10.5')).toBe('49.207.10.0/24');
    expect(service.truncateIpPrefix('2401:4900:1234:5678:9abc::1')).toBe('2401:4900:1234:5678::/64');
  });
});

describe('recordWorkingLocation', () => {
  test('public IP → GeoIP lookup stored as city/region/country (+ truncated prefix)', async () => {
    const result = await service.recordWorkingLocation('u1', '49.207.10.5');
    expect(geoip.lookup).toHaveBeenCalledWith('49.207.10.5');
    expect(db.upsertWorkLocation).toHaveBeenCalledWith({
      userId: 'u1',
      city: 'Hyderabad',
      region: 'TG',
      country: 'IN',
      ipPrefix: '49.207.10.0/24',
      source: 'geoip',
    });
    expect(result).not.toBeNull();
  });

  test('IPv4-mapped IPv6 client address is still geolocated', async () => {
    await service.recordWorkingLocation('u1', '::ffff:49.207.10.5');
    expect(geoip.lookup).toHaveBeenCalledWith('49.207.10.5');
  });

  test('only the truncated prefix is persisted — never the full IP', async () => {
    await service.recordWorkingLocation('u1', '49.207.10.5');
    const stored = db.upsertWorkLocation.mock.calls[0][0];
    expect(stored.ipPrefix).toBe('49.207.10.0/24');
    expect(JSON.stringify(stored)).not.toContain('49.207.10.5');
  });

  test('throttle: a reading younger than ~3h is not refreshed', async () => {
    db.getWorkLocationByUserId.mockResolvedValue({
      user_id: 'u1',
      detected_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    });
    const result = await service.recordWorkingLocation('u1', '49.207.10.5');
    expect(result).toBeNull();
    expect(geoip.lookup).not.toHaveBeenCalled();
    expect(db.upsertWorkLocation).not.toHaveBeenCalled();
  });

  test('throttle: a reading older than ~3h is refreshed', async () => {
    db.getWorkLocationByUserId.mockResolvedValue({
      user_id: 'u1',
      detected_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), // 4h ago
    });
    await service.recordWorkingLocation('u1', '49.207.10.5');
    expect(db.upsertWorkLocation).toHaveBeenCalled();
  });

  test('private / loopback / CGNAT IPs are skipped before any DB or GeoIP work', async () => {
    for (const ip of ['10.0.0.5', '192.168.1.2', '127.0.0.1', '100.64.0.9', '::1']) {
      const result = await service.recordWorkingLocation('u1', ip);
      expect(result).toBeNull();
    }
    expect(db.getWorkLocationByUserId).not.toHaveBeenCalled();
    expect(geoip.lookup).not.toHaveBeenCalled();
    expect(db.upsertWorkLocation).not.toHaveBeenCalled();
  });

  test('unknown public IP (GeoIP miss) stores nothing rather than a blank reading', async () => {
    geoip.lookup.mockReturnValue(null);
    const result = await service.recordWorkingLocation('u1', '203.0.113.200');
    expect(result).toBeNull();
    expect(db.upsertWorkLocation).not.toHaveBeenCalled();
  });

  test('invalid input (missing user, unparseable IP) is a silent no-op', async () => {
    expect(await service.recordWorkingLocation(null, '49.207.10.5')).toBeNull();
    expect(await service.recordWorkingLocation('u1', 'nonsense')).toBeNull();
    expect(geoip.lookup).not.toHaveBeenCalled();
  });
});

describe('getWorkLocationMapForUsers', () => {
  test('maps rows to { city, region, country, detectedAt } keyed by user', async () => {
    db.getWorkLocationsByUserIds.mockResolvedValue([
      { user_id: 'u1', city: 'Hyderabad', region: 'TG', country: 'IN', detected_at: 't1' },
      { user_id: 'u2', city: 'Austin', region: 'TX', country: 'US', detected_at: 't2' },
    ]);
    const map = await service.getWorkLocationMapForUsers(['u1', 'u2']);
    expect(map).toEqual({
      u1: { city: 'Hyderabad', region: 'TG', country: 'IN', detectedAt: 't1' },
      u2: { city: 'Austin', region: 'TX', country: 'US', detectedAt: 't2' },
    });
  });

  test('empty input returns an empty map without a DB call', async () => {
    const map = await service.getWorkLocationMapForUsers([]);
    expect(map).toEqual({});
    expect(db.getWorkLocationsByUserIds).not.toHaveBeenCalled();
  });
});

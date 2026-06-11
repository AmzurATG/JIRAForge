'use strict';

/**
 * WS-B — locations + employee-profile domain logic (AC-B1, AC-B2).
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md
 */

jest.mock('../../src/services/db/portal-employee-profile-db-service');
jest.mock('../../src/services/db/portal-lob-db-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const db = require('../../src/services/db/portal-employee-profile-db-service');
const lobDb = require('../../src/services/db/portal-lob-db-service');
const service = require('../../src/services/portal-employee-profile-service');

beforeEach(() => jest.clearAllMocks());

describe('locations CRUD (AC-B1)', () => {
  test('createLocation trims and creates', async () => {
    db.createLocation.mockResolvedValue({ id: 'loc1', name: 'Hyderabad', is_active: true });
    const loc = await service.createLocation('  Hyderabad  ', 'admin1');
    expect(db.createLocation).toHaveBeenCalledWith({ name: 'Hyderabad', createdBy: 'admin1' });
    expect(loc.id).toBe('loc1');
  });

  test('createLocation: empty name → 400', async () => {
    await expect(service.createLocation('   ')).rejects.toMatchObject({ status: 400 });
    expect(db.createLocation).not.toHaveBeenCalled();
  });

  test('createLocation: duplicate name → 409', async () => {
    const dup = new Error('duplicate key value violates unique constraint');
    dup.code = '23505';
    db.createLocation.mockRejectedValue(dup);
    await expect(service.createLocation('Tampa')).rejects.toMatchObject({ status: 409 });
  });

  test('updateLocation: unknown id → 404; no fields → 400', async () => {
    db.updateLocation.mockResolvedValue(null);
    await expect(service.updateLocation('missing', { name: 'X' })).rejects.toMatchObject({ status: 404 });
    await expect(service.updateLocation('loc1', {})).rejects.toMatchObject({ status: 400 });
  });

  test('deleteLocation: referenced by profiles → 409, no delete attempted', async () => {
    db.getLocationById.mockResolvedValue({ id: 'loc1', name: 'Tampa', is_active: true });
    db.countProfilesForLocation.mockResolvedValue(3);
    await expect(service.deleteLocation('loc1')).rejects.toMatchObject({ status: 409 });
    expect(db.deleteLocation).not.toHaveBeenCalled();
  });

  test('deleteLocation: unreferenced → deleted', async () => {
    db.getLocationById.mockResolvedValue({ id: 'loc1', name: 'Tampa', is_active: true });
    db.countProfilesForLocation.mockResolvedValue(0);
    db.deleteLocation.mockResolvedValue(true);
    await service.deleteLocation('loc1');
    expect(db.deleteLocation).toHaveBeenCalledWith('loc1');
  });
});

describe('setEmployeeLocation (AC-B2)', () => {
  test('happy path: validates user + location, upserts, never writes users', async () => {
    lobDb.getUsersByIds.mockResolvedValue([{ id: 'u1', display_name: 'Jane', email: 'j@x.com' }]);
    db.getLocationById.mockResolvedValue({ id: 'loc1', name: 'Hyderabad', is_active: true });
    db.upsertProfile.mockResolvedValue({
      user_id: 'u1', location_id: 'loc1',
      portal_locations: { id: 'loc1', name: 'Hyderabad', is_active: true },
    });

    const result = await service.setEmployeeLocation('u1', 'loc1', 'admin1');
    expect(result).toEqual({ userId: 'u1', locationId: 'loc1', locationName: 'Hyderabad' });
    expect(db.upsertProfile).toHaveBeenCalledWith('u1', 'loc1', 'admin1');
  });

  test('unknown employee → 404', async () => {
    lobDb.getUsersByIds.mockResolvedValue([]);
    await expect(service.setEmployeeLocation('ghost', 'loc1', 'admin1')).rejects.toMatchObject({ status: 404 });
    expect(db.upsertProfile).not.toHaveBeenCalled();
  });

  test('unknown location → 404; inactive location → 400', async () => {
    lobDb.getUsersByIds.mockResolvedValue([{ id: 'u1' }]);
    db.getLocationById.mockResolvedValueOnce(null);
    await expect(service.setEmployeeLocation('u1', 'missing', 'admin1')).rejects.toMatchObject({ status: 404 });

    db.getLocationById.mockResolvedValueOnce({ id: 'loc1', name: 'Old', is_active: false });
    await expect(service.setEmployeeLocation('u1', 'loc1', 'admin1')).rejects.toMatchObject({ status: 400 });
  });

  test('clearing the location (null) skips location validation', async () => {
    lobDb.getUsersByIds.mockResolvedValue([{ id: 'u1' }]);
    db.upsertProfile.mockResolvedValue({ user_id: 'u1', location_id: null, portal_locations: null });
    const result = await service.setEmployeeLocation('u1', null, 'admin1');
    expect(result).toEqual({ userId: 'u1', locationId: null, locationName: null });
    expect(db.getLocationById).not.toHaveBeenCalled();
  });
});

describe('applyLocationScope (Location filter on analytics)', () => {
  test('no locationId → visible set passes through untouched (null and array)', async () => {
    expect(await service.applyLocationScope(null, undefined)).toBeNull();
    expect(await service.applyLocationScope(['u1'], '')).toEqual(['u1']);
    expect(db.getUserIdsForLocation).not.toHaveBeenCalled();
  });

  test('unrestricted caller (null) + locationId → exactly the location\'s users', async () => {
    db.getUserIdsForLocation.mockResolvedValue(['u1', 'u2']);
    expect(await service.applyLocationScope(null, 'loc1')).toEqual(['u1', 'u2']);
  });

  test('LOB-scoped caller + locationId → intersection (empty when disjoint)', async () => {
    db.getUserIdsForLocation.mockResolvedValue(['u2', 'u3']);
    expect(await service.applyLocationScope(['u1', 'u2'], 'loc1')).toEqual(['u2']);

    db.getUserIdsForLocation.mockResolvedValue(['u9']);
    expect(await service.applyLocationScope(['u1', 'u2'], 'loc1')).toEqual([]);
  });
});

describe('setEmployeeLocations (bulk assignment)', () => {
  test('validates location once, filters unknown users, bulk-upserts the rest', async () => {
    db.getLocationById.mockResolvedValue({ id: 'loc1', name: 'Hyderabad', is_active: true });
    lobDb.getUsersByIds.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    db.bulkUpsertProfiles.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);

    const result = await service.setEmployeeLocations(['u1', 'u2', 'ghost'], 'loc1', 'admin1');

    expect(result).toEqual({ updatedCount: 2, invalidUserIds: ['ghost'] });
    expect(db.bulkUpsertProfiles).toHaveBeenCalledWith(['u1', 'u2'], 'loc1', 'admin1');
  });

  test('clearing (null location) skips location validation', async () => {
    lobDb.getUsersByIds.mockResolvedValue([{ id: 'u1' }]);
    db.bulkUpsertProfiles.mockResolvedValue([{ user_id: 'u1' }]);

    const result = await service.setEmployeeLocations(['u1'], null, 'admin1');

    expect(result.updatedCount).toBe(1);
    expect(db.getLocationById).not.toHaveBeenCalled();
    expect(db.bulkUpsertProfiles).toHaveBeenCalledWith(['u1'], null, 'admin1');
  });

  test('inactive location → 400; empty userIds → 400; no upsert attempted', async () => {
    db.getLocationById.mockResolvedValue({ id: 'loc1', name: 'Old', is_active: false });
    await expect(service.setEmployeeLocations(['u1'], 'loc1', 'a')).rejects.toMatchObject({ status: 400 });
    await expect(service.setEmployeeLocations([], 'loc1', 'a')).rejects.toMatchObject({ status: 400 });
    expect(db.bulkUpsertProfiles).not.toHaveBeenCalled();
  });

  test('user existence checks are chunked (URL-length safety)', async () => {
    db.getLocationById.mockResolvedValue({ id: 'loc1', name: 'Tampa', is_active: true });
    const ids = Array.from({ length: 450 }, (_, i) => `u${i}`);
    lobDb.getUsersByIds.mockImplementation(async (chunk) => chunk.map((id) => ({ id })));
    db.bulkUpsertProfiles.mockResolvedValue([]);

    const result = await service.setEmployeeLocations(ids, 'loc1', 'admin1');

    expect(lobDb.getUsersByIds.mock.calls.map((c) => c[0].length)).toEqual([200, 200, 50]);
    expect(result.updatedCount).toBe(450);
  });
});

describe('getLocationMapForUsers', () => {
  test('maps user ids to their location; users without profile omitted', async () => {
    db.getProfilesByUserIds.mockResolvedValue([
      { user_id: 'u1', location_id: 'loc1', portal_locations: { id: 'loc1', name: 'Tampa', is_active: true } },
      { user_id: 'u2', location_id: null, portal_locations: null },
    ]);
    const map = await service.getLocationMapForUsers(['u1', 'u2', 'u3']);
    expect(map).toEqual({ u1: { id: 'loc1', name: 'Tampa' } });
  });

  test('empty input → empty map, no query', async () => {
    const map = await service.getLocationMapForUsers([]);
    expect(map).toEqual({});
    expect(db.getProfilesByUserIds).not.toHaveBeenCalled();
  });
});

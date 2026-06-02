'use strict';

jest.mock('../../src/services/db/portal-lob-db-service');

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const db = require('../../src/services/db/portal-lob-db-service');
const lobService = require('../../src/services/portal-lob-service');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveScope', () => {
  test('superadmin → no restriction (nulls)', async () => {
    const scope = await lobService.resolveScope({ userId: 'admin1', role: 'superadmin' });
    expect(scope).toEqual({ isSuperadmin: true, visibleLobIds: null, visibleUserIds: null });
    expect(db.getHeadedLobIds).not.toHaveBeenCalled();
  });

  test('head → de-duplicated union of employees across headed LOBs', async () => {
    db.getHeadedLobIds.mockResolvedValue(['L1', 'L2']);
    db.getUserIdsForLobs.mockResolvedValue(['u1', 'u2', 'u3']);

    const scope = await lobService.resolveScope({ userId: 'head1', role: 'admin' });

    expect(db.getUserIdsForLobs).toHaveBeenCalledWith(['L1', 'L2']);
    expect(scope.isSuperadmin).toBe(false);
    expect(scope.visibleLobIds).toEqual(['L1', 'L2']);
    expect(scope.visibleUserIds).toEqual(['u1', 'u2', 'u3']);
  });

  test('non-superadmin with no headed LOBs → empty scope, no employee lookup', async () => {
    db.getHeadedLobIds.mockResolvedValue([]);

    const scope = await lobService.resolveScope({ userId: 'nobody', role: 'viewer' });

    expect(scope).toEqual({ isSuperadmin: false, visibleLobIds: [], visibleUserIds: [] });
    expect(db.getUserIdsForLobs).not.toHaveBeenCalled();
  });
});

describe('canAccessLob', () => {
  test('superadmin can access any LOB', () => {
    expect(lobService.canAccessLob({ isSuperadmin: true, visibleLobIds: null }, 'anyLob')).toBe(true);
  });
  test('head can access only headed LOBs', () => {
    const scope = { isSuperadmin: false, visibleLobIds: ['L1'] };
    expect(lobService.canAccessLob(scope, 'L1')).toBe(true);
    expect(lobService.canAccessLob(scope, 'L2')).toBe(false);
  });
});

describe('createLob', () => {
  test('rejects empty name with 400', async () => {
    await expect(lobService.createLob({ name: '   ' }, 'admin1')).rejects.toMatchObject({ status: 400 });
    expect(db.createLob).not.toHaveBeenCalled();
  });

  test('maps unique-violation to 409', async () => {
    db.createLob.mockRejectedValue({ code: '23505', message: 'duplicate key' });
    await expect(lobService.createLob({ name: 'Cloud' }, 'admin1')).rejects.toMatchObject({ status: 409 });
  });
});

describe('addMembers', () => {
  test('adds only user ids that exist in users; reports invalid ones', async () => {
    db.getLobById.mockResolvedValue({ id: 'L1' });
    db.getUsersByIds.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    db.addLobMembers.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);

    const result = await lobService.addMembers('L1', ['u1', 'u2', 'bad'], 'admin1');

    expect(db.addLobMembers).toHaveBeenCalledWith('L1', ['u1', 'u2'], 'admin1');
    expect(result).toEqual({ addedCount: 2, invalidUserIds: ['bad'] });
  });

  test('404 when LOB does not exist', async () => {
    db.getLobById.mockResolvedValue(null);
    await expect(lobService.addMembers('missing', ['u1'], 'admin1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('listLobClassifications — precedence (per-LOB rule → default → neutral)', () => {
  test('resolves effective classification per app', async () => {
    db.getLobById.mockResolvedValue({ id: 'L1' });
    db.listCatalog.mockResolvedValue({
      data: [
        { id: 'a', identifier: 'slack.exe', display_name: 'Slack', match_by: 'process', default_classification: 'productive' },
        { id: 'b', identifier: 'mystery', display_name: 'Mystery', match_by: 'url', default_classification: null },
        { id: 'c', identifier: 'youtube', display_name: 'YouTube', match_by: 'url', default_classification: 'non_productive' },
      ],
      totalCount: 3,
    });
    // LOB overrides app 'a' to neutral; leaves b and c unset.
    db.listLobClassifications.mockResolvedValue([{ app_id: 'a', classification: 'neutral' }]);

    const rows = await lobService.listLobClassifications('L1');
    const byId = Object.fromEntries(rows.map((r) => [r.appId, r]));

    // per-LOB rule wins over default
    expect(byId.a.lobClassification).toBe('neutral');
    expect(byId.a.effectiveClassification).toBe('neutral');
    // no rule, no default → neutral
    expect(byId.b.lobClassification).toBeNull();
    expect(byId.b.effectiveClassification).toBe('neutral');
    // no rule → falls back to org default
    expect(byId.c.lobClassification).toBeNull();
    expect(byId.c.effectiveClassification).toBe('non_productive');
  });
});

describe('setLobClassification', () => {
  test('rejects invalid classification value', async () => {
    await expect(lobService.setLobClassification('L1', 'a', 'banana', 'admin1')).rejects.toMatchObject({ status: 400 });
  });

  test('404 when LOB missing', async () => {
    db.getLobById.mockResolvedValue(null);
    await expect(lobService.setLobClassification('missing', 'a', 'productive', 'admin1')).rejects.toMatchObject({ status: 404 });
    expect(db.setLobClassification).not.toHaveBeenCalled();
  });

  test('404 when catalog app missing', async () => {
    db.getLobById.mockResolvedValue({ id: 'L1' });
    db.getCatalogById.mockResolvedValue(null);
    await expect(lobService.setLobClassification('L1', 'missing', 'productive', 'admin1')).rejects.toMatchObject({ status: 404 });
  });

  test('happy path upserts via db', async () => {
    db.getLobById.mockResolvedValue({ id: 'L1' });
    db.getCatalogById.mockResolvedValue({ id: 'a' });
    db.setLobClassification.mockResolvedValue({ id: 'x', lob_id: 'L1', app_id: 'a', classification: 'productive' });
    const row = await lobService.setLobClassification('L1', 'a', 'productive', 'admin1');
    expect(db.setLobClassification).toHaveBeenCalledWith('L1', 'a', 'productive', 'admin1');
    expect(row.classification).toBe('productive');
  });
});

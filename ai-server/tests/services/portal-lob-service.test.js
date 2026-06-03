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

describe('listLobClassifications — per-LOB rule → neutral (no catalog-default fallback)', () => {
  test('unclassified apps are neutral / isClassified:false even when the catalog has a default', async () => {
    db.getLobById.mockResolvedValue({ id: 'L1' });
    db.listCatalog.mockResolvedValue({
      data: [
        { id: 'a', identifier: 'slack.exe', display_name: 'Slack', match_by: 'process', default_classification: 'productive' },
        { id: 'b', identifier: 'mystery', display_name: 'Mystery', match_by: 'url', default_classification: null },
        { id: 'c', identifier: 'youtube', display_name: 'YouTube', match_by: 'url', default_classification: 'non_productive' },
      ],
      totalCount: 3,
    });
    // LOB explicitly sets app 'a' to neutral; b and c have no per-LOB rule.
    db.listLobClassifications.mockResolvedValue([{ app_id: 'a', classification: 'neutral' }]);

    const rows = await lobService.listLobClassifications('L1');
    const byId = Object.fromEntries(rows.map((r) => [r.appId, r]));

    // explicit rule (even 'neutral') ⇒ classified
    expect(byId.a.lobClassification).toBe('neutral');
    expect(byId.a.effectiveClassification).toBe('neutral');
    expect(byId.a.isClassified).toBe(true);

    // no rule, no default ⇒ neutral + unclassified
    expect(byId.b.lobClassification).toBeNull();
    expect(byId.b.effectiveClassification).toBe('neutral');
    expect(byId.b.isClassified).toBe(false);

    // no rule BUT catalog has a default ⇒ STILL neutral + unclassified
    // (default_classification is a display hint only, never the effective value)
    expect(byId.c.lobClassification).toBeNull();
    expect(byId.c.effectiveClassification).toBe('neutral');
    expect(byId.c.isClassified).toBe(false);
    expect(byId.c.defaultClassification).toBe('non_productive'); // still returned for display
  });
});

describe('getLobsForAdmins', () => {
  test('maps each admin to the LOB(s) they head', async () => {
    db.getHeadRowsForAdmins.mockResolvedValue([
      { admin_id: 'a1', lob_id: 'L1' },
      { admin_id: 'a1', lob_id: 'L2' },
      { admin_id: 'a2', lob_id: 'L1' },
    ]);
    db.listLobsByIds.mockResolvedValue([{ id: 'L1', name: 'Cloud' }, { id: 'L2', name: 'Data' }]);

    const map = await lobService.getLobsForAdmins(['a1', 'a2']);

    expect(map.a1.map((l) => l.name).sort()).toEqual(['Cloud', 'Data']);
    expect(map.a2.map((l) => l.name)).toEqual(['Cloud']);
  });

  test('empty input returns {} without DB calls', async () => {
    const map = await lobService.getLobsForAdmins([]);
    expect(map).toEqual({});
    expect(db.getHeadRowsForAdmins).not.toHaveBeenCalled();
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

describe('addLobApp', () => {
  test('404 when LOB missing', async () => {
    db.getLobById.mockResolvedValue(null);
    await expect(
      lobService.addLobApp('missing', { identifier: 'slack.exe', displayName: 'Slack', matchBy: 'process' }, 'admin1')
    ).rejects.toMatchObject({ status: 404 });
  });

  test('400 when identifier/displayName missing', async () => {
    db.getLobById.mockResolvedValue({ id: 'L1' });
    await expect(
      lobService.addLobApp('L1', { identifier: '', displayName: '', matchBy: 'process' }, 'admin1')
    ).rejects.toMatchObject({ status: 400 });
  });

  test('400 when matchBy invalid', async () => {
    db.getLobById.mockResolvedValue({ id: 'L1' });
    await expect(
      lobService.addLobApp('L1', { identifier: 'slack.exe', displayName: 'Slack', matchBy: 'bogus' }, 'admin1')
    ).rejects.toMatchObject({ status: 400 });
  });

  test('creates a new catalog app (no org default) and sets the LOB classification', async () => {
    db.getLobById.mockResolvedValue({ id: 'L1' });
    db.getCatalogByIdentifier.mockResolvedValue(null);
    db.createCatalogApp.mockResolvedValue({ id: 'a1', identifier: 'slack.exe', display_name: 'Slack', match_by: 'process', default_classification: null });
    db.setLobClassification.mockResolvedValue({ classification: 'productive' });

    const row = await lobService.addLobApp('L1', { identifier: 'Slack.exe', displayName: ' Slack ', matchBy: 'process', classification: 'productive' }, 'admin1');

    // identifier lower-cased/trimmed; created with NO org default
    expect(db.createCatalogApp).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'slack.exe', display_name: 'Slack', match_by: 'process', default_classification: null })
    );
    expect(db.setLobClassification).toHaveBeenCalledWith('L1', 'a1', 'productive', 'admin1');
    expect(row).toMatchObject({ appId: 'a1', created: true, lobClassification: 'productive', effectiveClassification: 'productive' });
  });

  test('reuses an existing catalog app instead of creating a duplicate', async () => {
    db.getLobById.mockResolvedValue({ id: 'L1' });
    db.getCatalogByIdentifier.mockResolvedValue({ id: 'a1', identifier: 'slack.exe', display_name: 'Slack', match_by: 'process', default_classification: 'productive' });
    db.setLobClassification.mockResolvedValue({ classification: 'non_productive' });

    const row = await lobService.addLobApp('L1', { identifier: 'slack.exe', displayName: 'Slack', matchBy: 'process', classification: 'non_productive' }, 'admin1');

    expect(db.createCatalogApp).not.toHaveBeenCalled();
    expect(row).toMatchObject({ appId: 'a1', created: false, lobClassification: 'non_productive' });
  });

  test('classification omitted ⇒ catalog entry only, no per-LOB rule (effective neutral)', async () => {
    db.getLobById.mockResolvedValue({ id: 'L1' });
    db.getCatalogByIdentifier.mockResolvedValue(null);
    db.createCatalogApp.mockResolvedValue({ id: 'a2', identifier: 'notion.so', display_name: 'Notion', match_by: 'url', default_classification: null });

    const row = await lobService.addLobApp('L1', { identifier: 'notion.so', displayName: 'Notion', matchBy: 'url' }, 'admin1');

    expect(db.setLobClassification).not.toHaveBeenCalled();
    expect(row).toMatchObject({ appId: 'a2', created: true, lobClassification: null, effectiveClassification: 'neutral' });
  });
});

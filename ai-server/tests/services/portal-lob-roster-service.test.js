'use strict';

/**
 * Portal LOB roster service — Excel/CSV parsing + normalize/dedupe, the
 * derive-on-read union (roster ∪ members with an installed flag), and
 * derive-on-install (a roster entry flips to Installed with NO write).
 * Spec: plan/2026-06-26_web-productivity-portal_lob-roster-adoption.md
 */

jest.mock('../../src/services/db/portal-lob-db-service');

const db = require('../../src/services/db/portal-lob-db-service');
const svc = require('../../src/services/portal-lob-roster-service');

const csvB64 = (text) => ({ filename: 'roster.csv', contentBase64: Buffer.from(text, 'utf8').toString('base64') });

beforeEach(() => {
  jest.clearAllMocks();
  db.getLobById.mockResolvedValue({ id: 'L1', name: 'Cloud' });
  db.upsertExpectedMembers.mockResolvedValue([]);
});

describe('extractRoster — parse, normalize, dedupe', () => {
  test('header row detected; emails normalized (lower/trim); name optional', () => {
    const out = svc.extractRoster([
      ['Email', 'Name'],
      ['  Alice@X.com ', 'Alice'],
      ['bob@y.com', ''],
    ]);
    expect(out.received).toBe(2);
    expect(out.valid).toEqual([
      { email: 'alice@x.com', full_name: 'Alice' },
      { email: 'bob@y.com', full_name: null },
    ]);
    expect(out.duplicatesSkipped).toBe(0);
    expect(out.invalidSkipped).toBe(0);
  });

  test('within-file duplicates and invalid emails are skipped', () => {
    const out = svc.extractRoster([
      ['email', 'name'],
      ['dup@x.com', 'First'],
      ['DUP@x.com', 'Second'], // same email, different case
      ['not-an-email', 'Nope'],
      ['', ''],                 // blank line ignored (not counted in received)
    ]);
    expect(out.received).toBe(3); // 3 non-blank data rows
    expect(out.valid).toEqual([{ email: 'dup@x.com', full_name: 'First' }]);
    expect(out.duplicatesSkipped).toBe(1);
    expect(out.invalidSkipped).toBe(1);
  });

  test('no header row: the cell containing "@" is the email', () => {
    const out = svc.extractRoster([['Alice', 'alice@x.com']]);
    expect(out.valid).toEqual([{ email: 'alice@x.com', full_name: 'Alice' }]);
  });

  test('hyphen/space header spellings ("E-mail", "Full Name") are detected', () => {
    const out = svc.extractRoster([
      ['E-mail', 'Full Name'],
      ['alice@x.com', 'Alice'],
    ]);
    expect(out.received).toBe(1); // header consumed, not counted as data
    expect(out.valid).toEqual([{ email: 'alice@x.com', full_name: 'Alice' }]);
  });

  test('a data value resembling "mail" (e.g. "Ismail") is not mistaken for a header', () => {
    // No header row: ["Ismail", "ismail@x.com"] must still parse as one person.
    const out = svc.extractRoster([['Ismail', 'ismail@x.com']]);
    expect(out.received).toBe(1);
    expect(out.valid).toEqual([{ email: 'ismail@x.com', full_name: 'Ismail' }]);
  });
});

describe('importRoster', () => {
  test('parses CSV, upserts valid rows, returns a summary', async () => {
    const summary = await svc.importRoster(
      'L1',
      csvB64('Email,Name\nalice@x.com,Alice\nbob@x.com,Bob\nbad,Nope\nalice@x.com,Dupe\n'),
      'admin1'
    );
    expect(db.upsertExpectedMembers).toHaveBeenCalledWith(
      'L1',
      [{ email: 'alice@x.com', full_name: 'Alice' }, { email: 'bob@x.com', full_name: 'Bob' }],
      'admin1'
    );
    expect(summary).toEqual({ received: 4, imported: 2, duplicatesSkipped: 1, invalidSkipped: 1 });
  });

  test('unknown LOB → 404, nothing upserted', async () => {
    db.getLobById.mockResolvedValue(null);
    await expect(svc.importRoster('nope', csvB64('email\na@x.com\n'), 'admin1')).rejects.toMatchObject({ status: 404 });
    expect(db.upsertExpectedMembers).not.toHaveBeenCalled();
  });

  test('empty file content → 400', async () => {
    await expect(svc.importRoster('L1', { filename: 'x.csv', contentBase64: '' }, 'admin1'))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('getRoster — derive-on-read union', () => {
  beforeEach(() => {
    db.listExpectedMembers.mockResolvedValue([
      { id: 'r1', email: 'alice@x.com', full_name: 'Alice' }, // installed (matches a user)
      { id: 'r2', email: 'bob@x.com', full_name: 'Bob' },     // not installed
    ]);
    db.getMemberUserIds.mockResolvedValue(['u9']);
    db.getUsersByIds.mockResolvedValue([{ id: 'u9', display_name: 'Carol', email: 'carol@x.com' }]);
    db.getUsersByEmails.mockResolvedValue([
      { id: 'u1', display_name: 'Alice A', email: 'alice@x.com' },
      { id: 'u9', display_name: 'Carol', email: 'carol@x.com' },
    ]);
  });

  test('roster + members merged by email, each with a derived installed flag', async () => {
    const { data, pagination } = await svc.getRoster('L1', { page: 1, limit: 20 });
    expect(pagination.totalCount).toBe(3);
    const byEmail = Object.fromEntries(data.map((r) => [r.email, r]));

    expect(byEmail['alice@x.com']).toMatchObject({ installed: true, userId: 'u1', rosterId: 'r1' });
    expect(byEmail['bob@x.com']).toMatchObject({ installed: false, userId: null, rosterId: 'r2' });
    expect(byEmail['carol@x.com']).toMatchObject({ installed: true, userId: 'u9', rosterId: null });
  });
});

describe('derive-on-install — flips to Installed with no write (AC6)', () => {
  beforeEach(() => {
    db.listExpectedMembers.mockResolvedValue([{ id: 'r1', email: 'dave@x.com', full_name: 'Dave' }]);
    db.getMemberUserIds.mockResolvedValue([]);
    db.getUsersByIds.mockResolvedValue([]);
  });

  test('not installed before a users row exists, Installed after — no upsert/delete', async () => {
    db.getUsersByEmails.mockResolvedValueOnce([]); // before install
    const before = await svc.getRoster('L1', {});
    expect(before.data[0]).toMatchObject({ email: 'dave@x.com', installed: false, userId: null });

    db.getUsersByEmails.mockResolvedValueOnce([{ id: 'u5', display_name: 'Dave', email: 'dave@x.com' }]); // after
    const after = await svc.getRoster('L1', {});
    expect(after.data[0]).toMatchObject({ email: 'dave@x.com', installed: true, userId: 'u5' });

    expect(db.upsertExpectedMembers).not.toHaveBeenCalled();
    expect(db.deleteExpectedMember).not.toHaveBeenCalled();
  });
});

describe('removeRosterEntry', () => {
  test('deletes only the roster row', async () => {
    db.deleteExpectedMember.mockResolvedValue(true);
    await expect(svc.removeRosterEntry('L1', 'r1')).resolves.toBeUndefined();
    expect(db.deleteExpectedMember).toHaveBeenCalledWith('L1', 'r1');
  });

  test('missing entry → 404', async () => {
    db.deleteExpectedMember.mockResolvedValue(false);
    await expect(svc.removeRosterEntry('L1', 'nope')).rejects.toMatchObject({ status: 404 });
  });
});

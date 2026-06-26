/**
 * Portal LOB Roster Service (adoption tracking)
 *
 * Domain logic for the email-keyed expected-member roster:
 *   - import: parse an uploaded .xlsx/.csv into normalized { email, full_name }
 *             rows and upsert them for a LOB
 *   - read:   the LOB member list as the dedupe-by-email UNION of the imported
 *             roster and the existing portal_lob_employees members, each with a
 *             DERIVED installed flag (email present in users.email = installed)
 *   - delete: remove a single imported roster entry
 *
 * Install status is derived at read time — nothing is written when a user
 * installs, and no Jira-owned table is ever written (users is read-only here).
 * Supabase access lives in services/db/portal-lob-db-service.js.
 *
 * Spec: plan/2026-06-26_web-productivity-portal_lob-roster-adoption.md
 */

'use strict';

const ExcelJS = require('exceljs');
const db = require('./db/portal-lob-db-service');

// Loose but practical email shape — rejects blanks/garbage, not an RFC validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Split one CSV line, honoring double-quoted fields and "" escapes. */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else { cur += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseCsv(text) {
  return String(text)
    .split(/\r\n|\n|\r/)
    .filter((line) => line !== '')
    .map(splitCsvLine);
}

/** exceljs cell → plain display text (handles hyperlink/rich-text/formula cells). */
function cellText(cell) {
  const t = cell && cell.text;
  return t == null ? '' : String(t).trim();
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw httpError('Could not read the Excel file', 400);
  }
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell) => cells.push(cellText(cell)));
    rows.push(cells);
  });
  return rows;
}

/** Decode the base64 upload to a 2D array of cell strings (xlsx or csv). */
async function parseFile({ filename, contentBase64 } = {}) {
  if (!contentBase64) throw httpError('No file content provided', 400);
  const buffer = Buffer.from(contentBase64, 'base64');
  if (!buffer.length) throw httpError('Uploaded file is empty', 400);

  const name = String(filename || '').toLowerCase();
  // .xlsx files are ZIP archives starting with the "PK" magic bytes; sniff when
  // the extension is missing/ambiguous so a mislabelled upload still parses.
  const looksXlsx = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (name.endsWith('.csv')) return parseCsv(buffer.toString('utf8'));
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || looksXlsx) return parseXlsx(buffer);
  return parseCsv(buffer.toString('utf8'));
}

/**
 * Turn raw sheet rows into normalized, de-duplicated { email, full_name }.
 * Detects an `email`/`name` header row; without one, the cell containing "@" is
 * the email and the first other non-empty cell is the name. Pure + exported for
 * unit tests.
 */
function extractRoster(rows) {
  const empty = { received: 0, valid: [], duplicatesSkipped: 0, invalidSkipped: 0 };
  if (!Array.isArray(rows) || rows.length === 0) return empty;

  // Detect an email/name header row. Headers are compared with non-alphanumerics
  // stripped, so "Email", "E-mail", "E mail", "Email Address", "Full-Name", etc.
  // are all recognized (the hyphen/space variants used to be missed). Stripping
  // can't cause a false positive on data — a name like "Ismail" → "ismail" still
  // does not contain "email".
  const header = (rows[0] || []).map((c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  const hasHeader = header.some((c) => c.includes('email'));
  const emailIdx = hasHeader ? header.findIndex((c) => c.includes('email')) : -1;
  const nameIdx = hasHeader ? header.findIndex((c) => c.includes('name')) : -1;
  const dataStart = hasHeader ? 1 : 0;

  const seen = new Set();
  let received = 0;
  let duplicatesSkipped = 0;
  let invalidSkipped = 0;
  const valid = [];

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i] || [];
    if (row.every((c) => !String(c || '').trim())) continue; // blank line
    received++;

    let emailCell;
    let nameCell;
    if (emailIdx >= 0) {
      emailCell = row[emailIdx];
      nameCell = nameIdx >= 0 ? row[nameIdx] : undefined;
    } else {
      emailCell = row.find((c) => String(c || '').includes('@'));
      nameCell = row.find((c) => c && c !== emailCell && String(c).trim());
    }

    const email = normalizeEmail(emailCell);
    if (!isValidEmail(email)) { invalidSkipped++; continue; }
    if (seen.has(email)) { duplicatesSkipped++; continue; }
    seen.add(email);
    valid.push({ email, full_name: String(nameCell || '').trim() || null });
  }

  return { received, valid, duplicatesSkipped, invalidSkipped };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Import a roster file into a LOB. Returns a summary so the UI can report how
 * many rows landed vs were skipped.
 */
async function importRoster(lobId, file, importedBy) {
  const lob = await db.getLobById(lobId);
  if (!lob) throw httpError('LOB not found', 404);

  const rows = await parseFile(file || {});
  const { received, valid, duplicatesSkipped, invalidSkipped } = extractRoster(rows);

  if (valid.length) await db.upsertExpectedMembers(lobId, valid, importedBy);

  return { received, imported: valid.length, duplicatesSkipped, invalidSkipped };
}

/**
 * The LOB member list: union (deduped by email) of the imported roster and the
 * existing portal_lob_employees members, each badged with a DERIVED installed
 * flag. Existing members are installed by definition; roster-only people are
 * installed iff their email appears in users.
 */
async function getRoster(lobId, { page = 1, limit = 20, search } = {}) {
  const lob = await db.getLobById(lobId);
  if (!lob) throw httpError('LOB not found', 404);

  const [roster, memberUserIds] = await Promise.all([
    db.listExpectedMembers(lobId),
    db.getMemberUserIds(lobId),
  ]);
  const memberUsers = memberUserIds.length ? await db.getUsersByIds(memberUserIds) : [];

  // Only roster emails need the install lookup — existing members already have a
  // users row (seeded installed below), so they never consult this map.
  const rosterEmails = [...new Set(roster.map((r) => r.email).filter(Boolean))];
  const installedUsers = rosterEmails.length ? await db.getUsersByEmails(rosterEmails) : [];
  const installedByEmail = new Map(
    installedUsers.filter((u) => u.email).map((u) => [normalizeEmail(u.email), u])
  );

  // Build the union, keyed by email (uid fallback for a member with no email).
  const map = new Map();
  for (const u of memberUsers) {
    const key = u.email ? normalizeEmail(u.email) : `uid:${u.id}`;
    map.set(key, {
      email: u.email || null,
      name: u.display_name || u.email || 'Unknown User',
      installed: true, // a portal_lob_employees member always has a users row
      userId: u.id,
      rosterId: null,
    });
  }
  for (const r of roster) {
    const existing = map.get(r.email);
    if (existing) {
      existing.rosterId = r.id;
      if (!existing.name) existing.name = r.full_name || r.email;
    } else {
      const inst = installedByEmail.get(r.email);
      map.set(r.email, {
        email: r.email,
        name: (inst && inst.display_name) || r.full_name || r.email,
        installed: !!inst,
        userId: inst ? inst.id : null,
        rosterId: r.id,
      });
    }
  }

  let rows = [...map.values()];
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter(
      (x) => (x.name || '').toLowerCase().includes(s) || (x.email || '').toLowerCase().includes(s)
    );
  }
  rows.sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));

  const totalCount = rows.length;
  const offset = (page - 1) * limit;
  return { data: rows.slice(offset, offset + limit), pagination: { page, limit, totalCount } };
}

async function removeRosterEntry(lobId, id) {
  const removed = await db.deleteExpectedMember(lobId, id);
  if (!removed) throw httpError('Roster entry not found', 404);
}

module.exports = {
  importRoster,
  getRoster,
  removeRosterEntry,
  // exported for unit tests
  extractRoster,
  normalizeEmail,
  isValidEmail,
};

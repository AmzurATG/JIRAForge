'use strict';

const template = require('../../src/services/notifications/templates/admin-download-digest');

const BASE_DATA = {
  displayName: 'Alice Admin',
  orgName: 'Acme Corp',
  users: [
    { name: 'Bob Smith', email: 'bob@acme.com' },
    { name: 'Carol Jones', email: 'carol@acme.com' },
  ],
  downloadUrl: 'https://example.com/download',
};

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('admin-download-digest template — module shape', () => {
  it('exports the correct type identifier', () => {
    expect(template.type).toBe('admin_download_digest');
  });

  it('exports subject, text, and html functions', () => {
    expect(typeof template.subject).toBe('function');
    expect(typeof template.text).toBe('function');
    expect(typeof template.html).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// subject()
// ---------------------------------------------------------------------------

describe('subject()', () => {
  it('includes the org name in the subject line', () => {
    const result = template.subject({ orgName: 'Acme Corp' });
    expect(result).toContain('Acme Corp');
  });

  it('returns a non-empty string', () => {
    expect(typeof template.subject({ orgName: 'Test Org' })).toBe('string');
    expect(template.subject({ orgName: 'Test Org' }).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// text()
// ---------------------------------------------------------------------------

describe('text()', () => {
  it('includes the admin display name', () => {
    expect(template.text(BASE_DATA)).toContain('Alice Admin');
  });

  it('includes the org name', () => {
    expect(template.text(BASE_DATA)).toContain('Acme Corp');
  });

  it('includes each user name and email', () => {
    const result = template.text(BASE_DATA);
    expect(result).toContain('Bob Smith');
    expect(result).toContain('bob@acme.com');
    expect(result).toContain('Carol Jones');
    expect(result).toContain('carol@acme.com');
  });

  it('includes the download URL', () => {
    expect(template.text(BASE_DATA)).toContain('https://example.com/download');
  });

  it('works with a single user', () => {
    const data = { ...BASE_DATA, users: [{ name: 'Dave', email: 'dave@acme.com' }] };
    expect(template.text(data)).toContain('Dave');
    expect(template.text(data)).toContain('dave@acme.com');
  });
});

// ---------------------------------------------------------------------------
// html() — general structure
// ---------------------------------------------------------------------------

describe('html()', () => {
  let result;

  beforeEach(() => {
    result = template.html(BASE_DATA);
  });

  it('returns a valid HTML string starting with DOCTYPE', () => {
    expect(result.trim()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('includes the admin display name', () => {
    expect(result).toContain('Alice Admin');
  });

  it('includes the org name', () => {
    expect(result).toContain('Acme Corp');
  });

  it('renders a row for each user', () => {
    expect(result).toContain('Bob Smith');
    expect(result).toContain('bob@acme.com');
    expect(result).toContain('Carol Jones');
    expect(result).toContain('carol@acme.com');
  });

  it('includes a download link', () => {
    expect(result).toContain('https://example.com/download');
  });

  // ── esc() — HTML escaping ────────────────────────────────────────────────

  it('escapes & in org name', () => {
    const out = template.html({ ...BASE_DATA, orgName: 'Acme & Partners' });
    expect(out).toContain('Acme &amp; Partners');
    expect(out).not.toContain('Acme & Partners');
  });

  it('escapes < in display name', () => {
    const out = template.html({ ...BASE_DATA, displayName: 'Alice<Admin>' });
    expect(out).toContain('Alice&lt;Admin&gt;');
    expect(out).not.toContain('Alice<Admin>');
  });

  it('escapes > in user name', () => {
    const users = [{ name: 'Bob>Evil', email: 'bob@evil.com' }];
    const out = template.html({ ...BASE_DATA, users });
    expect(out).toContain('Bob&gt;Evil');
  });

  it('escapes " in download URL', () => {
    const out = template.html({ ...BASE_DATA, downloadUrl: 'https://example.com/path?a="1"' });
    expect(out).toContain('https://example.com/path?a=&quot;1&quot;');
  });

  it('escapes all special chars in user email', () => {
    const users = [{ name: 'Test', email: 'x&<>"@example.com' }];
    const out = template.html({ ...BASE_DATA, users });
    expect(out).toContain('x&amp;&lt;&gt;&quot;@example.com');
  });

  it('handles null/undefined user name via String(null) → "null"', () => {
    const users = [{ name: null, email: 'test@example.com' }];
    // esc(null) → String(null ?? '') → '' in the new code (nullish coalescing)
    const out = template.html({ ...BASE_DATA, users });
    expect(out).toContain('test@example.com');
    // Should not throw
  });

  it('handles undefined user email via nullish coalescing', () => {
    const users = [{ name: 'Test', email: undefined }];
    expect(() => template.html({ ...BASE_DATA, users })).not.toThrow();
  });

  it('works with an empty users array', () => {
    const out = template.html({ ...BASE_DATA, users: [] });
    expect(out).toContain('Alice Admin');
    expect(out).toContain('<tbody></tbody>');
  });
});

'use strict';

const template = require('../../src/services/notifications/templates/admin-inactivity-digest');

const BASE_DATA = {
  displayName: 'Alice Admin',
  orgName: 'Acme Corp',
  inactiveUsers: [
    { name: 'Bob Smith', hoursInactive: 24, lastActivity: '2026-03-01 09:00' },
    { name: 'Carol Jones', hoursInactive: 48, lastActivity: '2026-02-28 17:30' },
  ],
};

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('admin-inactivity-digest template — module shape', () => {
  it('exports the correct type identifier', () => {
    expect(template.type).toBe('admin_inactivity_digest');
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
    expect(template.subject({ orgName: 'Acme Corp' })).toContain('Acme Corp');
  });

  it('returns a non-empty string', () => {
    expect(template.subject({ orgName: 'Test' }).length).toBeGreaterThan(0);
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

  it('includes each inactive user name', () => {
    const result = template.text(BASE_DATA);
    expect(result).toContain('Bob Smith');
    expect(result).toContain('Carol Jones');
  });

  it('includes inactivity hours for each user', () => {
    const result = template.text(BASE_DATA);
    expect(result).toContain('24h');
    expect(result).toContain('48h');
  });

  it('includes last activity timestamps', () => {
    const result = template.text(BASE_DATA);
    expect(result).toContain('2026-03-01 09:00');
    expect(result).toContain('2026-02-28 17:30');
  });

  it('works with a single inactive user', () => {
    const data = {
      ...BASE_DATA,
      inactiveUsers: [{ name: 'Dave', hoursInactive: 72, lastActivity: '2026-02-27' }],
    };
    const result = template.text(data);
    expect(result).toContain('Dave');
    expect(result).toContain('72h');
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

  it('renders a row for each inactive user', () => {
    expect(result).toContain('Bob Smith');
    expect(result).toContain('Carol Jones');
  });

  it('renders inactivity hours for each user', () => {
    expect(result).toContain('24');
    expect(result).toContain('48');
  });

  it('renders last activity timestamps', () => {
    expect(result).toContain('2026-03-01 09:00');
    expect(result).toContain('2026-02-28 17:30');
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
    const users = [{ name: 'Bob>Test', hoursInactive: 1, lastActivity: 'now' }];
    const out = template.html({ ...BASE_DATA, inactiveUsers: users });
    expect(out).toContain('Bob&gt;Test');
  });

  it('escapes " in lastActivity field', () => {
    const users = [{ name: 'Test', hoursInactive: 1, lastActivity: '"yesterday"' }];
    const out = template.html({ ...BASE_DATA, inactiveUsers: users });
    expect(out).toContain('&quot;yesterday&quot;');
  });

  it('escapes all four special HTML chars together', () => {
    const users = [{ name: 'A&B<C>D"E', hoursInactive: 5, lastActivity: '2026-01-01' }];
    const out = template.html({ ...BASE_DATA, inactiveUsers: users });
    expect(out).toContain('A&amp;B&lt;C&gt;D&quot;E');
  });

  it('handles null user name via nullish coalescing in esc()', () => {
    const users = [{ name: null, hoursInactive: 1, lastActivity: 'now' }];
    expect(() => template.html({ ...BASE_DATA, inactiveUsers: users })).not.toThrow();
  });

  it('handles undefined hoursInactive', () => {
    const users = [{ name: 'Test', hoursInactive: undefined, lastActivity: 'now' }];
    expect(() => template.html({ ...BASE_DATA, inactiveUsers: users })).not.toThrow();
  });

  it('works with an empty inactiveUsers array', () => {
    const out = template.html({ ...BASE_DATA, inactiveUsers: [] });
    expect(out).toContain('Alice Admin');
    expect(out).toContain('<tbody></tbody>');
  });
});

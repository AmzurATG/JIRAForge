'use strict';

/**
 * WS-D brand guard — portal frontend source (AC-D1).
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md
 *
 * The portal is the internal "Amzur Time Tracker" product; the Jira/
 * Marketplace branding must not appear anywhere in its frontend source.
 * Scans src/portal/src/** (.js/.jsx) + src/portal/index.html for banned
 * strings. Internal identifiers (/api/portal paths, portal_token keys) do
 * not contain the banned words, so a total ban is enforceable.
 */

const fs = require('fs');
const path = require('path');

const PORTAL_ROOT = path.join(__dirname, '..', 'src', 'portal');
const SRC_ROOT = path.join(PORTAL_ROOT, 'src');

const BANNED = [
  { name: 'Productivity Portal', pattern: /productivity portal/i },
  { name: 'Jira', pattern: /\bjira\b/i },
  { name: 'BRD', pattern: /\bBRD\b/ },
];

function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'build') continue;
      out.push(...collectFiles(full));
    } else if (/\.(jsx?|html)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('portal frontend brand guard (AC-D1)', () => {
  const files = [...collectFiles(SRC_ROOT), path.join(PORTAL_ROOT, 'index.html')];

  test('scans a sane number of files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test.each(BANNED.map((b) => [b.name, b.pattern]))(
    'no portal source file mentions "%s"',
    (name, pattern) => {
      const offenders = [];
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');
        lines.forEach((line, i) => {
          if (pattern.test(line)) {
            offenders.push(`${path.relative(PORTAL_ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
      expect(offenders).toEqual([]);
    }
  );
});

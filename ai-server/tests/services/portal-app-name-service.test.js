'use strict';

/**
 * WS-A — display-name cleaning heuristic (AC-A1).
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md
 */

const { cleanDisplayName } = require('../../src/services/portal-app-name-service');

describe('cleanDisplayName', () => {
  test.each([
    // [input, expected]
    ['ShellExperienceHost.exe', 'Shell Experience Host'],
    ['TimeTracker.exe', 'Time Tracker'],
    ['org.gnome.Nautilus', 'Nautilus'],
    ['docker desktop.exe', 'Docker Desktop'],
    ['chrome.exe', 'Chrome'],
    ['cmd.exe', 'Cmd'],
    ['CODE.EXE', 'Code'],
    ['ms-teams.exe', 'Ms Teams'],
    ['windows_terminal.exe', 'Windows Terminal'],
    ['idea64.exe', 'Idea'],
    ['phpstorm64.exe', 'Phpstorm'],
    // Honest limit: opaque executables stay close to the identifier.
    ['msrdc.exe', 'Msrdc'],
    // Two-part dotted values are not treated as reverse-DNS.
    ['notion.so', 'Notion.so'],
    // Whitespace is trimmed.
    ['  slack.exe  ', 'Slack'],
  ])('%s -> %s', (input, expected) => {
    expect(cleanDisplayName(input)).toBe(expected);
  });

  test('empty / nullish input returns empty string', () => {
    expect(cleanDisplayName('')).toBe('');
    expect(cleanDisplayName('   ')).toBe('');
    expect(cleanDisplayName(null)).toBe('');
    expect(cleanDisplayName(undefined)).toBe('');
  });

  test('garbage input is echoed back rather than emptied', () => {
    expect(cleanDisplayName('...')).toBe('...');
  });

  test('non-string input does not throw', () => {
    expect(() => cleanDisplayName(42)).not.toThrow();
    expect(cleanDisplayName(42)).toBe('42');
  });

  test('result is capped at 120 characters', () => {
    const long = `${'a'.repeat(200)}.exe`;
    expect(cleanDisplayName(long).length).toBeLessThanOrEqual(120);
  });
});

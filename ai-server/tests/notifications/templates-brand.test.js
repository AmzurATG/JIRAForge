'use strict';

/**
 * WS-D brand guard — portal-sent email templates (AC-D2).
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md
 *
 * The admin-invite email is portal-only (dispatched solely by
 * portal-admin-users-controller). It must carry the "Amzur Time Tracker"
 * brand and must not mention "Productivity Portal" or Jira — the portal
 * audience is internal users, not Marketplace/Jira users.
 */

const adminInvite = require('../../src/services/notifications/templates/admin-invite');

const CTX = {
  displayName: 'Jane Doe',
  email: 'jane@example.com',
  role: 'admin',
  portalUrl: 'https://portal.example.com/login',
  invitedBy: 'Admin User',
};

const BANNED = [/productivity portal/i, /\bjira\b/i, /\bBRD\b/];

function renderings() {
  return {
    subject: adminInvite.subject,
    text: adminInvite.text(CTX),
    html: adminInvite.html(CTX),
    textNoInviter: adminInvite.text({ ...CTX, invitedBy: null }),
    htmlNoInviter: adminInvite.html({ ...CTX, invitedBy: null }),
  };
}

describe('admin-invite template branding (AC-D2)', () => {
  test('subject, text, and html carry the Amzur Time Tracker brand', () => {
    const r = renderings();
    expect(r.subject).toContain('Amzur Time Tracker');
    expect(r.text).toContain('Amzur Time Tracker');
    expect(r.html).toContain('Amzur Time Tracker');
  });

  test.each(['subject', 'text', 'html', 'textNoInviter', 'htmlNoInviter'])(
    '%s contains no banned brand strings',
    (key) => {
      const value = renderings()[key];
      for (const pattern of BANNED) {
        expect(value).not.toMatch(pattern);
      }
    }
  );
});

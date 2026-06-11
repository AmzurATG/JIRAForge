'use strict';

/**
 * Portal auth controller — password-reset email branding (AC-D2).
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md
 *
 * The reset email is built inline in requestPasswordReset; assert the
 * dispatched subject/body carry "Amzur Time Tracker" and never
 * "Productivity Portal" or Jira.
 */

jest.mock('../../src/services/db/portal-db-service');
jest.mock('../../src/services/notifications/notifme-wrapper', () => ({
  send: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const portalDbService = require('../../src/services/db/portal-db-service');
const notifmeWrapper = require('../../src/services/notifications/notifme-wrapper');
const ctrl = require('../../src/controllers/portal-auth-controller');

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = jest.fn(function (c) { this._status = c; return this; });
  res.json = jest.fn(function (b) { this._body = b; return this; });
  return res;
}

beforeEach(() => jest.clearAllMocks());

describe('requestPasswordReset email branding (AC-D2)', () => {
  const ADMIN = {
    id: 'admin-1',
    org_id: 'org-1',
    email: 'jane@example.com',
    display_name: 'Jane Doe',
  };

  test('reset email subject and body use Amzur Time Tracker, never Productivity Portal or Jira', async () => {
    portalDbService.getAdminByEmail.mockResolvedValue(ADMIN);
    portalDbService.setPasswordResetToken.mockResolvedValue(undefined);
    notifmeWrapper.send.mockResolvedValue({ success: true, messageId: 'm1' });

    const res = makeRes();
    await ctrl.requestPasswordReset({ body: { email: ADMIN.email } }, res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(expect.objectContaining({ success: true }));
    expect(notifmeWrapper.send).toHaveBeenCalledTimes(1);

    const sent = notifmeWrapper.send.mock.calls[0][0];
    expect(sent.to).toBe(ADMIN.email);
    expect(sent.subject).toContain('Amzur Time Tracker');
    expect(sent.html).toContain('Amzur Time Tracker');
    for (const pattern of [/productivity portal/i, /\bjira\b/i, /\bBRD\b/]) {
      expect(sent.subject).not.toMatch(pattern);
      expect(sent.html).not.toMatch(pattern);
    }
  });

  test('unknown email: generic success, no email dispatched', async () => {
    portalDbService.getAdminByEmail.mockResolvedValue(null);

    const res = makeRes();
    await ctrl.requestPasswordReset({ body: { email: 'nobody@example.com' } }, res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(expect.objectContaining({ success: true }));
    expect(notifmeWrapper.send).not.toHaveBeenCalled();
  });
});

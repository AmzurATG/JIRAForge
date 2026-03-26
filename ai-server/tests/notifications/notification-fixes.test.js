/**
 * Automated tests for notification bug fixes:
 *
 * 1. Settings URL / notification preferences link must NOT produce a 404
 *    - _buildSettingsUrl should return null (no external link) unless SETTINGS_URL env is set
 *    - Email templates must gracefully render plain-text when settingsUrl is null
 *
 * 2. Notifications must NOT be sent on weekends or outside work hours
 *    - _sendLoginReminderToUser must check _isWithinWorkHours
 *    - _sendDownloadReminderToUser must check _isWithinWorkHours
 *    - _sendVersionNotificationToUser must check _isWithinWorkHours
 *    - _sendInactivityAlertToUser must check _isWithinWorkHours (already did before fix)
 */

// ─── Mock dependencies ───────────────────────────────────────────────
jest.mock('../../src/services/notifications/notifme-wrapper', () => ({
    send: jest.fn(),
    initialize: jest.fn(),
    isEnabled: jest.fn().mockReturnValue(true),
    getStatus: jest.fn().mockReturnValue({ initialized: true, provider: 'sendgrid' })
}));

jest.mock('../../src/services/db/notification-db-service', () => ({
    getUserPreferences: jest.fn(),
    checkCooldown: jest.fn(),
    updateCooldown: jest.fn(),
    createLog: jest.fn(),
    updateLog: jest.fn()
}));

jest.mock('../../src/services/db/user-db-service', () => ({
    getUserById: jest.fn(),
    getOrganizationById: jest.fn(),
    getLatestDownloadUrl: jest.fn()
}));

jest.mock('../../src/services/db/supabase-client', () => ({
    getClient: jest.fn()
}));

jest.mock('../../src/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// ─── Imports ─────────────────────────────────────────────────────────
const notificationService = require('../../src/services/notifications/notification-service');
const { NotificationPollingService } = require('../../src/services/notifications/notification-polling');
const notifmeWrapper = require('../../src/services/notifications/notifme-wrapper');
const notificationDb = require('../../src/services/db/notification-db-service');
const userDbService = require('../../src/services/db/user-db-service');
const { getClient } = require('../../src/services/db/supabase-client');

// ─── Email templates ─────────────────────────────────────────────────
const loginReminderTemplate = require('../../src/services/notifications/templates/login-reminder');
const downloadReminderTemplate = require('../../src/services/notifications/templates/download-reminder');
const newVersionTemplate = require('../../src/services/notifications/templates/new-version');
const inactivityAlertTemplate = require('../../src/services/notifications/templates/inactivity-alert');

// =====================================================================
// FIX 1 — Email templates must not reference notification preferences
// (no notification preferences page exists)
// =====================================================================
describe('Fix: Email templates should not reference notification preferences', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Email templates do not mention notification preferences', () => {
        const baseData = {
            displayName: 'Test User',
            loginUrl: 'https://test.atlassian.net/jira',
            lastLoginDate: '2025-02-01',
            downloadUrl: 'https://example.com/download',
            platform: 'Windows',
            version: '2.0.0',
            currentVersion: '1.0.0',
            releaseNotes: 'Bug fixes',
            isMandatory: false,
            lastActivityTime: '2025-02-01 10:00',
            hoursInactive: 5
        };

        it('login-reminder text should not mention notification preferences', () => {
            const text = loginReminderTemplate.text(baseData);
            expect(text).not.toContain('notification preferences');
        });

        it('login-reminder HTML should not mention notification preferences', () => {
            const html = loginReminderTemplate.html(baseData);
            expect(html).not.toContain('notification preferences');
        });

        it('download-reminder text should not mention notification preferences', () => {
            const text = downloadReminderTemplate.text(baseData);
            expect(text).not.toContain('notification preferences');
        });

        it('download-reminder HTML should not mention notification preferences', () => {
            const html = downloadReminderTemplate.html(baseData);
            expect(html).not.toContain('notification preferences');
        });

        it('new-version text should not mention notification preferences', () => {
            const text = newVersionTemplate.text(baseData);
            expect(text).not.toContain('notification preferences');
        });

        it('new-version HTML should not mention notification preferences', () => {
            const html = newVersionTemplate.html(baseData);
            expect(html).not.toContain('notification preferences');
        });

        it('inactivity-alert text should not mention notification preferences', () => {
            const text = inactivityAlertTemplate.text(baseData);
            expect(text).not.toContain('notification preferences');
        });

        it('inactivity-alert HTML should not mention notification preferences', () => {
            const html = inactivityAlertTemplate.html(baseData);
            expect(html).not.toContain('notification preferences');
        });
    });
});

// =====================================================================
// FIX 2 — Notifications must not be sent on weekends / outside work hours
// =====================================================================
describe('Fix: Notifications must not be sent on weekends', () => {
    let pollingService;

    beforeEach(() => {
        jest.clearAllMocks();

        pollingService = new NotificationPollingService();

        // Default: all sends succeed
        const notifService = require('../../src/services/notifications/notification-service');
        // (notifService is the singleton — same object as notificationService above
        //  but we import via require to be explicit in test context)

        notificationDb.getUserPreferences.mockResolvedValue({
            work_hours_start: '09:00:00',
            work_hours_end: '18:00:00',
            work_days: [1, 2, 3, 4, 5], // Monday–Friday
            timezone: 'UTC'
        });
    });

    // ── helpers ──────────────────────────────────────────────────────
    const mockUser = { id: 'user-1', organization_id: 'org-1', email: 'u@t.com', display_name: 'U' };

    // ── 2a. Weekend blocking ─────────────────────────────────────────
    describe('should block ALL notification types on weekends', () => {

        beforeEach(() => {
            // Saturday 12:00 UTC — within work "hours" but NOT a work day
            jest.useFakeTimers({ now: new Date('2025-03-08T12:00:00Z') });
        });

        afterEach(() => jest.useRealTimers());

        it('_sendLoginReminderToUser returns false on Saturday', async () => {
            const result = await pollingService._sendLoginReminderToUser(mockUser);
            expect(result).toBe(false);
        });

        it('_sendDownloadReminderToUser returns false on Saturday', async () => {
            const result = await pollingService._sendDownloadReminderToUser(mockUser);
            expect(result).toBe(false);
        });

        it('_sendVersionNotificationToUser returns false on Saturday', async () => {
            const user = { ...mockUser, desktop_app_version: '1.0.0' };
            const release = { version: '2.0.0', release_notes: '', download_url: '', is_mandatory: false };
            const result = await pollingService._sendVersionNotificationToUser(user, release);
            expect(result).toBe(false);
        });

        it('_sendInactivityAlertToUser returns false on Saturday', async () => {
            const result = await pollingService._sendInactivityAlertToUser(
                { ...mockUser, desktop_last_heartbeat: '2025-03-07T10:00:00Z' }, {}
            );
            expect(result).toBe(false);
        });
    });

    describe('should block ALL notification types on Sundays', () => {

        beforeEach(() => {
            // Sunday 14:00 UTC
            jest.useFakeTimers({ now: new Date('2025-03-09T14:00:00Z') });
        });

        afterEach(() => jest.useRealTimers());

        it('_sendLoginReminderToUser returns false on Sunday', async () => {
            const result = await pollingService._sendLoginReminderToUser(mockUser);
            expect(result).toBe(false);
        });

        it('_sendDownloadReminderToUser returns false on Sunday', async () => {
            const result = await pollingService._sendDownloadReminderToUser(mockUser);
            expect(result).toBe(false);
        });

        it('_sendVersionNotificationToUser returns false on Sunday', async () => {
            const user = { ...mockUser, desktop_app_version: '1.0.0' };
            const release = { version: '2.0.0', release_notes: '', download_url: '', is_mandatory: false };
            const result = await pollingService._sendVersionNotificationToUser(user, release);
            expect(result).toBe(false);
        });
    });

    // ── 2b. Outside work hours blocking ──────────────────────────────
    describe('should block ALL notification types outside work hours', () => {

        beforeEach(() => {
            // Monday 06:00 UTC — a work day but BEFORE work hours (09–18)
            jest.useFakeTimers({ now: new Date('2025-03-10T06:00:00Z') });
        });

        afterEach(() => jest.useRealTimers());

        it('_sendLoginReminderToUser returns false before work hours', async () => {
            const result = await pollingService._sendLoginReminderToUser(mockUser);
            expect(result).toBe(false);
        });

        it('_sendDownloadReminderToUser returns false before work hours', async () => {
            const result = await pollingService._sendDownloadReminderToUser(mockUser);
            expect(result).toBe(false);
        });

        it('_sendVersionNotificationToUser returns false before work hours', async () => {
            const user = { ...mockUser, desktop_app_version: '1.0.0' };
            const release = { version: '2.0.0', release_notes: '', download_url: '', is_mandatory: false };
            const result = await pollingService._sendVersionNotificationToUser(user, release);
            expect(result).toBe(false);
        });
    });

    describe('should block ALL notification types after work hours', () => {

        beforeEach(() => {
            // Monday 21:00 UTC — a work day but AFTER work hours (09–18)
            jest.useFakeTimers({ now: new Date('2025-03-10T21:00:00Z') });
        });

        afterEach(() => jest.useRealTimers());

        it('_sendLoginReminderToUser returns false after work hours', async () => {
            const result = await pollingService._sendLoginReminderToUser(mockUser);
            expect(result).toBe(false);
        });

        it('_sendDownloadReminderToUser returns false after work hours', async () => {
            const result = await pollingService._sendDownloadReminderToUser(mockUser);
            expect(result).toBe(false);
        });

        it('_sendVersionNotificationToUser returns false after work hours', async () => {
            const user = { ...mockUser, desktop_app_version: '1.0.0' };
            const release = { version: '2.0.0', release_notes: '', download_url: '', is_mandatory: false };
            const result = await pollingService._sendVersionNotificationToUser(user, release);
            expect(result).toBe(false);
        });
    });

    // ── 2c. Positive case: sends during work hours on work days ──────
    describe('should ALLOW all notification types during work hours on weekdays', () => {
        let mockNotifService;

        beforeEach(() => {
            // Monday 12:00 UTC — within work hours on a work day
            jest.useFakeTimers({ now: new Date('2025-03-10T12:00:00Z') });

            mockNotifService = require('../../src/services/notifications/notification-service');
        });

        afterEach(() => jest.useRealTimers());

        it('_sendLoginReminderToUser returns true during work hours', async () => {
            jest.spyOn(mockNotifService, 'sendLoginReminder').mockResolvedValue({ success: true });
            const result = await pollingService._sendLoginReminderToUser(mockUser);
            expect(result).toBe(true);
        });

        it('_sendDownloadReminderToUser returns true during work hours', async () => {
            jest.spyOn(mockNotifService, 'sendDownloadReminder').mockResolvedValue({ success: true });
            const result = await pollingService._sendDownloadReminderToUser(mockUser);
            expect(result).toBe(true);
        });

        it('_sendVersionNotificationToUser returns true during work hours', async () => {
            jest.spyOn(mockNotifService, 'sendNewVersionNotification').mockResolvedValue({ success: true });
            const user = { ...mockUser, desktop_app_version: '1.0.0' };
            const release = { version: '2.0.0', release_notes: '', download_url: '', is_mandatory: false };
            const result = await pollingService._sendVersionNotificationToUser(user, release);
            expect(result).toBe(true);
        });

        it('_sendInactivityAlertToUser returns true during work hours', async () => {
            jest.spyOn(mockNotifService, 'sendInactivityAlert').mockResolvedValue({ success: true });
            const user = { ...mockUser, desktop_last_heartbeat: '2025-03-09T10:00:00Z' };
            const result = await pollingService._sendInactivityAlertToUser(user, {});
            expect(result).toBe(true);
        });
    });

    // ── 2d. Users with no preferences default to allowing ────────────
    describe('should send when user has no notification preferences', () => {

        beforeEach(() => {
            // Wednesday 14:00 UTC
            jest.useFakeTimers({ now: new Date('2025-03-12T14:00:00Z') });
            notificationDb.getUserPreferences.mockResolvedValue(null);
        });

        afterEach(() => jest.useRealTimers());

        it('_sendLoginReminderToUser defaults to allowing', async () => {
            const mockNotifService = require('../../src/services/notifications/notification-service');
            jest.spyOn(mockNotifService, 'sendLoginReminder').mockResolvedValue({ success: true });
            const result = await pollingService._sendLoginReminderToUser(mockUser);
            expect(result).toBe(true);
        });

        it('_sendDownloadReminderToUser defaults to allowing', async () => {
            const mockNotifService = require('../../src/services/notifications/notification-service');
            jest.spyOn(mockNotifService, 'sendDownloadReminder').mockResolvedValue({ success: true });
            const result = await pollingService._sendDownloadReminderToUser(mockUser);
            expect(result).toBe(true);
        });
    });

    // ── 2e. Timezone-aware weekend detection ─────────────────────────
    describe('should respect user timezone for weekend detection', () => {

        afterEach(() => jest.useRealTimers());

        it('should block when it is Saturday in user timezone but Friday UTC', async () => {
            // Friday 23:00 UTC = Saturday 08:00 in Asia/Tokyo (UTC+9)
            jest.useFakeTimers({ now: new Date('2025-03-07T23:00:00Z') });

            notificationDb.getUserPreferences.mockResolvedValue({
                work_hours_start: '09:00:00',
                work_hours_end: '18:00:00',
                work_days: [1, 2, 3, 4, 5],
                timezone: 'Asia/Tokyo'
            });

            const result = await pollingService._sendLoginReminderToUser(mockUser);
            expect(result).toBe(false);
        });

        it('should allow when it is Monday in user timezone but Sunday UTC', async () => {
            // Sunday 23:00 UTC = Monday 08:00 in Asia/Tokyo (UTC+9)
            // But 08:00 is before work_hours_start 09:00, so this should be false
            // Let's use Sunday 23:30 UTC = Monday 08:30 JST — still before 09:00
            // Use Monday 00:00 UTC = Monday 09:00 JST — exactly at start boundary
            jest.useFakeTimers({ now: new Date('2025-03-10T00:00:00Z') });

            notificationDb.getUserPreferences.mockResolvedValue({
                work_hours_start: '09:00:00',
                work_hours_end: '18:00:00',
                work_days: [1, 2, 3, 4, 5],
                timezone: 'Asia/Tokyo'
            });

            const mockNotifService = require('../../src/services/notifications/notification-service');
            jest.spyOn(mockNotifService, 'sendLoginReminder').mockResolvedValue({ success: true });

            const result = await pollingService._sendLoginReminderToUser(mockUser);
            expect(result).toBe(true);
        });
    });

    // ── 2f. Custom work_days configuration ───────────────────────────
    describe('should respect custom work_days configuration', () => {

        afterEach(() => jest.useRealTimers());

        it('should allow Saturday when work_days includes 6', async () => {
            // Saturday 12:00 UTC
            jest.useFakeTimers({ now: new Date('2025-03-08T12:00:00Z') });

            notificationDb.getUserPreferences.mockResolvedValue({
                work_hours_start: '09:00:00',
                work_hours_end: '18:00:00',
                work_days: [1, 2, 3, 4, 5, 6], // includes Saturday
                timezone: 'UTC'
            });

            const mockNotifService = require('../../src/services/notifications/notification-service');
            jest.spyOn(mockNotifService, 'sendLoginReminder').mockResolvedValue({ success: true });

            const result = await pollingService._sendLoginReminderToUser(mockUser);
            expect(result).toBe(true);
        });

        it('should block Wednesday when work_days excludes 3', async () => {
            // Wednesday 12:00 UTC
            jest.useFakeTimers({ now: new Date('2025-03-12T12:00:00Z') });

            notificationDb.getUserPreferences.mockResolvedValue({
                work_hours_start: '09:00:00',
                work_hours_end: '18:00:00',
                work_days: [1, 2, 4, 5], // Wednesday (3) excluded
                timezone: 'UTC'
            });

            const result = await pollingService._sendLoginReminderToUser(mockUser);
            expect(result).toBe(false);
        });
    });

    // ── 2g. Admin digests must also respect weekends ─────────────────
    describe('should block admin digest notifications on weekends', () => {
        beforeEach(() => {
            // Saturday 12:00 UTC — within work "hours" but NOT a work day
            jest.useFakeTimers({ now: new Date('2025-03-08T12:00:00Z') });

            // Mock _getOrgAdmins and _getOrgName
            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([
                { id: 'admin-1', email: 'admin@t.com', display_name: 'Admin' }
            ]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');
        });

        afterEach(() => jest.useRealTimers());

        it('_sendAdminDownloadDigestForOrg returns 0 on Saturday', async () => {
            const orgUsers = [{ display_name: 'U', email: 'u@t.com' }];
            const result = await pollingService._sendAdminDownloadDigestForOrg('org-1', orgUsers);
            expect(result).toBe(0);
        });

        it('_sendAdminInactivityDigestForOrg returns 0 on Saturday', async () => {
            const orgUsers = [{ ...mockUser, desktop_last_heartbeat: '2025-03-07T10:00:00Z' }];
            const result = await pollingService._sendAdminInactivityDigestForOrg('org-1', orgUsers, {});
            expect(result).toBe(0);
        });
    });

    describe('should block admin digest notifications on Sundays', () => {
        beforeEach(() => {
            // Sunday 14:00 UTC
            jest.useFakeTimers({ now: new Date('2025-03-09T14:00:00Z') });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([
                { id: 'admin-1', email: 'admin@t.com', display_name: 'Admin' }
            ]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');
        });

        afterEach(() => jest.useRealTimers());

        it('_sendAdminDownloadDigestForOrg returns 0 on Sunday', async () => {
            const orgUsers = [{ display_name: 'U', email: 'u@t.com' }];
            const result = await pollingService._sendAdminDownloadDigestForOrg('org-1', orgUsers);
            expect(result).toBe(0);
        });

        it('_sendAdminInactivityDigestForOrg returns 0 on Sunday', async () => {
            const orgUsers = [{ ...mockUser, desktop_last_heartbeat: '2025-03-08T10:00:00Z' }];
            const result = await pollingService._sendAdminInactivityDigestForOrg('org-1', orgUsers, {});
            expect(result).toBe(0);
        });
    });

    describe('should ALLOW admin digest notifications during work hours on weekdays', () => {
        let mockNotifService;

        beforeEach(() => {
            // Monday 12:00 UTC — within work hours on a work day
            jest.useFakeTimers({ now: new Date('2025-03-10T12:00:00Z') });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([
                { id: 'admin-1', email: 'admin@t.com', display_name: 'Admin' }
            ]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');

            mockNotifService = require('../../src/services/notifications/notification-service');
        });

        afterEach(() => jest.useRealTimers());

        it('_sendAdminDownloadDigestForOrg sends on weekday work hours', async () => {
            jest.spyOn(mockNotifService, 'sendAdminDownloadDigest').mockResolvedValue({ success: true });
            const orgUsers = [{ display_name: 'U', email: 'u@t.com' }];
            const result = await pollingService._sendAdminDownloadDigestForOrg('org-1', orgUsers);
            expect(result).toBe(1);
        });

        it('_sendAdminInactivityDigestForOrg sends on weekday work hours', async () => {
            jest.spyOn(mockNotifService, 'sendAdminInactivityDigest').mockResolvedValue({ success: true });
            const orgUsers = [{ ...mockUser, desktop_last_heartbeat: '2025-03-09T10:00:00Z' }];
            const result = await pollingService._sendAdminInactivityDigestForOrg('org-1', orgUsers, {});
            expect(result).toBe(1);
        });
    });
});

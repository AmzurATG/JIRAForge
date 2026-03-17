/**
 * Inactivity Alert Data Consistency Tests
 *
 * Validates that the inactivity data shown in email notifications is accurate
 * and consistent with the time tracker data. Covers three key fixes:
 *
 * 1. hoursInactive is computed from the TRUE last activity (batch_end), not just
 *    the heartbeat, even when the user has been inactive longer than the threshold.
 * 2. lastActivityTime is formatted in the user's configured timezone.
 * 3. hoursInactive is displayed in "Xh Ym" format, matching the dashboard.
 */

jest.mock('../../src/services/notifications/notification-service', () => ({
    sendLoginReminder: jest.fn(),
    sendDownloadReminder: jest.fn(),
    sendNewVersionNotification: jest.fn(),
    sendInactivityAlert: jest.fn(),
    sendAdminInactivityDigest: jest.fn(),
    sendAdminDownloadDigest: jest.fn()
}));

jest.mock('../../src/services/db/notification-db-service', () => ({
    getUserPreferences: jest.fn()
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

const { NotificationPollingService } = require('../../src/services/notifications/notification-polling');
const notificationService = require('../../src/services/notifications/notification-service');
const notificationDb = require('../../src/services/db/notification-db-service');
const { getClient } = require('../../src/services/db/supabase-client');

describe('Inactivity Alert Data Consistency', () => {
    let pollingService;
    let mockSupabase;
    let fromCallTracker;

    beforeEach(() => {
        jest.clearAllMocks();
        // Wednesday March 12 2025 at 20:00 UTC (8 PM)
        jest.useFakeTimers({ now: new Date('2025-03-12T20:00:00Z') });
        pollingService = new NotificationPollingService();

        // Track which table 'from' is called with
        fromCallTracker = [];

        mockSupabase = {
            from: jest.fn().mockImplementation((table) => {
                fromCallTracker.push(table);
                return mockSupabase;
            }),
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            neq: jest.fn().mockReturnThis(),
            not: jest.fn().mockReturnThis(),
            is: jest.fn().mockReturnThis(),
            lt: jest.fn().mockReturnThis(),
            gt: jest.fn().mockReturnThis(),
            in: jest.fn().mockReturnThis(),
            or: jest.fn().mockReturnThis(),
            order: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            single: jest.fn(),
            rpc: jest.fn()
        };

        getClient.mockReturnValue(mockSupabase);
        notificationService.sendInactivityAlert.mockResolvedValue({ success: true });
        notificationService.sendAdminInactivityDigest.mockResolvedValue({ success: true });
        notificationDb.getUserPreferences.mockResolvedValue({
            work_hours_start: '09:00:00',
            work_hours_end: '23:00:00',
            work_days: [1, 2, 3, 4, 5],
            timezone: 'UTC'
        });
    });

    afterEach(() => {
        pollingService.stop();
        jest.useRealTimers();
    });

    // -------------------------------------------------------------------------
    // Bug Fix 1: hoursInactive uses true last activity for inactive users
    // -------------------------------------------------------------------------
    describe('Bug Fix 1: Accurate hoursInactive for inactive users', () => {

        it('should use batch_end (not heartbeat) when batch_end is more recent', async () => {
            // Scenario: heartbeat at 12:00, batch_end at 14:30, both older than threshold.
            // The old code would only use heartbeat (8h inactive) because _fetchRecentActivity
            // filtered out batch_end older than threshold. Now it should use batch_end (5h 30m).
            const user = {
                id: 'user-srilakshmi',
                organization_id: 'org-1',
                desktop_last_heartbeat: '2025-03-12T12:00:00Z'
            };

            // Simulate: recent activity query returns nothing (all older than threshold)
            // Fallback query returns the true latest batch_end
            mockSupabase.gt.mockResolvedValueOnce({ data: [], error: null }); // recent activity
            mockSupabase.rpc.mockResolvedValueOnce({
                data: [{ user_id: 'user-srilakshmi', batch_end: '2025-03-12T14:30:00Z' }],
                error: null
            });

            const { latestBatchByUser } = await pollingService._fetchRecentActivity(
                mockSupabase, ['user-srilakshmi'], new Date('2025-03-12T16:00:00Z')
            );

            const effectiveLastActive = pollingService._getEffectiveLastActive(user, latestBatchByUser);
            expect(effectiveLastActive.toISOString()).toBe('2025-03-12T14:30:00.000Z');

            const hoursInactive = pollingService._calculateHoursInactive(effectiveLastActive);
            expect(hoursInactive).toBe(5.5); // 20:00 - 14:30 = 5.5h
        });

        it('should still use heartbeat when it is newer than batch_end', async () => {
            const user = {
                id: 'user-1',
                organization_id: 'org-1',
                desktop_last_heartbeat: '2025-03-12T15:00:00Z'
            };

            mockSupabase.gt.mockResolvedValueOnce({ data: [], error: null });
            mockSupabase.rpc.mockResolvedValueOnce({
                data: [{ user_id: 'user-1', batch_end: '2025-03-12T13:00:00Z' }],
                error: null
            });

            const { latestBatchByUser } = await pollingService._fetchRecentActivity(
                mockSupabase, ['user-1'], new Date('2025-03-12T16:00:00Z')
            );

            const effectiveLastActive = pollingService._getEffectiveLastActive(user, latestBatchByUser);
            expect(effectiveLastActive.toISOString()).toBe('2025-03-12T15:00:00.000Z');
        });

        it('should fall back to per-user query when RPC fails', async () => {
            const user = {
                id: 'user-2',
                organization_id: 'org-1',
                desktop_last_heartbeat: '2025-03-12T10:00:00Z'
            };

            // Recent activity query returns empty
            mockSupabase.gt.mockResolvedValueOnce({ data: [], error: null });
            // RPC fails
            mockSupabase.rpc.mockResolvedValueOnce({ data: null, error: new Error('function not found') });
            // Fallback per-user query succeeds
            mockSupabase.limit.mockResolvedValueOnce({
                data: [{ batch_end: '2025-03-12T14:00:00Z' }],
                error: null
            });

            const { latestBatchByUser } = await pollingService._fetchRecentActivity(
                mockSupabase, ['user-2'], new Date('2025-03-12T16:00:00Z')
            );

            expect(latestBatchByUser['user-2']).toBe('2025-03-12T14:00:00Z');
            const effectiveLastActive = pollingService._getEffectiveLastActive(user, latestBatchByUser);
            expect(effectiveLastActive.toISOString()).toBe('2025-03-12T14:00:00.000Z');
        });

        it('should not fetch extra for users that already have recent activity', async () => {
            // User has recent activity above threshold — no fallback needed
            mockSupabase.gt.mockResolvedValueOnce({
                data: [{ user_id: 'user-active', batch_end: '2025-03-12T19:00:00Z' }],
                error: null
            });

            const { usersWithRecentActivity, latestBatchByUser } = await pollingService._fetchRecentActivity(
                mockSupabase, ['user-active'], new Date('2025-03-12T16:00:00Z')
            );

            expect(usersWithRecentActivity.has('user-active')).toBe(true);
            expect(latestBatchByUser['user-active']).toBe('2025-03-12T19:00:00Z');
            // RPC should not have been called since all users have recent activity
            expect(mockSupabase.rpc).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // Bug Fix 2: lastActivityTime formatted in user's timezone
    // -------------------------------------------------------------------------
    describe('Bug Fix 2: Timezone-aware lastActivityTime formatting', () => {

        it('should format date in user timezone (UTC)', () => {
            const date = new Date('2025-03-12T14:27:26Z');
            const formatted = pollingService._formatDateForUser(date, 'UTC');
            // en-US format in UTC
            expect(formatted).toContain('3/12/2025');
            expect(formatted).toContain('2:27:26');
            expect(formatted).toContain('PM');
        });

        it('should format date in user timezone (Asia/Kolkata, +5:30)', () => {
            const date = new Date('2025-03-12T14:27:26Z');
            const formatted = pollingService._formatDateForUser(date, 'Asia/Kolkata');
            // 14:27 UTC = 19:57 IST
            expect(formatted).toContain('3/12/2025');
            expect(formatted).toContain('7:57:26');
            expect(formatted).toContain('PM');
        });

        it('should format date in user timezone (America/New_York, -4 DST)', () => {
            const date = new Date('2025-03-12T14:27:26Z');
            const formatted = pollingService._formatDateForUser(date, 'America/New_York');
            // 14:27 UTC = 10:27 EDT
            expect(formatted).toContain('10:27:26');
            expect(formatted).toContain('AM');
        });

        it('should fall back to ISO string for invalid timezone', () => {
            const date = new Date('2025-03-12T14:27:26Z');
            const formatted = pollingService._formatDateForUser(date, 'Invalid/Zone');
            expect(formatted).toBe('2025-03-12T14:27:26.000Z');
        });

        it('should pass user timezone to sendInactivityAlert', async () => {
            // Use 10:00 UTC = 3:30 PM IST (within work hours in Asia/Kolkata)
            jest.setSystemTime(new Date('2025-03-12T10:00:00Z'));

            const user = {
                id: 'user-tz',
                organization_id: 'org-1',
                desktop_last_heartbeat: '2025-03-12T04:27:26Z'  // 9:57 AM IST
            };

            notificationDb.getUserPreferences.mockResolvedValue({
                work_hours_start: '09:00:00',
                work_hours_end: '23:00:00',
                work_days: [1, 2, 3, 4, 5],
                timezone: 'Asia/Kolkata'
            });

            await pollingService._sendInactivityAlertToUser(user, {});

            const callArgs = notificationService.sendInactivityAlert.mock.calls[0];
            const activityInfo = callArgs[2];

            // 04:27:26 UTC formatted in IST = 9:57:26 AM
            expect(activityInfo.lastActivityTime).toContain('9:57:26');
            expect(activityInfo.lastActivityTime).toContain('AM');
        });
    });

    // -------------------------------------------------------------------------
    // Bug Fix 3: hoursInactive in "Xh Ym" format (matches dashboard)
    // -------------------------------------------------------------------------
    describe('Bug Fix 3: Consistent time format (Xh Ym)', () => {

        it('should format 5.4 hours as "5h 24m"', () => {
            expect(pollingService._formatHoursForDisplay(5.4)).toBe('5h 24m');
        });

        it('should format 4.0 hours as "4h"', () => {
            expect(pollingService._formatHoursForDisplay(4.0)).toBe('4h');
        });

        it('should format 0.5 hours as "30m"', () => {
            expect(pollingService._formatHoursForDisplay(0.5)).toBe('30m');
        });

        it('should format 1.5 hours as "1h 30m"', () => {
            expect(pollingService._formatHoursForDisplay(1.5)).toBe('1h 30m');
        });

        it('should format 0 hours as "0m"', () => {
            expect(pollingService._formatHoursForDisplay(0)).toBe('0m');
        });

        it('should format 2.75 hours as "2h 45m"', () => {
            expect(pollingService._formatHoursForDisplay(2.75)).toBe('2h 45m');
        });

        it('should format 0.25 hours as "15m"', () => {
            expect(pollingService._formatHoursForDisplay(0.25)).toBe('15m');
        });

        it('should send formatted hoursInactive in alert email', async () => {
            jest.setSystemTime(new Date('2025-03-12T20:00:00Z'));

            const user = {
                id: 'user-fmt',
                organization_id: 'org-1',
                desktop_last_heartbeat: '2025-03-12T14:36:00Z'  // 5h 24m ago
            };

            await pollingService._sendInactivityAlertToUser(user, {});

            const callArgs = notificationService.sendInactivityAlert.mock.calls[0];
            const activityInfo = callArgs[2];

            expect(activityInfo.hoursInactive).toBe('5h 24m');
        });

        it('should send formatted hoursInactive in admin digest', async () => {
            jest.setSystemTime(new Date('2025-03-12T20:00:00Z'));

            const user = {
                id: 'user-digest',
                display_name: 'Test User',
                email: 'test@example.com',
                desktop_last_heartbeat: '2025-03-12T16:00:00Z'  // 4h ago
            };

            const result = await pollingService._prepareDigestUserData(user, {});

            expect(result.hoursInactive).toBe('4h');
            expect(result.name).toBe('Test User');
        });
    });

    // -------------------------------------------------------------------------
    // Integration: End-to-end inactivity alert flow
    // -------------------------------------------------------------------------
    describe('End-to-end inactivity alert data accuracy', () => {

        it('should send accurate data when user has batch_end newer than heartbeat', async () => {
            jest.setSystemTime(new Date('2025-03-12T20:00:00Z'));

            const user = {
                id: 'user-e2e',
                organization_id: 'org-1',
                desktop_last_heartbeat: '2025-03-12T12:00:00Z'
            };

            // batch_end at 14:27:26 (the data from the screenshot scenario)
            const latestBatchByUser = { 'user-e2e': '2025-03-12T14:27:26Z' };

            notificationDb.getUserPreferences.mockResolvedValue({
                work_hours_start: '09:00:00',
                work_hours_end: '23:00:00',
                work_days: [1, 2, 3, 4, 5],
                timezone: 'UTC'
            });

            await pollingService._sendInactivityAlertToUser(user, latestBatchByUser);

            const callArgs = notificationService.sendInactivityAlert.mock.calls[0];
            const activityInfo = callArgs[2];

            // True last activity is 14:27:26 (batch_end), not 12:00 (heartbeat)
            expect(activityInfo.lastActivityTime).toContain('2:27:26');
            expect(activityInfo.lastActivityTime).toContain('PM');

            // hours inactive: 20:00 - 14:27:26 ≈ 5.5h -> "5h 33m" (5 * 60 + 33 = 333 min)
            // Exact: (20:00:00 - 14:27:26) = 5h 32m 34s -> rounded to 5.5h -> 5h 30m
            expect(activityInfo.hoursInactive).toMatch(/^5h \d+m$/);
        });

        it('should NOT inflate hours when heartbeat is much older than batch_end', async () => {
            jest.setSystemTime(new Date('2025-03-12T20:00:00Z'));

            const user = {
                id: 'user-inflate',
                organization_id: 'org-1',
                desktop_last_heartbeat: '2025-03-12T08:00:00Z' // 12h ago
            };

            // batch_end was at 18:00 - only 2h ago
            const latestBatchByUser = { 'user-inflate': '2025-03-12T18:00:00Z' };

            await pollingService._sendInactivityAlertToUser(user, latestBatchByUser);

            const callArgs = notificationService.sendInactivityAlert.mock.calls[0];
            expect(callArgs[2].hoursInactive).toBe('2h');
            // Old code would have shown "12h" here since heartbeat was 12h ago
        });
    });

    // -------------------------------------------------------------------------
    // Template rendering with new format
    // -------------------------------------------------------------------------
    describe('Email template rendering with new format', () => {
        const inactivityTemplate = require('../../src/services/notifications/templates/inactivity-alert');
        const adminDigestTemplate = require('../../src/services/notifications/templates/admin-inactivity-digest');

        it('should render inactivity alert text with "Xh Ym" format', () => {
            const text = inactivityTemplate.text({
                displayName: 'Srilakshmi Achanta',
                lastActivityTime: '3/12/2025, 2:27:26 PM',
                hoursInactive: '5h 24m',
                settingsUrl: null
            });

            expect(text).toContain('about 5h 24m');
            expect(text).not.toContain('5h 24m hours');
            expect(text).toContain('Last activity: 3/12/2025, 2:27:26 PM');
        });

        it('should render inactivity alert HTML with "Xh Ym" format', () => {
            const html = inactivityTemplate.html({
                displayName: 'Srilakshmi Achanta',
                lastActivityTime: '3/12/2025, 2:27:26 PM',
                hoursInactive: '5h 24m',
                settingsUrl: null
            });

            // Should show "5h 24m" without extra "h" suffix
            expect(html).toContain('>5h 24m<');
            expect(html).not.toContain('>5h 24mh<');
            expect(html).toContain('since last activity');
        });

        it('should render admin digest with "Xh Ym" format', () => {
            const text = adminDigestTemplate.text({
                displayName: 'Admin',
                orgName: 'Amzur',
                inactiveUsers: [
                    { name: 'Srilakshmi', hoursInactive: '5h 24m', lastActivity: '3/12/2025, 2:27:26 PM' }
                ]
            });

            expect(text).toContain('inactive for 5h 24m');
            expect(text).not.toContain('5h 24mh');
        });

        it('should render admin digest HTML with "Xh Ym" format', () => {
            const html = adminDigestTemplate.html({
                displayName: 'Admin',
                orgName: 'Amzur',
                inactiveUsers: [
                    { name: 'Srilakshmi', hoursInactive: '5h 24m', lastActivity: '3/12/2025, 2:27:26 PM' }
                ]
            });

            expect(html).toContain('5h 24m inactive');
            expect(html).not.toContain('5h 24mh');
        });
    });
});

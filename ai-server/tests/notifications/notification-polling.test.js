/**
 * Notification Polling Service Unit Tests
 */

// Mock dependencies before requiring the module
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

describe('NotificationPollingService', () => {
    let pollingService;
    let mockSupabase;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        
        pollingService = new NotificationPollingService();
        
        // Mock Supabase client
        mockSupabase = {
            from: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            neq: jest.fn().mockReturnThis(),
            not: jest.fn().mockReturnThis(),
            is: jest.fn().mockReturnThis(),
            lt: jest.fn().mockReturnThis(),
            gt: jest.fn().mockReturnThis(),
            in: jest.fn().mockReturnThis(),
            or: jest.fn().mockReturnThis(),
            single: jest.fn()
        };
        getClient.mockReturnValue(mockSupabase);

        // Default mock responses
        notificationService.sendLoginReminder.mockResolvedValue({ success: true });
        notificationService.sendDownloadReminder.mockResolvedValue({ success: true });
        notificationService.sendNewVersionNotification.mockResolvedValue({ success: true });
        notificationService.sendInactivityAlert.mockResolvedValue({ success: true });
        notificationService.sendAdminInactivityDigest.mockResolvedValue({ success: true });
        notificationService.sendAdminDownloadDigest.mockResolvedValue({ success: true });
        notificationDb.getUserPreferences.mockResolvedValue({
            work_hours_start: '09:00:00',
            work_hours_end: '18:00:00',
            work_days: [1, 2, 3, 4, 5],
            timezone: 'UTC'
        });
    });

    afterEach(() => {
        pollingService.stop();
        jest.useRealTimers();
    });

    describe('start/stop', () => {
        it('should start polling service', () => {
            pollingService.start();
            expect(pollingService.isRunning).toBe(true);
        });

        it('should not start if already running', () => {
            pollingService.start();
            pollingService.start();
            // Should only have one interval
            expect(pollingService.isRunning).toBe(true);
        });

        it('should stop polling service', () => {
            pollingService.start();
            pollingService.stop();
            expect(pollingService.isRunning).toBe(false);
        });

        it('should handle stop when not running', () => {
            pollingService.stop();
            expect(pollingService.isRunning).toBe(false);
        });

        it('should run checks immediately on start', async () => {
            // Mock all check methods to track if they were called
            const mockCheckLogin = jest.fn().mockResolvedValue();
            const mockCheckDownload = jest.fn().mockResolvedValue();
            const mockCheckVersion = jest.fn().mockResolvedValue();
            const mockCheckInactivity = jest.fn().mockResolvedValue();

            pollingService.checkLoginReminders = mockCheckLogin;
            pollingService.checkDownloadReminders = mockCheckDownload;
            pollingService.checkNewVersionNotifications = mockCheckVersion;
            pollingService.checkInactivityAlerts = mockCheckInactivity;

            pollingService.start();

            // Let the initial run execute
            await Promise.resolve();

            // Stop to prevent interval from running
            pollingService.stop();
        });

        it('should handle initial run failure gracefully', async () => {
            pollingService.runAllChecks = jest.fn().mockRejectedValue(new Error('Initial failure'));

            // Should not throw
            pollingService.start();

            // Wait for the catch handler to execute (line 52)
            await Promise.resolve();
            await Promise.resolve();

            expect(pollingService.isRunning).toBe(true);

            pollingService.stop();
        });

        it('should handle scheduled run failure gracefully', async () => {
            let callCount = 0;
            pollingService.runAllChecks = jest.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(); // Initial run succeeds
                }
                return Promise.reject(new Error('Scheduled failure')); // Scheduled run fails
            });

            pollingService.start();

            // Wait for initial run
            await Promise.resolve();

            // Advance timer to trigger scheduled run (line 58)
            jest.advanceTimersByTime(900000); // 15 minutes

            // Wait for the scheduled rejection to be handled
            await Promise.resolve();
            await Promise.resolve();

            expect(pollingService.isRunning).toBe(true);
            expect(callCount).toBe(2);

            pollingService.stop();
        });

        it('should run checks at scheduled interval', async () => {
            const mockRunAllChecks = jest.spyOn(pollingService, 'runAllChecks').mockResolvedValue();

            pollingService.start();

            // Initial call
            expect(mockRunAllChecks).toHaveBeenCalledTimes(1);

            // Advance timer by polling interval
            jest.advanceTimersByTime(900000); // 15 minutes

            expect(mockRunAllChecks).toHaveBeenCalledTimes(2);

            pollingService.stop();
            mockRunAllChecks.mockRestore();
        });
    });

    describe('getStatus', () => {
        it('should return status when not running', () => {
            const status = pollingService.getStatus();
            expect(status.isRunning).toBe(false);
            expect(status.lastRunTime).toBeNull();
        });

        it('should return status with last run time after running', async () => {
            mockSupabase.select.mockResolvedValue({ data: [], error: null });
            
            await pollingService.runAllChecks();
            
            const status = pollingService.getStatus();
            expect(status.lastRunTime).toBeDefined();
            expect(status.stats.runsCompleted).toBe(1);
        });
    });

    describe('checkLoginReminders', () => {
        it('should find and notify users who need login reminders', async () => {
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', desktop_last_heartbeat: null },
                { id: 'user-2', organization_id: 'org-1', email: 'user2@test.com', desktop_last_heartbeat: '2025-01-01' }
            ];
            
            mockSupabase.or.mockResolvedValue({ data: mockUsers, error: null });

            await pollingService.checkLoginReminders();

            expect(notificationService.sendLoginReminder).toHaveBeenCalledTimes(2);
        });

        it('should handle empty user list', async () => {
            mockSupabase.or.mockResolvedValue({ data: [], error: null });

            await pollingService.checkLoginReminders();

            expect(notificationService.sendLoginReminder).not.toHaveBeenCalled();
        });

        it('should handle database errors', async () => {
            mockSupabase.or.mockResolvedValue({ data: null, error: new Error('DB error') });

            await pollingService.checkLoginReminders();

            // Should not throw, just log error
            expect(notificationService.sendLoginReminder).not.toHaveBeenCalled();
        });

        it('should handle missing supabase client', async () => {
            getClient.mockReturnValue(null);

            await pollingService.checkLoginReminders();

            expect(notificationService.sendLoginReminder).not.toHaveBeenCalled();
        });

        it('should continue on individual send failures', async () => {
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com' },
                { id: 'user-2', organization_id: 'org-1', email: 'user2@test.com' }
            ];
            
            mockSupabase.or.mockResolvedValue({ data: mockUsers, error: null });
            notificationService.sendLoginReminder
                .mockRejectedValueOnce(new Error('Send failed'))
                .mockResolvedValueOnce({ success: true });

            await pollingService.checkLoginReminders();

            expect(notificationService.sendLoginReminder).toHaveBeenCalledTimes(2);
        });
    });

    describe('checkDownloadReminders', () => {
        it('should find and notify users without desktop app', async () => {
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', desktop_app_version: null }
            ];
            
            mockSupabase.is.mockResolvedValue({ data: mockUsers, error: null });

            // Mock admin digest methods
            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');

            await pollingService.checkDownloadReminders();

            expect(notificationService.sendDownloadReminder).toHaveBeenCalledWith(
                'user-1',
                'org-1',
                'Windows'
            );
        });

        it('should handle missing supabase client', async () => {
            getClient.mockReturnValue(null);

            await pollingService.checkDownloadReminders();

            expect(notificationService.sendDownloadReminder).not.toHaveBeenCalled();
        });

        it('should send admin download digests', async () => {
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', display_name: 'User 1' }
            ];
            
            mockSupabase.is.mockResolvedValue({ data: mockUsers, error: null });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([{ id: 'admin1' }]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');

            await pollingService.checkDownloadReminders();

            expect(notificationService.sendAdminDownloadDigest).toHaveBeenCalled();
        });

        it('should handle database error gracefully', async () => {
            mockSupabase.is.mockResolvedValue({ data: null, error: new Error('DB Error') });

            // Should not throw
            await pollingService.checkDownloadReminders();

            expect(notificationService.sendDownloadReminder).not.toHaveBeenCalled();
        });
    });

    describe('checkNewVersionNotifications', () => {
        it('should find users with outdated versions', async () => {
            const latestRelease = {
                version: '2.0.0',
                download_url: 'https://example.com/download',
                release_notes: 'New features',
                is_mandatory: false
            };
            
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', desktop_app_version: '1.0.0' }
            ];

            mockSupabase.single.mockResolvedValue({ data: latestRelease, error: null });
            mockSupabase.neq.mockResolvedValue({ data: mockUsers, error: null });

            await pollingService.checkNewVersionNotifications();

            expect(notificationService.sendNewVersionNotification).toHaveBeenCalled();
        });

        it('should skip if no latest release found', async () => {
            mockSupabase.single.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });

            await pollingService.checkNewVersionNotifications();

            expect(notificationService.sendNewVersionNotification).not.toHaveBeenCalled();
        });

        it('should not notify users with newer versions', async () => {
            const latestRelease = { version: '2.0.0' };
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', desktop_app_version: '3.0.0' }
            ];

            mockSupabase.single.mockResolvedValue({ data: latestRelease, error: null });
            mockSupabase.neq.mockResolvedValue({ data: mockUsers, error: null });

            await pollingService.checkNewVersionNotifications();

            // Should not send because 3.0.0 is not older than 2.0.0
            expect(notificationService.sendNewVersionNotification).not.toHaveBeenCalled();
        });

        it('should handle missing supabase client', async () => {
            getClient.mockReturnValue(null);

            await pollingService.checkNewVersionNotifications();

            expect(notificationService.sendNewVersionNotification).not.toHaveBeenCalled();
        });

        it('should handle database error gracefully', async () => {
            mockSupabase.single.mockResolvedValue({ data: { version: '2.0.0' }, error: null });
            mockSupabase.neq.mockResolvedValue({ data: null, error: new Error('Query failed') });

            // Should not throw
            await pollingService.checkNewVersionNotifications();

            expect(notificationService.sendNewVersionNotification).not.toHaveBeenCalled();
        });
    });

    describe('checkInactivityAlerts', () => {
        beforeEach(() => {
            // Mock current time to be within work hours
            jest.setSystemTime(new Date('2025-02-25T14:00:00Z')); // Tuesday 2pm UTC
        });

        it('should find and alert inactive users', async () => {
            const oldTime = new Date('2025-02-25T09:00:00Z').toISOString();
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', desktop_last_heartbeat: oldTime }
            ];
            
            // Setup mock to handle the full chain for both queries including double .not() chain
            mockSupabase.from.mockImplementation((table) => {
                if (table === 'users') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        eq: jest.fn().mockReturnThis(),
                        not: jest.fn().mockImplementation(() => ({
                            not: jest.fn().mockResolvedValue({ data: mockUsers, error: null })
                        }))
                    };
                }
                if (table === 'activity_records') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        in: jest.fn().mockReturnThis(),
                        gt: jest.fn().mockResolvedValue({ data: [], error: null })
                    };
                }
                return mockSupabase;
            });

            // Mock admin methods
            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');

            await pollingService.checkInactivityAlerts();

            expect(notificationService.sendInactivityAlert).toHaveBeenCalled();
        });

        it('should skip users outside work hours', async () => {
            const oldTime = new Date('2025-02-25T09:00:00Z').toISOString();
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', desktop_last_heartbeat: oldTime }
            ];
            
            mockSupabase.from.mockImplementation((table) => {
                if (table === 'users') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        eq: jest.fn().mockReturnThis(),
                        not: jest.fn().mockImplementation(() => ({
                            not: jest.fn().mockResolvedValue({ data: mockUsers, error: null })
                        }))
                    };
                }
                if (table === 'activity_records') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        in: jest.fn().mockReturnThis(),
                        gt: jest.fn().mockResolvedValue({ data: [], error: null })
                    };
                }
                return mockSupabase;
            });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test');
            
            // Mock preferences with opposite work hours
            notificationDb.getUserPreferences.mockResolvedValue({
                work_hours_start: '20:00:00',
                work_hours_end: '23:00:00',
                work_days: [1, 2, 3, 4, 5],
                timezone: 'UTC'
            });

            await pollingService.checkInactivityAlerts();

            expect(notificationService.sendInactivityAlert).not.toHaveBeenCalled();
        });

        it('should skip users on non-work days', async () => {
            // Set to Sunday
            jest.setSystemTime(new Date('2025-02-23T14:00:00Z'));
            
            const oldTime = new Date('2025-02-23T09:00:00Z').toISOString();
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', desktop_last_heartbeat: oldTime }
            ];
            
            mockSupabase.from.mockImplementation((table) => {
                if (table === 'users') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        eq: jest.fn().mockReturnThis(),
                        not: jest.fn().mockImplementation(() => ({
                            not: jest.fn().mockResolvedValue({ data: mockUsers, error: null })
                        }))
                    };
                }
                if (table === 'activity_records') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        in: jest.fn().mockReturnThis(),
                        gt: jest.fn().mockResolvedValue({ data: [], error: null })
                    };
                }
                return mockSupabase;
            });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test');

            await pollingService.checkInactivityAlerts();

            expect(notificationService.sendInactivityAlert).not.toHaveBeenCalled();
        });

        it('should handle no logged-in users', async () => {
            mockSupabase.from.mockImplementation((table) => {
                if (table === 'users') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        eq: jest.fn().mockReturnThis(),
                        not: jest.fn().mockImplementation(() => ({
                            not: jest.fn().mockResolvedValue({ data: [], error: null })
                        }))
                    };
                }
                return mockSupabase;
            });

            await pollingService.checkInactivityAlerts();

            expect(notificationService.sendInactivityAlert).not.toHaveBeenCalled();
        });

        it('should handle missing supabase client', async () => {
            getClient.mockReturnValue(null);

            await pollingService.checkInactivityAlerts();

            expect(notificationService.sendInactivityAlert).not.toHaveBeenCalled();
        });

        it('should skip users with recent activity', async () => {
            const oldTime = new Date('2025-02-25T09:00:00Z').toISOString();
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', desktop_last_heartbeat: oldTime }
            ];
            
            mockSupabase.from.mockImplementation((table) => {
                if (table === 'users') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        eq: jest.fn().mockReturnThis(),
                        not: jest.fn().mockImplementation(() => ({
                            not: jest.fn().mockResolvedValue({ data: mockUsers, error: null })
                        }))
                    };
                }
                if (table === 'activity_records') {
                    // User has recent activity
                    return {
                        select: jest.fn().mockReturnThis(),
                        in: jest.fn().mockReturnThis(),
                        gt: jest.fn().mockResolvedValue({ 
                            data: [{ user_id: 'user-1', batch_end: new Date().toISOString() }], 
                            error: null 
                        })
                    };
                }
                return mockSupabase;
            });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test');

            await pollingService.checkInactivityAlerts();

            // User has recent activity, so no alert
            expect(notificationService.sendInactivityAlert).not.toHaveBeenCalled();
        });

        it('should send admin inactivity digests', async () => {
            const oldTime = new Date('2025-02-25T09:00:00Z').toISOString();
            const mockUsers = [
                { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', desktop_last_heartbeat: oldTime, display_name: 'User 1' }
            ];
            
            mockSupabase.from.mockImplementation((table) => {
                if (table === 'users') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        eq: jest.fn().mockReturnThis(),
                        not: jest.fn().mockImplementation(() => ({
                            not: jest.fn().mockResolvedValue({ data: mockUsers, error: null })
                        }))
                    };
                }
                if (table === 'activity_records') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        in: jest.fn().mockReturnThis(),
                        gt: jest.fn().mockResolvedValue({ data: [], error: null })
                    };
                }
                return mockSupabase;
            });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([{ id: 'admin1' }]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');

            await pollingService.checkInactivityAlerts();

            expect(notificationService.sendAdminInactivityDigest).toHaveBeenCalled();
        });

        it('should handle database error gracefully', async () => {
            mockSupabase.from.mockImplementation((table) => {
                if (table === 'users') {
                    return {
                        select: jest.fn().mockReturnThis(),
                        eq: jest.fn().mockReturnThis(),
                        not: jest.fn().mockImplementation(() => ({
                            not: jest.fn().mockResolvedValue({ data: null, error: new Error('DB Error') })
                        }))
                    };
                }
                return mockSupabase;
            });

            // Should not throw
            await pollingService.checkInactivityAlerts();

            expect(notificationService.sendInactivityAlert).not.toHaveBeenCalled();
        });
    });

    describe('_isVersionOlder', () => {
        it('should correctly compare versions', () => {
            expect(pollingService._isVersionOlder('1.0.0', '2.0.0')).toBe(true);
            expect(pollingService._isVersionOlder('2.0.0', '1.0.0')).toBe(false);
            expect(pollingService._isVersionOlder('1.5.0', '1.5.0')).toBe(false);
            expect(pollingService._isVersionOlder('1.0.0', '1.0.1')).toBe(true);
            expect(pollingService._isVersionOlder('1.9.9', '1.10.0')).toBe(true);
        });

        it('should handle versions with prefixes', () => {
            expect(pollingService._isVersionOlder('v1.0.0', 'v2.0.0')).toBe(true);
        });

        it('should handle null/undefined versions', () => {
            expect(pollingService._isVersionOlder(null, '2.0.0')).toBe(false);
            expect(pollingService._isVersionOlder('1.0.0', null)).toBe(false);
            expect(pollingService._isVersionOlder(null, null)).toBe(false);
        });

        it('should handle versions with different part counts', () => {
            expect(pollingService._isVersionOlder('1.0', '1.0.1')).toBe(true);
            expect(pollingService._isVersionOlder('1.0.0', '1.1')).toBe(true);
        });
    });

    describe('_isWithinWorkHours', () => {
        beforeEach(() => {
            jest.setSystemTime(new Date('2025-02-25T14:00:00Z')); // Tuesday 2pm UTC
        });

        it('should return true when within work hours', async () => {
            notificationDb.getUserPreferences.mockResolvedValue({
                work_hours_start: '09:00:00',
                work_hours_end: '18:00:00',
                work_days: [1, 2, 3, 4, 5],
                timezone: 'UTC'
            });

            const result = await pollingService._isWithinWorkHours('user-1');
            expect(result).toBe(true);
        });

        it('should return false when outside work hours', async () => {
            notificationDb.getUserPreferences.mockResolvedValue({
                work_hours_start: '09:00:00',
                work_hours_end: '12:00:00',
                work_days: [1, 2, 3, 4, 5],
                timezone: 'UTC'
            });

            const result = await pollingService._isWithinWorkHours('user-1');
            expect(result).toBe(false);
        });

        it('should return true with default preferences', async () => {
            notificationDb.getUserPreferences.mockResolvedValue(null);

            const result = await pollingService._isWithinWorkHours('user-1');
            expect(result).toBe(true);
        });

        it('should handle different timezones', async () => {
            notificationDb.getUserPreferences.mockResolvedValue({
                work_hours_start: '09:00:00',
                work_hours_end: '18:00:00',
                work_days: [1, 2, 3, 4, 5],
                timezone: 'America/New_York' // UTC-5, so 14:00 UTC = 09:00 EST
            });

            const result = await pollingService._isWithinWorkHours('user-1');
            expect(result).toBe(true);
        });

        it('should return true on errors', async () => {
            notificationDb.getUserPreferences.mockRejectedValue(new Error('DB error'));

            const result = await pollingService._isWithinWorkHours('user-1');
            expect(result).toBe(true);
        });
    });

    describe('runSingleCheck', () => {
        it('should run login reminder check', async () => {
            mockSupabase.or.mockResolvedValue({ data: [], error: null });

            await pollingService.runSingleCheck('login_reminder');

            expect(mockSupabase.from).toHaveBeenCalledWith('users');
        });

        it('should run download reminder check', async () => {
            mockSupabase.is.mockResolvedValue({ data: [], error: null });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test');

            await pollingService.runSingleCheck('download_reminder');

            expect(mockSupabase.from).toHaveBeenCalledWith('users');
        });

        it('should run new version check', async () => {
            mockSupabase.single.mockResolvedValue({ data: null, error: null });

            await pollingService.runSingleCheck('new_version');

            expect(mockSupabase.from).toHaveBeenCalledWith('app_releases');
        });

        it('should run inactivity alert check', async () => {
            mockSupabase.not.mockResolvedValue({ data: [], error: null });

            await pollingService.runSingleCheck('inactivity_alert');

            expect(mockSupabase.from).toHaveBeenCalledWith('users');
        });

        it('should throw for unknown check type', async () => {
            await expect(
                pollingService.runSingleCheck('unknown_type')
            ).rejects.toThrow('Unknown check type');
        });
    });

    describe('runAllChecks', () => {
        it('should run all checks in parallel', async () => {
            mockSupabase.or.mockResolvedValue({ data: [], error: null });
            mockSupabase.is.mockResolvedValue({ data: [], error: null });
            mockSupabase.single.mockResolvedValue({ data: null, error: null });
            mockSupabase.not.mockResolvedValue({ data: [], error: null });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test');

            await pollingService.runAllChecks();

            expect(pollingService.stats.runsCompleted).toBe(1);
        });

        it('should track errors', async () => {
            // Force an error in one check
            const originalCheckLogin = pollingService.checkLoginReminders;
            pollingService.checkLoginReminders = jest.fn().mockRejectedValue(new Error('Test error'));
            mockSupabase.is.mockResolvedValue({ data: [], error: null });
            mockSupabase.single.mockResolvedValue({ data: null, error: null });
            mockSupabase.not.mockResolvedValue({ data: [], error: null });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test');

            await pollingService.runAllChecks();

            // Restore original
            pollingService.checkLoginReminders = originalCheckLogin;
        });

        it('should update lastRunTime', async () => {
            mockSupabase.or.mockResolvedValue({ data: [], error: null });
            mockSupabase.is.mockResolvedValue({ data: [], error: null });
            mockSupabase.single.mockResolvedValue({ data: null, error: null });
            mockSupabase.not.mockResolvedValue({ data: [], error: null });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test');

            await pollingService.runAllChecks();

            expect(pollingService.lastRunTime).toBeDefined();
        });

        it('should record errors in stats.lastErrors', async () => {
            // Clear previous errors
            pollingService.stats.lastErrors = [];

            // Mock to throw in the outer try/catch
            const originalRunAllChecks = pollingService.runAllChecks.bind(pollingService);
            
            // Throw an error by mocking Promise.allSettled to throw
            const originalAllSettled = Promise.allSettled;
            Promise.allSettled = jest.fn().mockRejectedValue(new Error('Critical error'));

            await pollingService.runAllChecks();

            // Restore
            Promise.allSettled = originalAllSettled;

            expect(pollingService.stats.lastErrors.length).toBeGreaterThan(0);
            expect(pollingService.stats.lastErrors[0].error).toBe('Critical error');
        });

        it('should limit lastErrors to 10 entries', async () => {
            pollingService.stats.lastErrors = Array.from({ length: 10 }, (_, i) => ({
                time: new Date().toISOString(),
                error: `Error ${i}`
            }));

            const originalAllSettled = Promise.allSettled;
            Promise.allSettled = jest.fn().mockRejectedValue(new Error('New error'));

            await pollingService.runAllChecks();

            Promise.allSettled = originalAllSettled;

            expect(pollingService.stats.lastErrors.length).toBe(10);
            expect(pollingService.stats.lastErrors[9].error).toBe('New error');
        });
    });

    describe('Helper Functions', () => {
        describe('_queryUsersForLoginReminders', () => {
            it('should query users eligible for login reminders', async () => {
                const cutoffDate = new Date('2025-02-18T00:00:00Z');
                const mockUsers = [
                    { id: 'user1', organization_id: 'org1', email: 'user1@test.com' }
                ];

                mockSupabase.or.mockResolvedValue({ data: mockUsers, error: null });

                const result = await pollingService._queryUsersForLoginReminders(mockSupabase, cutoffDate);

                expect(result).toEqual(mockUsers);
                expect(mockSupabase.eq).toHaveBeenCalledWith('is_active', true);
                expect(mockSupabase.eq).toHaveBeenCalledWith('desktop_logged_in', false);
            });

            it('should handle database errors', async () => {
                const cutoffDate = new Date();
                mockSupabase.or.mockResolvedValue({ data: null, error: new Error('DB error') });

                await expect(
                    pollingService._queryUsersForLoginReminders(mockSupabase, cutoffDate)
                ).rejects.toThrow('DB error');
            });

            it('should return empty array if no data', async () => {
                const cutoffDate = new Date();
                mockSupabase.or.mockResolvedValue({ data: null, error: null });

                const result = await pollingService._queryUsersForLoginReminders(mockSupabase, cutoffDate);

                expect(result).toEqual([]);
            });
        });

        describe('_sendLoginReminderToUser', () => {
            it('should send login reminder successfully', async () => {
                const user = {
                    id: 'user1',
                    organization_id: 'org1',
                    desktop_last_heartbeat: '2025-01-15T10:00:00Z'
                };

                notificationService.sendLoginReminder.mockResolvedValue({ success: true });

                const result = await pollingService._sendLoginReminderToUser(user);

                expect(result).toBe(true);
                expect(notificationService.sendLoginReminder).toHaveBeenCalledWith(
                    'user1',
                    'org1',
                    expect.objectContaining({
                        lastLoginDate: expect.any(String)
                    })
                );
            });

            it('should handle null desktop_last_heartbeat', async () => {
                const user = {
                    id: 'user1',
                    organization_id: 'org1',
                    desktop_last_heartbeat: null
                };

                notificationService.sendLoginReminder.mockResolvedValue({ success: true });

                const result = await pollingService._sendLoginReminderToUser(user);

                expect(result).toBe(true);
                expect(notificationService.sendLoginReminder).toHaveBeenCalledWith(
                    'user1',
                    'org1',
                    expect.objectContaining({
                        lastLoginDate: null
                    })
                );
            });

            it('should return false on send failure', async () => {
                const user = { id: 'user1', organization_id: 'org1' };

                notificationService.sendLoginReminder.mockRejectedValue(new Error('Send failed'));

                const result = await pollingService._sendLoginReminderToUser(user);

                expect(result).toBe(false);
            });
        });

        describe('_queryUsersForDownloadReminders', () => {
            it('should query users without desktop app', async () => {
                const mockUsers = [
                    { id: 'user1', organization_id: 'org1', desktop_app_version: null }
                ];

                mockSupabase.is.mockResolvedValue({ data: mockUsers, error: null });

                const result = await pollingService._queryUsersForDownloadReminders(mockSupabase);

                expect(result).toEqual(mockUsers);
                expect(mockSupabase.is).toHaveBeenCalledWith('desktop_app_version', null);
            });

            it('should handle errors', async () => {
                mockSupabase.is.mockResolvedValue({ data: null, error: new Error('Query failed') });

                await expect(
                    pollingService._queryUsersForDownloadReminders(mockSupabase)
                ).rejects.toThrow('Query failed');
            });
        });

        describe('_sendDownloadReminderToUser', () => {
            it('should send download reminder successfully', async () => {
                const user = { id: 'user1', organization_id: 'org1' };

                notificationService.sendDownloadReminder.mockResolvedValue({ success: true });

                const result = await pollingService._sendDownloadReminderToUser(user);

                expect(result).toBe(true);
                expect(notificationService.sendDownloadReminder).toHaveBeenCalledWith(
                    'user1',
                    'org1',
                    'Windows'
                );
            });

            it('should return false on failure', async () => {
                const user = { id: 'user1', organization_id: 'org1' };

                notificationService.sendDownloadReminder.mockRejectedValue(new Error('Failed'));

                const result = await pollingService._sendDownloadReminderToUser(user);

                expect(result).toBe(false);
            });
        });

        describe('_groupUsersByOrganization', () => {
            it('should group users by organization_id', () => {
                const users = [
                    { id: 'user1', organization_id: 'org1', email: 'u1@test.com' },
                    { id: 'user2', organization_id: 'org2', email: 'u2@test.com' },
                    { id: 'user3', organization_id: 'org1', email: 'u3@test.com' }
                ];

                const result = pollingService._groupUsersByOrganization(users);

                expect(result).toEqual({
                    org1: [users[0], users[2]],
                    org2: [users[1]]
                });
            });

            it('should handle empty array', () => {
                const result = pollingService._groupUsersByOrganization([]);

                expect(result).toEqual({});
            });

            it('should handle single organization', () => {
                const users = [
                    { id: 'user1', organization_id: 'org1' },
                    { id: 'user2', organization_id: 'org1' }
                ];

                const result = pollingService._groupUsersByOrganization(users);

                expect(result).toEqual({
                    org1: users
                });
            });
        });

        describe('_getLatestAppRelease', () => {
            it('should get latest app release', async () => {
                const mockRelease = {
                    version: '2.0.0',
                    download_url: 'https://example.com/download',
                    release_notes: 'New version',
                    is_mandatory: false
                };

                mockSupabase.single.mockResolvedValue({ data: mockRelease, error: null });

                const result = await pollingService._getLatestAppRelease(mockSupabase);

                expect(result).toEqual(mockRelease);
                expect(mockSupabase.eq).toHaveBeenCalledWith('platform', 'windows');
                expect(mockSupabase.eq).toHaveBeenCalledWith('is_latest', true);
                expect(mockSupabase.eq).toHaveBeenCalledWith('is_active', true);
            });

            it('should return null on error', async () => {
                mockSupabase.single.mockResolvedValue({ data: null, error: new Error('Not found') });

                const result = await pollingService._getLatestAppRelease(mockSupabase);

                expect(result).toBeNull();
            });
        });

        describe('_queryUsersWithOutdatedVersion', () => {
            it('should query users with outdated versions', async () => {
                const mockUsers = [
                    { id: 'user1', desktop_app_version: '1.0.0' }
                ];

                mockSupabase.neq.mockResolvedValue({ data: mockUsers, error: null });

                const result = await pollingService._queryUsersWithOutdatedVersion(mockSupabase, '2.0.0');

                expect(result).toEqual(mockUsers);
                expect(mockSupabase.neq).toHaveBeenCalledWith('desktop_app_version', '2.0.0');
            });

            it('should handle errors', async () => {
                mockSupabase.neq.mockResolvedValue({ data: null, error: new Error('Query failed') });

                await expect(
                    pollingService._queryUsersWithOutdatedVersion(mockSupabase, '2.0.0')
                ).rejects.toThrow('Query failed');
            });
        });

        describe('_sendVersionNotificationToUser', () => {
            it('should send notification for older version', async () => {
                const user = {
                    id: 'user1',
                    organization_id: 'org1',
                    desktop_app_version: '1.0.0'
                };

                const releaseInfo = {
                    version: '2.0.0',
                    download_url: 'https://example.com/download',
                    release_notes: 'New features',
                    is_mandatory: false
                };

                notificationService.sendNewVersionNotification.mockResolvedValue({ success: true });

                const result = await pollingService._sendVersionNotificationToUser(user, releaseInfo);

                expect(result).toBe(true);
                expect(notificationService.sendNewVersionNotification).toHaveBeenCalled();
            });

            it('should not send notification if version is newer', async () => {
                const user = {
                    id: 'user1',
                    organization_id: 'org1',
                    desktop_app_version: '3.0.0'
                };

                const releaseInfo = {
                    version: '2.0.0'
                };

                const result = await pollingService._sendVersionNotificationToUser(user, releaseInfo);

                expect(result).toBe(false);
                expect(notificationService.sendNewVersionNotification).not.toHaveBeenCalled();
            });

            it('should return false on send failure', async () => {
                const user = {
                    id: 'user1',
                    organization_id: 'org1',
                    desktop_app_version: '1.0.0'
                };

                const releaseInfo = {
                    version: '2.0.0',
                    download_url: 'https://example.com',
                    release_notes: 'Notes',
                    is_mandatory: false
                };

                notificationService.sendNewVersionNotification.mockRejectedValue(new Error('Failed'));

                const result = await pollingService._sendVersionNotificationToUser(user, releaseInfo);

                expect(result).toBe(false);
            });
        });

        describe('_parseVersion', () => {
            it('should parse version correctly', () => {
                expect(pollingService._parseVersion('1.2.3')).toEqual([1, 2, 3]);
                expect(pollingService._parseVersion('v2.0.1')).toEqual([2, 0, 1]);
                expect(pollingService._parseVersion('10.5.0')).toEqual([10, 5, 0]);
            });

            it('should handle versions with different part counts', () => {
                expect(pollingService._parseVersion('1.0')).toEqual([1, 0]);
                expect(pollingService._parseVersion('5')).toEqual([5]);
            });

            it('should handle empty string', () => {
                expect(pollingService._parseVersion('')).toEqual([0]);
            });
        });

        describe('_queryLoggedInUsers', () => {
            it('should query logged-in users', async () => {
                const mockUsers = [
                    { id: 'user1', organization_id: 'org1', desktop_last_heartbeat: '2025-02-25T10:00:00Z' }
                ];

                // Create proper mock chain
                const mockChain = {
                    select: jest.fn().mockReturnThis(),
                    eq: jest.fn().mockReturnThis(),
                    not: jest.fn().mockImplementation(() => ({
                        not: jest.fn().mockResolvedValue({ data: mockUsers, error: null })
                    }))
                };
                const localMockSupabase = { from: jest.fn().mockReturnValue(mockChain) };

                const result = await pollingService._queryLoggedInUsers(localMockSupabase);

                expect(result).toEqual(mockUsers);
            });

            it('should throw on error', async () => {
                const mockChain = {
                    select: jest.fn().mockReturnThis(),
                    eq: jest.fn().mockReturnThis(),
                    not: jest.fn().mockImplementation(() => ({
                        not: jest.fn().mockResolvedValue({ data: null, error: new Error('Query failed') })
                    }))
                };
                const localMockSupabase = { from: jest.fn().mockReturnValue(mockChain) };

                await expect(pollingService._queryLoggedInUsers(localMockSupabase)).rejects.toThrow('Query failed');
            });

            it('should return empty array when data is null', async () => {
                const mockChain = {
                    select: jest.fn().mockReturnThis(),
                    eq: jest.fn().mockReturnThis(),
                    not: jest.fn().mockImplementation(() => ({
                        not: jest.fn().mockResolvedValue({ data: null, error: null })
                    }))
                };
                const localMockSupabase = { from: jest.fn().mockReturnValue(mockChain) };

                const result = await pollingService._queryLoggedInUsers(localMockSupabase);

                expect(result).toEqual([]);
            });
        });

        describe('_fetchRecentActivity', () => {
            it('should fetch recent activity for users', async () => {
                const userIds = ['user1', 'user2'];
                const thresholdTime = new Date('2025-02-25T10:00:00Z');
                const mockActivity = [
                    { user_id: 'user1', batch_end: '2025-02-25T11:00:00Z' },
                    { user_id: 'user1', batch_end: '2025-02-25T12:00:00Z' }
                ];

                const mockChain = {
                    select: jest.fn().mockReturnThis(),
                    in: jest.fn().mockReturnThis(),
                    gt: jest.fn().mockResolvedValue({ data: mockActivity, error: null })
                };
                const localMockSupabase = { from: jest.fn().mockReturnValue(mockChain) };

                const result = await pollingService._fetchRecentActivity(localMockSupabase, userIds, thresholdTime);

                expect(result.usersWithRecentActivity.has('user1')).toBe(true);
                expect(result.latestBatchByUser['user1']).toBe('2025-02-25T12:00:00Z');
            });

            it('should throw on error', async () => {
                const mockChain = {
                    select: jest.fn().mockReturnThis(),
                    in: jest.fn().mockReturnThis(),
                    gt: jest.fn().mockResolvedValue({ data: null, error: new Error('Failed') })
                };
                const localMockSupabase = { from: jest.fn().mockReturnValue(mockChain) };

                await expect(
                    pollingService._fetchRecentActivity(localMockSupabase, ['user1'], new Date())
                ).rejects.toThrow('Failed');
            });

            it('should handle empty activity list', async () => {
                const mockChain = {
                    select: jest.fn().mockReturnThis(),
                    in: jest.fn().mockReturnThis(),
                    gt: jest.fn().mockResolvedValue({ data: [], error: null })
                };
                const localMockSupabase = { from: jest.fn().mockReturnValue(mockChain) };

                const result = await pollingService._fetchRecentActivity(localMockSupabase, ['user1'], new Date());

                expect(result.usersWithRecentActivity.size).toBe(0);
                expect(Object.keys(result.latestBatchByUser)).toHaveLength(0);
            });
        });

        describe('_isUserInactive', () => {
            it('should return true when heartbeat is old and no recent activity', () => {
                const user = { id: 'user1', desktop_last_heartbeat: '2025-02-25T08:00:00Z' };
                const thresholdTime = new Date('2025-02-25T10:00:00Z');
                const usersWithRecentActivity = new Set();

                const result = pollingService._isUserInactive(user, thresholdTime, usersWithRecentActivity);

                expect(result).toBe(true);
            });

            it('should return false when heartbeat is recent', () => {
                const user = { id: 'user1', desktop_last_heartbeat: '2025-02-25T11:00:00Z' };
                const thresholdTime = new Date('2025-02-25T10:00:00Z');
                const usersWithRecentActivity = new Set();

                const result = pollingService._isUserInactive(user, thresholdTime, usersWithRecentActivity);

                expect(result).toBe(false);
            });

            it('should return false when user has recent activity', () => {
                const user = { id: 'user1', desktop_last_heartbeat: '2025-02-25T08:00:00Z' };
                const thresholdTime = new Date('2025-02-25T10:00:00Z');
                const usersWithRecentActivity = new Set(['user1']);

                const result = pollingService._isUserInactive(user, thresholdTime, usersWithRecentActivity);

                expect(result).toBe(false);
            });
        });

        describe('_getEffectiveLastActive', () => {
            it('should return heartbeat time when no batch time', () => {
                const user = { id: 'user1', desktop_last_heartbeat: '2025-02-25T10:00:00Z' };
                const latestBatchByUser = {};

                const result = pollingService._getEffectiveLastActive(user, latestBatchByUser);

                expect(result.toISOString()).toBe('2025-02-25T10:00:00.000Z');
            });

            it('should return batch time when it is later than heartbeat', () => {
                const user = { id: 'user1', desktop_last_heartbeat: '2025-02-25T10:00:00Z' };
                const latestBatchByUser = { user1: '2025-02-25T12:00:00Z' };

                const result = pollingService._getEffectiveLastActive(user, latestBatchByUser);

                expect(result.toISOString()).toBe('2025-02-25T12:00:00.000Z');
            });

            it('should return heartbeat time when it is later than batch', () => {
                const user = { id: 'user1', desktop_last_heartbeat: '2025-02-25T14:00:00Z' };
                const latestBatchByUser = { user1: '2025-02-25T12:00:00Z' };

                const result = pollingService._getEffectiveLastActive(user, latestBatchByUser);

                expect(result.toISOString()).toBe('2025-02-25T14:00:00.000Z');
            });
        });

        describe('_calculateHoursInactive', () => {
            beforeEach(() => {
                jest.setSystemTime(new Date('2025-02-25T14:00:00Z'));
            });

            it('should calculate hours inactive correctly', () => {
                const lastActive = new Date('2025-02-25T10:00:00Z');

                const result = pollingService._calculateHoursInactive(lastActive);

                expect(result).toBe(4);
            });

            it('should round to one decimal place', () => {
                const lastActive = new Date('2025-02-25T12:30:00Z');

                const result = pollingService._calculateHoursInactive(lastActive);

                expect(result).toBe(1.5);
            });
        });

        describe('_sendInactivityAlertToUser', () => {
            beforeEach(() => {
                jest.setSystemTime(new Date('2025-02-25T14:00:00Z'));
            });

            it('should send inactivity alert successfully', async () => {
                const user = {
                    id: 'user1',
                    organization_id: 'org1',
                    desktop_last_heartbeat: '2025-02-25T10:00:00Z'
                };
                const latestBatchByUser = {};

                notificationDb.getUserPreferences.mockResolvedValue({
                    work_hours_start: '09:00:00',
                    work_hours_end: '18:00:00',
                    work_days: [1, 2, 3, 4, 5],
                    timezone: 'UTC'
                });

                const result = await pollingService._sendInactivityAlertToUser(user, latestBatchByUser);

                expect(result).toBe(true);
                expect(notificationService.sendInactivityAlert).toHaveBeenCalled();
            });

            it('should return false when outside work hours', async () => {
                const user = {
                    id: 'user1',
                    organization_id: 'org1',
                    desktop_last_heartbeat: '2025-02-25T10:00:00Z'
                };

                notificationDb.getUserPreferences.mockResolvedValue({
                    work_hours_start: '20:00:00',
                    work_hours_end: '23:00:00',
                    work_days: [1, 2, 3, 4, 5],
                    timezone: 'UTC'
                });

                const result = await pollingService._sendInactivityAlertToUser(user, {});

                expect(result).toBe(false);
            });

            it('should return false on send error', async () => {
                const user = {
                    id: 'user1',
                    organization_id: 'org1',
                    desktop_last_heartbeat: '2025-02-25T10:00:00Z'
                };

                notificationService.sendInactivityAlert.mockRejectedValue(new Error('Send failed'));

                const result = await pollingService._sendInactivityAlertToUser(user, {});

                expect(result).toBe(false);
            });
        });

        describe('_prepareDigestUserData', () => {
            beforeEach(() => {
                jest.setSystemTime(new Date('2025-02-25T14:00:00Z'));
            });

            it('should prepare digest user data with display_name', () => {
                const user = {
                    id: 'user1',
                    display_name: 'John Doe',
                    email: 'john@test.com',
                    desktop_last_heartbeat: '2025-02-25T10:00:00Z'
                };
                const latestBatchByUser = {};

                const result = pollingService._prepareDigestUserData(user, latestBatchByUser);

                expect(result.name).toBe('John Doe');
                expect(result.hoursInactive).toBe(4);
                expect(result.lastActivity).toBeDefined();
            });

            it('should use email when display_name is not available', () => {
                const user = {
                    id: 'user1',
                    display_name: null,
                    email: 'john@test.com',
                    desktop_last_heartbeat: '2025-02-25T10:00:00Z'
                };

                const result = pollingService._prepareDigestUserData(user, {});

                expect(result.name).toBe('john@test.com');
            });
        });

        describe('_sendAdminDownloadDigestForOrg', () => {
            it('should send admin download digest successfully', async () => {
                const orgUsers = [
                    { display_name: 'User 1', email: 'user1@test.com' }
                ];

                // Mock _getOrgAdmins and _getOrgName
                pollingService._getOrgAdmins = jest.fn().mockResolvedValue([
                    { id: 'admin1', email: 'admin@test.com' }
                ]);
                pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');

                const result = await pollingService._sendAdminDownloadDigestForOrg('org1', orgUsers);

                expect(result).toBe(1);
                expect(notificationService.sendAdminDownloadDigest).toHaveBeenCalled();
            });

            it('should return 0 when no admins found', async () => {
                pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
                pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');

                const result = await pollingService._sendAdminDownloadDigestForOrg('org1', []);

                expect(result).toBe(0);
            });

            it('should handle send failures gracefully', async () => {
                const orgUsers = [{ display_name: 'User', email: 'user@test.com' }];

                pollingService._getOrgAdmins = jest.fn().mockResolvedValue([
                    { id: 'admin1' },
                    { id: 'admin2' }
                ]);
                pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');

                notificationService.sendAdminDownloadDigest
                    .mockRejectedValueOnce(new Error('Failed'))
                    .mockResolvedValueOnce({ success: true });

                const result = await pollingService._sendAdminDownloadDigestForOrg('org1', orgUsers);

                expect(result).toBe(1);
            });
        });

        describe('_sendAdminInactivityDigestForOrg', () => {
            beforeEach(() => {
                jest.setSystemTime(new Date('2025-02-25T14:00:00Z'));
            });

            it('should send admin inactivity digest successfully', async () => {
                const inactiveUsers = [
                    { id: 'user1', display_name: 'User 1', email: 'user1@test.com', desktop_last_heartbeat: '2025-02-25T10:00:00Z' }
                ];
                const latestBatchByUser = {};

                pollingService._getOrgAdmins = jest.fn().mockResolvedValue([
                    { id: 'admin1' }
                ]);
                pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');

                const result = await pollingService._sendAdminInactivityDigestForOrg('org1', inactiveUsers, latestBatchByUser);

                expect(result).toBe(1);
                expect(notificationService.sendAdminInactivityDigest).toHaveBeenCalled();
            });

            it('should handle send failures gracefully', async () => {
                pollingService._getOrgAdmins = jest.fn().mockResolvedValue([{ id: 'admin1' }]);
                pollingService._getOrgName = jest.fn().mockResolvedValue('Test Org');
                notificationService.sendAdminInactivityDigest.mockRejectedValue(new Error('Failed'));

                const result = await pollingService._sendAdminInactivityDigestForOrg(
                    'org1',
                    [{ id: 'user1', desktop_last_heartbeat: '2025-02-25T10:00:00Z' }],
                    {}
                );

                expect(result).toBe(0);
            });
        });

        describe('_deduplicateAdmins', () => {
            it('should deduplicate admin users', () => {
                const data = [
                    { users: { id: 'admin1', email: 'admin1@test.com' } },
                    { users: { id: 'admin1', email: 'admin1@test.com' } },
                    { users: { id: 'admin2', email: 'admin2@test.com' } }
                ];

                const result = pollingService._deduplicateAdmins(data);

                expect(result).toHaveLength(2);
                expect(result.map(a => a.id)).toEqual(['admin1', 'admin2']);
            });

            it('should skip entries without user email', () => {
                const data = [
                    { users: { id: 'admin1', email: null } },
                    { users: { id: 'admin2', email: 'admin2@test.com' } }
                ];

                const result = pollingService._deduplicateAdmins(data);

                expect(result).toHaveLength(1);
                expect(result[0].id).toBe('admin2');
            });

            it('should handle empty data', () => {
                const result = pollingService._deduplicateAdmins([]);

                expect(result).toEqual([]);
            });

            it('should skip entries without users object', () => {
                const data = [
                    { users: null },
                    { users: { id: 'admin1', email: 'admin1@test.com' } }
                ];

                const result = pollingService._deduplicateAdmins(data);

                expect(result).toHaveLength(1);
            });
        });

        describe('_getOrgAdmins', () => {
            it('should fetch org admins successfully', async () => {
                const mockData = [
                    { users: { id: 'admin1', email: 'admin1@test.com', display_name: 'Admin 1' } }
                ];

                mockSupabase.not.mockResolvedValue({ data: mockData, error: null });

                const result = await pollingService._getOrgAdmins('org1');

                expect(result).toHaveLength(1);
                expect(result[0].id).toBe('admin1');
            });

            it('should return empty array when supabase not available', async () => {
                getClient.mockReturnValue(null);

                const result = await pollingService._getOrgAdmins('org1');

                expect(result).toEqual([]);
            });

            it('should return empty array on error', async () => {
                mockSupabase.not.mockResolvedValue({ data: null, error: new Error('Query failed') });

                const result = await pollingService._getOrgAdmins('org1');

                expect(result).toEqual([]);
            });

            it('should handle exception gracefully', async () => {
                mockSupabase.not.mockRejectedValue(new Error('Connection error'));

                const result = await pollingService._getOrgAdmins('org1');

                expect(result).toEqual([]);
            });
        });

        describe('_getOrgName', () => {
            it('should fetch org name successfully', async () => {
                mockSupabase.single.mockResolvedValue({ data: { org_name: 'Test Organization' }, error: null });

                const result = await pollingService._getOrgName('org1');

                expect(result).toBe('Test Organization');
            });

            it('should return default name when supabase not available', async () => {
                getClient.mockReturnValue(null);

                const result = await pollingService._getOrgName('org1');

                expect(result).toBe('Your Organization');
            });

            it('should return default name when org_name is null', async () => {
                mockSupabase.single.mockResolvedValue({ data: { org_name: null }, error: null });

                const result = await pollingService._getOrgName('org1');

                expect(result).toBe('Your Organization');
            });

            it('should handle exception gracefully', async () => {
                mockSupabase.single.mockRejectedValue(new Error('Query failed'));

                const result = await pollingService._getOrgName('org1');

                expect(result).toBe('Your Organization');
            });
        });

        describe('_convertToTimezone', () => {
            it('should convert date to specified timezone', () => {
                const date = new Date('2025-02-25T14:00:00Z');

                const result = pollingService._convertToTimezone(date, 'UTC');

                expect(result instanceof Date).toBe(true);
            });

            it('should return original date on invalid timezone', () => {
                const date = new Date('2025-02-25T14:00:00Z');

                const result = pollingService._convertToTimezone(date, 'Invalid/Timezone');

                expect(result).toEqual(date);
            });
        });

        describe('_parseTimeToMinutes', () => {
            it('should parse time string to minutes', () => {
                expect(pollingService._parseTimeToMinutes('09:00:00')).toBe(540);
                expect(pollingService._parseTimeToMinutes('18:30:00')).toBe(1110);
                expect(pollingService._parseTimeToMinutes('00:00:00')).toBe(0);
            });

            it('should use default for null/undefined', () => {
                expect(pollingService._parseTimeToMinutes(null)).toBe(540); // 09:00
                expect(pollingService._parseTimeToMinutes(undefined)).toBe(540);
            });
        });

        describe('_isWorkDay', () => {
            it('should return true for work days', () => {
                const workDays = [1, 2, 3, 4, 5]; // Mon-Fri
                expect(pollingService._isWorkDay(1, workDays)).toBe(true); // Monday
                expect(pollingService._isWorkDay(5, workDays)).toBe(true); // Friday
            });

            it('should return false for non-work days', () => {
                const workDays = [1, 2, 3, 4, 5];
                expect(pollingService._isWorkDay(6, workDays)).toBe(false); // Saturday
            });

            it('should handle Sunday as 0 or 7', () => {
                const workDays = [7]; // Only Sunday
                expect(pollingService._isWorkDay(0, workDays)).toBe(true);
                expect(pollingService._isWorkDay(7, workDays)).toBe(true);
            });
        });

        describe('_isWithinTimeRange', () => {
            it('should return true when within range', () => {
                const currentMinutes = 600; // 10:00
                expect(pollingService._isWithinTimeRange(currentMinutes, '09:00:00', '18:00:00')).toBe(true);
            });

            it('should return false when outside range', () => {
                const currentMinutes = 1200; // 20:00
                expect(pollingService._isWithinTimeRange(currentMinutes, '09:00:00', '18:00:00')).toBe(false);
            });

            it('should return true at start boundary', () => {
                const currentMinutes = 540; // 09:00
                expect(pollingService._isWithinTimeRange(currentMinutes, '09:00:00', '18:00:00')).toBe(true);
            });

            it('should return true at end boundary', () => {
                const currentMinutes = 1080; // 18:00
                expect(pollingService._isWithinTimeRange(currentMinutes, '09:00:00', '18:00:00')).toBe(true);
            });
        });
    });

    describe('Statistics Tracking', () => {
        it('should increment notification counters', async () => {
            const mockUsers = [{ id: 'user1', organization_id: 'org1', email: 'test@test.com' }];
            mockSupabase.or.mockResolvedValue({ data: mockUsers, error: null });
            notificationService.sendLoginReminder.mockResolvedValue({ success: true });

            await pollingService.checkLoginReminders();

            expect(pollingService.stats.notificationsSent.login_reminder).toBeGreaterThan(0);
        });

        it('should track download reminder stats', async () => {
            const initialCount = pollingService.stats.notificationsSent.download_reminder;
            const mockUsers = [{ id: 'user1', organization_id: 'org1', email: 'test@test.com' }];
            mockSupabase.is.mockResolvedValue({ data: mockUsers, error: null });
            notificationService.sendDownloadReminder.mockResolvedValue({ success: true });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test');

            await pollingService.checkDownloadReminders();

            expect(pollingService.stats.notificationsSent.download_reminder).toBeGreaterThan(initialCount);
        });

        it('should track admin download digest stats', async () => {
            const initialCount = pollingService.stats.notificationsSent.admin_download_digest;
            const mockUsers = [{ id: 'user1', organization_id: 'org1', email: 'test@test.com', display_name: 'User' }];
            mockSupabase.is.mockResolvedValue({ data: mockUsers, error: null });

            pollingService._getOrgAdmins = jest.fn().mockResolvedValue([{ id: 'admin1' }]);
            pollingService._getOrgName = jest.fn().mockResolvedValue('Test');

            await pollingService.checkDownloadReminders();

            expect(pollingService.stats.notificationsSent.admin_download_digest).toBeGreaterThan(initialCount);
        });

        it('should track last errors', async () => {
            pollingService.checkLoginReminders = jest.fn().mockRejectedValue(new Error('Test error'));
            pollingService.checkDownloadReminders = jest.fn().mockResolvedValue();
            pollingService.checkNewVersionNotifications = jest.fn().mockResolvedValue();
            pollingService.checkInactivityAlerts = jest.fn().mockResolvedValue();

            await pollingService.runAllChecks();

            // Stats should still be updated despite errors
            expect(pollingService.stats.runsCompleted).toBeGreaterThan(0);
        });
    });

    describe('Edge Cases', () => {
        it('should handle users with missing organization_id gracefully', async () => {
            const usersWithMissingOrg = [
                { id: 'user1', organization_id: null, email: 'test@test.com' }
            ];

            const grouped = pollingService._groupUsersByOrganization(usersWithMissingOrg);

            expect(grouped).toHaveProperty('null');
            expect(grouped.null).toEqual(usersWithMissingOrg);
        });

        it('should handle concurrent access to stats', async () => {
            mockSupabase.or.mockResolvedValue({ data: [], error: null });
            mockSupabase.is.mockResolvedValue({ data: [], error: null });
            mockSupabase.single.mockResolvedValue({ data: null, error: null });
            mockSupabase.lt.mockResolvedValue({ data: [], error: null });

            // Run multiple checks concurrently
            await Promise.all([
                pollingService.runAllChecks(),
                pollingService.runAllChecks()
            ]);

            expect(pollingService.stats.runsCompleted).toBeGreaterThanOrEqual(2);
        });
    });
});

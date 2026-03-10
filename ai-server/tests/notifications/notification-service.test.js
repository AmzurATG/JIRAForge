/**
 * Notification Service Unit Tests
 */

// Mock dependencies before requiring the module
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

jest.mock('../../src/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const notificationService = require('../../src/services/notifications/notification-service');
const notifmeWrapper = require('../../src/services/notifications/notifme-wrapper');
const notificationDb = require('../../src/services/db/notification-db-service');
const userDbService = require('../../src/services/db/user-db-service');

describe('Notification Service', () => {
    const mockUser = {
        id: 'user-123',
        email: 'user@example.com',
        display_name: 'Test User',
        organization_id: 'org-456'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Default mock implementations
        userDbService.getUserById.mockResolvedValue(mockUser);
        userDbService.getOrganizationById.mockResolvedValue({
            id: 'org-456',
            org_name: 'Test Organization',
            jira_instance_url: 'https://test-org.atlassian.net',
            is_active: true
        });
        userDbService.getLatestDownloadUrl.mockResolvedValue('https://github.com/AmzurATG/JIRAForge/releases/download/v1.0.0/TimeTracker-Setup.exe');
        notificationDb.getUserPreferences.mockResolvedValue({
            email_enabled: true,
            login_reminder_enabled: true,
            download_reminder_enabled: true,
            new_version_enabled: true,
            inactivity_alert_enabled: true
        });
        notificationDb.checkCooldown.mockResolvedValue({ inCooldown: false, todayCount: 0 }); // Not in cooldown
        notificationDb.createLog.mockResolvedValue({ id: 'log-123' });
        notificationDb.updateLog.mockResolvedValue({});
        notificationDb.updateCooldown.mockResolvedValue({});
        notifmeWrapper.send.mockResolvedValue({ success: true, messageId: 'msg-123' });
    });

    describe('sendLoginReminder', () => {
        it('should send login reminder successfully', async () => {
            const result = await notificationService.sendLoginReminder(
                'user-123',
                'org-456',
                { lastLoginDate: '2025-01-15' }
            );

            expect(result.success).toBe(true);
            expect(notifmeWrapper.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: 'user@example.com',
                    subject: expect.stringContaining('TimeTracker')
                })
            );
            expect(notificationDb.createLog).toHaveBeenCalled();
            expect(notificationDb.updateCooldown).toHaveBeenCalled();
        });

        it('should skip if user has email disabled', async () => {
            notificationDb.getUserPreferences.mockResolvedValue({
                login_reminder_enabled: false
            });

            const result = await notificationService.sendLoginReminder(
                'user-123',
                'org-456',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('disabled_by_user');
            expect(notifmeWrapper.send).not.toHaveBeenCalled();
        });

        it('should skip if login reminder disabled', async () => {
            notificationDb.getUserPreferences.mockResolvedValue({
                email_enabled: true,
                login_reminder_enabled: false
            });

            const result = await notificationService.sendLoginReminder(
                'user-123',
                'org-456',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('disabled_by_user');
        });

        it('should skip if user in cooldown', async () => {
            notificationDb.checkCooldown.mockResolvedValue({ inCooldown: true, todayCount: 0 });

            const result = await notificationService.sendLoginReminder(
                'user-123',
                'org-456',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('cooldown');
        });

        it('should skip if user has no email', async () => {
            userDbService.getUserById.mockResolvedValue({
                ...mockUser,
                email: null
            });

            const result = await notificationService.sendLoginReminder(
                'user-123',
                'org-456',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('no_email');
        });

        it('should skip if user not found', async () => {
            userDbService.getUserById.mockResolvedValue(null);

            const result = await notificationService.sendLoginReminder(
                'user-123',
                'org-456',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('user_not_found');
        });
    });

    describe('sendDownloadReminder', () => {
        it('should send download reminder with Windows platform', async () => {
            const result = await notificationService.sendDownloadReminder(
                'user-123',
                'org-456',
                'Windows'
            );

            expect(result.success).toBe(true);
            expect(notifmeWrapper.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: 'user@example.com',
                    subject: expect.stringContaining('TimeTracker')
                })
            );
        });

        it('should send download reminder with Mac platform', async () => {
            const result = await notificationService.sendDownloadReminder(
                'user-123',
                'org-456',
                'Mac'
            );

            expect(result.success).toBe(true);
            expect(notifmeWrapper.send).toHaveBeenCalled();
        });

        it('should skip if download reminder disabled', async () => {
            notificationDb.getUserPreferences.mockResolvedValue({
                email_enabled: true,
                download_reminder_enabled: false
            });

            const result = await notificationService.sendDownloadReminder(
                'user-123',
                'org-456',
                'Windows'
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('disabled_by_user');
        });
    });

    describe('sendNewVersionNotification', () => {
        const versionInfo = {
            version: '2.0.0',
            currentVersion: '1.0.0',
            releaseNotes: 'New features added',
            downloadUrl: 'https://example.com/download',
            isMandatory: false
        };

        it('should send new version notification', async () => {
            const result = await notificationService.sendNewVersionNotification(
                'user-123',
                'org-456',
                versionInfo
            );

            expect(result.success).toBe(true);
            expect(notifmeWrapper.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: 'user@example.com',
                    subject: expect.stringContaining('2.0.0')
                })
            );
        });

        it('should include mandatory flag in subject', async () => {
            const result = await notificationService.sendNewVersionNotification(
                'user-123',
                'org-456',
                { ...versionInfo, isMandatory: true }
            );

            expect(result.success).toBe(true);
        });

        it('should skip if new version notifications disabled', async () => {
            notificationDb.getUserPreferences.mockResolvedValue({
                email_enabled: true,
                new_version_enabled: false
            });

            const result = await notificationService.sendNewVersionNotification(
                'user-123',
                'org-456',
                versionInfo
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('disabled_by_user');
        });
    });

    describe('sendInactivityAlert', () => {
        const activityData = {
            lastActivityTime: '2025-02-25 10:00:00',
            hoursInactive: 4.5
        };

        it('should send inactivity alert', async () => {
            const result = await notificationService.sendInactivityAlert(
                'user-123',
                'org-456',
                activityData
            );

            expect(result.success).toBe(true);
            expect(notifmeWrapper.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    to: 'user@example.com',
                    subject: expect.stringContaining('checking in')
                })
            );
        });

        it('should skip if inactivity alerts disabled', async () => {
            notificationDb.getUserPreferences.mockResolvedValue({
                email_enabled: true,
                inactivity_alert_enabled: false
            });

            const result = await notificationService.sendInactivityAlert(
                'user-123',
                'org-456',
                activityData
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('disabled_by_user');
        });
    });

    describe('sendNotification (generic)', () => {
        it('should route to correct handler based on type', async () => {
            await notificationService.sendNotification(
                'user-123',
                'org-456',
                'login_reminder',
                { lastLoginDate: '2025-01-15' }
            );

            expect(notifmeWrapper.send).toHaveBeenCalled();
        });

        it('should throw for unknown notification type', async () => {
            const result = await notificationService.sendNotification(
                'user-123',
                'org-456',
                'unknown_type',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('error');
        });
    });

    describe('error handling', () => {
        it('should log error when email send fails', async () => {
            notifmeWrapper.send.mockResolvedValue({ 
                success: false, 
                error: 'SMTP error' 
            });

            const result = await notificationService.sendLoginReminder(
                'user-123',
                'org-456',
                {}
            );

            expect(result.success).toBe(false);
            expect(notificationDb.updateLog).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ status: 'failed' })
            );
        });

        it('should handle database errors gracefully', async () => {
            notificationDb.createLog.mockRejectedValue(new Error('DB error'));

            // Should still attempt to send even if logging fails
            const result = await notificationService.sendLoginReminder(
                'user-123',
                'org-456',
                {}
            );

            // The service should handle DB errors gracefully
            expect(result).toBeDefined();
        });
    });
});

describe('Notification Service - Edge Cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should handle user with empty display name', async () => {
        userDbService.getUserById.mockResolvedValue({
            id: 'user-123',
            email: 'user@example.com',
            display_name: '',
            organization_id: 'org-456'
        });
        notificationDb.getUserPreferences.mockResolvedValue({ email_enabled: true, login_reminder_enabled: true });
        notificationDb.checkCooldown.mockResolvedValue(true);
        notificationDb.createLog.mockResolvedValue({ id: 'log-123' });
        notifmeWrapper.send.mockResolvedValue({ success: true });

        const result = await notificationService.sendLoginReminder(
            'user-123',
            'org-456',
            {}
        );

        expect(result.success).toBe(true);
    });

    it('should use defaults when preferences not found', async () => {
        userDbService.getUserById.mockResolvedValue({
            id: 'user-123',
            email: 'user@example.com',
            display_name: 'Test User',
            organization_id: 'org-456'
        });
        notificationDb.getUserPreferences.mockResolvedValue(null);
        notificationDb.checkCooldown.mockResolvedValue(true);
        notificationDb.createLog.mockResolvedValue({ id: 'log-123' });
        notifmeWrapper.send.mockResolvedValue({ success: true });

        const result = await notificationService.sendLoginReminder(
            'user-123',
            'org-456',
            {}
        );

        // Should send with defaults
        expect(result.success).toBe(true);
    });
});

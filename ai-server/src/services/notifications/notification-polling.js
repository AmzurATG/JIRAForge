/**
 * Notification Polling Service
 * 
 * Runs periodic checks for notification triggers:
 * - Login reminders for inactive users
 * - Download reminders for users without the desktop app
 * - New version notifications for users with outdated versions
 * - Inactivity alerts for users who stopped tracking
 */

const notificationService = require('./notification-service');
const notificationDb = require('../db/notification-db-service');
const { getClient } = require('../db/supabase-client');
const logger = require('../../utils/logger');

// Configuration (can be overridden via environment variables)
const POLLING_INTERVAL = Number.parseInt(process.env.NOTIFICATION_POLLING_INTERVAL || '900000', 10); // 15 minutes
const INACTIVITY_THRESHOLD_HOURS = Number.parseFloat(process.env.INACTIVITY_THRESHOLD_HOURS || '4');
const LOGIN_REMINDER_DAYS = Number.parseInt(process.env.LOGIN_REMINDER_DAYS || '7', 10);

class NotificationPollingService {
    intervalId = null;
    isRunning = false;
    lastRunTime = null;
    stats = {
        runsCompleted: 0,
        lastErrors: [],
        notificationsSent: {
            login_reminder: 0,
            download_reminder: 0,
            new_version: 0,
            inactivity_alert: 0,
            admin_inactivity_digest: 0,
            admin_download_digest: 0
        }
    };

    /**
     * Start the polling service
     */
    start() {
        if (this.isRunning) {
            logger.warn('[NotificationPolling] Already running');
            return;
        }

        this.isRunning = true;
        logger.info('[NotificationPolling] Starting notification polling service');

        // Run immediately on start
        this.runAllChecks().catch(err => {
            logger.error('[NotificationPolling] Initial run failed: %s', err.message);
        });

        // Set up interval
        this.intervalId = setInterval(() => {
            this.runAllChecks().catch(err => {
                logger.error('[NotificationPolling] Scheduled run failed: %s', err.message);
            });
        }, POLLING_INTERVAL);

        logger.info(`[NotificationPolling] Polling every ${POLLING_INTERVAL / 60000} minutes`);
    }

    /**
     * Stop the polling service
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        logger.info('[NotificationPolling] Stopped');
    }

    /**
     * Get service status
     * @returns {Object} Status information
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            lastRunTime: this.lastRunTime,
            pollingIntervalMs: POLLING_INTERVAL,
            stats: this.stats
        };
    }

    /**
     * Run all notification checks
     */
    async runAllChecks() {
        const startTime = Date.now();
        logger.info('[NotificationPolling] Running notification checks...');
        
        try {
            // Run all checks in parallel
            await Promise.allSettled([
                this.checkLoginReminders(),
                this.checkDownloadReminders(),
                this.checkNewVersionNotifications(),
                this.checkInactivityAlerts()
            ]);

            this.lastRunTime = new Date().toISOString();
            this.stats.runsCompleted++;
            
            const duration = Date.now() - startTime;
            logger.info(`[NotificationPolling] Notification checks complete in ${duration}ms`);
            
        } catch (error) {
            logger.error('[NotificationPolling] Error running checks: %s', error.message);
            this.stats.lastErrors.push({
                time: new Date().toISOString(),
                error: error.message
            });
            // Keep only last 10 errors
            if (this.stats.lastErrors.length > 10) {
                this.stats.lastErrors.shift();
            }
        }
    }

    /**
     * Query users eligible for login reminders
     * @param {Object} supabase - Supabase client
     * @param {Date} cutoffDate - Cutoff date for last heartbeat
     * @returns {Promise<Array>} Array of users
     */
    async _queryUsersForLoginReminders(supabase, cutoffDate) {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, organization_id, email, display_name, desktop_logged_in, desktop_last_heartbeat')
            .eq('is_active', true)
            .eq('desktop_logged_in', false)
            .not('email', 'is', null)
            .or(`desktop_last_heartbeat.is.null,desktop_last_heartbeat.lt.${cutoffDate.toISOString()}`);

        if (error) {
            throw error;
        }

        return users || [];
    }

    /**
     * Send login reminder to a single user
     * @param {Object} user - User object
     * @returns {Promise<boolean>} True if sent successfully
     */
    async _sendLoginReminderToUser(user) {
        try {
            const result = await notificationService.sendLoginReminder(
                user.id,
                user.organization_id,
                {
                    lastLoginDate: user.desktop_last_heartbeat
                        ? new Date(user.desktop_last_heartbeat).toLocaleDateString()
                        : null
                }
            );
            return result.success;
        } catch (err) {
            logger.warn(`[NotificationPolling] Error sending login reminder to ${user.id}:`, err.message);
            return false;
        }
    }

    /**
     * Check and send login reminders
     * Users who haven't logged in for X days
     */
    async checkLoginReminders() {
        try {
            const supabase = getClient();
            if (!supabase) {
                logger.warn('[NotificationPolling] Supabase not available for login reminders');
                return;
            }

            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - LOGIN_REMINDER_DAYS);

            const users = await this._queryUsersForLoginReminders(supabase, cutoffDate);

            let sentCount = 0;
            for (const user of users) {
                const sent = await this._sendLoginReminderToUser(user);
                if (sent) sentCount++;
            }

            this.stats.notificationsSent.login_reminder += sentCount;
            logger.info(`[NotificationPolling] Login reminders: checked ${users.length} users, sent ${sentCount}`);

        } catch (error) {
            logger.error('[NotificationPolling] Error checking login reminders: %s', error.message);
        }
    }

    /**
     * Query users eligible for download reminders
     * @param {Object} supabase - Supabase client
     * @returns {Promise<Array>} Array of users
     */
    async _queryUsersForDownloadReminders(supabase) {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, organization_id, email, display_name, desktop_app_version, desktop_last_heartbeat')
            .eq('is_active', true)
            .not('email', 'is', null)
            .not('atlassian_account_id', 'is', null)
            .is('desktop_app_version', null);

        if (error) {
            throw error;
        }

        return users || [];
    }

    /**
     * Send download reminder to a single user
     * @param {Object} user - User object
     * @returns {Promise<boolean>} True if sent successfully
     */
    async _sendDownloadReminderToUser(user) {
        try {
            const result = await notificationService.sendDownloadReminder(
                user.id,
                user.organization_id,
                'Windows'
            );
            return result.success;
        } catch (err) {
            logger.warn(`[NotificationPolling] Error sending download reminder to ${user.id}:`, err.message);
            return false;
        }
    }

    /**
     * Group users by organization
     * @param {Array} users - Array of user objects
     * @returns {Object} Users grouped by organization_id
     */
    _groupUsersByOrganization(users) {
        const byOrg = {};
        for (const user of users) {
            if (!byOrg[user.organization_id]) {
                byOrg[user.organization_id] = [];
            }
            byOrg[user.organization_id].push(user);
        }
        return byOrg;
    }

    /**
     * Send admin download digest for a single organization
     * @param {string} orgId - Organization ID
     * @param {Array} orgUsers - Users in the organization
     * @returns {Promise<number>} Number of digests sent
     */
    async _sendAdminDownloadDigestForOrg(orgId, orgUsers) {
        const [admins, orgName] = await Promise.all([
            this._getOrgAdmins(orgId),
            this._getOrgName(orgId)
        ]);

        const digestUsers = orgUsers.map(u => ({
            name: u.display_name || u.email,
            email: u.email
        }));

        let sentCount = 0;
        for (const admin of admins) {
            try {
                const result = await notificationService.sendAdminDownloadDigest(
                    admin.id, orgId, { orgName, users: digestUsers }
                );
                if (result.success) sentCount++;
            } catch (err) {
                logger.warn(`[NotificationPolling] Error sending admin download digest to ${admin.id}:`, err.message);
            }
        }
        return sentCount;
    }

    /**
     * Check and send download reminders
     * Users who have logged in but never downloaded the desktop app
     */
    async checkDownloadReminders() {
        try {
            const supabase = getClient();
            if (!supabase) {
                logger.warn('[NotificationPolling] Supabase not available for download reminders');
                return;
            }

            const users = await this._queryUsersForDownloadReminders(supabase);

            let sentCount = 0;
            for (const user of users) {
                const sent = await this._sendDownloadReminderToUser(user);
                if (sent) sentCount++;
            }

            this.stats.notificationsSent.download_reminder += sentCount;
            logger.info(`[NotificationPolling] Download reminders: checked ${users.length} users, sent ${sentCount}`);

            // Admin download digest: group no-app users by org, send one digest per org
            const byOrg = this._groupUsersByOrganization(users);

            let adminSentCount = 0;
            for (const [orgId, orgUsers] of Object.entries(byOrg)) {
                const sent = await this._sendAdminDownloadDigestForOrg(orgId, orgUsers);
                adminSentCount += sent;
            }

            this.stats.notificationsSent.admin_download_digest += adminSentCount;
            logger.info(`[NotificationPolling] Admin download digests sent: ${adminSentCount}`);

        } catch (error) {
            logger.error('[NotificationPolling] Error checking download reminders: %s', error.message);
        }
    }

    /**
     * Get latest app release from database
     * @param {Object} supabase - Supabase client
     * @returns {Promise<Object|null>} Latest release or null
     */
    async _getLatestAppRelease(supabase) {
        const { data: latestRelease, error } = await supabase
            .from('app_releases')
            .select('version, download_url, release_notes, is_mandatory')
            .eq('platform', 'windows')
            .eq('is_latest', true)
            .eq('is_active', true)
            .single();

        if (error) {
            return null;
        }

        return latestRelease;
    }

    /**
     * Query users with outdated app versions
     * @param {Object} supabase - Supabase client
     * @param {string} latestVersion - Latest version string
     * @returns {Promise<Array>} Array of users
     */
    async _queryUsersWithOutdatedVersion(supabase, latestVersion) {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, organization_id, email, display_name, desktop_app_version')
            .eq('is_active', true)
            .eq('desktop_logged_in', true)
            .not('email', 'is', null)
            .not('desktop_app_version', 'is', null)
            .neq('desktop_app_version', latestVersion);

        if (error) {
            throw error;
        }

        return users || [];
    }

    /**
     * Send version notification to a single user
     * @param {Object} user - User object
     * @param {Object} releaseInfo - Release information
     * @returns {Promise<boolean>} True if sent successfully
     */
    async _sendVersionNotificationToUser(user, releaseInfo) {
        // Only notify if user's version is actually older (not newer)
        if (!this._isVersionOlder(user.desktop_app_version, releaseInfo.version)) {
            return false;
        }

        try {
            const result = await notificationService.sendNewVersionNotification(
                user.id,
                user.organization_id,
                {
                    version: releaseInfo.version,
                    currentVersion: user.desktop_app_version,
                    releaseNotes: releaseInfo.release_notes,
                    downloadUrl: releaseInfo.download_url,
                    isMandatory: releaseInfo.is_mandatory
                }
            );
            return result.success;
        } catch (err) {
            logger.warn(`[NotificationPolling] Error sending version notification to ${user.id}:`, err.message);
            return false;
        }
    }

    /**
     * Check and send new version notifications
     * Users with outdated desktop app versions
     */
    async checkNewVersionNotifications() {
        try {
            const supabase = getClient();
            if (!supabase) {
                logger.warn('[NotificationPolling] Supabase not available for version notifications');
                return;
            }

            const latestRelease = await this._getLatestAppRelease(supabase);
            if (!latestRelease) {
                logger.debug('[NotificationPolling] No latest release found for version notifications');
                return;
            }

            const users = await this._queryUsersWithOutdatedVersion(supabase, latestRelease.version);

            let sentCount = 0;
            for (const user of users) {
                const sent = await this._sendVersionNotificationToUser(user, latestRelease);
                if (sent) sentCount++;
            }

            this.stats.notificationsSent.new_version += sentCount;
            logger.info(`[NotificationPolling] Version notifications: checked ${users.length} users, sent ${sentCount}`);

        } catch (error) {
            logger.error('[NotificationPolling] Error checking version notifications: %s', error.message);
        }
    }

    /**
     * Query logged-in users
     * @param {Object} supabase - Supabase client
     * @returns {Promise<Array>} Array of logged-in users
     */
    async _queryLoggedInUsers(supabase) {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, organization_id, email, display_name, desktop_last_heartbeat')
            .eq('is_active', true)
            .eq('desktop_logged_in', true)
            .not('email', 'is', null)
            .not('desktop_last_heartbeat', 'is', null);

        if (error) {
            throw error;
        }

        return users || [];
    }

    /**
     * Fetch recent activity records for users
     * @param {Object} supabase - Supabase client
     * @param {Array<string>} userIds - Array of user IDs
     * @param {Date} thresholdTime - Threshold time for recent activity
     * @returns {Promise<Object>} Object with usersWithRecentActivity Set and latestBatchByUser Map
     */
    async _fetchRecentActivity(supabase, userIds, thresholdTime) {
        const { data: recentActivity, error } = await supabase
            .from('activity_records')
            .select('user_id, batch_end')
            .in('user_id', userIds)
            .gt('batch_end', thresholdTime.toISOString());

        if (error) {
            throw error;
        }

        const usersWithRecentActivity = new Set();
        const latestBatchByUser = {};

        for (const record of (recentActivity || [])) {
            usersWithRecentActivity.add(record.user_id);

            if (!latestBatchByUser[record.user_id] || record.batch_end > latestBatchByUser[record.user_id]) {
                latestBatchByUser[record.user_id] = record.batch_end;
            }
        }

        return { usersWithRecentActivity, latestBatchByUser };
    }

    /**
     * Determine if user is inactive based on heartbeat and activity
     * @param {Object} user - User object
     * @param {Date} thresholdTime - Threshold time
     * @param {Set} usersWithRecentActivity - Set of user IDs with recent activity
     * @returns {boolean} True if user is inactive
     */
    _isUserInactive(user, thresholdTime, usersWithRecentActivity) {
        const heartbeatOld = new Date(user.desktop_last_heartbeat) < thresholdTime;
        const hasRecentActivity = usersWithRecentActivity.has(user.id);
        return heartbeatOld && !hasRecentActivity;
    }

    /**
     * Calculate effective last active time
     * @param {Object} user - User object
     * @param {Object} latestBatchByUser - Map of user_id to latest batch_end
     * @returns {Date} Effective last active time
     */
    _getEffectiveLastActive(user, latestBatchByUser) {
        const heartbeatTime = new Date(user.desktop_last_heartbeat);
        const batchTime = latestBatchByUser[user.id] ? new Date(latestBatchByUser[user.id]) : null;
        return (batchTime && batchTime > heartbeatTime) ? batchTime : heartbeatTime;
    }

    /**
     * Calculate hours inactive
     * @param {Date} effectiveLastActive - Effective last active time
     * @returns {number} Hours inactive (rounded to 1 decimal)
     */
    _calculateHoursInactive(effectiveLastActive) {
        return Math.round((Date.now() - effectiveLastActive.getTime()) / (1000 * 60 * 60) * 10) / 10;
    }

    /**
     * Send inactivity alert to a single user
     * @param {Object} user - User object
     * @param {Object} latestBatchByUser - Map of user_id to latest batch_end
     * @returns {Promise<boolean>} True if sent successfully
     */
    async _sendInactivityAlertToUser(user, latestBatchByUser) {
        const isWorkHours = await this._isWithinWorkHours(user.id);
        if (!isWorkHours) {
            return false;
        }

        const effectiveLastActive = this._getEffectiveLastActive(user, latestBatchByUser);
        const hoursInactive = this._calculateHoursInactive(effectiveLastActive);

        try {
            const result = await notificationService.sendInactivityAlert(
                user.id,
                user.organization_id,
                {
                    lastActivityTime: effectiveLastActive.toLocaleString(),
                    hoursInactive
                }
            );
            return result.success;
        } catch (err) {
            logger.warn(`[NotificationPolling] Error sending inactivity alert to ${user.id}:`, err.message);
            return false;
        }
    }

    /**
     * Prepare digest user data
     * @param {Object} user - User object
     * @param {Object} latestBatchByUser - Map of user_id to latest batch_end
     * @returns {Object} Digest user data
     */
    _prepareDigestUserData(user, latestBatchByUser) {
        const effectiveLastActive = this._getEffectiveLastActive(user, latestBatchByUser);
        const hoursInactive = this._calculateHoursInactive(effectiveLastActive);

        return {
            name: user.display_name || user.email,
            hoursInactive,
            lastActivity: effectiveLastActive.toLocaleString()
        };
    }

    /**
     * Send admin inactivity digest for a single organization
     * @param {string} orgId - Organization ID
     * @param {Array} orgInactiveUsers - Inactive users in the organization
     * @param {Object} latestBatchByUser - Map of user_id to latest batch_end
     * @returns {Promise<number>} Number of digests sent
     */
    async _sendAdminInactivityDigestForOrg(orgId, orgInactiveUsers, latestBatchByUser) {
        const [admins, orgName] = await Promise.all([
            this._getOrgAdmins(orgId),
            this._getOrgName(orgId)
        ]);

        const digestUsers = orgInactiveUsers.map(user => 
            this._prepareDigestUserData(user, latestBatchByUser)
        );

        let sentCount = 0;
        for (const admin of admins) {
            try {
                const result = await notificationService.sendAdminInactivityDigest(
                    admin.id, orgId, { orgName, inactiveUsers: digestUsers }
                );
                if (result.success) sentCount++;
            } catch (err) {
                logger.warn(`[NotificationPolling] Error sending admin inactivity digest to ${admin.id}:`, err.message);
            }
        }
        return sentCount;
    }

    /**
     * Check and send inactivity alerts
     * Users with desktop app logged in but no activity for INACTIVITY_THRESHOLD_HOURS+.
     * Uses combined signal: MAX(desktop_last_heartbeat, activity_records.batch_end)
     * so users who are actively uploading activity batches are not incorrectly flagged.
     */
    async checkInactivityAlerts() {
        try {
            const supabase = getClient();
            if (!supabase) {
                logger.warn('[NotificationPolling] Supabase not available for inactivity alerts');
                return;
            }

            const thresholdTime = new Date();
            thresholdTime.setHours(thresholdTime.getHours() - INACTIVITY_THRESHOLD_HOURS);

            const users = await this._queryLoggedInUsers(supabase);

            if (users.length === 0) {
                logger.info('[NotificationPolling] Inactivity alerts: no logged-in users found');
                return;
            }

            const userIds = users.map(u => u.id);
            const { usersWithRecentActivity, latestBatchByUser } = await this._fetchRecentActivity(
                supabase, userIds, thresholdTime
            );

            // Only alert users where BOTH the heartbeat AND activity_records are stale
            const inactiveUsers = users.filter(user => 
                this._isUserInactive(user, thresholdTime, usersWithRecentActivity)
            );

            let sentCount = 0;
            for (const user of inactiveUsers) {
                const sent = await this._sendInactivityAlertToUser(user, latestBatchByUser);
                if (sent) sentCount++;
            }

            this.stats.notificationsSent.inactivity_alert += sentCount;
            logger.info(`[NotificationPolling] Inactivity alerts: checked ${users.length} users, ${inactiveUsers.length} inactive, sent ${sentCount}`);

            // Admin inactivity digest: group inactive users by org, send one digest per org
            const byOrg = this._groupUsersByOrganization(inactiveUsers);

            let adminSentCount = 0;
            for (const [orgId, orgInactiveUsers] of Object.entries(byOrg)) {
                const sent = await this._sendAdminInactivityDigestForOrg(orgId, orgInactiveUsers, latestBatchByUser);
                adminSentCount += sent;
            }

            this.stats.notificationsSent.admin_inactivity_digest += adminSentCount;
            logger.info(`[NotificationPolling] Admin inactivity digests sent: ${adminSentCount}`);

        } catch (error) {
            logger.error('[NotificationPolling] Error checking inactivity alerts: %s', error.message);
        }
    }

    /**
     * Deduplicate admin users
     * @param {Array} data - Raw data from project_settings query
     * @returns {Array} Deduplicated admin users
     */
    _deduplicateAdmins(data) {
        const seen = new Set();
        const admins = [];

        for (const row of data) {
            const user = row.users;
            if (!user?.email || seen.has(user.id)) {
                continue;
            }
            seen.add(user.id);
            admins.push(user);
        }

        return admins;
    }

    /**
     * Get all owner/admin users for an organization
     * @param {string} orgId - Organization ID
     * @returns {Promise<Array>} Array of {id, email, display_name}
     */
    async _getOrgAdmins(orgId) {
        try {
            const supabase = getClient();
            if (!supabase) {
                return [];
            }

            // Use project_settings.configured_by — the user who configured each project
            // must have ADMINISTER_PROJECTS permission in Jira, making them the true
            // project admin (not just an org-level admin who may be a regular employee).
            const { data, error } = await supabase
                .from('project_settings')
                .select('users!configured_by(id, email, display_name)')
                .eq('organization_id', orgId)
                .not('configured_by', 'is', null);

            if (error || !data) {
                return [];
            }

            // Deduplicate — same person may have configured multiple projects
            return this._deduplicateAdmins(data);
        } catch (err) {
            logger.warn('[NotificationPolling] Error fetching project admins:', err.message);
            return [];
        }
    }

    /**
     * Get the display name of an organization
     * @param {string} orgId - Organization ID
     * @returns {Promise<string>} Organization name
     */
    async _getOrgName(orgId) {
        const defaultName = 'Your Organization';

        try {
            const supabase = getClient();
            if (!supabase) {
                return defaultName;
            }

            const { data } = await supabase
                .from('organizations')
                .select('org_name')
                .eq('id', orgId)
                .single();

            return data?.org_name || defaultName;
        } catch (err) {
            logger.warn('[NotificationPolling] Error fetching organization name for %s: %s', orgId, err.message);
            return defaultName;
        }
    }

    /**
     * Parse version string into numeric parts
     * @param {string} version - Version string
     * @returns {Array<number>} Array of version parts
     */
    _parseVersion(version) {
        return version.replaceAll(/[^0-9.]/g, '').split('.').map(n => Number.parseInt(n, 10) || 0);
    }

    /**
     * Compare semantic versions
     * @param {string} v1 - First version
     * @param {string} v2 - Second version
     * @returns {boolean} True if v1 is older than v2
     */
    _isVersionOlder(v1, v2) {
        if (!v1 || !v2) {
            return false;
        }

        const parts1 = this._parseVersion(v1);
        const parts2 = this._parseVersion(v2);

        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 < p2) return true;
            if (p1 > p2) return false;
        }
        return false;
    }

    /**
     * Convert time to user's timezone
     * @param {Date} date - Date to convert
     * @param {string} timezone - Target timezone
     * @returns {Date} Converted date
     */
    _convertToTimezone(date, timezone) {
        try {
            return new Date(date.toLocaleString('en-US', { timeZone: timezone }));
        } catch {
            return date; // Fallback to original date on invalid timezone
        }
    }

    /**
     * Parse time string to minutes since midnight
     * @param {string} timeStr - Time string in format "HH:MM:SS"
     * @returns {number} Minutes since midnight
     */
    _parseTimeToMinutes(timeStr) {
        const [h, m] = (timeStr || '09:00:00').split(':').map(Number);
        return h * 60 + (m || 0);
    }

    /**
     * Check if day is a work day
     * @param {number} day - Day of week (0-7, where 0 and 7 are Sunday)
     * @param {Array<number>} workDays - Array of work days
     * @returns {boolean} True if it's a work day
     */
    _isWorkDay(day, workDays) {
        const normalizedDay = day || 7; // Convert Sunday from 0 to 7
        return workDays.includes(normalizedDay);
    }

    /**
     * Check if time is within work hours range
     * @param {number} currentMinutes - Current time in minutes since midnight
     * @param {string} startTime - Start time string
     * @param {string} endTime - End time string
     * @returns {boolean} True if within range
     */
    _isWithinTimeRange(currentMinutes, startTime, endTime) {
        const startMinutes = this._parseTimeToMinutes(startTime);
        const endMinutes = this._parseTimeToMinutes(endTime);
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }

    /**
     * Check if current time is within user's configured work hours
     * @param {string} userId - User ID
     * @returns {Promise<boolean>} True if within work hours
     */
    async _isWithinWorkHours(userId) {
        try {
            const prefs = await notificationDb.getUserPreferences(userId);

            // Default to allowing if no preferences set
            if (!prefs) {
                return true;
            }

            const now = new Date();
            const userTimezone = prefs.timezone || 'UTC';
            const userTime = this._convertToTimezone(now, userTimezone);

            const currentDay = userTime.getDay();
            const workDays = prefs.work_days || [1, 2, 3, 4, 5];

            // Check if it's a work day (default: Monday-Friday)
            if (!this._isWorkDay(currentDay, workDays)) {
                return false;
            }

            const currentMinutes = userTime.getHours() * 60 + userTime.getMinutes();
            return this._isWithinTimeRange(currentMinutes, prefs.work_hours_start, prefs.work_hours_end);

        } catch (error) {
            logger.warn('[NotificationPolling] Error checking work hours:', error.message);
            return true; // Default to allowing on error
        }
    }

    /**
     * Run a single check type manually
     * @param {string} checkType - Type of check to run
     * @returns {Promise<void>}
     */
    async runSingleCheck(checkType) {
        const checks = {
            'login_reminder': () => this.checkLoginReminders(),
            'download_reminder': () => this.checkDownloadReminders(),
            'new_version': () => this.checkNewVersionNotifications(),
            'inactivity_alert': () => this.checkInactivityAlerts()
        };

        const checkFn = checks[checkType];
        if (!checkFn) {
            throw new Error(`Unknown check type: ${checkType}`);
        }

        await checkFn();
    }
}

// Export singleton instance
const notificationPollingService = new NotificationPollingService();
module.exports = notificationPollingService;

// Also export class for testing
module.exports.NotificationPollingService = NotificationPollingService;

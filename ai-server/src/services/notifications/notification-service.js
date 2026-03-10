/**
 * Notification Service
 * 
 * Handles business logic for sending email notifications.
 * Manages cooldowns, preferences, and notification logging.
 */

const notifmeWrapper = require('./notifme-wrapper');
const notificationDb = require('../db/notification-db-service');
const { getUserById, getOrganizationById, getLatestDownloadUrl } = require('../db/user-db-service');
const templates = require('./templates');
const logger = require('../../utils/logger');

class NotificationService {
    constructor() {
        this.templates = templates.byType;
    }

    /**
     * Build login URL for a user based on their organization's Jira instance
     * @param {string} organizationId - Organization ID
     * @returns {Promise<string>} Login URL
     */
    async _buildLoginUrl(organizationId) {
        const org = await getOrganizationById(organizationId);
        if (org?.jira_instance_url) {
            // Link directly to the Jira instance - the Forge app is accessible from there
            return `${org.jira_instance_url}/jira/software/projects`;
        }
        // If no Jira URL available, use a more helpful fallback
        logger.warn(`[Notification] No jira_instance_url for organization ${organizationId}`);
        return process.env.FORGE_APP_URL || 'https://marketplace.atlassian.com/apps';
    }

    /**
     * Build settings URL for a user based on their organization's Jira instance
     * @param {string} organizationId - Organization ID
     * @returns {Promise<string>} Settings URL
     */
    async _buildSettingsUrl(organizationId) {
        const org = await getOrganizationById(organizationId);
        if (org?.jira_instance_url) {
            // Link to Jira settings where users can access the app settings
            return `${org.jira_instance_url}/jira/settings/apps`;
        }
        logger.warn(`[Notification] No jira_instance_url for organization ${organizationId}`);
        return process.env.SETTINGS_URL || null;
    }

    /**
     * Get download URL from app_releases table or environment
     * @param {string} [platform='windows'] - Platform
     * @returns {Promise<string>} Download URL
     */
    async _getDownloadUrl(platform = 'windows') {
        // First try to get from app_releases table (most accurate)
        const dbUrl = await getLatestDownloadUrl(platform);
        if (dbUrl) {
            return dbUrl;
        }
        // Fallback to environment variable or a more helpful default
        return process.env.DOWNLOAD_URL || 'https://github.com/AmzurATG/JIRAForge/releases/latest';
    }

    /**
     * Send a notification with cooldown and preference checks
     * @param {string} userId - User ID
     * @param {string} organizationId - Organization ID
     * @param {string} type - Notification type
     * @param {Object} [data={}] - Template data
     * @returns {Promise<Object>} Send result
     */
    async sendNotification(userId, organizationId, type, data = {}) {
        try {
            // Check if notifications are enabled globally
            if (!notifmeWrapper.isEnabled()) {
                logger.info(`[Notification] Notifications disabled globally`);
                return { success: false, reason: 'notifications_disabled' };
            }

            // 1. Get user
            const user = await getUserById(userId);
            if (!user) {
                logger.warn(`[Notification] User not found: ${userId}`);
                return { success: false, reason: 'user_not_found' };
            }

            if (!user.email) {
                logger.warn(`[Notification] No email for user ${userId}`);
                return { success: false, reason: 'no_email' };
            }

            // 2. Check user preferences
            const prefs = await notificationDb.getUserPreferences(userId);
            const typeEnabledKey = `${type}_enabled`;
            
            // If preferences exist and this type is explicitly disabled, skip
            if (prefs && prefs[typeEnabledKey] === false) {
                logger.info(`[Notification] ${type} disabled for user ${userId}`);
                return { success: false, reason: 'disabled_by_user' };
            }

            // 3. Check cooldown
            const cooldown = await notificationDb.checkCooldown(userId, type);
            if (cooldown.inCooldown) {
                logger.info(`[Notification] ${type} in cooldown for user ${userId}, next allowed: ${cooldown.nextAllowed}`);
                return { 
                    success: false, 
                    reason: 'cooldown', 
                    nextAllowed: cooldown.nextAllowed 
                };
            }

            // 4. Check daily limit
            const maxDaily = prefs?.max_daily_notifications || 5;
            if (cooldown.todayCount >= maxDaily) {
                logger.info(`[Notification] Daily limit (${maxDaily}) reached for user ${userId}`);
                return { success: false, reason: 'daily_limit' };
            }

            // 5. Build email from template
            const template = this.templates[type];
            if (!template) {
                throw new Error(`Unknown notification type: ${type}`);
            }

            const templateData = {
                displayName: user.display_name || user.email.split('@')[0],
                email: user.email,
                ...data
            };

            // Handle dynamic subject (can be function or string)
            const subject = typeof template.subject === 'function' 
                ? template.subject(templateData) 
                : template.subject;
            
            const text = template.text(templateData);
            const html = template.html(templateData);

            // 6. Create log entry (status: pending)
            const logEntry = await notificationDb.createLog({
                userId,
                organizationId,
                type,
                email: user.email,
                subject,
                metadata: data
            });

            // 7. Send email
            const result = await notifmeWrapper.send({
                to: user.email,
                subject,
                text,
                html
            });

            // 8. Update log with result
            await notificationDb.updateLog(logEntry.id, {
                status: result.success ? 'sent' : 'failed',
                provider: result.provider,
                providerMessageId: result.messageId,
                errorMessage: result.errors?.[0]?.message,
                sentAt: result.success ? new Date().toISOString() : null
            });

            // 9. Update cooldown if successful
            if (result.success) {
                await notificationDb.updateCooldown(userId, type);
            }

            logger.info(`[Notification] ${type} to ${user.email}: ${result.success ? 'sent' : 'failed'}`, {
                userId,
                type,
                success: result.success,
                provider: result.provider
            });

            return {
                ...result,
                logId: logEntry.id,
                type,
                recipient: user.email
            };

        } catch (error) {
            logger.error(`[Notification] Error sending ${type} to user ${userId}:`, error);
            return { 
                success: false, 
                reason: 'error', 
                error: error.message 
            };
        }
    }

    /**
     * Send login reminder to a specific user
     * @param {string} userId - User ID
     * @param {string} organizationId - Organization ID
     * @param {Object} [options] - Additional options
     * @returns {Promise<Object>} Send result
     */
    async sendLoginReminder(userId, organizationId, options = {}) {
        // Build dynamic login URL based on organization's Jira instance
        const loginUrl = options.loginUrl || await this._buildLoginUrl(organizationId);
        // Build dynamic settings URL for notification preferences
        const settingsUrl = await this._buildSettingsUrl(organizationId);
        return this.sendNotification(userId, organizationId, 'login_reminder', { 
            loginUrl,
            lastLoginDate: options.lastLoginDate,
            settingsUrl
        });
    }

    /**
     * Send download reminder to a specific user
     * @param {string} userId - User ID
     * @param {string} organizationId - Organization ID
     * @param {string} [platform='Windows'] - Platform name
     * @returns {Promise<Object>} Send result
     */
    async sendDownloadReminder(userId, organizationId, platform = 'Windows', downloadUrl = null) {
        // Get download URL from app_releases table or fallback
        const resolvedUrl = downloadUrl || await this._getDownloadUrl(platform.toLowerCase());
        // Build dynamic settings URL for notification preferences
        const settingsUrl = await this._buildSettingsUrl(organizationId);
        return this.sendNotification(userId, organizationId, 'download_reminder', {
            downloadUrl: resolvedUrl,
            platform,
            settingsUrl
        });
    }

    /**
     * Send new version notification
     * @param {string} userId - User ID
     * @param {string} organizationId - Organization ID
     * @param {Object} versionInfo - Version information
     * @param {string} versionInfo.version - New version number
     * @param {string} versionInfo.currentVersion - User's current version
     * @param {string} versionInfo.releaseNotes - Release notes
     * @param {string} versionInfo.downloadUrl - Download URL
     * @param {boolean} [versionInfo.isMandatory] - Whether update is mandatory
     * @returns {Promise<Object>} Send result
     */
    async sendNewVersionNotification(userId, organizationId, versionInfo) {
        // Get download URL from app_releases or use provided one
        const downloadUrl = versionInfo.downloadUrl || await this._getDownloadUrl();
        // Build dynamic settings URL for notification preferences
        const settingsUrl = await this._buildSettingsUrl(organizationId);
        return this.sendNotification(userId, organizationId, 'new_version', {
            version: versionInfo.version,
            currentVersion: versionInfo.currentVersion,
            releaseNotes: versionInfo.releaseNotes || 'Bug fixes and performance improvements',
            downloadUrl,
            isMandatory: versionInfo.isMandatory || false,
            settingsUrl
        });
    }

    /**
     * Send inactivity alert
     * @param {string} userId - User ID
     * @param {string} organizationId - Organization ID
     * @param {Object} activityInfo - Activity information
     * @param {string} activityInfo.lastActivityTime - Last activity timestamp (formatted)
     * @param {number} activityInfo.hoursInactive - Hours since last activity
     * @returns {Promise<Object>} Send result
     */
    async sendInactivityAlert(userId, organizationId, activityInfo) {
        // Build dynamic settings URL based on organization's Jira instance
        const settingsUrl = await this._buildSettingsUrl(organizationId);
        return this.sendNotification(userId, organizationId, 'inactivity_alert', {
            lastActivityTime: activityInfo.lastActivityTime,
            hoursInactive: activityInfo.hoursInactive,
            settingsUrl
        });
    }

    /**
     * Send inactivity digest to an org admin
     * Lists all inactive team members for that org in one email.
     * @param {string} adminUserId - Admin's user ID
     * @param {string} organizationId - Organization ID
     * @param {Object} payload
     * @param {string} payload.orgName - Organization display name
     * @param {Array} payload.inactiveUsers - [{name, hoursInactive, lastActivity}]
     * @returns {Promise<Object>} Send result
     */
    async sendAdminInactivityDigest(adminUserId, organizationId, { orgName, inactiveUsers }) {
        return this.sendNotification(adminUserId, organizationId, 'admin_inactivity_digest', {
            orgName,
            inactiveUsers
        });
    }

    /**
     * Send download reminder digest to an org admin
     * Lists all team members who haven't installed the Desktop App.
     * @param {string} adminUserId - Admin's user ID
     * @param {string} organizationId - Organization ID
     * @param {Object} payload
     * @param {string} payload.orgName - Organization display name
     * @param {Array} payload.users - [{name, email}]
     * @returns {Promise<Object>} Send result
     */
    async sendAdminDownloadDigest(adminUserId, organizationId, { orgName, users, downloadUrl = null }) {
        // Get download URL from app_releases table or fallback
        const resolvedUrl = downloadUrl || await this._getDownloadUrl();
        return this.sendNotification(adminUserId, organizationId, 'admin_download_digest', {
            orgName,
            users,
            downloadUrl: resolvedUrl
        });
    }

    /**
     * Get supported notification types
     * @returns {Array<string>} Array of notification type names
     */
    getNotificationTypes() {
        return Object.keys(this.templates);
    }

    /**
     * Check if a notification type is valid
     * @param {string} type - Notification type to check
     * @returns {boolean} True if valid
     */
    isValidType(type) {
        return type in this.templates;
    }

    /**
     * Get user's notification history
     * @param {string} userId - User ID
     * @param {number} [limit=50] - Maximum records to return
     * @returns {Promise<Array>} Array of notification logs
     */
    async getHistory(userId, limit = 50) {
        return notificationDb.getUserNotificationHistory(userId, limit);
    }

    /**
     * Get organization statistics
     * @param {string} organizationId - Organization ID
     * @param {number} [days=30] - Days to include
     * @returns {Promise<Object>} Statistics object
     */
    async getStats(organizationId, days = 30) {
        return notificationDb.getOrganizationStats(organizationId, days);
    }

    /**
     * Update user notification preferences
     * @param {string} userId - User ID
     * @param {string} organizationId - Organization ID
     * @param {Object} preferences - Preference updates
     * @returns {Promise<Object>} Updated preferences
     */
    async updatePreferences(userId, organizationId, preferences) {
        return notificationDb.upsertUserPreferences(userId, organizationId, preferences);
    }

    /**
     * Get user notification preferences
     * @param {string} userId - User ID
     * @returns {Promise<Object|null>} User preferences or null
     */
    async getPreferences(userId) {
        return notificationDb.getUserPreferences(userId);
    }
}

// Export singleton instance
const notificationService = new NotificationService();
module.exports = notificationService;

// Also export class for testing
module.exports.NotificationService = NotificationService;

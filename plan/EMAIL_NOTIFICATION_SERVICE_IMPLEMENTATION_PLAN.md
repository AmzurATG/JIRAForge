# Email Notification Service Implementation Plan

## Overview

This document outlines the implementation plan for an email notification service using the **notifme-sdk** library with SendGrid as the primary provider. The service will handle:

1. **User Login Reminders** - Notify users who haven't logged in
2. **Desktop App Download Reminders** - Notify users who haven't downloaded the desktop app
3. **New Version Notifications** - Alert users when a new desktop app version is available
4. **Inactivity Alerts** - Notify users inactive for 3.5+ hours during work hours

## Architecture Decision

### Why ai-server?

The notification service will be implemented in the **ai-server** (Node.js) because:

- ✅ Already has Supabase access with service role credentials
- ✅ Has existing polling service infrastructure (`polling-service.js`, `activity-polling-service.js`)
- ✅ Runs as a persistent server (ideal for scheduled tasks)
- ✅ Central backend that can handle cross-platform notifications
- ✅ Already handles user authentication and tracking

### Service Architecture

```
ai-server/src/
├── services/
│   ├── notifications/
│   │   ├── index.js                    # Main export
│   │   ├── notifme-provider.js         # Provider abstraction layer
│   │   ├── notifme-wrapper.js          # NotifMe SDK wrapper
│   │   ├── notification-service.js     # Business logic
│   │   ├── notification-polling.js     # Scheduled polling
│   │   └── templates/
│   │       ├── login-reminder.js
│   │       ├── download-reminder.js
│   │       ├── new-version.js
│   │       └── inactivity-alert.js
│   └── db/
│       └── notification-db-service.js  # DB operations
├── controllers/
│   └── notification-controller.js      # REST endpoints
└── tests/
    ├── notification-service.test.js
    ├── notifme-wrapper.test.js
    └── notification-polling.test.js
```

---

## Phase 1: Database Schema

### Migration: `20260225_add_notification_tracking.sql`

```sql
-- ============================================================================
-- Migration: Add Email Notification Tracking
-- ============================================================================

-- Table to track sent notifications and prevent duplicates
CREATE TABLE IF NOT EXISTS public.notification_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- User reference
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    
    -- Notification details
    notification_type TEXT NOT NULL,  -- 'login_reminder', 'download_reminder', 'new_version', 'inactivity_alert'
    email_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    
    -- Status tracking
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'sent', 'failed', 'bounced'
    provider TEXT,                           -- 'sendgrid', 'mailgun', 'smtp', etc.
    provider_message_id TEXT,                -- External message ID from provider
    error_message TEXT,
    
    -- Contextual data
    metadata JSONB DEFAULT '{}',             -- Additional context (e.g., version for new_version)
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_notification_type CHECK (
        notification_type IN ('login_reminder', 'download_reminder', 'new_version', 'inactivity_alert')
    ),
    CONSTRAINT valid_status CHECK (
        status IN ('pending', 'queued', 'sent', 'failed', 'bounced', 'skipped')
    )
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_notification_logs_user_type 
ON public.notification_logs(user_id, notification_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_logs_org_status 
ON public.notification_logs(organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_logs_pending 
ON public.notification_logs(status) 
WHERE status = 'pending';

-- Table for notification preferences per user
CREATE TABLE IF NOT EXISTS public.notification_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    
    -- Notification types enabled
    login_reminder_enabled BOOLEAN DEFAULT TRUE,
    download_reminder_enabled BOOLEAN DEFAULT TRUE,
    new_version_enabled BOOLEAN DEFAULT TRUE,
    inactivity_alert_enabled BOOLEAN DEFAULT TRUE,
    
    -- Timing preferences
    inactivity_threshold_hours DECIMAL DEFAULT 3.5,
    work_hours_start TIME DEFAULT '09:00:00',
    work_hours_end TIME DEFAULT '18:00:00',
    work_days INTEGER[] DEFAULT '{1,2,3,4,5}',  -- 1=Monday, 7=Sunday
    timezone TEXT DEFAULT 'UTC',
    
    -- Rate limiting
    max_daily_notifications INTEGER DEFAULT 5,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(user_id)
);

-- Table to track notification cooldowns (prevent spam)
CREATE TABLE IF NOT EXISTS public.notification_cooldowns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL,
    
    -- Last sent timestamp per notification type
    last_sent_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Cooldown settings
    cooldown_hours INTEGER DEFAULT 24,
    
    -- Count for rate limiting
    sent_today_count INTEGER DEFAULT 0,
    count_reset_date DATE DEFAULT CURRENT_DATE,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(user_id, notification_type)
);

-- Function to update cooldown tracking
CREATE OR REPLACE FUNCTION public.update_notification_cooldown(
    p_user_id UUID,
    p_notification_type TEXT
) RETURNS void AS $$
BEGIN
    INSERT INTO public.notification_cooldowns (user_id, notification_type, last_sent_at, sent_today_count, count_reset_date)
    VALUES (p_user_id, p_notification_type, NOW(), 1, CURRENT_DATE)
    ON CONFLICT (user_id, notification_type) DO UPDATE SET
        last_sent_at = NOW(),
        sent_today_count = CASE 
            WHEN notification_cooldowns.count_reset_date = CURRENT_DATE 
            THEN notification_cooldowns.sent_today_count + 1 
            ELSE 1 
        END,
        count_reset_date = CURRENT_DATE,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- Comments
COMMENT ON TABLE public.notification_logs IS 'Tracks all email notifications sent to users';
COMMENT ON TABLE public.notification_preferences IS 'User preferences for notification settings';
COMMENT ON TABLE public.notification_cooldowns IS 'Prevents notification spam with cooldown tracking';
```

---

## Phase 2: Core Implementation

### 2.1 NotifMe Wrapper (`notifme-wrapper.js`)

The wrapper provides a provider-agnostic interface for sending emails.

```javascript
/**
 * NotifMe SDK Wrapper
 * Abstracts email provider configuration for easy switching
 * 
 * Supported providers: sendgrid, mailgun, smtp, ses, sparkpost
 */

const NotifmeSdk = require('notifme-sdk').default;
const logger = require('../../utils/logger');

class NotifMeWrapper {
    constructor() {
        this.sdk = null;
        this.provider = null;
        this.initialized = false;
    }

    /**
     * Initialize the SDK with environment-based configuration
     * Provider is determined by EMAIL_PROVIDER env variable
     */
    initialize() {
        const provider = process.env.EMAIL_PROVIDER || 'sendgrid';
        const config = this._buildConfig(provider);
        
        this.sdk = new NotifmeSdk({
            channels: {
                email: config
            }
        });
        
        this.provider = provider;
        this.initialized = true;
        
        logger.info(`[NotifMe] Initialized with provider: ${provider}`);
        return this;
    }

    /**
     * Build provider-specific configuration from environment
     */
    _buildConfig(provider) {
        const configs = {
            sendgrid: {
                providers: [{
                    type: 'sendgrid',
                    apiKey: process.env.SENDGRID_API_KEY
                }]
            },
            mailgun: {
                providers: [{
                    type: 'mailgun',
                    apiKey: process.env.MAILGUN_API_KEY,
                    domainName: process.env.MAILGUN_DOMAIN
                }]
            },
            smtp: {
                providers: [{
                    type: 'smtp',
                    host: process.env.SMTP_HOST,
                    port: parseInt(process.env.SMTP_PORT || '587'),
                    secure: process.env.SMTP_SECURE === 'true',
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASSWORD
                    }
                }]
            },
            ses: {
                providers: [{
                    type: 'ses',
                    region: process.env.AWS_REGION || 'us-east-1',
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                }]
            },
            sparkpost: {
                providers: [{
                    type: 'sparkpost',
                    apiKey: process.env.SPARKPOST_API_KEY
                }]
            }
        };

        const config = configs[provider];
        if (!config) {
            throw new Error(`Unsupported email provider: ${provider}`);
        }

        return config;
    }

    /**
     * Send an email using the configured provider
     * @param {Object} options - Email options
     * @param {string} options.to - Recipient email
     * @param {string} options.from - Sender email (optional, uses default)
     * @param {string} options.subject - Email subject
     * @param {string} options.text - Plain text body
     * @param {string} options.html - HTML body (optional)
     * @returns {Promise<Object>} Send result with status and messageId
     */
    async send({ to, from, subject, text, html }) {
        if (!this.initialized) {
            this.initialize();
        }

        const fromEmail = from || process.env.EMAIL_FROM || 'noreply@jiraforge.io';
        const fromName = process.env.EMAIL_FROM_NAME || 'JIRAForge';

        try {
            const result = await this.sdk.send({
                email: {
                    from: `${fromName} <${fromEmail}>`,
                    to,
                    subject,
                    text,
                    html: html || text
                }
            });

            logger.info(`[NotifMe] Email sent to ${to} via ${this.provider}`, {
                status: result.status,
                messageId: result.id
            });

            return {
                success: result.status === 'success',
                status: result.status,
                messageId: result.id,
                provider: this.provider,
                errors: result.errors
            };

        } catch (error) {
            logger.error(`[NotifMe] Failed to send email to ${to}:`, error);
            return {
                success: false,
                status: 'error',
                provider: this.provider,
                errors: [{ message: error.message }]
            };
        }
    }

    /**
     * Get current provider name
     */
    getProvider() {
        return this.provider;
    }

    /**
     * Check if the wrapper is properly configured
     */
    isConfigured() {
        try {
            this._buildConfig(process.env.EMAIL_PROVIDER || 'sendgrid');
            return true;
        } catch {
            return false;
        }
    }
}

// Export singleton instance
module.exports = new NotifMeWrapper();
```

### 2.2 Email Templates (`templates/*.js`)

```javascript
// templates/login-reminder.js
module.exports = {
    subject: 'Reminder: Login to JIRAForge Time Tracker',
    
    text: ({ displayName, loginUrl }) => `
Hi ${displayName},

We noticed you haven't logged into JIRAForge Time Tracker recently.

Login now to continue tracking your work time and stay productive:
${loginUrl}

If you're having trouble logging in, please contact support.

Best regards,
The JIRAForge Team
    `.trim(),
    
    html: ({ displayName, loginUrl }) => `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .button { display: inline-block; padding: 12px 24px; background: #0052CC; color: white; text-decoration: none; border-radius: 4px; }
        .footer { margin-top: 30px; color: #666; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Hi ${displayName},</h2>
        <p>We noticed you haven't logged into JIRAForge Time Tracker recently.</p>
        <p>Login now to continue tracking your work time and stay productive:</p>
        <p><a href="${loginUrl}" class="button">Login to JIRAForge</a></p>
        <div class="footer">
            <p>If you're having trouble logging in, please contact support.</p>
            <p>Best regards,<br>The JIRAForge Team</p>
        </div>
    </div>
</body>
</html>
    `.trim()
};

// templates/download-reminder.js
module.exports = {
    subject: 'Download the JIRAForge Desktop App',
    
    text: ({ displayName, downloadUrl, platform }) => `
Hi ${displayName},

Complete your JIRAForge setup by downloading the Desktop App.

The Desktop App provides:
- Automatic time tracking
- Screenshot-based activity monitoring
- Seamless Jira integration

Download for ${platform}: ${downloadUrl}

Best regards,
The JIRAForge Team
    `.trim(),
    
    html: ({ displayName, downloadUrl, platform }) => `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .button { display: inline-block; padding: 12px 24px; background: #0052CC; color: white; text-decoration: none; border-radius: 4px; }
        .features { background: #f5f5f5; padding: 15px; border-radius: 4px; margin: 20px 0; }
        .footer { margin-top: 30px; color: #666; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Hi ${displayName},</h2>
        <p>Complete your JIRAForge setup by downloading the Desktop App.</p>
        <div class="features">
            <strong>The Desktop App provides:</strong>
            <ul>
                <li>Automatic time tracking</li>
                <li>Screenshot-based activity monitoring</li>
                <li>Seamless Jira integration</li>
            </ul>
        </div>
        <p><a href="${downloadUrl}" class="button">Download for ${platform}</a></p>
        <div class="footer">
            <p>Best regards,<br>The JIRAForge Team</p>
        </div>
    </div>
</body>
</html>
    `.trim()
};

// templates/new-version.js
module.exports = {
    subject: ({ version }) => `JIRAForge Desktop App v${version} is Available`,
    
    text: ({ displayName, version, releaseNotes, downloadUrl, currentVersion }) => `
Hi ${displayName},

A new version of the JIRAForge Desktop App is available!

Current version: ${currentVersion}
New version: ${version}

What's new:
${releaseNotes}

Download the update: ${downloadUrl}

Best regards,
The JIRAForge Team
    `.trim(),
    
    html: ({ displayName, version, releaseNotes, downloadUrl, currentVersion }) => `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .button { display: inline-block; padding: 12px 24px; background: #0052CC; color: white; text-decoration: none; border-radius: 4px; }
        .version-badge { background: #00875A; color: white; padding: 4px 8px; border-radius: 4px; font-size: 14px; }
        .release-notes { background: #f5f5f5; padding: 15px; border-radius: 4px; margin: 20px 0; white-space: pre-wrap; }
        .footer { margin-top: 30px; color: #666; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Hi ${displayName},</h2>
        <p>A new version of the JIRAForge Desktop App is available!</p>
        <p>
            Current: <span style="color: #666;">${currentVersion}</span> →
            New: <span class="version-badge">${version}</span>
        </p>
        <div class="release-notes">
            <strong>What's new:</strong><br>
            ${releaseNotes}
        </div>
        <p><a href="${downloadUrl}" class="button">Download Update</a></p>
        <div class="footer">
            <p>Best regards,<br>The JIRAForge Team</p>
        </div>
    </div>
</body>
</html>
    `.trim()
};

// templates/inactivity-alert.js
module.exports = {
    subject: 'Are you taking a break? - JIRAForge',
    
    text: ({ displayName, lastActivityTime, hoursInactive }) => `
Hi ${displayName},

We noticed you haven't been active in JIRAForge for ${hoursInactive} hours.

Last activity: ${lastActivityTime}

If you're taking a well-deserved break, that's great! This is just a friendly reminder.

If you intended to track your work, please open the Desktop App to continue.

Best regards,
The JIRAForge Team

---
To adjust or disable these alerts, update your notification preferences in JIRAForge settings.
    `.trim(),
    
    html: ({ displayName, lastActivityTime, hoursInactive, settingsUrl }) => `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .alert-box { background: #FFF3CD; border: 1px solid #FFECB5; padding: 15px; border-radius: 4px; margin: 20px 0; }
        .footer { margin-top: 30px; color: #666; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h2>Hi ${displayName},</h2>
        <div class="alert-box">
            <p><strong>⏰ No activity detected for ${hoursInactive} hours</strong></p>
            <p style="margin: 0;">Last activity: ${lastActivityTime}</p>
        </div>
        <p>If you're taking a well-deserved break, that's great! This is just a friendly reminder.</p>
        <p>If you intended to track your work, please open the Desktop App to continue.</p>
        <div class="footer">
            <p>To adjust or disable these alerts, <a href="${settingsUrl}">update your notification preferences</a>.</p>
            <p>Best regards,<br>The JIRAForge Team</p>
        </div>
    </div>
</body>
</html>
    `.trim()
};
```

### 2.3 Notification Service (`notification-service.js`)

```javascript
/**
 * Notification Service
 * Handles business logic for sending notifications
 */

const notifmeWrapper = require('./notifme-wrapper');
const notificationDb = require('../db/notification-db-service');
const { getUserById } = require('../db/user-db-service');
const logger = require('../../utils/logger');

// Import templates
const loginReminderTemplate = require('./templates/login-reminder');
const downloadReminderTemplate = require('./templates/download-reminder');
const newVersionTemplate = require('./templates/new-version');
const inactivityAlertTemplate = require('./templates/inactivity-alert');

class NotificationService {
    constructor() {
        this.templates = {
            login_reminder: loginReminderTemplate,
            download_reminder: downloadReminderTemplate,
            new_version: newVersionTemplate,
            inactivity_alert: inactivityAlertTemplate
        };
    }

    /**
     * Send a notification with cooldown and preference checks
     */
    async sendNotification(userId, organizationId, type, data = {}) {
        try {
            // 1. Get user
            const user = await getUserById(userId);
            if (!user || !user.email) {
                logger.warn(`[Notification] No email for user ${userId}`);
                return { success: false, reason: 'no_email' };
            }

            // 2. Check preferences
            const prefs = await notificationDb.getUserPreferences(userId);
            const typeEnabled = prefs?.[`${type}_enabled`] !== false;
            if (!typeEnabled) {
                logger.info(`[Notification] ${type} disabled for user ${userId}`);
                return { success: false, reason: 'disabled_by_user' };
            }

            // 3. Check cooldown
            const cooldown = await notificationDb.checkCooldown(userId, type);
            if (cooldown.inCooldown) {
                logger.info(`[Notification] ${type} in cooldown for user ${userId}, next allowed: ${cooldown.nextAllowed}`);
                return { success: false, reason: 'cooldown', nextAllowed: cooldown.nextAllowed };
            }

            // 4. Check daily limit
            if (cooldown.todayCount >= (prefs?.max_daily_notifications || 5)) {
                logger.info(`[Notification] Daily limit reached for user ${userId}`);
                return { success: false, reason: 'daily_limit' };
            }

            // 5. Build email from template
            const template = this.templates[type];
            if (!template) {
                throw new Error(`Unknown notification type: ${type}`);
            }

            const templateData = {
                displayName: user.display_name || user.email.split('@')[0],
                ...data
            };

            const subject = typeof template.subject === 'function' 
                ? template.subject(templateData) 
                : template.subject;
            const text = template.text(templateData);
            const html = template.html(templateData);

            // 6. Log pending notification
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

            // 8. Update log and cooldown
            await notificationDb.updateLog(logEntry.id, {
                status: result.success ? 'sent' : 'failed',
                provider: result.provider,
                providerMessageId: result.messageId,
                errorMessage: result.errors?.[0]?.message,
                sentAt: result.success ? new Date().toISOString() : null
            });

            if (result.success) {
                await notificationDb.updateCooldown(userId, type);
            }

            logger.info(`[Notification] ${type} to ${user.email}: ${result.success ? 'sent' : 'failed'}`);
            return result;

        } catch (error) {
            logger.error(`[Notification] Error sending ${type} to user ${userId}:`, error);
            return { success: false, reason: 'error', error: error.message };
        }
    }

    /**
     * Send login reminder to a specific user
     */
    async sendLoginReminder(userId, organizationId) {
        const loginUrl = process.env.FORGE_APP_URL || 'https://jiraforge.io';
        return this.sendNotification(userId, organizationId, 'login_reminder', { loginUrl });
    }

    /**
     * Send download reminder to a specific user
     */
    async sendDownloadReminder(userId, organizationId, platform = 'Windows') {
        const downloadUrl = process.env.DOWNLOAD_URL || 'https://jiraforge.io/download';
        return this.sendNotification(userId, organizationId, 'download_reminder', { 
            downloadUrl, 
            platform 
        });
    }

    /**
     * Send new version notification
     */
    async sendNewVersionNotification(userId, organizationId, versionInfo) {
        return this.sendNotification(userId, organizationId, 'new_version', {
            version: versionInfo.version,
            releaseNotes: versionInfo.releaseNotes || 'Bug fixes and improvements',
            downloadUrl: versionInfo.downloadUrl,
            currentVersion: versionInfo.currentVersion
        });
    }

    /**
     * Send inactivity alert
     */
    async sendInactivityAlert(userId, organizationId, activityInfo) {
        const settingsUrl = process.env.SETTINGS_URL || 'https://jiraforge.io/settings';
        return this.sendNotification(userId, organizationId, 'inactivity_alert', {
            lastActivityTime: activityInfo.lastActivityTime,
            hoursInactive: activityInfo.hoursInactive,
            settingsUrl
        });
    }
}

module.exports = new NotificationService();
```

### 2.4 Notification Polling Service (`notification-polling.js`)

```javascript
/**
 * Notification Polling Service
 * Runs periodic checks for notification triggers
 */

const notificationService = require('./notification-service');
const notificationDb = require('../db/notification-db-service');
const { getClient } = require('../db/supabase-client');
const logger = require('../../utils/logger');

// Configuration
const POLLING_INTERVAL = 15 * 60 * 1000; // 15 minutes
const INACTIVITY_THRESHOLD_HOURS = 3.5;
const LOGIN_REMINDER_DAYS = 7; // Send reminder after 7 days of no login

class NotificationPollingService {
    constructor() {
        this.intervalId = null;
        this.isRunning = false;
    }

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
        this.runAllChecks();

        // Set up interval
        this.intervalId = setInterval(() => {
            this.runAllChecks();
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
     * Run all notification checks
     */
    async runAllChecks() {
        try {
            logger.info('[NotificationPolling] Running notification checks...');
            
            await Promise.all([
                this.checkLoginReminders(),
                this.checkDownloadReminders(),
                this.checkNewVersionNotifications(),
                this.checkInactivityAlerts()
            ]);

            logger.info('[NotificationPolling] Notification checks complete');
        } catch (error) {
            logger.error('[NotificationPolling] Error running checks:', error);
        }
    }

    /**
     * Check and send login reminders
     * Users who haven't logged in for X days
     */
    async checkLoginReminders() {
        try {
            const supabase = getClient();
            if (!supabase) return;

            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - LOGIN_REMINDER_DAYS);

            // Find users who haven't logged in recently and have email
            const { data: users, error } = await supabase
                .from('users')
                .select('id, organization_id, email, display_name, desktop_logged_in, desktop_last_heartbeat')
                .eq('is_active', true)
                .eq('desktop_logged_in', false)
                .not('email', 'is', null)
                .or(`desktop_last_heartbeat.is.null,desktop_last_heartbeat.lt.${cutoffDate.toISOString()}`);

            if (error) throw error;

            for (const user of (users || [])) {
                await notificationService.sendLoginReminder(user.id, user.organization_id);
            }

            logger.info(`[NotificationPolling] Login reminders: checked ${users?.length || 0} users`);
        } catch (error) {
            logger.error('[NotificationPolling] Error checking login reminders:', error);
        }
    }

    /**
     * Check and send download reminders
     * Users who have logged in but never downloaded the desktop app
     */
    async checkDownloadReminders() {
        try {
            const supabase = getClient();
            if (!supabase) return;

            // Find users who have logged in (have atlassian_account_id) but never used desktop app
            const { data: users, error } = await supabase
                .from('users')
                .select('id, organization_id, email, display_name, desktop_app_version, desktop_last_heartbeat')
                .eq('is_active', true)
                .not('email', 'is', null)
                .not('atlassian_account_id', 'is', null)
                .is('desktop_app_version', null);

            if (error) throw error;

            for (const user of (users || [])) {
                await notificationService.sendDownloadReminder(user.id, user.organization_id);
            }

            logger.info(`[NotificationPolling] Download reminders: checked ${users?.length || 0} users`);
        } catch (error) {
            logger.error('[NotificationPolling] Error checking download reminders:', error);
        }
    }

    /**
     * Check and send new version notifications
     * Users with outdated desktop app versions
     */
    async checkNewVersionNotifications() {
        try {
            const supabase = getClient();
            if (!supabase) return;

            // Get latest version
            const { data: latestRelease, error: releaseError } = await supabase
                .from('app_releases')
                .select('version, download_url, release_notes')
                .eq('platform', 'windows')
                .eq('is_latest', true)
                .eq('is_active', true)
                .single();

            if (releaseError || !latestRelease) {
                logger.debug('[NotificationPolling] No latest release found');
                return;
            }

            // Find users with older versions
            const { data: users, error } = await supabase
                .from('users')
                .select('id, organization_id, email, display_name, desktop_app_version')
                .eq('is_active', true)
                .eq('desktop_logged_in', true)
                .not('email', 'is', null)
                .not('desktop_app_version', 'is', null)
                .neq('desktop_app_version', latestRelease.version);

            if (error) throw error;

            for (const user of (users || [])) {
                // Check if user's version is actually older (semantic version compare)
                if (this._isVersionOlder(user.desktop_app_version, latestRelease.version)) {
                    await notificationService.sendNewVersionNotification(user.id, user.organization_id, {
                        version: latestRelease.version,
                        releaseNotes: latestRelease.release_notes,
                        downloadUrl: latestRelease.download_url,
                        currentVersion: user.desktop_app_version
                    });
                }
            }

            logger.info(`[NotificationPolling] Version notifications: checked ${users?.length || 0} users`);
        } catch (error) {
            logger.error('[NotificationPolling] Error checking version notifications:', error);
        }
    }

    /**
     * Check and send inactivity alerts
     * Users with desktop app logged in but no activity for 3.5+ hours
     */
    async checkInactivityAlerts() {
        try {
            const supabase = getClient();
            if (!supabase) return;

            const thresholdTime = new Date();
            thresholdTime.setHours(thresholdTime.getHours() - INACTIVITY_THRESHOLD_HOURS);

            // Find users who are logged in but haven't had recent heartbeats
            const { data: users, error } = await supabase
                .from('users')
                .select('id, organization_id, email, display_name, desktop_last_heartbeat')
                .eq('is_active', true)
                .eq('desktop_logged_in', true)
                .not('email', 'is', null)
                .lt('desktop_last_heartbeat', thresholdTime.toISOString());

            if (error) throw error;

            for (const user of (users || [])) {
                const lastActivity = new Date(user.desktop_last_heartbeat);
                const hoursInactive = Math.round((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60) * 10) / 10;

                // Only send during work hours (configurable per user)
                if (await this._isWithinWorkHours(user.id)) {
                    await notificationService.sendInactivityAlert(user.id, user.organization_id, {
                        lastActivityTime: lastActivity.toLocaleString(),
                        hoursInactive
                    });
                }
            }

            logger.info(`[NotificationPolling] Inactivity alerts: checked ${users?.length || 0} users`);
        } catch (error) {
            logger.error('[NotificationPolling] Error checking inactivity alerts:', error);
        }
    }

    /**
     * Compare semantic versions
     * @returns {boolean} True if v1 is older than v2
     */
    _isVersionOlder(v1, v2) {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);

        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            if (p1 < p2) return true;
            if (p1 > p2) return false;
        }
        return false;
    }

    /**
     * Check if current time is within user's work hours
     */
    async _isWithinWorkHours(userId) {
        try {
            const prefs = await notificationDb.getUserPreferences(userId);
            if (!prefs) return true; // Default to true if no preferences

            const now = new Date();
            const userTimezone = prefs.timezone || 'UTC';
            
            // Convert to user's timezone
            const userTime = new Date(now.toLocaleString('en-US', { timeZone: userTimezone }));
            const currentHour = userTime.getHours();
            const currentMinute = userTime.getMinutes();
            const currentDay = userTime.getDay() || 7; // Convert Sunday from 0 to 7

            // Check if it's a work day
            const workDays = prefs.work_days || [1, 2, 3, 4, 5];
            if (!workDays.includes(currentDay)) return false;

            // Parse work hours
            const [startHour, startMinute] = (prefs.work_hours_start || '09:00:00').split(':').map(Number);
            const [endHour, endMinute] = (prefs.work_hours_end || '18:00:00').split(':').map(Number);

            const currentMinutes = currentHour * 60 + currentMinute;
            const startMinutes = startHour * 60 + startMinute;
            const endMinutes = endHour * 60 + endMinute;

            return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
        } catch {
            return true; // Default to true on error
        }
    }
}

module.exports = new NotificationPollingService();
```

### 2.5 Notification DB Service (`db/notification-db-service.js`)

```javascript
/**
 * Notification Database Service
 * Database operations for notification tracking
 */

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

/**
 * Create a notification log entry
 */
async function createLog({ userId, organizationId, type, email, subject, metadata = {} }) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase
        .from('notification_logs')
        .insert({
            user_id: userId,
            organization_id: organizationId,
            notification_type: type,
            email_address: email,
            subject,
            metadata,
            status: 'pending'
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Update a notification log entry
 */
async function updateLog(logId, updates) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase
        .from('notification_logs')
        .update({
            status: updates.status,
            provider: updates.provider,
            provider_message_id: updates.providerMessageId,
            error_message: updates.errorMessage,
            sent_at: updates.sentAt,
            updated_at: new Date().toISOString()
        })
        .eq('id', logId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Get user notification preferences
 */
async function getUserPreferences(userId) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
}

/**
 * Check notification cooldown status
 */
async function checkCooldown(userId, notificationType) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase
        .from('notification_cooldowns')
        .select('*')
        .eq('user_id', userId)
        .eq('notification_type', notificationType)
        .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (!data) {
        return { inCooldown: false, todayCount: 0 };
    }

    const cooldownHours = data.cooldown_hours || 24;
    const lastSent = new Date(data.last_sent_at);
    const cooldownEnd = new Date(lastSent.getTime() + cooldownHours * 60 * 60 * 1000);
    const now = new Date();

    // Reset count if day changed
    const todayCount = data.count_reset_date === new Date().toISOString().split('T')[0]
        ? data.sent_today_count
        : 0;

    return {
        inCooldown: now < cooldownEnd,
        nextAllowed: cooldownEnd.toISOString(),
        todayCount
    };
}

/**
 * Update cooldown after sending notification
 */
async function updateCooldown(userId, notificationType) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    // Use the database function for atomic update
    const { error } = await supabase.rpc('update_notification_cooldown', {
        p_user_id: userId,
        p_notification_type: notificationType
    });

    if (error) throw error;
}

/**
 * Get notification history for a user
 */
async function getUserNotificationHistory(userId, limit = 50) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase
        .from('notification_logs')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

/**
 * Get organization notification statistics
 */
async function getOrganizationStats(organizationId, days = 30) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const { data, error } = await supabase
        .from('notification_logs')
        .select('notification_type, status')
        .eq('organization_id', organizationId)
        .gte('created_at', cutoffDate.toISOString());

    if (error) throw error;

    // Aggregate stats
    const stats = {
        total: data?.length || 0,
        byType: {},
        byStatus: {}
    };

    (data || []).forEach(log => {
        stats.byType[log.notification_type] = (stats.byType[log.notification_type] || 0) + 1;
        stats.byStatus[log.status] = (stats.byStatus[log.status] || 0) + 1;
    });

    return stats;
}

module.exports = {
    createLog,
    updateLog,
    getUserPreferences,
    checkCooldown,
    updateCooldown,
    getUserNotificationHistory,
    getOrganizationStats
};
```

---

## Phase 3: Environment Configuration

### Required Environment Variables

Add to `ai-server/.env`:

```env
# =============================================================================
# EMAIL NOTIFICATION CONFIGURATION
# =============================================================================

# Email Provider (sendgrid, mailgun, smtp, ses, sparkpost)
EMAIL_PROVIDER=sendgrid

# SendGrid Configuration
SENDGRID_API_KEY=your_sendgrid_api_key_here

# Mailgun Configuration (if using mailgun)
# MAILGUN_API_KEY=your_mailgun_api_key
# MAILGUN_DOMAIN=mg.yourdomain.com

# SMTP Configuration (if using smtp)
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=your@email.com
# SMTP_PASSWORD=your_password

# AWS SES Configuration (if using ses)
# AWS_REGION=us-east-1
# AWS_ACCESS_KEY_ID=your_access_key
# AWS_SECRET_ACCESS_KEY=your_secret_key

# SparkPost Configuration (if using sparkpost)
# SPARKPOST_API_KEY=your_sparkpost_api_key

# Email Sender Configuration
EMAIL_FROM=noreply@jiraforge.io
EMAIL_FROM_NAME=JIRAForge

# Notification Settings
NOTIFICATION_POLLING_ENABLED=true
NOTIFICATION_POLLING_INTERVAL=900000
INACTIVITY_THRESHOLD_HOURS=3.5
LOGIN_REMINDER_DAYS=7

# URLs for email templates
FORGE_APP_URL=https://jiraforge.atlassian.net
DOWNLOAD_URL=https://jiraforge.io/download
SETTINGS_URL=https://jiraforge.io/settings
```

---

## Phase 4: REST Controller (`notification-controller.js`)

```javascript
/**
 * Notification Controller
 * REST endpoints for notification management
 */

const notificationService = require('../services/notifications/notification-service');
const notificationDb = require('../services/db/notification-db-service');
const notificationPolling = require('../services/notifications/notification-polling');
const logger = require('../utils/logger');

/**
 * POST /api/notifications/send
 * Manually send a notification (admin only)
 */
exports.sendNotification = async (req, res) => {
    try {
        const { userId, organizationId, type, data } = req.body;

        if (!userId || !organizationId || !type) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, organizationId, type'
            });
        }

        const validTypes = ['login_reminder', 'download_reminder', 'new_version', 'inactivity_alert'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({
                success: false,
                error: `Invalid notification type. Must be one of: ${validTypes.join(', ')}`
            });
        }

        const result = await notificationService.sendNotification(userId, organizationId, type, data || {});

        res.json({
            success: result.success,
            data: result
        });
    } catch (error) {
        logger.error('[NotificationController] Send error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send notification'
        });
    }
};

/**
 * GET /api/notifications/history/:userId
 * Get notification history for a user
 */
exports.getHistory = async (req, res) => {
    try {
        const { userId } = req.params;
        const limit = parseInt(req.query.limit) || 50;

        const history = await notificationDb.getUserNotificationHistory(userId, limit);

        res.json({
            success: true,
            data: history
        });
    } catch (error) {
        logger.error('[NotificationController] History error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get notification history'
        });
    }
};

/**
 * GET /api/notifications/stats/:organizationId
 * Get notification statistics for an organization
 */
exports.getStats = async (req, res) => {
    try {
        const { organizationId } = req.params;
        const days = parseInt(req.query.days) || 30;

        const stats = await notificationDb.getOrganizationStats(organizationId, days);

        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        logger.error('[NotificationController] Stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get notification statistics'
        });
    }
};

/**
 * POST /api/notifications/preferences
 * Update user notification preferences
 */
exports.updatePreferences = async (req, res) => {
    try {
        const { userId, preferences } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: 'Missing userId'
            });
        }

        // TODO: Implement upsert for notification_preferences table
        res.json({
            success: true,
            message: 'Preferences updated'
        });
    } catch (error) {
        logger.error('[NotificationController] Preferences error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update preferences'
        });
    }
};

/**
 * POST /api/notifications/polling/start
 * Start the notification polling service (admin only)
 */
exports.startPolling = async (req, res) => {
    try {
        notificationPolling.start();
        res.json({
            success: true,
            message: 'Notification polling started'
        });
    } catch (error) {
        logger.error('[NotificationController] Start polling error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start polling'
        });
    }
};

/**
 * POST /api/notifications/polling/stop
 * Stop the notification polling service (admin only)
 */
exports.stopPolling = async (req, res) => {
    try {
        notificationPolling.stop();
        res.json({
            success: true,
            message: 'Notification polling stopped'
        });
    } catch (error) {
        logger.error('[NotificationController] Stop polling error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to stop polling'
        });
    }
};
```

---

## Phase 5: Tests

### 5.1 NotifMe Wrapper Tests (`tests/notifme-wrapper.test.js`)

```javascript
/**
 * Tests for NotifMe Wrapper
 */

const notifmeWrapper = require('../src/services/notifications/notifme-wrapper');

// Mock the NotifmeSdk
jest.mock('notifme-sdk', () => {
    return {
        default: jest.fn().mockImplementation(() => ({
            send: jest.fn().mockResolvedValue({
                status: 'success',
                id: 'mock-message-id-123'
            })
        }))
    };
});

describe('NotifMe Wrapper', () => {
    beforeEach(() => {
        // Reset environment
        process.env.EMAIL_PROVIDER = 'sendgrid';
        process.env.SENDGRID_API_KEY = 'test-api-key';
        process.env.EMAIL_FROM = 'test@jiraforge.io';
        process.env.EMAIL_FROM_NAME = 'JIRAForge Test';
    });

    describe('initialize()', () => {
        test('should initialize with sendgrid provider', () => {
            notifmeWrapper.initialize();
            expect(notifmeWrapper.getProvider()).toBe('sendgrid');
            expect(notifmeWrapper.initialized).toBe(true);
        });

        test('should initialize with different providers', () => {
            const providers = ['sendgrid', 'mailgun', 'smtp', 'ses', 'sparkpost'];
            providers.forEach(provider => {
                process.env.EMAIL_PROVIDER = provider;
                // Set required env vars for each provider
                if (provider === 'mailgun') {
                    process.env.MAILGUN_API_KEY = 'test';
                    process.env.MAILGUN_DOMAIN = 'test.com';
                }
                notifmeWrapper.initialize();
                expect(notifmeWrapper.getProvider()).toBe(provider);
            });
        });

        test('should throw for unsupported provider', () => {
            process.env.EMAIL_PROVIDER = 'invalid_provider';
            expect(() => notifmeWrapper._buildConfig('invalid_provider'))
                .toThrow('Unsupported email provider');
        });
    });

    describe('send()', () => {
        test('should send email successfully', async () => {
            notifmeWrapper.initialize();
            
            const result = await notifmeWrapper.send({
                to: 'user@example.com',
                subject: 'Test Subject',
                text: 'Test body',
                html: '<p>Test body</p>'
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('success');
            expect(result.messageId).toBe('mock-message-id-123');
            expect(result.provider).toBe('sendgrid');
        });

        test('should auto-initialize if not initialized', async () => {
            // Reset wrapper state
            notifmeWrapper.initialized = false;
            
            const result = await notifmeWrapper.send({
                to: 'user@example.com',
                subject: 'Test',
                text: 'Test'
            });

            expect(notifmeWrapper.initialized).toBe(true);
            expect(result.success).toBe(true);
        });

        test('should use default from address', async () => {
            notifmeWrapper.initialize();
            
            // The wrapper should use EMAIL_FROM from env
            const result = await notifmeWrapper.send({
                to: 'user@example.com',
                subject: 'Test',
                text: 'Test'
            });

            expect(result.success).toBe(true);
        });
    });

    describe('isConfigured()', () => {
        test('should return true when properly configured', () => {
            expect(notifmeWrapper.isConfigured()).toBe(true);
        });

        test('should return false when misconfigured', () => {
            process.env.EMAIL_PROVIDER = 'invalid';
            expect(notifmeWrapper.isConfigured()).toBe(false);
        });
    });
});
```

### 5.2 Notification Service Tests (`tests/notification-service.test.js`)

```javascript
/**
 * Tests for Notification Service
 */

const notificationService = require('../src/services/notifications/notification-service');
const notifmeWrapper = require('../src/services/notifications/notifme-wrapper');
const notificationDb = require('../src/services/db/notification-db-service');
const userDbService = require('../src/services/db/user-db-service');

// Mock dependencies
jest.mock('../src/services/notifications/notifme-wrapper');
jest.mock('../src/services/db/notification-db-service');
jest.mock('../src/services/db/user-db-service');

describe('Notification Service', () => {
    const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        display_name: 'Test User',
        organization_id: 'org-123'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Default mock implementations
        userDbService.getUserById.mockResolvedValue(mockUser);
        notificationDb.getUserPreferences.mockResolvedValue({
            login_reminder_enabled: true,
            download_reminder_enabled: true,
            new_version_enabled: true,
            inactivity_alert_enabled: true,
            max_daily_notifications: 5
        });
        notificationDb.checkCooldown.mockResolvedValue({
            inCooldown: false,
            todayCount: 0
        });
        notificationDb.createLog.mockResolvedValue({ id: 'log-123' });
        notificationDb.updateLog.mockResolvedValue({});
        notificationDb.updateCooldown.mockResolvedValue({});
        notifmeWrapper.send.mockResolvedValue({
            success: true,
            status: 'success',
            messageId: 'msg-123',
            provider: 'sendgrid'
        });
    });

    describe('sendNotification()', () => {
        test('should send notification successfully', async () => {
            const result = await notificationService.sendNotification(
                'user-123',
                'org-123',
                'login_reminder',
                { loginUrl: 'https://example.com' }
            );

            expect(result.success).toBe(true);
            expect(notificationDb.createLog).toHaveBeenCalled();
            expect(notifmeWrapper.send).toHaveBeenCalledWith(expect.objectContaining({
                to: 'test@example.com'
            }));
            expect(notificationDb.updateCooldown).toHaveBeenCalled();
        });

        test('should skip if user has no email', async () => {
            userDbService.getUserById.mockResolvedValue({ ...mockUser, email: null });

            const result = await notificationService.sendNotification(
                'user-123',
                'org-123',
                'login_reminder',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('no_email');
            expect(notifmeWrapper.send).not.toHaveBeenCalled();
        });

        test('should skip if notification type is disabled', async () => {
            notificationDb.getUserPreferences.mockResolvedValue({
                login_reminder_enabled: false
            });

            const result = await notificationService.sendNotification(
                'user-123',
                'org-123',
                'login_reminder',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('disabled_by_user');
        });

        test('should respect cooldown period', async () => {
            notificationDb.checkCooldown.mockResolvedValue({
                inCooldown: true,
                nextAllowed: '2026-02-26T00:00:00Z'
            });

            const result = await notificationService.sendNotification(
                'user-123',
                'org-123',
                'login_reminder',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('cooldown');
        });

        test('should respect daily limit', async () => {
            notificationDb.checkCooldown.mockResolvedValue({
                inCooldown: false,
                todayCount: 10
            });
            notificationDb.getUserPreferences.mockResolvedValue({
                login_reminder_enabled: true,
                max_daily_notifications: 5
            });

            const result = await notificationService.sendNotification(
                'user-123',
                'org-123',
                'login_reminder',
                {}
            );

            expect(result.success).toBe(false);
            expect(result.reason).toBe('daily_limit');
        });
    });

    describe('sendLoginReminder()', () => {
        test('should send login reminder with correct template', async () => {
            const result = await notificationService.sendLoginReminder('user-123', 'org-123');

            expect(result.success).toBe(true);
            expect(notifmeWrapper.send).toHaveBeenCalledWith(expect.objectContaining({
                subject: 'Reminder: Login to JIRAForge Time Tracker'
            }));
        });
    });

    describe('sendDownloadReminder()', () => {
        test('should send download reminder for Windows', async () => {
            const result = await notificationService.sendDownloadReminder('user-123', 'org-123', 'Windows');

            expect(result.success).toBe(true);
            expect(notifmeWrapper.send).toHaveBeenCalledWith(expect.objectContaining({
                subject: 'Download the JIRAForge Desktop App'
            }));
        });
    });

    describe('sendNewVersionNotification()', () => {
        test('should send version notification with version info', async () => {
            const versionInfo = {
                version: '2.0.0',
                releaseNotes: 'New features!',
                downloadUrl: 'https://example.com/download',
                currentVersion: '1.0.0'
            };

            const result = await notificationService.sendNewVersionNotification(
                'user-123',
                'org-123',
                versionInfo
            );

            expect(result.success).toBe(true);
        });
    });

    describe('sendInactivityAlert()', () => {
        test('should send inactivity alert with activity info', async () => {
            const activityInfo = {
                lastActivityTime: '2026-02-25 10:00:00',
                hoursInactive: 4.5
            };

            const result = await notificationService.sendInactivityAlert(
                'user-123',
                'org-123',
                activityInfo
            );

            expect(result.success).toBe(true);
        });
    });
});
```

### 5.3 Notification Polling Tests (`tests/notification-polling.test.js`)

```javascript
/**
 * Tests for Notification Polling Service
 */

const notificationPolling = require('../src/services/notifications/notification-polling');
const notificationService = require('../src/services/notifications/notification-service');
const notificationDb = require('../src/services/db/notification-db-service');
const { getClient } = require('../src/services/db/supabase-client');

// Mock dependencies
jest.mock('../src/services/notifications/notification-service');
jest.mock('../src/services/db/notification-db-service');
jest.mock('../src/services/db/supabase-client');

describe('Notification Polling Service', () => {
    let mockSupabase;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        // Mock Supabase client
        mockSupabase = {
            from: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            not: jest.fn().mockReturnThis(),
            or: jest.fn().mockReturnThis(),
            is: jest.fn().mockReturnThis(),
            lt: jest.fn().mockReturnThis(),
            neq: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({ data: null, error: null })
        };
        getClient.mockReturnValue(mockSupabase);

        // Default notification service mock
        notificationService.sendLoginReminder.mockResolvedValue({ success: true });
        notificationService.sendDownloadReminder.mockResolvedValue({ success: true });
        notificationService.sendNewVersionNotification.mockResolvedValue({ success: true });
        notificationService.sendInactivityAlert.mockResolvedValue({ success: true });
    });

    afterEach(() => {
        notificationPolling.stop();
        jest.useRealTimers();
    });

    describe('start() / stop()', () => {
        test('should start polling service', () => {
            notificationPolling.start();
            expect(notificationPolling.isRunning).toBe(true);
        });

        test('should not start if already running', () => {
            notificationPolling.start();
            notificationPolling.start();
            expect(notificationPolling.isRunning).toBe(true);
        });

        test('should stop polling service', () => {
            notificationPolling.start();
            notificationPolling.stop();
            expect(notificationPolling.isRunning).toBe(false);
        });
    });

    describe('checkLoginReminders()', () => {
        test('should send reminders to users who havent logged in', async () => {
            mockSupabase.single.mockResolvedValue({ data: null, error: null });
            mockSupabase.select.mockResolvedValue({
                data: [
                    { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com' },
                    { id: 'user-2', organization_id: 'org-1', email: 'user2@test.com' }
                ],
                error: null
            });

            await notificationPolling.checkLoginReminders();

            expect(notificationService.sendLoginReminder).toHaveBeenCalledTimes(2);
        });
    });

    describe('checkDownloadReminders()', () => {
        test('should send reminders to users who havent downloaded app', async () => {
            mockSupabase.select.mockResolvedValue({
                data: [
                    { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com' }
                ],
                error: null
            });

            await notificationPolling.checkDownloadReminders();

            expect(notificationService.sendDownloadReminder).toHaveBeenCalledTimes(1);
        });
    });

    describe('checkNewVersionNotifications()', () => {
        test('should notify users with older versions', async () => {
            // Mock latest release query
            mockSupabase.single.mockResolvedValue({
                data: {
                    version: '2.0.0',
                    download_url: 'https://example.com/download',
                    release_notes: 'New features'
                },
                error: null
            });

            // Mock users with older versions
            mockSupabase.select.mockResolvedValue({
                data: [
                    { id: 'user-1', organization_id: 'org-1', email: 'user1@test.com', desktop_app_version: '1.0.0' }
                ],
                error: null
            });

            await notificationPolling.checkNewVersionNotifications();

            expect(notificationService.sendNewVersionNotification).toHaveBeenCalled();
        });
    });

    describe('checkInactivityAlerts()', () => {
        test('should send alerts to inactive users', async () => {
            const threeHoursAgo = new Date();
            threeHoursAgo.setHours(threeHoursAgo.getHours() - 4);

            mockSupabase.select.mockResolvedValue({
                data: [
                    {
                        id: 'user-1',
                        organization_id: 'org-1',
                        email: 'user1@test.com',
                        desktop_last_heartbeat: threeHoursAgo.toISOString()
                    }
                ],
                error: null
            });

            notificationDb.getUserPreferences.mockResolvedValue({
                timezone: 'UTC',
                work_days: [1, 2, 3, 4, 5],
                work_hours_start: '00:00:00',
                work_hours_end: '23:59:59'
            });

            await notificationPolling.checkInactivityAlerts();

            expect(notificationService.sendInactivityAlert).toHaveBeenCalled();
        });
    });

    describe('_isVersionOlder()', () => {
        test('should correctly compare semantic versions', () => {
            expect(notificationPolling._isVersionOlder('1.0.0', '2.0.0')).toBe(true);
            expect(notificationPolling._isVersionOlder('1.0.0', '1.1.0')).toBe(true);
            expect(notificationPolling._isVersionOlder('1.0.0', '1.0.1')).toBe(true);
            expect(notificationPolling._isVersionOlder('2.0.0', '1.0.0')).toBe(false);
            expect(notificationPolling._isVersionOlder('1.0.0', '1.0.0')).toBe(false);
        });
    });
});
```

---

## Phase 6: Integration with ai-server

### Update `ai-server/src/index.js`

Add to the existing index.js:

```javascript
// Add imports at top
const notificationController = require('./controllers/notification-controller');
const notificationPollingService = require('./services/notifications/notification-polling');

// Add routes after other API routes
// =============================================================================
// NOTIFICATION ROUTES (Protected - requires authentication)
// =============================================================================

app.post('/api/notifications/send', authMiddleware, notificationController.sendNotification);
app.get('/api/notifications/history/:userId', authMiddleware, notificationController.getHistory);
app.get('/api/notifications/stats/:organizationId', authMiddleware, notificationController.getStats);
app.post('/api/notifications/preferences', authMiddleware, notificationController.updatePreferences);

// Admin routes for polling control
app.post('/api/notifications/polling/start', authMiddleware, notificationController.startPolling);
app.post('/api/notifications/polling/stop', authMiddleware, notificationController.stopPolling);

// Start notification polling on server startup
if (process.env.NOTIFICATION_POLLING_ENABLED === 'true') {
    notificationPollingService.start();
}
```

### Update `ai-server/package.json`

Add to dependencies:

```json
{
  "dependencies": {
    "notifme-sdk": "^1.11.0"
  }
}
```

---

## Phase 7: File Structure Summary

```
ai-server/
├── src/
│   ├── controllers/
│   │   └── notification-controller.js        # NEW - REST endpoints
│   ├── services/
│   │   ├── db/
│   │   │   └── notification-db-service.js    # NEW - DB operations
│   │   └── notifications/
│   │       ├── index.js                      # NEW - Main export
│   │       ├── notifme-wrapper.js            # NEW - Provider wrapper
│   │       ├── notification-service.js       # NEW - Business logic
│   │       ├── notification-polling.js       # NEW - Scheduled polling
│   │       └── templates/
│   │           ├── login-reminder.js         # NEW
│   │           ├── download-reminder.js      # NEW
│   │           ├── new-version.js            # NEW
│   │           └── inactivity-alert.js       # NEW
│   └── index.js                              # UPDATE - Add routes
├── tests/
│   ├── notifme-wrapper.test.js              # NEW
│   ├── notification-service.test.js          # NEW
│   └── notification-polling.test.js          # NEW
├── package.json                              # UPDATE - Add dependency
└── .env                                      # UPDATE - Add config

supabase/
└── migrations/
    └── 20260225_add_notification_tracking.sql # NEW - DB schema
```

---

## Implementation Timeline

| Phase | Task | Estimated Time |
|-------|------|----------------|
| 1 | Database Migration | 1 hour |
| 2.1 | NotifMe Wrapper | 2 hours |
| 2.2 | Email Templates | 2 hours |
| 2.3 | Notification Service | 3 hours |
| 2.4 | Polling Service | 3 hours |
| 2.5 | DB Service | 2 hours |
| 3 | Environment Config | 30 minutes |
| 4 | REST Controller | 2 hours |
| 5 | Test Suite | 4 hours |
| 6 | Integration | 2 hours |
| **Total** | | **~21 hours** |

---

## Testing Strategy

1. **Unit Tests**: Test each component in isolation with mocked dependencies
2. **Integration Tests**: Test the full notification flow with a test email provider
3. **Manual Testing**: 
   - Test each notification type with real SendGrid API
   - Verify email rendering in different email clients
   - Test cooldown and rate limiting behavior

---

## Security Considerations

1. **API Keys**: Store email provider API keys only in environment variables
2. **Rate Limiting**: Built-in cooldown and daily limits prevent abuse
3. **Data Privacy**: Email content doesn't include sensitive work data
4. **Preference Controls**: Users can disable notifications per-type
5. **Work Hours**: Inactivity alerts only sent during configured work hours

---

## Future Enhancements

1. **Multi-channel**: Extend notifme-sdk to support Slack, SMS, Push notifications
2. **Email Analytics**: Track open rates and click-through using SendGrid events
3. **Admin Dashboard**: Build UI for notification management in Forge app
4. **A/B Testing**: Test different email templates for engagement
5. **Webhook Events**: Receive SendGrid webhook events for bounce/complaint handling

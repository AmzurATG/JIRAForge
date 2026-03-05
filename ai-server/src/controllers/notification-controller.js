/**
 * Notification Controller
 * 
 * REST API endpoints for notification management.
 */

const express = require('express');
const router = express.Router();
const notificationService = require('../services/notifications/notification-service');
const notificationPollingService = require('../services/notifications/notification-polling');
const notificationDb = require('../services/db/notification-db-service');
const logger = require('../utils/logger');

/**
 * POST /notifications/send
 * Send a notification manually
 * 
 * Body: { type, userId, organizationId, data }
 */
router.post('/send', async (req, res) => {
    try {
        const { type, userId, organizationId, data } = req.body;

        if (!type || !userId || !organizationId) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: type, userId, organizationId'
            });
        }

        let result;
        switch (type) {
            case 'login_reminder':
                result = await notificationService.sendLoginReminder(userId, organizationId, data);
                break;
            case 'download_reminder':
                result = await notificationService.sendDownloadReminder(userId, organizationId, data?.platform || 'Windows');
                break;
            case 'new_version':
                result = await notificationService.sendNewVersionNotification(userId, organizationId, data);
                break;
            case 'inactivity_alert':
                result = await notificationService.sendInactivityAlert(userId, organizationId, data);
                break;
            default:
                return res.status(400).json({
                    success: false,
                    error: `Unknown notification type: ${type}`
                });
        }

        res.json(result);

    } catch (error) {
        logger.error('[NotificationController] Error sending notification:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /notifications/history/:userId
 * Get notification history for a user
 */
router.get('/history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 50, offset = 0, type } = req.query;


        const history = await notificationDb.getUserNotificationHistory(
            userId,
            Number.parseInt(limit, 10),
            Number.parseInt(offset, 10),
            type || null
        );

        res.json({
            success: true,
            data: history,
            pagination: {
                limit: Number.parseInt(limit, 10),
                offset: Number.parseInt(offset, 10),
                hasMore: history.length === Number.parseInt(limit, 10)
            }
        });

    } catch (error) {
        logger.error('[NotificationController] Error getting history:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /notifications/stats/:organizationId
 * Get notification statistics for an organization
 */
router.get('/stats/:organizationId', async (req, res) => {
    try {
        const { organizationId } = req.params;
        const { startDate, endDate } = req.query;

        const stats = await notificationDb.getOrganizationStats(
            organizationId,
            startDate || null,
            endDate || null
        );

        res.json({
            success: true,
            data: stats
        });

    } catch (error) {
        logger.error('[NotificationController] Error getting stats:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /notifications/preferences/:userId
 * Get notification preferences for a user
 */
router.get('/preferences/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const preferences = await notificationDb.getUserPreferences(userId);

        res.json({
            success: true,
            data: preferences || {
                email_enabled: true,
                login_reminder_enabled: true,
                download_reminder_enabled: true,
                new_version_enabled: true,
                inactivity_alert_enabled: true,
                work_hours_start: '09:00:00',
                work_hours_end: '18:00:00',
                work_days: [1, 2, 3, 4, 5],
                timezone: 'UTC'
            }
        });

    } catch (error) {
        logger.error('[NotificationController] Error getting preferences:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * PUT /notifications/preferences/:userId
 * Update notification preferences for a user
 */
router.put('/preferences/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const preferences = req.body;

        const { getClient } = require('../services/db/supabase-client');
        const supabase = getClient();
        
        if (!supabase) {
            return res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }

        const { data, error } = await supabase
            .from('notification_preferences')
            .upsert({
                user_id: userId,
                ...preferences,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' })
            .select()
            .single();

        if (error) {
            throw error;
        }

        res.json({
            success: true,
            data
        });

    } catch (error) {
        logger.error('[NotificationController] Error updating preferences:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /notifications/polling/status
 * Get notification polling service status
 */
router.get('/polling/status', (req, res) => {
    res.json({
        success: true,
        data: notificationPollingService.getStatus()
    });
});

/**
 * POST /notifications/polling/start
 * Start the notification polling service
 */
router.post('/polling/start', (req, res) => {
    try {
        notificationPollingService.start();
        res.json({
            success: true,
            message: 'Polling service started'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /notifications/polling/stop
 * Stop the notification polling service
 */
router.post('/polling/stop', (req, res) => {
    try {
        notificationPollingService.stop();
        res.json({
            success: true,
            message: 'Polling service stopped'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /notifications/polling/run
 * Trigger an immediate polling run
 */
router.post('/polling/run', async (req, res) => {
    try {
        const { type } = req.body;
        
        if (type) {
            await notificationPollingService.runSingleCheck(type);
        } else {
            await notificationPollingService.runAllChecks();
        }
        
        res.json({
            success: true,
            message: type ? `${type} check completed` : 'All checks completed'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * DELETE /notifications/cooldowns/:userId
 * Clear cooldowns for a user (admin function)
 */
router.delete('/cooldowns/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { type } = req.query;

        const { getClient } = require('../services/db/supabase-client');
        const supabase = getClient();
        
        if (!supabase) {
            return res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }

        let query = supabase
            .from('notification_cooldowns')
            .delete()
            .eq('user_id', userId);

        if (type) {
            query = query.eq('notification_type', type);
        }

        const { error } = await query;

        if (error) {
            throw error;
        }

        res.json({
            success: true,
            message: type 
                ? `${type} cooldown cleared for user` 
                : 'All cooldowns cleared for user'
        });

    } catch (error) {
        logger.error('[NotificationController] Error clearing cooldowns:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;

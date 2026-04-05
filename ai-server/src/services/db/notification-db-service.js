/**
 * Notification Database Service
 * 
 * Database operations for notification tracking, preferences, and cooldowns.
 * Uses the shared Supabase client from supabase-client.js.
 */

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

/**
 * Create a notification log entry
 * @param {Object} params - Log parameters
 * @param {string} params.userId - User ID
 * @param {string} params.organizationId - Organization ID
 * @param {string} params.type - Notification type
 * @param {string} params.email - Recipient email
 * @param {string} params.subject - Email subject
 * @param {Object} [params.metadata] - Additional metadata
 * @returns {Promise<Object>} Created log entry
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

    if (error) {
        logger.error('[NotificationDB] Error creating log:', error);
        throw error;
    }
    
    return data;
}

/**
 * Update a notification log entry
 * @param {string} logId - Log entry ID
 * @param {Object} updates - Fields to update
 * @param {string} [updates.status] - New status
 * @param {string} [updates.provider] - Provider used
 * @param {string} [updates.providerMessageId] - Provider's message ID
 * @param {string} [updates.errorMessage] - Error message if failed
 * @param {string} [updates.sentAt] - Timestamp when sent
 * @returns {Promise<Object>} Updated log entry
 */
async function updateLog(logId, updates) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const updateData = {
        updated_at: new Date().toISOString()
    };

    if (updates.status) updateData.status = updates.status;
    if (updates.provider) updateData.provider = updates.provider;
    if (updates.providerMessageId) updateData.provider_message_id = updates.providerMessageId;
    if (updates.errorMessage) updateData.error_message = updates.errorMessage;
    if (updates.sentAt) updateData.sent_at = updates.sentAt;

    const { data, error } = await supabase
        .from('notification_logs')
        .update(updateData)
        .eq('id', logId)
        .select()
        .single();

    if (error) {
        logger.error('[NotificationDB] Error updating log:', error);
        throw error;
    }
    
    return data;
}

/**
 * Get user notification preferences
 * @param {string} userId - User ID
 * @returns {Promise<Object|null>} User preferences or null if not set
 */
async function getUserPreferences(userId) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();

    // PGRST116 = no rows returned (not an error, just means no preferences set)
    if (error && error.code !== 'PGRST116') {
        logger.error('[NotificationDB] Error getting preferences:', error);
        throw error;
    }
    
    return data || null;
}

/**
 * Update or create user notification preferences
 * @param {string} userId - User ID
 * @param {string} organizationId - Organization ID
 * @param {Object} preferences - Preference values to update
 * @returns {Promise<Object>} Updated preferences
 */
async function upsertUserPreferences(userId, organizationId, preferences) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase
        .from('notification_preferences')
        .upsert({
            user_id: userId,
            organization_id: organizationId,
            ...preferences,
            updated_at: new Date().toISOString()
        }, {
            onConflict: 'user_id'
        })
        .select()
        .single();

    if (error) {
        logger.error('[NotificationDB] Error upserting preferences:', error);
        throw error;
    }
    
    return data;
}

/**
 * Check notification cooldown status for a user and notification type
 * @param {string} userId - User ID
 * @param {string} notificationType - Notification type
 * @returns {Promise<Object>} Cooldown status
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

    // PGRST116 = no rows returned (means no cooldown set yet)
    if (error && error.code !== 'PGRST116') {
        logger.error('[NotificationDB] Error checking cooldown:', error);
        throw error;
    }

    // No cooldown record exists - not in cooldown
    if (!data) {
        return { 
            inCooldown: false, 
            todayCount: 0,
            nextAllowed: null
        };
    }

    const cooldownHours = data.cooldown_hours || 24;
    const lastSent = new Date(data.last_sent_at);
    const cooldownEnd = new Date(lastSent.getTime() + cooldownHours * 60 * 60 * 1000);
    const now = new Date();

    // Check if day has changed - reset count if so
    const today = new Date().toISOString().split('T')[0];
    const countResetDate = data.count_reset_date;
    const todayCount = countResetDate === today ? data.sent_today_count : 0;

    return {
        inCooldown: now < cooldownEnd,
        nextAllowed: now < cooldownEnd ? cooldownEnd.toISOString() : null,
        todayCount,
        lastSentAt: data.last_sent_at
    };
}

/**
 * Update cooldown after sending a notification
 * Uses the database function for atomic updates.
 * @param {string} userId - User ID
 * @param {string} notificationType - Notification type
 * @param {number} [cooldownHours] - Custom cooldown hours (uses the 3-param DB overload). Omit for default (24h).
 * @returns {Promise<void>}
 */
async function updateCooldown(userId, notificationType, cooldownHours) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const rpcParams = {
        p_user_id: userId,
        p_notification_type: notificationType
    };

    // Use the 3-param overload when a custom cooldown is specified
    if (cooldownHours !== undefined) {
        rpcParams.p_cooldown_hours = cooldownHours;
    }

    const { error } = await supabase.rpc('update_notification_cooldown', rpcParams);

    if (error) {
        logger.error('[NotificationDB] Error updating cooldown:', error);
        throw error;
    }
}

/**
 * Get notification history for a user
 * @param {string} userId - User ID
 * @param {number} [limit=50] - Maximum number of records
 * @returns {Promise<Array>} Array of notification logs
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

    if (error) {
        logger.error('[NotificationDB] Error getting history:', error);
        throw error;
    }
    
    return data || [];
}

/**
 * Get organization notification statistics
 * @param {string} organizationId - Organization ID
 * @param {number} [days=30] - Number of days to include
 * @returns {Promise<Object>} Statistics object
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

    if (error) {
        logger.error('[NotificationDB] Error getting stats:', error);
        throw error;
    }

    // Aggregate statistics
    const stats = {
        total: data?.length || 0,
        byType: {},
        byStatus: {},
        period: `${days} days`
    };

    (data || []).forEach(log => {
        // Count by type
        stats.byType[log.notification_type] = (stats.byType[log.notification_type] || 0) + 1;
        // Count by status
        stats.byStatus[log.status] = (stats.byStatus[log.status] || 0) + 1;
    });

    return stats;
}

/**
 * Get pending notifications for retry
 * @param {number} [limit=100] - Maximum number of records
 * @returns {Promise<Array>} Array of pending notifications
 */
async function getPendingNotifications(limit = 100) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const { data, error } = await supabase
        .from('notification_logs')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(limit);

    if (error) {
        logger.error('[NotificationDB] Error getting pending:', error);
        throw error;
    }
    
    return data || [];
}

/**
 * Get recent notification of a specific type for a user
 * Used to check if we recently sent a similar notification
 * @param {string} userId - User ID
 * @param {string} notificationType - Notification type
 * @param {number} [hoursAgo=24] - Look back period in hours
 * @returns {Promise<Object|null>} Most recent notification or null
 */
async function getRecentNotification(userId, notificationType, hoursAgo = 24) {
    const supabase = getClient();
    if (!supabase) throw new Error('Supabase client not initialized');

    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hoursAgo);

    const { data, error } = await supabase
        .from('notification_logs')
        .select('*')
        .eq('user_id', userId)
        .eq('notification_type', notificationType)
        .eq('status', 'sent')
        .gte('sent_at', cutoffTime.toISOString())
        .order('sent_at', { ascending: false })
        .limit(1)
        .single();

    if (error && error.code !== 'PGRST116') {
        logger.error('[NotificationDB] Error getting recent notification:', error);
        throw error;
    }
    
    return data || null;
}

module.exports = {
    createLog,
    updateLog,
    getUserPreferences,
    upsertUserPreferences,
    checkCooldown,
    updateCooldown,
    getUserNotificationHistory,
    getOrganizationStats,
    getPendingNotifications,
    getRecentNotification
};

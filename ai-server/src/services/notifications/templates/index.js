/**
 * Email Templates Index
 * 
 * Exports all notification email templates
 */

const loginReminder = require('./login-reminder');
const downloadReminder = require('./download-reminder');
const newVersion = require('./new-version');
const inactivityAlert = require('./inactivity-alert');
const adminInactivityDigest = require('./admin-inactivity-digest');
const adminDownloadDigest = require('./admin-download-digest');
const defaultPasswordReminder = require('./default-password-reminder');
const approvalPendingDigest = require('./approval-pending-digest');
const adminInvite = require('./admin-invite');

module.exports = {
    loginReminder,
    downloadReminder,
    newVersion,
    inactivityAlert,
    adminInactivityDigest,
    adminDownloadDigest,
    defaultPasswordReminder,
    approvalPendingDigest,
    adminInvite,

    // Map by type for easy lookup
    byType: {
        'login_reminder': loginReminder,
        'download_reminder': downloadReminder,
        'new_version': newVersion,
        'inactivity_alert': inactivityAlert,
        'admin_inactivity_digest': adminInactivityDigest,
        'admin_download_digest': adminDownloadDigest,
        'default_password_reminder': defaultPasswordReminder,
        'approval_pending_digest': approvalPendingDigest,
        'admin_invite': adminInvite
    },
    
    // Get template by type
    getTemplate(type) {
        return this.byType[type] || null;
    },
    
    // Get all template types
    getTypes() {
        return Object.keys(this.byType);
    }
};

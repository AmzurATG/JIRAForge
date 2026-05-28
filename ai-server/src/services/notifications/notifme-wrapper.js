/**
 * Mail Service Wrapper (formerly NotifMe SDK Wrapper)
 * 
 * Migrated from notifme-sdk to use the new mail service adapter architecture.
 * Maintains backward compatibility with existing notification code.
 * 
 * Uses the new mail service with automatic fallback between providers.
 */

const mailService = require('../mail');
const logger = require('../../utils/logger');


class NotifMeWrapper {
    initialized = false;

    constructor() {
        // Initialization handled by class fields
    }

    /**
     * Initialize the mail service
     * Now uses the new mail adapter instead of notifme-sdk
     * @returns {NotifMeWrapper} Returns this for method chaining
     */
    initialize() {
        if (this.initialized) {
            return this;
        }

        try {
            // Verify mail service is configured
            const provider = process.env.MAIL_PRIMARY_PROVIDER || 'resend';
            this.initialized = true;
            
            logger.info(`[MailService] Initialized with provider: ${provider}`);
        } catch (error) {
            logger.error(`[MailService] Failed to initialize:`, error.message);
            throw error;
        }
        
        return this;
    }

    /**
     * Send an email using the new mail service adapter
     * @param {Object} options - Email options
     * @param {string} options.to - Recipient email address
     * @param {string} [options.from] - Sender email address (uses default if not provided)
     * @param {string} options.subject - Email subject line
     * @param {string} options.text - Plain text body
     * @param {string} [options.html] - HTML body (optional, falls back to text)
     * @returns {Promise<Object>} Send result with success status and provider info
     */
    async send({ to, from, subject, text, html }) {
        if (!this.initialized) {
            this.initialize();
        }

        const fromEmail = from || process.env.MAIL_FROM_ADDRESS || process.env.EMAIL_FROM || 'noreply@jiraforge.io';
        const fromName = process.env.MAIL_FROM_NAME || process.env.EMAIL_FROM_NAME || 'JIRAForge';

        try {
            const result = await mailService.send({
                to,
                from: fromEmail,
                fromName,
                subject,
                text,
                html: html || this._textToBasicHtml(text)
            });

            if (result.success) {
                logger.info(`[MailService] Email sent to ${to} via ${result.provider}`, {
                    status: 'success',
                    messageId: result.messageId
                });
            } else {
                logger.warn(`[MailService] Email to ${to} not successful`, {
                    status: 'error',
                    errors: { email: result.error }
                });
            }

            return {
                success: result.success,
                status: result.success ? 'success' : 'error',
                messageId: result.messageId || null,
                provider: result.provider,
                errors: result.success ? null : { email: result.error }
            };

        } catch (error) {
            logger.error(`[MailService] Failed to send email to ${to}:`, error);
            return {
                success: false,
                status: 'error',
                messageId: null,
                provider: 'none',
                errors: [{ message: error.message, code: error.code }]
            };
        }
    }

    /**
     * Convert plain text to basic HTML (for fallback)
     * @param {string} text - Plain text
     * @returns {string} Basic HTML
     */
    _textToBasicHtml(text) {
        if (!text) return '';
        return `<div style="font-family: sans-serif; white-space: pre-wrap;">${text.replaceAll('\n', '<br>')}</div>`;
    }

    /**
     * Send a batch of emails
     * @param {Array<Object>} emails - Array of email objects with to, subject, text, html
     * @returns {Promise<Array<Object>>} Array of send results
     */
    async sendBatch(emails) {
        const results = [];
        
        for (const email of emails) {
            const result = await this.send(email);
            results.push({
                to: email.to,
                ...result
            });
            
            // Small delay between emails to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        return results;
    }

    /**
     * Get current provider name
     * @returns {string|null} Provider name or null if not initialized
     */
    getProvider() {
        return process.env.MAIL_PRIMARY_PROVIDER || 'resend';
    }

    /**
     * Check if the mail service is properly configured
     * @returns {boolean} True if configuration is valid
     */
    isConfigured() {
        const resendKey = process.env.RESEND_API_KEY;
        const sendgridKey = process.env.SENDGRID_API_KEY;
        return Boolean(resendKey || sendgridKey);
    }

    /**
     * Check if notifications are enabled
     * @returns {boolean} True if EMAIL_NOTIFICATIONS_ENABLED is not explicitly 'false'
     */
    isEnabled() {
        return process.env.EMAIL_NOTIFICATIONS_ENABLED !== 'false';
    }

    /**
     * Reset the wrapper (useful for testing or reconfiguration)
     */
    reset() {
        // Reset state and log the reset action
        this.initialized = false;
        logger.info('[MailService] Wrapper state has been reset');
    }
}

// Export singleton instance
const notifmeWrapper = new NotifMeWrapper();
module.exports = notifmeWrapper;

// Also export the class for testing
module.exports.NotifMeWrapper = NotifMeWrapper;

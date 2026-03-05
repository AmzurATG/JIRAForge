/**
 * NotifMe SDK Wrapper
 * 
 * Abstracts email provider configuration for easy switching between providers.
 * Change EMAIL_PROVIDER env variable to switch providers without code changes.
 * 
 * Supported providers: sendgrid, mailgun, smtp, ses, sparkpost
 */

const NotifmeSdk = require('notifme-sdk').default;
const logger = require('../../utils/logger');


class NotifMeWrapper {
    sdk = null;
    provider = null;
    initialized = false;

    constructor() {
        // Initialization handled by class fields
    }

    /**
     * Initialize the SDK with environment-based configuration
     * Provider is determined by EMAIL_PROVIDER env variable
     * @returns {NotifMeWrapper} Returns this for method chaining
     */
    initialize() {
        if (this.initialized) {
            return this;
        }

        const provider = process.env.EMAIL_PROVIDER || 'sendgrid';
        
        try {
            const config = this._buildConfig(provider);
            
            this.sdk = new NotifmeSdk({
                channels: {
                    email: config
                }
            });
            
            this.provider = provider;
            this.initialized = true;
            
            logger.info(`[NotifMe] Initialized with provider: ${provider}`);
        } catch (error) {
            logger.error(`[NotifMe] Failed to initialize with provider ${provider}:`, error.message);
            throw error;
        }
        
        return this;
    }

    /**
     * Build provider-specific configuration from environment variables
     * @param {string} provider - Provider name
     * @returns {Object} Provider configuration for notifme-sdk
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
                    port: Number.parseInt(process.env.SMTP_PORT || '587', 10),
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
                    region: process.env.AWS_SES_REGION || process.env.AWS_REGION || 'us-east-1',
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
            throw new Error(`Unsupported email provider: ${provider}. Supported: ${Object.keys(configs).join(', ')}`);
        }

        // Validate required credentials based on provider
        this._validateConfig(provider, config);

        return config;
    }

    /**
     * Validate that required configuration is present
     * @param {string} provider - Provider name
     * @param {Object} config - Provider configuration
     */
    _validateConfig(provider, config) {
        const providerConfig = config.providers[0];
        
        const requiredFields = {
            sendgrid: ['apiKey'],
            mailgun: ['apiKey', 'domainName'],
            smtp: ['host', 'auth.user', 'auth.pass'],
            ses: ['accessKeyId', 'secretAccessKey'],
            sparkpost: ['apiKey']
        };

        const required = requiredFields[provider] || [];
        const missing = [];

        for (const field of required) {
            const value = field.includes('.') 
                ? field.split('.').reduce((obj, key) => obj?.[key], providerConfig)
                : providerConfig[field];
            
            if (!value) {
                missing.push(field);
            }
        }

        if (missing.length > 0) {
            logger.warn(`[NotifMe] Missing configuration for ${provider}: ${missing.join(', ')}`);
        }
    }

    /**
     * Send an email using the configured provider
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

        const fromEmail = from || process.env.EMAIL_FROM || 'noreply@jiraforge.io';
        const fromName = process.env.EMAIL_FROM_NAME || 'JIRAForge';

        try {
            const result = await this.sdk.send({
                email: {
                    from: `${fromName} <${fromEmail}>`,
                    to,
                    subject,
                    text,
                    html: html || this._textToBasicHtml(text)
                }
            });

            const success = result.status === 'success';
            
            if (success) {
                logger.info(`[NotifMe] Email sent to ${to} via ${this.provider}`, {
                    status: result.status,
                    messageId: result.id
                });
            } else {
                logger.warn(`[NotifMe] Email to ${to} not successful`, {
                    status: result.status,
                    errors: result.errors
                });
            }

            return {
                success,
                status: result.status,
                messageId: result.id || null,
                provider: this.provider,
                errors: result.errors || null
            };

        } catch (error) {
            logger.error(`[NotifMe] Failed to send email to ${to}:`, error);
            return {
                success: false,
                status: 'error',
                messageId: null,
                provider: this.provider,
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
        return this.provider;
    }

    /**
     * Check if the wrapper is properly configured for the current provider
     * @returns {boolean} True if configuration is valid
     */
    isConfigured() {
        try {
            const provider = process.env.EMAIL_PROVIDER || 'sendgrid';
            this._buildConfig(provider);
            return true;
        } catch {
            return false;
        }
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
        this.sdk = null;
        this.provider = null;
        this.initialized = false;
        logger.info('[NotifMe] Wrapper state has been reset');
    }
}

// Export singleton instance
const notifmeWrapper = new NotifMeWrapper();
module.exports = notifmeWrapper;

// Also export the class for testing
module.exports.NotifMeWrapper = NotifMeWrapper;

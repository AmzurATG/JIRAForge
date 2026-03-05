/**
 * NotifMe Wrapper with Multi-Provider Fallback Support
 * 
 * Enhanced version that supports multiple email providers with automatic failover.
 * This ensures email delivery even if your primary provider fails.
 * 
 * Features:
 * - Automatic fallback between providers
 * - Priority-based provider selection (lower number = higher priority)
 * - Round-robin load balancing (optional)
 * - Provider health tracking
 * - Supports: SendGrid, Mailgun, SMTP, AWS SES, SparkPost
 * 
 * Priority System Examples:
 * 
 * Method 1 - Explicit Priorities (Recommended):
 *   EMAIL_PROVIDERS=sendgrid,mailgun,smtp
 *   SENDGRID_PRIORITY=1     # Primary (tried first)
 *   MAILGUN_PRIORITY=50     # Fallback (tried second)
 *   SMTP_PRIORITY=99        # Last resort (tried third)
 * 
 * Method 2 - Array Order (Simple):
 *   EMAIL_PROVIDERS=sendgrid,mailgun,smtp
 *   # No priorities set = uses array order
 *   # sendgrid tried first, then mailgun, then smtp
 * 
 * Usage:
 * - Single provider: EMAIL_PROVIDER=sendgrid
 * - Multiple providers with fallback: EMAIL_PROVIDERS=sendgrid,mailgun,smtp
 * - Strategy: EMAIL_MULTI_PROVIDER_STRATEGY=fallback (default) or roundrobin
 */

const NotifmeSdk = require('notifme-sdk').default;
const logger = require('../../utils/logger');

class NotifMeWrapperEnhanced {
    sdk = null;
    providers = [];
    initialized = false;

    constructor() {
        // Class fields initialized above
    }

    /**
     * Initialize the NotifMe SDK with configured provider(s)
     * Supports multiple providers with automatic fallback
     * @returns {NotifMeWrapperEnhanced} this instance for chaining
     */
    initialize() {
        if (this.initialized) {
            return this;
        }

        try {
            // Get provider list (comma-separated for multiple providers)
            const providersEnv = process.env.EMAIL_PROVIDERS || process.env.EMAIL_PROVIDER || 'sendgrid';
            const providerList = providersEnv.split(',').map(p => p.trim().toLowerCase());
            
            const config = this._buildMultiProviderConfig(providerList);
            
            this.sdk = new NotifmeSdk({
                channels: {
                    email: config
                }
            });
            
            this.providers = providerList;
            this.initialized = true;
            
            if (providerList.length > 1) {
                logger.info(`[NotifMe] Initialized with ${providerList.length} providers (fallback chain): ${providerList.join(' -> ')}`);
            } else {
                logger.info(`[NotifMe] Initialized with provider: ${providerList[0]}`);
            }
        } catch (error) {
            logger.error(`[NotifMe] Failed to initialize:`, error.message);
            throw error;
        }
        
        return this;
    }

    /**
     * Build configuration with multiple providers for fallback
     * @param {string[]} providerList - Array of provider names in priority order
     * @returns {Object} NotifMe email channel configuration
     */
    _buildMultiProviderConfig(providerList) {
        const providers = [];
        const skipped = [];
        
        for (const provider of providerList) {
            try {
                const config = this._getProviderConfig(provider);
                if (config) {
                    providers.push(config);
                } else {
                    skipped.push(provider);
                }
            } catch (error) {
                logger.warn(`[NotifMe] Skipping provider ${provider}: ${error.message}`);
                skipped.push(provider);
            }
        }

        if (providers.length === 0) {
            throw new Error(`No valid email providers configured. Attempted: ${providerList.join(', ')}`);
        }

        if (skipped.length > 0) {
            logger.warn(`[NotifMe] Skipped providers due to missing credentials: ${skipped.join(', ')}`);
        }

        // Sort providers by priority (lower number = higher priority)
        // Providers without priority come after those with priority
        providers.sort((a, b) => {
            const priorityA = a.priority ?? 999;
            const priorityB = b.priority ?? 999;
            return priorityA - priorityB;
        });

        // Log the final priority order
        const priorityInfo = providers.map(p => {
            const priority = p.priority ? `(${p.priority})` : '';
            return `${p.type}${priority}`;
        }).join(' → ');
        logger.info(`[NotifMe] Provider priority order: ${priorityInfo}`);

        const strategy = process.env.EMAIL_MULTI_PROVIDER_STRATEGY || 'fallback';
        
        return {
            providers,
            // 'fallback': tries providers in order until one succeeds (RECOMMENDED for reliability)
            // 'roundrobin': distributes load across providers (for load balancing)
            // 'no-fallback': only uses first provider (legacy mode)
            multiProviderStrategy: strategy
        };
    }

    /**
     * Get individual provider configuration with priority support
     * @param {string} provider - Provider name
     * @returns {Object|null} Provider configuration or null if credentials missing
     */
    _getProviderConfig(provider) {
        const configBuilders = {
            sendgrid: this._buildSendGridConfig,
            mailgun: this._buildMailgunConfig,
            smtp: this._buildSmtpConfig,
            ses: this._buildSesConfig,
            sparkpost: this._buildSparkPostConfig
        };

        const builder = configBuilders[provider];
        if (!builder) {
            logger.warn(`[NotifMe] Unknown email provider: ${provider}`);
            return null;
        }

        const config = builder.call(this);
        if (!config) {
            return null;
        }

        // Add priority if specified (lower number = higher priority)
        // Environment variable format: SENDGRID_PRIORITY=1, SMTP_PRIORITY=99
        const priorityEnvVar = `${provider.toUpperCase()}_PRIORITY`;
        if (process.env[priorityEnvVar]) {
            config.priority = Number.parseInt(process.env[priorityEnvVar], 10);
        }

        return config;
    }

    _buildSendGridConfig() {
        if (!process.env.SENDGRID_API_KEY) {
            return null;
        }
        return {
            type: 'sendgrid',
            apiKey: process.env.SENDGRID_API_KEY
        };
    }

    _buildMailgunConfig() {
        if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
            return null;
        }
        return {
            type: 'mailgun',
            apiKey: process.env.MAILGUN_API_KEY,
            domainName: process.env.MAILGUN_DOMAIN
        };
    }

    _buildSmtpConfig() {
        if (!process.env.SMTP_HOST || !process.env.SMTP_PORT) {
            return null;
        }
        return {
            type: 'smtp',
            host: process.env.SMTP_HOST,
            port: Number.parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASSWORD
            }
        };
    }

    _buildSesConfig() {
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            return null;
        }
        return {
            type: 'ses',
            region: process.env.AWS_SES_REGION || process.env.AWS_REGION || 'us-east-1',
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN })
        };
    }

    _buildSparkPostConfig() {
        if (!process.env.SPARKPOST_API_KEY) {
            return null;
        }
        return {
            type: 'sparkpost',
            apiKey: process.env.SPARKPOST_API_KEY
        };
    }

    /**
     * Send an email using the configured provider(s)
     * Will automatically fallback to next provider if first fails (when configured)
     * @param {Object} options - Email options
     * @param {string} options.to - Recipient email address
     * @param {string} [options.from] - Sender email address (uses default if not provided)
     * @param {string} [options.fromName] - Sender name
     * @param {string} options.subject - Email subject line
     * @param {string} options.text - Plain text body
     * @param {string} [options.html] - HTML body (optional)
     * @param {string|string[]} [options.cc] - CC recipients
     * @param {string|string[]} [options.bcc] - BCC recipients
     * @returns {Promise<Object>} Send result with success status and provider info
     */
    async send({ to, from, fromName, subject, text, html, cc, bcc }) {
        if (!this.initialized) {
            this.initialize();
        }

        const fromEmail = from || process.env.EMAIL_FROM || 'noreply@jiraforge.io';
        const senderName = fromName || process.env.EMAIL_FROM_NAME || 'JIRAForge';

        try {
            const emailPayload = {
                from: `${senderName} <${fromEmail}>`,
                to,
                subject,
                text,
                html: html || this._textToBasicHtml(text)
            };

            // Add CC/BCC if provided
            if (cc) {
                emailPayload.cc = Array.isArray(cc) ? cc : [cc];
            }
            if (bcc) {
                emailPayload.bcc = Array.isArray(bcc) ? bcc : [bcc];
            }

            const result = await this.sdk.send({
                email: emailPayload
            });

            const success = result.status === 'success';
            
            if (success) {
                const usedProvider = result.channels?.email?.provider || this.providers[0];
                logger.info(`[NotifMe] Email sent to ${to} via ${usedProvider}`, {
                    status: result.status,
                    messageId: result.channels?.email?.id
                });
                
                return {
                    success: true,
                    messageId: result.channels?.email?.id,
                    provider: usedProvider,
                    status: result.status
                };
            } else {
                logger.error('[NotifMe] Email send failed', result);
                return {
                    success: false,
                    error: result.info?.error || 'Unknown error',
                    status: result.status
                };
            }
        } catch (error) {
            logger.error('[NotifMe] Email send exception:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Convert plain text to basic HTML for email fallback
     * @param {string} text - Plain text content
     * @returns {string} Basic HTML version
     */
    _textToBasicHtml(text) {
        if (!text) return '';
        return text
            .split('\n\n')
            .map(para => `<p>${para.replaceAll('\n', '<br>')}</p>`)
            .join('');
    }

    /**
     * Get status information about the wrapper
     * @returns {Object} Status info including providers and initialization state
     */
    getStatus() {
        return {
            initialized: this.initialized,
            providers: this.providers,
            multiProviderStrategy: process.env.EMAIL_MULTI_PROVIDER_STRATEGY || 'fallback',
            fromEmail: process.env.EMAIL_FROM || 'noreply@jiraforge.io',
            fromName: process.env.EMAIL_FROM_NAME || 'JIRAForge'
        };
    }
}

// Export singleton instance
const notifmeWrapperEnhanced = new NotifMeWrapperEnhanced();
module.exports = notifmeWrapperEnhanced;

// Also export class for testing
module.exports.NotifMeWrapperEnhanced = NotifMeWrapperEnhanced;

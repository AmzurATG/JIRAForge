/**
 * MailService - Central mail service manager with automatic fallback
 * 
 * Provides a unified interface for sending emails with automatic provider
 * selection and fallback handling. Business modules use this service without
 * needing to know about specific mail providers.
 */

const SendGridAdapter = require('./SendGridAdapter');
const ResendAdapter = require('./ResendAdapter');

class MailService {
  constructor(config = {}) {
    this.config = {
      primaryProvider: config.primaryProvider || process.env.MAIL_PRIMARY_PROVIDER || 'sendgrid',
      fallbackProvider: config.fallbackProvider || process.env.MAIL_FALLBACK_PROVIDER || 'resend',
      enableFallback: config.enableFallback !== false,
      logEnabled: config.logEnabled !== false,
    };

    // Initialize adapters
    this.adapters = this._initializeAdapters();
    
    // Track provider health (circuit breaker pattern)
    this.providerHealth = {
      sendgrid: { failures: 0, lastFailure: null },
      resend: { failures: 0, lastFailure: null },
    };
    
    this.MAX_FAILURES = 3;
    this.CIRCUIT_RESET_TIME = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Initialize all available adapters
   */
  _initializeAdapters() {
    return {
      sendgrid: new SendGridAdapter(),
      resend: new ResendAdapter(),
    };
  }

  /**
   * Get the primary adapter based on configuration
   */
  _getPrimaryAdapter() {
    const providerName = this.config.primaryProvider.toLowerCase();
    return this.adapters[providerName];
  }

  /**
   * Get the fallback adapter based on configuration
   */
  _getFallbackAdapter() {
    const providerName = this.config.fallbackProvider.toLowerCase();
    return this.adapters[providerName];
  }

  /**
   * Check if a provider is healthy (circuit breaker check)
   */
  _isProviderHealthy(providerName) {
    const health = this.providerHealth[providerName];
    if (!health) return true;

    // Reset circuit if enough time has passed
    if (health.lastFailure && Date.now() - health.lastFailure > this.CIRCUIT_RESET_TIME) {
      health.failures = 0;
      health.lastFailure = null;
      return true;
    }

    return health.failures < this.MAX_FAILURES;
  }

  /**
   * Record a provider failure
   */
  _recordFailure(providerName) {
    if (this.providerHealth[providerName]) {
      this.providerHealth[providerName].failures++;
      this.providerHealth[providerName].lastFailure = Date.now();
    }
  }

  /**
   * Record a provider success (reset failure count)
   */
  _recordSuccess(providerName) {
    if (this.providerHealth[providerName]) {
      this.providerHealth[providerName].failures = 0;
      this.providerHealth[providerName].lastFailure = null;
    }
  }

  /**
   * Log operation (can be replaced with proper logger)
   */
  _log(level, message, data = {}) {
    if (!this.config.logEnabled) return;
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...data,
    };
    
    console[level === 'error' ? 'error' : 'log']('[MailService]', JSON.stringify(logEntry, null, 2));
  }

  /**
   * Validate email options
   */
  _validateMailOptions(mailOptions) {
    if (!mailOptions.to) {
      throw new Error('Recipient email (to) is required');
    }
    if (!mailOptions.subject) {
      throw new Error('Email subject is required');
    }
    if (!mailOptions.html && !mailOptions.text) {
      throw new Error('Email content (html or text) is required');
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(mailOptions.to)) {
      throw new Error(`Invalid recipient email format: ${mailOptions.to}`);
    }
  }

  /**
   * Send email with automatic provider selection and fallback
   * 
   * @param {Object} mailOptions - Email parameters
   * @returns {Promise<SendResult>}
   */
  async send(mailOptions) {
    try {
      this._validateMailOptions(mailOptions);
    } catch (error) {
      this._log('error', 'Email validation failed', { error: error.message });
      return {
        success: false,
        error: error.message,
        provider: 'none',
      };
    }

    const primary = this._getPrimaryAdapter();
    const primaryName = this.config.primaryProvider.toLowerCase();

    // Try primary provider if healthy and configured
    if (primary && primary.isConfigured() && this._isProviderHealthy(primaryName)) {
      this._log('info', 'Attempting to send email via primary provider', {
        provider: primary.getProviderName(),
        to: mailOptions.to,
        subject: mailOptions.subject,
      });

      const result = await primary.send(mailOptions);

      if (result.success) {
        this._recordSuccess(primaryName);
        this._log('info', 'Email sent successfully via primary provider', {
          provider: result.provider,
          messageId: result.messageId,
        });
        return result;
      } else {
        this._recordFailure(primaryName);
        this._log('error', 'Primary provider failed', {
          provider: result.provider,
          error: result.error,
        });
      }
    }

    // Try fallback provider if enabled
    if (this.config.enableFallback) {
      const fallback = this._getFallbackAdapter();
      const fallbackName = this.config.fallbackProvider.toLowerCase();

      if (fallback && fallback.isConfigured() && this._isProviderHealthy(fallbackName)) {
        this._log('info', 'Attempting fallback provider', {
          provider: fallback.getProviderName(),
        });

        const result = await fallback.send(mailOptions);

        if (result.success) {
          this._recordSuccess(fallbackName);
          this._log('info', 'Email sent successfully via fallback provider', {
            provider: result.provider,
            messageId: result.messageId,
          });
          return result;
        } else {
          this._recordFailure(fallbackName);
          this._log('error', 'Fallback provider also failed', {
            provider: result.provider,
            error: result.error,
          });
        }
      }
    }

    // All providers failed
    this._log('error', 'All mail providers failed or unavailable');
    return {
      success: false,
      error: 'All mail providers failed or unavailable',
      provider: 'none',
    };
  }

  /**
   * Send multiple emails in batch
   * 
   * @param {Array} mailOptionsList - Array of email parameters
   * @returns {Promise<SendResult[]>}
   */
  async sendBatch(mailOptionsList) {
    const results = [];
    
    for (const mailOptions of mailOptionsList) {
      const result = await this.send(mailOptions);
      results.push(result);
    }

    return results;
  }

  /**
   * Verify that at least one provider is available
   * 
   * @returns {Promise<Object>}
   */
  async verifyProviders() {
    const status = {};

    for (const [name, adapter] of Object.entries(this.adapters)) {
      const isConfigured = adapter.isConfigured();
      const isHealthy = await adapter.verifyConnection();
      
      status[name] = {
        configured: isConfigured,
        healthy: isHealthy,
        available: isConfigured && isHealthy,
      };
    }

    return {
      primary: this.config.primaryProvider,
      fallback: this.config.fallbackProvider,
      providers: status,
    };
  }

  /**
   * Get current provider health status
   */
  getHealthStatus() {
    return {
      providers: this.providerHealth,
      config: this.config,
    };
  }
}

// Export singleton instance
let instance = null;

module.exports = {
  MailService,
  getInstance: (config) => {
    if (!instance) {
      instance = new MailService(config);
    }
    return instance;
  },
  resetInstance: () => {
    instance = null;
  },
};

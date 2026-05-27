/**
 * IMailAdapter - Base interface for all mail service adapters
 * 
 * Defines the contract that all mail provider adapters must implement.
 * Following the Adapter Pattern to enable plug-and-play mail providers.
 */

/**
 * @typedef {Object} MailOptions
 * @property {string} to - Recipient email address
 * @property {string} subject - Email subject line
 * @property {string} html - HTML content of the email
 * @property {string} [text] - Plain text content (optional, fallback for HTML)
 * @property {string} [from] - Sender email (optional, uses default if not provided)
 * @property {string} [fromName] - Sender name (optional)
 * @property {string} [replyTo] - Reply-to email address (optional)
 */

/**
 * @typedef {Object} SendResult
 * @property {boolean} success - Whether the email was sent successfully
 * @property {string} [messageId] - Provider's message ID (if available)
 * @property {string} [error] - Error message (if failed)
 * @property {string} provider - Name of the provider used
 */

/**
 * Base Mail Adapter Interface
 * 
 * All concrete adapters must implement these methods.
 */
class IMailAdapter {
  /**
   * Send a single email
   * 
   * @param {MailOptions} mailOptions - Email parameters
   * @returns {Promise<SendResult>}
   */
  async send(mailOptions) {
    throw new Error('Method send() must be implemented by adapter');
  }

  /**
   * Send multiple emails in batch
   * 
   * @param {MailOptions[]} mailOptionsList - Array of email parameters
   * @returns {Promise<SendResult[]>}
   */
  async sendBatch(mailOptionsList) {
    throw new Error('Method sendBatch() must be implemented by adapter');
  }

  /**
   * Verify connection/credentials with the mail provider
   * 
   * @returns {Promise<boolean>}
   */
  async verifyConnection() {
    throw new Error('Method verifyConnection() must be implemented by adapter');
  }

  /**
   * Get the provider name for logging and identification
   * 
   * @returns {string}
   */
  getProviderName() {
    throw new Error('Method getProviderName() must be implemented by adapter');
  }

  /**
   * Check if the adapter is properly configured
   * 
   * @returns {boolean}
   */
  isConfigured() {
    throw new Error('Method isConfigured() must be implemented by adapter');
  }
}

module.exports = IMailAdapter;

/**
 * SendGridAdapter - SendGrid mail provider adapter
 * 
 * Implements IMailAdapter interface using SendGrid API.
 */

const sgMail = require('@sendgrid/mail');
const IMailAdapter = require('./IMailAdapter');

class SendGridAdapter extends IMailAdapter {
  constructor(config = {}) {
    super();
    this.apiKey = config.hasOwnProperty('apiKey') ? config.apiKey : process.env.SENDGRID_API_KEY;
    this.defaultFrom = config.defaultFrom || process.env.MAIL_FROM_ADDRESS || 'noreply@example.com';
    this.defaultFromName = config.defaultFromName || process.env.MAIL_FROM_NAME || 'Amzur Time Tracker';
    
    if (this.apiKey) {
      sgMail.setApiKey(this.apiKey);
    }
  }

  /**
   * Send a single email via SendGrid
   */
  async send(mailOptions) {
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'SendGrid adapter not configured - missing API key',
        provider: this.getProviderName(),
      };
    }

    try {
      const msg = {
        to: mailOptions.to,
        from: {
          email: mailOptions.from || this.defaultFrom,
          name: mailOptions.fromName || this.defaultFromName,
        },
        subject: mailOptions.subject,
        html: mailOptions.html,
        text: mailOptions.text,
      };

      if (mailOptions.replyTo) {
        msg.replyTo = mailOptions.replyTo;
      }

      const response = await sgMail.send(msg);
      
      return {
        success: true,
        messageId: response[0]?.headers?.[('x-message-id')] || 'sendgrid-success',
        provider: this.getProviderName(),
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'SendGrid send failed',
        provider: this.getProviderName(),
      };
    }
  }

  /**
   * Send multiple emails in batch via SendGrid
   */
  async sendBatch(mailOptionsList) {
    if (!this.isConfigured()) {
      return mailOptionsList.map(() => ({
        success: false,
        error: 'SendGrid adapter not configured - missing API key',
        provider: this.getProviderName(),
      }));
    }

    const results = [];
    
    for (const mailOptions of mailOptionsList) {
      const result = await this.send(mailOptions);
      results.push(result);
    }

    return results;
  }

  /**
   * Verify SendGrid API key is valid
   */
  async verifyConnection() {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      // SendGrid doesn't have a dedicated ping endpoint, so we'll just check the API key format
      // A real verification would require sending a test email or calling an API endpoint
      return this.apiKey && this.apiKey.startsWith('SG.');
    } catch (error) {
      return false;
    }
  }

  /**
   * Get provider name
   */
  getProviderName() {
    return 'SendGrid';
  }

  /**
   * Check if adapter is configured with required credentials
   */
  isConfigured() {
    return Boolean(this.apiKey);
  }
}

module.exports = SendGridAdapter;

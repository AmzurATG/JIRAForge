/**
 * ResendAdapter - Resend mail provider adapter
 * 
 * Implements IMailAdapter interface using Resend API.
 */

const { Resend } = require('resend');
const IMailAdapter = require('./IMailAdapter');

class ResendAdapter extends IMailAdapter {
  constructor(config = {}) {
    super();
    this.apiKey = config.hasOwnProperty('apiKey') ? config.apiKey : process.env.RESEND_API_KEY;
    this.defaultFrom = config.defaultFrom || process.env.MAIL_FROM_ADDRESS || 'noreply@example.com';
    this.defaultFromName = config.defaultFromName || process.env.MAIL_FROM_NAME || 'Amzur Time Tracker';
    
    if (this.apiKey) {
      this.client = new Resend(this.apiKey);
    }
  }

  /**
   * Send a single email via Resend
   */
  async send(mailOptions) {
    if (!this.isConfigured()) {
      return {
        success: false,
        error: 'Resend adapter not configured - missing API key',
        provider: this.getProviderName(),
      };
    }

    try {
      const fromAddress = mailOptions.fromName 
        ? `${mailOptions.fromName} <${mailOptions.from || this.defaultFrom}>`
        : mailOptions.from || this.defaultFrom;

      const emailData = {
        from: fromAddress,
        to: mailOptions.to,
        subject: mailOptions.subject,
        html: mailOptions.html,
      };

      // Add optional fields
      if (mailOptions.text) {
        emailData.text = mailOptions.text;
      }

      if (mailOptions.replyTo) {
        emailData.reply_to = mailOptions.replyTo;
      }

      console.log('[ResendAdapter] Sending email:', {
        to: emailData.to,
        from: emailData.from,
        subject: emailData.subject
      });

      const response = await this.client.emails.send(emailData);
      
      console.log('[ResendAdapter] Resend API response:', JSON.stringify(response, null, 2));
      
      // Check if Resend returned an error (Resend SDK wraps errors in response.error)
      if (response.error) {
        console.error('[ResendAdapter] Resend API returned error:', response.error);
        return {
          success: false,
          error: response.error.message || 'Resend API error',
          provider: this.getProviderName(),
        };
      }
      
      // Success - get message ID from response.data.id or response.id
      const messageId = response.data?.id || response.id;
      
      return {
        success: true,
        messageId: messageId || 'resend-success',
        provider: this.getProviderName(),
      };
    } catch (error) {
      console.error('[ResendAdapter] Resend API error:', {
        message: error.message,
        statusCode: error.statusCode,
        response: error.response?.data || error.response,
        stack: error.stack
      });
      
      return {
        success: false,
        error: error.message || 'Resend send failed',
        provider: this.getProviderName(),
      };
    }
  }

  /**
   * Send multiple emails in batch via Resend
   */
  async sendBatch(mailOptionsList) {
    if (!this.isConfigured()) {
      return mailOptionsList.map(() => ({
        success: false,
        error: 'Resend adapter not configured - missing API key',
        provider: this.getProviderName(),
      }));
    }

    const results = [];
    
    // Resend supports batch sending, but for consistency with interface,
    // we'll process sequentially to maintain individual result tracking
    for (const mailOptions of mailOptionsList) {
      const result = await this.send(mailOptions);
      results.push(result);
    }

    return results;
  }

  /**
   * Verify Resend API key is valid
   */
  async verifyConnection() {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      // Resend doesn't have a dedicated ping endpoint
      // We verify by checking if the API key exists and is properly formatted
      return this.apiKey && this.apiKey.startsWith('re_');
    } catch (error) {
      return false;
    }
  }

  /**
   * Get provider name
   */
  getProviderName() {
    return 'Resend';
  }

  /**
   * Check if adapter is configured with required credentials
   */
  isConfigured() {
    return Boolean(this.apiKey);
  }
}

module.exports = ResendAdapter;

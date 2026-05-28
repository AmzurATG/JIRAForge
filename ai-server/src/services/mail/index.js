/**
 * Mail Service - Central export
 * 
 * Provides easy access to the mail service singleton.
 * Business modules should import from this file.
 * 
 * Usage:
 * ```javascript
 * const mailService = require('./services/mail');
 * 
 * await mailService.send({
 *   to: 'user@example.com',
 *   subject: 'Welcome!',
 *   html: '<h1>Hello World</h1>',
 *   text: 'Hello World'
 * });
 * ```
 */

const { getInstance } = require('./MailService');

// Export singleton instance
module.exports = getInstance();

// Also export classes for testing and advanced usage
module.exports.MailService = require('./MailService').MailService;
module.exports.SendGridAdapter = require('./SendGridAdapter');
module.exports.ResendAdapter = require('./ResendAdapter');
module.exports.IMailAdapter = require('./IMailAdapter');

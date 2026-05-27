# Mail Service Adapter - Usage Guide

## Overview

The Mail Service provides a robust, provider-agnostic email sending system with automatic fallback handling. It implements the **Adapter Pattern** to allow seamless switching between email providers (SendGrid, Resend) with zero changes to business logic.

## Features

- ✅ **Multiple Providers**: SendGrid and Resend adapters
- ✅ **Automatic Fallback**: Switches to backup provider on failure
- ✅ **Circuit Breaker**: Automatically skips unhealthy providers
- ✅ **Validation**: Email format and required field validation
- ✅ **Batch Sending**: Send multiple emails efficiently
- ✅ **Health Monitoring**: Track provider status and failures
- ✅ **Zero Coupling**: Business modules don't depend on specific SDKs
- ✅ **Extensible**: Add new providers with minimal changes

## Quick Start

### 1. Environment Configuration

Add to `.env`:

```env
# Primary mail provider (sendgrid or resend)
MAIL_PRIMARY_PROVIDER=sendgrid

# Fallback mail provider (sendgrid or resend)
MAIL_FALLBACK_PROVIDER=resend

# SendGrid API Key (get from: https://app.sendgrid.com/settings/api_keys)
SENDGRID_API_KEY=SG.your_api_key_here

# Resend API Key (get from: https://resend.com/api-keys)
RESEND_API_KEY=re_your_api_key_here

# Default sender information
MAIL_FROM_ADDRESS=noreply@yourdomain.com
MAIL_FROM_NAME=Productivity Portal
```

### 2. Install Dependencies

```bash
npm install
```

Required packages:
- `@sendgrid/mail` - SendGrid SDK
- `resend` - Resend SDK

### 3. Basic Usage

```javascript
const mailService = require('./services/mail');

// Send a single email
async function sendWelcomeEmail(userEmail, userName) {
  const result = await mailService.send({
    to: userEmail,
    subject: 'Welcome to Productivity Portal',
    html: `<h1>Welcome ${userName}!</h1><p>Thanks for joining.</p>`,
    text: `Welcome ${userName}! Thanks for joining.`,
  });

  if (result.success) {
    console.log(`Email sent via ${result.provider}`);
  } else {
    console.error(`Failed to send email: ${result.error}`);
  }

  return result;
}
```

## API Reference

### mailService.send(mailOptions)

Send a single email.

**Parameters:**

```typescript
mailOptions: {
  to: string;           // Recipient email (required)
  subject: string;      // Email subject (required)
  html: string;         // HTML content (required if text not provided)
  text?: string;        // Plain text content (optional)
  from?: string;        // Sender email (optional, uses default)
  fromName?: string;    // Sender name (optional, uses default)
  replyTo?: string;     // Reply-to address (optional)
}
```

**Returns:**

```typescript
{
  success: boolean;     // Whether email was sent successfully
  messageId?: string;   // Provider's message ID (if successful)
  error?: string;       // Error message (if failed)
  provider: string;     // Provider name used ('SendGrid', 'Resend', or 'none')
}
```

**Example:**

```javascript
const result = await mailService.send({
  to: 'user@example.com',
  subject: 'Password Reset',
  html: '<p>Click <a href="...">here</a> to reset your password.</p>',
  text: 'Click here to reset your password: ...',
  replyTo: 'support@yourdomain.com',
});
```

### mailService.sendBatch(mailOptionsList)

Send multiple emails.

**Parameters:**

```typescript
mailOptionsList: Array<mailOptions>
```

**Returns:**

```typescript
Array<SendResult>
```

**Example:**

```javascript
const results = await mailService.sendBatch([
  {
    to: 'user1@example.com',
    subject: 'Weekly Report',
    html: '<p>Your report...</p>',
  },
  {
    to: 'user2@example.com',
    subject: 'Weekly Report',
    html: '<p>Your report...</p>',
  },
]);

console.log(`Sent ${results.filter(r => r.success).length} emails successfully`);
```

### mailService.verifyProviders()

Check health and configuration status of all providers.

**Returns:**

```typescript
{
  primary: string;      // Primary provider name
  fallback: string;     // Fallback provider name
  providers: {
    sendgrid: {
      configured: boolean;
      healthy: boolean;
      available: boolean;
    },
    resend: {
      configured: boolean;
      healthy: boolean;
      available: boolean;
    }
  }
}
```

**Example:**

```javascript
const status = await mailService.verifyProviders();
console.log('Mail Service Status:', JSON.stringify(status, null, 2));
```

### mailService.getHealthStatus()

Get current circuit breaker status and failure tracking.

**Returns:**

```typescript
{
  providers: {
    sendgrid: { failures: number, lastFailure: number | null },
    resend: { failures: number, lastFailure: number | null }
  },
  config: {
    primaryProvider: string,
    fallbackProvider: string,
    enableFallback: boolean,
    logEnabled: boolean
  }
}
```

## Real-World Examples

### Password Reset Email

```javascript
async function sendPasswordResetEmail(user, resetToken) {
  const resetUrl = `${process.env.PORTAL_URL}/reset-password?token=${resetToken}`;
  
  const result = await mailService.send({
    to: user.email,
    subject: 'Password Reset Request',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Password Reset Request</h2>
        <p>Hi ${user.name},</p>
        <p>You requested to reset your password. Click the button below to proceed:</p>
        <a href="${resetUrl}" 
           style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; 
                  color: white; text-decoration: none; border-radius: 4px; margin: 16px 0;">
          Reset Password
        </a>
        <p>This link will expire in 1 hour.</p>
        <p>If you didn't request this, please ignore this email.</p>
        <hr style="margin: 20px 0;">
        <p style="color: #666; font-size: 12px;">
          Productivity Portal Team<br>
          This is an automated message, please do not reply.
        </p>
      </div>
    `,
    text: `
      Password Reset Request
      
      Hi ${user.name},
      
      You requested to reset your password. Visit this link to proceed:
      ${resetUrl}
      
      This link will expire in 1 hour.
      
      If you didn't request this, please ignore this email.
      
      ---
      Productivity Portal Team
    `,
    replyTo: 'support@yourdomain.com',
  });

  return result;
}
```

### Weekly Report Email

```javascript
async function sendWeeklyReports(employees, reports) {
  const emailPromises = employees.map((employee, index) => {
    const report = reports[index];
    
    return {
      to: employee.email,
      subject: `Your Weekly Productivity Report - ${report.weekEnding}`,
      html: `
        <h2>Weekly Productivity Report</h2>
        <p>Hi ${employee.name},</p>
        <p>Here's your productivity summary for the week ending ${report.weekEnding}:</p>
        <table style="border-collapse: collapse; width: 100%;">
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Total Hours</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${report.totalHours}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Productive Hours</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${report.productiveHours}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #ddd;"><strong>Productivity %</strong></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${report.productivityPercentage}%</td>
          </tr>
        </table>
        <p>Keep up the great work!</p>
      `,
    };
  });

  const results = await mailService.sendBatch(emailPromises);
  
  const successCount = results.filter(r => r.success).length;
  console.log(`Sent ${successCount}/${results.length} weekly reports`);
  
  return results;
}
```

### Account Notification

```javascript
async function sendAccountNotification(user, notificationType, data) {
  const templates = {
    'account-created': {
      subject: 'Welcome to Productivity Portal',
      html: `<h2>Welcome aboard!</h2><p>Your account has been created.</p>`,
    },
    'account-deleted': {
      subject: 'Account Deletion Confirmation',
      html: `<p>Your account has been deleted as requested.</p>`,
    },
    'data-export-ready': {
      subject: 'Your Data Export is Ready',
      html: `<p>Your data export is ready. <a href="${data.downloadUrl}">Download here</a></p>`,
    },
  };

  const template = templates[notificationType];
  
  const result = await mailService.send({
    to: user.email,
    subject: template.subject,
    html: template.html,
  });

  return result;
}
```

## Advanced Configuration

### Custom Provider Configuration

```javascript
const { MailService } = require('./services/mail/MailService');

const customMailService = new MailService({
  primaryProvider: 'resend',
  fallbackProvider: 'sendgrid',
  enableFallback: true,
  logEnabled: true,
});

// Use custom instance
await customMailService.send({ ... });
```

### Adding a New Provider

To add a new email provider (e.g., Mailgun):

1. **Create adapter** (`src/services/mail/MailgunAdapter.js`):

```javascript
const IMailAdapter = require('./IMailAdapter');

class MailgunAdapter extends IMailAdapter {
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey || process.env.MAILGUN_API_KEY;
    // Initialize Mailgun client...
  }

  async send(mailOptions) {
    // Implement send logic
  }

  async sendBatch(mailOptionsList) {
    // Implement batch send
  }

  async verifyConnection() {
    // Implement verification
  }

  getProviderName() {
    return 'Mailgun';
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }
}

module.exports = MailgunAdapter;
```

2. **Register in MailService** (`src/services/mail/MailService.js`):

```javascript
const MailgunAdapter = require('./MailgunAdapter');

_initializeAdapters() {
  return {
    sendgrid: new SendGridAdapter(),
    resend: new ResendAdapter(),
    mailgun: new MailgunAdapter(),  // Add new adapter
  };
}
```

3. **Update environment** (`.env`):

```env
MAIL_PRIMARY_PROVIDER=mailgun
MAILGUN_API_KEY=key-your_mailgun_api_key
```

## Testing

Run tests:

```bash
npm test -- tests/portal/mail/
```

Run specific adapter test:

```bash
npm test -- tests/portal/mail/SendGridAdapter.test.js
```

## Troubleshooting

### No emails being sent

1. Check environment variables are set:
   ```bash
   echo $SENDGRID_API_KEY
   echo $RESEND_API_KEY
   ```

2. Verify provider status:
   ```javascript
   const status = await mailService.verifyProviders();
   console.log(status);
   ```

3. Check circuit breaker status:
   ```javascript
   const health = mailService.getHealthStatus();
   console.log(health);
   ```

### Fallback not working

- Ensure `enableFallback` is not explicitly set to `false`
- Verify fallback provider is configured with valid API key
- Check fallback provider hasn't also tripped the circuit breaker

### Invalid API key errors

- SendGrid keys start with `SG.`
- Resend keys start with `re_`
- Verify keys in provider dashboards

## Best Practices

1. **Always provide both HTML and text**: Improves deliverability
2. **Use descriptive subjects**: Clear, concise subject lines
3. **Monitor provider health**: Set up alerts for circuit breaker trips
4. **Test with real emails**: Use personal emails in development
5. **Handle failures gracefully**: Always check `result.success`
6. **Use batching for bulk emails**: More efficient than individual sends
7. **Keep email content simple**: Avoid complex CSS, large images
8. **Include unsubscribe links**: Required for marketing emails

## Security Considerations

- Never log API keys or email content containing PII
- Store API keys in environment variables, never in code
- Validate recipient emails to prevent injection attacks
- Rate limit email sending to prevent abuse
- Use HTTPS for all links in emails
- Implement SPF, DKIM, and DMARC records for your domain

## License

MIT

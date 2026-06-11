/**
 * Mail Service Integration Examples
 * 
 * This file demonstrates practical usage of the mail service
 * in various portal scenarios.
 */

const mailService = require('./index');

/**
 * Example 1: Send password reset email
 */
async function sendPasswordResetEmail(userEmail, userName, resetToken) {
  const resetUrl = `${process.env.PORTAL_URL || 'http://localhost:3001'}/reset-password?token=${resetToken}`;
  
  const result = await mailService.send({
    to: userEmail,
    subject: 'Password Reset Request - Amzur Time Tracker',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: white; margin: 0;">Password Reset</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="margin-top: 0;">Hi ${userName},</p>
            <p>We received a request to reset your password for your Amzur Time Tracker account.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" 
                 style="display: inline-block; padding: 14px 32px; background-color: #667eea; 
                        color: white; text-decoration: none; border-radius: 6px; font-weight: bold;
                        box-shadow: 0 4px 6px rgba(50, 50, 93, 0.11);">
                Reset Your Password
              </a>
            </div>
            <p style="color: #666; font-size: 14px;">
              <strong>This link will expire in 1 hour.</strong>
            </p>
            <p style="color: #666; font-size: 14px;">
              If you didn't request this password reset, please ignore this email or contact support if you have concerns.
            </p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
            <p style="color: #999; font-size: 12px; margin-bottom: 0;">
              Amzur Time Tracker Team<br>
              This is an automated message, please do not reply to this email.
            </p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
Password Reset Request

Hi ${userName},

We received a request to reset your password for your Amzur Time Tracker account.

Click here to reset your password:
${resetUrl}

This link will expire in 1 hour.

If you didn't request this password reset, please ignore this email.

---
Amzur Time Tracker Team
This is an automated message, please do not reply to this email.
    `.trim(),
    replyTo: process.env.MAIL_SUPPORT_ADDRESS || 'support@example.com',
  });

  return result;
}

/**
 * Example 2: Send welcome email to new user
 */
async function sendWelcomeEmail(userEmail, userName, orgName) {
  const loginUrl = `${process.env.PORTAL_URL || 'http://localhost:3001'}/login`;
  
  const result = await mailService.send({
    to: userEmail,
    subject: `Welcome to ${orgName} - Amzur Time Tracker`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #667eea;">Welcome to Amzur Time Tracker!</h1>
          <p>Hi ${userName},</p>
          <p>Your account has been created for <strong>${orgName}</strong>.</p>
          <h3>What's Next?</h3>
          <ul>
            <li>Log in to your dashboard at <a href="${loginUrl}">${loginUrl}</a></li>
            <li>Review your productivity analytics</li>
            <li>Configure your preferences</li>
            <li>Generate custom reports</li>
          </ul>
          <p>If you have any questions, our support team is here to help!</p>
          <div style="margin-top: 30px; padding: 20px; background: #f5f5f5; border-radius: 6px;">
            <p style="margin: 0; color: #666; font-size: 14px;">
              Need help? Visit our <a href="#">Help Center</a> or contact us at support@example.com
            </p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
Welcome to Amzur Time Tracker!

Hi ${userName},

Your account has been created for ${orgName}.

What's Next?
- Log in to your dashboard at ${loginUrl}
- Review your productivity analytics
- Configure your preferences
- Generate custom reports

If you have any questions, our support team is here to help!

Need help? Contact us at support@example.com
    `.trim(),
  });

  return result;
}

/**
 * Example 3: Send weekly report notification
 */
async function sendWeeklyReportNotification(employees, weekEnding) {
  const emails = employees.map(employee => ({
    to: employee.email,
    subject: `Your Weekly Productivity Report - Week Ending ${weekEnding}`,
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2>Weekly Productivity Report</h2>
          <p>Hi ${employee.name},</p>
          <p>Your productivity summary for the week ending <strong>${weekEnding}</strong>:</p>
          
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr style="background: #667eea; color: white;">
              <th style="padding: 12px; text-align: left; border: 1px solid #ddd;">Metric</th>
              <th style="padding: 12px; text-align: right; border: 1px solid #ddd;">Value</th>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd;">Total Hours Tracked</td>
              <td style="padding: 10px; text-align: right; border: 1px solid #ddd; font-weight: bold;">
                ${employee.stats.totalHours.toFixed(1)}h
              </td>
            </tr>
            <tr style="background: #f9f9f9;">
              <td style="padding: 10px; border: 1px solid #ddd;">Productive Hours</td>
              <td style="padding: 10px; text-align: right; border: 1px solid #ddd; font-weight: bold; color: #4caf50;">
                ${employee.stats.productiveHours.toFixed(1)}h
              </td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd;">Productivity Rate</td>
              <td style="padding: 10px; text-align: right; border: 1px solid #ddd; font-weight: bold;">
                ${employee.stats.productivityPercentage.toFixed(1)}%
              </td>
            </tr>
          </table>

          <p style="color: #666; font-size: 14px;">
            View your detailed analytics in the <a href="${process.env.PORTAL_URL}/dashboard">dashboard</a>.
          </p>

          <p>Keep up the great work! 🎉</p>
        </div>
      </body>
      </html>
    `,
    text: `
Weekly Productivity Report

Hi ${employee.name},

Your productivity summary for the week ending ${weekEnding}:

Total Hours Tracked: ${employee.stats.totalHours.toFixed(1)}h
Productive Hours: ${employee.stats.productiveHours.toFixed(1)}h
Productivity Rate: ${employee.stats.productivityPercentage.toFixed(1)}%

View your detailed analytics in the dashboard: ${process.env.PORTAL_URL}/dashboard

Keep up the great work!
    `.trim(),
  }));

  const results = await mailService.sendBatch(emails);
  
  const successCount = results.filter(r => r.success).length;
  console.log(`[WeeklyReport] Sent ${successCount}/${results.length} emails successfully`);
  
  // Log failures
  results.forEach((result, index) => {
    if (!result.success) {
      console.error(`[WeeklyReport] Failed to send to ${employees[index].email}: ${result.error}`);
    }
  });

  return {
    total: results.length,
    successful: successCount,
    failed: results.length - successCount,
    results,
  };
}

/**
 * Example 4: Send account deletion confirmation
 */
async function sendAccountDeletionConfirmation(userEmail, userName) {
  const result = await mailService.send({
    to: userEmail,
    subject: 'Account Deletion Confirmation - Amzur Time Tracker',
    html: `
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2>Account Deletion Confirmation</h2>
          <p>Hi ${userName},</p>
          <p>This email confirms that your Amzur Time Tracker account has been permanently deleted as per your request.</p>
          
          <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
            <p style="margin: 0; color: #856404;">
              <strong>Important:</strong> All your data, including activity logs, reports, and settings have been removed from our systems.
            </p>
          </div>

          <p>If you deleted your account by mistake or wish to return in the future, you'll need to create a new account.</p>
          
          <p>Thank you for using Amzur Time Tracker. We're sorry to see you go!</p>
          
          <p style="margin-top: 30px; color: #666; font-size: 14px;">
            If you didn't request this deletion, please contact support immediately at support@example.com
          </p>
        </div>
      </body>
      </html>
    `,
    text: `
Account Deletion Confirmation

Hi ${userName},

This email confirms that your Amzur Time Tracker account has been permanently deleted as per your request.

IMPORTANT: All your data, including activity logs, reports, and settings have been removed from our systems.

If you deleted your account by mistake or wish to return in the future, you'll need to create a new account.

Thank you for using Amzur Time Tracker. We're sorry to see you go!

If you didn't request this deletion, please contact support immediately at support@example.com
    `.trim(),
  });

  return result;
}

/**
 * Example 5: Health check and provider status
 */
async function checkMailServiceHealth() {
  console.log('=== Mail Service Health Check ===\n');

  // Check provider configuration
  const providerStatus = await mailService.verifyProviders();
  console.log('Provider Configuration:');
  console.log(`  Primary: ${providerStatus.primary}`);
  console.log(`  Fallback: ${providerStatus.fallback}\n`);

  console.log('Provider Status:');
  Object.entries(providerStatus.providers).forEach(([name, status]) => {
    const statusIcon = status.available ? '✅' : '❌';
    console.log(`  ${statusIcon} ${name}:`);
    console.log(`     Configured: ${status.configured}`);
    console.log(`     Healthy: ${status.healthy}`);
    console.log(`     Available: ${status.available}`);
  });

  // Check circuit breaker status
  const health = mailService.getHealthStatus();
  console.log('\nCircuit Breaker Status:');
  Object.entries(health.providers).forEach(([name, status]) => {
    console.log(`  ${name}:`);
    console.log(`     Failures: ${status.failures}`);
    console.log(`     Last Failure: ${status.lastFailure ? new Date(status.lastFailure).toISOString() : 'None'}`);
  });

  return providerStatus;
}

// Export examples for use in other modules
module.exports = {
  sendPasswordResetEmail,
  sendWelcomeEmail,
  sendWeeklyReportNotification,
  sendAccountDeletionConfirmation,
  checkMailServiceHealth,
};

// Example: Run health check if executed directly
if (require.main === module) {
  checkMailServiceHealth()
    .then(() => {
      console.log('\n✅ Health check complete');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Health check failed:', error);
      process.exit(1);
    });
}

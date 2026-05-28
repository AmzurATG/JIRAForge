/**
 * Send a test email using the configured Resend credentials
 * 
 * Usage:
 *   node send-test-email.js your-email@example.com
 */

require('dotenv').config();
const mailService = require('./src/services/mail');

const recipientEmail = process.argv[2];

if (!recipientEmail) {
  console.error('❌ Error: Please provide a recipient email address');
  console.log('\nUsage:');
  console.log('  node send-test-email.js your-email@example.com');
  process.exit(1);
}

async function sendTestEmail() {
  console.log('📧 Sending test email...\n');
  console.log(`   To: ${recipientEmail}`);
  console.log(`   From: ${process.env.MAIL_FROM_ADDRESS}`);
  console.log(`   Provider: ${process.env.MAIL_PRIMARY_PROVIDER}\n`);

  const result = await mailService.send({
    to: recipientEmail,
    subject: 'Test Email from Productivity Portal',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: white; margin: 0;">✅ Mail Service Test</h1>
        </div>
        <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
          <h2 style="color: #667eea; margin-top: 0;">Success!</h2>
          <p>This is a test email from the <strong>Productivity Portal</strong> mail service.</p>
          
          <div style="background: #f5f5f5; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <p style="margin: 0; font-family: monospace; font-size: 14px;"><strong>Configuration:</strong></p>
            <ul style="font-family: monospace; font-size: 13px; color: #666;">
              <li>Provider: Resend</li>
              <li>From: ${process.env.MAIL_FROM_ADDRESS}</li>
              <li>Status: ✅ Working</li>
            </ul>
          </div>

          <h3 style="color: #667eea;">Features Verified:</h3>
          <ul>
            <li>✅ Resend API integration</li>
            <li>✅ HTML email rendering</li>
            <li>✅ Configuration loading</li>
            <li>✅ Automatic provider selection</li>
          </ul>

          <p style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0; color: #666; font-size: 12px;">
            <strong>Productivity Portal Mail Service</strong><br>
            Powered by Resend • Adapter Pattern Architecture
          </p>
        </div>
      </body>
      </html>
    `,
    text: `
✅ Mail Service Test - Success!

This is a test email from the Productivity Portal mail service.

Configuration:
- Provider: Resend
- From: ${process.env.MAIL_FROM_ADDRESS}
- Status: ✅ Working

Features Verified:
✅ Resend API integration
✅ HTML email rendering
✅ Configuration loading
✅ Automatic provider selection

---
Productivity Portal Mail Service
Powered by Resend • Adapter Pattern Architecture
    `.trim(),
  });

  if (result.success) {
    console.log('✅ Email sent successfully!\n');
    console.log(`   Provider: ${result.provider}`);
    console.log(`   Message ID: ${result.messageId}\n`);
    console.log('📬 Check your inbox!');
  } else {
    console.error('❌ Failed to send email\n');
    console.error(`   Error: ${result.error}`);
    console.error(`   Provider: ${result.provider}`);
    process.exit(1);
  }
}

sendTestEmail().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});

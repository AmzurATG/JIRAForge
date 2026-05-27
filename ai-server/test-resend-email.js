/**
 * Test Resend API directly to verify email delivery
 */

require('dotenv').config();
const mailService = require('./src/services/mail');

async function testResendEmail() {
  console.log('📧 Testing Resend Email Delivery\n');

  const testEmail = 'pushpanacharla@gmail.com'; // Your email from the logs

  console.log(`Sending test email to: ${testEmail}`);
  console.log(`From: ${process.env.MAIL_FROM_ADDRESS}`);
  console.log(`API Key: ${process.env.RESEND_API_KEY ? 'Set (starts with: ' + process.env.RESEND_API_KEY.substring(0, 10) + '...)' : 'NOT SET'}\n`);

  try {
    const result = await mailService.send({
      to: testEmail,
      subject: '🧪 Test Email from Productivity Portal',
      html: `
        <!DOCTYPE html>
        <html>
        <body style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #667eea;">✅ Resend Test Successful!</h2>
          <p>This email confirms that your Resend configuration is working correctly.</p>
          <div style="background: #f0f0f0; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Configuration Details:</strong></p>
            <ul>
              <li>Provider: Resend</li>
              <li>From: ${process.env.MAIL_FROM_ADDRESS}</li>
              <li>Status: ✅ Active</li>
            </ul>
          </div>
          <p>If you're seeing this, your email system is working perfectly!</p>
        </body>
        </html>
      `,
      text: `
✅ Resend Test Successful!

This email confirms that your Resend configuration is working correctly.

Configuration Details:
- Provider: Resend
- From: ${process.env.MAIL_FROM_ADDRESS}
- Status: ✅ Active

If you're seeing this, your email system is working perfectly!
      `.trim()
    });

    console.log('\n📊 Result:');
    console.log(`  Success: ${result.success}`);
    console.log(`  Provider: ${result.provider}`);
    console.log(`  Message ID: ${result.messageId || 'N/A'}`);
    
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }

    if (result.success) {
      console.log('\n✅ Email sent successfully!');
      console.log('📬 Check your inbox (and spam folder) for the test email.');
      console.log('\nNote: Email delivery may take a few seconds to a few minutes.');
    } else {
      console.log('\n❌ Email send failed!');
      console.log('Check the error message above for details.');
    }

  } catch (error) {
    console.error('\n❌ Unexpected error:', error.message);
    console.error('Stack:', error.stack);
  }
}

testResendEmail();

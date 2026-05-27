/**
 * Test sending email to Resend account owner (test mode)
 */

require('dotenv').config();
const mailService = require('./src/services/mail');

async function testAccountOwnerEmail() {
  console.log('📧 Testing Resend in Test Mode\n');

  // In test mode, can only send to the account owner
  const accountOwnerEmail = 'solutions.atg@amzur.com';

  console.log('⚠️  RESEND TEST MODE ACTIVE');
  console.log('   Can only send to account owner email\n');
  console.log(`Sending test email to: ${accountOwnerEmail}`);
  console.log(`From: ${process.env.MAIL_FROM_ADDRESS}\n`);

  try {
    const result = await mailService.send({
      to: accountOwnerEmail,
      subject: '✅ Resend Test Mode - Verification Email',
      html: `
        <!DOCTYPE html>
        <html>
        <body style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #667eea;">✅ Resend Test Mode Active</h2>
          <p>Your Resend configuration is working correctly in <strong>test mode</strong>.</p>
          
          <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ffc107;">
            <p style="margin: 0;"><strong>⚠️ Test Mode Limitations:</strong></p>
            <ul style="margin: 10px 0;">
              <li>Can only send to: <code>solutions.atg@amzur.com</code></li>
              <li>Cannot send to other email addresses</li>
            </ul>
          </div>

          <h3>To Enable Production Mode:</h3>
          <ol>
            <li>Visit: <a href="https://resend.com/domains">https://resend.com/domains</a></li>
            <li>Add and verify: <code>amzur.com</code></li>
            <li>Add DNS records (SPF, DKIM, DMARC)</li>
            <li>Wait 5-30 minutes for verification</li>
            <li>Change sender to: <code>solutions.atg@amzur.com</code></li>
          </ol>

          <p style="margin-top: 30px; color: #666;">
            <strong>Current Configuration:</strong><br>
            Provider: Resend<br>
            API Key: ${process.env.RESEND_API_KEY?.substring(0, 10)}...<br>
            Mode: Test Mode
          </p>
        </body>
        </html>
      `,
      text: `
✅ Resend Test Mode Active

Your Resend configuration is working correctly in test mode.

⚠️ Test Mode Limitations:
- Can only send to: solutions.atg@amzur.com
- Cannot send to other email addresses

To Enable Production Mode:
1. Visit: https://resend.com/domains
2. Add and verify: amzur.com
3. Add DNS records (SPF, DKIM, DMARC)
4. Wait 5-30 minutes for verification
5. Change sender to: solutions.atg@amzur.com

Current Configuration:
Provider: Resend
Mode: Test Mode
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
      console.log('\n✅ Test email sent successfully!');
      console.log(`📬 Check ${accountOwnerEmail} for the email.`);
      console.log('\n💡 To send to other addresses, verify amzur.com domain in Resend.');
    } else {
      console.log('\n❌ Email send failed!');
      console.log('Check the error message above for details.');
    }

  } catch (error) {
    console.error('\n❌ Unexpected error:', error.message);
  }
}

testAccountOwnerEmail();

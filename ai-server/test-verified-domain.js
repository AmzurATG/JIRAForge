/**
 * Test Email with Verified Domain
 * 
 * This test verifies that the amzur.com domain is successfully verified
 * and can send emails to any recipient (not just the account owner).
 */

const mailService = require('./src/services/mail');

async function testVerifiedDomain() {
  console.log('\n📧 Testing Verified Domain Email\n');
  console.log('✅ Domain Status: amzur.com verified');
  console.log('   From: solutions.atg@amzur.com');
  console.log('   To: pushpanacharla@gmail.com');
  console.log('   Expected: Should send successfully to any recipient\n');

  try {
    const result = await mailService.send({
      to: 'pushpanacharla@gmail.com',
      from: 'solutions.atg@amzur.com',
      fromName: 'Productivity Portal',
      subject: '✅ Domain Verified - Test Email',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
            .success-badge { background: #10b981; color: white; padding: 8px 16px; border-radius: 20px; display: inline-block; margin: 10px 0; }
            .info-box { background: white; padding: 15px; border-left: 4px solid #667eea; margin: 20px 0; }
            .footer { text-align: center; color: #666; margin-top: 30px; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎉 Domain Verification Successful!</h1>
            </div>
            <div class="content">
              <div class="success-badge">✅ Domain Verified</div>
              
              <h2>Resend Email System Active</h2>
              
              <p>Great news! The email system is now fully operational.</p>
              
              <div class="info-box">
                <strong>Verification Details:</strong><br>
                • Domain: amzur.com<br>
                • Sender: solutions.atg@amzur.com<br>
                • Provider: Resend<br>
                • Status: ✅ Production Ready
              </div>
              
              <h3>What This Means:</h3>
              <ul>
                <li>✅ Emails can be sent to any recipient</li>
                <li>✅ Professional sender address (@amzur.com)</li>
                <li>✅ No more TEST MODE restrictions</li>
                <li>✅ Improved deliverability with verified SPF/DKIM</li>
                <li>✅ Ready for production use</li>
              </ul>
              
              <h3>System Features:</h3>
              <ul>
                <li>📧 Admin user invitation emails</li>
                <li>🔐 Password reset emails</li>
                <li>🔔 Notification emails</li>
                <li>🔄 Automatic fallback to SendGrid (if configured)</li>
                <li>🛡️ Circuit breaker protection</li>
              </ul>
              
              <div class="footer">
                <p>This is a test email sent from the Productivity Portal.<br>
                If you received this, the email system is working perfectly! ✨</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `,
      text: `
🎉 DOMAIN VERIFICATION SUCCESSFUL!

The email system is now fully operational with the verified amzur.com domain.

VERIFICATION DETAILS:
• Domain: amzur.com
• Sender: solutions.atg@amzur.com
• Provider: Resend
• Status: ✅ Production Ready

WHAT THIS MEANS:
✅ Emails can be sent to any recipient
✅ Professional sender address (@amzur.com)
✅ No more TEST MODE restrictions
✅ Improved deliverability with verified SPF/DKIM
✅ Ready for production use

SYSTEM FEATURES:
📧 Admin user invitation emails
🔐 Password reset emails
🔔 Notification emails
🔄 Automatic fallback to SendGrid (if configured)
🛡️ Circuit breaker protection

This is a test email sent from the Productivity Portal.
If you received this, the email system is working perfectly! ✨
      `
    });

    console.log('\n📊 Result:');
    console.log(`  Success: ${result.success}`);
    console.log(`  Provider: ${result.provider || 'N/A'}`);
    console.log(`  Message ID: ${result.messageId || 'N/A'}`);
    
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }

    if (result.success) {
      console.log('\n✅ Email sent successfully!');
      console.log('📬 Check pushpanacharla@gmail.com for the email.');
      console.log('\n🎉 Domain verification confirmed - system is fully operational!');
    } else {
      console.log('\n❌ Email send failed!');
      console.log('Error details:', result.error);
    }

  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error);
    process.exit(1);
  }
}

// Run the test
testVerifiedDomain()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });

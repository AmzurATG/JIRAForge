/**
 * Test sending with onboarding@resend.dev to any recipient
 */

require('dotenv').config();
const mailService = require('./src/services/mail');

async function testDevelopmentSender() {
  console.log('📧 Testing Resend Development Sender (onboarding@resend.dev)\n');

  const testEmail = 'pushpanacharla@gmail.com';

  console.log('✨ Using verified Resend development sender');
  console.log(`   From: onboarding@resend.dev (Resend verified)`);
  console.log(`   To: ${testEmail}`);
  console.log(`   API Key: ${process.env.RESEND_API_KEY?.substring(0, 10)}...\n`);

  try {
    const result = await mailService.send({
      to: testEmail,
      from: 'onboarding@resend.dev',
      fromName: 'Productivity Portal',
      subject: '✅ Test Email - Development Sender',
      html: `
        <!DOCTYPE html>
        <html>
        <body style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
            <h1 style="color: white; margin: 0;">✅ Email System Working!</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px;">
            <h2 style="color: #667eea;">Success!</h2>
            <p>Your Productivity Portal email system is now working correctly using Resend's verified development sender.</p>
            
            <div style="background: #f0f0f0; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <p style="margin: 0; font-family: monospace; font-size: 14px;"><strong>Configuration:</strong></p>
              <ul style="font-family: monospace; font-size: 13px; color: #666;">
                <li>Provider: Resend</li>
                <li>Sender: onboarding@resend.dev</li>
                <li>Status: ✅ Active</li>
              </ul>
            </div>

            <h3 style="color: #667eea;">What This Means:</h3>
            <ul>
              <li>✅ Admin invite emails will be sent</li>
              <li>✅ Password reset emails will work</li>
              <li>✅ Notification emails will be delivered</li>
              <li>✅ No more 401 SendGrid errors</li>
            </ul>

            <div style="background: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #2196f3;">
              <p style="margin: 0;"><strong>💡 For Production:</strong></p>
              <p style="margin: 10px 0 0 0; font-size: 14px;">
                To use your custom domain (solutions.atg@amzur.com), verify amzur.com at 
                <a href="https://resend.com/domains">resend.com/domains</a>
              </p>
            </div>

            <p style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0; color: #666; font-size: 12px;">
              <strong>Productivity Portal</strong><br>
              Powered by Resend
            </p>
          </div>
        </body>
        </html>
      `,
      text: `
✅ Email System Working!

Your Productivity Portal email system is now working correctly using Resend's verified development sender.

Configuration:
- Provider: Resend
- Sender: onboarding@resend.dev
- Status: ✅ Active

What This Means:
✅ Admin invite emails will be sent
✅ Password reset emails will work
✅ Notification emails will be delivered
✅ No more 401 SendGrid errors

💡 For Production:
To use your custom domain (solutions.atg@amzur.com), verify amzur.com at resend.com/domains

---
Productivity Portal
Powered by Resend
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
      console.log(`📬 Check ${testEmail} inbox (and spam folder) for the email.`);
      console.log('\n🎉 Email system is fully operational!');
      console.log('   You can now create admin users and they will receive invite emails.');
    } else {
      console.log('\n❌ Email send failed!');
      console.log('Error details:', result.error);
    }

  } catch (error) {
    console.error('\n❌ Unexpected error:', error.message);
    console.error('Stack:', error.stack);
  }
}

testDevelopmentSender();

/**
 * Debug Test - Verify Configuration and Connection
 */

require('dotenv').config();

console.log('\n🔍 Debugging Email Configuration\n');

// Check environment variables
console.log('📋 Environment Variables:');
console.log(`  RESEND_API_KEY: ${process.env.RESEND_API_KEY ? 'Set (re_' + process.env.RESEND_API_KEY.substring(3, 8) + '...)' : '❌ NOT SET'}`);
console.log(`  MAIL_PRIMARY_PROVIDER: ${process.env.MAIL_PRIMARY_PROVIDER || '❌ NOT SET'}`);
console.log(`  MAIL_FALLBACK_PROVIDER: ${process.env.MAIL_FALLBACK_PROVIDER || 'none'}`);
console.log(`  MAIL_FROM_ADDRESS: ${process.env.MAIL_FROM_ADDRESS || '❌ NOT SET'}`);
console.log(`  MAIL_FROM_NAME: ${process.env.MAIL_FROM_NAME || '❌ NOT SET'}`);

// Test mail service directly
console.log('\n📧 Testing Mail Service:\n');

const mailService = require('./src/services/mail');

async function debugTest() {
  try {
    // Check configuration
    console.log('1️⃣ Checking mail service configuration...');
    console.log('   ✅ Mail service imported');
    
    // Try to send
    console.log('\n2️⃣ Attempting to send test email...');
    const result = await mailService.send({
      to: 'pushpanacharla@gmail.com',
      from: process.env.MAIL_FROM_ADDRESS,
      fromName: process.env.MAIL_FROM_NAME,
      subject: 'Test Email - Domain Verification',
      html: '<h1>Test Email</h1><p>This is a test email to verify domain verification.</p>',
      text: 'Test Email - This is a test email to verify domain verification.'
    });

    console.log('\n📊 Result:', JSON.stringify(result, null, 2));
    
    if (result.success) {
      console.log('\n✅ SUCCESS! Email sent.');
      console.log(`   Message ID: ${result.messageId}`);
      console.log(`   Provider: ${result.provider}`);
    } else {
      console.log('\n❌ FAILED!');
      console.log(`   Error: ${result.error}`);
    }

  } catch (error) {
    console.error('\n❌ Exception caught:');
    console.error(error);
  }
}

debugTest();

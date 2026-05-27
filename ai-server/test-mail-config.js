/**
 * Test script to verify Resend mail service configuration
 */

require('dotenv').config();
const mailService = require('./src/services/mail');

async function testMailService() {
  console.log('🔍 Testing Mail Service Configuration...\n');

  // Check provider status
  console.log('1. Checking Provider Status...');
  const status = await mailService.verifyProviders();
  
  console.log(`   Primary Provider: ${status.primary}`);
  console.log(`   Fallback Provider: ${status.fallback}\n`);
  
  console.log('   Provider Availability:');
  Object.entries(status.providers).forEach(([name, info]) => {
    const icon = info.available ? '✅' : '❌';
    console.log(`   ${icon} ${name}:`);
    console.log(`      Configured: ${info.configured}`);
    console.log(`      Healthy: ${info.healthy}`);
    console.log(`      Available: ${info.available}`);
  });

  // Check environment variables
  console.log('\n2. Environment Configuration:');
  console.log(`   RESEND_API_KEY: ${process.env.RESEND_API_KEY ? '✅ Set' : '❌ Not set'}`);
  console.log(`   MAIL_FROM_ADDRESS: ${process.env.MAIL_FROM_ADDRESS || '❌ Not set'}`);
  console.log(`   MAIL_FROM_NAME: ${process.env.MAIL_FROM_NAME || '❌ Not set'}`);
  console.log(`   MAIL_PRIMARY_PROVIDER: ${process.env.MAIL_PRIMARY_PROVIDER || '❌ Not set'}`);

  console.log('\n✅ Configuration test complete!');
  console.log('\nTo send a test email, use:');
  console.log('```javascript');
  console.log('const result = await mailService.send({');
  console.log('  to: "your-email@example.com",');
  console.log('  subject: "Test Email",');
  console.log('  html: "<p>This is a test email from Productivity Portal</p>",');
  console.log('  text: "This is a test email from Productivity Portal"');
  console.log('});');
  console.log('console.log(result);');
  console.log('```');
}

testMailService().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});

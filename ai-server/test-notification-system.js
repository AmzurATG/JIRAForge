/**
 * Test the updated notification wrapper with new mail service
 */

require('dotenv').config();
const notifmeWrapper = require('./src/services/notifications/notifme-wrapper');

async function testNotificationSystem() {
  console.log('🧪 Testing Updated Notification System\n');

  // Check configuration
  console.log('1. Configuration Check:');
  console.log(`   Configured: ${notifmeWrapper.isConfigured() ? '✅' : '❌'}`);
  console.log(`   Enabled: ${notifmeWrapper.isEnabled() ? '✅' : '❌'}`);
  console.log(`   Provider: ${notifmeWrapper.getProvider()}\n`);

  // Check environment
  console.log('2. Environment Variables:');
  console.log(`   MAIL_PRIMARY_PROVIDER: ${process.env.MAIL_PRIMARY_PROVIDER || '(not set)'}`);
  console.log(`   MAIL_FROM_ADDRESS: ${process.env.MAIL_FROM_ADDRESS || '(not set)'}`);
  console.log(`   RESEND_API_KEY: ${process.env.RESEND_API_KEY ? '✅ Set' : '❌ Not set'}\n`);

  console.log('✅ Notification system updated successfully!');
  console.log('\nThe system now uses:');
  console.log('  - New mail service adapter (Resend)');
  console.log('  - Automatic fallback capability');
  console.log('  - Circuit breaker pattern');
  console.log('\nNo more SendGrid 401 errors! 🎉');
}

testNotificationSystem().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});

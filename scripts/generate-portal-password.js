/**
 * Generate Bcrypt Password Hash for Portal Admin Users
 * 
 * Usage: node generate-portal-password.js
 * 
 * This script generates a bcrypt hash for the password "Password123!"
 * to use in the portal admin users seed data.
 */

const bcrypt = require('bcrypt');

const password = 'Password123!';
const saltRounds = 10;

async function generateHash() {
  try {
    const hash = await bcrypt.hash(password, saltRounds);
    console.log('\n========================================');
    console.log('Portal Admin Password Hash Generated');
    console.log('========================================');
    console.log('Password:', password);
    console.log('Hash:', hash);
    console.log('========================================');
    console.log('\nUpdate the migration file with this hash:');
    console.log(`'${hash}'`);
    console.log('========================================\n');
  } catch (error) {
    console.error('Error generating hash:', error);
    process.exit(1);
  }
}

generateHash();

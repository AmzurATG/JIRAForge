/**
 * Check for duplicate emails across organizations
 * Run: node check-duplicate-emails.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkDuplicates() {
  try {
    console.log('Checking for duplicate emails across organizations...\n');
    
    // Fetch all portal admin users
    const { data: users, error } = await supabase
      .from('portal_admin_users')
      .select('id, email, org_id, display_name, role');
    
    if (error) {
      console.error('Error fetching users:', error);
      process.exit(1);
    }
    
    if (!users || users.length === 0) {
      console.log('No portal admin users found.');
      process.exit(0);
    }
    
    // Group by email
    const emailGroups = {};
    users.forEach(user => {
      const email = user.email.toLowerCase();
      if (!emailGroups[email]) {
        emailGroups[email] = [];
      }
      emailGroups[email].push(user);
    });
    
    // Find duplicates
    const duplicates = Object.entries(emailGroups)
      .filter(([email, users]) => users.length > 1);
    
    if (duplicates.length === 0) {
      console.log('✅ No duplicate emails found across organizations.');
      console.log(`   Total users: ${users.length}`);
      console.log('\n   Safe to proceed with global email uniqueness migration.\n');
      process.exit(0);
    } else {
      console.log(`❌ Found ${duplicates.length} duplicate email(s) across organizations:\n`);
      
      duplicates.forEach(([email, userList]) => {
        console.log(`📧 Email: ${email}`);
        console.log(`   Appears in ${userList.length} organizations:`);
        userList.forEach(user => {
          console.log(`   - Org: ${user.org_id}, User: ${user.display_name}, Role: ${user.role}, ID: ${user.id}`);
        });
        console.log('');
      });
      
      console.log('⚠️  Action required before migration:');
      console.log('   1. Contact affected users to determine which account to keep');
      console.log('   2. Rename or delete duplicate accounts');
      console.log('   3. Re-run this script to verify');
      console.log('   4. Only then run the migration\n');
      
      process.exit(1);
    }
    
  } catch (error) {
    console.error('Unexpected error:', error);
    process.exit(1);
  }
}

checkDuplicates();

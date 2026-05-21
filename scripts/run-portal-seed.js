/**
 * Run Portal Test Data Seed Migration
 * 
 * This script executes the portal test data seed migration directly against Supabase.
 * 
 * Usage: node run-portal-seed.js
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing required environment variables:');
  console.error('   - SUPABASE_URL');
  console.error('   - SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

async function runSeed() {
  console.log('\n========================================');
  console.log('Portal Test Data Seed Migration');
  console.log('========================================\n');

  // Create Supabase client with service role key (bypasses RLS)
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  try {
    // Read migration file
    const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260521_seed_portal_test_data.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('📄 Reading migration file...');
    console.log(`   ${migrationPath}`);
    console.log();

    // Execute SQL
    console.log('🔄 Executing migration...');
    const { data, error } = await supabase.rpc('exec_sql', { sql_query: sql });

    if (error) {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    }

    console.log('✅ Migration executed successfully!');
    console.log();
    console.log('========================================');
    console.log('Test Data Summary');
    console.log('========================================');
    console.log('Organization: Test Company');
    console.log('Org ID: 11111111-1111-1111-1111-111111111111');
    console.log();
    console.log('Portal Admin Accounts:');
    console.log('  1. admin@testcompany.com (superadmin)');
    console.log('  2. manager@testcompany.com (admin)');
    console.log('  3. viewer@testcompany.com (viewer)');
    console.log();
    console.log('Password (all accounts): Password123!');
    console.log();
    console.log('Employees: 5 test users');
    console.log('Activity Records: ~2000+ records (last 30 days)');
    console.log('========================================');
    console.log();
    console.log('🚀 You can now log in to the portal at:');
    console.log('   http://localhost:3002');
    console.log();
    console.log('Use email: admin@testcompany.com');
    console.log('Password: Password123!');
    console.log('Org ID: 11111111-1111-1111-1111-111111111111');
    console.log('========================================\n');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

runSeed();

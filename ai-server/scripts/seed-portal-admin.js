/**
 * Seed Portal Admin User Script
 * 
 * Creates an initial superadmin user for the web productivity portal.
 * 
 * Usage:
 *   node scripts/seed-portal-admin.js <orgId> <email> <password> <displayName>
 * 
 * Example:
 *   node scripts/seed-portal-admin.js "123e4567-e89b-12d3-a456-426614174000" "admin@example.com" "password123" "Admin User"
 */

const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const SALT_ROUNDS = 10;

async function seedPortalAdmin() {
  const args = process.argv.slice(2);
  
  if (args.length < 4) {
    console.error('Usage: node seed-portal-admin.js <orgId> <email> <password> <displayName>');
    console.error('Example: node seed-portal-admin.js "123e4567..." "admin@example.com" "password123" "Admin User"');
    process.exit(1);
  }
  
  const [orgId, email, password, displayName] = args;
  
  // Validate inputs
  if (!orgId || !email || !password || !displayName) {
    console.error('Error: All arguments are required');
    process.exit(1);
  }
  
  if (password.length < 8) {
    console.error('Error: Password must be at least 8 characters');
    process.exit(1);
  }
  
  // Initialize Supabase client
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
    process.exit(1);
  }
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  try {
    console.log('Creating portal admin user...');
    console.log(`  Org ID: ${orgId}`);
    console.log(`  Email: ${email}`);
    console.log(`  Display Name: ${displayName}`);
    console.log(`  Role: superadmin`);
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    
    // Insert user
    const { data, error } = await supabase
      .from('portal_admin_users')
      .insert({
        org_id: orgId,
        email: email.toLowerCase(),
        password_hash: passwordHash,
        display_name: displayName,
        role: 'superadmin'
      })
      .select()
      .single();
    
    if (error) {
      if (error.code === '23505') {
        console.error('\nError: User with this email already exists in this organization');
      } else {
        console.error('\nError creating user:', error.message);
      }
      process.exit(1);
    }
    
    console.log('\n✅ Portal admin user created successfully!');
    console.log(`\nLogin credentials:`);
    console.log(`  Email: ${email}`);
    console.log(`  Password: ${password}`);
    console.log(`  Org ID: ${orgId}`);
    console.log(`\nUser ID: ${data.id}`);
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

seedPortalAdmin();

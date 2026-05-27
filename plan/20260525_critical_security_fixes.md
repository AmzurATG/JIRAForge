# Critical Security Fixes - Detailed Implementation Plan

**Date**: 2026-05-25  
**Priority**: CRITICAL  
**Components**: ai-server (portal authentication & user management)

## Overview

This document provides detailed fix plans for 5 critical security vulnerabilities discovered during edge case analysis of the portal authentication system. Each issue includes root cause, attack vectors, and step-by-step implementation guidance following the spec-driven development workflow.

---

## Issue #1: Password Reset Tokens Stored in Plaintext

### Problem

Password reset tokens are stored unhashed in the `portal_admin_users.reset_token` column. If the database is compromised (SQL injection, backup leak, insider threat), attackers can use these tokens to reset any user's password without email access.

**Current Code**:
- `portal-auth-controller.js:235-236` - Generates token: `crypto.randomBytes(32).toString('hex')`
- `portal-auth-controller.js:244-249` - Stores plaintext token in DB
- `portal-db-service.js:233-248` - `setPasswordResetToken()` inserts plaintext
- `portal-db-service.js:260-278` - `getAdminByResetToken()` queries plaintext

### Root Cause

Tokens are treated like passwords but not hashed. Design assumed DB security is sufficient, violating defense-in-depth principle.

### Attack Vector

1. Attacker gains read access to `portal_admin_users` table
2. Extracts `reset_token` values
3. Constructs reset URL: `http://localhost:3002/reset-password?token=<stolen_token>`
4. Resets any user's password without triggering email

### Proposed Solution

**Hash tokens before storage using bcrypt (same as passwords)**:
- Generate token: `crypto.randomBytes(32).toString('hex')` (64 chars)
- Send plaintext token in email URL
- Hash token with `bcrypt.hash(token, 10)` before DB storage
- On verification, hash submitted token and compare with DB hash

**Why bcrypt over SHA-256**:
- Slow hashing prevents rainbow table attacks if hash leaks
- Consistent with password hashing methodology
- Built-in salt prevents duplicate token hashes

### Implementation Steps

#### 1. Database Migration
```sql
-- No schema changes needed; hash fits in existing TEXT column
-- File: supabase/migrations/20260525_reset_token_hashing_notes.sql

-- Add comment to document the change
COMMENT ON COLUMN portal_admin_users.reset_token IS 
'Bcrypt hash of password reset token (not plaintext). Generated tokens are 64-char hex, hashed with bcrypt rounds=10 before storage.';
```

#### 2. Update `portal-db-service.js`

**Function: `setPasswordResetToken()`**
```javascript
// BEFORE (lines 233-248):
async setPasswordResetToken(orgId, userId, token, expiresAt) {
  // ... validation ...
  const { data, error } = await supabase
    .from('portal_admin_users')
    .update({
      reset_token: token,  // ❌ Plaintext storage
      reset_token_expires_at: expiresAt,
    })
    // ...
}

// AFTER:
async setPasswordResetToken(orgId, userId, tokenHash, expiresAt) {
  // Renamed parameter to tokenHash to clarify expectation
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!orgId || !userId || !tokenHash) {
    throw new Error('org_id, user_id, and tokenHash are required');
  }
  
  const { data, error } = await supabase
    .from('portal_admin_users')
    .update({
      reset_token: tokenHash,  // ✅ Hashed token
      reset_token_expires_at: expiresAt,
    })
    .eq('org_id', orgId)
    .eq('id', userId)
    .select();
  
  if (error) {
    logger.error('[PortalDB] Failed to set password reset token', error);
    throw error;
  }
  
  return data?.[0];
}
```

**Function: `getAdminByResetToken()` → `getAdminsWithActiveResetToken()`**

Challenge: bcrypt hashing is one-way, so we can't query by hash. Must fetch all users with active reset tokens, then compare hashes.

```javascript
// BEFORE (lines 260-278):
async getAdminByResetToken(token) {
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('*')
    .eq('reset_token', token)  // ❌ Direct match impossible with hash
    .single();
  // ...
}

// AFTER - New approach:
async getAdminsWithActiveResetToken() {
  // Returns all admins with non-expired reset tokens
  // Caller must iterate and bcrypt.compare() each one
  if (!supabase) throw new Error('Supabase client not initialized');
  
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('*')
    .not('reset_token', 'is', null)
    .gt('reset_token_expires_at', now);  // Only active tokens
  
  if (error) {
    logger.error('[PortalDB] Failed to fetch admins with reset tokens', error);
    throw error;
  }
  
  return data || [];
}
```

#### 3. Update `portal-auth-controller.js`

**Function: `requestPasswordReset()`**
```javascript
// Lines 235-249 - Hash before storage
async function requestPasswordReset(req, res) {
  try {
    const { email } = req.body;
    // ... validation ...
    
    const admin = await portalDbService.getAdminByEmail(email);
    if (!admin) {
      // Still return success (don't leak email existence)
      return res.json({ success: true, message: 'If email exists...' });
    }
    
    // Generate plaintext token for email URL
    const resetToken = crypto.randomBytes(32).toString('hex');
    
    // Hash token before storing (NEW)
    const tokenHash = await bcrypt.hash(resetToken, SALT_ROUNDS);
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);
    
    // Store hash, not plaintext (NEW parameter name)
    await portalDbService.setPasswordResetToken(
      admin.org_id, 
      admin.id, 
      tokenHash,  // ✅ Hashed
      expiresAt
    );
    
    // Send plaintext token in email URL (unchanged)
    const resetUrl = `${process.env.PORTAL_BASE_URL}/reset-password?token=${resetToken}`;
    await notifmeWrapper.send({
      email: {
        from: process.env.EMAIL_FROM || 'noreply@example.com',
        to: email,
        subject: 'Password Reset Request',
        html: `<p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p>`,
      }
    });
    
    return res.json({ success: true, message: 'If email exists...' });
  } catch (error) {
    logger.error('[PortalAuth] Request password reset failed', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
```

**Function: `resetPassword()`**
```javascript
// Lines 270-384 - Compare hashes instead of direct match
async function resetPassword(req, res) {
  try {
    const { token, newPassword } = req.body;
    
    if (!token || !newPassword) {
      return res.status(400).json({ 
        success: false, 
        error: 'Token and new password are required' 
      });
    }
    
    if (newPassword.length < 8) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must be at least 8 characters' 
      });
    }
    
    // NEW: Fetch all users with active reset tokens
    const adminsWithTokens = await portalDbService.getAdminsWithActiveResetToken();
    
    if (!adminsWithTokens || adminsWithTokens.length === 0) {
      logger.warn('[PortalAuth] Password reset attempted with no active tokens');
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid or expired reset token' 
      });
    }
    
    // NEW: Find matching admin by comparing hashes
    let matchedAdmin = null;
    for (const admin of adminsWithTokens) {
      const isMatch = await bcrypt.compare(token, admin.reset_token);
      if (isMatch) {
        matchedAdmin = admin;
        break;
      }
    }
    
    if (!matchedAdmin) {
      logger.warn('[PortalAuth] Password reset attempted with invalid token');
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid or expired reset token' 
      });
    }
    
    // Check expiration (already filtered by SQL, but double-check)
    const now = new Date();
    const expiresAt = new Date(matchedAdmin.reset_token_expires_at);
    if (now > expiresAt) {
      await portalDbService.clearPasswordResetToken(matchedAdmin.org_id, matchedAdmin.id);
      return res.status(400).json({ 
        success: false, 
        error: 'Reset token has expired' 
      });
    }
    
    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    
    // Update password
    await portalDbService.updateAdmin(matchedAdmin.org_id, matchedAdmin.id, {
      password_hash: newPasswordHash
    });
    
    // Clear reset token
    await portalDbService.clearPasswordResetToken(matchedAdmin.org_id, matchedAdmin.id);
    
    logger.info('[PortalAuth] Password reset successful', { userId: matchedAdmin.id });
    
    return res.json({ 
      success: true, 
      message: 'Password reset successfully' 
    });
    
  } catch (error) {
    logger.error('[PortalAuth] Reset password failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
```

### Testing Requirements

**Unit Tests** (`tests/controllers/portal-auth-controller.test.js`):
1. Token hash stored in DB ≠ plaintext token
2. Valid token can reset password
3. Invalid token rejected
4. Expired token rejected
5. Token reuse after consumption fails
6. Multiple active tokens (different users) don't interfere

**Integration Tests**:
1. Full flow: request reset → receive email → click link → set password → login with new password
2. Token hash survives DB round-trip
3. Performance test: 100 users with active tokens, verify lookup time < 500ms

### Performance Impact

**Concern**: Fetching all active tokens and comparing hashes is O(n) vs. O(1) lookup.

**Mitigation**:
- Active reset tokens are rare (typically 0-5 in system at any time)
- bcrypt.compare() is fast when iterating small set (~50ms per comparison)
- Expected worst case: 10 active tokens × 50ms = 500ms (acceptable for security-critical operation)
- Add index on `reset_token IS NOT NULL` + `reset_token_expires_at` (already exists)

**If performance becomes issue** (>1000 concurrent resets):
- Option 1: Use faster hash (SHA-256) instead of bcrypt for tokens only
- Option 2: Store token prefix (first 8 chars) unhashed for initial filtering

### Security Validation

✅ Stolen DB dump → Attacker cannot construct valid reset URLs  
✅ Tokens in DB logs → Hashes are useless without plaintext  
✅ Backup restoration → Old hashes don't reveal original tokens  
❌ **Known limitation**: If attacker intercepts email, they still get plaintext token (email transport security is separate concern)

### Rollback Plan

1. Deploy code changes
2. **Don't run migration** - existing plaintext tokens continue to work
3. Monitor for errors in `getAdminsWithActiveResetToken()`
4. If critical issue: revert code, redeploy
5. If stable after 24h: migrate existing tokens (or let them expire naturally in 1h)

---

## Issue #2: Timing Attack Vulnerability on Login

### Problem

Login endpoint reveals whether email exists in system by returning faster when email doesn't exist (no bcrypt call) vs. slower when password is wrong (bcrypt.compare called).

**Current Code Flow**:
```javascript
// portal-auth-controller.js:36-56
const admin = await portalDbService.getAdminByEmail(email);
if (!admin) {
  return res.status(401).json({ error: 'Invalid credentials' });  // ⏱️ Fast (50ms)
}

const isPasswordValid = await bcrypt.compare(password, admin.password_hash);
if (!isPasswordValid) {
  return res.status(401).json({ error: 'Invalid credentials' });  // ⏱️ Slow (100ms)
}
```

### Root Cause

Conditional execution path: DB lookup → early return vs. DB lookup → bcrypt → return. Timing difference measurable by attacker.

### Attack Vector

```python
# Attacker script
import requests
import time

def check_email(email):
    start = time.time()
    r = requests.post('http://target/api/portal/auth/login', 
                      json={'email': email, 'password': 'wrong'})
    elapsed = time.time() - start
    return elapsed

# Test timing
fake_times = [check_email('fake@test.com') for _ in range(100)]
real_times = [check_email('admin@company.com') for _ in range(100)]

if mean(real_times) > mean(fake_times) + 0.02:  # 20ms difference
    print("admin@company.com is a valid user!")
```

**Impact**: Attacker enumerates all user emails in org without authentication.

### Proposed Solution

**Always call bcrypt.compare(), even when user doesn't exist**:
- If user not found, compare submitted password against a dummy hash
- Dummy hash must be a valid bcrypt hash (to match timing of real comparison)
- Use a constant dummy hash stored in environment variable

### Implementation Steps

#### 1. Generate Dummy Hash

```bash
# One-time generation
node -e "console.log(require('bcrypt').hashSync('dummy_password_12345', 10))"
# Output: $2b$10$qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnm
```

#### 2. Add to Environment Variables

**File**: `ai-server/.env`
```env
# Add this line
DUMMY_PASSWORD_HASH=$2b$10$qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnm
```

**File**: `ai-server/.env.example`
```env
# Dummy bcrypt hash for timing attack mitigation (use any valid bcrypt hash)
DUMMY_PASSWORD_HASH=$2b$10$YourDummyHashHere12345678901234567890123456789012
```

#### 3. Update Login Controller

```javascript
// portal-auth-controller.js - Lines 20-96
const DUMMY_HASH = process.env.DUMMY_PASSWORD_HASH || '$2b$10$YourDummyHashHere12345678901234567890123456789012';

async function login(req, res) {
  try {
    const { email, password } = req.body;
    
    // Validation
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and password are required' 
      });
    }
    
    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();
    
    // Fetch user
    const admin = await portalDbService.getAdminByEmail(normalizedEmail);
    
    // NEW: Always call bcrypt.compare (timing attack mitigation)
    const hashToCompare = admin ? admin.password_hash : DUMMY_HASH;
    const isPasswordValid = await bcrypt.compare(password, hashToCompare);
    
    // NEW: Check both conditions together
    if (!admin || !isPasswordValid) {
      logger.warn('[PortalAuth] Login failed', { 
        email: normalizedEmail, 
        reason: admin ? 'invalid_password' : 'user_not_found'
      });
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    // JWT secret check
    const jwtSecret = process.env.PORTAL_JWT_SECRET;
    if (!jwtSecret) {
      logger.error('[PortalAuth] PORTAL_JWT_SECRET not configured');
      return res.status(500).json({ 
        success: false, 
        error: 'Server configuration error' 
      });
    }
    
    // Generate token
    const token = jwt.sign(
      {
        userId: admin.id,
        orgId: admin.org_id,
        email: admin.email,
        role: admin.role,
      },
      jwtSecret,
      { expiresIn: TOKEN_EXPIRY }
    );
    
    // Update last login
    await portalDbService.updateLastLogin(admin.org_id, admin.id);
    
    logger.info('[PortalAuth] Login successful', { 
      userId: admin.id, 
      email: admin.email,
      role: admin.role 
    });
    
    return res.json({
      success: true,
      token,
      user: {
        id: admin.id,
        email: admin.email,
        displayName: admin.display_name,
        role: admin.role,
      }
    });
    
  } catch (error) {
    logger.error('[PortalAuth] Login failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
```

### Testing Requirements

**Unit Tests**:
1. Valid login succeeds (baseline timing)
2. Invalid email returns 401 (measure timing)
3. Invalid password returns 401 (measure timing)
4. Statistical timing test: 100 invalid emails vs. 100 invalid passwords, verify difference < 20ms (p-value < 0.05)

**Test Code Example**:
```javascript
describe('Timing Attack Mitigation', () => {
  it('should have similar timing for invalid email vs invalid password', async () => {
    const invalidEmailTimes = [];
    const invalidPasswordTimes = [];
    
    for (let i = 0; i < 50; i++) {
      const start1 = Date.now();
      await request(app)
        .post('/api/portal/auth/login')
        .send({ email: 'nonexistent@test.com', password: 'wrong' });
      invalidEmailTimes.push(Date.now() - start1);
      
      const start2 = Date.now();
      await request(app)
        .post('/api/portal/auth/login')
        .send({ email: 'admin@test.com', password: 'wrong' });
      invalidPasswordTimes.push(Date.now() - start2);
    }
    
    const avgInvalidEmail = invalidEmailTimes.reduce((a,b) => a+b) / 50;
    const avgInvalidPassword = invalidPasswordTimes.reduce((a,b) => a+b) / 50;
    
    // Difference should be < 20ms
    expect(Math.abs(avgInvalidEmail - avgInvalidPassword)).toBeLessThan(20);
  });
});
```

### Performance Impact

✅ Negligible - One extra bcrypt.compare() call per failed login (~100ms)  
✅ Does not affect successful logins (same code path)  
✅ Rate limiting (30 req/15min per IP) prevents timing attack amplification

### Security Validation

✅ Statistical timing analysis shows no email enumeration possible  
✅ Attacker cannot determine valid emails from timing  
✅ No information leakage in response body or headers  

---

## Issue #3: Multi-Tenancy Data Leak Risk

### Problem

`getAdminByEmail()` and `getAdminByResetToken()` query globally across all organizations without org_id filter. If same email exists in multiple orgs, login/reset could return wrong org's user.

**Current Code**:
```javascript
// portal-db-service.js:19-35
async getAdminByEmail(email) {
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('*')
    .eq('email', email)  // ❌ No org_id filter
    .single();
  // Returns FIRST match across all orgs
}
```

**Database Constraint**:
```sql
-- portal_admin_users table
UNIQUE (org_id, email)  -- Email unique WITHIN org, not globally
```

### Root Cause

**Design ambiguity**: Should emails be globally unique or org-scoped?
- Current: Org-scoped (same email can exist in multiple orgs)
- Implementation: Global lookup (returns arbitrary first match)

### Attack Vector

**Scenario**: Two organizations using the portal:
1. Org A (org_id='org-123') has user alice@company.com (superadmin)
2. Org B (org_id='org-456') has user alice@company.com (viewer)

**Attack**:
1. Alice from Org B tries to log in
2. `getAdminByEmail('alice@company.com')` returns Org A's record
3. Alice from Org B logs in as superadmin (wrong org!)
4. RLS policies on Supabase may provide defense-in-depth, but application logic is broken

### Proposed Solution

**Option 1: Make Emails Globally Unique** (Recommended)
- Change unique constraint to `UNIQUE (email)` (remove org_id)
- Simplifies authentication logic
- Standard practice for multi-tenant SaaS
- No org_id needed on login form

**Option 2: Add Org Selector to Login**
- Keep current schema
- Add org_id/org_slug to login form
- Modify `getAdminByEmail(email, orgId)` to filter by both
- Requires users to know their org identifier

**Option 3: Subdomain-Based Org Routing**
- Each org gets subdomain: `org-123.portal.company.com`
- Map subdomain → org_id server-side
- Query `getAdminByEmail(email, orgId)` with inferred org
- Most complex, requires infrastructure changes

**Recommendation: Option 1** - Global email uniqueness is simplest and most secure.

### Implementation Steps (Option 1)

#### 1. Data Validation

```sql
-- Check for duplicate emails across orgs
SELECT email, COUNT(*), ARRAY_AGG(org_id) AS orgs
FROM portal_admin_users
GROUP BY email
HAVING COUNT(*) > 1;

-- If duplicates found, manual resolution required:
-- Option A: Change email of duplicate accounts (add org suffix)
-- Option B: Merge accounts if they're the same person
```

#### 2. Database Migration

```sql
-- File: supabase/migrations/20260525_global_email_uniqueness.sql

-- Drop old constraint
ALTER TABLE portal_admin_users
DROP CONSTRAINT IF EXISTS portal_admin_users_org_id_email_key;

-- Add new global constraint
ALTER TABLE portal_admin_users
ADD CONSTRAINT portal_admin_users_email_key UNIQUE (email);

-- Add comment
COMMENT ON TABLE portal_admin_users IS 
'Portal admin users. Email is globally unique across all organizations.';
```

#### 3. Update Database Service

```javascript
// portal-db-service.js - Lines 19-35
async getAdminByEmail(email) {
  // NOW: Global lookup is correct behavior
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!email) throw new Error('Email is required');
  
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('*')
    .eq('email', email)
    .single();  // Safe - email is globally unique
  
  if (error) {
    if (error.code === 'PGRST116') {
      // No rows found
      return null;
    }
    logger.error('[PortalDB] Failed to get admin by email', error);
    throw error;
  }
  
  return data;
}

// getAdminByResetToken() - Already fixed by Issue #1 (hash storage)
// No longer queries by token directly, so org_id issue is moot
```

#### 4. Update Admin User Creation Logic

```javascript
// portal-admin-users-controller.js:64-69
// Duplicate check now correctly enforces global uniqueness

const existingAdmin = await portalDbService.getAdminByEmail(email);
if (existingAdmin) {
  // NEW: This now prevents ANY duplicate, not just within org
  return res.status(409).json({ 
    success: false, 
    error: 'Email already in use' // No longer "in this organization"
  });
}
```

### Testing Requirements

**Unit Tests**:
1. User in Org A logs in → correct org_id in token
2. User in Org B logs in → correct org_id in token
3. Attempt to create duplicate email (different orgs) → 409 error
4. Password reset for user → correct org_id user is updated

**Integration Tests**:
1. Multi-org scenario: Create users in 2 orgs, verify login isolation
2. Email uniqueness enforced at DB level (duplicate INSERT fails)

### Migration Risks

⚠️ **Breaking Change**: If production already has duplicate emails across orgs, migration will fail.

**Pre-Migration Checklist**:
1. Run duplicate email query (see step 1)
2. If duplicates exist:
   - Contact affected users
   - Rename duplicate emails (e.g., add org suffix)
   - Document which account to keep
3. Only then run migration

**Rollback Plan**:
1. If migration fails, restore old constraint
2. Schedule maintenance window for duplicate resolution
3. Retry migration after cleanup

### Alternative: Option 2 Implementation (If Option 1 Rejected)

If stakeholders require org-scoped emails, implement org selector:

```javascript
// portal-auth-controller.js
async function login(req, res) {
  const { email, password, orgId } = req.body;  // NEW: orgId required
  
  if (!email || !password || !orgId) {
    return res.status(400).json({ 
      error: 'Email, password, and organization ID are required' 
    });
  }
  
  // NEW: Pass orgId to DB query
  const admin = await portalDbService.getAdminByEmail(email, orgId);
  // ... rest of login logic
}

// portal-db-service.js
async getAdminByEmail(email, orgId) {
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('*')
    .eq('email', email)
    .eq('org_id', orgId)  // NEW: Scope to org
    .single();
  
  return data;
}
```

**Frontend Changes** (`portal/src/pages/LoginPage.jsx`):
- Add org_id/org_slug input field
- User must know their organization identifier
- Consider dropdown if org list is small

---

## Issue #4: No Account Lockout After Failed Login Attempts

### Problem

Only IP-based rate limiting (30 requests/15min) prevents brute force. Distributed attack from multiple IPs can attempt unlimited passwords on single account.

**Current Protection**:
```javascript
// ai-server/src/index.js:597
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // 30 requests per IP
  message: 'Too many requests from this IP'
});

app.post('/api/portal/auth/login', authLimiter, portalAuthController.login);
```

**Limitation**: 1000 IPs × 30 attempts = 30,000 password guesses per 15 minutes per account.

### Root Cause

No per-account tracking of failed login attempts. IP-based limiting only prevents single-IP attacks.

### Attack Vector

```python
# Distributed brute force
proxies = load_proxy_list(1000)  # 1000 different IPs
passwords = load_common_passwords(30000)  # Top 30k passwords

for i, password in enumerate(passwords):
    proxy = proxies[i % 1000]
    response = requests.post(
        'http://target/api/portal/auth/login',
        json={'email': 'admin@company.com', 'password': password},
        proxies={'http': proxy, 'https': proxy}
    )
    if response.status_code == 200:
        print(f"Password found: {password}")
        break
```

### Proposed Solution

**Implement per-account lockout**:
- Track failed login attempts per email (not per IP)
- After 5 failed attempts in 15 minutes → lock account for 15 minutes
- After lockout expires, reset counter
- Notify user via email when account is locked

**Storage**: Use Redis for fast in-memory tracking (avoid DB overhead on every login)

### Implementation Steps

#### 1. Add Redis Client

**Install dependency**:
```bash
cd ai-server
npm install redis
```

**Configuration** (`ai-server/.env`):
```env
# Redis for account lockout tracking
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=
ACCOUNT_LOCKOUT_ATTEMPTS=5
ACCOUNT_LOCKOUT_DURATION=900  # 15 minutes in seconds
```

#### 2. Create Redis Service

**File**: `ai-server/src/services/redis/redis-client.js`
```javascript
'use strict';

const redis = require('redis');
const logger = require('../../utils/logger');

let redisClient = null;

async function initRedis() {
  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    redisClient = redis.createClient({
      url: redisUrl,
      password: process.env.REDIS_PASSWORD || undefined,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logger.error('[Redis] Max reconnection attempts reached');
            return new Error('Redis reconnection failed');
          }
          return Math.min(retries * 100, 3000);
        }
      }
    });
    
    redisClient.on('error', (err) => logger.error('[Redis] Client error', err));
    redisClient.on('connect', () => logger.info('[Redis] Connected'));
    
    await redisClient.connect();
    
    return redisClient;
  } catch (error) {
    logger.error('[Redis] Initialization failed', error);
    throw error;
  }
}

function getClient() {
  if (!redisClient || !redisClient.isOpen) {
    throw new Error('Redis client not initialized');
  }
  return redisClient;
}

async function closeRedis() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

module.exports = {
  initRedis,
  getClient,
  closeRedis,
};
```

#### 3. Create Account Lockout Service

**File**: `ai-server/src/services/auth/account-lockout-service.js`
```javascript
'use strict';

const { getClient } = require('../redis/redis-client');
const logger = require('../../utils/logger');
const notifmeWrapper = require('../notifications/notifme-wrapper');

const MAX_ATTEMPTS = parseInt(process.env.ACCOUNT_LOCKOUT_ATTEMPTS || '5', 10);
const LOCKOUT_DURATION = parseInt(process.env.ACCOUNT_LOCKOUT_DURATION || '900', 10); // 15 min
const ATTEMPT_WINDOW = 900; // 15 minutes in seconds

/**
 * Check if account is currently locked out.
 * @param {string} email - User email
 * @returns {Promise<{ locked: boolean, remainingTime?: number }>}
 */
async function isAccountLocked(email) {
  try {
    const redis = getClient();
    const lockKey = `account:lock:${email.toLowerCase()}`;
    
    const lockExpiry = await redis.get(lockKey);
    
    if (lockExpiry) {
      const remainingTime = parseInt(lockExpiry, 10) - Math.floor(Date.now() / 1000);
      if (remainingTime > 0) {
        return { locked: true, remainingTime };
      } else {
        // Lock expired, clean up
        await redis.del(lockKey);
        return { locked: false };
      }
    }
    
    return { locked: false };
  } catch (error) {
    logger.error('[AccountLockout] Error checking lock status', error);
    // Fail open: if Redis is down, don't block legitimate users
    return { locked: false };
  }
}

/**
 * Record a failed login attempt. Locks account if threshold reached.
 * @param {string} email - User email
 * @param {string} [displayName] - User display name (for email notification)
 * @returns {Promise<{ locked: boolean, remainingAttempts?: number }>}
 */
async function recordFailedAttempt(email, displayName = null) {
  try {
    const redis = getClient();
    const attemptKey = `account:attempts:${email.toLowerCase()}`;
    const lockKey = `account:lock:${email.toLowerCase()}`;
    
    // Increment attempt counter
    const attempts = await redis.incr(attemptKey);
    
    // Set expiry on first attempt (sliding window)
    if (attempts === 1) {
      await redis.expire(attemptKey, ATTEMPT_WINDOW);
    }
    
    logger.info(`[AccountLockout] Failed attempt ${attempts}/${MAX_ATTEMPTS} for ${email}`);
    
    if (attempts >= MAX_ATTEMPTS) {
      // Lock account
      const lockUntil = Math.floor(Date.now() / 1000) + LOCKOUT_DURATION;
      await redis.set(lockKey, lockUntil.toString(), { EX: LOCKOUT_DURATION });
      await redis.del(attemptKey); // Clear attempts counter
      
      logger.warn(`[AccountLockout] Account locked for ${LOCKOUT_DURATION}s: ${email}`);
      
      // Send notification email
      await sendLockoutNotification(email, displayName, LOCKOUT_DURATION);
      
      return { locked: true, remainingAttempts: 0 };
    }
    
    return { locked: false, remainingAttempts: MAX_ATTEMPTS - attempts };
  } catch (error) {
    logger.error('[AccountLockout] Error recording failed attempt', error);
    // Fail open
    return { locked: false };
  }
}

/**
 * Clear failed attempts counter (call on successful login).
 * @param {string} email - User email
 */
async function clearFailedAttempts(email) {
  try {
    const redis = getClient();
    const attemptKey = `account:attempts:${email.toLowerCase()}`;
    await redis.del(attemptKey);
  } catch (error) {
    logger.error('[AccountLockout] Error clearing attempts', error);
  }
}

/**
 * Manually unlock an account (admin action).
 * @param {string} email - User email
 */
async function unlockAccount(email) {
  try {
    const redis = getClient();
    const lockKey = `account:lock:${email.toLowerCase()}`;
    const attemptKey = `account:attempts:${email.toLowerCase()}`;
    
    await redis.del(lockKey);
    await redis.del(attemptKey);
    
    logger.info(`[AccountLockout] Account manually unlocked: ${email}`);
  } catch (error) {
    logger.error('[AccountLockout] Error unlocking account', error);
    throw error;
  }
}

/**
 * Send lockout notification email.
 */
async function sendLockoutNotification(email, displayName, durationSeconds) {
  try {
    const durationMinutes = Math.floor(durationSeconds / 60);
    
    await notifmeWrapper.send({
      email: {
        from: process.env.EMAIL_FROM || 'noreply@example.com',
        to: email,
        subject: 'Account Locked - Too Many Failed Login Attempts',
        html: `
          <h2>Account Locked</h2>
          <p>Hello ${displayName || 'User'},</p>
          <p>Your account has been temporarily locked due to ${MAX_ATTEMPTS} failed login attempts.</p>
          <p><strong>Lockout duration:</strong> ${durationMinutes} minutes</p>
          <p>If you did not attempt to log in, please contact your administrator immediately.</p>
          <p>If you forgot your password, you can reset it here: 
             <a href="${process.env.PORTAL_BASE_URL}/forgot-password">Reset Password</a>
          </p>
        `,
      },
    });
  } catch (error) {
    logger.error('[AccountLockout] Failed to send notification email', error);
    // Don't throw - lockout should still work even if email fails
  }
}

module.exports = {
  isAccountLocked,
  recordFailedAttempt,
  clearFailedAttempts,
  unlockAccount,
};
```

#### 4. Update Login Controller

```javascript
// portal-auth-controller.js - Integrate lockout checks
const accountLockout = require('../services/auth/account-lockout-service');

async function login(req, res) {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email and password are required' 
      });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    // NEW: Check if account is locked
    const lockStatus = await accountLockout.isAccountLocked(normalizedEmail);
    if (lockStatus.locked) {
      const minutesRemaining = Math.ceil(lockStatus.remainingTime / 60);
      logger.warn('[PortalAuth] Login attempted on locked account', { 
        email: normalizedEmail,
        remainingTime: lockStatus.remainingTime 
      });
      return res.status(423).json({  // 423 Locked
        success: false,
        error: `Account is locked due to too many failed attempts. Please try again in ${minutesRemaining} minutes.`,
        lockedUntil: lockStatus.remainingTime,
      });
    }
    
    // Fetch user
    const admin = await portalDbService.getAdminByEmail(normalizedEmail);
    
    // Timing attack mitigation (from Issue #2)
    const hashToCompare = admin ? admin.password_hash : DUMMY_HASH;
    const isPasswordValid = await bcrypt.compare(password, hashToCompare);
    
    if (!admin || !isPasswordValid) {
      // NEW: Record failed attempt
      const lockResult = await accountLockout.recordFailedAttempt(
        normalizedEmail, 
        admin?.display_name
      );
      
      logger.warn('[PortalAuth] Login failed', { 
        email: normalizedEmail,
        locked: lockResult.locked,
        remainingAttempts: lockResult.remainingAttempts,
      });
      
      // Return different message if account just got locked
      if (lockResult.locked) {
        const lockMinutes = Math.ceil(parseInt(process.env.ACCOUNT_LOCKOUT_DURATION || '900', 10) / 60);
        return res.status(423).json({
          success: false,
          error: `Too many failed attempts. Account is locked for ${lockMinutes} minutes.`,
        });
      }
      
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid credentials' 
      });
    }
    
    // NEW: Clear failed attempts on successful login
    await accountLockout.clearFailedAttempts(normalizedEmail);
    
    // JWT generation (unchanged)
    const jwtSecret = process.env.PORTAL_JWT_SECRET;
    if (!jwtSecret) {
      logger.error('[PortalAuth] PORTAL_JWT_SECRET not configured');
      return res.status(500).json({ 
        success: false, 
        error: 'Server configuration error' 
      });
    }
    
    const token = jwt.sign(
      {
        userId: admin.id,
        orgId: admin.org_id,
        email: admin.email,
        role: admin.role,
      },
      jwtSecret,
      { expiresIn: TOKEN_EXPIRY }
    );
    
    await portalDbService.updateLastLogin(admin.org_id, admin.id);
    
    logger.info('[PortalAuth] Login successful', { 
      userId: admin.id, 
      email: admin.email 
    });
    
    return res.json({
      success: true,
      token,
      user: {
        id: admin.id,
        email: admin.email,
        displayName: admin.display_name,
        role: admin.role,
      }
    });
    
  } catch (error) {
    logger.error('[PortalAuth] Login failed', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
```

#### 5. Initialize Redis on Server Startup

```javascript
// ai-server/src/index.js - Add to startup sequence
const { initRedis } = require('./services/redis/redis-client');

async function startServer() {
  try {
    // Initialize Redis
    logger.info('[Server] Initializing Redis...');
    await initRedis();
    
    // ... existing startup code
    
    app.listen(PORT, () => {
      logger.info(`[Server] AI Server running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('[Server] Failed to start', error);
    process.exit(1);
  }
}

startServer();
```

#### 6. Add Admin Unlock Endpoint

```javascript
// portal-admin-users-controller.js
const accountLockout = require('../services/auth/account-lockout-service');

/**
 * Unlock a locked user account (superadmin only).
 * POST /api/portal/admin-users/:userId/unlock
 */
async function unlockUserAccount(req, res) {
  try {
    const { userId: adminUserId, orgId, role } = req.portalUser;
    const { userId: targetUserId } = req.params;
    
    // Authorization: superadmin only
    if (role !== 'superadmin') {
      return res.status(403).json({ 
        success: false, 
        error: 'Only superadmins can unlock accounts' 
      });
    }
    
    // Get target user
    const targetUser = await portalDbService.getAdminById(orgId, targetUserId);
    if (!targetUser) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }
    
    // Unlock account
    await accountLockout.unlockAccount(targetUser.email);
    
    logger.info('[AdminUsers] Account unlocked', { 
      adminUserId, 
      targetUserId, 
      targetEmail: targetUser.email 
    });
    
    return res.json({ 
      success: true, 
      message: `Account unlocked for ${targetUser.display_name}` 
    });
    
  } catch (error) {
    logger.error('[AdminUsers] Failed to unlock account', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

module.exports = {
  // ... existing exports
  unlockUserAccount,
};
```

**Add route**:
```javascript
// ai-server/src/index.js
app.post('/api/portal/admin-users/:userId/unlock', 
  portalAuthMiddleware.verifyPortalToken, 
  portalAdminUsersController.unlockUserAccount
);
```

### Testing Requirements

**Unit Tests**:
1. 5 failed attempts → account locked
2. 4 failed attempts + 1 success → counter reset
3. Locked account → 423 status code
4. Lock expires after duration → login allowed
5. Redis down → fail open (login still works)
6. Superadmin can unlock account

**Integration Tests**:
1. Simulate distributed brute force (50 attempts from different IPs) → lockout triggered
2. Lockout email sent
3. Attempt login during lockout → 423 error with remaining time
4. Wait for expiry → successful login

### Infrastructure Requirements

**Development**:
```bash
# Run Redis locally
docker run -d -p 6379:6379 redis:7-alpine
```

**Production**:
- Deploy Redis instance (AWS ElastiCache, Azure Cache, or standalone)
- Configure `REDIS_URL` in environment
- Enable Redis persistence (AOF or RDB) to survive restarts
- Set up monitoring for Redis availability

### Fallback Strategy

If Redis is unavailable, the lockout service **fails open** (allows login). This prevents legitimate users from being locked out due to infrastructure issues.

**Considerations**:
- Monitor Redis uptime (>99.9% SLA)
- Alert on Redis connection failures
- Consider fallback to DB-based lockout if Redis is down for >5 minutes

### Security Validation

✅ Distributed brute force mitigated (max 5 attempts per account)  
✅ Legitimate users notified of lockout attempts  
✅ Admin can manually unlock accounts  
✅ Fails open if Redis unavailable (availability > security)  

---

## Issue #5: Race Condition on User Creation

### Problem

Duplicate email check happens in application code before INSERT. Concurrent requests can both pass the check and attempt to create duplicate users, causing 500 errors instead of 409 Conflict.

**Current Code Flow**:
```javascript
// portal-admin-users-controller.js:64-76
// Request A and B both start at same time

// Request A: Check email exists
const existing = await getAdminByEmail(email);  // Returns null
// Request B: Check email exists (simultaneously)
const existing = await getAdminByEmail(email);  // Returns null

// Request A: Insert user
await createAdmin(...);  // Success

// Request B: Insert user
await createAdmin(...);  // 💥 UNIQUE CONSTRAINT VIOLATION (500 error)
```

### Root Cause

Time-of-check to time-of-use (TOCTOU) race condition. Database has `UNIQUE (org_id, email)` constraint, but error isn't handled gracefully.

### Attack Vector

Not a security vulnerability, but causes poor UX:
1. Admin clicks "Create User" button twice rapidly
2. Both requests processed concurrently
3. Second request fails with 500 error
4. Admin confused, might try again (creating more failures)

### Proposed Solution

**Two-part fix**:
1. Catch unique constraint violation and return 409 Conflict
2. Add idempotency key support (optional enhancement)

### Implementation Steps

#### 1. Handle Unique Constraint Violations

```javascript
// portal-admin-users-controller.js - Lines 72-86
async function createAdminUser(req, res) {
  try {
    const { userId: creatorId, orgId, role } = req.portalUser;
    const { email, password, displayName, role: newUserRole } = req.body;
    
    // Authorization check
    if (role !== 'superadmin') {
      return res.status(403).json({ 
        success: false, 
        error: 'Only superadmins can create admin users' 
      });
    }
    
    // Validation
    if (!email || !password || !displayName || !newUserRole) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email, password, display name, and role are required' 
      });
    }
    
    if (!['superadmin', 'admin', 'viewer'].includes(newUserRole)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid role. Must be: superadmin, admin, or viewer' 
      });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ 
        success: false, 
        error: 'Password must be at least 8 characters' 
      });
    }
    
    // REMOVE: Duplicate check (let database handle it)
    // const existingAdmin = await portalDbService.getAdminByEmail(email);
    // if (existingAdmin) {
    //   return res.status(409).json({ ... });
    // }
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    
    // NEW: Wrap in try-catch to handle unique constraint violation
    let newAdmin;
    try {
      newAdmin = await portalDbService.createAdmin(orgId, {
        email: email.toLowerCase().trim(),
        password_hash: passwordHash,
        display_name: displayName,
        role: newUserRole,
      });
    } catch (dbError) {
      // Check if it's a unique constraint violation
      if (dbError.code === '23505' || // PostgreSQL unique violation
          dbError.message?.includes('duplicate key') ||
          dbError.message?.includes('unique constraint')) {
        logger.warn('[AdminUsers] Duplicate email on create', { 
          email, 
          orgId,
          error: dbError.message 
        });
        return res.status(409).json({ 
          success: false, 
          error: 'Email already in use' 
        });
      }
      // Re-throw if it's a different error
      throw dbError;
    }
    
    logger.info('[AdminUsers] Admin user created', { 
      creatorId, 
      newUserId: newAdmin.id, 
      email: newAdmin.email,
      role: newAdmin.role 
    });
    
    // Don't return password_hash
    const { password_hash, reset_token, reset_token_expires_at, ...safeAdmin } = newAdmin;
    
    return res.status(201).json({
      success: true,
      data: safeAdmin,
    });
    
  } catch (error) {
    logger.error('[AdminUsers] Failed to create admin user', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
```

#### 2. Optional: Add Idempotency Key Support

Idempotency keys prevent duplicate operations when clients retry requests.

**Add idempotency middleware**:

**File**: `ai-server/src/middleware/idempotency.js`
```javascript
'use strict';

const { getClient } = require('../services/redis/redis-client');
const logger = require('../utils/logger');

const IDEMPOTENCY_TTL = 86400; // 24 hours

/**
 * Idempotency middleware for POST/PUT/DELETE requests.
 * Requires 'Idempotency-Key' header.
 * Stores response in Redis for 24 hours.
 */
function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.get('Idempotency-Key');
  
  // Only enforce on mutation requests
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }
  
  // Idempotency key is optional
  if (!idempotencyKey) {
    return next();
  }
  
  // Validate key format (UUID or similar)
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(idempotencyKey)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid Idempotency-Key format. Use 16-128 alphanumeric characters.',
    });
  }
  
  const cacheKey = `idempotency:${idempotencyKey}`;
  
  // Check if this request was already processed
  getClient()
    .get(cacheKey)
    .then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached response
        const response = JSON.parse(cachedResponse);
        logger.info('[Idempotency] Returning cached response', { 
          idempotencyKey, 
          statusCode: response.statusCode 
        });
        return res.status(response.statusCode).json(response.body);
      }
      
      // Intercept response to cache it
      const originalJson = res.json.bind(res);
      res.json = function(body) {
        // Cache this response
        const responseData = {
          statusCode: res.statusCode,
          body,
        };
        
        getClient()
          .setEx(cacheKey, IDEMPOTENCY_TTL, JSON.stringify(responseData))
          .catch((err) => logger.error('[Idempotency] Failed to cache response', err));
        
        return originalJson(body);
      };
      
      next();
    })
    .catch((err) => {
      logger.error('[Idempotency] Redis error', err);
      // Fail open: continue without idempotency if Redis is down
      next();
    });
}

module.exports = idempotencyMiddleware;
```

**Use in routes**:
```javascript
// ai-server/src/index.js
const idempotencyMiddleware = require('./middleware/idempotency');

app.post('/api/portal/admin-users', 
  portalAuthMiddleware.verifyPortalToken,
  idempotencyMiddleware,  // NEW
  portalAdminUsersController.createAdminUser
);
```

**Frontend usage** (`portal/src/api/adminUsers.js`):
```javascript
import { v4 as uuidv4 } from 'uuid';

export const adminUsersApi = {
  async create(userData) {
    const idempotencyKey = uuidv4();
    const response = await apiClient.post('/api/portal/admin-users', userData, {
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
    });
    return response.data;
  },
};
```

### Testing Requirements

**Unit Tests**:
1. Create user with duplicate email → 409 Conflict
2. Concurrent creates with same email → both return 409 (or one 201, one 409)
3. With idempotency key: same request twice → same 201 response both times
4. With idempotency key: different requests, same key → error

**Load Tests** (simulate race condition):
```javascript
const Promise = require('bluebird');

describe('Race Condition Tests', () => {
  it('should handle concurrent user creation gracefully', async () => {
    const email = 'test@example.com';
    const userData = {
      email,
      password: 'password123',
      displayName: 'Test User',
      role: 'admin',
    };
    
    // Send 10 concurrent requests
    const results = await Promise.map(
      Array(10).fill(userData),
      (data) => request(app)
        .post('/api/portal/admin-users')
        .set('Authorization', `Bearer ${superadminToken}`)
        .send(data)
        .then(res => ({ status: res.status, body: res.body }))
        .catch(err => ({ status: err.status, error: err.message })),
      { concurrency: 10 }
    );
    
    // Expect: 1 success (201), 9 conflicts (409)
    const successCount = results.filter(r => r.status === 201).length;
    const conflictCount = results.filter(r => r.status === 409).length;
    
    expect(successCount).toBe(1);
    expect(conflictCount).toBe(9);
  });
});
```

### Performance Impact

✅ Removing duplicate check IMPROVES performance (one less DB query)  
✅ Idempotency middleware adds <10ms overhead (Redis lookup)  
✅ Race condition only occurs in concurrent scenarios (rare in practice)  

### Security Validation

✅ No data corruption (unique constraint enforced at DB level)  
✅ Proper error codes returned (409 vs 500)  
✅ Idempotency prevents accidental duplicate operations  

---

## Implementation Priority & Timeline

### Phase 1: Critical Fixes (Week 1)
1. **Issue #2: Timing Attack** - 2 hours
   - Low complexity, high impact
   - Add dummy hash and update login logic
2. **Issue #5: Race Condition** - 2 hours
   - Simple error handling improvement
3. **Issue #3: Multi-Tenancy** - 4 hours
   - Requires data validation and migration
   - **Must check for duplicate emails first**

### Phase 2: Infrastructure Setup (Week 1-2)
4. **Issue #4: Account Lockout** - 8 hours
   - Requires Redis deployment
   - Most complex implementation
   - High security value

### Phase 3: Security Hardening (Week 2)
5. **Issue #1: Token Hashing** - 6 hours
   - Breaking change for active reset tokens
   - Requires careful deployment

### Total Estimated Time: 22 hours (~3 days)

---

## Post-Implementation Validation

### Security Testing Checklist

- [ ] Penetration test: timing attack on login (before/after metrics)
- [ ] Penetration test: distributed brute force (verify lockout triggers)
- [ ] Verify reset tokens in DB are hashed (inspect raw DB values)
- [ ] Verify multi-org email isolation (create users in 2 orgs)
- [ ] Load test: 100 concurrent user creations (verify no 500 errors)

### Monitoring & Alerting

- [ ] Set up alert: Account lockout triggered >10 times/hour
- [ ] Set up alert: Redis connection failures
- [ ] Set up alert: Unique constraint violations (might indicate attack)
- [ ] Dashboard: Track failed login attempts per account
- [ ] Dashboard: Track active reset token usage

### Documentation Updates

- [ ] Update `docs/AI_SERVER_CONNECTION_ARCHITECTURE.md` with Redis requirement
- [ ] Update `ai-server/README.md` with new environment variables
- [ ] Add "Account Security" section to admin user guide
- [ ] Document idempotency key usage for API consumers

---

## Rollback Plans

Each fix has independent rollback procedure:

**Issue #1 (Token Hashing)**: Revert code, existing plaintext tokens continue working  
**Issue #2 (Timing Attack)**: Revert code, no data changes  
**Issue #3 (Multi-Tenancy)**: Revert migration + code, restore old constraint  
**Issue #4 (Account Lockout)**: Disable Redis, fail-open behavior allows logins  
**Issue #5 (Race Condition)**: Revert code, duplicate check restored  

No cross-dependencies between fixes—can deploy/rollback independently.

---

## Appendix: Additional Recommendations

### Lower-Priority Security Improvements

After completing the 5 critical fixes, consider these medium-priority enhancements:

1. **Password Strength Validation**: Use zxcvbn library for password strength scoring
2. **Email Notifications**: Send alerts on password changes, new logins from unknown IPs
3. **Token Revocation**: Implement JWT blacklist for immediate logout
4. **Audit Logging**: Track all admin actions (create/update/delete users)
5. **Session Management**: Track concurrent sessions, allow users to revoke devices
6. **2FA Support**: TOTP-based two-factor authentication for superadmins

See full analysis document for details on each recommendation.

---

**End of Critical Security Fixes Plan**

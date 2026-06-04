# Non-JIRA Users Time Tracking — Implementation Plan

**Date:** 2026-05-27  
**Status:** Planning  
**Goal:** Enable time tracking for users without Jira accounts while maintaining full compatibility with existing JIRA users

---

## 1. Problem Statement

Currently, all users in the system must have a Jira account because:
- The `users` table has `atlassian_account_id TEXT UNIQUE NOT NULL`
- User authentication flows through Atlassian OAuth
- Organization assignment depends on Jira cloud ID
- Desktop app requires Atlassian OAuth for initial setup

**New Requirement:**  
Support time tracking for employees who don't have Jira licenses but still need their work activity logged and analyzed.

---

## 2. Current Architecture Analysis

### 2.1 Current User Types

| User Type | Table | Authentication | Purpose |
|-----------|-------|----------------|---------|
| **JIRA Users** | `users` | Atlassian OAuth | Desktop app time tracking + Forge app access |
| **Portal Admins** | `portal_admin_users` | Email/Password | Web portal analytics viewing only |

### 2.2 Data Flow for JIRA Users

```
Desktop App Login
  ↓
Atlassian OAuth → Token + Account ID
  ↓
Fetch accessible-resources → Cloud ID
  ↓
Create/Update organization (by cloud_id)
  ↓
Create/Update user (atlassian_account_id + organization_id)
  ↓
Capture activity → activity_records (user_id + organization_id)
```

### 2.3 Key Tables Affected

**users table:**
```sql
id UUID PRIMARY KEY
atlassian_account_id TEXT UNIQUE NOT NULL  ← Must change
email TEXT
display_name TEXT
organization_id UUID NOT NULL REFERENCES organizations(id)
... (desktop tracking fields)
```

**activity_records table:**
```sql
id UUID PRIMARY KEY
user_id UUID NOT NULL REFERENCES users(id)  ← Works for both user types
organization_id UUID REFERENCES organizations(id)
window_title TEXT
ocr_text TEXT
... (tracking data)
```

---

## 3. Proposed Solution: Hybrid User Model

### 3.1 Design Principles

1. **Single Source of Truth:** One `users` table for all time-tracking users
2. **Backward Compatibility:** All existing JIRA user flows continue unchanged
3. **Clear Discrimination:** `user_type` field distinguishes JIRA vs standalone users
4. **No Breaking Changes:** Existing queries work without modification
5. **Gradual Adoption:** Organizations can have mixed user types

### 3.2 Modified Schema

```sql
-- users table (modified)
CREATE TABLE public.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- User Type Discriminator (NEW)
    user_type TEXT NOT NULL DEFAULT 'jira' CHECK (user_type IN ('jira', 'standalone')),
    
    -- Jira-specific fields (nullable for standalone users)
    atlassian_account_id TEXT UNIQUE,  -- Changed from NOT NULL
    
    -- Common fields (required for all users)
    email TEXT NOT NULL,               -- Changed from nullable
    display_name TEXT NOT NULL,        -- Changed from nullable
    organization_id UUID NOT NULL REFERENCES organizations(id),
    
    -- Desktop app fields (common)
    desktop_logged_in BOOLEAN DEFAULT FALSE,
    desktop_last_heartbeat TIMESTAMPTZ,
    desktop_app_version TEXT,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_sync_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE,
    settings JSONB DEFAULT '{}'::JSONB,
    supabase_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- Constraints
    CONSTRAINT users_jira_account_required CHECK (
        user_type = 'standalone' OR atlassian_account_id IS NOT NULL
    ),
    CONSTRAINT users_email_org_unique UNIQUE (email, organization_id)
);
```

### 3.3 User Type Characteristics

| Characteristic | JIRA User | Standalone User |
|----------------|-----------|-----------------|
| `user_type` | `'jira'` | `'standalone'` |
| `atlassian_account_id` | Required (NOT NULL) | NULL |
| `email` | From Jira profile | From Google OAuth |
| `display_name` | From Jira profile | From Google OAuth |
| Authentication | Atlassian OAuth | Google OAuth |
| Desktop App Access | Full (Atlassian OAuth) | Full (Google OAuth) |
| Forge App Access | Yes | No |
| Time Tracking | Yes | Yes |
| Organization | From Jira cloud | Assigned by admin |

---

## 4. Time Tracking Data Storage

### 4.1 Storage Architecture

**Key Point:** Time tracking data storage is **identical** for both JIRA and standalone users. The `user_type` field only affects authentication, not data storage.

### 4.2 Primary Storage Table: `activity_records`

All time tracking data is stored in the existing `activity_records` table:

```sql
CREATE TABLE public.activity_records (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    
    -- User identification (works for BOTH user types)
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    
    -- Activity metadata
    window_title TEXT,
    application_name TEXT,
    classification TEXT CHECK (classification IN ('productive', 'non_productive', 'private', 'unknown')),
    
    -- OCR data
    ocr_text TEXT,
    ocr_method TEXT,
    ocr_confidence REAL,
    ocr_error_message TEXT,
    
    -- Time tracking
    total_time_seconds INTEGER,
    visit_count INTEGER DEFAULT 1,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    duration_seconds INTEGER,
    
    -- Batch metadata
    batch_timestamp TIMESTAMPTZ,
    batch_start TIMESTAMPTZ,
    batch_end TIMESTAMPTZ,
    work_date DATE,
    user_timezone TEXT,
    
    -- Issue assignment
    project_key TEXT,
    user_assigned_issue_key TEXT,
    user_assigned_issues TEXT,
    
    -- Processing status
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'analyzed', 'failed')),
    metadata JSONB DEFAULT '{}'::JSONB,
    retry_count INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    analyzed_at TIMESTAMPTZ
);
```

### 4.3 Data Flow for Standalone Users

```
Desktop App (Standalone User)
  ↓
Captures window activity every 5 minutes
  ↓
Aggregates into sessions (start_time → end_time)
  ↓
Performs local OCR (WinRT/RapidOCR)
  ↓
Redacts PII via Presidio
  ↓
POST to AI Server: /api/activity/batch
Headers: Authorization: Bearer <JWT from Google OAuth>
Body: {
  records: [
    {
      user_id: "<user UUID>",
      organization_id: "<org UUID>",
      window_title: "Visual Studio Code",
      application_name: "Code.exe",
      ocr_text: "[redacted text]",
      start_time: "2026-05-27T10:00:00Z",
      end_time: "2026-05-27T10:05:00Z",
      duration_seconds: 300,
      classification: "productive",
      ...
    }
  ]
}
  ↓
AI Server validates JWT
  ↓
Inserts records into activity_records table
  ↓
Background AI analysis (if enabled)
  ↓
Updates status to 'analyzed'
```

### 4.4 Comparison: JIRA vs Standalone Users

| Aspect | JIRA Users | Standalone Users | Notes |
|--------|-----------|------------------|-------|
| **Storage Table** | `activity_records` | `activity_records` | Identical |
| **user_id** | UUID from `users` | UUID from `users` | Same FK |
| **organization_id** | From Jira cloud | Admin-assigned | Same FK |
| **Time Tracking** | ✅ Full tracking | ✅ Full tracking | Identical |
| **OCR Text** | ✅ Captured | ✅ Captured | Identical |
| **AI Analysis** | ✅ If enabled | ✅ If enabled | Identical |
| **Issue Matching** | ✅ From Jira | ❌ N/A | Different |
| **Worklog Sync** | ✅ To Jira | ❌ Not available | Different |
| **Portal Analytics** | ✅ Visible | ✅ Visible | Identical |

### 4.5 Additional Tables

#### Screenshots (Optional)

If screenshots are enabled, they're stored in Supabase Storage and referenced in `screenshots` table:

```sql
CREATE TABLE public.screenshots (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    organization_id UUID REFERENCES public.organizations(id),
    storage_url TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    -- Works identically for both user types
);
```

Storage path format: `screenshots/{org_id}/{user_id}/{date}/{timestamp}.png`

#### Worklogs (JIRA Users Only)

Synced to Jira for JIRA users only:

```sql
CREATE TABLE public.worklogs (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    jira_worklog_id TEXT NOT NULL,
    jira_issue_key TEXT NOT NULL,
    time_spent_seconds INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    -- Only populated for JIRA users
);
```

**Standalone users:** This table is never populated. Their time tracking exists only in `activity_records`.

### 4.6 Query Examples

**Get standalone user's tracked time for a date range:**

```sql
SELECT 
    window_title,
    application_name,
    classification,
    start_time,
    end_time,
    duration_seconds,
    work_date
FROM activity_records
WHERE user_id = '<standalone-user-uuid>'
    AND organization_id = '<org-uuid>'
    AND work_date BETWEEN '2026-05-01' AND '2026-05-31'
ORDER BY start_time DESC;
```

**Get total productive time by day:**

```sql
SELECT 
    work_date,
    SUM(duration_seconds) / 3600.0 AS hours_worked,
    COUNT(*) AS session_count
FROM activity_records
WHERE user_id = '<standalone-user-uuid>'
    AND organization_id = '<org-uuid>'
    AND classification = 'productive'
    AND work_date BETWEEN '2026-05-01' AND '2026-05-31'
GROUP BY work_date
ORDER BY work_date;
```

**Compare JIRA vs standalone users in same org:**

```sql
SELECT 
    u.display_name,
    u.user_type,
    COUNT(ar.id) AS activity_count,
    SUM(ar.duration_seconds) / 3600.0 AS total_hours,
    MIN(ar.work_date) AS first_tracked_date,
    MAX(ar.work_date) AS last_tracked_date
FROM users u
LEFT JOIN activity_records ar ON u.id = ar.user_id
WHERE u.organization_id = '<org-uuid>'
    AND u.is_active = true
GROUP BY u.id, u.display_name, u.user_type
ORDER BY total_hours DESC;
```

### 4.7 Data Retention & Cleanup

Both user types follow the same retention policy:

```javascript
// ai-server cleanup service (configured via .env)
CLEANUP_MONTHS_TO_KEEP=2  // Default: 2 months

// Cleanup job runs monthly
// Deletes screenshot files (not metadata) older than N months
// activity_records metadata is preserved indefinitely
```

**Note:** `activity_records` table records are **not** auto-deleted. Organizations must manually delete old data via:
1. Portal admin interface (future feature)
2. User deletion (CASCADE deletes their records)
3. Organization deletion (CASCADE deletes all records)

### 4.8 Analytics & Reporting

Portal analytics queries work identically for both user types:

**Available views:**
- Daily time summary by user
- Weekly productivity trends
- Application usage breakdown
- Top activities by duration
- Classification distribution (productive/non-productive/private)

**API endpoints that work for both types:**
- `GET /api/portal/dashboard` - KPIs (all users in org)
- `GET /api/portal/reports/user/:userId` - Individual user report
- `GET /api/portal/reports/team` - Team comparison
- `GET /api/portal/reports/export` - CSV export

**Note:** Issue-level reporting is only meaningful for JIRA users who have `user_assigned_issue_key` populated.

### 4.9 Storage Quotas & Limits

| Resource | Limit | Applies To |
|----------|-------|------------|
| activity_records per user | Unlimited | Both types |
| Screenshots (if enabled) | 10 GB per org | Both types |
| OCR text length | 50,000 chars | Both types |
| Batch upload size | 1000 records | Both types |

### 4.10 Backup & Export

Users can export their data via:

**Portal UI:**
- Settings → Export My Data
- Generates ZIP with:
  - `activity_records.csv` (all time tracking data)
  - `screenshots/` (if enabled)
  - `summary_report.pdf`

**API:**
```javascript
GET /api/user-data/export
Authorization: Bearer <portal-token>

// Returns job ID, polls for completion
// Downloads ZIP when ready
```

---

## 5. Implementation Plan

### 5.1 Phase 1: Database Migration

**File:** `supabase/migrations/20260527_add_standalone_users.sql`

```sql
-- ============================================================================
-- Migration: Add support for standalone (non-Jira) users
-- Date: 2026-05-27
-- Description: Enables time tracking for users without Jira accounts
-- ============================================================================

BEGIN;

-- Step 1: Add user_type column (default 'jira' for existing users)
ALTER TABLE public.users 
ADD COLUMN user_type TEXT NOT NULL DEFAULT 'jira' 
CHECK (user_type IN ('jira', 'standalone'));

-- Step 2: Add password_hash column for standalone users
ALTER TABLE public.users 
ALTER COLUMN atlassian_account_id DROP NOT NULL;

-- Step 4: Make email and display_name required (for standalone users)
UPDATE public.users SET email = 'unknown@example.com' WHERE email IS NULL;
UPDATE public.users SET display_name = 'Unknown User' WHERE display_name IS NULL;

ALTER TA3: Make email and display_name required (for all
ALTER COLUMN email SET NOT NULL;

ALTER TABLE public.users 
ALTER COLUMN display_name SET NOT NULL;

-- Step 4: Add constraints
ALTER TABLE public.users 
ADD CONSTRAINT users_jira_account_required CHECK (
    user_type = 'standalone' OR atlassian_account_id IS NOT NULL
);

-- Step 5: Add unique constraint on email per organization
ALTER TABLE public.users 
ADD CONSTRAINT users_email_org_unique UNIQUE (email, organization_id);

-- Step 7: Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_user_type ON public.users(user_type);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);

-- Step 8: Update comments
COMMENT 6: Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_user_type ON public.users(user_type);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);

-- Step 7: Update comments
COMMENT ON COLUMN public.users.user_type IS 
  'User type: jira (Atlassian OAuth) or standalone (Google OAuth
- ✅ Migration runs without errors on dev Supabase
- ✅ All existing users have `user_type = 'jira'`
- ✅ Existing queries return same results
- ✅ Constraints prevent invalid data combinations

### 5.2 Phase 2: Backend API for Standalone User Management

#### 5.2.1 New Controller: Standalone Users CRUD

**File:** `ai-server/src/controllers/standalone-users-controller.js`

```javascript
/**
 * Standalone Users Controller
 * 
 * Manages standalone (non-Jira) users for time tracking.
 * Only accessible by organization admins via portal.
 */

co 
 * Note: Standalone users authenticate via Google OAuth (no password).
 */

const { getClient } = require('../services/db/supabase-client');
const logger = require('../utils/logger')
 * List standalone users in the organization
 * GET /api/portal/standalone-users?page=1&limit=20
 */
async function listStandaloneUsers(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    const supabase = getClient();
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database unavailable' });
    }
    
    // Get total count
    const { count } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('user_type', 'standalone');
    
    // Get paginated data
    const { data, error } = await supabase
      .from('users')
      .select('id, email, display_name, is_active, desktop_logged_in, desktop_last_heartbeat, created_at, updated_at')
      .eq('organization_id', orgId)
      .eq('user_type', 'standalone')
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    
    if (error) throw error;
    
    return res.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        totalCount: count,
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    logger.error('[StandaloneUsers] List failed', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Create standalone user
 * POST /api/portal/standalone-users
 * Body: { email, displayName, password }
 */ invitation
 * POST /api/portal/standalone-users
 * Body: { email, displayName }
 * 
 * Note: User will authenticate via Google OAuth on first desktop app login.
 * Admin only needs to register their email with the organization.
 */
async function createStandaloneUser(req, res) {
  try {
    const { orgId, role } = req.portalUser;
    const { email, displayName } = req.body;
    
    // Validation
    if (!email || !displayName) {
      return res.status(400).json({
        success: false,
        error: 'Email and displayName are required'
      });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const supabase = getClient();
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database unavailable' });
    }
    
    // Check for duplicate email in org
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', orgId)
      .eq('email', normalizedEmail)
      .single();
    
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'User with this email already exists in your organization'
      });
    }
    
    // Create pre-authorized user (Google OAuth will complete the record)
    const { data: newUser, error } = await supabase
      .from('users')
      .insert({
        user_type: 'standalone',
        email: normalizedEmail,
        display_name: displayName,
        organization_id: orgId,
        is_active: true
      })
      .select('id, email, display_name, user_type, is_active, created_at')
      .single();
    
    if (error) throw error;
    
    logger.info('[StandaloneUsers] User invitation created', {
      userId: newUser.id,
      email: newUser.email,
      orgId
    });
    
    // TODO: Send email notification with desktop app download link
    
    return res.status(201).json({ 
      success: true, 
      data: newUser,
      message: 'User can now authenticate with Google OAuth in the desktop app'
   .message });
  }
}

/**
 * Update standalone user
 * PUT /api/portal/standalone-users/:userId
 * Body: { displayName?, password?, isActive? }
 */
async function updateStandaloneUser(req, res) {
  try {isActive? }
 */
async function updateStandaloneUser(req, res) {
  try {
    const { orgId } = req.portalUser;
    const { userId } = req.params;
    const { displayName, isActive } = req.body;
    
    if (!displayName && isActive === undefined) {
      return res.status(400).json({
        success: false,
        error: 'At least one field must be provided'
      });
    }
    
    const supabase = getClient();
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database unavailable' });
    }
    
    // Verify user exists and belongs to org
    const { data: user } = await supabase
      .from('users')
      .select('id, user_type')
      .eq('id', userId)
      .eq('organization_id', orgId)
      .single();
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    if (user.user_type !== 'standalone') {
      return res.status(400).json({
        success: false,
        error: 'Cannot modify JIRA users through this endpoint'
      });
    }
    
    // Build updates
    const updates = { updated_at: new Date().toISOString() };
    if (displayName) updates.display_name = displayName;
    if (isActive !== undefined) updates.is_active = isActive; .from('users')
      .update(updates)
      .eq('id', userId)
      .eq('organization_id', orgId)
      .select('id, email, display_name, is_active, updated_at')
      .single();
    
    if (error) throw error;
    
    logger.info('[StandaloneUsers] User updated', { userId, orgId });
    
    return res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('[StandaloneUsers] Update failed', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Delete standalone user
 * DELETE /api/portal/standalone-users/:userId
 */
async function deleteStandaloneUser(req, res) {
  try {
    const { orgId } = req.portalUser;
    const { userId } = req.params;
    
    const supabase = getClient();
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database unavailable' });
    }
    
    // Verify user exists and is standalone
    const { data: user } = await supabase
      .from('users')
      .select('id, user_type, email')
      .eq('id', userId)
      .eq('organization_id', orgId)
      .single();
    
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    
    if (user.user_type !== 'standalone') {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete JIRA users through this endpoint'
      });
    }
    
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', userId)
      .eq('organization_id', orgId);
    
    if (error) throw error;
    
    logger.info('[StandaloneUsers] User deleted', {
      userId,
      email: user.email,
      orgId
    });
    
    return res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    logger.error('[StandaloneUsers] Delete failed', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = {
  listStandaloneUsers,
  createStandaloneUser,
  updateStandaloneUser,
  deleteStandaloneUser
};
```

#### 5.2.2 Register Routes

**File:** `ai-server/src/index.js` (add routes)

```javascript
// Standalone users management (portal admins only)
const standaloneUsersController = require('./controllers/standalone-users-controller');

app.get(
  '/api/portal/standalone-users',
  portalAuthMiddleware.verifyPortalToken,
  standaloneUsersController.listStandaloneUsers
);

app.post(
  '/api/portal/standalone-users',
  portalAuthMiddleware.verifyPortalToken,
  standaloneUsersController.createStandaloneUser
);

app.put(
  '/api/portal/standalone-users/:userId',
  portalAuthMiddleware.verifyPortalToken,
  standaloneUsersController.updateStandaloneUser
);

app.delete(
  '/api/portal/standalone-users/:userId',
  portalAuthMiddleware.verifyPortalToken,
  standaloneUsersController.deleteStandaloneUser
);
```

### 5.3 Phase 3: Desktop App Authentication for Standalone Users

#### 5.3.1 New Auth Endpoint

**File:** `ai-server/src/controllers/auth-controller.js` (add function)

```javascript
/**
 * Authenticate standalone user (email/password)
 * POST /api/auth/standalone-login
 * Body: { email, password, organizationId }
 */
async function standaloneLogin(req, res) {
  try {
    const { email, password, organizationId } = req.body;
    
    if (!email || !password || !organizationId) {
      return res.status(400).json({
        success: false,
   Complete standalone user Google OAuth authentication
 * POST /api/auth/standalone-oauth-complete
 * Body: { googleToken, organizationId }
 * 
 * Verifies Google token, links user to organization if pre-authorized.
 */
async function standaloneOAuthComplete(req, res) {
  try {
    const { googleToken, organizationId } = req.body;
    
    if (!googleToken || !organizationId) {
      return res.status(400).json({
        success: false,
        error: 'Google token and organizationId are required'
      });
    }
    
    // Verify Google token with Google's API
    const googleUserInfo = await verifyGoogleToken(googleToken);
    
    if (!googleUserInfo) {
      return res.status(401).json({
        success: false,
        error: 'Invalid Google token'
      });
    }
    
    const normalizedEmail = googleUserInfo.email.toLowerCase().trim();
    
    const supabase = getClient();
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database unavailable' });
    }
    
    // Check if user is pre-authorized in this organization
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('id, email, display_name, user_type, organization_id, is_active')
      .eq('email', normalizedEmail)
      .eq('organization_id', organizationId)
      .eq('user_type', 'standalone')
      .single();
    
    if (fetchError || !user) {
      return res.status(403).json({
        success: false,
        error: 'Your email is not authorized for this organization. Contact your administrator.'
      });
    }
    
    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Account is inactive. Contact your administrator.'
      });
    }
    
    // Update display name from Google if not set
    if (!user.display_name || user.display_name === normalizedEmail) {
      await supabase
        .from('users')
        .update({ 
          display_name: googleUserInfo.name || googleUserInfo.email,
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id);
    }
    
    // Generate JWT token (same format as JIRA users)
    const payload = {
      user_id: user.id,
      org_id: user.organization_id,
      email: user.email,
      user_type: 'standalone'
    };
    
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
    
    logger.info('[Auth] Standalone user authenticated via Google OAuth', {
      userId: user.id,
      email: user.email,
      orgId: user.organization_id
    });
    
    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        organizationId: user.organization_id,
        userType: 'standalone'
      }
    });
  } catch (error) {
    logger.error('[Auth] Standalone OAuth complete failed', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * Verify Google OAuth token with Google's API
 */
async function verifyGoogleToken(token) {
  try {
    const response = await axios.get(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${token}`,
      { timeout: 10000 }
    );
    google_login(self, org_id: str) -> dict:
        """
        Authenticate standalone user with Google OAuth.
        
        Args:
            org_id: Organization UUID
            
        Returns:
            dict: User info and JWT token
            
        Raises:
            Exception: If authentication fails
        """
        try:
            # Start local OAuth server to receive callback
            oauth_server = LocalOAuthServer(port=8765)
            oauth_server.start()
            
            # Build Google OAuth URL
            auth_url = (
                f"https://accounts.google.com/o/oauth2/v2/auth?"
                f"client_id={os.getenv('GOOGLE_CLIENT_ID')}&"
                f"redirect_uri=http://localhost:8765/callback&"
                f"response_type=token&"
                f"scope=openid email profile"
            )
            
            # Open browser for user to authenticate
            webbrowser.open(auth_url)
            
            # Wait for callback with token
            google_token = oauth_server.wait_for_token(timeout=300)
            oauth_server.stop()
            
            if not google_token:
                raise Exception('Google authentication cancelled or timed out')
            
            # Complete authentication with backend
            response = requests.post(
                f'{self.ai_server_url}/api/auth/standalone-oauth-complete',
                json={
                    'googleToken': google_token,
                    'organizationId': org_id
                },
                headers={'Content-Type': 'application/json'},
                timeout=30
            )
            
            if response.status_code != 200:
                error_data = response.json()
                error_msg = error_data.get('error', 'Authentication failed')
                raise Exception(error_msg)
            
            data = response.json()
            
            # Store credentials securely
            self.store_standalone_credentials(
                email=data['user']['email'],
                user_id=data['user']['id'],
                org_id=data['user']['organizationId'],
                token=data['token']
            )
            
            return data
            
        except Exception as e:
            logger.error(f'Standalone Google login failed: {e}')
            raise
    
    def store_standalone_credentials(self, email: str, user_id: str, org_id: str, token: str):
        """Store standalone user credentials securely."""
        self.keyring.set_password('jiraforge_standalone', 'email', email)
        self.keyring.set_password('jiraforge_standalone', 'user_id', user_id)
        self.keyring.set_password('jiraforge_standalone', 'org_id', org_id)
        self.keyring.set_password('jiraforge_standalone', 'token', token)
        
        # Also store in encrypted DB
        self.db_connection.execute('''
            INSERT OR REPLACE INTO auth_credentials (key, value)
            VALUES 
                ('user_type', 'standalone'),
                ('email', ?),
                ('user_id', ?),
                ('org_id', ?),
                ('token', ?)
        ''', (email, user_id, org_id, token))


class LocalOAuthServer:
    """Simple HTTP server to receive OAuth callback."""
    
    def __init__(self, port=8765):
        self.p
        standalone_frame, 
        text='Login with your Google account\n(must be pre-authorized by admin)',
        justify='center'
    ).pack(pady=(20, 10))
    
    ttk.Label(standalone_frame, text='Organization ID:').pack(pady=5)
    org_entry = ttk.Entry(standalone_frame, width=40)
    org_entry.pack(pady=5)
    
    ttk.Label(
        standalone_frame,
        text='(Ask your administrator for the Organization ID)',
        font=('TkDefaultFont', 8),
        foreground='gray'
    ).pack(pady=(0, 10))
    
    def do_standalone_login():
        org_id = org_entry.get().strip()
        
        if not org_id:
            messagebox.showerror('Error', 'Organization ID is required')
            return
        
        try:
            # Disable button during auth
            login_btn.config(state='disabled', text='Authenticating...')
            
            result = self.auth_manager.standalone_google_login(org_id)
            self.current_user_id = result['user']['id']
            self.organization_id = result['user']['organizationId']
            self.user_info = result['user']
            
            dialog.destroy()
            self.on_login_success()
        except Exception as e:
            login_btn.config(state='normal', text='Login with Google')
            messagebox.showerror('Login Failed', str(e))
    
    login_btn = ttk.Button(
        standalone_frame,
        text='Login with Google',
        command=do_standalone_login
    )
    login_btn           html = '''
                <html>
                <body>
                    <h2>Authenticating...</h2>
                    <script>
                        const hash = window.location.hash.substring(1);
                        const params = new URLSearchParams(hash);
                        const token = params.get('id_token');
                        if (token) {
                            fetch('/token?id_token=' + token);
                        }
                        setTimeout(() => {
                            document.body.innerHTML = '<h2>✅ Authentication successful! You can close this window.</h2>';
                        }, 1000);
                    </script>
                </body>
                </html>
                '''
                self.wfile.write(html.encode())
            
            def do_GET_token(self):
                # Receive token from JavaScript
                parsed = urlparse(self.path)
                params = parse_qs(parsed.query)
                if 'id_token' in params:
                    parent.token = params['id_token'][0]
                self.send_response(200)
                self.end_headers()
            
            def log_message(self, format, *args):
                pass  # Suppress logs
        
        return OAuthHandler
                user_id=data['user']['id'],
                org_id=data['user']['organizationId'],
                token=data['token']
            )
            
            return data
            
        except Exception as e: });
    setShowModal(true);
  };
  
  const handleEdit = (user) => {
    setModalMode('edit');
    setEditingUser(user);
    setFormData({ email: user.email, displayName: user.display_name
                ('user_type', 'standalone'),
                ('email', ?),
                ('user_id', ?),
                ('org_id', ?),
                ('token', ?)
        ''', (email, user_id, org_id, token))
```

**File:** `python-desktop-app/desktop_app.py` (add UI for standalone login)

```python
def show_login_dialog(self):
    """Show login dialog with options for JIRA and standalone users."""
    dialog = tk.Toplevel(self.root)
    dialog.title("Login to JIRAForge")
    dialog.geometry("400x300")
    
    # Tab control
    notebook = ttk.Notebook(dialog)
    notebook.pack(fill='both', expand=True, padx=10, pady=10)
    
    # JIRA OAuth tab
    jira_frame = ttk.Frame(notebook)
    notebook.add(jira_frame, text='JIRA Users')
    
    ttk.Label(jira_frame, text='Login with your Atlassian account').pack(pady=20)
    ttk.Button(
        jira_frame,
        text='Login with Atlassian',
        command=self.start_jira_oauth
    ).pack(pady=10)
    
    # Standalone tab
    standalone_frame = ttk.Frame(notebook)
    notebook.add(standalone_frame, text='Standalone Users')
    
    ttk.Label(standalone_frame, text='Email:').pack(pady=(20, 5))
    email_entry = ttk.Entry(standalone_frame, width=30)
    email_entry.pack(pady=5)
    
    ttk.Label(standalone_frame, text='Password:').pack(pady=5)
    password_entry = ttk.Entry(standalone_frame, width=30, show='*')
    password_entry.pack(pady=5)
    
    ttk.Label(standalone_frame, text='Organization ID:').pack(pady=5)
    org_entry = ttk.Entry(standalone_frame, width=30)
    org_entry.pack(pady=5)
    
    def do_standalone_login():
        email = email_entry.get().strip()
        password = password_entry.get()
        org_id = org_entry.get().strip()
        
        if not email or not password or not org_id:
            messagebox.showerror('Error', 'All fields are required')
            return
        
        try:
            result = self.auth_manager.standalone_login(email, password, org_id)
            self.current_user_id = result['user']['id']
            self.organization_id = result['user']['organizationId']
            self.user_info = result['user']
            
          })
        });
        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || 'Failed to create user');
        }
        const result = await response.json();
        setSuccess(result.message || 'User invitation created. They can now authenticate via Google OAuth.');
      } else if (modalMode === 'edit') {
        const response = await fetch(`/api/portal/standalone-users/${editingUser.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ displayName: formData.displayName })
        });
        if (!response.ok) throw new Error('Failed to update user');
        setSuccess('User updatedents/common/ErrorBanner';

function UsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState('create'); // 'create' | 'edit' | 'password'
  const [editingUser, setEditingUser] = useState(null);
  const [formData, setFormData] = useState({ email: '', displayName: '', password: '' });
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  
  useEffect(() => {
    loadUsers();
  }, []);
  
  const loadUsers = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/portal/standalone-users', {
        headers: { Authorization: `Bearer ${localStorage.getItem('portal_token')}` }
      });
      if (!response.ok) throw new Error('Failed to load users');
      const data = await response.json();
      setUsers(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  
  const handleCreate = () => {
    setModalMode('create');
    setFormData({ email: '', displayName: '', password: '' });
    setShowModal(true);
  };
  
  const handleEdit = (user) => {
    setModalMode('edit');
    setEditingUser(user);
    setFormData({ email: user.email, displayName: user.display_name, password: '' });
    setShowModal(true);
  };
  
  const handlePasswordReset = (user) => {
    setModalMode('password');
    setEditingUser(user);
    setFormData({ email: user.email, displayName: user.display_name, password: '' });
    setShowModal(true);
  };
  
  const handleSave = async () => {
    try {
      const token = localStorage.getItem('portal_token');
      
      if (modalMode === 'create') {
        const response = await fetch('/api/portal/standalone-users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            email: formData.email,
            displayName: formData.displayName,
            password: formData.password
          })
        });
        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || 'Failed to create user');
        }
        setSuccess('User created successfully');
      } else if (modalMode === 'edit') {
        const response = await fetch(`/api/portal/standalone-users/${editingUser.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ displayName: formData.displayName })
        });
        if (!response.ok) throw new Error('Failed to update user');
        setSuccess('User updated successfully');
      } else if (modalMode === 'password') {
        const response = await fetch(`/api/portal/standalone-users/${editingUser.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ password: formData.password })
        });
        if (!response.ok) throw new Error('Failed to reset password');
        setSuccess('Password reset successfully');
      }
      
      setShowModal(false);
      loadUsers();
    } catch (err) {
      setError(err.message);
    }
  };
  
  const handleDelete = async () => {
    try {
      const response = await fetch(`/api/portal/standalone-users/${deleteConfirm.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('portal_token')}` }
      });
      if (!response.ok) throw new Error('Failed to delete user');
      setSuccess('User deleted successfully');
      setDeleteConfirm(null);
      loadUsers();
    } catch (err) {
      setError(err.message);
    }
  };
  
  const columns = [
    { key: 'display_name', label: 'Name', sortable: true },
    { key: 'email', label: 'Email', sortable: true },
    {
      key: 'desktop_logged_in',
      label: 'Desktop App',
      render: (val) => val ? <Check className="text-green-500" /> : <X className="text-gray-400" />
    },
    { key: 'created_at', label: 'Created', sortable: true, render: (val) => new Date(val).toLocaleDateString() },
    {
      key: 'actions',
      label: 'Actions',
      render: (_, user) => ( (Google)', sortable: true },
    {
      key: 'desktop_logged_in',
      label: 'Desktop App',
      render: (val) => val ? <Check className="text-green-500" /> : <X className="text-gray-400" />
    },
    { key: 'created_at', label: 'Invited', sortable: true, render: (val) => new Date(val).toLocaleDateString() },
    {
      key: 'actions',
      label: 'Actions',
      render: (_, user) => (
        <div className="flex gap-2">
          <button onClick={() => handleEdit(user)} title="Edit">
            <Edit2eturn <LoadingSpinner />;
  
  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Standalone Users</h1>
        <button onClick={handleCreate} className="btn btn-primary flex items-center gap-2">
          <UserPlus size={18} />
          Add User
        </button>
      </div>
      
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
      {success && <div className="alert alert-success mb-4">{success}</div>}
      
      <DataTable
        data={users}
        columns={columns}
        sortable
        searchable
        searchPlaceholder="Search users..."
      />
      
      {/* Modal and ConfirmDialog components here */}
    </div>
  );
}

export default UsersPage;
```

### 5.5 Phase 5: Testing & Verification

#### 5.5.1 Unit Tests

**File:** `ai-server/tests/controllers/standalone-users-controller.test.js`

```javascript
const request = require('supertest');
const app = require('../../src/index');
const bcrypt = require('bcrypt');

describe('Standalone Users Controller', () => {
  let authToken;
  let orgId;
  let testUserId;
  
  beforeAll(async () => {
    // Setup test org and admin user
    // Login and get token
  });
  
  test('POST /api/portal/standalone-users - creates standalone user', async () => {
    const res = await request(app)
      .post('/api/portal/standalone-users')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        email: 'test@example.com',
        displayName: 'Test User',
        password: 'securepassword123'
      });
    
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe('test@example.com');
    expect(res.body.data.user_type).toBe('standalone'); invitation', async () => {
    const res = await request(app)
      .post('/api/portal/standalone-users')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        email: 'test@example.com',
        displayName: 'Test User'
      });
    
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe('test@example.com');
    expect(res.body.data.user_type).toBe('standalone');
    testUserId = res.body.data.id;
  });
  
  test('POST /api/auth/standalone-oauth-complete - authenticates standalone user with Google', async () => {
    const mockGoogleToken = 'mock_google_id_token';
    
    // Mock Google token verification
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        email: 'test@example.com',
        name: 'Test User',
        aud: process.env.GOOGLE_CLIENT_ID,
        email_verified: 'true'
      }
    });
    
    const res = await request(app)
      .post('/api/auth/standalone-oauth-complete')
      .send({
        googleToken: mockGoogleToken,
        organizationId: orgId
      });
    
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.userType).toBe('standalone'
```

#### 5.5.2 Integration Test Checklist

- [ ] JIRA users continue to work unchanged (OAuth flow)
- [ ] Standalone users can be created via portal
- [ ] Standalone users can log into desktop app
- [ ] Activity records created by standalone users appear in portal
- [ ] Standalone users cannot access Forge app
- [ ] JIRA users and standalone users can coexist in same org
- [ ] User deletion cascades to activity_records
- [ ] Email uniqueness enforced per organization
- [ ] Password reset works for standalone users
- [ ] Desktop app heartbeat updates for standalone users

---

## 6. Security Considerations

### 6.1 Authentication Security

| Aspect | JIRA Users | Standalone Users |
|--------|-----------|------------------|
| Auth Method | Atlassian OAuth 2.0 | Email/Password |
| Password Storage | N/A | bcrypt (10 rounds) |
| Token Type | Atlassian tokens | JWT (30-day expiry) |
| Token Storage | OS keyring | OS keyring |
| MFA | Via Atlassian | Future enhancement |

### 6.2 Access Control

- Standalone users **cannot** access Forge app (no Atlassian account)
- Standalone users **can** access desktop app (time tracking only)
- Portal admins can only manage users Google OAuth 2.0 |
| Password Storage | N/A | N/A (Google handles) |
| Token Type | Atlassian tokens | JWT (30-day expiry) |
| Token Storage | OS keyring | OS keyring |
| MFA | Via Atlassian | Via Google
- Password hashes never returned in API responses
- JWT tokens signed with `PORTAL_JWT_SECRET`
- Activity data (OCR text) same privacy rules as JIRA users
- No passwords stored (Google OAuth handles authentication)
- JWT tokens signed with `AI_SERVER_API_KEY`
- Activity data (OCR text) same privacy rules as JIRA users
- User deletion triggers cascade delete of activity records
- Google OAuth tokens verified via Google's tokeninfo endpoint
## 6. Deployment Plan

### 7.1 Pre-Deployment Checklist

- [ ] Test migration on dev Supabase instance
- [ ] Verify all existing tests pass
- [ ] Add new tests for standalone user flows
- [ ] Update API documentation
- [ ] Update desktop app version (requires new release)
- [ ] Update portal UI with user management page

### 7.2 Deployment Steps

1. **Deploy database migration** (Supabase Studio)
   ```sql
   -- Run: supabase/migrations/20260527_add_standalone_users.sql
   ```

2. **Deploy AI server backend** (Docker/PM2)
   ```bash
   cd ai-server
   npm test
   npm run build:dashboard
   pm2 restart ai-analysis-server
   ```

3. **Deploy desktop app update** (GitHub Releases)
   ```bash
   cd python-desktop-app
   python -m pytest tests/
   build.bat
   # Upload to GitHub releases
   ```

4. **Deploy portal UI**
   ```bash
   cd ai-server/src/portal
   npm run build
   # Automatically served by ai-server
   ```

### 7.3 Rollback Plan

If critical issues arise:

1. **Revert migration:**
   ```sql
   ALTER TABLE public.users ALTER COLUMN atlassian_account_id SET NOT NULL;
   ALTER TABLE public.users DROP COLUMN user_type;
   ALTER TABLE public.users DROP COLUMN password_hash;
   ```

2. **Disable standalone endpoints:**
   ```javascript
   // Comment out routes in ai-server/src/index.js
   ```

3. **Desktop app auto-update** will revert users to previous version

---

## 7. Useuser's **Google email** and display name
5. Click **Create**
6. Share organization ID with user
7. User can now authenticate via Google in desktop app

**Creating a Standalone User:**

1. Log into web portal
2. Go to **Users** page
3. Click **Add User**
4. Enter email, name, and temporary password
5. Share credentials with user securely
6. User can reset password on first login

**Managing Users:**

- View all standalone users in your organization
- Edit usorganization ID (provided by admin)
4. Click "Login with Google"
5. Browser opens for Google authentication
6. Sign in with your Google account
7 Delete users (removes all activity data)

### 8.2 For Standalone Users

**Desktop App Setup:**

1. Download and install JIRAForge Desktop App
2. Launch app and select "Standalone User" login
3. Enter email, password, and organization ID (provided by admin)
4. Click "Login"
5. App will start tracking your work activity
Email notification when user is invited
- Bulk user import (CSV upload)
- User activity reports per user
- Desktop app download link in invitationeenshots + activity)
- ✅ OCR and AI analysis
- ✅ View your own activity in web portal
- ❌ Cannot access Jira integration features
- ❌ Cannot sync worklogs to Jira

---

## 9. Future Enhancements

### 9.1 Short-Term (v2)

- Self-service password reset via email
- Two-factor authentication (TOTP)
- Bulk user import (CSV upload)
- Additional OAuth providers (Microsoft, GitHub)
- User activity reports per user

### 9.2 Long-Term (v3)

- SSO integration (SAML, OIDC)
- Active Directory sync
- Role-based permissions per user
- Custom user groups/teams

---

## 10. Acceptance Criteria

### 10.1 Functional

- [ ] Standalone users can be created via web portal
- [ ] Standalone users can authenticate in desktop app
- [ ] Standalone user activity tracked in `activity_records` table
- [ ] Standalone user activity visible in web portal analytics
- [ ] JIRA users continue to work without changes
- [ ] Mixed organizations (JIRA + standalone) work correctly

### 10.2 Non-Functional

- [ ] Migration completes in < 10 seconds on production database
- [ ] Password hashing takes < 500ms (bcrypt cost 10)
- [ ] No performance degradation for existing JIRA user flows
- [ ] Google OAuth tokens verified via Google API
- [ ] JWT tokens expire after 30 days
- [ ] Failed auth attempts logged
- [ ] Duplicate email per org prevented
- [ ] Only pre-authorized emails can authenticate
- [ ] Google token audience verifi
- [ ] Passwords hashed with bcrypt (10 rounds)
- [ ] JWT tokens expire after 30 days
- [ ] Failed login attempts logged
- [ ] Duplicate email per org prevented
- [ ] Password minimum 8 characters enforced

---

## 11. Out of Scope
User self-registration (admin-only)
- Additional OAuth providers (only Google)
- Granular permissions per user (future RBAC)
- Standalone users accessing Forge app
- Migrating existing JIRA users to standalone
- Offline authentication (requires internet for OAuth)
- User self-registration
- Forgot password flow (admin reset only)
- Granular permissions per user (future RBAC)
- Standalone users accessing Forge app
- Migrating existing JIRA users to standalone

---

## 12. Questions & Answers

**Q: Can a standalone user become a JIRA user later?**  
A: No, user type is immutable once set. They would need a new account.

**Q: Can JIRA users and standalone users share the same email?**  
A: No, email is unique per organization regardless of user type.

**Q: Do standalone users count toward license limits?**  
A: This depends on your business model. Currently, no limits enforced.

**Q: Can standalone users create Jira worklogs?**  

**Q: What Google accounts can standalone users use?**  
A: Any Google account (personal Gmail or Google Workspace). Admin must pre-authorize the email address.

**Q: Does the user need to create a Google account?**  
A: If they don't have one, they can create a free Gmail account at google.com.
A: No, only JIRA users with Atlassian accounts can sync to Jira.

**Q: How do standalone users get their organization ID?**  
A: Portal admin provides it during account setup (shown in portal UI).

---

## 13. Success Metrics

Track these metrics post-deployment:

- Number of standalone users created per organization
- Standalone user authentication success rate
- Desktop app adoption rate (standalone vs JIRA)
- Support tickets related to standalone user issues
- Activity data volume from standalone users

---

**End of Implementation Plan**

**Next Steps:**
1. Review plan with stakeholders
2. Get approval for database schema changes
3. Create Phase 1 migration and test on dev
4. Begin backend implementation (Phases 2-3)
5. Desktop app integration (Phase 3.2)
6. Web portal UI (Phase 4)
7. Testing and deployment (Phases 5-6)

# Python Desktop App Migration Plan

## Overview
Migrating from the example desktop app (Google OAuth + old Supabase) to a new Python desktop app with:
- **Atlassian OAuth** (instead of Google OAuth)
- **New Supabase instance** (jvijitdewbypqbatfboi.supabase.co)
- **New database schema** (screenshots, analysis_results instead of activities)
- **PyInstaller** for .exe conversion

## Key Differences

### 1. OAuth Provider Change
- **Old**: Google OAuth via Supabase (`sign_in_with_oauth` with provider="google")
- **New**: Atlassian OAuth 3LO (direct OAuth flow, not via Supabase)

### 2. Database Schema Changes
- **Old**: `activities` table
- **New**: 
  - `screenshots` table (metadata for captured screenshots)
  - `analysis_results` table (AI analysis results)
  - `users` table structure changed (uses `atlassian_account_id` instead of `auth_id`)

### 3. Authentication Flow
- **Old**: Supabase handles OAuth → returns session → user authenticated
- **New**: 
  1. Atlassian OAuth → get access token
  2. Use token to get Atlassian user info
  3. Create/update user in Supabase `users` table with `atlassian_account_id`
  4. Store Atlassian tokens for API calls

## Migration Steps

### Step 1: Update Environment Variables
- Replace old Supabase URL/keys with new ones
- Add Atlassian OAuth credentials
- Remove Google OAuth credentials

### Step 2: Replace OAuth Implementation
- Remove Google OAuth routes (`/auth/google`)
- Implement Atlassian OAuth flow:
  - `/auth/atlassian` - Start OAuth
  - `/auth/callback` - Handle OAuth callback
  - Custom protocol handler: `brd-time-tracker://oauth/callback`

### Step 3: Update Database Operations
- Replace `activities` table operations with `screenshots` and `analysis_results`
- Update user creation/lookup to use `atlassian_account_id`
- Update screenshot upload logic

### Step 4: Update Supabase Client Usage
- Remove Supabase Auth OAuth methods
- Use direct HTTP requests for Atlassian OAuth
- Keep Supabase client for database operations only

### Step 5: Create PyInstaller Configuration
- Create `spec` file for PyInstaller
- Include all dependencies
- Configure icon and metadata

## Files to Modify

1. **example_desktop app.py** → **desktop_app.py** (renamed)
   - Replace OAuth implementation
   - Update database operations
   - Update Supabase configuration

2. **requirements.txt** (create new)
   - List all Python dependencies

3. **desktop_app.spec** (create new)
   - PyInstaller configuration

4. **.env** (update)
   - New Supabase credentials
   - Atlassian OAuth credentials


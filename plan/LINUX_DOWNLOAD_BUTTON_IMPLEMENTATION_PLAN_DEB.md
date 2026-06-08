# Linux Desktop App Download Button — Implementation Plan (.deb)

**Date:** 2026-06-05  
**Status:** Planning  
**Scope:** Add a Linux download button to the Time Analytics page download banner, matching the existing Windows button styling. The button will fetch the .deb package URL from the Supabase `app_releases` table (same releases bucket already used for Windows).

---

## 1. Background & Current State

### 1.1 What exists today

| Layer | File | Current Behaviour |
|---|---|---|
| **Frontend banner** | `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` | Renders a `Download` button labelled **Windows** only |
| **Frontend fallback URL** | Same file (line 8) | `FALLBACK_DOWNLOAD_URL` = `.../TimeTracker.exe` (Windows only) |
| **Forge resolver** | `forge-app/src/resolvers/userResolvers.js` → `getDesktopAppStatus` | Calls `getLatestAppVersion({ platform: 'windows' })` — hard-coded to Windows |
| **Remote util** | `forge-app/src/utils/remote.js` → `getLatestAppVersion` | Calls `/api/forge/app-version/latest` with `{ platform }` body; caches for 5 minutes |
| **AI-server endpoint** | `ai-server/src/controllers/app-version-controller.js` | Already validates `windows | macos | linux`; queries `app_releases` by platform |
| **Database table** | `supabase/migrations/20260203_add_app_releases.sql` | `platform TEXT` column already supports `'linux'`; unique constraint on `(version, platform)` |
| **Storage bucket (Windows)** | Supabase project `jvijitdewbypqbatfboi` | Bucket `desktop app`; currently contains `TimeTracker.exe` |
| **Storage bucket (Linux)** | Supabase project `jvijitdewbypqbatfboi` | Bucket `releases`; will contain Linux `.deb` package |

### 1.2 What is missing

1. The Linux .deb package is **not yet uploaded** to the Supabase storage bucket.
2. There is **no row** in `app_releases` for `platform = 'linux'`.
3. `getDesktopAppStatus` resolver does **not fetch** a Linux download URL.
4. `TimeAnalyticsTab.js` **only renders one platform button** (Windows).
5. There is no `FALLBACK_DOWNLOAD_URL` for Linux.

---

## 2. Implementation Overview

The implementation is split into **5 phases** that must be executed in order:

```
Phase 1 — Storage Upload      (one-time manual/script step)
Phase 2 — Database Record      (SQL / migration)
Phase 3 — Forge Resolver       (backend — userResolvers.js)
Phase 4 — Frontend UI          (TimeAnalyticsTab.js + CSS)
Phase 5 — Smoke Test & Deploy
```

---

## 3. Phase 1 — Upload the Linux .deb Package to Supabase Storage

### 3.1 Goal
Make the `.deb` file publicly accessible via a Supabase Storage URL so it can be referenced in `app_releases.download_url`.

### 3.2 Storage path convention

Use the `releases` bucket for Linux packages:

```
Bucket : releases
Path   : linux/timetracker_1.0.0_amd64.deb
```

Note: Windows binaries are stored in the `desktop app` bucket, while Linux packages use the `releases` bucket.

### 3.3 Locate the .deb file

The Linux .deb package should be located in your build output directory. Common locations:
- `python-desktop-app/dist/timetracker_1.0.0_amd64.deb`
- Check your Linux build scripts or CI/CD pipeline output

If not built yet, build the .deb package using your packaging tool (e.g., `fpm`, `dpkg-deb`, or PyInstaller with appropriate spec).

### 3.4 Upload steps

**Option A — Supabase Dashboard (recommended)**
1. Open the Supabase dashboard → Storage → `releases` bucket.
2. Create a folder named `linux/` (if it doesn't exist).
3. Upload the `.deb` file into `linux/`.
4. Copy the public URL from the dashboard — it will be in the form:
   ```
   https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/releases/linux/timetracker_1.0.0_amd64.deb
   ```

**Option B — Supabase CLI / cURL**
```bash
# From the directory containing the .deb file
SUPABASE_URL="https://jvijitdewbypqbatfboi.supabase.co"
SERVICE_KEY="<your-service-role-key>"
FILE="timetracker_1.0.0_amd64.deb"
BUCKET_PATH="linux/${FILE}"

curl -X POST \
  "${SUPABASE_URL}/storage/v1/object/releases/${BUCKET_PATH}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/vnd.debian.binary-package" \
  --data-binary "@${FILE}"
```

### 3.5 Compute SHA256 checksum (for integrity)
```bash
# Linux / Git Bash / WSL
sha256sum timetracker_1.0.0_amd64.deb

# PowerShell
Get-FileHash timetracker_1.0.0_amd64.deb -Algorithm SHA256 | Select-Object Hash
```

Record this value; it goes into the DB in Phase 2.

### 3.6 Get file size in bytes
```bash
# Linux / Git Bash
stat -c%s timetracker_1.0.0_amd64.deb

# Windows PowerShell
(Get-Item timetracker_1.0.0_amd64.deb).Length
```

### 3.7 Deliverable
Public URL (example):
```
https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/releases/linux/timetracker_1.0.0_amd64.deb
```

---

## 4. Phase 2 — Insert Linux Release Record in `app_releases`

### 4.1 Goal
The AI-server's `/api/app-version/latest?platform=linux` and the Forge remote util query `app_releases` where `platform = 'linux' AND is_latest = TRUE AND is_active = TRUE`. We need exactly one such row.

### 4.2 SQL Migration

Create a new migration file:

**File:** `supabase/migrations/20260605_add_linux_deb_release.sql`

```sql
-- ============================================================================
-- Migration: Add Linux Desktop App Release Record (.deb)
-- ============================================================================
-- Inserts the initial Linux .deb release so the download endpoint
-- returns a valid URL for platform=linux.
-- ============================================================================

INSERT INTO public.app_releases (
    version,
    platform,
    download_url,
    file_size_bytes,
    checksum,
    release_notes,
    is_mandatory,
    is_latest,
    is_active
)
VALUES (
    '1.0.0',
    'linux',
    'https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/releases/linux/timetracker_1.0.0_amd64.deb',
    <FILE_SIZE_BYTES>,          -- replace with value from Phase 1.6
    '<SHA256_CHECKSUM>',        -- replace with value from Phase 1.5
    'Initial Linux release of Time Tracker desktop application (.deb package for Debian/Ubuntu, x86_64).',
    FALSE,
    TRUE,
    TRUE
)
ON CONFLICT (version, platform) DO UPDATE SET
    download_url    = EXCLUDED.download_url,
    file_size_bytes = EXCLUDED.file_size_bytes,
    checksum        = EXCLUDED.checksum,
    release_notes   = EXCLUDED.release_notes,
    is_latest       = TRUE,
    is_active       = TRUE,
    updated_at      = NOW();

-- Add a comment for documentation
COMMENT ON TABLE public.app_releases IS 
'Stores desktop app release information for version control and update notifications. Supports windows, macos, and linux platforms.';
```

### 4.3 Apply the migration

**Using Supabase CLI:**
```bash
cd supabase
supabase db push
```

**Using Supabase Dashboard:**
1. Go to SQL Editor
2. Paste the migration content (after replacing placeholders)
3. Click "Run"

### 4.4 Verify via the API
After running the migration, confirm the endpoint returns the Linux URL:
```bash
curl "https://<your-ai-server-url>/api/forge/app-version/latest?platform=linux"
# Expected response:
# {
#   "success": true,
#   "latestVersion": "1.0.0",
#   "downloadUrl": "https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/releases/linux/timetracker_1.0.0_amd64.deb",
#   "releaseNotes": "Initial Linux release...",
#   ...
# }
```

### 4.5 Deliverable
`app_releases` contains a `linux` row; the public API returns a non-null `downloadUrl` for `platform=linux`.

---

## 5. Phase 3 — Update the Forge Resolver (`getDesktopAppStatus`)

### 5.1 Goal
The resolver currently calls `getLatestAppVersion({ platform: 'windows' })` and returns a single `downloadUrl`. It must now also fetch the Linux URL and return it as `linuxDownloadUrl`.

### 5.2 File to modify
```
forge-app/src/resolvers/userResolvers.js
```

### 5.3 Current code structure

The resolver has **7 return statements** across different user states:
1. Not setup (no Supabase config) — line ~66
2. Not setup (no organization) — line ~82
3. Not setup (no user record) — line ~112
4. Not setup (never used desktop) — line ~154
5. Active (desktop app running) — line ~171
6. Inactive (3h+ gap) — line ~186
7. Logged out — line ~202
8. Error catch block — line ~216

All return blocks include:
```js
downloadUrl: latestVersionInfo?.downloadUrl || null,
```

### 5.4 Change — fetch both platform URLs in parallel

**Current code (around line 55):**
```js
// Fetch latest app version info (cached for 5 minutes)
let latestVersionInfo = null;
try {
  latestVersionInfo = await getLatestAppVersion({ platform: 'windows' });
} catch (versionError) {
  console.warn('Could not fetch latest app version:', versionError.message);
}
```

**New code:**
```js
// Fetch latest app version info for both platforms (cached for 5 minutes)
let latestVersionInfo = null;
let latestLinuxVersionInfo = null;
try {
  // Fetch both Windows and Linux versions in parallel
  const [winResult, linuxResult] = await Promise.allSettled([
    getLatestAppVersion({ platform: 'windows' }),
    getLatestAppVersion({ platform: 'linux' })
  ]);
  
  // Extract fulfilled values (null if rejected)
  latestVersionInfo = winResult.status === 'fulfilled' ? winResult.value : null;
  latestLinuxVersionInfo = linuxResult.status === 'fulfilled' ? linuxResult.value : null;
} catch (versionError) {
  console.warn('Could not fetch latest app version:', versionError.message);
}
```

### 5.5 Change — include `linuxDownloadUrl` in all return statements

**Pattern to follow for each return block:**

**Before:**
```js
return {
  success: true,
  status: 'not-setup',
  showDownload: true,
  message: 'Download the Desktop App to start tracking your work',
  latestVersion: latestVersionInfo?.latestVersion || null,
  downloadUrl: latestVersionInfo?.downloadUrl || null,
  releaseNotes: latestVersionInfo?.releaseNotes || null
};
```

**After:**
```js
return {
  success: true,
  status: 'not-setup',
  showDownload: true,
  message: 'Download the Desktop App to start tracking your work',
  latestVersion: latestVersionInfo?.latestVersion || null,
  downloadUrl: latestVersionInfo?.downloadUrl || null,
  linuxDownloadUrl: latestLinuxVersionInfo?.downloadUrl || null,  // ADD THIS LINE
  releaseNotes: latestVersionInfo?.releaseNotes || null
};
```

**Apply this pattern to all 7 return statements.**

### 5.6 Line-by-line changes

| Line Range | Return Block | Change Required |
|---|---|---|
| ~66-74 | Not setup (no config) | Add `linuxDownloadUrl: latestLinuxVersionInfo?.downloadUrl \|\| null,` |
| ~82-90 | Not setup (no org) | Add `linuxDownloadUrl: latestLinuxVersionInfo?.downloadUrl \|\| null,` |
| ~112-120 | Not setup (no user) | Add `linuxDownloadUrl: latestLinuxVersionInfo?.downloadUrl \|\| null,` |
| ~154-162 | Not setup (never used) | Add `linuxDownloadUrl: latestLinuxVersionInfo?.downloadUrl \|\| null,` |
| ~171-184 | Active | Add `linuxDownloadUrl: latestLinuxVersionInfo?.downloadUrl \|\| null,` |
| ~186-199 | Inactive | Add `linuxDownloadUrl: latestLinuxVersionInfo?.downloadUrl \|\| null,` |
| ~202-213 | Logged out | Add `linuxDownloadUrl: latestLinuxVersionInfo?.downloadUrl \|\| null,` |
| ~216-223 | Error | Add `linuxDownloadUrl: latestLinuxVersionInfo?.downloadUrl \|\| null,` (error block) |

### 5.7 Deliverable
`getDesktopAppStatus` always returns both `downloadUrl` (Windows) and `linuxDownloadUrl` (Linux) regardless of user status.

---

## 6. Phase 4 — Frontend Changes

### 6.1 Files to modify

| File | Change |
|---|---|
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` | Add Linux state, fetch Linux URL, render Linux button |
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css` | **No changes needed** — use existing `.download-button` style |

---

### 6.2 `TimeAnalyticsTab.js` — Step-by-step changes

#### 6.2.1 Add Linux fallback constant (top of file, after line 8)

**Current (line 8):**
```js
const FALLBACK_DOWNLOAD_URL = 'https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/desktop%20app/TimeTracker.exe';
```

**Add after:**
```js
const FALLBACK_LINUX_DOWNLOAD_URL = 'https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/releases/linux/timetracker_1.0.0_amd64.deb';
```

#### 6.2.2 Add `linuxDownloadUrl` state variable (inside component, after line 24)

**Current (line 24):**
```js
const [downloadUrl, setDownloadUrl] = useState(FALLBACK_DOWNLOAD_URL);
```

**Add after:**
```js
const [linuxDownloadUrl, setLinuxDownloadUrl] = useState(FALLBACK_LINUX_DOWNLOAD_URL);
```

#### 6.2.3 Update `fetchDownloadUrl` to capture Linux URL (around line 83)

**Current:**
```js
const fetchDownloadUrl = async () => {
  try {
    const result = await invoke('getDesktopAppStatus');
    if (result.success && result.downloadUrl) {
      setDownloadUrl(result.downloadUrl);
    }
  } catch (err) {
    console.warn('Could not fetch download URL, using fallback:', err);
  }
};
```

**New:**
```js
const fetchDownloadUrl = async () => {
  try {
    const result = await invoke('getDesktopAppStatus');
    if (result.success) {
      // Update Windows download URL if available
      if (result.downloadUrl) {
        setDownloadUrl(result.downloadUrl);
      }
      // Update Linux download URL if available
      if (result.linuxDownloadUrl) {
        setLinuxDownloadUrl(result.linuxDownloadUrl);
      }
    }
  } catch (err) {
    console.warn('Could not fetch download URL, using fallback:', err);
  }
};
```

#### 6.2.4 Add Linux download handler (after line 98)

**Current:**
```js
const handleDownloadClick = () => {
  router.open(downloadUrl);
};
```

**Add after:**
```js
const handleLinuxDownloadClick = () => {
  router.open(linuxDownloadUrl);
};
```

#### 6.2.5 Update the JSX — add Linux platform option next to Windows (around line 124)

**Current JSX:**
```jsx
<div className="download-banner-platforms">
  <div className="platform-option">
    <span className="platform-label">Windows</span>
    <button
      className="download-button"
      onClick={handleDownloadClick}
    >
      Download
    </button>
  </div>
</div>
```

**New JSX:**
```jsx
<div className="download-banner-platforms">
  <div className="platform-option">
    <span className="platform-label">Windows</span>
    <button
      className="download-button"
      onClick={handleDownloadClick}
    >
      Download
    </button>
  </div>
  <div className="platform-option">
    <span className="platform-label">Linux</span>
    <button
      className="download-button"
      onClick={handleLinuxDownloadClick}
    >
      Download
    </button>
  </div>
</div>
```

---

### 6.3 `TimeAnalyticsTab.css` — **No changes required**

**Rationale:**
- The existing `.download-button` style (line 147) uses `background: #6656fc;` (purple) — this is the color used for Windows.
- Since the user specified "**do not change the color to green, match the color with the download button for windows**", we will **reuse the same class** without creating a variant.
- The platform label above the button provides sufficient visual differentiation.

**Existing button style (lines 147-157):**
```css
.download-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 24px;
  background: #6656fc;  /* Purple — used for both Windows and Linux */
  color: white;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  min-width: 100px;
}

.download-button:hover:not(:disabled) {
  background: #6656fc;
  box-shadow: 0 4px 8px rgba(11, 153, 142, 0.3);
}
```

**Conclusion:** Both Windows and Linux buttons will use the same purple color (`#6656fc`), as requested.

---

## 7. Phase 5 — Smoke Test & Deploy

### 7.1 Local verification checklist

| # | Check | How |
|---|---|---|
| 1 | Supabase URL is publicly accessible | `curl -I "<linux-deb-url>"` → HTTP 200 |
| 2 | `app_releases` row exists for `platform=linux` | Supabase dashboard → Table Editor → `app_releases` → filter `platform = 'linux'` |
| 3 | AI-server returns Linux URL | `curl "https://<ai-server>/api/forge/app-version/latest?platform=linux"` → verify `downloadUrl` is present |
| 4 | Forge resolver returns `linuxDownloadUrl` | Open browser DevTools → Network tab → look for `getDesktopAppStatus` invoke response → verify `linuxDownloadUrl` field |
| 5 | Linux button appears in the UI | Load Time Analytics tab → verify both Windows and Linux buttons are visible |
| 6 | Linux button opens the .deb URL | Click Linux button → browser downloads `.deb` file |
| 7 | Windows button still works | Click Windows button → still downloads `.exe` |
| 8 | Both buttons have the same color | Visually verify both buttons are purple (`#6656fc`) |

### 7.2 Functional tests

**Test Case 1: Fresh user (not-setup)**
1. User who has never installed the desktop app visits Time Analytics page
2. Expected: Banner shows both Windows and Linux download buttons
3. Click Linux button → `.deb` file downloads
4. Click Windows button → `.exe` file downloads

**Test Case 2: Active desktop user**
1. User with active desktop app session visits Time Analytics page
2. Expected: Banner is hidden (status = 'active')
3. No download buttons visible

**Test Case 3: Inactive desktop user**
1. User whose desktop app hasn't synced in 3+ hours
2. Expected: Banner shows with both download buttons
3. Click Linux button → `.deb` file downloads

**Test Case 4: Fallback URL (API fails)**
1. Simulate API failure (disconnect AI server)
2. Frontend should use hardcoded fallback URLs
3. Expected: `FALLBACK_LINUX_DOWNLOAD_URL` used for Linux button
4. Expected: `FALLBACK_DOWNLOAD_URL` used for Windows button

### 7.3 Deploy order

```
1. Apply Supabase migration (Phase 2 SQL)
2. Verify AI server already supports linux (no code changes needed)
3. Deploy Forge app  (`forge deploy`)
4. Verify in Jira test project
```

> **Note:** The AI-server endpoint (`app-version-controller.js`) already supports `linux` platform — **no AI-server code changes are required**.

---

## 8. File Change Summary

| File | Change Type | Lines Modified | Description |
|---|---|---|---|
| `supabase/migrations/20260605_add_linux_deb_release.sql` | **New file** | N/A | Insert Linux release record |
| `forge-app/src/resolvers/userResolvers.js` | **Modify** | ~55-223 | Fetch Linux URL in parallel; add `linuxDownloadUrl` to all 8 return branches |
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` | **Modify** | 8-135 | Add Linux state, handler, and JSX button |
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css` | **No change** | N/A | Reuse existing `.download-button` style |

**No changes needed to:**
- `ai-server/src/controllers/app-version-controller.js` — already supports `linux` (line 37: `const validPlatforms = ['windows', 'macos', 'linux'];`)
- `forge-app/src/utils/remote.js` — `getLatestAppVersion` already accepts any platform string and caches per platform (line 472)
- `app_releases` table schema — `platform` column already supports `'linux'` (migration 20260203)
- `TimeAnalyticsTab.css` — existing button style is reused without color change

---

## 9. Breaking Changes & Rollback Plan

### 9.1 Breaking changes
**None.** This is a purely additive feature:
- Existing Windows functionality remains unchanged
- New `linuxDownloadUrl` field is optional (defaults to `null`)
- Frontend gracefully handles missing Linux URL (uses fallback)

### 9.2 Rollback plan

If deployment fails or Linux button causes issues:

**Step 1: Revert frontend changes**
```bash
cd forge-app
git revert <commit-hash>
forge deploy
```

**Step 2: Mark Linux release as inactive (optional)**
```sql
UPDATE public.app_releases
SET is_active = FALSE
WHERE platform = 'linux';
```

**Step 3: Monitor logs**
```bash
# Forge logs
forge logs

# AI server logs
tail -f ai-server/logs/*.log
```

---

## 10. Security Considerations

### 10.1 Storage bucket permissions
Verify the `releases` bucket has **public read access**:
```sql
-- Check bucket policy
SELECT * FROM storage.buckets WHERE name = 'releases';

-- Ensure public access is enabled
UPDATE storage.buckets
SET public = TRUE
WHERE name = 'releases';
```

### 10.2 CORS policy
The Supabase storage bucket must allow downloads from Jira domains. Verify CORS configuration:
```json
{
  "allowedOrigins": ["*"],
  "allowedMethods": ["GET", "HEAD"]
}
```

### 10.3 RLS policies
The `app_releases` table already has a policy allowing public reads:
```sql
-- Already exists from migration 20260203
CREATE POLICY "Anyone can view active releases" ON public.app_releases
  FOR SELECT USING (is_active = TRUE);
```

### 10.4 File integrity verification (optional)
Users can verify the downloaded file matches the published checksum:
```bash
# On Linux
sha256sum timetracker_1.0.0_amd64.deb

# Compare with checksum from API response
curl "https://<ai-server>/api/forge/app-version/latest?platform=linux" | jq -r '.checksum'
```

---

## 11. Future Enhancements (Out of Scope)

### 11.1 macOS button
Follow the same pattern with `platform = 'macos'` once a macOS build exists:
- Upload `.dmg` or `.pkg` to `releases/macos/`
- Insert `app_releases` row for macOS
- Add `macDownloadUrl` to resolver
- Add macOS button to frontend

### 11.2 Auto-platform detection
Detect the user's OS (via `navigator.platform` or `navigator.userAgent`) and highlight the matching download button:
```js
const platform = navigator.platform.toLowerCase();
const isMac = platform.includes('mac');
const isWindows = platform.includes('win');
const isLinux = platform.includes('linux');

// Highlight the matching button
<button className={`download-button ${isLinux ? 'recommended' : ''}`}>
```

### 11.3 Multi-architecture support
Support multiple Linux architectures (x86_64, ARM64) in the `releases` bucket:
```
releases/linux/timetracker_1.0.0_amd64.deb
releases/linux/timetracker_1.0.0_arm64.deb
```

Add architecture detection and display both options.

### 11.4 DesktopAppStatusBanner component
The `DesktopAppStatusBanner.js` component (if it exists) also shows a download button. Once the Time Analytics page is stable, apply the same multi-platform pattern there.

### 11.5 In-app update notifications (Linux)
The desktop app's auto-update system (described in `PLAN_AUTO_UPDATE_SILENT.md`) currently targets Windows. Extend it to support Linux `.deb` updates using `apt-get` or a custom updater.

---

## 12. Risk Assessment & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| .deb upload fails / wrong URL | Medium | High | Verify with `curl -I <url>` before inserting into DB |
| `is_latest` trigger marks old Linux row | Low | Medium | `ON CONFLICT DO UPDATE` keeps `is_latest = TRUE`; trigger only fires on insert/update |
| Resolver performance degradation | Low | Low | `Promise.allSettled` runs parallel — no additional latency vs current sequential call; both calls cached for 5 min |
| Frontend shows Linux button with broken URL | Low | Medium | Fallback constant `FALLBACK_LINUX_DOWNLOAD_URL` prevents broken experience |
| Forge sandbox SSRF restrictions | Very Low | High | `router.open(linuxDownloadUrl)` uses same Forge bridge already validated for Windows URL |
| Linux users download wrong architecture | Medium | Medium | Add `.deb` architecture suffix (`_amd64.deb`) to filename; add installation instructions in banner |
| Database migration conflicts | Low | Medium | Use unique migration filename with date prefix; test in dev environment first |

---

## 13. Testing Matrix

| Scenario | Windows Button | Linux Button | Notes |
|---|---|---|---|
| User never installed app | ✅ Shows | ✅ Shows | Both buttons visible |
| Active desktop user | ❌ Hidden | ❌ Hidden | Banner hidden entirely |
| Inactive desktop user (3h+ gap) | ✅ Shows | ✅ Shows | Both buttons visible |
| Logged out desktop user | ✅ Shows | ✅ Shows | Both buttons visible |
| API fails (no network) | ✅ Fallback | ✅ Fallback | Uses hardcoded URLs |
| Linux URL missing in API | ✅ Works | ⚠️ Fallback | Windows unaffected; Linux uses fallback |
| Both URLs missing | ✅ Fallback | ✅ Fallback | Both use hardcoded fallbacks |
| Windows URL missing | ⚠️ Fallback | ✅ Works | Linux unaffected |

---

## 14. Documentation Updates Required

After implementation, update the following docs:

1. **User-facing:**
   - Add Linux installation instructions to main README
   - Create `docs/LINUX_INSTALLATION.md` with `.deb` setup steps
   - Update `docs/VERSION_CONTROL_FEATURE.md` to mention Linux support

2. **Developer-facing:**
   - Update `docs/ARCHITECTURE.md` with multi-platform download flow diagram
   - Document Linux build process in `python-desktop-app/README.md`
   - Add Linux release checklist to `docs/RELEASE_PROCESS.md`

3. **API documentation:**
   - Update `ai-server/README.md` with Linux platform example
   - Add Linux response example to `/api/forge/app-version/latest` docs

---

## 15. Success Criteria

✅ Implementation is considered complete when:

1. Linux `.deb` file is uploaded to Supabase storage and publicly accessible
2. `app_releases` table contains a `linux` row with correct URL and checksum
3. AI server endpoint `/api/forge/app-version/latest?platform=linux` returns valid data
4. Forge resolver `getDesktopAppStatus` returns `linuxDownloadUrl` in all cases
5. Time Analytics page displays **both** Windows and Linux download buttons
6. Both buttons use **identical purple color** (`#6656fc`)
7. Clicking Linux button downloads the `.deb` file
8. Clicking Windows button still downloads the `.exe` file
9. All existing functionality remains unaffected
10. No console errors or warnings related to the new feature

---

## 16. Implementation Timeline

| Phase | Estimated Time | Dependencies |
|---|---|---|
| Phase 1: Storage Upload | 15 min | Linux `.deb` file must exist |
| Phase 2: Database Migration | 10 min | Phase 1 complete |
| Phase 3: Forge Resolver | 20 min | Phase 2 complete |
| Phase 4: Frontend UI | 30 min | Phase 3 complete |
| Phase 5: Testing & Deploy | 45 min | Phases 1-4 complete |
| **Total** | **~2 hours** | Assumes `.deb` file is ready |

---

## 17. Post-Implementation Monitoring

### 17.1 Metrics to track

1. **Download counts** (via Supabase Storage analytics):
   - Windows downloads per day
   - Linux downloads per day
   - Ratio of Windows:Linux downloads

2. **API performance**:
   - `/api/forge/app-version/latest` response time
   - Cache hit rate for `getLatestAppVersion`

3. **Error rates**:
   - Failed download attempts
   - Missing `linuxDownloadUrl` cases
   - Forge resolver errors

### 17.2 Monitoring queries

```sql
-- Check Linux release is active
SELECT * FROM public.app_releases
WHERE platform = 'linux' AND is_active = TRUE;

-- Count downloads by platform (requires storage analytics)
SELECT 
  bucket_id,
  name,
  COUNT(*) as downloads
FROM storage.objects
WHERE bucket_id IN ('desktop app', 'releases')
  AND name LIKE '%timetracker%'
GROUP BY bucket_id, name;
```

---

## 18. Final Checklist

**Before starting implementation:**
- [ ] Linux `.deb` file exists and is tested
- [ ] Supabase service role key is available
- [ ] Dev environment Forge app can be tested
- [ ] Backup of `userResolvers.js` and `TimeAnalyticsTab.js` created

**During implementation:**
- [ ] Phase 1: .deb uploaded to Supabase storage
- [ ] Phase 1: SHA256 checksum computed
- [ ] Phase 1: Public URL verified with curl
- [ ] Phase 2: Migration file created with correct values
- [ ] Phase 2: Migration applied successfully
- [ ] Phase 2: API endpoint tested and returns Linux URL
- [ ] Phase 3: Resolver modified to fetch Linux URL
- [ ] Phase 3: All 8 return statements updated
- [ ] Phase 4: Frontend constants added
- [ ] Phase 4: Frontend state variables added
- [ ] Phase 4: Frontend handler added
- [ ] Phase 4: JSX updated with Linux button
- [ ] Phase 5: All 8 test cases pass
- [ ] Phase 5: No console errors

**After deployment:**
- [ ] Windows download still works
- [ ] Linux download works
- [ ] Both buttons same color (purple)
- [ ] No breaking changes observed
- [ ] Documentation updated
- [ ] Team notified of new feature

---

## 19. Contact & Support

**Implementation Owner:** [Your Name]  
**Reviewed By:** [Reviewer Name]  
**Questions:** Refer to `docs/` or open a GitHub issue

---

**END OF IMPLEMENTATION PLAN**

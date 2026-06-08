# Linux Desktop App Download Button — Implementation Plan

**Date:** 2026-06-03  
**Status:** Planning  
**Scope:** Add a Linux download button to the Time Analytics page download banner, mirroring the existing Windows button, fetching the AppImage URL from the Supabase `app_releases` table (same releases bucket already used for Windows).

---

## 1. Background & Current State

### 1.1 What exists today

| Layer | File | Current Behaviour |
|---|---|---|
| **Frontend banner** | `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` | Renders a `Download` button labelled **Windows** only |
| **Frontend fallback URL** | Same file (line 8) | `FALLBACK_DOWNLOAD_URL` = `.../TimeTracker.exe` (Windows only) |
| **Forge resolver** | `forge-app/src/resolvers/userResolvers.js` → `getDesktopAppStatus` | Calls `getLatestAppVersion({ platform: 'windows' })` — hard-coded to Windows |
| **Remote util** | `forge-app/src/utils/remote.js` → `getLatestAppVersion` | Calls `/api/forge/app-version/latest` with `{ platform }` body |
| **AI-server endpoint** | `ai-server/src/controllers/app-version-controller.js` | Already validates `windows | macos | linux`; queries `app_releases` by platform |
| **Database table** | `supabase/migrations/20260203_add_app_releases.sql` | `platform TEXT` column already supports `'linux'`; unique constraint on `(version, platform)` |
| **Storage bucket** | Supabase project `jvijitdewbypqbatfboi` | Bucket `desktop app`; currently contains `TimeTracker.exe` |
| **Linux build output** | `python-desktop-app/dist/TimeTracker-v1.0.0-x86_64.AppImage` | Built by `build.sh`, outputs an AppImage |

### 1.2 What is missing

1. The Linux AppImage is **not yet uploaded** to the Supabase storage bucket.
2. There is **no row** in `app_releases` for `platform = 'linux'`.
3. `getDesktopAppStatus` resolver does **not fetch** a Linux download URL.
4. `TimeAnalyticsTab.js` **only renders one platform button** (Windows).
5. There is no `FALLBACK_DOWNLOAD_URL` for Linux.

---

## 2. Implementation Overview

The implementation is split into **5 phases** that must be executed in order:

```
Phase 1 — Storage Upload  (one-time manual/script step)
Phase 2 — Database Record  (SQL / migration)
Phase 3 — Forge Resolver   (backend — userResolvers.js)
Phase 4 — Frontend UI       (TimeAnalyticsTab.js + CSS)
Phase 5 — Smoke Test & Deploy
```

---

## 3. Phase 1 — Upload the Linux AppImage to Supabase Storage

### 3.1 Goal
Make the `.AppImage` file publicly accessible via a Supabase Storage URL so it can be referenced in `app_releases.download_url`.

### 3.2 Storage path convention

Use the same `desktop app` bucket but organise releases under a versioned path:

```
Bucket : desktop app
Path   : linux/TimeTracker-v1.0.0-x86_64.AppImage
```

This keeps Windows (`TimeTracker.exe`) and Linux binaries in the same bucket, separated by OS prefix.

### 3.3 Upload steps

**Option A — Supabase Dashboard (easiest)**
1. Open the Supabase dashboard → Storage → `desktop app` bucket.
2. Create a folder named `linux/`.
3. Upload `python-desktop-app/dist/TimeTracker-v1.0.0-x86_64.AppImage` into `linux/`.
4. Copy the public URL from the dashboard — it will be in the form:
   ```
   https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/desktop%20app/linux/TimeTracker-v1.0.0-x86_64.AppImage
   ```

**Option B — Supabase CLI / cURL**
```bash
# From python-desktop-app/dist/
SUPABASE_URL="https://jvijitdewbypqbatfboi.supabase.co"
SERVICE_KEY="<your-service-role-key>"
FILE="TimeTracker-v1.0.0-x86_64.AppImage"
BUCKET_PATH="linux/${FILE}"

curl -X POST \
  "${SUPABASE_URL}/storage/v1/object/desktop%20app/${BUCKET_PATH}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${FILE}"
```

### 3.4 Compute SHA256 checksum (for integrity)
```bash
sha256sum dist/TimeTracker-v1.0.0-x86_64.AppImage
# → record this value; it goes into the DB in Phase 2
```

### 3.5 Get file size in bytes
```bash
stat --format="%s" dist/TimeTracker-v1.0.0-x86_64.AppImage
```

### 3.6 Deliverable
Public URL (example):
```
https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/desktop%20app/linux/TimeTracker-v1.0.0-x86_64.AppImage
```

---

## 4. Phase 2 — Insert Linux Release Record in `app_releases`

### 4.1 Goal
The AI-server's `/api/app-version/latest?platform=linux` and the Forge remote util query `app_releases` where `platform = 'linux' AND is_latest = TRUE AND is_active = TRUE`. We need exactly one such row.

### 4.2 SQL Migration

Create a new migration file:

**File:** `supabase/migrations/20260603_add_linux_release.sql`

```sql
-- ============================================================================
-- Migration: Add Linux Desktop App Release Record
-- ============================================================================
-- Inserts the initial Linux AppImage release so the download endpoint
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
    'https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/desktop%20app/linux/TimeTracker-v1.0.0-x86_64.AppImage',
    <FILE_SIZE_BYTES>,          -- replace with value from Phase 1.5
    '<SHA256_CHECKSUM>',        -- replace with value from Phase 1.4
    'Initial Linux release of Time Tracker desktop application (AppImage, x86_64).',
    FALSE,
    TRUE,
    TRUE
)
ON CONFLICT (version, platform) DO UPDATE SET
    download_url   = EXCLUDED.download_url,
    file_size_bytes = EXCLUDED.file_size_bytes,
    checksum       = EXCLUDED.checksum,
    release_notes  = EXCLUDED.release_notes,
    is_latest      = TRUE,
    is_active      = TRUE,
    updated_at     = NOW();
```

### 4.3 Verify via the API
After running the migration, confirm the endpoint returns the Linux URL:
```bash
curl "https://<ai-server-url>/api/app-version/latest?platform=linux"
# Expected: { "success": true, "data": { "version": "1.0.0", "downloadUrl": "...AppImage", ... } }
```

### 4.4 Deliverable
`app_releases` contains a `linux` row; the public API returns a non-null `downloadUrl` for `platform=linux`.

---

## 5. Phase 3 — Update the Forge Resolver (`getDesktopAppStatus`)

### 5.1 Goal
The resolver currently calls `getLatestAppVersion({ platform: 'windows' })` and returns a single `downloadUrl`. It must now also fetch the Linux URL and return it as `linuxDownloadUrl`.

### 5.2 File to modify
```
forge-app/src/resolvers/userResolvers.js
```

### 5.3 Change — fetch both platform URLs in parallel

**Current code (around line 55):**
```js
let latestVersionInfo = null;
try {
  latestVersionInfo = await getLatestAppVersion({ platform: 'windows' });
} catch (versionError) {
  console.warn('Could not fetch latest app version:', versionError.message);
}
```

**New code:**
```js
let latestVersionInfo = null;
let latestLinuxVersionInfo = null;
try {
  [latestVersionInfo, latestLinuxVersionInfo] = await Promise.allSettled([
    getLatestAppVersion({ platform: 'windows' }),
    getLatestAppVersion({ platform: 'linux' }),
  ]).then(([win, linux]) => [
    win.status === 'fulfilled' ? win.value : null,
    linux.status === 'fulfilled' ? linux.value : null,
  ]);
} catch (versionError) {
  console.warn('Could not fetch latest app version:', versionError.message);
}
```

### 5.4 Change — include `linuxDownloadUrl` in every return branch

Every `return { ... }` in the resolver body currently has:
```js
downloadUrl: latestVersionInfo?.downloadUrl || null,
```

Add alongside it:
```js
linuxDownloadUrl: latestLinuxVersionInfo?.downloadUrl || null,
```

There are **7 return statements** in the resolver (not-setup ×3, active, inactive, logged-out, error). All of them must gain `linuxDownloadUrl`.

### 5.5 Deliverable
`getDesktopAppStatus` always returns both `downloadUrl` (Windows) and `linuxDownloadUrl` (Linux) regardless of user status.

---

## 6. Phase 4 — Frontend Changes

### 6.1 Files to modify

| File | Change |
|---|---|
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` | Add Linux state, fetch Linux URL, render Linux button |
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css` | Add Linux button styles / OS icon (optional) |

---

### 6.2 `TimeAnalyticsTab.js` — Step-by-step changes

#### 6.2.1 Add Linux fallback constant (top of file, line 8)

**Current:**
```js
const FALLBACK_DOWNLOAD_URL = 'https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/desktop%20app/TimeTracker.exe';
```

**Add after:**
```js
const FALLBACK_LINUX_DOWNLOAD_URL = 'https://jvijitdewbypqbatfboi.supabase.co/storage/v1/object/public/desktop%20app/linux/TimeTracker-v1.0.0-x86_64.AppImage';
```

#### 6.2.2 Add `linuxDownloadUrl` state variable (inside component, with existing state declarations)

**Current:**
```js
const [downloadUrl, setDownloadUrl] = useState(FALLBACK_DOWNLOAD_URL);
```

**Add after:**
```js
const [linuxDownloadUrl, setLinuxDownloadUrl] = useState(FALLBACK_LINUX_DOWNLOAD_URL);
```

#### 6.2.3 Update `fetchDownloadUrl` to capture Linux URL

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
      if (result.downloadUrl) {
        setDownloadUrl(result.downloadUrl);
      }
      if (result.linuxDownloadUrl) {
        setLinuxDownloadUrl(result.linuxDownloadUrl);
      }
    }
  } catch (err) {
    console.warn('Could not fetch download URL, using fallback:', err);
  }
};
```

#### 6.2.4 Add Linux download handler

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

#### 6.2.5 Update the JSX — add Linux platform option next to Windows

**Current JSX (in the return block):**
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
      className="download-button download-button--linux"
      onClick={handleLinuxDownloadClick}
    >
      Download
    </button>
  </div>
</div>
```

---

### 6.3 `TimeAnalyticsTab.css` — Style adjustments

The `.download-button` style already exists. We only need a minor variant for the Linux button (optional visual differentiation). Add at the bottom of the existing download banner CSS block:

```css
/* Linux variant — use same base but tint slightly */
.download-button--linux {
  background: #0b6e4f;   /* green tint, visually distinct from Windows purple */
}

.download-button--linux:hover:not(:disabled) {
  background: #0a5d43;
  box-shadow: 0 4px 8px rgba(11, 110, 79, 0.3);
}
```

> **Note:** If a Linux Tux SVG icon is desired in future, it can be added as a `<span>` with an inline SVG inside the button — this is a low-priority cosmetic enhancement.

---

## 7. Phase 5 — Smoke Test & Deploy

### 7.1 Local verification checklist

| # | Check | How |
|---|---|---|
| 1 | Supabase URL is publicly accessible | `curl -I "<linux-appimage-url>"` → HTTP 200 |
| 2 | `app_releases` row exists for `platform=linux` | Supabase dashboard → Table Editor → `app_releases` |
| 3 | AI-server returns Linux URL | `GET /api/app-version/latest?platform=linux` |
| 4 | Forge resolver returns `linuxDownloadUrl` | Check browser network tab in Jira — invoke response |
| 5 | Linux button appears in the UI | Load Time Analytics tab, check banner |
| 6 | Linux button opens the AppImage URL | Click button → browser downloads/opens the AppImage |
| 7 | Windows button still works | Click Windows button → still downloads `.exe` |

### 7.2 Deploy order

```
1. Apply Supabase migration (Phase 2 SQL)
2. Deploy AI server (if any changes needed — none expected, endpoint already supports linux)
3. Deploy Forge app  (`forge deploy`)
4. Verify in Jira test project
```

> The AI-server endpoint already supports `linux` platform — **no AI-server code changes are required**.

---

## 8. File Change Summary

| File | Change Type | Description |
|---|---|---|
| `supabase/migrations/20260603_add_linux_release.sql` | **New file** | Insert Linux release record |
| `forge-app/src/resolvers/userResolvers.js` | **Modify** | Fetch Linux URL in parallel; add `linuxDownloadUrl` to all return branches |
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.js` | **Modify** | Add Linux state, handler, and JSX button |
| `forge-app/static/main/src/components/tabs/TimeAnalyticsTab.css` | **Modify** | Add `.download-button--linux` style variant |

**No changes needed to:**
- `ai-server/src/controllers/app-version-controller.js` — already supports `linux`
- `forge-app/src/utils/remote.js` — `getLatestAppVersion` already accepts any platform string
- `app_releases` table schema — `platform` column already supports `'linux'`

---

## 9. Future Enhancements (Out of Scope)

- **macOS button**: Follow the same pattern with `platform = 'macos'` once a macOS build exists.
- **Auto-update for Linux**: The desktop app's `PLAN_AUTO_UPDATE_SILENT.md` describes Windows auto-update. A Linux equivalent (using AppImageUpdate or a custom updater) is a separate piece of work.
- **DesktopAppStatusBanner**: The `DesktopAppStatusBanner.js` component also shows a download button. It currently accepts a single `downloadUrl` prop. Once the Time Analytics page is stable, the same multi-platform pattern can be applied there.
- **Platform detection**: Detect the user's OS (via `navigator.platform` or a Forge user-agent header) to pre-select the correct download button automatically.

---

## 10. Risk & Notes

| Risk | Mitigation |
|---|---|
| AppImage upload fails / URL is wrong | Verify with `curl -I <url>` before inserting into DB |
| `is_latest` trigger marks old Linux row if re-running migration | `ON CONFLICT DO UPDATE` keeps `is_latest = TRUE` on the new row; trigger only fires on `INSERT OR UPDATE OF is_latest` |
| `getDesktopAppStatus` resolver performance | `Promise.allSettled` runs both platform fetches in parallel — no additional latency vs current sequential call |
| Frontend shows Linux button with a broken URL | Fallback constant `FALLBACK_LINUX_DOWNLOAD_URL` is set directly in code; worst case user downloads the right version from the hardcoded URL |
| Forge sandbox SSRF restrictions on `router.open` | `router.open(linuxDownloadUrl)` uses the same Forge bridge call already validated for the Windows URL — no additional permissions needed |
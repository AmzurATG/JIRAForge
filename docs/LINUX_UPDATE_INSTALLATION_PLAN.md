# Linux Update & Installation Plan — TimeTracker `.deb`

## Overview

TimeTracker is distributed on Linux as a single `.deb` file that embeds an AppImage.
There are two update paths:

| Path | Trigger | Who performs it |
|---|---|---|
| **Manual upgrade** | User downloads a newer `.deb` and opens it | dpkg + GDebi |
| **Auto-update** | Running app detects a new version from Supabase | `UpdateManager` inside the app |

Both paths converge on the same result: the AppImage at the canonical per-user path
`~/.local/share/TimeTracker/TimeTracker.AppImage` is replaced with the new version
and the app restarts.

---

## 1. Package Structure

### What the `.deb` contains

```
timetracker_1.0.x_amd64.deb
├── opt/timetracker/
│   └── TimeTracker.AppImage          ← the full application binary
├── usr/local/bin/
│   └── timetracker                   ← launcher wrapper script
├── usr/share/applications/
│   └── timetracker.desktop           ← system-level .desktop entry
├── usr/share/icons/hicolor/256x256/apps/
│   └── timetracker.png
└── DEBIAN/
    ├── control                       ← package metadata (version, deps)
    ├── prerm                         ← runs BEFORE dpkg replaces files
    └── postinst                      ← runs AFTER dpkg places files
```

### `DEBIAN/control` key fields

```
Package: timetracker
Version: 1.0.x
Architecture: amd64
Depends: gdebi
Recommends: gnome-shell-extension-appindicator, libnotify-bin
```

- **`Depends: gdebi`** — apt installs GDebi Package Installer alongside TimeTracker.
  GDebi shows a proper "Upgrade" button when a newer `.deb` is double-clicked, unlike
  the Ubuntu App Center which shows "Installed" for all local `.deb` files (known Ubuntu bug).

### Launcher wrapper `/usr/local/bin/timetracker`

```bash
#!/bin/bash
CANONICAL="${HOME}/.local/share/TimeTracker/TimeTracker.AppImage"
if [ -f "$CANONICAL" ] && [ -x "$CANONICAL" ]; then
    exec env APPIMAGE_EXTRACT_AND_RUN=1 "$CANONICAL" "$@"
else
    exec env APPIMAGE_EXTRACT_AND_RUN=1 /opt/timetracker/TimeTracker.AppImage "$@"
fi
```

**Priority**: always runs the user's canonical copy (auto-updated) over `/opt/`.
`APPIMAGE_EXTRACT_AND_RUN=1` avoids the FUSE kernel module requirement.

---

## 2. First-Time Installation Flow

```
User downloads timetracker_1.0.0_amd64.deb
            │
            ▼
Double-click → GDebi Package Installer (set as default after first install)
            │   or: sudo dpkg -i timetracker_1.0.0_amd64.deb
            ▼
dpkg extracts files:
  /opt/timetracker/TimeTracker.AppImage   ← placed by dpkg
  /usr/local/bin/timetracker              ← placed by dpkg
  /usr/share/applications/timetracker.desktop
            │
            ▼
DEBIAN/postinst runs (as root):
  1. chmod +x /opt/timetracker/TimeTracker.AppImage
  2. update-desktop-database (launcher cache refresh)
  3. gtk-update-icon-cache
  4. Upgrade canonical copy loop → skipped (no ~/.local/share/TimeTracker/ yet)
  5. Remove stale .desktop entries → none yet
  6. Enable AppIndicator GNOME extension (tray visibility)
  7. Set gdebi as default .deb MIME handler for all users (via xdg-mime)
            │
            ▼
User clicks "TimeTracker" in app launcher
  → wrapper runs /opt/timetracker/TimeTracker.AppImage (no canonical copy yet)
            │
            ▼
App starts → _install_appimage() detects $APPIMAGE ≠ canonical path
  1. Copies /opt/timetracker/TimeTracker.AppImage
         → ~/.local/share/TimeTracker/TimeTracker.AppImage  (atomic rename)
  2. Creates ~/.local/share/TimeTracker/uninstall.sh
  3. Writes ~/.local/share/applications/timetracker.desktop
         (Exec=env APPIMAGE_EXTRACT_AND_RUN=1 ~/.local/share/TimeTracker/TimeTracker.AppImage)
  4. Relaunches from canonical path → exits the /opt/ instance
            │
            ▼
App now runs from ~/.local/share/TimeTracker/TimeTracker.AppImage  ✓
```

---

## 3. Manual Upgrade Flow (User Downloads Newer `.deb`)

### Why a naïve install would NOT upgrade

The wrapper script always prefers `~/.local/share/TimeTracker/TimeTracker.AppImage`.
Installing a new `.deb` only updates `/opt/timetracker/TimeTracker.AppImage`.
Without extra logic, the old canonical copy keeps launching — the upgrade is invisible.

### How it is fixed: `prerm` + `postinst`

```
User downloads timetracker_1.0.2_amd64.deb (newer version)
            │
            ▼
Double-click → GDebi shows "Upgrade" button (version comparison)
  (GDebi was set as default .deb handler by the previous install's postinst)
            │
            ▼
User clicks Upgrade → GDebi runs: sudo dpkg -i timetracker_1.0.2_amd64.deb
            │
            ▼
DEBIAN/prerm runs (as root) — BEFORE files are replaced:
  For each user in /home/*:
    1. Find all TimeTracker PIDs for that user (pgrep -u <user> -f TimeTracker)
    2. Send SIGTERM → wait up to 5 seconds for graceful exit
    3. If still alive → send SIGKILL
  → Old binary is now stopped; FUSE mount is released; no "text file busy" error
            │
            ▼
dpkg replaces files:
  /opt/timetracker/TimeTracker.AppImage  ← now contains v1.0.2
            │
            ▼
DEBIAN/postinst runs (as root) — AFTER files are placed:
  For each user in /home/* that has ~/.local/share/TimeTracker/:
    1. cp /opt/timetracker/TimeTracker.AppImage
          → ~/.local/share/TimeTracker/TimeTracker.AppImage.new   (temp)
    2. chmod +x .new
    3. mv -f .new → ~/.local/share/TimeTracker/TimeTracker.AppImage  (atomic)
    4. chown <user>:<user> canonical copy
    5. Kill any lingering TimeTracker PIDs for that user (safety net)
  → Canonical copy is now v1.0.2; user's next launch gets the new version
            │
            ▼
User relaunches TimeTracker → runs v1.0.2 from canonical path  ✓
```

### Why GDebi instead of Ubuntu App Center

Ubuntu's Flutter-based App Center (Ubuntu 23.04+) always shows **"Installed"** for
local `.deb` files regardless of version. It does not implement the "upgrade from
local file" flow. GDebi correctly compares the installed package version against the
`.deb` being opened and shows a green **"Upgrade"** button.

The `postinst` script sets GDebi as the default MIME handler:
```bash
xdg-mime default gdebi.desktop application/vnd.debian.binary-package
xdg-mime default gdebi.desktop application/x-debian-package
```
This runs for every user account, so future `.deb` double-clicks open GDebi automatically.

---

## 4. Auto-Update Flow (App Self-Updates)

The running app polls Supabase for a newer version and installs it without user interaction.

### 4.1 Version Detection

`check_for_app_updates()` in `TimeTracker` calls the AI server, which queries the
`app_releases` table in Supabase for the latest `platform='linux'` release.

Response includes:
```json
{
  "update_available": true,
  "latest_version": "1.0.2",
  "download_url": "https://<project>.supabase.co/storage/v1/object/public/releases/timetracker_1.0.2_amd64.deb",
  "checksum": "<sha256 of the .deb>",
  "file_size_bytes": 147000000,
  "is_mandatory": false
}
```

### 4.2 Download Phase (`UpdateManager._download_worker`)

```
UpdateManager.check_and_download(update_info)
            │
            ▼
Spawns background thread: _download_worker()
            │
State: checking → downloading
            │
            ▼
Detects URL ends in .deb → is_bundle=True, is_deb=True
Temp file: ~/.local/share/TimeTracker/updates/TimeTracker_v1.0.2.deb.tmp
Final staged file: ~/.local/share/TimeTracker/updates/TimeTracker_v1.0.2.AppImage
            │
            ▼
Downloads .deb in 8KB chunks with progress tracking
            │
            ▼
Size verification:
  1. server Content-Length vs actual bytes downloaded
  2. API metadata size vs actual (soft-fail if checksum available)
            │
            ▼
Checksum verification (SHA256 of the .deb):
  verify_download_checksum(temp_path, expected_checksum)
  → Must match the SHA256 in Supabase app_releases.checksum
            │
            ▼
Sets _bundle_checksum_verified = True
  (flag prevents false mismatch when apply_update() re-checks the extracted AppImage)
            │
            ▼
Extracts AppImage from .deb → _extract_appimage_from_deb(bundle_path, final_path)
  Pure-Python extraction:
    1. ar(1) format parser reads control.tar.* and data.tar.*
    2. data.tar.xz → lzma (stdlib, always available)
    3. data.tar.zst → zstandard (bundled in PyInstaller binary via hiddenimports)
    4. Locates opt/timetracker/TimeTracker.AppImage inside the tar
    5. Streams it to final_path; sets +x permissions
  Fallback: if zstandard not available → subprocess dpkg-deb --fsys-tarfile
            │
            ▼
Deletes the .deb bundle (saves disk space)
Staged: ~/.local/share/TimeTracker/updates/TimeTracker_v1.0.2.AppImage
            │
            ▼
State: ready (or mandatory_ready)
```

### 4.3 Install Phase (`UpdateManager.apply_update` → `create_linux_update_script`)

```
_on_update_manager_state_changed() detects state = 'ready'
            │
            ▼
Shows desktop notification:
  "Updating Time Tracker — Installing v1.0.2. The app will restart shortly."
            │
            ▼
auto_apply() → apply_update()
            │
Checksum re-verification:
  Skipped because _bundle_checksum_verified = True
  (the staged file is an AppImage; its SHA256 ≠ .deb SHA256)
            │
            ▼
create_linux_update_script() generates apply_update.sh:
  ~/.local/share/TimeTracker/updates/apply_update.sh
            │
Spawns: bash apply_update.sh (detached, new session)
Calls: _on_apply_update() → triggers app shutdown (os._exit(0))
            │
            ▼
apply_update.sh runs after app exits:

  Phase 1: Wait for old PID to exit (up to 5s), then SIGKILL
  Phase 2: Verify staged AppImage exists
  Phase 3: Replace installed binary (up to 15 retries):
    mv ~/.local/share/TimeTracker/TimeTracker.AppImage → .bak
    cp staged AppImage → canonical path
    chmod +x canonical
    On failure: rollback from .bak
  Phase 4: Update XDG autostart entry to point to canonical path
  Phase 5: Launch new version:
    nohup ~/.local/share/TimeTracker/TimeTracker.AppImage &
  Phase 6: Cleanup staged file + .bak + self-delete script
            │
            ▼
New version v1.0.2 is running from canonical path  ✓
```

### 4.4 Retry on Failure

If the download or extraction fails, `UpdateManager` sets state to `failed` and:
- Shows a desktop notification: "Update download failed. The app will retry later."
- `should_retry_download()` returns `True` after 30 minutes
- The next update check cycle calls `check_and_download()` again automatically

---

## 5. Stale Desktop Entry Cleanup

A stale `~/.local/share/applications/timetracker.desktop` pointing to a missing
AppImage path silently shadows the system `.desktop` and causes double-clicks to do
nothing. This is cleaned up in two places:

### In `postinst` (at install time)

For each user's `~/.local/share/applications/timetracker.desktop`:
- **Case 1**: `Exec=` line has no `.AppImage` → old-style binary path → remove
- **Case 2**: `Exec=` has `.AppImage` but that file doesn't exist on disk → remove

### In `_cleanup_stale_user_desktop()` (at app launch time)

Same logic runs inside the app before `_install_appimage()`. Covers cases where the
user deleted `~/.local/share/TimeTracker/` manually between app launches.

---

## 6. File Locations Summary

| File | Purpose |
|---|---|
| `/opt/timetracker/TimeTracker.AppImage` | System copy installed by dpkg |
| `~/.local/share/TimeTracker/TimeTracker.AppImage` | **Canonical copy** — always launched |
| `~/.local/share/TimeTracker/updates/TimeTracker_v<X>.AppImage` | Staged update (temporary) |
| `~/.local/share/TimeTracker/updates/apply_update.sh` | Auto-generated updater script |
| `~/.local/share/TimeTracker/updates/update_install.log` | Update install log |
| `~/.local/share/TimeTracker/uninstall.sh` | Uninstall script |
| `~/.local/share/applications/timetracker.desktop` | Per-user launcher (canonical Exec path) |
| `/usr/share/applications/timetracker.desktop` | System launcher (Exec=timetracker) |
| `~/.config/autostart/timetracker.desktop` | Autostart on login |
| `/usr/local/bin/timetracker` | Wrapper: prefers canonical, fallback to /opt/ |

---

## 7. Compression: Why xz Instead of zstd

Ubuntu 24.04's dpkg ≥ 1.21.18 defaults to **zstd** compression for `.deb` data archives.
The bundled app's pure-Python `.deb` extractor uses `lzma` (stdlib) for xz/lzma archives
and the `zstandard` package for zstd. While `zstandard` is bundled via PyInstaller
`hiddenimports`, using xz is safer and simpler.

`build.sh` forces xz:
```bash
dpkg-deb -Zxz --build --root-owner-group "${DEB_BUILD_DIR}" "${DEB_OUT}"
```

---

## 8. Build Pipeline Summary

```
build.sh
  [1] Clean build/ dist/ AppDir/
  [2] Validate embedded config (version, AI server URL, credentials)
  [3] PyInstaller → dist/TimeTracker (standalone binary, ~141MB)
       - upx=False (prevents PYZ deletion bug on Linux)
       - pyinstaller output redirected to build_log.txt directly
         (avoids SIGPIPE when piped through grep | head)
  [4] appimagetool → dist/TimeTracker-v<X>-x86_64.AppImage
  [5] dpkg-deb -Zxz → dist/timetracker_<X>_amd64.deb
       - embeds AppImage in /opt/timetracker/
       - includes wrapper, .desktop, icon, prerm, postinst
```

---

## 9. Supabase Release Publishing

After building, upload the `.deb` to the `releases` bucket and insert a row:

```sql
INSERT INTO app_releases (platform, version, release_url, checksum, created_at)
VALUES (
  'linux',
  '1.0.2',
  'https://<project>.supabase.co/storage/v1/object/public/releases/timetracker_1.0.2_amd64.deb',
  '<sha256 of .deb>',
  now()
);
```

The `checksum` value must be the SHA256 of the **`.deb` file** (not the AppImage),
because `_download_worker` verifies the `.deb` before extraction. After extraction,
`_bundle_checksum_verified = True` prevents `apply_update()` from re-checking the
extracted AppImage (which has a different hash).

The `releases` Supabase storage bucket must allow MIME types:
- `application/vnd.debian.binary-package`
- `application/x-debian-package`

Migration: `supabase/migrations/20260604_fix_releases_bucket_mime_types.sql`

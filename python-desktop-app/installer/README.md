# TimeTracker — Installer & Silent Auto-Update

This folder packages the desktop app as a **per-machine install into
`C:\Program Files\TimeTracker`** with a **silent SYSTEM-context auto-updater**.

## Why this exists (the problem it fixes)

The app was previously a one-file PyInstaller `.exe` that users double-clicked,
which self-installed into `%LOCALAPPDATA%\TimeTracker`. On machines with a
Windows application-control policy (WDAC / Smart App Control / AppLocker) this
was **blocked** with:

```
DLL load failed while importing pyexpat:
An Application Control policy has blocked this file.
```

Two reasons:

1. **One-file** unpacks unsigned DLLs into `%TEMP%\_MEIxxxx` (a user-writable,
   untrusted folder) on every launch, and the policy blocks loading them.
2. **`%LOCALAPPDATA%`** is a user-writable (untrusted) location. Default
   policies only trust `C:\Program Files` and `C:\Windows`.

`pyexpat.pyd` was just the first bundled DLL loaded — any of them would be
blocked. See the team analysis for the full evidence trail.

## What changed

| Area | Before | After |
|------|--------|-------|
| PyInstaller build | one-file (`--onefile`) | **one-folder (`--onedir`)** — DLLs sit next to the exe, no temp extraction (`desktop_app.spec`) |
| UPX | `upx=True` | **`upx=False`** (packers hurt SmartScreen/SAC reputation) |
| Install location of the **exe** | `%LOCALAPPDATA%\TimeTracker` (untrusted) | **`C:\Program Files\TimeTracker`** (trusted) via `TimeTracker.iss` |
| Install mechanism | app self-copies on first run | **Inno Setup installer** (admin-elevated once) |
| Auto-update | app overwrites its own exe in-place (no elevation) | **SYSTEM scheduled task** downloads + installs silently (`update_service.ps1`) |
| Uninstaller | runtime-generated `uninstall.bat` (had stale `BRDTimeTracker` names) | Inno-generated, in Add/Remove Programs |
| Per-user **data** (tokens, DB, settings) | `%LOCALAPPDATA%` / `%APPDATA%` | **unchanged** — data is not executed, so the policy doesn't touch it |

## Files

- **`TimeTracker.iss`** — Inno Setup script. Installs the one-folder build to
  `{autopf}\TimeTracker` (Program Files), records the install dir/version in
  `HKLM\Software\Amzur Technologies\TimeTracker`, registers the
  `TimeTracker Updater` SYSTEM scheduled task, and generates the uninstaller.
- **`update_service.ps1`** — the SYSTEM updater the scheduled task runs hourly.
  Checks the version endpoint, downloads the new installer to a SYSTEM-only
  staging dir, verifies SHA256, and runs it silently (`/VERYSILENT`).
- **`Output/TimeTrackerSetup.exe`** — the compiled installer you distribute
  (created by `build.bat`).

## How auto-update works now (silent, no UAC — the Chrome/Edge model)

```
TimeTracker Updater scheduled task  (runs as SYSTEM, hourly)
        │
        ├─ GET https://forgesync.amzur.com/api/app-version/check?platform=windows&current=<ver>
        ├─ if updateAvailable: download downloadUrl  ->  C:\Windows\Temp\TimeTrackerUpdate\
        ├─ verify SHA256 == checksum
        └─ run TimeTrackerSetup.exe /VERYSILENT   (SYSTEM => writes Program Files, NO prompt)
                 └─ Inno closes the running app, replaces files, restarts it
```

Because the task runs as **SYSTEM** (`/RU SYSTEM /RL HIGHEST`), it is already
fully privileged, so installing into Program Files needs **no UAC prompt**. The
app's own `apply_update()` simply triggers this task on demand
(`schtasks /Run`); the hourly schedule is the guarantee even if the on-demand
trigger is denied.

## How to build

1. Install **Inno Setup 6** on the build machine: <https://jrsoftware.org/isdl.php>
   (provides `ISCC.exe`).
2. (Optional, for signing) install the **Windows SDK** (`signtool`) and set:
   ```bat
   set SIGN_PFX=C:\path\to\codesign.pfx
   set SIGN_PFX_PASSWORD=yourpassword
   ```
3. Run `build.bat`. It will:
   - build the one-folder app to `dist\TimeTracker\`,
   - (if `SIGN_PFX` set) sign every `*.exe` / `*.dll`,
   - compile `installer\Output\TimeTrackerSetup.exe`,
   - (if `SIGN_PFX` set) sign the installer.

Distribute **`TimeTrackerSetup.exe`**.

## ⚠️ Required external steps (NOT done by this code)

These are outside the desktop-app repo and must be completed for auto-update to
work end-to-end:

1. **Server — point `downloadUrl` at the installer.** The
   `/api/app-version/check` endpoint (ai-server) currently returns a
   `downloadUrl` for the old single `TimeTracker.exe`. It must now return:
   - `downloadUrl` → the hosted **`TimeTrackerSetup.exe`** for the new version,
   - `checksum` → the **SHA256 of that installer**,
   - `latestVersion` → the new version string.
   The desktop app and `update_service.ps1` already speak this exact contract;
   only the hosted artifact + checksum change.

2. **Install Inno Setup 6** on whatever machine runs `build.bat` (see above).

3. **Code-signing certificate (recommended, required for the strictest
   policies).** Path-based policies (most enterprises) are satisfied by the
   Program Files location **without** a certificate. *Publisher-based* policies
   (and Smart App Control) require signing. Once you have a cert:
   - set `SIGN_PFX` / `SIGN_PFX_PASSWORD` before `build.bat`, and
   - flip `$RequireValidSignature = $true` in `update_service.ps1` so the
     updater refuses to install any unsigned installer.

## Security / trust model of the SYSTEM updater

The updater runs as SYSTEM, so its trust inputs matter:

- **Transport:** HTTPS (TLS 1.2) to the trusted server.
- **Integrity:** SHA256 from the server manifest is verified before running.
- **Tamper resistance:** the installer is staged in `C:\Windows\Temp\...`
  (SYSTEM/admin-only), so a standard user **cannot** swap the file between
  download and execution. This avoids the classic "SYSTEM executes a
  user-writable file" privilege-escalation hole.
- **Future hardening:** enable `$RequireValidSignature` once signed so the
  updater additionally requires a valid Authenticode signature from your
  publisher.

## Verify on a test machine

1. Build, then run `TimeTrackerSetup.exe` → confirm it installs to
   `C:\Program Files\TimeTracker` and the app launches.
2. `schtasks /Query /TN "TimeTracker Updater" /V /FO LIST` → confirm it exists,
   **Run As User = SYSTEM**, Run Level = Highest.
3. On a locked-down (WDAC/SAC/AppLocker) machine, confirm the app now launches
   (no `pyexpat` block).
4. Bump the server `latestVersion` + host a newer `TimeTrackerSetup.exe` +
   checksum, then `schtasks /Run /TN "TimeTracker Updater"` and watch
   `C:\ProgramData\TimeTracker\updates\update_service.log` — confirm it
   downloads, verifies, installs, and the app reports the new version.

## ⚠️ Known items that still need real-machine testing

I implemented these correct-by-design but **could not build or run them in this
environment** (no Inno Setup / Windows installer execution available here):

- **Relaunch into the user session after a SYSTEM update.** Inno's
  `CloseApplications`/`RestartApplications` handles the running instance during
  install; otherwise the app restarts on next logon via its `HKCU\...\Run`
  entry. If immediate relaunch is required, add a short-lived user-context task
  in `update_service.ps1` (noted inline). **Validate the restart behaviour.**
- **On-demand `schtasks /Run` by a standard user.** A standard user may be
  denied running a SYSTEM task on demand (task DACL). The hourly schedule still
  applies updates regardless; if you want instant "Update now", grant Users run
  permission on the task (the app treats a denied trigger as *deferred*, not a
  failure).
- **`AppId` GUID in `TimeTracker.iss`** uses a placeholder
  (`...-TIMETRACKER01`). Replace with a real, stable GUID before shipping so
  upgrades are tracked correctly in Add/Remove Programs.

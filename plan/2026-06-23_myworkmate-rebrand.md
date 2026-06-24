# MyWorkMate Rebrand — Plan & Migration Record

**Date:** 2026-06-23
**Scope:** Rename the product to **MyWorkMate** across the UI, safely, without breaking
existing installs or auto-update.
**Status:** Phase 1 = ✅ implemented (not yet released). Phase 2 = 📋 documented, **not** started.

---

## 1. Context / Why

The product is being rebranded from **"Amzur Time Tracker" / "Time Tracker" / "TimeTracker"**
to **MyWorkMate** (matching the new portal domain `myworkmate.amzur.com`). This supersedes the
earlier *URL-only* decision (2026-06-23) that had kept the in-app name as "Amzur Time Tracker".

The hard requirement throughout: **do not disturb existing functionality** — especially the
desktop app's **auto-update**, **login/credentials**, **saved data**, and **startup**
registration for users already installed as "TimeTracker".

---

## 2. The core idea — two layers of identity

Every name in the codebase is one of two kinds:

| Layer | Examples | Safe to rename? |
|---|---|---|
| **Display identity** (what humans see) | app UI text, tray tooltip, toasts, Start Menu shortcut, Add/Remove Programs entry, installer wizard | ✅ Yes — anytime |
| **Functional identity** (what code/Windows key off) | install dir, `TimeTracker.exe`, `"TimeTracker Updater"` task, HKCU Run value name, HKLM registry key, keyring/Credential-Manager service, data dir, installer **AppId** | ⚠️ No — changing these forces a data/credential **migration** |

**Phase 1 = rename the display layer only.** **Phase 2 = also rename the functional layer
(requires a one-time migration).**

### The brand rule (keeps scope clean)
The codebase has **two brands**. Only one is being changed:
- **"Amzur Time Tracker" / "Time Tracker" / "TimeTracker" / "Amzur Timesheet Tracker"** = the
  internal product brand → **rebrand to "MyWorkMate"**.
- **"BRD Time Tracker"** = the Jira/Marketplace + legal brand → **NEVER changed** (this
  auto-excludes the Forge app, the legal Terms/Privacy pages, the feedback form, and the
  server-identity string).

---

## 3. Phase 1 — Display rename ✅ IMPLEMENTED

Everything a normal user sees now reads **MyWorkMate**, while every functional identifier stays
**TimeTracker**. Existing users get this via normal auto-update **with zero migration risk**
(same AppId + same install dir = in-place upgrade; no logout, no data move).

### 3.1 Files changed (display strings → "MyWorkMate")

**ai-server portal web UI**
- `ai-server/src/portal/index.html` — browser-tab `<title>`
- `ai-server/src/portal/src/pages/LoginPage.jsx` — hero heading (kept "© Amzur Technologies" + logo alt text)
- `ai-server/src/portal/src/components/layout/Sidebar.jsx` — logo block (kept footer copyright)

**ai-server internal ops page**
- `ai-server/src/dashboard/admin-dashboard.html` — page `<title>`

**Desktop app** — `python-desktop-app/desktop_app.py`
- Tray tooltip/title + `pystray.Icon(...)` name
- Pause window title (`"MyWorkMate - Paused"`)
- All toast notifications: `app_id` (sender label) + titles + messages
- All locally-served HTML pages (consent / admin / settings / dashboard): titles + brand text
- The generated uninstaller's user-facing `echo` lines
- A few user-facing console `print()` lines

**Installer display-name split** — `python-desktop-app/installer/TimeTracker.iss`
- Added `#define MyAppDisplayName "MyWorkMate"`.
- Used `MyAppDisplayName` for the **display** fields only: `AppName`, `DefaultGroupName`
  (Start Menu folder), `UninstallDisplayName` (Add/Remove Programs), `[Icons]` shortcut names.
- Kept `MyAppName="TimeTracker"` for the **functional** fields: `DefaultDirName`
  (`C:\Program Files\TimeTracker`), HKLM `Software\Amzur Technologies\TimeTracker`, the HKCU
  Run-key value name, ProgramData/AppData paths.
- Added `CurStepChanged(ssPostInstall)` that deletes the stale old `{commonprograms}\TimeTracker`
  Start Menu group on upgrade (cosmetic; shortcuts hold no data; no-op on fresh installs).

### 3.2 Verification done
- `python -m py_compile desktop_app.py` → OK (the 2 SyntaxWarnings are pre-existing, in untouched docstrings).
- Portal `npm run build` → ✅ built (LoginPage + Sidebar compile).
- Jest `tests/portal-brand-guard.test.js` → pass ("MyWorkMate" is not a banned word).
- The desktop diff is **100% display-string swaps** — no function/identifier/logic changed.
- Confirmed nothing reads the changed strings back: active-window tracking uses
  `process.name()` + PID (not the window title); screenshot-skip uses DB classification keyed on
  `app_name`; every `MyWorkMate` occurrence is a write/display, never a comparison.
- Installer token split verified by grep; no `.bat`/`.ps1` in the pipeline references the
  renamed Start Menu group.
- Desktop `tests/test_tray_menu_and_notifications.py`: 17 pass, 11 fail — the 11 are
  **pre-existing** (they expect `show_update_notification`; current code builds the toast inline
  and calls `auto_apply()`), unrelated to branding.

### 3.3 Why auto-update is NOT affected (the proof)
The auto-update flow is keyed entirely on functional identifiers that **did not change**:

| Update step | Keyed on | Changed? |
|---|---|---|
| Version check (`/api/app-version/check?platform=windows&current=…`) | platform + version number | ❌ |
| Download → staged file `TimeTracker_v{version}.exe` | exe-name convention | ❌ |
| Install trigger | SYSTEM task `"TimeTracker Updater"` | ❌ |
| Upgrade-in-place identity | installer **AppId** `{0302495E-…}` + install dir | ❌ |
| Login preserved | keyring service `TimeTracker` | ❌ |
| Data preserved | `%LOCALAPPDATA%\TimeTracker` | ❌ |
| Startup preserved | HKCU Run value name `TimeTracker` | ❌ |

Existing "TimeTracker" users upgrade in place, stay logged in, keep their data and startup, and
simply see the name is now MyWorkMate.

### 3.4 Cosmetic caveat (not a malfunction)
The toast `app_id` (Windows AppUserModelID) changed `Time Tracker` → `MyWorkMate`, so
notifications now show "MyWorkMate" as the sender. A user who had *manually muted* the old
"Time Tracker" notifications in Windows Settings would have that preference reset to default
(enabled). No functional impact. (If undesired, keep `app_id="Time Tracker"` while still showing
"MyWorkMate" everywhere else.)

---

## 4. FROZEN functional identifiers — do NOT change in Phase 1 (would need Phase 2 migration)

| Identifier | Value | Where |
|---|---|---|
| Executable | `TimeTracker.exe` | desktop_app.py, .spec, .iss |
| Install dir (prod) | `C:\Program Files\TimeTracker` | .iss `DefaultDirName` |
| Install/data dir | `%LOCALAPPDATA%\TimeTracker` | desktop_app.py |
| Scheduled task | `"TimeTracker Updater"` | desktop_app.py `SYSTEM_UPDATE_TASK_NAME`, .iss |
| Single-instance mutex | `TimeTracker_SingleInstance_Mutex` | desktop_app.py |
| Startup (Run key value name) | `TimeTracker` | desktop_app.py, .iss |
| HKLM install key | `Software\Amzur Technologies\TimeTracker` | .iss |
| Credentials (keyring service) | `TimeTracker` (`KEYRING_SERVICE`) | desktop_app.py |
| Internal app name | `APP_NAME = "TimeTracker"` | desktop_app.py |
| Python class | `class TimeTracker` | desktop_app.py |
| Staged update file | `TimeTracker_v{version}.exe` | desktop_app.py |
| Installer AppId | `{0302495E-0DC4-460E-85CE-92C26EFE0FF0}` | .iss |
| Installer output | `TimeTrackerSetup.exe` | .iss, build.bat |
| Data file names | `time_tracker_*.json` / `.db` | desktop_app.py, .iss |
| Version-check endpoint | `/api/app-version/check` | desktop_app.py |

---

## 5. Out of scope (intentionally NOT rebranded)

- **ai-server transactional emails / sender name** — `MAIL_FROM_NAME` still "Amzur Time Tracker";
  templates in `ai-server/src/services/notifications/templates/`, the mail adapters, and the
  reset-email controller are unchanged. (Per user instruction.)
- **Forge / Jira Marketplace app** — `forge-app/` manifest titles, package name
  `brd-automate-time-tracker`, module keys `brd-time-tracker-*`. Separate brand context.
- **Legal pages** — Terms / Privacy (`ai-server/src/legal/*`, `forge-app/legal/*`) carry
  "BRD Time Tracker".
- `portal-app-name-service` (`TimeTracker.exe → "Time Tracker"`) — this cleans *other apps'*
  executable names; it is classification logic, **not** the product brand. Never touch.

---

## 6. Phase 2 — Full deep rename 📋 FUTURE / OPTIONAL (not started)

**Goal:** also rename the functional identifiers in Section 4 so even the install folder,
Task Scheduler, Credential Manager, and registry read "MyWorkMate".

**Benefit:** small — only power users who open Program Files / Task Scheduler / Credential
Manager ever see these. Everything a normal user sees is *already* MyWorkMate after Phase 1.

**Cost / risk:** real — it must **move existing users' login and data** from the old
"TimeTracker" names to new "MyWorkMate" names. If a step fails, a user can be logged out or lose
local unsynced data. Therefore Phase 2 is **not zero-risk** like Phase 1 and must be its own
tested project.

### 6.1 What Phase 2 would change
Each frozen identifier in Section 4 → its MyWorkMate equivalent (e.g. install dir
`…\MyWorkMate`, task `"MyWorkMate Updater"`, keyring service `MyWorkMate`, Run value name
`MyWorkMate`, HKLM `Software\Amzur Technologies\MyWorkMate`, data dir
`%LOCALAPPDATA%\MyWorkMate`). The installer AppId can **stay the same** (to keep upgrade
detection), or be reissued (only if doing a clean uninstall+reinstall).

### 6.2 Required: a one-time, idempotent migration shim
Runs on first launch of the new version (and/or in the installer for the elevated parts):
1. **Credentials** — copy every secret from keyring service `TimeTracker` → `MyWorkMate`
   (**copy, verify, then** optionally delete old). Without this, users get logged out.
2. **Data dir** — if `%LOCALAPPDATA%\MyWorkMate` doesn't exist and `…\TimeTracker` does,
   copy/move its contents (offline DB, consent, cache).
3. **Startup** — add HKCU Run `MyWorkMate`, remove `TimeTracker`.
4. **Scheduled task** — register `"MyWorkMate Updater"`, delete `"TimeTracker Updater"`
   (needs SYSTEM/installer context).
5. **Registry** — migrate `HKLM\Software\Amzur Technologies\TimeTracker` → `…\MyWorkMate`.
6. **Mark done** — write a one-time flag (file/registry) so the shim is idempotent and never
   re-runs or double-migrates.

**Safety rules:** copy-then-verify-then-delete (never delete old before new is confirmed); keep
old as fallback for one release; handle "already migrated"; log every step for support.

### 6.3 The install-folder snag (important)
With a preserved AppId, Inno Setup **upgrades into the existing folder regardless of
`DefaultDirName`** — so you cannot simply "move" existing installs to
`C:\Program Files\MyWorkMate` via a normal upgrade. Options:
- **(a)** Keep the folder as `…\TimeTracker` and only rename everything else → tiny benefit;
  basically still Phase 1 for the folder.
- **(b)** Ship a transitional installer that uninstalls the old AppId and installs fresh to
  `…\MyWorkMate` **after** the data/credential migration has run and been verified → highest
  risk; needs careful sequencing so nothing is wiped before it's copied.

### 6.4 Recommendation
**Do Phase 2 only if there is a hard requirement** that the internal folder/registry/task names
must also say "MyWorkMate". Otherwise stop at Phase 1. If pursued, plan + test the migration
shim on real upgrade scenarios (logged-in user, offline pending data, antivirus present,
standard vs admin user) **before** shipping.

---

## 7. Optional polish (not done, low effort, display-only)
- Add a `VERSIONINFO` to `python-desktop-app/desktop_app.spec` so the `.exe` file Properties show
  ProductName "MyWorkMate" (safe, display-only).
- Rename the **downloaded** setup artifact `TimeTrackerSetup.exe` → `MyWorkMateSetup.exe`
  (touches `build.bat` + the release-upload step; does not affect in-place upgrade).

---

## 8. Decision log
- **2026-06-23** — Display name = **"MyWorkMate"** (company line stays "© Amzur Technologies").
- **2026-06-23** — Scope = portal UI + desktop UI. **Emails excluded.** Forge app + legal excluded.
- **2026-06-23** — Chose **Phase 1 (display split)** for the next release; Phase 2 deferred/optional.

## 9. Verification checklist for the next release
1. `cd ai-server/src/portal && npm run build` → succeeds; login + sidebar show "MyWorkMate".
2. `cd ai-server && npx jest tests/portal-brand-guard.test.js` → pass.
3. `python -m py_compile python-desktop-app/desktop_app.py` → OK.
4. Build the installer via `build.bat` (runs ISCC) → compiles; **on a test VM that already has
   the old "TimeTracker" build, run the new installer and confirm: in-place upgrade (same
   `C:\Program Files\TimeTracker`), still logged in, data intact, startup intact, Start Menu +
   Add/Remove now read "MyWorkMate", no leftover "TimeTracker" Start Menu group.**
5. Grep guard: no in-scope UI file shows the old product brand; every `BRD Time Tracker` is
   unchanged.

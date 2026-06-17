; ============================================================================
; TimeTracker - Inno Setup installer
; ----------------------------------------------------------------------------
; WHY THIS EXISTS
;   The app was previously a one-file PyInstaller .exe that users double-clicked
;   and which self-installed into %LOCALAPPDATA%\TimeTracker. On machines with a
;   Windows application-control policy (WDAC / Smart App Control / AppLocker),
;   that model is blocked, because:
;     - one-file unpacks unsigned DLLs into %TEMP% (an untrusted folder), and
;     - %LOCALAPPDATA% is a user-writable (untrusted) location.
;   Only C:\Program Files and C:\Windows are trusted by default policies.
;
;   This installer puts the one-folder build into C:\Program Files\TimeTracker
;   (a trusted, admin-only location) and registers a SYSTEM-context scheduled
;   task that performs SILENT auto-updates (the same approach Chrome/Edge use to
;   update themselves in Program Files without a UAC prompt). See update_service.ps1.
;
; BUILD
;   Compiled by build.bat via the Inno Setup command-line compiler (ISCC.exe):
;       ISCC.exe /DMyAppVersion=9.0.0 installer\TimeTracker.iss
;   Requires the one-folder PyInstaller output to exist at dist\TimeTracker\.
;   Output: installer\Output\TimeTrackerSetup.exe
; ============================================================================

#ifndef MyAppVersion
  #define MyAppVersion "9.0.0"    ; fallback; build.bat overrides with /D
#endif

#define MyAppName        "TimeTracker"
#define MyAppPublisher   "Amzur Technologies"
#define MyAppExeName     "TimeTracker.exe"
#define MyUpdateTaskName "TimeTracker Updater"

[Setup]
; Stable unique identifier for this product (keep constant across versions so
; upgrades replace in place and Add/Remove Programs tracks it correctly).
AppId={{0302495E-0DC4-460E-85CE-92C26EFE0FF0}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; Install per-machine into Program Files (the trusted location).
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; Streamlined install: don't ask the user anything — just install to the default
; Program Files location. (Forcing Program Files is also required so the install
; stays in a trusted, application-control-allowed location.)
DisableWelcomePage=yes
DisableDirPage=yes
DisableReadyPage=yes
; ---- Force a per-machine (elevated) install. This is the whole point:
; ---- only an admin-elevated install can write to Program Files, which is what
; ---- makes the app trusted by application-control policies.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
; Paths below are script-relative (Inno's default SourceDir is the directory of
; this .iss file = installer\). So "..\dist" = python-desktop-app\dist and
; "Output" = installer\Output. build.bat reads installer\Output\TimeTrackerSetup.exe.
OutputDir=Output
OutputBaseFilename=TimeTrackerSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Close a running TimeTracker during install/upgrade and restart it afterwards.
CloseApplications=yes
RestartApplications=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; The entire one-folder PyInstaller build (TimeTracker.exe + _internal\ + data).
; "..\dist\TimeTracker" = python-desktop-app\dist\TimeTracker (script-relative).
Source: "..\dist\TimeTracker\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; The SYSTEM updater script (run by the scheduled task as SYSTEM); sits beside this .iss.
Source: "update_service.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "clear_credentials.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Registry]
; Record install dir machine-wide so other tooling (and the updater) can find it.
Root: HKLM; Subkey: "Software\{#MyAppPublisher}\{#MyAppName}"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\{#MyAppPublisher}\{#MyAppName}"; ValueType: string; ValueName: "Version"; ValueData: "{#MyAppVersion}"; Flags: uninsdeletekey

[Run]
; --- Register the SYSTEM-context auto-update scheduled task. -----------------
; The installer runs elevated, so this registers a task that runs as SYSTEM
; (fully privileged) and can write the update into Program Files with NO UAC
; prompt. Registration is done via the script's -Register mode, which uses
; PowerShell's Register-ScheduledTask (object-based) -- no fragile schtasks
; quote-escaping. The task runs hourly + at startup (Chrome-style cadence).
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\update_service.ps1"" -Register -InstallDir ""{app}"""; \
  Flags: runhidden waituntilterminated; StatusMsg: "Registering auto-update service..."

; Auto-launch the app at the end of a fresh install. NO 'postinstall' flag and
; NO Description => this does NOT show a "Launch TimeTracker" checkbox; the app
; just starts automatically. runasoriginaluser => starts as the non-elevated user
; (not admin), matching normal use. skipifsilent => not launched during a silent
; SYSTEM auto-update (the installer's RestartApplications handles the restart then).
Filename: "{app}\{#MyAppExeName}"; Flags: nowait skipifsilent runasoriginaluser

[UninstallRun]
; Remove the auto-update scheduled task on uninstall.
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN ""{#MyUpdateTaskName}"""; Flags: runhidden; RunOnceId: "DelUpdateTask"
; Stop the app if it is running so its files can be removed.
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM {#MyAppExeName}"; Flags: runhidden; RunOnceId: "KillApp"
; (HKCU\...\Run auto-start entries are removed for all loaded user hives in [Code].)

[UninstallDelete]
; ProgramData (updater staging/logs). Per-user data is wiped in [Code] below
; across ALL user profiles, since this is a per-machine install.
Type: filesandordirs; Name: "{commonappdata}\{#MyAppName}"

[Code]
// COMPLETE removal on uninstall: delete every trace of TimeTracker for EVERY
// user on the machine — auth tokens, offline DB, consent, settings, caches.
// Requirement: uninstall must leave nothing behind ("remove everything, user and
// all"). The uninstaller runs elevated, so it can reach all user profiles.
procedure WipeAllUserData();
var
  FindRec: TFindRec;
  UsersDir, Profile: String;
  SIDs: TArrayOfString;
  i: Integer;
begin
  // 1) Per-user data folders across ALL user profiles.
  UsersDir := ExpandConstant('{sd}\Users');
  if FindFirst(UsersDir + '\*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0)
           and (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          Profile := UsersDir + '\' + FindRec.Name;
          DelTree(Profile + '\AppData\Local\TimeTracker', True, True, True);
          DelTree(Profile + '\AppData\Roaming\TimeTracker', True, True, True);
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;

  // 2) ProgramData (also covered by [UninstallDelete]; belt-and-suspenders).
  DelTree(ExpandConstant('{commonappdata}\TimeTracker'), True, True, True);

  // 3) HKCU auto-start entry for every currently-loaded user hive (under
  //    HKEY_USERS). Any not-loaded user's leftover entry is harmless — it points
  //    to the now-deleted exe and Windows simply skips it at logon.
  if RegGetSubkeyNames(HKEY_USERS, '', SIDs) then
    for i := 0 to GetArrayLength(SIDs) - 1 do
      RegDeleteValue(HKEY_USERS,
        SIDs[i] + '\Software\Microsoft\Windows\CurrentVersion\Run', '{#MyAppName}');
end;

// Remove this user's TimeTracker credentials from the Windows Credential
// Manager. The OAuth tokens live in the credential vault (not in the data
// folder), so without this they survive uninstall and the app silently signs
// the user back in on reinstall — skipping the login page. Run at usUninstall,
// while {app}\clear_credentials.ps1 still exists (it is deleted with the rest of
// {app} shortly after). Runs as the uninstalling user, whose vault this is.
procedure ClearCredentialVault();
var
  ResultCode: Integer;
begin
  Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\clear_credentials.ps1') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  // Before files are removed: clear the credential vault (needs the script file).
  if CurUninstallStep = usUninstall then
    ClearCredentialVault();
  // After files are removed: wipe all per-user data folders / registry traces.
  if CurUninstallStep = usPostUninstall then
    WipeAllUserData();
end;

// Runs right before files are installed. Force-close any running TimeTracker so
// its files in Program Files can be overwritten. CRITICAL for auto-update: a
// SYSTEM-launched SILENT install cannot close the user-session app via Restart
// Manager, so without this the file stays locked and Setup aborts with exit
// code 5 (the update silently fails and the app stays on the old version).
// taskkill runs in Setup's context (SYSTEM during auto-update) and CAN terminate
// the user-session process.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM {#MyAppExeName}', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(2000);   // give Windows a moment to release the file handles
  Result := '';  // empty string => proceed with installation
end;

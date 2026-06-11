<#
================================================================================
 TimeTracker - SYSTEM auto-update service
--------------------------------------------------------------------------------
 MODES
   -Register     Register the SYSTEM scheduled task (called by the installer,
                 elevated). Uses Register-ScheduledTask (object-based) so there
                 is no fragile schtasks quote-escaping.
   -Unregister   Remove the scheduled task (optional; uninstall also uses
                 schtasks /Delete as a bulletproof fallback).
   (default)     Perform an update check + silent install. This is what the
                 scheduled task runs hourly AS SYSTEM.

 WHY SYSTEM
   Running as SYSTEM (/RunLevel Highest, ServiceAccount) is fully privileged, so
   it can install an update INTO C:\Program Files with NO UAC prompt -> silent
   background auto-update for a per-machine install. Same model as Chrome/Edge.

 UPDATE FLOW (default mode, each run)
   1. Read installed version + install dir + server from HKLM.
   2. GET {server}/api/app-version/check?platform=windows&current={version}
      (the SAME endpoint the app uses).
   3. If an update is available, download the NEW INSTALLER to an ACL-locked
      staging dir under ProgramData (restricted to SYSTEM + Administrators after
      creation => a standard user cannot tamper with the staged installer).
   4. Verify the server's SHA256 checksum.
   5. Run the installer silently (/VERYSILENT). The installer (CloseApplications)
      closes & restarts the running app.

 SECURITY / TRUST MODEL  (see installer/README.md)
   Trust anchors today: HTTPS to the trusted server + server SHA256 + an
   ACL-locked staging dir (SYSTEM + Administrators only). Once a code-signing
   certificate exists, set $RequireValidSignature = $true so the service refuses
   any installer that is not validly Authenticode-signed by your publisher.

 NOTES
   - REQUIRED SERVER CHANGE: downloadUrl must point at the Inno installer
     (TimeTrackerSetup.exe) and checksum must be its SHA256. See README.
   - Windows PowerShell 5.1 compatible (no ternary / null-coalescing).
================================================================================
#>

param(
    [switch]$Register,
    [switch]$Unregister,
    [string]$InstallDir = "",
    [string]$ServerUrl  = ""
)

$ErrorActionPreference = 'Stop'

# ---- Constants --------------------------------------------------------------
$AppName       = 'TimeTracker'
$Publisher     = 'Amzur Technologies'
$ExeName       = 'TimeTracker.exe'
$TaskName      = 'TimeTracker Updater'
$DefaultServer = 'https://timetracker-forge.amzur.com'
$RegKey        = "HKLM:\Software\$Publisher\$AppName"

# Flip to $true once the installer is code-signed (see README). Until then we
# rely on HTTPS + SHA256 + an ACL-locked staging dir (SYSTEM + Administrators).
$RequireValidSignature = $false

# Resolve this script's own path (used when registering the task action).
$ScriptPath = $PSCommandPath
if ([string]::IsNullOrWhiteSpace($ScriptPath)) { $ScriptPath = $MyInvocation.MyCommand.Path }

# ---- Paths ------------------------------------------------------------------
$DataRoot   = Join-Path $env:ProgramData $AppName            # C:\ProgramData\TimeTracker
$UpdatesDir = Join-Path $DataRoot 'updates'
$LogFile    = Join-Path $UpdatesDir 'update_service.log'
$LockFile   = Join-Path $UpdatesDir 'update_service.lock'
$StageDir   = Join-Path $UpdatesDir 'stage'  # ProgramData\TimeTracker\updates\stage; ACL-locked to SYSTEM+Admins after creation

if (-not (Test-Path $UpdatesDir)) {
    New-Item -ItemType Directory -Path $UpdatesDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
    Write-Output $line
}

# =============================================================================
# MODE: -Register  (register the SYSTEM scheduled task)
# =============================================================================
function Register-UpdateTask {
    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        $InstallDir = Split-Path -Parent $ScriptPath
    }
    Write-Log "Registering scheduled task '$TaskName' (InstallDir='$InstallDir', Script='$ScriptPath')"

    # Object-based action -> PowerShell handles all quoting; spaces in paths are
    # safe because we pass the arguments as a single -Argument string with the
    # paths wrapped in literal double-quotes.
    $argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -InstallDir "{1}"' -f $ScriptPath, $InstallDir
    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine

    # Triggers: hourly (indefinite) + at system startup.
    $hourly  = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) -RepetitionInterval (New-TimeSpan -Hours 1)
    $atBoot  = New-ScheduledTaskTrigger -AtStartup

    $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -RunLevel Highest -LogonType ServiceAccount  # S-1-5-18 = LocalSystem
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($hourly, $atBoot) `
        -Principal $principal -Settings $settings -Force | Out-Null

    Write-Log "Scheduled task '$TaskName' registered (SYSTEM, hourly + at startup)."

    # Allow standard (non-admin) users to RUN this SYSTEM task on demand. Without this,
    # the app -- which runs as the logged-in user -- gets "ERROR: Access is denied" when
    # it calls `schtasks /Run` to trigger an immediate update from the "Check for updates"
    # button. We grant Authenticated Users read+EXECUTE on the task's security descriptor.
    # SYSTEM and Administrators keep Full control; users can only VIEW and RUN it, not
    # modify it. (0x1200a9 = generic read + execute.) The hourly SYSTEM run does not need
    # this; it is only for the on-demand trigger.
    try {
        $svc = New-Object -ComObject 'Schedule.Service'
        $svc.Connect()
        $regTask = $svc.GetFolder('\').GetTask($TaskName)
        $sddl = 'D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;AU)'
        $regTask.SetSecurityDescriptor($sddl, 0)
        Write-Log "Granted Authenticated Users run permission on '$TaskName' (on-demand trigger enabled)."
    } catch {
        Write-Log "Could not set task DACL (on-demand trigger may be admin-only; hourly run still works): $($_.Exception.Message)" 'WARN'
    }
}

function Unregister-UpdateTask {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Log "Scheduled task '$TaskName' removed."
    } catch {
        Write-Log "Could not remove task '$TaskName': $($_.Exception.Message)" 'WARN'
    }
}

function Start-AppInUserSession {
    # We run as SYSTEM (session 0), so we cannot launch a GUI app into the
    # logged-on user's session directly. Use a transient interactive scheduled
    # task that runs as the user who owns the active explorer.exe.
    param([string]$ExePath)
    try {
        if (-not (Test-Path $ExePath)) { Write-Log "Relaunch skipped: '$ExePath' not found." 'WARN'; return }
        $exp = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $exp) {
            Write-Log "No interactive user session found; app will start at next logon (HKCU Run)." 'WARN'
            return
        }
        $owner = Invoke-CimMethod -InputObject $exp -MethodName GetOwner -ErrorAction Stop
        $userId = "$($owner.Domain)\$($owner.User)"
        Write-Log "Relaunching app in session of '$userId'..."
        $relaunchName = 'TimeTrackerRelaunch'
        $act  = New-ScheduledTaskAction -Execute $ExePath
        $prin = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $relaunchName -Action $act -Principal $prin -Force | Out-Null
        Start-ScheduledTask -TaskName $relaunchName
        Start-Sleep -Seconds 3
        Unregister-ScheduledTask -TaskName $relaunchName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Log "Relaunch triggered."
    } catch {
        Write-Log "Relaunch in user session failed: $($_.Exception.Message). App will start at next logon." 'WARN'
    }
}

if ($Register)   { Register-UpdateTask;   return }
if ($Unregister) { Unregister-UpdateTask; return }

# =============================================================================
# MODE: default  (check for + apply an update)
# =============================================================================

# Single-instance guard (avoid overlapping hourly runs).
if (Test-Path $LockFile) {
    $age = (New-TimeSpan -Start (Get-Item $LockFile).LastWriteTime -End (Get-Date)).TotalMinutes
    if ($age -lt 30) {
        Write-Log "Another update run appears active (lock age $([int]$age)m). Exiting." 'WARN'
        return
    }
    Write-Log "Stale lock found (age $([int]$age)m); continuing." 'WARN'
}
Set-Content -Path $LockFile -Value (Get-Date -Format o) -Encoding UTF8

try {
    Write-Log "===== Update check started (as $([Security.Principal.WindowsIdentity]::GetCurrent().Name)) ====="

    # TLS 1.2 (Windows PowerShell 5.1 defaults can be too low).
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    # Resolve install dir, current version, server from registry.
    $reg = $null
    try { $reg = Get-ItemProperty -Path $RegKey -ErrorAction Stop } catch { }

    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        if ($reg -and $reg.InstallDir) { $InstallDir = $reg.InstallDir }
    }
    if ([string]::IsNullOrWhiteSpace($ServerUrl)) {
        if ($reg -and $reg.ServerUrl) { $ServerUrl = $reg.ServerUrl } else { $ServerUrl = $DefaultServer }
    }
    $currentVersion = '0.0.0'
    if ($reg -and $reg.Version) { $currentVersion = $reg.Version }

    Write-Log "InstallDir='$InstallDir' CurrentVersion='$currentVersion' Server='$ServerUrl'"

    # Query the version manifest (same contract as the app).
    $checkUrl = "$ServerUrl/api/app-version/check?platform=windows&current=$currentVersion"
    Write-Log "Checking: $checkUrl"

    $resp = Invoke-RestMethod -Uri $checkUrl -Method Get -TimeoutSec 30
    if (-not $resp.success) {
        Write-Log "Server returned success=false. Nothing to do." 'WARN'
        return
    }

    $data = $resp.data
    if (-not $data.updateAvailable) {
        Write-Log "Already up to date (server reports no update)."
        return
    }

    $latest      = [string]$data.latestVersion
    $downloadUrl = [string]$data.downloadUrl
    $checksum    = [string]$data.checksum

    if ([string]::IsNullOrWhiteSpace($downloadUrl)) {
        Write-Log "Update '$latest' available but downloadUrl is empty. Aborting." 'ERROR'
        return
    }
    Write-Log "Update available: v$latest"

    # Download the installer into a freshly-created, ACL-locked staging dir.
    # The installer is later executed AS SYSTEM, so the dir is restricted to
    # SYSTEM + Administrators (no standard-user write) to remove any window for a
    # local user to swap the file between download/verify and execution.
    if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
    try {
        $stageAcl = New-Object System.Security.AccessControl.DirectorySecurity
        $stageAcl.SetAccessRuleProtection($true, $false)   # disable inheritance + drop inherited ACEs
        $idSystem = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'      # LocalSystem
        $idAdmins = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'  # Administrators
        foreach ($sid in @($idSystem, $idAdmins)) {
            $stageAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        }
        Set-Acl -Path $StageDir -AclObject $stageAcl
        Write-Log "Staging dir locked to SYSTEM + Administrators only: $StageDir"
    } catch {
        Write-Log "Could not lock down staging dir ($StageDir): $($_.Exception.Message). Aborting -- refusing to stage a SYSTEM-executed installer in a non-hardened directory." 'ERROR'
        return
    }
    $dest = Join-Path $StageDir "TimeTrackerSetup_$latest.exe"

    Write-Log "Downloading $downloadUrl -> $dest"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $dest -UseBasicParsing -TimeoutSec 600
    if (-not (Test-Path $dest)) {
        Write-Log "Download failed (file missing)." 'ERROR'
        return
    }
    $sizeMB = [math]::Round((Get-Item $dest).Length / 1MB, 2)
    Write-Log "Downloaded $sizeMB MB."

    # Verify SHA256.
    if (-not [string]::IsNullOrWhiteSpace($checksum)) {
        $actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $checksum.ToLower()) {
            Write-Log "CHECKSUM MISMATCH. expected=$($checksum.ToLower()) actual=$actual. Aborting." 'ERROR'
            Remove-Item $dest -Force -ErrorAction SilentlyContinue
            return
        }
        Write-Log "Checksum OK ($actual)."
    } else {
        Write-Log "No checksum provided by server; proceeding on HTTPS trust only." 'WARN'
    }

    # Optional Authenticode check (enable once signed).
    if ($RequireValidSignature) {
        $sig = Get-AuthenticodeSignature -FilePath $dest
        if ($sig.Status -ne 'Valid') {
            Write-Log "Authenticode signature not Valid (status=$($sig.Status)). Aborting." 'ERROR'
            Remove-Item $dest -Force -ErrorAction SilentlyContinue
            return
        }
        Write-Log "Authenticode signature valid: $($sig.SignerCertificate.Subject)"
    }

    # Close the running app BEFORE installing so its files (in Program Files) are
    # not locked. The installer's PrepareToInstall also does this; doing it here
    # too removes any timing race. Without it the silent install aborts with exit
    # code 5 (file in use).
    Write-Log "Stopping running TimeTracker before install..."
    Get-Process -Name 'TimeTracker' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # Install silently (we are SYSTEM => writes to Program Files, no UAC).
    Write-Log "Running installer silently..."
    $proc = Start-Process -FilePath $dest `
        -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOCANCEL' `
        -Wait -PassThru
    Write-Log "Installer exit code: $($proc.ExitCode)"

    if ($proc.ExitCode -eq 0) {
        Write-Log "Update to v$latest applied successfully."
        # Relaunch the updated app in the logged-on user's session.
        Start-AppInUserSession -ExePath (Join-Path $InstallDir 'TimeTracker.exe')
    } else {
        Write-Log "Installer returned non-zero exit code $($proc.ExitCode)." 'ERROR'
    }

    Remove-Item $dest -Force -ErrorAction SilentlyContinue

    # NOTE: Start-AppInUserSession (above) is the primary relaunch path after a
    # successful update. If it fails (no interactive session, or policy blocks
    # registering the transient task), the app falls back to starting at next
    # logon via its HKCU Run entry. The cross-session relaunch is the one piece
    # that can only be fully validated on a real machine with a logged-on user.
}
catch {
    Write-Log "Unhandled error: $($_.Exception.Message)" 'ERROR'
}
finally {
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
    Write-Log "===== Update check finished ====="
}

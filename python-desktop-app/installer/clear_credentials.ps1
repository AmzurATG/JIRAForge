# =============================================================================
# clear_credentials.ps1 — remove TimeTracker's saved credentials from the
# Windows Credential Manager (the "keyring") for the user running this script.
#
# WHY: the Python keyring backend (WinVaultKeyring) stores the OAuth tokens as
# generic credentials named '<key>@TimeTracker' (chunked entries too). These live
# in the credential vault, NOT in the app's data folder, so a normal uninstall
# (which only deletes files/folders) leaves them behind. On reinstall the app
# reads them back and silently signs the user in — skipping the login page.
# This script enumerates the vault and deletes every '*@TimeTracker' credential
# (plus the legacy 'TimeTracker' target) so uninstall truly removes everything.
#
# CONTEXT: Credential Manager is per-user and DPAPI-encrypted, so this only
# clears the vault of the user who runs it (the person uninstalling). Other
# Windows profiles are cleared by the app's own clean-install guard on their
# next launch. Invoked by the uninstaller (TimeTracker.iss, usUninstall).
# =============================================================================
$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CredApi {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredEnumerate(string filter, int flag, out int count, out IntPtr credentials);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool CredDelete(string target, int type, int flag);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr buffer);
}
"@

# CRED_TYPE_GENERIC = 1. In the CREDENTIAL struct, TargetName (an LPWSTR) sits at
# byte offset 8 (DWORD Flags + DWORD Type), regardless of pointer size.
$count = 0
$ptr = [IntPtr]::Zero
$deleted = 0
if ([CredApi]::CredEnumerate($null, 0, [ref]$count, [ref]$ptr)) {
    $size = [IntPtr]::Size
    for ($i = 0; $i -lt $count; $i++) {
        $credPtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $i * $size)
        if ($credPtr -eq [IntPtr]::Zero) { continue }
        $namePtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($credPtr, 8)
        if ($namePtr -eq [IntPtr]::Zero) { continue }
        $target = [Runtime.InteropServices.Marshal]::PtrToStringUni($namePtr)
        if ($target -and ($target -like '*@TimeTracker' -or $target -eq 'TimeTracker')) {
            if ([CredApi]::CredDelete($target, 1, 0)) { $deleted++ }
        }
    }
    [CredApi]::CredFree($ptr)
}
Write-Output "Cleared $deleted TimeTracker credential(s) from the vault."
exit 0

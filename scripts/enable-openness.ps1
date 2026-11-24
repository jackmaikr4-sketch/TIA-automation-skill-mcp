# Run manually in an administrator PowerShell, then sign out/in.
# This script never reboots, signs out, or modifies system registry values.
param([string]$Account)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator PowerShell is required. No changes made.' }
if (-not $Account) { $Account = $identity.Name }
& net.exe localgroup 'Siemens TIA Openness' $Account /add
if ($LASTEXITCODE -ne 0) { throw 'Could not add Openness membership; check current members with net localgroup.' }
Write-Output 'Membership added. Save your documents and sign out/in manually to refresh the Windows token. No restart has been scheduled.'

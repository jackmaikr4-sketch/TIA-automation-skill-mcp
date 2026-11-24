param([Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9-]{36}$')][string]$Id)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$file = Join-Path $root ('artifacts\approvals\' + $Id + '.json')
$r = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $r.expiresAt) { throw 'Request expired. Generate a new request.' }
$r | ConvertTo-Json -Depth 20 | Write-Host
$answer = Read-Host 'Check the exact CPU identity, action and project fingerprint above. Type the full request ID to approve this one action'
if ($answer -cne $Id) { throw 'Approval cancelled' }
$r.approved = $true
[IO.File]::WriteAllText($file, ($r | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
Write-Output 'One action approved until the displayed expiry. AI agents must never run this approval on the user behalf.'

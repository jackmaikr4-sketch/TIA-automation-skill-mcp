param([switch]$Register)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$configurationPath = if ($env:TIA_MCP_CONFIG) { $env:TIA_MCP_CONFIG } else { Join-Path $root 'config.json' }
if (!(Test-Path -LiteralPath $configurationPath)) {
    & node.exe (Join-Path $PSScriptRoot 'configure.mjs')
    if ($LASTEXITCODE) { throw 'Configuration creation failed' }
    throw 'Created config.json. Set the two Siemens API paths, then run install.ps1 again.'
}
Push-Location $root
try {
    & npm.cmd ci --ignore-scripts
    if ($LASTEXITCODE) { throw 'Dependency installation failed' }
    & (Join-Path $PSScriptRoot 'build.ps1')
    & npm.cmd test
    if ($LASTEXITCODE) { throw 'Tests failed' }
    if ($Register) { & (Join-Path $PSScriptRoot 'register-codex.ps1') }
    & node.exe (Join-Path $PSScriptRoot 'doctor.mjs')
    if ($LASTEXITCODE) { Write-Warning 'Environment not ready; read artifacts/doctor.json and README.' }
}
finally { Pop-Location }

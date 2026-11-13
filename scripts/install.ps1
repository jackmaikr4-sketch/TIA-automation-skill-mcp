param([switch]$Register)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
 & npm.cmd ci --ignore-scripts
 if($LASTEXITCODE){throw 'Dependency installation failed'}
 & (Join-Path $PSScriptRoot 'build.ps1')
 & npm.cmd test
 if($LASTEXITCODE){throw 'Tests failed'}
 if($Register){& (Join-Path $PSScriptRoot 'register-codex.ps1')}
 & node.exe (Join-Path $PSScriptRoot 'doctor.mjs')
 if($LASTEXITCODE){Write-Warning 'Environment not ready; read artifacts/doctor.json and README.'}
}finally{Pop-Location}

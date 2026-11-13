$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$cfg=Get-Content -LiteralPath $(if($env:TIA_MCP_CONFIG){$env:TIA_MCP_CONFIG}else{Join-Path $root 'config.json'}) -Raw -Encoding UTF8 | ConvertFrom-Json
$out=Join-Path $root 'bin'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$api=Join-Path $cfg.tiaApiDirectory 'Siemens.Engineering.dll'
$sim=Join-Path $cfg.simulationApiDirectory 'Siemens.Simatic.Simulation.Runtime.Api.x64.dll'
$sha=[Security.Cryptography.SHA256]::Create()
try {$hash=([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $root 'src\TiaWorker.cs'))))).Replace('-','').Substring(0,12).ToLowerInvariant()} finally {$sha.Dispose()}
$filename='TiaWorker-'+$hash+'.exe'
& $csc /nologo /target:exe /platform:x64 /optimize+ /utf8output "/out:$out\$filename" /reference:System.Web.Extensions.dll /reference:System.Xml.Linq.dll /reference:Microsoft.CSharp.dll /reference:System.Security.dll "/reference:$api" "/reference:$sim" (Join-Path $root 'src\TiaWorker.cs')
if($LASTEXITCODE){throw 'Worker compilation failed'}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'TiaWorker.exe.config') -Destination (Join-Path $out ($filename+'.config')) -Force
[IO.File]::WriteAllText((Join-Path $out 'current.json'),(@{executable=$filename}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output 'Built x64 TIA V18 worker.'

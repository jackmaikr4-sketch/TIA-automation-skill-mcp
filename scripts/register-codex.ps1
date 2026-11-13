$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$homeDir=if($env:CODEX_HOME){$env:CODEX_HOME}else{Join-Path $env:USERPROFILE '.codex'}
$cfg=Join-Path $homeDir 'config.toml'
if(Test-Path -LiteralPath $cfg){Copy-Item -LiteralPath $cfg -Destination ($cfg+'.backup-tia-'+(Get-Date -Format 'yyyyMMddHHmmss'))}
& codex mcp add tia-mcp -- (Get-Command node.exe).Source (Join-Path $root 'src\server.mjs')
if($LASTEXITCODE){throw 'Codex MCP registration failed'}
$text=[IO.File]::ReadAllText($cfg)
$text=[regex]::Replace($text,'(?ms)(^\[mcp_servers\.tia-mcp\]\r?\n)(.*?)(?=^\[|\z)',[Text.RegularExpressions.MatchEvaluator]{param($m)
 $body=[regex]::Replace($m.Groups[2].Value,'(?m)^(startup_timeout_sec|tool_timeout_sec)\s*=.*\r?\n?','').TrimEnd()
 $m.Groups[1].Value+$body+"`nstartup_timeout_sec = 30`ntool_timeout_sec = 240`n`n"
})
[IO.File]::WriteAllText($cfg,$text,[Text.UTF8Encoding]::new($false))
Write-Output 'Registered tia-mcp. Reload MCP connections or restart Codex to discover the new tools.'

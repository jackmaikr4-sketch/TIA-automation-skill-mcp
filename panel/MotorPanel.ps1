param([Parameter(Mandatory = $true)][string]$ConfigFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$launch = [IO.File]::ReadAllText($ConfigFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
if ($launch.key -notmatch '^[a-f0-9]{24}$' -or $launch.nonce -notmatch '^[a-f0-9-]{36}$') { throw '面板配置无效' }
$script:sessionDir = [IO.Path]::GetFullPath([string]$launch.runDir)
$script:processStartedAtTicks = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ConfigFile)) -ne $script:sessionDir) { throw '面板路径无效' }
$createdNew = $false
$panelMutex = [Threading.Mutex]::new($true, ('Local\CodexTiaMotorPanel_' + $launch.key), [ref]$createdNew)
if (-not $createdNew) {
    [Windows.Forms.MessageBox]::Show('这个仿真实例的操作面板已经打开，请切换到已有窗口。', [string]$launch.config.title) | Out-Null
    $panelMutex.Dispose()
    exit
}
$script:sequence = 0
$script:closing = $false
$script:allowClose = $false
$script:everConnected = $false
$script:jogHeld = $false
$script:suppressOverload = $false
$script:closeRequestedAt = [DateTime]::UtcNow
$script:lastState = $null
$timer = $null
$form = $null
$btnJog = $null
$lblMessage = $null

function Write-PanelJson([string]$Name, $Value) {
    $target = Join-Path $script:sessionDir $Name
    $temporary = $target + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Compress -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $target -Force -ErrorAction Stop
}
function Send-PanelAction([string]$Action) {
    $script:sequence++
    Write-PanelJson ('{0:D8}.request.json' -f $script:sequence) @{ action = $Action; nonce = [string]$launch.nonce }
}
function Release-Jog {
    if ($script:jogHeld) {
        $script:jogHeld = $false
        if ($null -ne $btnJog) { $btnJog.Capture = $false }
        try { Send-PanelAction 'jog_off' } catch { if ($null -ne $lblMessage) { $lblMessage.Text = '点动释放未确认：' + $_.Exception.Message } }
    }
}
function Set-ControlsEnabled([bool]$Enabled) {
    $btnStart.Enabled = $Enabled
    $btnJog.Enabled = $Enabled
    $btnStop.Enabled = $Enabled
    $chkOverload.Enabled = $Enabled
}
function Request-PanelClose {
    $script:closing = $true
    $script:closeRequestedAt = [DateTime]::UtcNow
    Set-ControlsEnabled $false
    Release-Jog
    $lblMessage.Text = '正在停止电机，收到停止确认后关闭…'
    try { Send-PanelAction 'shutdown' } catch { $lblMessage.Text = '关闭请求未发送：' + $_.Exception.Message }
}
function New-PanelLabel([string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, [int]$FontSize = 10) {
    $label = [Windows.Forms.Label]::new()
    $label.Text = $Text
    $label.Location = [Drawing.Point]::new($X, $Y)
    $label.Size = [Drawing.Size]::new($Width, $Height)
    $label.Font = [Drawing.Font]::new('Microsoft YaHei UI', $FontSize)
    $label.ForeColor = [Drawing.Color]::FromArgb(39, 52, 70)
    $form.Controls.Add($label)
    return $label
}
function New-PanelButton([string]$Text, [int]$X, [Drawing.Color]$Color) {
    $button = [Windows.Forms.Button]::new()
    $button.Text = $Text
    $button.Location = [Drawing.Point]::new($X, 193)
    $button.Size = [Drawing.Size]::new(190, 78)
    $button.Font = [Drawing.Font]::new('Microsoft YaHei UI', 14, [Drawing.FontStyle]::Bold)
    $button.FlatStyle = [Windows.Forms.FlatStyle]::Flat
    $button.FlatAppearance.BorderSize = 0
    $button.BackColor = $Color
    $button.ForeColor = [Drawing.Color]::White
    $button.UseVisualStyleBackColor = $false
    $button.Enabled = $false
    $form.Controls.Add($button)
    return $button
}
function Show-Disconnected([string]$Message) {
    Release-Jog
    Set-ControlsEnabled $false
    $lblMotor.Text = if ($script:everConnected) { '连接中断，状态未知' } else { '等待连接仿真' }
    $lblMotor.ForeColor = [Drawing.Color]::FromArgb(180, 80, 40)
    $lblCpu.Text = 'PLC 状态：未确认'
    $lblInputs.Text = "启动输入：—     停止正常：—`n点动输入：—     过载正常：—`n电机输出：—"
    $lblMessage.Text = $Message
}
try {
    if (-not (Test-Path -LiteralPath $launch.backend) -or -not (Test-Path -LiteralPath $launch.node)) { throw '未找到面板连接程序，请重新安装 tia-mcp。' }
    $backendProcess = Start-Process -FilePath $launch.node -ArgumentList @(('"' + $launch.backend + '"'), '--config', ('"' + [IO.Path]::GetFullPath($ConfigFile) + '"')) -WorkingDirectory $script:sessionDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $script:sessionDir 'backend.stdout.log') -RedirectStandardError (Join-Path $script:sessionDir 'backend.stderr.log') -PassThru
    $form = [Windows.Forms.Form]::new()
    $form.Text = [string]$launch.config.title
    $form.ClientSize = [Drawing.Size]::new(650, 535)
    $form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
    $form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.BackColor = [Drawing.Color]::FromArgb(245, 247, 251)
    $form.AutoScaleMode = [Windows.Forms.AutoScaleMode]::Dpi
    $lblTitle = New-PanelLabel '电机启动、停止与点动' 24 20 600 36 18
    $lblTitle.Font = [Drawing.Font]::new('Microsoft YaHei UI', 18, [Drawing.FontStyle]::Bold)
    $lblSubtitle = New-PanelLabel ('本机 PLC 仿真 · ' + [string]$launch.config.cpu + ' · 指示灯显示实际状态') 26 64 600 26 10
    $lblMotor = New-PanelLabel '正在连接仿真…' 26 104 590 46 24
    $lblMotor.Font = [Drawing.Font]::new('Microsoft YaHei UI', 24, [Drawing.FontStyle]::Bold)
    $lblCpu = New-PanelLabel 'PLC 状态：等待连接' 28 157 590 26 10
    $btnStart = New-PanelButton "启动`n点击后连续运行" 24 ([Drawing.Color]::FromArgb(27, 139, 83))
    $btnStop = New-PanelButton "停止`n点击停止电机" 230 ([Drawing.Color]::FromArgb(205, 53, 62))
    $btnJog = New-PanelButton "点动`n按住运行" 436 ([Drawing.Color]::FromArgb(42, 103, 190))
    $btnJog.TabStop = $false
    $lblHint = New-PanelLabel '点动：待机时按住运行，松开停止（最长 30 秒）。' 26 282 600 26 10
    $chkOverload = [Windows.Forms.CheckBox]::new()
    $chkOverload.Text = '模拟过载（勾选后电机立即停止）'
    $chkOverload.Location = [Drawing.Point]::new(27, 321)
    $chkOverload.Size = [Drawing.Size]::new(590, 30)
    $chkOverload.Font = [Drawing.Font]::new('Microsoft YaHei UI', 11)
    $chkOverload.Enabled = $false
    $form.Controls.Add($chkOverload)
    $lblInputs = New-PanelLabel "启动输入：—     停止正常：—`n点动输入：—     过载正常：—`n电机输出：—" 28 365 595 76 11
    $lblMessage = New-PanelLabel '正在连接已下载的电机工程…' 28 450 595 50 10
    $lblFoot = New-PanelLabel '关闭面板时会先停止电机，并等待实际状态确认。' 28 508 595 22 9
    $tips = [Windows.Forms.ToolTip]::new()
    $tips.SetToolTip($btnStart, [string]$launch.config.tags.start)
    $tips.SetToolTip($btnStop, [string]$launch.config.tags.stopOk)
    $tips.SetToolTip($btnJog, [string]$launch.config.tags.jog)
    $tips.SetToolTip($chkOverload, [string]$launch.config.tags.overloadOk)
    $tips.SetToolTip($lblInputs, ('电机输出：' + $launch.config.tags.motor + '；自保持：' + $launch.config.tags.latch))
    $btnStart.Add_Click({ try { Send-PanelAction 'start'; $lblMessage.Text = '正在发送启动命令…' } catch { $lblMessage.Text = $_.Exception.Message } })
    $btnStop.Add_Click({ try { Release-Jog; Send-PanelAction 'stop'; $lblMessage.Text = '正在发送停止命令…' } catch { $lblMessage.Text = $_.Exception.Message } })
    $btnJog.Add_MouseDown({ param($sender, $eventArgs)
            if ($eventArgs.Button -eq [Windows.Forms.MouseButtons]::Left -and -not $script:jogHeld -and -not $script:closing) {
                $script:jogHeld = $true
                $btnJog.Capture = $true
                try { Send-PanelAction 'jog_on' } catch { Release-Jog; $lblMessage.Text = $_.Exception.Message }
            }
        })
    $btnJog.Add_MouseUp({ param($sender, $eventArgs) if ($eventArgs.Button -eq [Windows.Forms.MouseButtons]::Left) { Release-Jog } })
    $btnJog.Add_MouseCaptureChanged({ if (-not $btnJog.Capture) { Release-Jog } })
    $form.Add_Deactivate({ Release-Jog })
    $chkOverload.Add_CheckedChanged({
            if (-not $script:suppressOverload -and -not $script:closing) {
                try { Release-Jog; if ($chkOverload.Checked) { Send-PanelAction 'overload_on' } else { Send-PanelAction 'overload_off' } } catch { $lblMessage.Text = $_.Exception.Message }
            }
        })
    $form.Add_FormClosing({ param($sender, $eventArgs)
            if ($script:allowClose) { return }
            if (-not $script:everConnected) {
                try { Send-PanelAction 'detach' } catch {}
                $script:allowClose = $true
                return
            }
            $eventArgs.Cancel = $true
            if (-not $script:closing) { Request-PanelClose }
        })
    $form.Add_Shown({
            Write-PanelJson 'ui.json' @{ pid = $PID; processStartedAtTicks = $script:processStartedAtTicks; nonce = [string]$launch.nonce; title = [string]$launch.config.title }
            $form.Activate()
        })
    $timer = [Windows.Forms.Timer]::new()
    $timer.Interval = 300
    $timer.Add_Tick({
            try {
                Write-PanelJson 'heartbeat.json' @{ at = [DateTimeOffset]::UtcNow.ToString('o'); nonce = [string]$launch.nonce; pid = $PID; processStartedAtTicks = $script:processStartedAtTicks }
                $activate = Join-Path $script:sessionDir 'activate.request'
                if (Test-Path -LiteralPath $activate) {
                    $activation = [IO.File]::ReadAllText($activate, [Text.Encoding]::UTF8) | ConvertFrom-Json
                    Remove-Item -LiteralPath $activate
                    if ($activation.nonce -eq [string]$launch.nonce -and $activation.requestId -match '^[a-f0-9-]{36}$') {
                        $form.WindowState = [Windows.Forms.FormWindowState]::Normal
                        $form.Show()
                        $form.Activate()
                        $form.BringToFront()
                        Write-PanelJson 'activation.json' @{ requestId = [string]$activation.requestId; nonce = [string]$launch.nonce; pid = $PID; processStartedAtTicks = $script:processStartedAtTicks }
                    }
                }
                if ($null -ne $script:lastState -and $script:everConnected -and -not $script:closing) {
                    if (([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$script:lastState.updatedAt)).TotalSeconds -gt 3) { Show-Disconnected '超过 3 秒未收到状态，正在等待连接恢复。' }
                }
                $stateFile = Join-Path $script:sessionDir 'state.json'
                if (Test-Path -LiteralPath $stateFile) {
                    $state = [IO.File]::ReadAllText($stateFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
                    $script:lastState = $state
                    if ($state.closed -eq $true) {
                        $script:allowClose = $true
                        $timer.Stop()
                        $form.Close()
                        return
                    }
                    $fresh = ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$state.updatedAt)).TotalSeconds -le 3
                    $connected = $state.connected -eq $true -and $fresh
                    if ($connected) { $script:everConnected = $true }
                    if (-not $script:closing) {
                        if ($connected) {
                            $lblMotor.Text = if ($state.motor) { '电机运行中' } else { '电机已停止' }
                            $lblMotor.ForeColor = if ($state.motor) { [Drawing.Color]::FromArgb(19, 132, 73) } else { [Drawing.Color]::FromArgb(73, 86, 106) }
                            $lblCpu.Text = 'PLC 状态：' + [string]$state.cpu + '    自保持：' + [int][bool]$state.latch
                            $lblInputs.Text = ('启动输入：{0}     停止正常：{1}' -f [int][bool]$state.inputs.start, [int][bool]$state.inputs.stopOK) + "`n" + ('点动输入：{0}     过载正常：{1}' -f [int][bool]$state.inputs.jog, [int][bool]$state.inputs.frOK) + "`n" + ('电机输出：{0}' -f [int][bool]$state.motor)
                            Set-ControlsEnabled $true
                            $canRun = $state.cpu -eq 'Run' -and $state.inputs.stopOK -eq $true -and $state.inputs.frOK -eq $true
                            $btnStart.Enabled = $canRun
                            $btnJog.Enabled = $canRun
                            if (-not $canRun) { Release-Jog }
                            $script:suppressOverload = $true
                            $chkOverload.Checked = -not [bool]$state.inputs.frOK
                            $script:suppressOverload = $false
                            $lblMessage.Text = [string]$state.message
                        }
                        else { Show-Disconnected $(if (-not $fresh) { '超过 3 秒未收到状态，正在等待连接恢复。' } else { [string]$state.message }) }
                    }
                }
                if ($script:closing -and ([DateTime]::UtcNow - $script:closeRequestedAt).TotalSeconds -ge 8) {
                    $timer.Stop()
                    $choice = [Windows.Forms.MessageBox]::Show("8 秒内未收到停止确认，尚不能确认电机已停止。`n`n选择「重试」再次请求停止并关闭；选择「取消」返回面板。", '停止尚未确认', [Windows.Forms.MessageBoxButtons]::RetryCancel, [Windows.Forms.MessageBoxIcon]::Warning)
                    if ($choice -eq [Windows.Forms.DialogResult]::Retry) { Request-PanelClose } else { $script:closing = $false; $lblMessage.Text = '已取消关闭；电机停止状态尚未确认。' }
                    $timer.Start()
                }
            }
            catch { $lblMessage.Text = '读取状态失败：' + $_.Exception.Message }
        })
    $timer.Start()
    [Windows.Forms.Application]::Run($form)
}
catch {
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, '电机面板无法启动', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}
finally {
    if ($null -ne $timer) { $timer.Stop(); $timer.Dispose() }
    if ($null -ne $form) { $form.Dispose() }
    try { $panelMutex.ReleaseMutex() } catch {}
    $panelMutex.Dispose()
}

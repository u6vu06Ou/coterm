param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Start', 'Stop', 'Status', 'RestartTunnel', 'InstallStartup', 'RemoveStartup', 'InstallSummary', 'RemoveSummary')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $env:LOCALAPPDATA 'Coterm'
$ConfigPath = Join-Path $DataDir 'remote-config.json'
$StatePath = Join-Path $DataDir 'remote-processes.json'
$TaskName = 'Coterm Remote Host'
$SummaryTaskName = 'Coterm Daily Summary'
$TunnelConfig = Join-Path $env:USERPROFILE '.cloudflared\coterm.yml'

function Get-State {
  if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
  Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
}

function Test-ManagedProcess([object]$Id, [string]$Exe, [string]$Marker) {
  if (-not $Id -or -not $Exe) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction SilentlyContinue
  return [bool]($process -and $process.ExecutablePath -eq $Exe -and $process.CommandLine -like "*$Marker*")
}

function Get-CotermListener([string]$Exe) {
  $connection = Get-NetTCPConnection -LocalPort 43127 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
    Select-Object -First 1
  if (-not $connection) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not $process -or $process.ExecutablePath -ne $Exe) { return $null }
  return $process
}

function Test-Running([object]$State) {
  if (-not $State) { return $false }
  $coterm = Get-CotermListener $State.cotermExe
  $tunnel = Test-ManagedProcess $State.tunnelPid $State.tunnelExe 'coterm.yml'
  return [bool]($coterm -and $tunnel)
}

function Show-Status {
  $state = Get-State
  $running = Test-Running $state
  $health = $false
  if ($running) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:43127/health' -TimeoutSec 2
      $health = $response.StatusCode -eq 200
    } catch {}
  }
  [pscustomobject]@{
    running = $running
    healthy = $health
    cotermPid = if ($state) { $state.cotermPid } else { $null }
    tunnelPid = if ($state) { $state.tunnelPid } else { $null }
    url = $env:COTERM_PUBLIC_URL
  }
}

function Start-Host {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $existing = Get-State
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Missing $ConfigPath. Create it from docs/remote-access.md."
  }
  if (-not (Test-Path -LiteralPath $TunnelConfig)) { throw "Missing $TunnelConfig." }
  $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
  foreach ($name in 'teamDomain', 'audience', 'remoteRoots') {
    if (-not $config.$name) { throw "remote-config.json is missing $name." }
  }
  $installedExe = Join-Path $env:LOCALAPPDATA 'Programs\Coterm\Coterm\Coterm.exe'
  $unpackedExe = Join-Path $Repo 'release\win-unpacked\Coterm.exe'
  $cotermExe = if (Test-Path -LiteralPath $installedExe) { $installedExe } else { $unpackedExe }
  if (-not (Test-Path -LiteralPath $cotermExe)) {
    throw "Coterm is not installed and $unpackedExe is missing. Run npm run dist or npm run build:unpack."
  }
  $cloudflared = (Get-Command cloudflared).Source
  $cotermListener = Get-CotermListener $cotermExe
  $cotermRunning = [bool]$cotermListener
  $tunnelRunning = [bool]($existing -and (Test-ManagedProcess $existing.tunnelPid $existing.tunnelExe 'coterm.yml'))
  if ($cotermRunning -and $tunnelRunning) { Show-Status; return }
  $old = @{
    COTERM_ACCESS_TEAM_DOMAIN = $env:COTERM_ACCESS_TEAM_DOMAIN
    COTERM_ACCESS_AUD = $env:COTERM_ACCESS_AUD
    COTERM_REMOTE_ROOTS = $env:COTERM_REMOTE_ROOTS
    COTERM_WEB_PORT = $env:COTERM_WEB_PORT
    COTERM_ALLOWED_ORIGIN = $env:COTERM_ALLOWED_ORIGIN
  }
  try {
    $env:COTERM_ACCESS_TEAM_DOMAIN = [string]$config.teamDomain
    $env:COTERM_ACCESS_AUD = [string]$config.audience
    $env:COTERM_REMOTE_ROOTS = ($config.remoteRoots -join ';')
    $env:COTERM_WEB_PORT = '43127'
    # "self" = accept any origin whose host matches the request host (http or https).
    # Lets tunnel clients (https://coterm.<domain>) in without hard-coding the hostname.
    $env:COTERM_ALLOWED_ORIGIN = 'self'
    if (-not $cotermRunning) {
      $coterm = Start-Process -FilePath $cotermExe -ArgumentList '--host' -WorkingDirectory $Repo -WindowStyle Hidden -PassThru
    }
    if (-not $tunnelRunning) {
      $tunnel = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--config', $TunnelConfig, 'run', 'coterm') -WindowStyle Hidden -PassThru
    }
    for ($attempt = 0; $attempt -lt 20 -and -not $cotermListener; $attempt++) {
      Start-Sleep -Milliseconds 250
      $cotermListener = Get-CotermListener $cotermExe
    }
    [pscustomobject]@{
      cotermPid = if ($cotermListener) { $cotermListener.ProcessId } else { $coterm.Id }
      tunnelPid = if ($tunnelRunning) { $existing.tunnelPid } else { $tunnel.Id }
      cotermExe = $cotermExe
      tunnelExe = $cloudflared
      startedAt = if ($existing.startedAt) { $existing.startedAt } else { (Get-Date).ToString('o') }
      reconciledAt = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
  } finally {
    $env:COTERM_ACCESS_TEAM_DOMAIN = $old.COTERM_ACCESS_TEAM_DOMAIN
    $env:COTERM_ACCESS_AUD = $old.COTERM_ACCESS_AUD
    $env:COTERM_REMOTE_ROOTS = $old.COTERM_REMOTE_ROOTS
    $env:COTERM_WEB_PORT = $old.COTERM_WEB_PORT
    $env:COTERM_ALLOWED_ORIGIN = $old.COTERM_ALLOWED_ORIGIN
  }
  Start-Sleep -Seconds 2
  Show-Status
}

function Stop-Host {
  $state = Get-State
  if (-not $state) { Show-Status; return }
  $targets = @(@{ Id = $state.tunnelPid; Exe = $state.tunnelExe; Marker = 'coterm.yml' })
  $cotermProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.cotermPid)" -ErrorAction SilentlyContinue
  if ($cotermProcess -and $cotermProcess.CommandLine -like '*--host*') {
    $targets += @{ Id = $state.cotermPid; Exe = $state.cotermExe; Marker = '--host' }
  }
  foreach ($target in $targets) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($target.Id)" -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    if ($process.ExecutablePath -ne $target.Exe -or $process.CommandLine -notlike "*$($target.Marker)*") {
      throw "PID $($target.Id) no longer belongs to the Coterm host; refusing to stop it."
    }
    Stop-Process -Id $target.Id
  }
  Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
  Show-Status
}

function Restart-Tunnel {
  $state = Get-State
  if (-not $state -or -not (Test-ManagedProcess $state.tunnelPid $state.tunnelExe 'coterm.yml')) {
    Start-Host
    return
  }
  Stop-Process -Id $state.tunnelPid
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (-not (Get-Process -Id $state.tunnelPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Id $state.tunnelPid -ErrorAction SilentlyContinue) {
    throw "Coterm tunnel PID $($state.tunnelPid) did not stop."
  }
  Start-Host
}

switch ($Action) {
  'Start' { Start-Host }
  'Stop' { Stop-Host }
  'Status' { Show-Status }
  'RestartTunnel' { Restart-Tunnel }
  'InstallStartup' {
    $hiddenLauncher = Join-Path $PSScriptRoot 'coterm-host-hidden.vbs'
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$hiddenLauncher`""
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $periodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger @($logonTrigger, $periodicTrigger) -Settings $settings -Description 'Starts and periodically repairs the private Coterm host and its dedicated Cloudflare Tunnel.' -Force | Out-Null
    Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
  }
  'RemoveStartup' {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  'InstallSummary' {
    $installedExe = Join-Path $env:LOCALAPPDATA 'Programs\Coterm\Coterm\Coterm.exe'
    $unpackedExe = Join-Path $Repo 'release\win-unpacked\Coterm.exe'
    $cotermExe = if (Test-Path -LiteralPath $installedExe) { $installedExe } else { $unpackedExe }
    if (-not (Test-Path -LiteralPath $cotermExe)) { throw 'Coterm executable not found.' }
    $taskAction = New-ScheduledTaskAction -Execute $cotermExe -Argument '--summarize-all'
    $trigger = New-ScheduledTaskTrigger -Daily -At '04:30'
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $SummaryTaskName -Action $taskAction -Trigger $trigger -Settings $settings -Description 'Summarizes changed Coterm sessions with the free DeepSeek/Qwen profiles.' -Force | Out-Null
    Get-ScheduledTask -TaskName $SummaryTaskName | Select-Object TaskName, State
  }
  'RemoveSummary' {
    Unregister-ScheduledTask -TaskName $SummaryTaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
}

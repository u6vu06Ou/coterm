<#
.SYNOPSIS
  Programmatic watcher for one or more dispatched Coterm terminals via the
  AgentApi agent API wait endpoint (GET /api/v1/agent/session/:id/wait).

.DESCRIPTION
  Watches terminals until one of five end conditions fires:
    match       - new scrollback matched -MatchPattern (regex)
    interrupted - terminal entered a -StopOn state (or caller cancel)
    timeout     - the total -TimeoutSec budget elapsed with no match/stop
    stale       - no scrollback growth for -StaleAfterSec seconds
    gone        - terminal process exited (outcome=closed) or the session
                  no longer exists (HTTP 404)
  State-target waits (outcome=matched) are also supported via -State.

  stdout prints exactly ONE LINE per finished terminal:
    WATCH-END <terminalId> <outcome> <logPath>
  All diagnostics/request details go to the per-terminal log file only.

.EXAMPLE
  pwsh -File scripts/agent-watch.ps1 -TerminalId abc123 -MatchPattern '^(DONE|BLOCKED)\b' -TimeoutSec 600

.EXAMPLE
  pwsh -File scripts/agent-watch.ps1 -TerminalId t1,t2 -State done -StopOn error,blocked

.PARAMETER Token
  Bearer token. Resolution order: -Token > $env:COTERM_AGENT_TOKEN >
  %APPDATA%\Coterm\agent-api-token.txt > %APPDATA%\Coterm\agent-api-token.txt
  (the file Coterm writes when Settings -> Agent API is enabled).

.EXIT CODES
  0 = every terminal ended matched|match; 1 = any other outcome; 2 = usage/auth/setup error.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string[]]$TerminalId,

  [string]$State,

  [string]$MatchPattern,

  [string[]]$StopOn,

  [int]$TimeoutSec = 300,

  [int]$StaleAfterSec,

  [string]$Token,

  [string]$BaseUrl = 'http://127.0.0.1:43127',

  [string]$LogDir = (Join-Path $env:TEMP 'coterm-agent-watch')
)

$ErrorActionPreference = 'Stop'

# Accept both `-TerminalId a b` (in-host) and `-TerminalId "a,b"` (-File argv) forms.
$TerminalId = @($TerminalId | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($TerminalId.Count -eq 0) { [Console]::Error.WriteLine('agent-watch: at least one -TerminalId is required.'); exit 2 }

function Exit-Usage([string]$msg) { [Console]::Error.WriteLine("agent-watch: $msg"); exit 2 }

if ($TimeoutSec -lt 1) { Exit-Usage '-TimeoutSec must be >= 1' }
if ($PSBoundParameters.ContainsKey('StaleAfterSec') -and ($StaleAfterSec -lt 1 -or $StaleAfterSec -gt 300)) {
  Exit-Usage '-StaleAfterSec must be in 1..300'
}

# Resolve bearer token (never hard-coded).
if (-not $Token) { $Token = $env:COTERM_AGENT_TOKEN }
if (-not $Token) {
  foreach ($dir in @('Coterm', 'Coterm')) {
    $p = Join-Path $env:APPDATA "$dir\agent-api-token.txt"
    if (Test-Path -LiteralPath $p) { $Token = (Get-Content -Raw -LiteralPath $p).Trim(); break }
  }
}
if (-not $Token) {
  Exit-Usage 'No agent token: pass -Token, set COTERM_AGENT_TOKEN, or enable Settings -> Agent API in Coterm.'
}

# At least one wait condition is required by the endpoint; default to state=done.
if (-not $State -and -not $MatchPattern -and -not $PSBoundParameters.ContainsKey('StaleAfterSec')) {
  $State = 'done'
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$watchBody = {
  param($Id, $BaseUrl, $Token, $State, $MatchPattern, $StopOn, $TimeoutSec, $StaleAfterSec, $LogDir)
  $ErrorActionPreference = 'Stop'
  $logPath = Join-Path $LogDir ("watch-{0}-{1:yyyyMMdd-HHmmss}.log" -f $Id, (Get-Date))
  function Log([string]$msg) {
    Add-Content -LiteralPath $logPath -Value ("[{0:u}] {1}" -f (Get-Date), $msg)
  }

  $query = ''
  if ($State) { $query += "&state=$([uri]::EscapeDataString($State))" }
  if ($MatchPattern) { $query += "&match=$([uri]::EscapeDataString($MatchPattern))" }
  if ($StopOn -and $StopOn.Count -gt 0) { $query += "&stopOn=$([uri]::EscapeDataString(($StopOn -join ',')))" }
  if ($StaleAfterSec) { $query += "&staleAfterSec=$StaleAfterSec" }
  $baseUrl = "{0}/api/v1/agent/session/{1}/wait" -f $BaseUrl, ([uri]::EscapeDataString($Id))
  $headers = @{ Authorization = "Bearer $Token" }

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $outcome = 'timeout'
  while ($true) {
    $remain = [int][math]::Ceiling(($deadline - (Get-Date)).TotalSeconds)
    if ($remain -le 0) { $outcome = 'timeout'; break }
    $slice = [math]::Min($remain, 300) # endpoint caps timeout at 300s per call
    try {
      $resp = Invoke-RestMethod -UseBasicParsing -Method Get `
        -Uri "$baseUrl`?timeout=$slice$query" `
        -Headers $headers -TimeoutSec ($slice + 10)
      $out = $resp.result.outcome
      Log ($resp | ConvertTo-Json -Depth 8 -Compress)
      if ($out -eq 'timeout') { continue } # server-side slice elapsed; keep waiting within budget
      $outcome = $out
      break
    } catch {
      $status = $null
      try { $status = [int]$_.Exception.Response.StatusCode } catch {}
      $detail = $null
      try { $detail = $_.ErrorDetails.Message } catch {}
      if (-not $detail) { $detail = $_.Exception.Message }
      Log "ERROR status=$status $detail"
      switch ($status) {
        404 { $outcome = 'gone' }
        401 { $outcome = 'auth-error' }
        503 { Start-Sleep -Seconds 2; continue } # coordinator shutting down; retry within budget
        default { $outcome = if ($status) { "error-$status" } else { 'error-unreachable' } }
      }
      break
    }
  }
  "WATCH-END $Id $outcome $logPath"
}

$jobs = foreach ($id in $TerminalId) {
  $staleArg = if ($PSBoundParameters.ContainsKey('StaleAfterSec')) { $StaleAfterSec } else { 0 }
  Start-Job -ScriptBlock $watchBody -ArgumentList $id, $BaseUrl, $Token, $State, $MatchPattern, $StopOn, $TimeoutSec, $staleArg, $LogDir
}

$failed = $false
try {
  while ($jobs) {
    $done = Wait-Job -Job $jobs -Any
    foreach ($j in @($done)) {
      $line = ($j | Receive-Job) | Select-Object -Last 1
      Write-Output $line
      if ($line -notmatch ' (matched|match) ') { $script:failed = $true }
      $j | Remove-Job -Force
    }
    $jobs = @($jobs | Where-Object { $_.State -eq 'Running' -or $_.State -eq 'NotStarted' })
  }
} finally {
  Get-Job | Where-Object { $_.Name -like 'Job*' -and $jobs -contains $_ } | Remove-Job -Force -ErrorAction SilentlyContinue
}

exit ([int]$failed)

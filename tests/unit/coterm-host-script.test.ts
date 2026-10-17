import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = readFileSync(resolve(process.cwd(), 'scripts/coterm-host.ps1'), 'utf8')
const hiddenLauncher = resolve(process.cwd(), 'scripts/coterm-host-hidden.vbs')

describe('Coterm host service script', () => {
  it('repairs only the missing managed process', () => {
    expect(script).toContain('function Test-ManagedProcess')
    expect(script).toMatch(/if \(-not \$cotermRunning\)[\s\S]*?Start-Process[\s\S]*?if \(-not \$tunnelRunning\)[\s\S]*?Start-Process/)
  })

  it('rebinds stale state to the actual localhost Coterm listener', () => {
    expect(script).toContain('function Get-CotermListener')
    expect(script).toContain("Get-NetTCPConnection -LocalPort 43127")
    expect(script).toContain('$cotermListener.ProcessId')
  })

  it('periodically reconciles child processes without a rapid restart loop', () => {
    expect(script).toContain("New-TimeSpan -Minutes 5")
    expect(script).toContain('-RepetitionInterval')
  })

  it('uses a windowless launcher for the five-minute task', () => {
    expect(script).toContain("-Execute 'wscript.exe'")
    expect(script).toContain('coterm-host-hidden.vbs')
    expect(readFileSync(hiddenLauncher, 'utf8')).toContain('shell.Run(command, 0, True)')
  })

  it('installs the free daily summary task at 04:30 without a console host', () => {
    expect(script).toContain("'InstallSummary'")
    expect(script).toContain("'Coterm Daily Summary'")
    expect(script).toContain("New-ScheduledTaskTrigger -Daily -At '04:30'")
    expect(script).toContain("-Argument '--summarize-all'")
  })

  it('can restart only the dedicated tunnel for recovery testing', () => {
    expect(script).toContain("'RestartTunnel'")
    expect(script).toMatch(/function Restart-Tunnel[\s\S]*?Test-ManagedProcess[\s\S]*?Stop-Process[\s\S]*?Start-Host/)
    expect(script).toMatch(/for \(\$attempt = 0; \$attempt -lt 40;/)
  })
})

$ErrorActionPreference = "Stop"
$out = Join-Path $PSScriptRoot "..\resources\codex-protocol"
if (Test-Path $out) {
  Remove-Item -LiteralPath $out -Recurse -Force
}
New-Item -ItemType Directory -Path $out | Out-Null
codex app-server generate-ts --experimental --out $out
$version = (codex --version).Trim()
$snapshot = @"
# Codex app-server compatibility snapshot

- Generated: $(Get-Date -Format "yyyy-MM-ddTHH:mm:ssK")
- CLI: $version
- Command: ``codex app-server generate-ts --experimental``

These files are checked in so protocol drift can be reviewed before updating the adapter.
"@
Set-Content -LiteralPath (Join-Path $out "COMPATIBILITY.md") -Value $snapshot -Encoding utf8
Write-Output "Codex protocol bindings generated at $out"

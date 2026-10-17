# Platform Support

Coterm is **Windows-first**. Other platforms are not blocked from launching,
but are untested and considered experimental.

## Support matrix

| Platform | Tier | Status |
|---|---|---|
| Windows 10/11 | Tier 1 | Fully supported. Official installer (`release/Coterm-<version>-Setup.exe`) via `npm run dist`. |
| macOS | Tier 2 | Theoretically runs; not officially tested. No installer build. PRs welcome. |
| Linux | Tier 2 | Theoretically runs; not officially tested. No installer build. PRs welcome. |

## Policy

No platform-specialisation work is done speculatively (YAGNI). When real
non-Windows users appear, the points below are where hardening should focus.

## Platform-specific points

- **conpty** — Windows-only pseudoconsole. `src/main/terminal/pty-manager.ts`
  sets `useConpty: process.platform === "win32"`; on macOS/Linux the underlying
  `node-pty` falls back to Unix PTYs automatically. No code change needed.
- **pwsh default shell** — The default terminal profile resolves to PowerShell 7
  (`pwsh.exe`) on Windows, falling back to Windows PowerShell 5.1. On macOS/Linux
  the resolver still returns the bare name `pwsh.exe`, which will not resolve
  unless a `pwsh` binary is on PATH. Until per-platform shell resolution is
  implemented, macOS/Linux users should select the `bash` or `zsh` profile
  explicitly when creating a terminal.
- **CLI executable resolution** — `src/main/providers/executables.ts` already
  short-circuits on non-Windows (`if (process.platform !== "win32") return name`),
  so `claude` / `codex` are invoked by bare name on macOS/Linux.
- **NSIS installer** — `electron-builder` is configured for `--win nsis`
  (`npm run dist`). There is no DMG / AppImage / deb build target. macOS/Linux
  users must run from source (`npm run dev`) or build their own packaging.
- **PowerShell build scripts** — `scripts/generate-icon.ps1`,
  `scripts/generate-codex-protocol.ps1`, `scripts/coterm-host.ps1`, and
  `scripts/coterm-host-hidden.vbs` are Windows-only build/hosting helpers. They
  are not required to run the app from source on macOS/Linux (icon generation
  and installer packaging are Windows-only concerns).

## Startup behaviour on non-Windows

`src/main/index.ts` does **not** block startup on non-Windows platforms. It
emits a single `logger.warn` line at bootstrap so the experimental status is
visible in `<userData>/logs/coterm.log`:

> Platform compatibility: Coterm is Windows-first. macOS/Linux support is
> experimental and untested.

Windows behaviour is unchanged — the warning branch is skipped entirely.

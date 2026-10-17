import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let toml;
try { toml = require('smol-toml'); }
catch { toml = require('./smol-toml.cjs'); }

// Inherit local tools and instructions, never providers or account state.
export function capabilityConfig(sourceHome) {
  const file = path.join(sourceHome, 'config.toml');
  const source = fs.existsSync(file) ? toml.parse(fs.readFileSync(file, 'utf8')) : {};
  const servers = {};
  for (const [name, server] of Object.entries(source.mcp_servers || {})) {
    if (name === 'codex_team' || name === 'team_bus') continue;
    servers[name] = server;
  }
  return {
    mcp_servers: servers,
    ...(source.skills ? { skills: source.skills } : {}),
    ...(source.projects ? { projects: source.projects } : {}),
  };
}

export function writeAgentConfig(runtimeHome, sourceHome, config) {
  const inherited = capabilityConfig(sourceHome);
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(path.join(runtimeHome, 'config.toml'), toml.stringify({
    ...config, ...inherited, mcp_servers: { ...inherited.mcp_servers, ...config.mcp_servers },
  }), 'utf8');
  for (const directory of ['skills', 'rules']) {
    const sourceDir = path.join(sourceHome, directory), targetDir = path.join(runtimeHome, directory);
    if (fs.existsSync(sourceDir) && !fs.existsSync(targetDir)) {
      fs.symlinkSync(sourceDir, targetDir, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  for (const name of ['AGENTS.md', 'AGENTS.override.md']) {
    const source = path.join(sourceHome, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(runtimeHome, name));
  }
  return Object.entries(inherited.mcp_servers).filter(([, server]) => server.enabled !== false).map(([name]) => name);
}

export function workerAccess(args) {
  const legacy = args.workspace_write;
  const access = args.access ?? (legacy === undefined ? 'full-access' : legacy ? 'workspace-write' : 'read-only');
  if (!['full-access', 'workspace-write', 'read-only'].includes(access)) throw new Error('Invalid access mode');
  if (legacy !== undefined && typeof legacy !== 'boolean') throw new Error('workspace_write must be boolean');
  if (args.access !== undefined && legacy !== undefined) throw new Error('Use access or workspace_write, not both');
  return access;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { writeAgentConfig, workerAccess } from '../capabilities.mjs';
const { parse } = createRequire(import.meta.url)('smol-toml');

test('normal access and explicit restrictions never silently escalate', () => {
  assert.equal(workerAccess({}), 'full-access');
  assert.equal(workerAccess({ workspace_write: false }), 'read-only');
  assert.equal(workerAccess({ workspace_write: true }), 'workspace-write');
  assert.equal(workerAccess({ access: 'read-only' }), 'read-only');
  assert.throws(() => workerAccess({ access: 'full-access', workspace_write: false }));
  assert.throws(() => workerAccess({ access: 'unknown' }));
});

test('inherit local tools, skill flags and instructions without account/provider state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-capabilities-'));
  const source = path.join(home, 'source'), runtime = path.join(home, 'runtime');
  fs.mkdirSync(path.join(source, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(source, 'skills', 'marker'), 'skill');
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'instructions');
  fs.writeFileSync(path.join(source, 'auth.json'), 'do not copy');
  fs.writeFileSync(path.join(source, 'config.toml'), `model_provider="paid"\n[mcp_servers.local]\ncommand='C:\\tools\\mcp.exe'\nargs=['a']\n[mcp_servers.disabled]\ncommand="disabled"\nenabled=false\n[mcp_servers.codex_team]\ncommand="recursive"\n[[skills.config]]\npath="disabled-skill"\nenabled=false\n`);
  const names = writeAgentConfig(runtime, source, { model_provider: 'team_free', mcp_servers: { team_bus: { command: 'node' } } });
  const config = parse(fs.readFileSync(path.join(runtime, 'config.toml'), 'utf8'));
  assert.deepEqual(names, ['local']);
  assert.equal(config.model_provider, 'team_free');
  assert.equal(config.mcp_servers.local.command, 'C:\\tools\\mcp.exe');
  assert.equal(config.mcp_servers.disabled.enabled, false);
  assert.equal(config.mcp_servers.codex_team, undefined);
  assert.equal(config.skills.config[0].enabled, false);
  assert.equal(fs.readFileSync(path.join(runtime, 'skills', 'marker'), 'utf8'), 'skill');
  assert.equal(fs.readFileSync(path.join(runtime, 'AGENTS.md'), 'utf8'), 'instructions');
  assert.equal(fs.existsSync(path.join(runtime, 'auth.json')), false);
});

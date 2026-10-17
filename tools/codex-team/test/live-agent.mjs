// Explicit opt-in live check. Only creates its own temporary files/processes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-agent-live-'));
const bridge = process.env.CODEX_TEAM_TEST_BRIDGE || fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const executable = process.env.CODEX_TEAM_TEST_EXECUTABLE || process.execPath;
const child = spawn(executable, [bridge], {
  env: { ...process.env, CODEX_TEAM_HOME: home, ...(process.env.CODEX_TEAM_TEST_EXECUTABLE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
const pending = new Map(); let seq = 0;
let stderr = '';
child.stderr.on('data', c => { stderr += c; });
child.on('exit', code => {
  for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error(`Bridge exited ${code}: ${stderr}`)); pending.delete(id); }
});
readline.createInterface({ input: child.stdout }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const entry = pending.get(msg.id);
  if (entry) { pending.delete(msg.id); clearTimeout(entry.timer); entry.resolve(msg); }
});
function request(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')); }, 60000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args) {
  const msg = await request('tools/call', { name, arguments: args });
  if (msg.error || msg.result.isError) throw new Error(JSON.stringify(msg.error || msg.result));
  return JSON.parse(msg.result.content[0].text);
}
const results = { home, workers: {} };
function save() { fs.writeFileSync(path.join(home, 'acceptance.json'), JSON.stringify(results, null, 2)); }
async function finish(name) {
  const deadline = Date.now() + 8 * 60000;
  while (Date.now() < deadline) {
    const ev = await call('team_wait', { names: [name], timeout_sec: 45, max_chars: 1000 });
    for (const e of ev.events || []) {
      process.stdout.write(`${name}: ${e.type} ${e.name || ''}\n`);
      if (e.type === 'worker_request') throw new Error(`Needs native client response: ${e.method}`);
    }
    const worker = ev.workers.find(w => w.name === name);
    if (worker && ['completed', 'failed', 'error', 'interrupted'].includes(worker.status)) return worker;
  }
  throw new Error('Live turn timed out');
}
try {
  process.stdout.write(`Acceptance directory: ${home}\n`);
  await request('initialize', { protocolVersion: '2024-11-05' });
  for (const model of (process.env.CODEX_TEAM_TEST_MODELS || 'glm,kimi').split(',')) {
    const cwd = path.join(home, model); fs.mkdirSync(cwd);
    const token = randomUUID();
    fs.writeFileSync(path.join(cwd, 'input.txt'), token);
    fs.writeFileSync(path.join(cwd, 'answer.js'), 'module.exports = () => "broken";\n');
    fs.writeFileSync(path.join(cwd, 'verify.cjs'), 'const fs=require("fs"),assert=require("assert"); assert.equal(require("./answer.js")(),fs.readFileSync("input.txt","utf8").trim()); fs.writeFileSync("test-passed.txt","PASS");\n');
    const start = await call('team_start', { name: model, model, cwd, task:
      'This is an authorized isolated agent acceptance test. Use actual tools, not just descriptions. Read input.txt; use the apply_patch tool to repair answer.js (do not substitute shell writes for this first repair) so its function returns the EXACT token you read as a literal string. Run node verify.cjs and fix until PASS. Read ' + path.join(os.homedir(), '.agents', 'skills', 'codebase-memory', 'SKILL.md').split(path.sep).join('/') + ' and follow it to call the configured codebase-memory MCP get_architecture for project coterm path tools/codex-team, format json, aspects structure. Use report_to_lead with the exact input token and brief outcomes. Remember the token in this conversation for a later follow-up. Do not change files outside this test directory, start services or delegate. If a tool is unavailable report the actual error. Finish the turn after these checks.' });
    results.inheritedTools = start.inheritedTools;
    const first = await finish(model);
    const fixed = fs.readFileSync(path.join(cwd, 'answer.js'), 'utf8');
    results.workers[model] = { access: first.access, status: first.status, output: first.output, readEdit: fixed.includes(token), commandTest: fs.existsSync(path.join(cwd, 'test-passed.txt')), thread: first.thread };
    save();
    await call('team_send', { name: model, message: 'Follow-up acceptance: without reading input.txt or answer.js again, use the exact token you remembered from the previous turn to create continued.txt in your test directory. Then report_to_lead saying the follow-up completed. Finish.' });
    const second = await finish(model);
    results.workers[model].sameThread = first.thread === second.thread;
    results.workers[model].continuation = fs.existsSync(path.join(cwd, 'continued.txt')) && fs.readFileSync(path.join(cwd, 'continued.txt'), 'utf8').trim() === token;
    results.workers[model].followup = second.output;
    assert.equal(results.workers[model].readEdit, true, `${model}: file read/edit failed`);
    assert.equal(results.workers[model].commandTest, true, `${model}: command test failed`);
    assert.equal(results.workers[model].sameThread, true, `${model}: thread changed`);
    assert.equal(results.workers[model].continuation, true, `${model}: continuation failed`);
    save();
    process.stdout.write(`${model}: ${JSON.stringify(results.workers[model])}\n`);
  }
} catch (e) { results.error = e.message; results.stderr = stderr; save(); process.exitCode = 1; }
finally { child.stdin.end(); }
process.stdout.write(`Result: ${path.join(home, 'acceptance.json')}\n`);

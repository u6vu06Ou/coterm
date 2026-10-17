// Bridge integration tests against a fake codex app-server (stdio JSON-RPC).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const BRIDGE = path.join(here, '..', 'bridge.mjs');
const FAKE = path.join(here, 'fake-app-server.mjs');
const HOME = path.join(os.tmpdir(), `codex-team-test-${randomUUID()}`);

class McpClient {
  constructor() {
    this.proc = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, CODEX_TEAM_CLI: process.execPath, CODEX_TEAM_CLI_PREFIX_ARGS: JSON.stringify([FAKE]), CODEX_TEAM_HOME: HOME, CODEX_TEAM_CAPABILITIES_HOME: path.join(HOME, 'source'), CODEX_TEAM_TEST_TRACE: path.join(HOME, 'trace.jsonl') },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exitCode = undefined;
    this.proc.on('exit', (code) => { this.exitCode = code; });
    this.stderr = '';
    this.proc.stderr.on('data', (c) => { this.stderr += c; });
    this.pending = new Map();
    const rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (!msg || msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    });
    this.seq = 0;
  }
  request(method, params, timeoutMs = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout on ${method}`)); }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(tool, args) {
    const msg = await this.request('tools/call', { name: tool, arguments: args || {} });
    if (msg.error) throw new Error(`RPC error: ${msg.error.message}`);
    const payload = msg.result.content[0].text;
    return { isError: !!msg.result.isError, text: payload, json: () => JSON.parse(payload) };
  }
  closeStdin() { try { this.proc.stdin.end(); } catch { /* already gone */ } }
}

async function postDashboard(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const res = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...extraHeaders }, timeout: 10000 }, (r) => {
      let out = '';
      r.on('data', (c) => { out += c; });
      r.on('end', () => resolve({ status: r.statusCode, body: out }));
    });
    res.on('error', reject);
    res.end(data);
  });
}

async function poll(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('poll timeout');
}

const mc = new McpClient();
let state = null;

async function getAck(name) {
  const r = await mc.call('team_status', name ? { name } : {});
  assert.equal(r.isError, false);
  return r.json();
}

after(() => {
  mc.closeStdin();
  setTimeout(() => { try { if (mc.proc.exitCode === null) mc.proc.kill(); } catch { /* gone */ } }, 3000).unref?.();
});

test('initialize + tools/list', async () => {
  const init = await mc.request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  const list = await mc.request('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['team_cancel', 'team_respond', 'team_send', 'team_start', 'team_status', 'team_wait']);
});

test('team_start, completion, status bound with max_chars', async () => {
  const r = await mc.call('team_start', { name: 'glm1', model: 'glm', task: 'first task' });
  assert.equal(r.isError, false);
  state = r.json();
  assert.ok(state && state.workers && state.workers[0].name === 'glm1');
  assert.equal(state.workers[0].access, 'full-access');
  const start = fs.readFileSync(path.join(HOME, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(m => m.method === 'thread/start');
  assert.equal(start.params.sandbox, 'danger-full-access');
  assert.equal(start.params.dynamicTools[0].name, 'apply_patch');
  const done = await poll(async () => {
    const s = await getAck('glm1');
    const w = s.workers.find((w) => w.name === 'glm1');
    return w.status === 'completed' && w.output ? w : null;
  });
  assert.equal(typeof done.updatedAt, 'string');
  assert.ok(done.elapsedSec === null || typeof done.elapsedSec === 'number');
  assert.equal(done.output, 'Hello from fake worker');
  const bounded = await mc.call('team_status', { name: 'glm1', max_chars: 5 });
  assert.equal(bounded.json().workers[0].output, 'Hello from fake worker'.slice(-5));
});

test('worker interactive requests wake the lead and resume after response', async () => {
  await mc.call('team_start', { name: 'question', model: 'kimi', task: 'QUESTION', access: 'read-only' });
  const status = (await mc.call('team_status', { name: 'question' })).json();
  assert.equal(status.workers[0].access, 'read-only');
  const starts = fs.readFileSync(path.join(HOME, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(m => m.method === 'thread/start');
  assert.equal(starts.at(-1).params.dynamicTools, undefined);
  assert.equal(status.requests[0].method, 'item/tool/requestUserInput');
  const response = await mc.call('team_respond', { request_id: status.requests[0].requestId, response: { answers: { choice: { answers: ['yes'] } } } });
  assert.equal(response.isError, false);
  await poll(async () => ((await getAck('question')).workers[0].status === 'completed' ? true : null));
  assert.equal((await getAck('question')).requests.length, 0);
});

test('team_send keeps the same worker thread', async () => {
  const before = (await getAck('glm1')).workers[0].thread;
  const r = await mc.call('team_send', { name: 'glm1', message: 'follow-up' });
  assert.equal(r.isError, false);
  const after = (await getAck('glm1')).workers[0].thread;
  assert.equal(after, before);
  await poll(async () => ((await getAck('glm1')).workers[0].status === 'completed' ? true : null));
});

test('team_cancel interrupts a running turn', async () => {
  await mc.call('team_send', { name: 'glm1', message: 'second question' });
  const r = await mc.call('team_cancel', { name: 'glm1' });
  assert.equal(r.isError, false);
  await poll(async () => ((await getAck('glm1')).workers[0].status === 'interrupted' ? true : null));
});

test('dashboard rejects a bad Origin', async () => {
  const r = await postDashboard(`${state.dashboard}action`, { op: 'cancel', name: 'glm1' }, { Origin: 'http://127.0.0.1:9' });
  assert.equal(r.status, 403);
  assert.equal(r.body, 'Origin rejected');
});

test('peer guard throttles bus sends', async () => {
  const first = await postDashboard(`${state.dashboard}action`, { op: 'send', name: 'glm1', message: 'ping' }, { Origin: new URL(state.dashboard).origin, 'X-Team-Bus': '1' });
  assert.equal(first.status, 200);
  const second = await postDashboard(`${state.dashboard}action`, { op: 'send', name: 'glm1', message: 'ping' }, { Origin: new URL(state.dashboard).origin, 'X-Team-Bus': '1' });
  assert.equal(second.status, 429);
  assert.match(second.body, /60/);
});

test('unknown worker name gives a clear error', async () => {
  const r = await mc.call('team_send', { name: 'ghost', message: 'hello' });
  assert.equal(r.isError, true);
  assert.match(r.text, /找不到隊員/);
  assert.match(r.text, /glm1/);
});

test('app-server crash marks workers dead, fresh name restarts', async () => {
  // wait for any in-flight turn (e.g. the peer-guard ping) to settle first,
  // otherwise the send takes the steer path and never reaches turn/start
  await poll(async () => ((await getAck('glm1')).workers[0].status === 'completed' ? true : null), { timeoutMs: 8000 });
  try { await mc.call('team_send', { name: 'glm1', message: 'CRASH' }); } catch { /* ack race is fine */ }
  const dead = await poll(async () => {
    const w = (await getAck('glm1')).workers[0];
    return w.status === 'error' ? w : null;
  }, { timeoutMs: 8000 });
  assert.match(dead.error.message, /結束/);
  const blocked = await mc.call('team_send', { name: 'glm1', message: 'still there?' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /team_start/);
  const restart = await mc.call('team_start', { name: 'glm_fresh', model: 'glm', task: 'restart check' });
  assert.equal(restart.isError, false);
  await poll(async () => {
    const w = (await getAck('glm_fresh')).workers[0];
    return w.status === 'completed' ? w : null;
  }, { timeoutMs: 8000 });
});

test('team_wait returns when a worker turn completes', async () => {
  const r = await mc.call('team_send', { name: 'glm_fresh', message: 'wake check' });
  assert.equal(r.isError, false);
  const w = await mc.call('team_wait', { names: ['glm_fresh'], timeout_sec: 30, max_chars: 200 });
  const j = w.json();
  assert.equal(j.timedOut, false);
  assert.equal(j.event.type, 'turn_finished');
  assert.equal(j.event.name, 'glm_fresh');
  const row = j.workers.find((x) => x.name === 'glm_fresh');
  assert.equal(row.status, 'completed');
  assert.equal(row.output, 'Hello from fake worker');
});

test('team_wait returns immediately for an already-queued lead message', async () => {
  const r = await postDashboard(`${state.dashboard}action`, { op: 'send', name: 'lead', message: 'mid-task question' }, { Origin: new URL(state.dashboard).origin });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).lead, true);
  const t0 = Date.now();
  const w = await mc.call('team_wait', { timeout_sec: 30 });
  const j = w.json();
  assert.equal(j.timedOut, false);
  assert.equal(j.event.type, 'lead_message');
  assert.equal(j.event.message, 'mid-task question');
  assert.ok(Date.now() - t0 < 5000);
});

test('a lead-directed message wakes an in-flight team_wait', async () => {
  await getAck(); // drain the queue so nothing is pre-queued
  const pending = mc.call('team_wait', { timeout_sec: 30 });
  await new Promise((r) => setTimeout(r, 200));
  const r = await postDashboard(`${state.dashboard}action`, { op: 'send', name: 'lead', message: 'wake up' }, { Origin: new URL(state.dashboard).origin });
  assert.equal(r.status, 200);
  const j = (await pending).json();
  assert.equal(j.timedOut, false);
  assert.equal(j.event.type, 'lead_message');
  assert.equal(j.event.message, 'wake up');
});

test('team_wait times out with a short status-only summary', async () => {
  await getAck(); // drain
  const t0 = Date.now();
  const w = await mc.call('team_wait', { names: ['glm_fresh'], timeout_sec: 1 });
  const j = w.json();
  assert.equal(j.timedOut, true);
  assert.ok(Date.now() - t0 >= 900);
  assert.equal(j.event, null);
  assert.ok(Array.isArray(j.events) && j.events.length === 0);
  for (const row of j.workers) {
    assert.ok(!('output' in row));
    assert.ok(typeof row.name === 'string');
    assert.ok(typeof row.status === 'string');
  }
});

test('stdin close exits cleanly', async () => {
  const c = new McpClient();
  c.closeStdin();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('clean exit timeout')), 8000);
    c.proc.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  }).then((code) => {
    assert.equal(c.exitCode, 0);
    assert.equal(code, 0);
  });
});

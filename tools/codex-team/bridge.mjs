#!/usr/bin/env node
// Codex Team bridge: a paid Codex lead loads this MCP stdio server; it spawns
// `codex app-server --listen stdio://` with a free-only CODEX_HOME and keeps
// persistent named worker threads (glm/kimi/deepseek/qwen) on the local free proxy.
// Bundled TOML parser; expected to run as `<electron> bridge.mjs` with
// ELECTRON_RUN_AS_NODE=1 (plain node also works and is used by the tests).

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeAgentConfig, workerAccess } from './capabilities.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- env contract ----------
const HOME_DIR = process.env.CODEX_TEAM_HOME
  || path.join(os.homedir(), '.codex-team-free');
const PROXY_URL = (process.env.CODEX_TEAM_PROXY_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const MODELS = { glm: 'my-glm-flash', kimi: 'my-kimi', deepseek: 'my-ds', qwen: 'my-qwen' };
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const RPC_TIMEOUT_MS = 45000;
const PEER_WINDOW_MS = 10 * 60 * 1000; // rolling 10 minutes
const PEER_WINDOW_MAX = 20;            // max peer messages per window
const PEER_DUP_MS = 60 * 1000;         // same text to same worker within this is rejected
const HISTORY_MAX = 50;
const STATUS_DEFAULT_CHARS = 2000;     // team_status default tail
const STATUS_MAX_CHARS = 8000;         // team_status max tail
const POST_BODY_LIMIT = 16000;
const WAIT_DEFAULT_SEC = 1500;   // team_wait default block (25 minutes)
const WAIT_MAX_SEC = 1700;       // team_wait max block seconds

fs.mkdirSync(HOME_DIR, { recursive: true });
const LOG_PATH = path.join(HOME_DIR, 'bridge.log');
const SESSION = randomUUID().replace(/-/g, '');

function log(prefix, ...parts) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${prefix} ${parts.join(' ')}\n`);
  } catch { /* logging must never crash the bridge */ }
}
log('bridge start', `session=${SESSION} home=${HOME_DIR}`);

// ---------- codex CLI resolution ----------
const VENDOR_REL = path.join('node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
function resolveCli() {
  const fromEnv = process.env.CODEX_TEAM_CLI;
  if (fromEnv) return fromEnv;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const npmVendor = path.join(appData, 'npm', VENDOR_REL);
  try { if (fs.existsSync(npmVendor)) return npmVendor; } catch { /* keep looking */ }
  // Fallback: codex found on PATH -> vendor binary next to it.
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      const direct = path.join(dir, 'codex.exe');
      if (fs.existsSync(direct)) return direct;
      const shim = path.join(dir, 'codex.cmd');
      if (fs.existsSync(shim)) {
        const vendor = path.join(dir, VENDOR_REL);
        if (fs.existsSync(vendor)) return vendor;
      }
    } catch { /* skip this dir */ }
  }
  return null;
}

// ---------- state ----------
const RUNTIME_HOME = path.join(HOME_DIR, 'runs', SESSION);
const CAPABILITIES_HOME = process.env.CODEX_TEAM_CAPABILITIES_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
let inheritedTools = [];
const workerRequests = new Map();
fs.mkdirSync(RUNTIME_HOME, { recursive: true });
const STATE_PATH = path.join(HOME_DIR, 'teams', `${SESSION}.json`);
fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });

const workers = new Map();      // name -> worker record
const pendingRpcs = new Map();  // id -> {resolve, reject, timer}
let rpcSeq = 0;
let proc = null;                // codex app-server child
let httpServer = null;
let dashboardPort = null;
let busUrl = null;
let shuttingDown = false;
let cleaned = false;
// ---- lead long-poll (team_wait): events queue, waiters resolve; no busy loop ----
const unreadEvents = [];       // lead event queue: turn finishes + lead-directed messages
const waiters = new Set();     // active team_wait waiters

function eventMatches(ev, names) {
  if (ev.type === 'lead_message' || ev.type === 'worker_request') return true;
  if (!names || !names.length) return true;
  return names.includes(String(ev.name || '').toLowerCase());
}

function pushUnreadEvent(ev) {
  ev.at = new Date().toISOString();
  unreadEvents.push(ev);
  if (unreadEvents.length > HISTORY_MAX) unreadEvents.splice(0, unreadEvents.length - HISTORY_MAX);
  for (const waiter of [...waiters]) {
    if (eventMatches(ev, waiter.args.names)) finishWaiter(waiter, false);
  }
}

function waitSummaryRows() {
  // short status only: no output tail in the timeout response
  return [...workers.values()].map((w) => ({
    name: w.name,
    model: w.model,
    status: w.status,
    dead: !!w.dead,
    elapsedSec: w.turnStartedAt ? Math.round((Date.now() - w.turnStartedAt) / 1000) : null,
  }));
}

function waitResult(args, timedOut) {
  if (timedOut) return { timedOut: true, event: null, events: [], workers: waitSummaryRows() };
  const drained = unreadEvents.filter((e) => eventMatches(e, args.names));
  if (drained.length === unreadEvents.length) {
    unreadEvents.length = 0;
  } else if (drained.length) {
    unreadEvents.splice(0, unreadEvents.length, ...unreadEvents.filter((e) => !eventMatches(e, args.names)));
  }
  const fired = drained.length ? drained[drained.length - 1] : null;
  return {
    timedOut: false,
    event: fired ? { ...fired } : null,
    events: drained,
    workers: overview(fired && fired.type === 'turn_finished' ? fired.name : null, args.maxChars).workers,
  };
}

function finishWaiter(waiter, timedOut) {
  if (waiter.done) return;
  waiter.done = true;
  if (waiter.timer) clearTimeout(waiter.timer);
  waiters.delete(waiter);
  waiter.resolve(waitResult(waiter.args, timedOut));
}

function normalizedWaitArgs(raw = {}) {
  let names = null;
  if (Array.isArray(raw.names)) {
    names = [...new Set(raw.names.filter((n) => typeof n === 'string' && n).map((n) => n.toLowerCase()))];
    if (!names.length) names = null;
  }
  let timeoutSec = WAIT_DEFAULT_SEC;
  if (raw.timeout_sec !== undefined && raw.timeout_sec !== null) {
    const n = Number(raw.timeout_sec);
    if (Number.isFinite(n)) timeoutSec = Math.max(1, Math.min(Math.floor(n), WAIT_MAX_SEC));
  }
  let maxChars = STATUS_DEFAULT_CHARS;
  if (raw.max_chars !== undefined && raw.max_chars !== null) {
    const n = Number(raw.max_chars);
    if (Number.isFinite(n) && n > 0) maxChars = Math.min(Math.floor(n), STATUS_MAX_CHARS);
    else maxChars = 0;
  }
  return { names, timeoutSec, maxChars };
}

function waitTool(raw = {}) {
  const args = normalizedWaitArgs(raw);
  const queued = unreadEvents.find((e) => eventMatches(e, args.names));
  if (queued) return waitResult(args, false);
  return new Promise((resolve) => {
    const waiter = { args, resolve, done: false, timer: null };
    waiter.timer = setTimeout(() => finishWaiter(waiter, true), args.timeoutSec * 1000);
    if (waiter.timer.unref) waiter.timer.unref();
    waiters.add(waiter);
  });
}


function save() {
  try {
    const data = {
      session: SESSION,
      dashboard: busUrl,
      savedAt: new Date().toISOString(),
      workers: [...workers.values()].map((w) => ({ ...w })),
    };
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) { log('save failed:', e && e.message); }
}

// ---------- RPC layer to the codex app-server ----------
function sendLine(obj) {
  if (!proc || !proc.stdin || proc.stdin.destroyed) {
    throw new Error('Codex app-server 未在執行；下一個工具呼叫會自動重啟。');
  }
  proc.stdin.write(JSON.stringify(obj) + '\n');
}
function emit(method, params) { sendLine({ method, params }); }

function rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const rid = ++rpcSeq;
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      pendingRpcs.delete(rid);
      reject(new Error(`Codex RPC 逾時（45 秒）: ${method}`));
    }, timeoutMs);
    pendingRpcs.set(rid, entry);
    try { sendLine({ id: rid, method, params }); }
    catch (e) {
      clearTimeout(entry.timer);
      pendingRpcs.delete(rid);
      reject(e);
    }
  });
}

function rejectAllPending(message) {
  for (const [rid, entry] of [...pendingRpcs]) {
    clearTimeout(entry.timer);
    pendingRpcs.delete(rid);
    entry.reject(new Error(message));
  }
}

function findWorkerByThread(threadId) {
  // a dead worker's thread id is stale and a re-spawned app-server restarts
  // its id counter, so ids can collide; only live workers may claim a match
  for (const w of workers.values()) if (!w.dead && w.thread === threadId) return w;
  return null;
}

function touch(w) { w.updatedAt = new Date().toISOString(); }

function handleAppServerMessage(msg) {
  const rid = msg.id;
  if (!msg.method && rid !== undefined && pendingRpcs.has(rid)) {
    const entry = pendingRpcs.get(rid);
    pendingRpcs.delete(rid);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
    } else {
      entry.resolve(msg.result);
    }
    return;
  }
  const params = msg.params || {};
  if (msg.method === 'serverRequest/resolved') {
    workerRequests.delete(String(params.requestId));
    return;
  }
  if (rid !== undefined && msg.method) {
    if (msg.method === 'item/tool/call' && params.tool === 'apply_patch') {
      const worker = findWorkerByThread(params.threadId);
      let result;
      try {
        if (!worker || worker.access !== 'full-access') throw new Error('Direct patch is only available to full-access workers.');
        const patch = params.arguments?.patch;
        if (typeof patch !== 'string' || !patch.startsWith('*** Begin Patch\n') || !patch.trimEnd().endsWith('*** End Patch')) throw new Error('Supply a complete Codex patch string.');
        const applied = spawnSync(resolveCli(), ['--codex-run-as-apply-patch', patch], {
          cwd: worker.cwd, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024,
        });
        if (applied.error) throw applied.error;
        result = { success: applied.status === 0, contentItems: [{ type: 'inputText', text: `${applied.stdout || ''}${applied.stderr || ''}` || `Patch exit: ${applied.status}` }] };
      } catch (error) {
        result = { success: false, contentItems: [{ type: 'inputText', text: error.message }] };
      }
      sendLine({ id: rid, result });
      return;
    }
    if (msg.method === 'account/chatgptAuthTokens/refresh' || msg.method === 'attestation/generate') {
      sendLine({ id: rid, error: { code: -32601, message: 'Free workers do not use paid account credentials.' } });
      return;
    }
    const worker = findWorkerByThread(params.threadId);
    const requestId = String(rid);
    workerRequests.set(requestId, { id: rid, method: msg.method, name: worker?.name || null, params });
    pushUnreadEvent({ type: 'worker_request', requestId, name: worker?.name || null, method: msg.method, params });
    return;
  }
  const w = findWorkerByThread(params.threadId);
  if (!w) return;
  switch (msg.method) {
    case 'turn/started':
      w.turn = (params.turn && params.turn.id) || null;
      w.status = 'running';
      w.turnStartedAt = Date.now();
      touch(w);
      break;
    case 'item/agentMessage/delta':
      w.output += params.delta || '';
      touch(w);
      break;
    case 'turn/completed': {
      const turn = params.turn || {};
      for (const [id, request] of workerRequests) {
        if (request.params.threadId === w.thread && (!request.params.turnId || request.params.turnId === turn.id)) workerRequests.delete(id);
      }
      w.status = turn.status || 'done';
      w.error = turn.error !== undefined ? turn.error : null;
      w.turn = null;
      w.turnStartedAt = null;
      if (w.output && w.output.trim()) {
        // Keep the assistant reply in the worker history (only user turns were kept before).
        w.history.push({ role: 'assistant', text: w.output });
        if (w.history.length > HISTORY_MAX) w.history = w.history.slice(-HISTORY_MAX);
      }
      pushUnreadEvent({ type: 'turn_finished', name: w.name, status: w.status, error: w.error ? (w.error.message || JSON.stringify(w.error)) : null });
      touch(w);
      break;
    }
    default:
      return;
  }
  save();
}

// If the app-server process exits or crashes: fail everything pending, mark
// every worker dead (its thread cannot be reused), clear proc so the next
// tool call re-spawns and re-initializes.
function handleProcFailure(reason) {
  workerRequests.clear();
  if (shuttingDown) return;
  if (proc === null && pendingRpcs.size === 0) return; // already handled
  log('app-server failure:', reason);
  proc = null;
  const workerMessage =
    `Codex app-server 工作程序已結束（${reason}）。thread 無法重用，請 team_start 一個新的隊員名稱。`;
  for (const w of workers.values()) {
    w.status = 'error';
    w.error = { message: workerMessage };
    w.dead = true;
    w.turn = null;
    w.turnStartedAt = null;
    w.thread = null; // thread belonged to the dead process; never reuse or shadow
    touch(w);
    pushUnreadEvent({ type: 'turn_finished', name: w.name, status: 'error', error: workerMessage });
  }
  rejectAllPending(`Codex app-server 已結束（${reason}）`);
  save();
}

function startEventReader() {
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // ignore non-JSON frames
    handleAppServerMessage(msg);
  });
  const stderrLines = readline.createInterface({ input: proc.stderr, crlfDelay: Infinity });
  stderrLines.on('line', (line) => log('app-server stderr:', line));
}

// ensureHost is serialized through a promise chain: concurrent tool calls must
// never double-spawn the app-server, and a failed ensure must not poison later calls.
let hostChain = Promise.resolve();
function ensureHost() {
  const run = hostChain.then(() => (proc ? undefined : doEnsureHost()));
  hostChain = run.catch(() => {});
  return run;
}

// One dashboard per bridge session; listen(0) picks a free loopback port.
function startDashboard() {
  return new Promise((resolve, reject) => {
    httpServer = http.createServer(dashboardHandler);
    httpServer.on('error', (e) => { httpServer = null; reject(e); });
    httpServer.listen(0, '127.0.0.1', () => {
      dashboardPort = httpServer.address().port;
      busUrl = `http://127.0.0.1:${dashboardPort}/${SESSION}/`;
      resolve();
    });
  });
}

async function doEnsureHost() {
  if (!httpServer) await startDashboard();
  writeRuntimeConfig();
  spawnCodex();
  try {
    await rpc('initialize', {
      clientInfo: { name: 'codex_team_free_bridge', version: '1.0' },
      capabilities: { experimentalApi: true },
    });
  } catch (e) {
    killAppServerTree();
    throw e;
  }
  emit('initialized', {});
}
function writeRuntimeConfig() {
  const nodePath = process.execPath.replace(/\\/g, '/');
  const busPath = path.join(__dirname, 'team_bus.mjs').replace(/\\/g, '/');
  inheritedTools = writeAgentConfig(RUNTIME_HOME, CAPABILITIES_HOME, {
    model: MODELS.glm, model_provider: 'team_free', approval_policy: 'never',
    sandbox_mode: 'danger-full-access', agents: { enabled: false },
    model_providers: { team_free: {
      name: 'Friend server free models via local proxy', base_url: `${PROXY_URL}/v1`,
      wire_api: 'responses', experimental_bearer_token: 'free-backend', requires_openai_auth: false,
    } },
    mcp_servers: { team_bus: {
      command: nodePath, args: [busPath, busUrl], env: { ELECTRON_RUN_AS_NODE: '1' },
      default_tools_approval_mode: 'auto',
    } },
  });
}

function spawnCodex() {
  const cliPath = resolveCli();
  if (!cliPath) {
    throw new Error(
      '找不到 Codex CLI：請先 `npm i -g @openai/codex` 安裝（或檢查 vendor 路徑），或設定環境變數 CODEX_TEAM_CLI 指向 codex.exe 的完整路徑。'
    );
  }
  let prefixArgs = [];
  const rawPrefix = process.env.CODEX_TEAM_CLI_PREFIX_ARGS;
  if (rawPrefix) {
    try {
      const parsed = JSON.parse(rawPrefix);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      prefixArgs = parsed.map(String);
    } catch {
      throw new Error('CODEX_TEAM_CLI_PREFIX_ARGS 需為 JSON 陣列，例如 ["--flag"]。');
    }
  }
  const env = { ...process.env };
  // Strip the host app's credentials and node mode; give codex a clean free-only home.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CHATGPT_ACCESS_TOKEN']) {
    delete env[key];
  }
  env.CODEX_HOME = RUNTIME_HOME;
  fs.mkdirSync(RUNTIME_HOME, { recursive: true });
  proc = spawn(cliPath, [...prefixArgs, 'app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    windowsHide: true, // never open a console window
  });
  startEventReader();
  proc.on('exit', (code, signal) =>
    handleProcFailure(`exit code ${code}${signal ? ` signal ${signal}` : ''}`));
  proc.on('error', (e) => handleProcFailure(e && e.message ? e.message : String(e)));
}

function killAppServerTree() {
  if (!proc || !proc.pid) return;
  try {
    // Windows has no tree kill signal; taskkill /T /F takes the whole tree down.
    spawnSync('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { windowsHide: true });
  } catch (e) { log('taskkill failed:', e && e.message); }
  proc = null;
}
// ---- peer-message loop guard (only applies to team_bus peer traffic) ----
const peerTimes = [];        // rolling timestamps of accepted peer messages
const peerLast = new Map();  // 'name\nmessage' -> ts, for the 60s duplicate rule

function checkPeerGuard(name, text) {
  const now = Date.now();
  while (peerTimes.length && now - peerTimes[0] > PEER_WINDOW_MS) peerTimes.shift();
  const key = `${name}\n${text}`;
  const last = peerLast.get(key);
  if (last !== undefined && now - last < PEER_DUP_MS) {
    const e = new Error(
      `同一則訊息 60 秒內已轉送給 "${name}"；請等一下再送，或先用 team_status 查看進度。`
    );
    e.status = 429;
    throw e;
  }
  if (peerTimes.length >= PEER_WINDOW_MAX) {
    const e = new Error(
      `10 分鐘內已轉送 ${PEER_WINDOW_MAX} 則隊員互傳訊息；為避免兩位隊員互動形成迴圈，請先用 team_status 查看狀態。`
    );
    e.status = 429;
    throw e;
  }
}

function recordPeer(name, text) {
  const now = Date.now();
  peerTimes.push(now);
  peerLast.set(`${name}\n${text}`, now);
}

// ---- reads and responses ----
function tail(text, max) {
  if (max == null) return text;
  if (!Number.isFinite(max) || max <= 0) return '';
  return text.length > max ? text.slice(-max) : text;
}

function overview(name = null, maxChars = null) {
  const rows = [...workers.values()]
    .filter((w) => !name || w.name === name)
    .map((w) => ({
      name: w.name,
      model: w.model,
      thread: w.thread,
      access: w.access,
      status: w.status,
      output: tail(w.output, maxChars),
      error: w.error ?? null,
      dead: !!w.dead,
      updatedAt: w.updatedAt,
      elapsedSec: w.turnStartedAt ? Math.round((Date.now() - w.turnStartedAt) / 1000) : null,
      historyCount: w.history.length,
    }));
  return { session: SESSION, dashboard: busUrl, inheritedTools, requests: [...workerRequests.entries()].map(([requestId, request]) => ({ requestId, ...request })), workers: rows };
}

function ack(name) { return overview(name, 0); }

function unknownWorkerError(name) {
  const names = [...workers.keys()];
  return new Error(
    names.length
      ? `找不到隊員 "${name}"。現有隊員：${names.join(', ')}。`
      : `找不到隊員 "${name}"。目前沒有任何隊員；請先用 team_start。`
  );
}
const workerInstructions = (name) =>
  `Your teammate name is "${name}". Start every report_to_lead or team_message text with "[${name}] ". ` +
  'You are a persistent coding agent with shell, file editing, tests, skills and configured MCP tools. Complete assigned work autonomously and verify it. Follow revisions and project AGENTS.md. ' +
  'Reply in concise Traditional Chinese. Do not delegate or modify services or credentials. ' +
  'Writing requires explicitly assigned implementation work. Never launch background services.';

async function sendMessage(name, message) {
  await ensureHost();
  const w = workers.get(name);
  if (!w) throw unknownWorkerError(name);
  if (w.dead) {
    throw new Error(`隊員 "${name}" 的工作程序已結束，thread 無法重用；請 team_start 一個新的隊員名稱。`);
  }
  const hadTurn = !!w.turn;
  w.history.push({ role: 'user', text: message });
  if (w.history.length > HISTORY_MAX) w.history = w.history.slice(-HISTORY_MAX);
  if (hadTurn) {
    // Steer the running turn; the thread keeps buffering everything after it.
    await rpc('turn/steer', { threadId: w.thread, expectedTurnId: w.turn, input: [{ type: 'text', text: message }] });
  } else {
    w.output = '';
    w.error = null;
    w.status = 'starting';
    w.turnStartedAt = null;
    const result = await rpc('turn/start', { threadId: w.thread, input: [{ type: 'text', text: message }] });
    // The turn/started event may land before or after this RPC resolves; fill only when not set yet.
    if (w.status === 'starting') {
      w.turn = (result && result.turn && result.turn.id) || null;
      w.status = 'running';
      w.turnStartedAt = Date.now();
    }
  }
  touch(w);
  save();
  return { ...ack(name) };
}

async function startWorker(name, model, task, cwd = null, access = 'full-access') {
  if (!NAME_RE.test(name)) {
    throw new Error(`隊員名稱 "${name}" 無效：需 1-32 個字元的英數、底線或連字號（開頭為英數）。`);
  }
  await ensureHost();
  if (!MODELS[model]) {
    throw new Error(`不認識的模型 "${model}"。可用：${Object.keys(MODELS).join(', ')}。`);
  }
  if (workers.has(name)) {
    throw new Error(`名稱 "${name}" 已存在；追問請用 team_send。`);
  }
  const result = await rpc('thread/start', {
    model: MODELS[model],
    modelProvider: 'team_free',
    cwd: cwd || process.cwd(),
    approvalPolicy: 'never',
    sandbox: access === 'full-access' ? 'danger-full-access' : access,
    ...(access === 'full-access' ? { dynamicTools: [{
      name: 'apply_patch',
      description: 'Edit files directly with the native Codex patch engine, without shell quoting. Supply a patch string starting *** Begin Patch and ending *** End Patch, with *** Add File:, *** Update File:, or *** Delete File: sections. Update hunks use @@ and space/+/− line prefixes (use ASCII minus). Paths resolve from your working directory. Use this tool instead of invoking apply_patch through a shell. Honor task scope; destructive work requires authorization.',
      inputSchema: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'], additionalProperties: false },
    }] } : {}),
    developerInstructions: workerInstructions(name),
  });
  workers.set(name, {
    name,
    model,
    access,
    cwd: path.resolve(cwd || process.cwd()),
    thread: (result && result.thread && result.thread.id) || null,
    status: 'idle',
    turn: null,
    output: '',
    error: null,
    dead: false,
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turnStartedAt: null,
  });
  save();
  return sendMessage(name, task);
}

async function cancelWorker(name) {
  await ensureHost();
  const w = workers.get(name);
  if (!w) throw unknownWorkerError(name);
  if (w.dead) {
    throw new Error(`隊員 "${name}" 的工作程序已結束；請 team_start 一個新的隊員名稱。`);
  }
  if (w.turn) {
    await rpc('turn/interrupt', { threadId: w.thread, turnId: w.turn });
  }
  touch(w);
  save();
  return { ...ack(name) };
}

function statusTool(args = {}) {
  const name = typeof args.name === 'string' && args.name ? args.name : null;
  let maxChars = STATUS_DEFAULT_CHARS;
  if (args.max_chars !== undefined && args.max_chars !== null) {
    const n = Number(args.max_chars);
    if (Number.isFinite(n) && n > 0) maxChars = Math.min(Math.floor(n), STATUS_MAX_CHARS);
    else maxChars = 0;
  }
  if (name && !workers.has(name)) throw unknownWorkerError(name);
  // Reading status counts as the lead's read; consume queued events so the
  // next team_wait does not replay what the lead has already seen.
  unreadEvents.length = 0;
  return overview(name, maxChars);
}
// ---- dashboard ----
function dashboardHandler(req, res) {
  const expectedHost = `127.0.0.1:${dashboardPort}`;
  const expectedOrigin = `http://127.0.0.1:${dashboardPort}`;
  if ((req.headers.host || '') !== expectedHost) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Host rejected');
    return;
  }
  const url = new URL(req.url || '/', expectedOrigin);
  if (req.method === 'GET' && url.pathname === `/${SESSION}/`) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DASHBOARD_HTML);
    return;
  }
  if (req.method === 'GET' && url.pathname === `/${SESSION}/state`) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(overview(null, null)));
    return;
  }
  if (req.method === 'POST' && url.pathname === `/${SESSION}/action`) {
    if ((req.headers.origin || '') !== expectedOrigin) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Origin rejected');
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > POST_BODY_LIMIT) req.destroy();
    });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { payload = null; }
      if (!payload || typeof payload !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      const op = payload.op;
      const name = typeof payload.name === 'string' ? payload.name : '';
      const text = typeof payload.message === 'string' ? payload.message : '';
      const fromBus = req.headers['x-team-bus'] === '1';
      Promise.resolve()
        .then(async () => {
          if (op === 'send') {
            if (!name) throw new Error('缺少 name');
            if (fromBus) checkPeerGuard(name, text);
            if (name.toLowerCase() === 'lead') {
              // 'lead' is reserved: the message queues a lead_message event and
              // wakes any team_wait long-poll; the loop guard above still applies.
              pushUnreadEvent({ type: 'lead_message', message: text });
              if (fromBus) recordPeer(name, text);
              return { lead: true, queued: true };
            }
            const out = await sendMessage(name, text);
            if (fromBus) recordPeer(name, text);
            return out;
          }
          if (op === 'cancel') return cancelWorker(name);
          throw new Error('Unknown action');
        })
        .then((out) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(out));
        })
        .catch((e) => {
          res.writeHead((e && e.status) || 400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
        });
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}
const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<title>Codex Team</title>
<style>
body { background:#101522; color:#cdd3e0; font-family: ui-monospace, Consolas, monospace; margin: 16px; }
h1 { font-size: 18px; color:#e8ecf4; }
h2 { font-size: 15px; color:#9fb3ff; margin: 0 0 4px 0; }
section { border: 1px solid #26314a; border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; }
pre { white-space: pre-wrap; word-break: break-word; background:#0b0f1a; padding: 8px; border-radius: 6px; max-height: 260px; overflow: auto; font-size: 12px; }
textarea { width: 100%; min-height: 52px; background:#0b0f1a; color:#cdd3e0; border: 1px solid #26314a; border-radius: 6px; font: inherit; box-sizing: border-box; }
button { background:#1d2a45; color:#e8ecf4; border: 1px solid #33456b; border-radius: 6px; padding: 4px 12px; margin-top: 6px; cursor: pointer; }
.meta { color:#6b7891; font-size: 12px; }
</style></head><body>
<h1>Codex Team</h1><p class="meta">主 agent 在 Coterm（付費 Codex 領隊 session）；此看板僅留本機。</p>
<div id="board"></div>
<script>
async function refresh() {
  try {
    const r = await fetch('state');
    const data = await r.json();
    const board = document.getElementById('board');
    board.innerHTML = '';
    for (const w of data.workers) {
      const sec = document.createElement('section');
      const statusLine = w.status + (w.elapsedSec != null ? (' · ' + w.elapsedSec + 's') : '');
      sec.innerHTML = '<h2>' + w.name + ' <span class="meta">(' + w.model + ' · ' + statusLine + ')</span></h2>' +
        '<p class="meta">' + (w.error ? ('error: ' + (w.error.message || JSON.stringify(w.error))) : (w.thread || 'no thread')) + '</p>' +
        '<pre></pre>' +
        '<textarea placeholder="訊息..."></textarea>' +
        '<button data-op="send">送出</button> <button data-op="cancel">取消輪次</button>';
      sec.querySelector('pre').textContent = w.output || '';
      sec.querySelector('button[data-op=send]').onclick = async () => {
        const t = sec.querySelector('textarea').value;
        if (!t) return;
        await fetch('action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'send', name: w.name, message: t }) });
        sec.querySelector('textarea').value = '';
        refresh();
      };
      sec.querySelector('button[data-op=cancel]').onclick = async () => {
        await fetch('action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'cancel', name: w.name }) });
        refresh();
      };
      board.appendChild(sec);
    }
  } catch (e) { /* refresh failures are non-fatal; next tick retries */ }
  setTimeout(refresh, 1500);
}
refresh();
</script></body></html>`;
// ---- MCP tool surface ----
const TOOLS = [
  {
    name: 'team_respond',
    description: 'Respond to a worker_request returned by team_wait or team_status.requests. Supply the native response object: user input {answers:{question_id:{answers:[text]}}}; MCP elicitation {action:"accept"|"decline"|"cancel",content:object|null,_meta:null}; approval {decision:"accept"|"decline"|"cancel"}. Honor user authorization; never approve out-of-scope actions.',
    inputSchema: { type: 'object', properties: {
      request_id: { type: 'string' }, response: { type: 'object', additionalProperties: true },
    }, required: ['request_id', 'response'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  },
  {
    name: 'team_start',
    description: 'Start a persistent free coding agent with shell, edits, tests, skills and inherited MCP tools. Default full-access matches the normal local agent. Honor task scope. For restricted tasks select access read-only or workspace-write. Reuse via team_send.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker name: 1-32 chars, letters/digits/underscore/dash, starting with a letter or digit.' },
        model: { type: 'string', enum: Object.keys(MODELS), description: 'Model key for the worker.' },
        task: { type: 'string', description: 'First task message for the worker.' },
        cwd: { type: 'string', description: 'Optional working directory for the worker.' },
        access: { type: 'string', enum: ['full-access', 'workspace-write', 'read-only'], default: 'full-access', description: 'Normal local agent access by default. Restricted modes never silently escalate.' },
        workspace_write: { type: 'boolean', description: 'Legacy true = workspace-write, false = read-only. Omit for normal access; do not combine with access.' },
      },
      required: ['name', 'model', 'task'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  },
  {
    name: 'team_send',
    description: 'Send a message to an existing named teammate: steers their running turn or continues their preserved thread. Keep the same named worker for follow-ups.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Existing teammate name.' },
        message: { type: 'string', description: 'Message or follow-up task.' },
      },
      required: ['name', 'message'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  },
  {
    name: 'team_status',
    description: 'Read worker status. Pass a specific name and a small max_chars to read one bounded output tail; omit name for an overview of all workers.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional single worker name; omit for all workers.' },
        max_chars: { type: 'integer', default: 2000, description: 'Max output chars per worker (tail). Max 8000.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'team_wait',
    description: 'Block until a teammate finishes a turn (completed, interrupted or failed) or a teammate reports to the lead, then return the fired event plus that teammate status and a bounded output tail. Call this once after dispatching instead of polling team_status; act on what it reports, then call again while workers still run. Returns immediately when a matching event is already queued.',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Optional teammate names to watch; omit to watch all teammates.' },
        timeout_sec: { type: 'integer', default: 1500, description: 'Seconds to block before timing out. Max 1700, min 1.' },
        max_chars: { type: 'integer', default: 2000, description: 'Max output chars in the returned teammate tail. Max 8000.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  },
  {
    name: 'team_cancel',
    description: 'Interrupt the chosen worker\'s running turn. Other workers continue.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Teammate whose turn to interrupt.' },
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  },
];

async function dispatch(msg) {
  const method = msg.method;
  const params = msg.params || {};
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'codex-team', version: '1.0' },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'ping':
      return {};
    case 'tools/call': {
      const toolName = params.name;
      const args = params.arguments || {};
      try {
        let result;
        if (toolName === 'team_start') {
          result = await startWorker(args.name, args.model, args.task, args.cwd || null, workerAccess(args));
        } else if (toolName === 'team_send') {
          result = await sendMessage(args.name, args.message);
        } else if (toolName === 'team_status') {
          result = statusTool(args);
        } else if (toolName === 'team_cancel') {
          result = await cancelWorker(args.name);
        } else if (toolName === 'team_wait') {
          result = await waitTool(args);
        } else if (toolName === 'team_respond') {
          const request = workerRequests.get(String(args.request_id));
          if (!request) throw new Error('Request expired or unknown; inspect team_status.requests.');
          if (!args.response || typeof args.response !== 'object' || Array.isArray(args.response)) throw new Error('response must be an object');
          sendLine({ id: request.id, result: args.response });
          workerRequests.delete(String(args.request_id));
          result = { answered: true, request_id: String(args.request_id) };
        } else {
          throw new Error(`Unknown tool: ${toolName}`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e && e.message ? e.message : String(e) }] };
      }
    }
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// ---- stdio main loop ----
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return; // notifications ignored
  chain = chain
    .then(() => dispatch(msg))
    .then((result) => reply({ jsonrpc: '2.0', id: msg.id, result }))
    .catch((e) => reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e && e.message ? e.message : String(e) } }));
});
rl.on('close', () => {
  log('stdin closed; shutting down');
  if (!shuttingDown) shutdown(0);
});

function reply(payload) {
  try { process.stdout.write(JSON.stringify(payload) + '\n'); } catch { /* client gone */ }
}

function cleanupSync() {
  if (cleaned) return;
  cleaned = true;
  for (const waiter of waiters) { if (waiter.timer) clearTimeout(waiter.timer); waiter.done = true; }
  waiters.clear();
  try {
    if (httpServer) {
      try { if (httpServer.closeAllConnections) httpServer.closeAllConnections(); } catch { /* older node */ }
      httpServer.close();
    }
  } catch { /* keep going */ }
  killAppServerTree();
  save();
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanupSync();
  process.exit(code);
}

process.on('exit', () => cleanupSync());
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (e) => {
  log('uncaughtException:', (e && e.stack) || e);
  shutdown(1);
});
process.on('unhandledRejection', (e) => {
  log('unhandledRejection:', (e && (e.stack || e.message)) || e);
});

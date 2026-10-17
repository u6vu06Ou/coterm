// Fake `codex app-server` for tests: minimal JSON-RPC over stdio.
import fs from 'node:fs';
let seq = 0;
let question = null;
const activeTurns = new Map();

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function emit(method, params) {
  reply({ method, params });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) onLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (process.env.CODEX_TEAM_TEST_TRACE) fs.appendFileSync(process.env.CODEX_TEAM_TEST_TRACE, line + '\n');
  const { id, method, params = {} } = msg;
  if (question && id === question.id && !method) {
    emit('turn/completed', { threadId: question.threadId, turn: { id: question.turnId, status: 'completed', error: null } });
    question = null;
    return;
  }
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    reply({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'thread/start') {
    reply({ jsonrpc: '2.0', id, result: { thread: { id: `thr_${++seq}` } } });
  } else if (method === 'turn/start') {
    const threadId = params.threadId;
    const text = params.input?.[0]?.text || '';
    const turnId = `t_${++seq}`;
    reply({ jsonrpc: '2.0', id, result: { turn: { id: turnId } } });
    emit('turn/started', { threadId, turn: { id: turnId } });
    emit('item/agentMessage/delta', { threadId, delta: 'Hello from ' });
    emit('item/agentMessage/delta', { threadId, delta: 'fake worker' });
    if (text === 'CRASH') {
      process.exit(1); // no completion scheduled
    }
    activeTurns.set(threadId, turnId);
    if (text === 'QUESTION') {
      question = { id: 'question-1', threadId, turnId };
      reply({ id: question.id, method: 'item/tool/requestUserInput', params: { threadId, turnId, questions: [{ id: 'choice', header: 'Choice', question: 'Pick?', options: [] }] } });
      return;
    }
    setTimeout(() => {
      if (activeTurns.get(threadId) === turnId) {
        activeTurns.delete(threadId);
        emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null } });
      }
    }, 150);
  } else if (method === 'turn/steer') {
    reply({ jsonrpc: '2.0', id, result: {} });
  } else if (method === 'turn/interrupt') {
    reply({ jsonrpc: '2.0', id, result: {} });
    const threadId = params.threadId;
    activeTurns.delete(threadId);
    emit('turn/completed', { threadId, turn: { id: params.turnId, status: 'interrupted', error: null } });
  } else {
    reply({ jsonrpc: '2.0', id, error: { code: -32603, message: `Unknown method: ${method}` } });
  }
}

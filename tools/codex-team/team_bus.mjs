// team_bus: worker-only MCP server. Workers use it to message each other by
// name via the bridge dashboard /action endpoint. Run: team_bus.mjs <busUrl>
import http from 'node:http';
import readline from 'node:readline';

const busUrl = process.argv[2];
if (!busUrl) {
  console.error('team_bus: usage: team_bus.mjs <busUrl>');
  process.exit(1);
}

const TOOL = {
  name: 'team_message',
  description: 'Send a concise message to another named teammate: it steers their active task or opens a follow-up on their existing thread. The name "lead" is reserved for the lead; to reach them use report_to_lead. Use only when requested or necessary to coordinate; never send to yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Target teammate name.' },
      message: { type: 'string', description: 'Message for the target teammate.' },
    },
    required: ['name', 'message'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
};

const LEAD_TOOL = {
  name: 'report_to_lead',
  description: "Report to the lead: the name 'lead' is reserved, so this queues your message for the lead and wakes their team_wait immediately. Use for milestones, blockers and mid-task questions; never send to yourself.",
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message for the lead.' },
    },
    required: ['message'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
};

function reply(payload) {
  try { process.stdout.write(JSON.stringify(payload) + '\n'); } catch { /* parent gone */ }
}

function postAction(payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(busUrl);
    const body = JSON.stringify(payload);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname.replace(/\/+$/, '') + '/action', method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': target.origin, 'X-Team-Bus': '1', 'Content-Length': Buffer.byteLength(body) }, timeout: 50000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('team_bus POST timeout (50s)')));
    req.on('error', reject);
    req.end(body);
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  const params = msg.params || {};
  if (msg.method === 'initialize') {
    reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codex-team-bus', version: '1.0' } } });
  } else if (msg.method === 'tools/list') {
    reply({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL, LEAD_TOOL] } });
  } else if (msg.method === 'ping') {
    reply({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};
    if (toolName !== 'team_message' && toolName !== 'report_to_lead') {
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Unknown tool: ${toolName}` } });
      return;
    }
    const targetName = toolName === 'report_to_lead' ? 'lead' : args.name;
    const targetMessage = toolName === 'report_to_lead' ? (args.message || '') : args.message;
    postAction({ op: 'send', name: targetName, message: targetMessage, fromBus: true })
      .then((res) => {
        if (res.status >= 200 && res.status < 300) {
          reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: res.body }] } });
        } else {
          reply({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: `HTTP ${res.status}: ${res.body}` }] } });
        }
      })
      .catch((e) => reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e && e.message ? e.message : String(e) } }));
  } else {
    reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Unknown method: ${msg.method}` } });
  }
});

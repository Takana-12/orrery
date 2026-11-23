// Test fixture: a minimal stdio MCP server with one tool, `pick_color`, which asks the human a form question
// through MCP elicitation and returns what came back. No dependencies; newline-delimited JSON-RPC.
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let clientCanElicit = false;
const waiting = new Map(); // elicitation request id -> tools/call id

createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === 'initialize') {
    clientCanElicit = !!m.params?.capabilities?.elicitation;
    send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'elicit-fixture', version: '0.0.1' } } });
  } else if (m.method === 'tools/list') {
    send({
      id: m.id,
      result: { tools: [{ name: 'pick_color', description: 'Asks the user to pick a color and returns the choice.', inputSchema: { type: 'object', properties: {} } }] },
    });
  } else if (m.method === 'tools/call') {
    if (!clientCanElicit) return send({ id: m.id, result: { content: [{ type: 'text', text: 'NO_ELICITATION_CAPABILITY' }] } });
    const eid = `e-${m.id}`;
    waiting.set(eid, m.id);
    send({
      id: eid,
      method: 'elicitation/create',
      params: {
        message: 'Pick a color for the sample app',
        requestedSchema: {
          type: 'object',
          properties: {
            color: { type: 'string', title: 'Color', oneOf: [{ const: 'red', title: 'Red' }, { const: 'blue', title: 'Blue' }] },
            shade: { type: 'integer', title: 'Shade (1-9)' },
          },
          required: ['color'],
        },
      },
    });
  } else if (m.id !== undefined && waiting.has(m.id)) {
    const callId = waiting.get(m.id);
    waiting.delete(m.id);
    const r = m.result ?? {};
    send({ id: callId, result: { content: [{ type: 'text', text: `ELICIT_ACTION=${r.action} COLOR=${r.content?.color ?? '-'} SHADE=${r.content?.shade ?? '-'}` }] } });
  } else if (m.id !== undefined && m.method) {
    send({ id: m.id, error: { code: -32601, message: 'method not found' } });
  }
});

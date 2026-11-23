// Probe: which per-thread config shape makes Codex pass an environment variable to the commands it runs?
// Usage: node poc/06-codex-env-probe.mjs
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcStdio } from './lib/jsonrpc-stdio.mjs';
import { findCodex } from './lib/find-codex.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(here, 'fixtures/project-b-codex');
const variants = {
  nested: { shell_environment_policy: { set: { CR_PROBE: 'nested-ok' } } },
  dotted: { 'shell_environment_policy.set': { CR_PROBE: 'dotted-ok' } },
  dottedLeaf: { 'shell_environment_policy.set.CR_PROBE': 'leaf-ok' },
};

const rpc = new JsonRpcStdio(findCodex(), ['app-server'], { label: 'codex' });
const outputs = new Map();
const done = new Map();
rpc.onServerRequest = (msg, respond) => respond(msg.method.includes('requestApproval') ? { decision: 'accept' } : {});
rpc.onNotification = (m) => {
  const p = m.params ?? {};
  if (m.method === 'item/completed' && p.item?.type === 'commandExecution') outputs.set(p.threadId, String(p.item.aggregatedOutput ?? '').trim());
  if (m.method === 'turn/completed') done.get(p.threadId)?.();
};
await rpc.request('initialize', { clientInfo: { name: 'control_room_poc', title: 'PoC', version: '0.0.1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
rpc.notify('initialized');
for (const [name, config] of Object.entries(variants)) {
  try {
    const t = await rpc.request('thread/start', { cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write', config });
    const id = t.thread.id;
    const fin = new Promise((r) => done.set(id, r));
    await rpc.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Run exactly this shell command and nothing else: `node -e "console.log(\'PROBE=\'+process.env.CR_PROBE)"`', text_elements: [] }] });
    await Promise.race([fin, new Promise((r) => setTimeout(r, 90_000))]);
    console.log(`${name}: ${outputs.get(id) ?? '(no command output)'}`);
    await rpc.request('thread/archive', { threadId: id }).catch(() => {});
  } catch (e) {
    console.log(`${name}: ERROR ${e.message}`);
  }
}
rpc.close();
setTimeout(() => process.exit(0), 3000);

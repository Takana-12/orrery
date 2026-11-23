// PoC 05: Windows process ownership with Job Objects.
//  Part 1 (synthetic): a child spawns a detached grandchild and exits. Parent-PID tree walking loses the
//          grandchild; the job still lists it, and terminating the job removes it.
//  Part 2 (real agents): measure the process group of an idle `codex app-server`, of the same server with
//          one thread waiting on approval, and of one Claude Code session waiting on approval.
// Writes poc/logs/05-winjob-result.json.
import { spawn, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { WinJob, mb } from './lib/winjob.mjs';
import { JsonRpcStdio } from './lib/jsonrpc-stdio.mjs';
import { findCodex } from './lib/find-codex.mjs';
import { cleanChildEnv } from './lib/clean-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const summary = (s) => ({
  processCount: s.processCount,
  workingSetMB: mb(s.workingSetBytes),
  privateMB: mb(s.privateBytes),
  processes: s.processes.map((p) => `${p.image}(${p.pid}) ws=${mb(p.workingSetBytes)}MB priv=${mb(p.privateBytes)}MB`),
});
const out = { ranAt: new Date().toISOString(), node: process.version };

// ---------------------------------------------------------------- Part 1
{
  const job = new WinJob();
  // Child: start a detached, long-lived grandchild, print its pid, then exit immediately.
  const childCode = `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true });
    g.unref();
    setTimeout(() => { console.log(g.pid); process.exit(0); }, 700);
  `;
  const child = spawn(process.execPath, ['-e', childCode], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  job.assign(child.pid); // assigned before the child spawns anything (it waits 0ms, but spawn is async: see "race" note in docs)
  const grandPid = await new Promise((r) => child.stdout.once('data', (d) => r(Number(String(d).trim()))));
  await new Promise((r) => child.once('exit', r));
  await sleep(300);

  let taskkillTree = 'not run';
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'pipe' });
    taskkillTree = 'succeeded';
  } catch (e) {
    taskkillTree = `failed: ${String(e.stderr ?? e.message).trim().slice(0, 120)}`;
  }
  const before = { parentAlive: alive(child.pid), grandchildAlive: alive(grandPid), jobPids: job.pids(), accounting: job.accounting() };
  job.terminate();
  await sleep(500);
  const after = { grandchildAlive: alive(grandPid), jobPids: job.pids() };
  job.close();
  out.part1 = {
    childPid: child.pid,
    grandchildPid: grandPid,
    afterParentExit: before,
    taskkillTreeOnDeadParent: taskkillTree,
    afterTerminateJob: after,
    pass: before.grandchildAlive && before.jobPids.includes(grandPid) && !after.grandchildAlive && after.jobPids.length === 0,
  };
  console.log('Part 1:', JSON.stringify(out.part1, null, 1));
}

// ---------------------------------------------------------------- Part 2: Codex
{
  const job = new WinJob();
  const rpc = new JsonRpcStdio(findCodex(), ['app-server'], { label: 'codex' });
  job.assign(rpc.pid);
  let approval;
  const gotApproval = new Promise((r) => (approval = r));
  rpc.onServerRequest = (msg, respond) => approval({ msg, respond });
  await rpc.request('initialize', { clientInfo: { name: 'control_room_poc', title: 'PoC', version: '0.0.1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  rpc.notify('initialized');
  await sleep(4000);
  const idle = job.sample();
  const started = await rpc.request('thread/start', { cwd: resolve(here, 'fixtures/project-b-codex'), approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  await rpc.request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: 'Run exactly this shell command and nothing else: `node -e "console.log(42)"`. If declined reply DECLINED.', text_elements: [] }],
  });
  const { respond } = await gotApproval;
  await sleep(1500);
  const waiting = job.sample();
  respond({ decision: 'decline' });
  await sleep(4000);
  await rpc.request('thread/archive', { threadId: started.thread.id }).catch(() => {});
  rpc.close();
  await Promise.race([rpc.exited, sleep(4000)]);
  await sleep(500);
  const leftover = job.pids();
  job.terminate();
  job.close();
  out.codex = {
    binary: 'codex app-server (one process hosts all threads)',
    idleNoThreads: summary(idle),
    oneThreadWaitingOnApproval: summary(waiting),
    leftoverPidsAfterGracefulClose: leftover,
  };
  console.log('Codex:', JSON.stringify(out.codex, null, 1));
}

// ---------------------------------------------------------------- Part 2: Claude
{
  const job = new WinJob();
  let rootPid = null;
  let release;
  const held = new Promise((r) => (release = r));
  let sampleWaiting = null;
  let finish;
  const done = new Promise((r) => (finish = r));
  async function* input() {
    yield {
      type: 'user',
      message: { role: 'user', content: 'Run exactly this shell command with the Bash tool and nothing else: `node -e "console.log(42)"`. If denied reply DENIED.' },
      parent_tool_use_id: null,
      session_id: '',
    };
    await done;
  }
  const q = query({
    prompt: input(),
    options: {
      cwd: resolve(here, 'fixtures/project-a-claude'),
      model: 'haiku',
      env: cleanChildEnv(),
      // We spawn the official binary ourselves so we own the pid and can put it in a job at birth.
      spawnClaudeCodeProcess: (o) => {
        const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, signal: o.signal });
        rootPid = child.pid;
        job.assign(child.pid);
        return child;
      },
      canUseTool: async () => {
        await sleep(1500);
        sampleWaiting = job.sample();
        release();
        return { behavior: 'deny', message: 'Denied by PoC.' };
      },
    },
  });
  const timer = setTimeout(() => finish(), 120_000);
  for await (const m of q) {
    if (m.type === 'result') finish();
  }
  clearTimeout(timer);
  await held;
  await sleep(1500);
  const leftover = job.pids();
  job.terminate();
  job.close();
  out.claude = {
    binary: 'Claude Code (one process per live session, spawned via Agent SDK custom spawn)',
    rootPid,
    oneSessionWaitingOnApproval: sampleWaiting ? summary(sampleWaiting) : null,
    leftoverPidsAfterSessionEnd: leftover,
  };
  console.log('Claude:', JSON.stringify(out.claude, null, 1));
}

out.notes = [
  'workingSet = physical RAM currently mapped per process, summed (shared pages counted in each process, so the sum overstates).',
  'private = committed private bytes (PrivateUsage); this is commit charge, not physical RAM.',
  'Scope = every live process in the session job at the sample instant (root + descendants).',
];
writeFileSync(resolve(here, 'logs/05-winjob-result.json'), JSON.stringify(out, null, 2));
console.log('\nwritten: poc/logs/05-winjob-result.json');

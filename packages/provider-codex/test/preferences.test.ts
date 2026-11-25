import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../src/index.ts';
import type { JsonRpcStdio, RpcMessage } from '../src/jsonrpc.ts';

test('Codex preference adapter routes helper events and denies tool requests without creating work', async () => {
  const adapter = new CodexAdapter(new Proxy({}, { get: () => () => assert.fail('preference helpers must not report a work session') }) as never);
  const internals = adapter as unknown as {
    starting: Promise<JsonRpcStdio>;
    onNotification(msg: RpcMessage): void;
    onServerRequest(msg: RpcMessage, respond: (r: unknown) => void, respondError: (code: number, text: string) => void): void;
  };
  const choices: { model: string; effort: string }[] = [];
  let model = '';
  const rpc = { request: async (method: string, params: any) => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') { model = params.model; return { thread: { id: 'preferences' } }; }
    if (method === 'turn/start') {
      choices.push({ model, effort: params.effort });
      let denied = false;
      internals.onServerRequest({ id: 'tool', method: 'item/tool/requestUserInput', params: { threadId: 'preferences' } }, () => assert.fail('must refuse tools'), (code) => { assert.equal(code, -32601); denied = true; });
      assert.equal(denied, true);
      internals.onNotification({ method: 'item/completed', params: { threadId: 'preferences', item: { type: 'agentMessage', text: JSON.stringify({ reply: '記録しました', add: [{ domain: 'writing', text: '短く書く', scope: 'all' }] }) } } });
      internals.onNotification({ method: 'turn/completed', params: { threadId: 'preferences', turn: { status: 'completed' } } });
      return { turn: { id: 'turn' } };
    }
    return {};
  } };
  internals.starting = Promise.resolve(rpc as unknown as JsonRpcStdio);
  const domains = [{ id: 'writing', name: '文章', description: '文章の書き方' }];
  const choice = { model: 'codex-test', effort: 'high' };
  const captured = await adapter.extractPreferences({ human: '説明は短く', agentBefore: '', domains, entries: [], otherDomainId: 'other', canAddDomain: false }, choice);
  const tuned = await adapter.tunePreferences({ message: '説明は短く', history: [], domains, entries: [], projects: [], otherDomainId: 'other', domainsLeft: 0 }, choice);
  assert.equal(captured?.add[0]?.text, '短く書く');
  assert.equal(tuned?.reply, '記録しました');
  assert.deepEqual(choices, [choice, choice]);
  assert.equal(adapter.isLive('preferences'), false);
});

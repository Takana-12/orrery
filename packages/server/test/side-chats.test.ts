// Side chats: a conversation beside the work. Never work: nothing of it reaches the core (lists, inbox), it never
// asks the human, switching AI keeps the conversation, and closing it leaves nothing behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlCore, MemoryEventStore } from '#core';
import type { StartSessionRequest } from '#core';
import { SqliteStore } from '../src/infrastructure/sqlite-store.ts';
import type { Runtime } from '../src/application/runtime.ts';
import { Journal } from '../src/application/journal.ts';
import { SideChats, isChatId } from '../src/application/side-chats.ts';

const tick = () => new Promise((r) => setTimeout(r, 10));

function setup() {
  const core = new ControlCore({ store: new MemoryEventStore() } as never);
  core.start();
  const store = new SqliteStore(':memory:');
  const started: (StartSessionRequest & { provider: string })[] = [];
  const sent: string[] = [];
  const live = new Set<string>();
  let chats!: SideChats;
  // Fake agents: they answer every message with "re: <message>" through the same callbacks the real adapters use.
  const fake = (provider: 'claude' | 'codex') => ({
    provider,
    isLive: (id: string) => live.has(`${provider}:${id}`),
    startSession: async (req: StartSessionRequest) => {
      started.push({ ...req, provider });
      await new Promise((r) => setTimeout(r, 1)); // the agent answers later, as a real one does
      live.add(`${provider}:${req.sessionId}`);
      chats.update(req.sessionId, { providerSessionId: `${provider}-conv`, model: req.model ?? 'x' });
      chats.transcript(req.sessionId, 'user', req.shownPrompt ?? req.prompt);
      chats.update(req.sessionId, { lifecycle: 'running' });
      chats.transcript(req.sessionId, 'assistant', `re: ${req.shownPrompt ?? req.prompt}`);
      chats.update(req.sessionId, { lifecycle: 'turn_finished' });
    },
    sendMessage: async (id: string, text: string) => {
      sent.push(text);
      chats.transcript(id, 'user', text);
      chats.transcript(id, 'assistant', `re: ${text}`);
      chats.update(id, { lifecycle: 'turn_finished' });
    },
    stop: async (id: string) => void live.delete(`${provider}:${id}`),
    interrupt: async () => {},
  });
  const rt = { core, store, closing: false, notify: () => {}, adapters: { claude: fake('claude'), codex: fake('codex') } } as unknown as Runtime;
  const journal = new Journal(rt, (x) => x);
  chats = new SideChats(rt, journal, (x) => x, { cwd: 'C:\\chat', attachments: 'C:\\att' });
  const words = (id: string) => store.readTranscript(id, 100).map((e) => `${e.role}: ${e.text}`);
  return { rt, core, store, chats, started, sent, words };
}

test('a side chat talks to its AI with no workspace, and nothing of it reaches the work', async () => {
  const t = setup();
  const id = t.chats.start({ provider: 'claude', model: 'sonnet', effort: 'low', prompt: 'こんにちは' });
  assert.ok(isChatId(id));
  assert.equal(t.chats.view()[0]!.state, 'running', 'shown as answering from the start');
  await tick();
  assert.equal(t.started[0]!.chat, true);
  assert.equal(t.started[0]!.cwd, 'C:\\chat');
  assert.deepEqual(t.started[0]!.readDirs, ['C:\\att'], 'attached files can be read');
  assert.equal(t.core.state.sessions.size, 0, 'not a piece of work');
  assert.deepEqual(t.words(id), ['user: こんにちは', 'assistant: re: こんにちは']);
  assert.equal(t.chats.view()[0]!.state, 'idle');
  t.chats.send(id, 'もう一つ');
  await tick();
  assert.deepEqual(t.sent, ['もう一つ'], 'a live chat gets the next message directly');
});

test('switching model resumes the same conversation; switching agent tells the new one what was said', async () => {
  const t = setup();
  const id = t.chats.start({ provider: 'claude', model: 'haiku', prompt: '好きな果物はキウイ' });
  await tick();
  t.chats.setChoice(id, { provider: 'claude', model: 'sonnet', effort: 'high' });
  t.chats.send(id, '好きな果物は？');
  await tick();
  assert.equal(t.started[1]!.resumeProviderSessionId, 'claude-conv');
  assert.equal(t.started[1]!.model, 'sonnet');
  assert.equal(t.started[1]!.effort, 'high');
  t.chats.setChoice(id, { provider: 'codex', model: 'gpt-6-luna' });
  t.chats.send(id, 'もう一度');
  await tick();
  const third = t.started[2]!;
  assert.equal(third.provider, 'codex');
  assert.equal(third.resumeProviderSessionId, null);
  assert.match(third.prompt, /キウイ/, 'the new agent hears the conversation so far');
  assert.equal(third.shownPrompt, 'もう一度', 'the record shows only what the human wrote');
  assert.equal((third as { codex?: { sandbox?: string } }).codex?.sandbox, 'read-only');
});

test('a chat never asks the human: requests are refused at once', async () => {
  const t = setup();
  const id = t.chats.start({ provider: 'claude', prompt: 'x' });
  let answer: unknown = null;
  t.chats.refuse({ sessionId: id, requestId: 'r1', type: 'permission_approval', summary: 'Bash の実行承認', reply: (a) => void (answer = a) });
  await tick();
  assert.deepEqual(answer, { kind: 'decision', decision: 'decline', message: 'サイドチャットでは、この操作はできません。' });
  assert.equal(t.core.state.items.size, 0, 'nothing in the inbox');
});

test('a message while answering is refused; closing a chat leaves nothing behind', async () => {
  const t = setup();
  const id = t.chats.start({ provider: 'claude', prompt: 'x' });
  assert.throws(() => t.chats.send(id, 'y'), /返答中/);
  await tick();
  await t.chats.close(id);
  assert.equal(t.chats.view().length, 0);
  assert.deepEqual(t.words(id), []);
  assert.deepEqual(t.store.readChats(), []);
  assert.throws(() => t.chats.send(id, 'z'), /もうありません/);
});

test('open chats come back after a restart; one that was answering shows as interrupted', () => {
  const t = setup();
  t.store.saveChat({ id: 'chat-a', title: 'a', createdAt: 1, updatedAt: 1, provider: 'claude', model: null, effort: null, state: 'running', error: null, conversation: null, activeModel: null } as { id: string });
  const again = new SideChats(t.rt, new Journal(t.rt, (x) => x), (x) => x, { cwd: '', attachments: '' });
  assert.equal(again.view()[0]!.state, 'interrupted');
});

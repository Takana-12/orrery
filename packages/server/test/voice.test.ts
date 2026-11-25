// Voice input on the server: a recording becomes text (with a stand-in recogniser), the text becomes a plan (with a
// stand-in planner), and the model that does the real recognising is fetched, checked and reported honestly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlCore, MemoryEventStore } from '#core';
import type { ModelChoice, ProviderId } from '#core';
import { Assistant } from '../src/application/assistant.ts';
import type { AssistantModel, HelperModel } from '../src/application/assistant.ts';
import { HttpError } from '../src/application/errors.ts';
import type { Runtime } from '../src/application/runtime.ts';
import { MAX_VOICE_BYTES, Voice } from '../src/application/voice.ts';
import { ChosenSpeech, DEFAULT_SPEECH_MODEL, SPEECH_MODELS, SPEECH_SAMPLE_RATE, SherpaSpeech, dropLoop, splitAtPauses, tidyTranscript } from '../src/infrastructure/speech.ts';
import type { Speech, SpeechModel } from '../src/infrastructure/speech.ts';
import type { VoicePlanInput, VoiceTask, VoiceTidyInput } from '../../provider-shared/src/voice-plan.ts';

const nothing = async () => null;
const base: AssistantModel = { generateTitle: nothing, readFinalReply: nothing, readCommandResult: nothing, clarifyChecks: nothing, extractPreferences: nothing, tunePreferences: nothing, routeKnowledge: nothing };

function setup(opts: { plan?: (input: VoicePlanInput) => { tasks: VoiceTask[] } | null; tidy?: (input: VoiceTidyInput) => string | null; signedIn?: Partial<Record<ProviderId, boolean | null>>; models?: (p: ProviderId) => Promise<ModelChoice[]> } = {}) {
  const events = new MemoryEventStore();
  const core = new ControlCore({ store: events } as never);
  core.start();
  const rt = { core, closing: false, notify: () => {}, adapters: {} } as unknown as Runtime;
  const heard: Float32Array[] = [];
  const speech: Speech & { prepared: number; warmed: number } = {
    prepared: 0,
    warmed: 0,
    status: () => ({ id: 'test', state: 'ready', progress: 1, bytes: 1, label: 'test', error: null }),
    prepare: async () => { speech.prepared++; },
    warm: () => { speech.warmed++; },
    transcribe: async (samples) => (heard.push(samples), 'テストを足して'),
    close: () => {},
  };
  const asked: { input: VoicePlanInput; choice: unknown }[] = [];
  const tidied: { input: VoiceTidyInput; choice: unknown }[] = [];
  const helper = (provider: ProviderId): HelperModel => ({ extractPreferences: nothing, tunePreferences: nothing, planVoice: async (input, choice) => (asked.push({ input, choice: { provider, ...choice } }), opts.plan ? opts.plan(input) : { tasks: [{ sessionId: '', projectId: input.projects[0]!.id, provider: 'claude', model: 'opus', effort: 'medium', prompt: 'やって' }] }), tidyVoice: async (input, choice) => (tidied.push({ input, choice: { provider, ...choice } }), opts.tidy ? opts.tidy(input) : input.transcript.replace('プランビ', 'プランB')) });
  const assistant = new Assistant(rt, base, { claude: helper('claude'), codex: helper('codex') });
  const signedIn = { claude: true, codex: true, ...opts.signedIn };
  const accounts = {
    view: () => ({ claude: { loggedIn: signedIn.claude, plan: null, loginInProgress: false, error: null }, codex: { loggedIn: signedIn.codex, plan: null, loginInProgress: false, error: null } }),
    listModels: opts.models ?? (async (p: ProviderId) => (p === 'claude' ? [{ id: 'default', label: '既定' }, { id: 'opus', label: 'Opus', efforts: ['low', 'medium'], isDefault: true }] : [{ id: 'gpt', label: 'GPT' }])),
  };
  const voice = new Voice(rt, { speech, assistant, accounts: accounts as never });
  return { core, events, voice, speech, heard, asked, tidied };
}

const pcm = (seconds: number, amplitude: number) => {
  const b = Buffer.alloc(Math.floor(seconds * SPEECH_SAMPLE_RATE) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * amplitude * 32767), i * 2);
  return b;
};
const status = async (work: Promise<unknown>) => work.then(() => 200, (e) => (e instanceof HttpError ? e.status : -1));

test('a recording reaches the recogniser as samples; silence and slips of the key never do', async () => {
  const t = setup();
  assert.deepEqual(await t.voice.transcribe(pcm(1, 0.5)), { text: 'テストを足して' });
  assert.equal(t.heard[0]!.length, SPEECH_SAMPLE_RATE);
  assert.ok(Math.abs(Math.max(...t.heard[0]!) - 0.5) < 0.01, '16-bit samples are scaled back to -1..1');
  assert.deepEqual(await t.voice.transcribe(pcm(1, 0.001)), { text: '' }, 'a muted microphone is not sent to the model');
  assert.deepEqual(await t.voice.transcribe(pcm(0.1, 0.5)), { text: '' }, 'a tenth of a second is not a request');
  assert.equal(t.heard.length, 1);
  assert.equal(await status(t.voice.transcribe('text')), 400);
  assert.equal(await status(t.voice.transcribe(Buffer.alloc(3))), 400);
  assert.equal(await status(t.voice.transcribe(Buffer.alloc(MAX_VOICE_BYTES + 2))), 413);
});

test('a recogniser that cannot run is an answer the page can show, not a crash', async () => {
  const t = setup();
  t.speech.transcribe = async () => { throw new Error('音声認識を起動できませんでした'); };
  assert.equal(await status(t.voice.transcribe(pcm(1, 0.5))), 503);
});

test('opening the layer fetches the model if needed and loads it before the human has finished speaking', async () => {
  const t = setup();
  t.voice.prepare();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([t.speech.prepared, t.speech.warmed], [1, 1]);
  assert.equal(t.voice.view().model.state, 'ready');
});

test('the planner is shown every workspace, every signed-in agent and the human\'s own habits, and is the AI chosen in settings', async () => {
  const t = setup();
  const a = t.core.addProject('orrery', process.cwd());
  const b = t.core.addProject('ledger', tmpdir());
  const s = t.core.createSession({ projectId: b, provider: 'codex', title: '移行スクリプト' });
  t.core.setProjectOptions(a, { description: '  エージェントを並行して動かすアプリ  ' });
  t.core.setSettings({ voice: { plannerAi: { provider: 'codex', model: 'gpt', effort: 'low' } } as never });
  const r = await t.voice.plan({ text: '  テストを足して  ', lastProjectId: 'gone', usual: { [a]: { provider: 'claude', model: 'opus' }, [b]: { provider: 'gemini' }, other: { provider: 'claude' } } });
  assert.equal(r.tasks.length, 1);
  const { input, choice } = t.asked[0]!;
  assert.deepEqual(choice, { provider: 'codex', model: 'gpt', effort: 'low' });
  assert.equal(input.transcript, 'テストを足して');
  assert.deepEqual(input.projects.map((p) => [p.id, p.name, p.usual, p.recent]), [[a, 'orrery', { provider: 'claude', model: 'opus' }, []], [b, 'ledger', null, ['移行スクリプト']]]);
  assert.deepEqual(input.projects.map((p) => p.description), ['エージェントを並行して動かすアプリ', ''], 'each workspace comes with the description written in settings');
  assert.equal(input.defaultProjectId, t.core.state.sessions.get(s.id)!.projectId, 'an unknown "last workspace" falls back to the one worked in most recently');
  assert.deepEqual(input.agents.map((x) => [x.provider, x.models.map((m) => m.id)]), [['claude', ['opus']], ['codex', ['gpt']]], 'the "default" pseudo-model is not offered');
  assert.equal((await t.voice.plan({ text: 'x', lastProjectId: a })).tasks.length, 1);
  assert.equal(t.asked[1]!.input.defaultProjectId, a);
});

test('open work is offered as something the words may answer: not what was put away or accepted', async () => {
  const t = setup();
  const p = t.core.addProject('orrery', process.cwd());
  const a = t.core.createSession({ projectId: p, provider: 'claude', title: 'READMEの更新' });
  const b = t.core.createSession({ projectId: p, provider: 'codex', title: '片付け済み' });
  const c = t.core.createSession({ projectId: p, provider: 'codex', title: '完了済み' });
  for (const s of [b, c]) t.core.sessionUpdate(s.id, { lifecycle: 'turn_finished' });
  assert.ok(t.core.setArchived(b.id, true).ok);
  assert.ok(t.core.setAccepted(c.id, true).ok);
  await t.voice.plan({ text: 'それでいい' });
  const offered = t.asked[0]!.input.sessions;
  assert.deepEqual(offered.map((s) => [s.id, s.title, s.projectId, s.provider]), [[a.id, 'READMEの更新', p, 'claude']]);
  assert.ok(offered[0]!.state, 'its state is described');
});

test('only agents that are signed in are offered; a model list that cannot be read leaves the agent usable', async () => {
  const t = setup({ signedIn: { codex: false }, models: async () => { throw new Error('offline'); } });
  t.core.addProject('orrery', process.cwd());
  await t.voice.plan({ text: 'x' });
  assert.deepEqual(t.asked[0]!.input.agents, [{ provider: 'claude', models: [] }]);
});

test('what cannot be planned is refused with a reason, before or after the planner is asked', async () => {
  const none = setup();
  assert.equal(await status(none.voice.plan({ text: 'x' })), 409, 'no workspace yet');
  const t = setup({ plan: () => null });
  t.core.addProject('orrery', process.cwd());
  assert.equal(await status(t.voice.plan({ text: '   ' })), 400);
  assert.equal(await status(t.voice.plan({ text: 'x' })), 502, 'the planner gave no usable answer');
  const empty = setup({ plan: () => ({ tasks: [] }) });
  empty.core.addProject('orrery', process.cwd());
  assert.equal(await status(empty.voice.plan({ text: 'えーと' })), 422, 'nothing was asked for');
  const out = setup({ signedIn: { claude: false, codex: false } });
  out.core.addProject('orrery', process.cwd());
  assert.equal(await status(out.voice.plan({ text: 'x' })), 409);
  assert.equal(out.asked.length, 0);
});

test('voice settings: defaults, validation, and no event when nothing changes', () => {
  const { core, events } = setup();
  assert.deepEqual(core.state.settings.voice, { plannerAi: { provider: 'claude', model: 'haiku', effort: '' }, confirm: true });
  core.setSettings({ voice: { recognizer: ' sense-voice-small ', words: '  Orrery \r\n\n takanaEditor\n' } as never });
  assert.deepEqual([core.state.settings.voice.recognizer, core.state.settings.voice.words], ['sense-voice-small', 'Orrery\ntakanaEditor'], 'one word a line, blank lines dropped');
  core.setSettings({ voice: { recognizer: undefined, words: '' } as never });
  assert.equal(core.state.settings.voice.recognizer, 'sense-voice-small', 'what is not in the patch stays');
  core.setSettings({ voice: { confirm: false } as never });
  assert.deepEqual(core.state.settings.voice, { plannerAi: { provider: 'claude', model: 'haiku', effort: '' }, confirm: false, recognizer: 'sense-voice-small', words: '' }, 'one field at a time');
  core.setSettings({ voice: { plannerAi: { provider: 'gemini', model: ' m ', effort: 'x'.repeat(99) } } as never });
  assert.deepEqual(core.state.settings.voice.plannerAi, { provider: 'claude', model: 'm', effort: 'x'.repeat(30) });
  assert.equal(core.state.settings.voice.confirm, false);
  const before = events.readAll().length;
  core.setSettings({ voice: { confirm: false } as never });
  assert.equal(events.readAll().length, before);
  core.setSettings({ voice: { confirm: true } as never });
  assert.equal(events.readAll().length, before + 1);
});

test('the transcript is written the way the language is written', () => {
  assert.equal(tidyTranscript('<|ja|><|NEUTRAL|>オーラリー の ホーム 画面 の バグ を 直 して、それ と ユニティ'), 'オーラリーのホーム画面のバグを直して、それとユニティ');
  assert.equal(tidyTranscript('Please refactor  the settings view'), 'Please refactor the settings view');
  assert.equal(tidyTranscript('README を update して pull request も'), 'READMEをupdateしてpull requestも');
  assert.equal(tidyTranscript('   '), '');
});

test('a recogniser stuck in a loop is cut back to what was said once; real repetition and subtitles in silence are told apart', () => {
  // Whisper, given 2.8 s of "Orreryの設定画面を開いて", ran on until it hit the token limit.
  assert.equal(tidyTranscript('オルリーの設定画面を開いて、オルリーの設定画面を開いて、オルリーの設定画面を開いて、オルリー'), 'オルリーの設定画面を開いて');
  assert.equal(dropLoop('テストを直して。はい、はい、はい、はい、はい、は'), 'テストを直して。はい');
  assert.equal(dropLoop('READMEを直して、READMEを直して'), 'READMEを直して', 'a long stretch twice, to the very end, is a loop');
  for (const kept of ['AとBとC', 'はいはい', 'まずテスト、次にテスト', 'ドンドン進めて', 'じゃあプランBでお願い。']) assert.equal(dropLoop(kept), kept);
  assert.equal(tidyTranscript('ご視聴ありがとうございました。'), '');
  assert.equal(tidyTranscript('Thank you for watching!'), '');
  assert.equal(tidyTranscript('ご視聴ありがとうございましたと書いて'), 'ご視聴ありがとうございましたと書いて', 'said as part of a request, it stays');
});

test('the recogniser is the one chosen in settings; an unknown choice is the default, and the other lets its memory go', async () => {
  assert.equal(DEFAULT_SPEECH_MODEL, 'whisper-turbo', 'English inside Japanese is written as English by default');
  assert.deepEqual(SPEECH_MODELS.map((m) => m.id), ['whisper-turbo', 'sense-voice-small']);
  const whisper = SPEECH_MODELS[0]!;
  const config = whisper.config('/m') as { whisper: { language: string } };
  assert.equal(config.whisper.language, '', 'the language is detected: forced to Japanese, English speech turns into nonsense');
  assert.ok(Number(whisper.streamOptions?.max_tokens_per_second) >= 15, 'quick Japanese is not cut short');
  let chosen: string | undefined;
  const root = mkdtempSync(join(tmpdir(), 'orrery-voice-'));
  const speech = new ChosenSpeech(root, () => {}, () => chosen);
  assert.equal(speech.status().id, 'whisper-turbo');
  chosen = 'sense-voice-small';
  assert.equal(speech.status().id, 'sense-voice-small');
  chosen = 'nothing-like-it';
  assert.equal(speech.status().id, 'whisper-turbo');
  assert.deepEqual(speech.choices().map((c) => [c.id, c.state, !!c.note]), [['whisper-turbo', 'missing', true], ['sense-voice-small', 'missing', true]]);
  speech.close();
});

test('a spoken reply has its English put back with the human\'s words and the work it answers; plain Japanese is not sent to an AI', async () => {
  const t = setup();
  const p = t.core.addProject('ledger', join(tmpdir(), 'ledger-app'));
  const s = t.core.createSession({ projectId: p, provider: 'claude', title: 'プランの比較' });
  t.core.setSettings({ voice: { plannerAi: { provider: 'codex', model: 'gpt', effort: 'low' }, words: 'Unity\nOrrery' } as never });
  assert.deepEqual(await t.voice.tidy({ text: ' じゃあプランビでお願い ', sessionId: s.id }), { text: 'じゃあプランBでお願い' });
  const { input, choice } = t.tidied[0]!;
  assert.deepEqual(choice, { provider: 'codex', model: 'gpt', effort: 'low' }, 'the AI chosen for voice input');
  assert.deepEqual(input.words, ['Unity', 'Orrery', 'Claude Code', 'Codex', 'ledger', 'ledger-app'], 'the human\'s own words first, then the app, its agents and the workspaces');
  assert.match(input.context, /プランの比較/);
  assert.deepEqual(await t.voice.tidy({ text: 'テストを全部実行して' }), { text: 'テストを全部実行して' });
  assert.deepEqual(await t.voice.tidy({ text: 'それで進めてください。' }), { text: 'それで進めてください。' });
  assert.equal(t.tidied.length, 2, 'no katakana and no Latin letters: nothing to put back, nothing waited for');
  assert.equal(await status(t.voice.tidy({ text: '  ' })), 400);
  const down = setup({ tidy: () => null });
  assert.deepEqual(await down.voice.tidy({ text: 'プランビで' }), { text: 'プランビで' }, 'an AI that cannot help leaves the words as heard');
});

test('the planner is given the human\'s words to spell with', async () => {
  const t = setup();
  t.core.addProject('orrery', process.cwd());
  t.core.setSettings({ voice: { words: 'Unity' } as never });
  await t.voice.plan({ text: 'オルリーの設定画面' });
  assert.deepEqual(t.asked[0]!.input.words?.slice(0, 3), ['Unity', 'Orrery', 'Claude Code']);
});

test('a long recording is cut at its quietest moments, losing nothing', () => {
  const rate = 100;
  const samples = new Float32Array(rate * 70).fill(0.5);
  for (let i = rate * 22; i < rate * 23; i++) samples[i] = 0; // a pause 22 s in
  const parts = splitAtPauses(samples, 25, rate);
  assert.equal(parts.reduce((n, p) => n + p.length, 0), samples.length);
  assert.ok(parts.every((p) => p.length <= 25 * rate));
  assert.ok(parts[0]!.length > 22 * rate && parts[0]!.length < 23 * rate, `the first cut falls in the pause: ${parts[0]!.length}`);
  assert.equal(splitAtPauses(new Float32Array(rate * 3), 25, rate).length, 1);
});

test('the model is downloaded once, checked against its size and hash, and a bad download is not kept', async () => {
  const good = Buffer.from('the model');
  const model = (sha256: string): SpeechModel => ({ id: 'm', label: 'M', repo: 'who/what', revision: 'abc', files: [{ name: 'model.onnx', bytes: good.length, sha256 }, { name: 'tokens.txt', bytes: 2 }], config: () => ({}), maxSeconds: 25, note: '' });
  const urls: string[] = [];
  const fetchFake = (async (url: string) => (urls.push(url), new Response(url.endsWith('tokens.txt') ? 'ab' : good))) as unknown as typeof fetch;
  const hash = createHash('sha256').update(good).digest('hex');

  const root = mkdtempSync(join(tmpdir(), 'orrery-voice-'));
  let told = 0;
  const speech = new SherpaSpeech(root, () => told++, { model: model(hash), fetch: fetchFake });
  assert.equal(speech.status().state, 'missing');
  const both = [speech.prepare(), speech.prepare()];
  assert.equal(speech.status().state, 'downloading');
  await Promise.all(both);
  assert.deepEqual(speech.status(), { id: 'm', state: 'ready', progress: 1, bytes: good.length + 2, label: 'M', error: null });
  assert.deepEqual(urls, ['https://huggingface.co/who/what/resolve/abc/model.onnx', 'https://huggingface.co/who/what/resolve/abc/tokens.txt'], 'asked for once, at the pinned revision');
  assert.equal(readFileSync(join(root, 'm', 'model.onnx'), 'utf8'), 'the model');
  assert.ok(told >= 2, 'the page is told when the download starts and ends');
  await speech.prepare();
  assert.equal(urls.length, 2, 'nothing is fetched again');

  const bad = mkdtempSync(join(tmpdir(), 'orrery-voice-'));
  const broken = new SherpaSpeech(bad, () => {}, { model: model('0'.repeat(64)), fetch: fetchFake });
  await assert.rejects(broken.prepare(), /内容が一致しません/);
  assert.equal(broken.status().state, 'failed');
  assert.deepEqual(readdirSync(join(bad, 'm')), [], 'a file that fails its check is thrown away');
  const offline = new SherpaSpeech(mkdtempSync(join(tmpdir(), 'orrery-voice-')), () => {}, { model: model(hash), fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch });
  await assert.rejects(offline.prepare(), /HTTP 404/);
  assert.match(offline.status().error ?? '', /ダウンロードできませんでした/);
});

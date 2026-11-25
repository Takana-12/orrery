// Live check of voice input against the real things: the speech model (downloaded on first run, 230 MB to 1 GB, into
// .control-room/models, or VOICE_MODELS_DIR) and the real planner model (costs a little plan usage).
//   node packages/server/test/voice-live.ts [recording.wav ...]     (16 kHz mono 16-bit WAV)
//   node packages/server/test/voice-live.ts --plan "話した内容"       (planner only)
//   node packages/server/test/voice-live.ts --tidy [recording.wav ...] (each transcript, its English put back)
// VOICE_MODEL picks the recogniser (an id of SPEECH_MODELS; the default otherwise).
// Runs under Electron as well (`npx electron packages/server/test/voice-live.ts ...`), which is how the app loads it.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '#provider-claude';
import type { ProviderSink } from '#core';
import { ChosenSpeech, SPEECH_SAMPLE_RATE } from '../src/infrastructure/speech.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2).filter((a) => !a.endsWith('voice-live.ts'));
const planAt = args.indexOf('--plan');
const said = planAt >= 0 ? [args[planAt + 1] ?? ''] : [];
const wavs = args.filter((a) => a.toLowerCase().endsWith('.wav'));
const tidy = args.includes('--tidy');
/** What the tidying is told the human says: the same kind of list the app builds (own words, the app, workspaces). */
const WORDS = ['Orrery', 'Claude Code', 'Codex', 'takanaEditor', 'UnityRunner', 'ledger'];

/** The samples of a plain PCM WAV file (16-bit mono at the recogniser's rate). */
function readWav(file: string): Float32Array {
  const b = readFileSync(file);
  let at = 12;
  let rate = 0;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(at + 12);
    if (id === 'data') {
      if (rate !== SPEECH_SAMPLE_RATE) throw new Error(`${file}: ${rate} Hz（16000 Hz のWAVを渡してください）`);
      const out = new Float32Array(Math.floor(Math.min(size, b.length - at - 8) / 2));
      for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(at + 8 + i * 2) / 32768;
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file}: WAVではありません`);
}

let ok = true;
if (wavs.length) {
  let last = '';
  const speech = new ChosenSpeech(process.env.VOICE_MODELS_DIR ?? join(root, '.control-room/models'), () => {
    const s = speech.status();
    const line = `${s.id} ${s.state} ${Math.round(s.progress * 100)}%`;
    if (line !== last) console.log(`[model] ${(last = line)}`);
  }, () => process.env.VOICE_MODEL);
  const started = Date.now();
  await speech.prepare();
  console.log(`[model] ready in ${Date.now() - started} ms: ${JSON.stringify(speech.status())}`);
  for (const file of wavs) {
    const samples = readWav(file);
    const t = Date.now();
    const text = await speech.transcribe(samples);
    console.log(`${(samples.length / SPEECH_SAMPLE_RATE).toFixed(1)} s of speech, ${Date.now() - t} ms: ${text}`);
    said.push(text);
    ok &&= !!text;
  }
  speech.close();
}

if (tidy) {
  const sink = { processSpawned() {}, sessionUpdate() {}, transcript() {}, usage() {}, usageLimits() {}, usageBlocked() {}, saveRaw: () => '', attentionOpen: () => '', attentionAcknowledged() {}, attentionWithdrawn() {} } as unknown as ProviderSink;
  const claude = new ClaudeAdapter(sink);
  for (const transcript of said.filter(Boolean)) {
    const t = Date.now();
    const fixed = await claude.tidyVoice({ transcript, words: WORDS, context: '' });
    console.log(`[tidy] ${Date.now() - t} ms: ${transcript}  ->  ${fixed ?? '(as heard)'}`);
  }
  await claude.shutdown();
}

if (planAt >= 0 || process.env.VOICE_LIVE_PLAN === '1') {
  const sink = { processSpawned() {}, sessionUpdate() {}, transcript() {}, usage() {}, usageLimits() {}, usageBlocked() {}, saveRaw: () => '', attentionOpen: () => '', attentionAcknowledged() {}, attentionWithdrawn() {} } as unknown as ProviderSink;
  const claude = new ClaudeAdapter(sink);
  const models = (await claude.listModels()).filter((m) => m.id !== 'default').map((m) => ({ id: m.id, label: m.label, description: m.description ?? '', efforts: m.efforts ?? [], isDefault: !!m.isDefault, defaultEffort: m.defaultEffort ?? null }));
  for (const transcript of said.filter(Boolean)) {
    const t = Date.now();
    const r = await claude.planVoice({
      transcript,
      projects: [
        { id: 'p1', name: 'orrery', path: 'C:\\work\\orrery', description: 'AIエージェントを並行して動かすデスクトップアプリ', recent: ['ホーム画面の入力欄の修正', '設定画面の目次'], usual: { provider: 'claude', model: 'opus' } },
        { id: 'p2', name: 'UnityRunner', path: 'C:\\work\\unity-runner', description: 'Unity製の横スクロールアクションゲーム', recent: ['プレイヤーの二段ジャンプ', '敵のスポーン調整'], usual: null },
        { id: 'p3', name: 'ledger', path: 'C:\\work\\ledger', description: '', recent: ['SQLiteストアの移行スクリプト'], usual: { provider: 'codex', model: '' } },
      ],
      agents: [{ provider: 'claude', models }, { provider: 'codex', models: [{ id: 'gpt-codex', label: 'GPT Codex', description: 'Codex の標準モデル', efforts: ['low', 'medium', 'high'], isDefault: true, defaultEffort: 'medium' }] }],
      sessions: [],
      defaultProjectId: 'p1',
      words: WORDS,
    });
    console.log(`\n[plan] ${Date.now() - t} ms: ${transcript}`);
    console.log(JSON.stringify(r, null, 2));
    ok &&= !!r?.tasks.length;
  }
  await claude.shutdown();
}
process.exit(ok ? 0 : 1);

// Voice input use cases: a recording becomes text (on this machine), and the text becomes pieces of work, each with
// its workspace, agent and model. Nothing is started here: the page shows what was understood and starts each piece
// through the same path as work that was typed (Sessions.start), so approvals and worktrees follow each workspace's
// own settings. Recognisers write English inside Japanese badly ("オルリー" for Orrery): the planner, and for a spoken
// reply a tidying step, put it back into English with the help of the human's own words.
import { basename } from 'node:path';
import type { ProviderId, SessionLifecycle } from '#core';
import { SPEECH_SAMPLE_RATE } from '../infrastructure/speech.ts';
import type { Speech } from '../infrastructure/speech.ts';
import { VOICE_LIMITS } from '../../../provider-shared/src/voice-plan.ts';
import type { VoiceAgent, VoiceProject, VoiceSession, VoiceTask } from '../../../provider-shared/src/voice-plan.ts';
import type { Accounts } from './accounts.ts';
import type { Assistant } from './assistant.ts';
import { HttpError } from './errors.ts';
import { PROVIDERS, message } from './runtime.ts';
import type { Runtime } from './runtime.ts';

/** The longest recording that is read: five minutes of 16-bit mono. */
export const MAX_VOICE_BYTES = SPEECH_SAMPLE_RATE * 2 * 300;
/** Shorter than this is a key held a moment too long, not a request. */
const MIN_VOICE_BYTES = SPEECH_SAMPLE_RATE * 2 * 0.3;
/** Quieter than this at its loudest is a closed or muted microphone. */
const SILENCE_PEAK = 0.01;

const PROVIDER_NAME: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' };
/** How many pieces of work going on the planner is shown as things the words may answer. */
const REPLY_CANDIDATES = 12;
const STATE_WORD: Record<SessionLifecycle, string> = { queued: '順番待ち', running: '作業中', waiting_for_user: 'あなたの判断待ち', turn_finished: '返答済み', interrupted: '中断', error: 'エラー', unknown: '状況不明' };

export interface VoiceDeps {
  speech: Speech;
  assistant: Assistant;
  accounts: Pick<Accounts, 'view' | 'listModels'>;
}

export class Voice {
  private readonly rt: Runtime;
  private readonly d: VoiceDeps;

  constructor(rt: Runtime, deps: VoiceDeps) {
    this.rt = rt;
    this.d = deps;
  }

  /** What the page shows about voice input: the recognisers that can be chosen, and whether the chosen one's model is there yet. */
  view() {
    const model = this.d.speech.status();
    return { model, models: this.d.speech.choices?.() ?? [{ ...model, note: '' }] };
  }

  /**
   * Words whose spelling a recogniser cannot know: the human's own list first, then this app and its agents, and the
   * names of the workspaces (and their folders).
   */
  private words(): string[] {
    const { state } = this.rt.core;
    const own = (state.settings.voice.words ?? '').split('\n');
    const places = [...state.projects.values()].flatMap((p) => [p.name, basename(p.rootPath)]);
    return [...new Set([...own, 'Orrery', 'Claude Code', 'Codex', ...places].map((w) => w.trim()).filter(Boolean))];
  }

  /**
   * A spoken reply to work `sessionId`, written the way the human would have typed it: English put back into English
   * ("プランビ" -> "プランB"). What was heard comes back unchanged when there is nothing to fix or it cannot be fixed.
   */
  async tidy(input: { text?: unknown; sessionId?: unknown }): Promise<{ text: string }> {
    const heard = String(input.text ?? '').trim().slice(0, VOICE_LIMITS.transcript);
    if (!heard) throw new HttpError(400, '内容が空です');
    // No katakana and no Latin letters: no English came out, so there is none to put back (and no AI is waited for).
    if (!/[゠-ヿA-Za-zＡ-ｚ]/.test(heard)) return { text: heard };
    const { state } = this.rt.core;
    const s = typeof input.sessionId === 'string' ? state.sessions.get(input.sessionId) : undefined;
    const context = s ? [state.tasks.get(s.taskId)?.title ?? '', (s.lastText ?? '').slice(-400)].filter(Boolean).join('\n') : '';
    const fixed = await this.d.assistant.tidyVoice({ transcript: heard, words: this.words(), context }, { ...state.settings.voice.plannerAi }).catch(() => null);
    return { text: fixed ?? heard };
  }

  /**
   * The human is about to speak: fetch the recogniser's model if it is not there yet, and load it. Returns at once;
   * progress shows through view().
   */
  prepare(): void {
    void this.d.speech.prepare().then(() => this.d.speech.warm(), () => {});
  }

  /** `body`: the recording as 16-bit little-endian mono samples at SPEECH_SAMPLE_RATE. */
  async transcribe(body: unknown): Promise<{ text: string }> {
    if (!Buffer.isBuffer(body) || body.length % 2 !== 0) throw new HttpError(400, '録音の形式が不正です');
    if (body.length > MAX_VOICE_BYTES) throw new HttpError(413, '録音が長すぎます（5分まで）');
    if (body.length < MIN_VOICE_BYTES) return { text: '' };
    const samples = new Float32Array(body.length / 2);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = body.readInt16LE(i * 2) / 32768;
      samples[i] = v;
      if (v > peak || -v > peak) peak = Math.abs(v);
    }
    if (peak < SILENCE_PEAK) return { text: '' };
    try {
      return { text: await this.d.speech.transcribe(samples) };
    } catch (e) {
      throw new HttpError(503, message(e));
    }
  }

  /**
   * What was said, as work to start. `lastProjectId` and `usual` are what the page remembers of the human's own
   * choices (the workspace used last, the AI last picked in each workspace): hints, checked against what exists.
   */
  async plan(input: { text?: unknown; lastProjectId?: unknown; usual?: unknown }): Promise<{ tasks: VoiceTask[] }> {
    const { rt } = this;
    const transcript = String(input.text ?? '').trim().slice(0, VOICE_LIMITS.transcript);
    if (!transcript) throw new HttpError(400, '依頼が空です');
    const state = rt.core.state;
    if (!state.projects.size) throw new HttpError(409, 'ワークスペースがまだありません。先にフォルダを追加してください');

    const auth = this.d.accounts.view();
    const signedIn = PROVIDERS.filter((p) => auth[p]?.loggedIn !== false);
    if (!signedIn.length) throw new HttpError(409, 'サインインしているAIがありません');
    const agents: VoiceAgent[] = await Promise.all(signedIn.map(async (provider) => {
      // A list that cannot be read still leaves the agent usable with its own default model.
      const models = await this.d.accounts.listModels(provider).catch(() => []);
      return {
        provider,
        models: models.filter((m) => m.id !== 'default').map((m) => ({ id: m.id, label: m.label, description: m.description ?? '', efforts: m.efforts ?? [], isDefault: !!m.isDefault, defaultEffort: m.defaultEffort ?? null })),
      };
    }));

    const sessions = [...state.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const hints = input.usual && typeof input.usual === 'object' ? (input.usual as Record<string, { provider?: unknown; model?: unknown }>) : {};
    const projects: VoiceProject[] = [...state.projects.values()].map((p) => {
      const h = hints[p.id];
      const usual = h && (h.provider === 'claude' || h.provider === 'codex') && signedIn.includes(h.provider) ? { provider: h.provider as ProviderId, model: String(h.model ?? '').slice(0, 120) } : null;
      const recent = sessions.filter((s) => s.projectId === p.id).slice(0, 5).map((s) => state.tasks.get(s.taskId)?.title ?? '').filter(Boolean);
      return { id: p.id, name: p.name, path: p.rootPath, description: (p.description ?? '').trim(), recent, usual };
    });
    // Work still open (not put away, not accepted as done) can be answered by voice.
    const open: VoiceSession[] = sessions
      .filter((s) => !s.archived && state.tasks.get(s.taskId)?.acceptedAt == null && state.projects.has(s.projectId))
      .slice(0, REPLY_CANDIDATES)
      .map((s) => ({ id: s.id, title: state.tasks.get(s.taskId)?.title ?? '', projectId: s.projectId, provider: s.provider, state: STATE_WORD[s.lifecycle] ?? STATE_WORD.unknown, last: (s.lastText ?? '').slice(-400) }));
    const last = typeof input.lastProjectId === 'string' && state.projects.has(input.lastProjectId) ? input.lastProjectId : (sessions[0]?.projectId ?? projects[0]!.id);

    const choice = state.settings.voice.plannerAi;
    const reading = await this.d.assistant.planVoice({ transcript, projects, agents, sessions: open, defaultProjectId: last, words: this.words() }, { ...choice });
    if (!reading) throw new HttpError(502, `依頼を読み取れませんでした（判断するAI: ${PROVIDER_NAME[choice.provider]}${choice.model ? ` ${choice.model}` : ''}）`);
    if (!reading.tasks.length) throw new HttpError(422, '依頼が見つかりませんでした');
    return reading;
  }
}

// Speech to text, on this machine: nothing that is said leaves it. The recogniser (sherpa-onnx, a native addon) and
// its model are loaded on first use and let go after a while without use, so an Orrery that is never spoken to pays
// nothing. The model itself is not shipped with the app: it is downloaded once, into the data folder, and checked.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Everything the recogniser is given, at this rate, one channel. */
export const SPEECH_SAMPLE_RATE = 16000;

interface ModelFile {
  name: string;
  bytes: number;
  /** SHA-256 of the file. Left out for the small text files (their size is checked). */
  sha256?: string;
}

export interface SpeechModel {
  id: string;
  /** Shown in settings. */
  label: string;
  /** Where the files are: a Hugging Face repository at one fixed revision. */
  repo: string;
  revision: string;
  files: ModelFile[];
  /** The recogniser's model settings, given the folder the files are in. */
  config(dir: string): Record<string, unknown>;
  /** The longest stretch the model reads well in one go, in seconds. Longer recordings are cut at pauses. */
  maxSeconds: number;
  /** Set on each recording's stream before it is read (sherpa-onnx per-stream options). */
  streamOptions?: Record<string, string>;
  /** Shown in settings under the name: what the model is good at. */
  note: string;
}

/**
 * SenseVoice Small (FunAudioLLM), 8-bit: 230 MB, about 0.5 s for 10 s of speech on a laptop CPU. It picks one language
 * for the whole recording: English said inside a Japanese sentence comes out as katakana ("プランビー") or is dropped.
 */
export const SENSE_VOICE: SpeechModel = {
  id: 'sense-voice-small',
  label: 'SenseVoice Small',
  repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
  revision: '2365baeacb507f821a0c8120fcee3d484dba7a07',
  files: [
    { name: 'model.int8.onnx', bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
    { name: 'tokens.txt', bytes: 315894 },
  ],
  config: (dir) => ({ senseVoice: { model: join(dir, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 }, tokens: join(dir, 'tokens.txt') }),
  maxSeconds: 25,
  note: '速くて軽い。日本語に混ざった英語はカタカナになるか、抜け落ちやすい',
};

/**
 * Whisper large-v3 turbo (OpenAI), 8-bit: 1 GB, about 2-3 s for 10 s of speech on a laptop CPU (the encoder reads a
 * 30 s window whatever the length). English inside Japanese stays English ("プランB", "branchをmerge"), and English
 * alone is English. The language is detected, not fixed: told "Japanese", it turns English speech into nonsense.
 */
export const WHISPER_TURBO: SpeechModel = {
  id: 'whisper-turbo',
  label: 'Whisper large-v3 turbo',
  repo: 'csukuangfj/sherpa-onnx-whisper-turbo',
  revision: '2ca6ff69fc878651b770880507669577ac41c2ff',
  files: [
    { name: 'turbo-encoder.int8.onnx', bytes: 674716297, sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b' },
    { name: 'turbo-decoder.int8.onnx', bytes: 361080764, sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547' },
    { name: 'turbo-tokens.txt', bytes: 816730 },
  ],
  config: (dir) => ({ whisper: { encoder: join(dir, 'turbo-encoder.int8.onnx'), decoder: join(dir, 'turbo-decoder.int8.onnx'), language: '', task: 'transcribe', tailPaddings: -1 }, tokens: join(dir, 'turbo-tokens.txt') }),
  maxSeconds: 28,
  // Japanese is about one token a character: the default (6 a second) cuts quick speech short. A loop that runs on to
  // the limit is cut back by tidyTranscript.
  streamOptions: { max_tokens_per_second: '20' },
  note: '日本語に英語が混ざっても英語のまま書ける。少し遅い（10秒の発話で2〜3秒）',
};

/** The recognisers that can be chosen in settings, the default first. */
export const SPEECH_MODELS: readonly SpeechModel[] = [WHISPER_TURBO, SENSE_VOICE];
export const DEFAULT_SPEECH_MODEL = WHISPER_TURBO.id;

export interface SpeechStatus {
  /** Which recogniser (SpeechModel.id). */
  id: string;
  /** missing: not downloaded yet. failed: the download or the recogniser itself did not work (see `error`). */
  state: 'missing' | 'downloading' | 'ready' | 'failed';
  /** Downloaded so far, 0..1 (1 once ready). */
  progress: number;
  /** Size of the download, for the settings screen. */
  bytes: number;
  label: string;
  error: string | null;
}

/** Port: what the voice use case needs from a recogniser. */
export interface Speech {
  status(): SpeechStatus;
  /** Make the model ready (download what is missing). Safe to call again; resolves once it is ready. */
  prepare(): Promise<void>;
  /** Somebody is about to speak: load the recogniser now (if its model is there), so the first reading does not wait for it. */
  warm(): void;
  /** Mono samples at SPEECH_SAMPLE_RATE, -1..1. Resolves with what was said ('' when nothing was). */
  transcribe(samples: Float32Array): Promise<string>;
  /** The recognisers that can be chosen in settings (left out: only this one). */
  choices?(): SpeechChoice[];
  close(): void;
}

const CJK = '\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef';
/** What Whisper says over silence or noise, learnt from subtitles. Never a request on its own. */
const PHANTOMS = /^(ご視聴ありがとうございました|ご清聴ありがとうございました|チャンネル登録(を)?お願いします|Thank you for watching|Thanks for watching|字幕.*)[。.!！]?$/i;

/**
 * Written the way the language is written: SenseVoice puts a space between every Japanese word (Japanese has none;
 * spaces between Latin words stay), and Whisper sometimes loops on its last words until it runs out of tokens, or
 * hears a subtitle in silence.
 */
export function tidyTranscript(text: string): string {
  const t = dropLoop(text
    .replace(/<\|[^|]*\|>/g, '')
    .replace(new RegExp(`(?<=[${CJK}])\\s+|\\s+(?=[${CJK}])`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim());
  return PHANTOMS.test(t) ? '' : t;
}

/**
 * A stretch said once and then repeated to the very end ("開いて、開いて、開いて、開") is a recogniser stuck in a loop,
 * not speech: keep it once. Three times or more; twice only for a stretch long enough that nobody says it twice.
 */
export function dropLoop(text: string): string {
  const n = text.length;
  let best = n;
  for (let len = 2; len * 1.8 <= n; len++) {
    // How far back from the end the text repeats itself every `len` characters.
    let i = n - len - 1;
    while (i >= 0 && text[i] === text[i + len]) i--;
    const start = i + 1;
    // The last repeat may be cut off by the limit (or miss only its comma).
    const times = (n - start) / len;
    if ((times >= 2.5 || (times >= 1.8 && len >= 8)) && start + len < best) best = start + len;
  }
  return best === n ? text : text.slice(0, best).replace(/[、,\s]+$/, '');
}

/**
 * Cut a long recording into pieces the model reads well, each at the quietest moment near its end, so that no word
 * is cut in two.
 */
export function splitAtPauses(samples: Float32Array, maxSeconds: number, rate = SPEECH_SAMPLE_RATE): Float32Array[] {
  const max = Math.floor(maxSeconds * rate);
  const out: Float32Array[] = [];
  let from = 0;
  while (samples.length - from > max) {
    const win = Math.floor(rate / 10); // 100 ms
    const searchFrom = from + Math.floor(max * 0.7);
    let best = from + max;
    let bestEnergy = Infinity;
    for (let at = searchFrom; at + win <= from + max; at += win >> 1) {
      let e = 0;
      for (let i = at; i < at + win; i++) e += samples[i]! * samples[i]!;
      if (e < bestEnergy) { bestEnergy = e; best = at + (win >> 1); }
    }
    out.push(samples.subarray(from, best));
    from = best;
  }
  out.push(samples.subarray(from));
  return out;
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

export interface SpeechOptions {
  model?: SpeechModel;
  /** For tests. */
  fetch?: typeof fetch;
  /** Let the recogniser go after this long without use. */
  idleMs?: number;
}

export class SherpaSpeech implements Speech {
  private readonly dir: string;
  private readonly model: SpeechModel;
  get note(): string { return this.model.note; }
  private readonly onChange: () => void;
  private readonly fetch: typeof fetch;
  private readonly idleMs: number;
  private downloading: Promise<void> | null = null;
  private got = 0;
  private error: string | null = null;
  private recognizer: Promise<any> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private lastTold = 0;
  /** One recording at a time: the recogniser uses every core it is given. */
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(root: string, onChange: () => void, opts: SpeechOptions = {}) {
    this.model = opts.model ?? SENSE_VOICE;
    this.dir = join(root, this.model.id);
    this.onChange = onChange;
    this.fetch = opts.fetch ?? fetch;
    this.idleMs = opts.idleMs ?? 10 * 60_000;
  }

  private total(): number {
    return this.model.files.reduce((n, f) => n + f.bytes, 0);
  }

  private have(f: ModelFile): boolean {
    try {
      return statSync(join(this.dir, f.name)).size === f.bytes;
    } catch {
      return false;
    }
  }

  private complete(): boolean {
    return this.model.files.every((f) => this.have(f));
  }

  status(): SpeechStatus {
    const base = { id: this.model.id, bytes: this.total(), label: this.model.label };
    if (this.downloading) return { ...base, state: 'downloading', progress: Math.min(1, this.got / this.total()), error: null };
    if (this.error) return { ...base, state: 'failed', progress: 0, error: this.error };
    return this.complete() ? { ...base, state: 'ready', progress: 1, error: null } : { ...base, state: 'missing', progress: 0, error: null };
  }

  prepare(): Promise<void> {
    if (this.downloading) return this.downloading;
    if (this.complete()) return Promise.resolve();
    this.error = null;
    this.got = this.model.files.filter((f) => this.have(f)).reduce((n, f) => n + f.bytes, 0);
    this.downloading = this.download()
      .catch((e) => {
        this.error = `音声認識モデルをダウンロードできませんでした: ${String((e as Error)?.message ?? e)}`;
        throw new Error(this.error);
      })
      .finally(() => {
        this.downloading = null;
        this.onChange();
      });
    this.downloading.catch(() => {}); // callers that do not wait must not leave an unhandled rejection
    this.onChange();
    return this.downloading;
  }

  private async download(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    for (const f of this.model.files) {
      if (this.have(f)) continue;
      const target = join(this.dir, f.name);
      const part = `${target}.part`;
      rmSync(part, { force: true });
      const res = await this.fetch(`https://huggingface.co/${this.model.repo}/resolve/${this.model.revision}/${f.name}`, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`${f.name}: HTTP ${res.status}`);
      const before = this.got;
      const body = Readable.fromWeb(res.body as any);
      body.on('data', (chunk: Buffer) => {
        this.got += chunk.length;
        // The settings screen and the voice screen show the progress: a few times a second is plenty.
        if (Date.now() - this.lastTold > 300) {
          this.lastTold = Date.now();
          this.onChange();
        }
      });
      try {
        await pipeline(body, createWriteStream(part));
        if (statSync(part).size !== f.bytes) throw new Error(`${f.name}: サイズが一致しません`);
        if (f.sha256 && (await sha256Of(part)) !== f.sha256) throw new Error(`${f.name}: 内容が一致しません`);
      } catch (e) {
        this.got = before;
        rmSync(part, { force: true });
        throw e;
      }
      renameSync(part, target);
    }
  }

  private load(): Promise<any> {
    this.recognizer ??= (async () => {
      // Loaded here, not at the top of the file: the addon is only needed once somebody speaks.
      const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
      return sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: 80 },
        modelConfig: { ...this.model.config(this.dir), numThreads: 4, provider: 'cpu', debug: 0 },
      });
    })();
    this.recognizer.catch(() => { this.recognizer = null; });
    return this.recognizer;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.recognizer = null; }, this.idleMs);
    this.idle.unref();
  }

  warm(): void {
    if (this.closed || this.downloading || !this.complete()) return;
    void this.load().then(() => this.touch(), () => {});
  }

  transcribe(samples: Float32Array): Promise<string> {
    const run = async (): Promise<string> => {
      if (this.closed) return '';
      await this.prepare();
      let recognizer;
      try {
        recognizer = await this.load();
      } catch (e) {
        this.error = `音声認識を起動できませんでした: ${String((e as Error)?.message ?? e)}`;
        this.onChange();
        throw new Error(this.error);
      }
      this.touch();
      const parts: string[] = [];
      for (const piece of splitAtPauses(samples, this.model.maxSeconds)) {
        const stream = recognizer.createStream();
        for (const [k, v] of Object.entries(this.model.streamOptions ?? {})) stream.setOption(k, v);
        stream.acceptWaveform({ samples: piece, sampleRate: SPEECH_SAMPLE_RATE });
        const result = await recognizer.decodeAsync(stream);
        const text = tidyTranscript(String(result?.text ?? ''));
        if (text) parts.push(text);
      }
      this.touch();
      return parts.join(new RegExp(`[${CJK}]$`).test(parts[0] ?? '') ? '' : ' ');
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  /** Let the loaded recogniser go now (another one was chosen); it loads again if this one is chosen back. */
  release(): void {
    if (this.idle) clearTimeout(this.idle);
    this.recognizer = null;
  }

  close(): void {
    this.closed = true;
    this.release();
  }
}

/** A recogniser that can be chosen in settings, and how far along its download is. */
export type SpeechChoice = SpeechStatus & { note: string };

/**
 * The recogniser chosen in settings (`chosen()`: a SpeechModel id; anything unknown is the default). Each model keeps
 * its own files; switching lets the other one's memory go, and downloads nothing until the new one is needed.
 */
export class ChosenSpeech implements Speech {
  private readonly each = new Map<string, SherpaSpeech>();
  private readonly chosen: () => string | undefined;
  private last = '';

  constructor(root: string, onChange: () => void, chosen: () => string | undefined, opts: Omit<SpeechOptions, 'model'> & { models?: readonly SpeechModel[] } = {}) {
    this.chosen = chosen;
    for (const model of opts.models ?? SPEECH_MODELS) this.each.set(model.id, new SherpaSpeech(root, onChange, { ...opts, model }));
  }

  private current(): SherpaSpeech {
    const wanted = this.chosen() ?? '';
    const id = this.each.has(wanted) ? wanted : this.each.has(DEFAULT_SPEECH_MODEL) ? DEFAULT_SPEECH_MODEL : [...this.each.keys()][0]!;
    if (this.last && this.last !== id) this.each.get(this.last)?.release();
    this.last = id;
    return this.each.get(id)!;
  }

  status(): SpeechStatus { return this.current().status(); }
  /** Every recogniser that can be chosen. */
  choices(): SpeechChoice[] { return [...this.each.values()].map((s) => ({ ...s.status(), note: s.note })); }
  prepare(): Promise<void> { return this.current().prepare(); }
  warm(): void { this.current().warm(); }
  transcribe(samples: Float32Array): Promise<string> { return this.current().transcribe(samples); }
  close(): void { for (const s of this.each.values()) s.close(); }
}

// The microphone: opened when the human starts speaking, closed the moment they stop. What it hears is kept in
// memory as 16 kHz mono samples (what the recogniser reads) and never touches the disk.
export const VOICE_RATE = 16000;

/** Why the microphone could not be opened, in the human's words. */
export function micProblem(e) {
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return 'マイクを使う許可がありません';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'マイクが見つかりません';
  return 'マイクを開けませんでした';
}

/** Float samples (-1..1) as 16-bit integers, the form they are sent in. */
export function toPcm16(chunks, length) {
  const pcm = new Int16Array(length);
  let at = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const v = Math.max(-1, Math.min(1, c[i]));
      pcm[at++] = v < 0 ? v * 32768 : v * 32767;
    }
  }
  return pcm;
}

/** Whether the microphone opens without asking the human (only then is it opened before a hold is certain). */
let granted = false;
try {
  globalThis.navigator?.permissions?.query({ name: 'microphone' }).then((p) => {
    granted = p.state === 'granted';
    p.onchange = () => { granted = p.state === 'granted'; };
  }, () => {});
} catch {}
export const micGranted = () => granted;

/**
 * Open the microphone and start keeping what it hears. Resolves once it is really listening with
 *   level()   how loud it is right now, 0..1 (for the picture on screen)
 *   stop()    stop and give back { pcm: Int16Array, seconds, peak }
 *   cancel()  stop and throw away
 * The device and the audio thread are made ready side by side: what is said is kept from as early as possible.
 */
export async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no microphone API'), { name: 'NotFoundError' });
  const asking = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  let ctx;
  let stream = null;
  const release = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    void ctx?.close().catch(() => {});
  };
  try {
    // The context itself runs at the recogniser's rate, so the browser does the resampling.
    ctx = new AudioContext({ sampleRate: VOICE_RATE, latencyHint: 'interactive' });
    const [heard, loaded] = await Promise.allSettled([asking, ctx.audioWorklet.addModule('/js/logic/voice-worklet.js')]);
    if (heard.status === 'fulfilled') stream = heard.value;
    if (heard.status === 'rejected') throw heard.reason;
    if (loaded.status === 'rejected') throw loaded.reason;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(ctx, 'orrery-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    const chunks = [];
    let length = 0;
    let level = 0;
    let peak = 0;
    tap.port.onmessage = (e) => {
      const f = e.data;
      chunks.push(f);
      length += f.length;
      let sum = 0;
      for (let i = 0; i < f.length; i++) {
        sum += f[i] * f[i];
        const a = f[i] < 0 ? -f[i] : f[i];
        if (a > peak) peak = a;
      }
      // Speech at a normal distance is around 0.05–0.2 RMS: stretch that over most of 0..1.
      level = Math.min(1, Math.sqrt(sum / f.length) * 6);
    };
    source.connect(tap);
    const end = () => {
      tap.port.onmessage = null;
      source.disconnect();
      release();
    };
    return {
      level: () => level,
      stop() {
        end();
        return { pcm: toPcm16(chunks, length), seconds: length / VOICE_RATE, peak };
      },
      cancel: end,
    };
  } catch (e) {
    if (!stream) void asking.then((s) => { for (const t of s.getTracks()) t.stop(); }, () => {});
    release();
    throw e;
  }
}

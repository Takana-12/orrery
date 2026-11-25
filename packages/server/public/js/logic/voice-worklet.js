// Runs on the audio thread: hands the microphone's samples to the page, a few dozen times a second.
// (An AudioWorklet module: loaded by voice-capture.js, not imported.)
const BATCH = 512; // 32 ms at 16 kHz: often enough for the level to follow the voice

class OrreryTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BATCH);
    this.at = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let from = 0;
    while (from < ch.length) {
      const n = Math.min(ch.length - from, BATCH - this.at);
      this.buf.set(ch.subarray(from, from + n), this.at);
      this.at += n;
      from += n;
      if (this.at === BATCH) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(BATCH);
        this.at = 0;
      }
    }
    return true;
  }
}

registerProcessor('orrery-tap', OrreryTap);

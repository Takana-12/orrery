// Talking to the Orrery server: JSON calls, file upload, and the state stream. Every answer is { status, body };
// status 0 means the server could not be reached (nothing was sent).
import { store } from './store.js';

export async function api(path, body) {
  try {
    const r = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-control-room-token': store.token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch {
    return { status: 0, body: { error: 'Orreryに接続できません。何も送信されていません。' } };
  }
}

/** Send a file as the request body (no JSON, no base64). */
export async function upload(path, file) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-control-room-token': store.token }, body: file });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, body: { error: 'Orreryに接続できません。添付されていません。' } };
  }
}

/**
 * Follow the server's state stream for as long as the page lives, reconnecting when it drops.
 * onState(snapshot) for every push; onStatus('connected' | 'lost' | 'refused') when the connection changes.
 */
export async function followState(onState, onStatus) {
  for (;;) {
    try {
      const r = await fetch('/api/stream', { headers: { 'x-control-room-token': store.token } });
      if (r.status === 401) return onStatus('refused');
      if (!r.ok) throw new Error(String(r.status));
      onStatus('connected');
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.startsWith('data: ')) onState(JSON.parse(chunk.slice(6)));
        }
      }
    } catch {}
    onStatus('lost');
    await new Promise((res) => setTimeout(res, 2000));
  }
}

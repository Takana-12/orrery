// Webhooks: posting a short message to a chat service (Discord, Slack) or any endpoint that takes JSON.
// What each service accepts differs (field name, length), so the address decides the shape. The address itself holds a
// token: callers keep it encrypted (Secrets) and never log it; errors from here never contain it.

export type HookKind = 'discord' | 'slack' | 'generic';

/** What a message to a webhook says. `ok` false: the run failed, and `text` says why. */
export interface HookMessage {
  title: string;
  workspace: string;
  text: string;
  ok: boolean;
  sessionId?: string | null;
}

/** Longest webhook address kept. */
const MAX_URL = 2048;
/** Discord refuses a message longer than 2000 characters; a long reply goes as several, up to this many. */
const DISCORD_LIMIT = 1900;
const DISCORD_PARTS = 5;
/** Slack shows up to about 4000 characters of `text` before it cuts the message itself. */
const SLACK_LIMIT = 3900;
const TIMEOUT_MS = 10_000;

export function hookKind(url: string): HookKind {
  try {
    const u = new URL(url);
    if (/(^|\.)discord(app)?\.com$/i.test(u.hostname) && u.pathname.startsWith('/api/webhooks/')) return 'discord';
    if (/^hooks\.slack\.com$/i.test(u.hostname)) return 'slack';
  } catch {}
  return 'generic';
}

/**
 * The address as it will be kept, or an error message for the human. Only https, except plain http to this machine
 * (a local endpoint being tried out).
 */
export function checkHookUrl(input: unknown): { url: string } | { error: string } {
  const raw = String(input ?? '').trim();
  if (!raw) return { error: 'Webhook の URL が空です' };
  if (raw.length > MAX_URL) return { error: 'Webhook の URL が長すぎます' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'Webhook の URL として読めません（https:// から始まる URL を貼り付けてください）' };
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { error: 'Webhook の URL は https:// から始まるものにしてください' };
  return { url: u.toString() };
}

/** What the screen may show of a saved address: the service and its host, never the token in its path. */
export function hookLabel(url: string): { kind: HookKind; host: string } {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {}
  return { kind: hookKind(url), host };
}

/** Cut `text` into pieces of at most `limit` characters, at a line break where there is one near the end. */
export function splitForLimit(text: string, limit: number, maxParts: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit && parts.length < maxParts - 1) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length > limit) rest = `${rest.slice(0, limit - 20).trimEnd()}\n…（続きは Orrery で）`;
  parts.push(rest);
  return parts.filter((p) => p.trim());
}

/** The message as one line of heading and the body, plain text. */
export function messageText(m: HookMessage, bold: (s: string) => string): string {
  const head = `${m.ok ? '' : '失敗: '}${bold(m.title)}${m.workspace ? `（${m.workspace}）` : ''}`;
  return m.text.trim() ? `${head}\n${m.text.trim()}` : head;
}

/** The request bodies to send for this message, in order (Discord may need several). */
export function hookBodies(kind: HookKind, m: HookMessage): unknown[] {
  if (kind === 'discord') {
    // Nobody is pinged by what an agent wrote (@everyone in a reply stays text).
    return splitForLimit(messageText(m, (s) => `**${s}**`), DISCORD_LIMIT, DISCORD_PARTS).map((content) => ({ content, username: 'Orrery', allowed_mentions: { parse: [] } }));
  }
  if (kind === 'slack') return [{ text: splitForLimit(messageText(m, (s) => `*${s}*`), SLACK_LIMIT, 1)[0] }];
  return [{ text: messageText(m, (s) => s), title: m.title, workspace: m.workspace, ok: m.ok, sessionId: m.sessionId ?? null, at: new Date().toISOString() }];
}

/** POST one JSON body. Throws with a short reason (status and the start of the answer), never the address. */
async function postOnce(url: string, body: unknown): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    } catch (e) {
      const name = (e as Error)?.name;
      throw new Error(name === 'TimeoutError' ? '送信先が10秒以内に応答しませんでした' : '送信先に接続できませんでした');
    }
    if (res.ok) return;
    // Too many at once (Discord: 5 per 2 seconds): wait as asked, once.
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(5000, Math.max(500, Number(res.headers.get('retry-after') ?? '1') * 1000));
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const said = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`送信先が ${res.status} を返しました${said ? `: ${said}` : ''}`);
  }
}

/** Send a message to a webhook, in as many posts as the service needs. */
export async function postHook(url: string, m: HookMessage): Promise<void> {
  for (const body of hookBodies(hookKind(url), m)) await postOnce(url, body);
}

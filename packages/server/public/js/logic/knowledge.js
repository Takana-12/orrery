// The human's standing preferences (こだわり) as the screens see them. Pure: no DOM, no network.
// The limits come with the snapshot (the server's own numbers), so what is shown here is what is actually cut.

/** Above this share of a limit the number turns to a warning colour; at the limit, to an alarm. */
export const WARN_AT = 0.8;

/** 'ok' | 'warn' | 'full' for `used` of `max`. */
export function tone(used, max) {
  if (!max) return 'ok';
  if (used >= max) return 'full';
  return used / max >= WARN_AT ? 'warn' : 'ok';
}

/** One preference's line as it is sent (the same form as the core's knowledgeLine): its text, and nothing else. */
export const sentLine = (e, max = 5000) => String(e.text).slice(0, max);
const combine = (entries) => [...new Set([...entries].sort((a, b) => a.createdAt - b.createdAt).map((e) => String(e.text).trim()).filter(Boolean))].join('\n\n');

/**
 * How much of each limit is used: per preference (characters), per area (preferences, characters) and in all (the
 * characters sent if every area went, against the budget and against the line under which everything is sent).
 */
export function knowledgeUsage(state) {
  const k = state?.knowledge;
  if (!k) return null;
  const L = k.limits;
  const perEntry = new Map();
  for (const e of k.entries) perEntry.set(e.id, { used: String(e.text).length, max: L.sectionText, tone: tone(String(e.text).length, L.sectionText) });
  const perDomain = new Map();
  let total = 0;
  for (const d of k.domains) {
    const mine = k.entries.filter((e) => e.domainId === d.id);
    const chars = combine(mine).length;
    const attached = Math.min(chars, L.sectionText);
    total += chars ? `### ${d.name}`.length + 2 + attached : 0;
    perDomain.set(d.id, { chars, maxChars: L.sectionText, attached, tone: tone(chars, L.sectionText) });
  }
  if (total) total += (k.heading ?? '').length;
  return {
    perEntry,
    perDomain,
    total: { chars: total, routeThreshold: L.routeThreshold, routed: total > L.routeThreshold },
    limits: L,
  };
}

/** What was recorded by itself and not yet looked at: only the lines it added, in full, newest section first. */
export function knowledgeNews(state) {
  const k = state?.knowledge;
  if (!k) return { count: 0, lines: [] };
  const fresh = k.entries.filter((e) => !e.seen).sort((a, b) => b.updatedAt - a.updatedAt);
  const lines = [...new Set(fresh.flatMap(addedLines))];
  return { count: lines.length, lines };
}

/** The lines of an entry that are new to the human, in full (an entry recorded before they were kept: all of it). */
function addedLines(e) {
  if (e.seen) return [];
  return e.added ?? String(e.text).split('\n').map((l) => l.trim()).filter(Boolean);
}

/** The areas in order, each with its preferences (most repeated first, then oldest first). */
export function knowledgeModel(state) {
  const k = state?.knowledge;
  if (!k) return [];
  return [...k.domains].sort((a, b) => a.order - b.order).map((d) => ({
    domain: d,
    entries: k.entries.filter((e) => e.domainId === d.id).sort((a, b) => a.createdAt - b.createdAt),
  }));
}

/** What one preference puts on the clipboard: its text as it is. */
export const entryClipboard = (e) => String(e.text);

/** What one area puts on the clipboard: its name as a heading and its preferences as they are sent (most repeated first). */
export function domainClipboard(state, domainId) {
  const m = knowledgeModel(state).find((x) => x.domain.id === domainId);
  if (!m) return '';
  const prompt = combine(m.entries);
  return [`### ${m.domain.name}`, prompt].filter(Boolean).join('\n');
}

/** The こだわり chat as the screen sees it: the conversation, whether a message is being read, and the longest message. */
export function tuneModel(state) {
  const t = state?.knowledge?.tune;
  return { messages: t?.messages ?? [], busy: !!t?.busy, max: t?.max ?? 12000 };
}

const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const text = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

// ---- expected effects (the server is expected to do the same; its next picture corrects any difference) ----

export const knowledgeSettingsEffect = (patch) => (state) => {
  const now = state.settings.knowledge ?? { capture: true, inject: true };
  const next = { ...now, capture: patch.capture === undefined ? now.capture : patch.capture !== false, inject: patch.inject === undefined ? now.inject : patch.inject !== false };
  for (const key of ['captureAi', 'tuneAi']) {
    const ai = patch[key];
    if (!ai || typeof ai !== 'object') continue;
    next[key] = { provider: ai.provider === 'codex' ? 'codex' : 'claude', model: String(ai.model ?? '').trim().slice(0, 120), effort: String(ai.effort ?? '').trim().slice(0, 30) };
  }
  state.settings = { ...state.settings, knowledge: next };
};

export const entryAddEffect = (tempId, input) => (state) => {
  const k = state.knowledge;
  if (!k) return;
  const t = text(input.text, Infinity);
  if (!t) return;
  const entry = { id: tempId, domainId: input.domainId, text: t, sessionId: null, scope: input.scope ?? 'all', hits: 1, createdAt: Date.now(), updatedAt: Date.now(), seen: true };
  mergeSection(state, entry);
};

const scopedText = (state, e) => {
  if (!e.scope || e.scope === 'all') return e.text;
  const p = state.projects.find((p) => p.id === e.scope);
  return `プロジェクト「${p?.name ?? e.scope}」${p ? `（${p.rootPath}）` : ''}に限り、次の方針を適用する。\n${e.text}`;
};

/** Mirror the core's section merge, including moves to an already populated section. */
function mergeSection(state, entry) {
  const k = state.knowledge;
  const target = k.entries.filter((e) => e.domainId === entry.domainId && e.id !== entry.id);
  const all = [...target, entry].sort((a, b) => a.createdAt - b.createdAt);
  const merged = {
    ...all[0], id: target[0]?.id ?? entry.id, domainId: entry.domainId, scope: 'all',
    text: combine(all.map((e) => ({ ...e, text: scopedText(state, e) }))),
    hits: all.reduce((n, e) => n + e.hits, 0),
    seen: entry.seen, updatedAt: Date.now(),
  };
  k.entries = k.entries.filter((e) => e.id !== entry.id && e.domainId !== entry.domainId);
  k.entries.push(merged);
}

export const entryUpdateEffect = (entryId, patch) => (state) => {
  const k = state.knowledge;
  const saved = k?.entries.find((x) => x.id === entryId);
  if (!saved) return;
  const e = { ...saved };
  if (patch.text !== undefined) {
    const t = text(patch.text, Infinity);
    if (!t) {
      k.entries = k.entries.filter((x) => x.id !== entryId);
      return;
    }
    e.text = t;
  }
  if (patch.domainId !== undefined && k.domains.some((d) => d.id === patch.domainId)) e.domainId = patch.domainId;
  if (patch.scope !== undefined) e.scope = patch.scope;
  e.seen = true;
  k.entries = k.entries.filter((x) => x.id !== entryId);
  mergeSection(state, e);
};

export const entryRemoveEffect = (entryId) => (state) => {
  const k = state.knowledge;
  if (!k) return;
  k.entries = k.entries.filter((e) => e.id !== entryId);
};

export const domainSetEffect = (domainId, patch) => (state) => {
  const k = state.knowledge;
  if (!k) return;
  let d = k.domains.find((x) => x.id === domainId);
  if (!d) {
    d = { id: domainId, name: '', description: '', always: false, order: Math.max(-1, ...k.domains.map((x) => x.order)) + 1 };
    k.domains.push(d);
  }
  if (patch.name !== undefined) d.name = line(patch.name, k.limits.domainName) || d.name;
  if (patch.description !== undefined) d.description = line(patch.description, k.limits.domainDescription);
  if (patch.always !== undefined) d.always = !!patch.always;
};

export const domainRemoveEffect = (domainId) => (state) => {
  const k = state.knowledge;
  if (!k || domainId === 'other') return;
  k.domains = k.domains.filter((d) => d.id !== domainId);
  for (const e of k.entries.filter((e) => e.domainId === domainId)) {
    k.entries = k.entries.filter((x) => x.id !== e.id);
    const seen = e.seen && k.entries.filter((x) => x.domainId === 'other').every((x) => x.seen);
    mergeSection(state, { ...e, domainId: 'other', seen });
  }
};

/** The human's message in the こだわり chat: shown at once, with the reading under way. */
export const tuneSendEffect = (tempId, text) => (state) => {
  const k = state.knowledge;
  if (!k) return;
  const t = k.tune ?? { messages: [], busy: false, max: 12000 };
  k.tune = { ...t, busy: true, messages: [...t.messages, { id: tempId, role: 'human', text: String(text).trim(), at: Date.now() }] };
};

export const knowledgeSeenEffect = () => (state) => {
  const k = state.knowledge;
  if (!k) return;
  for (const e of k.entries) e.seen = true;
  k.unseen = 0;
};

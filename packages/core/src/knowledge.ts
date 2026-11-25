// The human's standing preferences (こだわり), kept by area. Pure functions only: what the limits are, which
// preferences hold for a project, and how the ones that bear on new work are written at the head of its first message.
import type { CoreState, KnowledgeDomain, KnowledgeEntry, KnowledgeState } from './types.ts';

/**
 * Every limit in one place. The settings screen shows how much of each is used, from these same numbers (they go out
 * with the snapshot), so what it shows and what is actually cut never disagree.
 */
export const KNOWLEDGE_LIMITS = {
  /** Characters attached from each section. Stored text is kept intact, including older, longer sections. */
  sectionText: 5000,
  domainName: 40,
  domainDescription: 200,
  domains: 30,
  /** Up to this many characters, everything that holds is sent without asking which areas bear on the work. */
  routeThreshold: 1500,
  /** Areas chosen for one piece of work, besides the ones always sent. */
  maxRoutedDomains: 3,
} as const;

/** The area that takes whatever fits no other. It cannot be removed: removing another area moves its preferences here. */
export const OTHER_DOMAIN_ID = 'other';

const DEFAULT_DOMAINS: Omit<KnowledgeDomain, 'order'>[] = [
  { id: 'ui', name: 'UI・操作感', description: '画面の見た目、操作したときの反応、レイアウト、表示する言葉の量', always: false },
  { id: 'writing', name: '文章・言葉づかい', description: '文章の構成、言葉の選び方、説明や報告の書き方', always: false },
  { id: 'code', name: 'コード構造・設計', description: 'ファイルや層の分け方、命名、設計の方針', always: false },
  { id: 'workflow', name: '進め方・git・報告', description: '作業の進め方、ブランチやコミット、マージ、報告のしかた', always: false },
  { id: 'verify', name: '確認・テスト', description: 'テストの書き方、動作確認のしかた、「完了」の判断', always: false },
  { id: OTHER_DOMAIN_ID, name: 'その他', description: 'どの領域にも当てはまらないこだわり', always: false },
];

export function defaultKnowledge(): KnowledgeState {
  return {
    domains: new Map(DEFAULT_DOMAINS.map((d, i) => [d.id, { ...d, order: i }])),
    entries: new Map(),
  };
}

/** One line of text, folded and cut to `max`. */
export function cleanLine(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Text that may keep its line breaks (a preference may be a short list), cut to `max`. */
export function cleanText(value: unknown, max: number): string {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

export function domainsInOrder(k: KnowledgeState): KnowledgeDomain[] {
  return [...k.domains.values()].sort((a, b) => a.order - b.order);
}

/** The preferences that hold in a project: those for every project and those for it, in an area that exists. */
export function entriesFor(k: KnowledgeState, projectId: string | null): KnowledgeEntry[] {
  return [...k.entries.values()].filter((e) => k.domains.has(e.domainId) && (e.scope === 'all' || e.scope === projectId)).sort((a, b) => a.createdAt - b.createdAt);
}

/** Join existing rules into one prompt, keeping their order and paragraphs. Never cut stored content. */
export function combineKnowledgeText(texts: readonly string[]): string {
  return [...new Set(texts.map((text) => cleanText(text, Infinity)).filter(Boolean))].join('\n\n');
}

/** Preserve a legacy project restriction in the unified prompt instead of silently making it universal. */
export function scopedKnowledgeText(state: Pick<CoreState, 'projects'>, scope: string, text: string): string {
  if (scope === 'all') return text;
  const project = state.projects.get(scope);
  return `プロジェクト「${project?.name ?? scope}」${project ? `（${project.rootPath}）` : ''}に限り、次の方針を適用する。\n${text}`;
}

/** A section's entries become one prompt. Used by migration, appends and moves; no model or I/O is needed. */
export function mergeKnowledgeEntries(state: Pick<CoreState, 'projects'>, entries: readonly KnowledgeEntry[], domainId: string): KnowledgeEntry {
  const ordered = [...entries].sort((a, b) => a.createdAt - b.createdAt);
  return {
    ...ordered[0]!,
    domainId,
    text: combineKnowledgeText(ordered.map((e) => scopedKnowledgeText(state, e.scope, e.text))),
    scope: 'all',
    hits: ordered.reduce((hits, e) => hits + e.hits, 0),
    updatedAt: Math.max(...ordered.map((e) => e.updatedAt)),
    seen: ordered.every((e) => e.seen),
  };
}

/** The section prompt as attached. Line breaks are part of the prompt. */
export function knowledgeLine(e: Pick<KnowledgeEntry, 'text'>): string {
  return e.text.slice(0, KNOWLEDGE_LIMITS.sectionText);
}

export const KNOWLEDGE_HEADING = '## ユーザーのこだわり（この作業に関係する領域のみ）';

export interface RenderedKnowledge {
  /** Empty when nothing is sent. */
  text: string;
  /** Names of the areas that made it in, in order. */
  domains: string[];
  /** Sections whose tail was left out by their attachment limit. Stored text is unchanged. */
  dropped: number;
}

/**
 * The preferences of the given areas that hold in the project, as they are put at the head of the first message.
 * Each section is one prompt, at most sectionText characters. There is no shared budget that drops later sections.
 */
export function renderKnowledge(k: KnowledgeState, domainIds: Iterable<string>, projectId: string | null): RenderedKnowledge {
  const wanted = new Set(domainIds);
  const held = entriesFor(k, projectId);
  const parts: string[] = [KNOWLEDGE_HEADING];
  const names: string[] = [];
  let dropped = 0;
  for (const d of domainsInOrder(k)) {
    if (!wanted.has(d.id)) continue;
    const text = combineKnowledgeText(held.filter((e) => e.domainId === d.id).map((e) => e.text));
    if (!text) continue;
    if (text.length > KNOWLEDGE_LIMITS.sectionText) dropped++;
    parts.push(`### ${d.name}`, knowledgeLine({ text }));
    names.push(d.name);
  }
  return names.length ? { text: parts.join('\n'), domains: names, dropped } : { text: '', domains: [], dropped };
}

/** How new work gets its preferences. */
export type KnowledgePlan =
  /** Nothing to send (turned off, or nothing holds). */
  | { kind: 'none' }
  /** Little enough to send all of it: asking which areas bear on the work would cost more than it saves. */
  | { kind: 'all'; domainIds: string[] }
  /** Ask which of `candidates` bear on the work; `always` go whatever the answer. */
  | { kind: 'route'; candidates: KnowledgeDomain[]; always: string[] };

export function planKnowledge(state: Pick<CoreState, 'knowledge' | 'settings'>, projectId: string | null): KnowledgePlan {
  const k = state.knowledge;
  if (!state.settings.knowledge.inject) return { kind: 'none' };
  const held = entriesFor(k, projectId);
  if (!held.length) return { kind: 'none' };
  const withEntries = domainsInOrder(k).filter((d) => held.some((e) => e.domainId === d.id));
  const ids = withEntries.map((d) => d.id);
  if (renderKnowledge(k, ids, projectId).text.length <= KNOWLEDGE_LIMITS.routeThreshold) return { kind: 'all', domainIds: ids };
  return { kind: 'route', candidates: withEntries, always: withEntries.filter((d) => d.always).map((d) => d.id) };
}

/** The areas to send: the ones always sent, plus up to `maxRoutedDomains` of those chosen that are candidates. */
export function chooseDomains(plan: Extract<KnowledgePlan, { kind: 'route' }>, chosen: readonly string[] | null): string[] {
  const known = new Set(plan.candidates.map((d) => d.id));
  const picked = (chosen ?? []).filter((id) => known.has(id) && !plan.always.includes(id)).slice(0, KNOWLEDGE_LIMITS.maxRoutedDomains);
  return [...new Set([...plan.always, ...picked])];
}

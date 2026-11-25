// The human's standing preferences (こだわり): picked up from what they say, kept by area, and sent with new work.
//  heard()         every instruction, follow-up and refusal-with-a-reason is read (in the background, one at a time)
//                  for preferences that would hold every time. Found ones are recorded at once, said in the work's
//                  record, and counted in the inbox until the human has looked at them in the settings.
//  preferencesFor() what new work gets: everything when there is little, otherwise only the areas the helper model
//                  says bear on the instruction (and those always sent). Never holds the work up for long.
//  apply()         the one way to change the record from a helper model's answer (new areas, additions, rewrites,
//                  moves, removals, repeats), shared by heard() and the こだわり chat (knowledge-tune.ts).
// The policy (limits, what holds where, how it is written) is the core's; this adds the helper model and the record.
import { KNOWLEDGE_LIMITS, OTHER_DOMAIN_ID, chooseDomains, domainsInOrder, planKnowledge, renderKnowledge } from '#core';
import type { RenderedKnowledge } from '#core';
import type { Assistant, DomainBrief, NewDomain } from './assistant.ts';
import { HttpError } from './errors.ts';
import type { Journal } from './journal.ts';
import { message } from './runtime.ts';
import type { Runtime } from './runtime.ts';

/** How long new work waits for the choice of areas before it goes with the ones always sent. */
export const ROUTE_TIMEOUT_MS = 8000;

const NOTHING: RenderedKnowledge = { text: '', domains: [], dropped: 0 };

/** One change made to the record, as the human is told of it: which kind (one icon each), in which area, and the text. */
export interface KnowledgeChange {
  kind: 'domain' | 'add' | 'update' | 'move' | 'remove' | 'reinforce';
  /** The area's name (for 'domain': the new area's). */
  domain: string;
  /** The preference's text (for 'domain': the area's description). */
  text: string;
}

/** Changes to the record, as a helper model hands them over. Area fields hold an area's id or a `newDomains` key. */
export interface KnowledgeEdit {
  newDomains?: NewDomain[];
  /** `scope`: 'all', 'project' (the project of the work it was heard in) or a project's id. */
  add?: { domainId: string; text: string; scope: string }[];
  update?: { id: string; text: string | null; domainId: string | null }[];
  remove?: string[];
  reinforce?: string[];
}

export class Knowledge {
  private readonly rt: Runtime;
  private readonly journal: Journal;
  private readonly assistant: Assistant;
  private readonly redact: (text: string) => string;
  private readonly routeTimeoutMs: number;

  constructor(rt: Runtime, journal: Journal, assistant: Assistant, redact: (text: string) => string, routeTimeoutMs = ROUTE_TIMEOUT_MS) {
    this.rt = rt;
    this.journal = journal;
    this.assistant = assistant;
    this.redact = redact;
    this.routeTimeoutMs = routeTimeoutMs;
  }

  /** The areas as a helper model is shown them. */
  briefs(): DomainBrief[] {
    return domainsInOrder(this.rt.core.state.knowledge).map((d) => ({ id: d.id, name: d.name, description: d.description }));
  }

  // ---- picking up ------------------------------------------------------------------------------

  /**
   * The human said something to a piece of work. Read it, with the reply it answers, for standing preferences.
   * Returns at once; nothing here can get in the way of the work.
   */
  /** Picking up is on app-wide and for the project this work belongs to (each workspace can turn it off). */
  private capturing(sessionId: string): boolean {
    const { state } = this.rt.core;
    if (!state.settings.knowledge.capture) return false;
    const s = state.sessions.get(sessionId);
    return !s || state.projects.get(s.projectId)?.captureKnowledge !== false;
  }

  heard(sessionId: string, human: string): void {
    const { core } = this.rt;
    if (!this.capturing(sessionId)) return;
    const said = this.redact(String(human ?? '').trim());
    if (said.length < 4) return;
    const s = core.state.sessions.get(sessionId);
    if (!s) return;
    let agentBefore = '';
    try {
      agentBefore = this.redact(this.rt.store.turnReplies(sessionId, 4000) ?? '');
    } catch {}
    const choice = { ...(core.state.settings.knowledge.captureAi ?? { provider: 'claude', model: 'haiku', effort: '' }) };
    this.assistant.queue(
      async () => {
        const k = core.state.knowledge;
        const entries = [...k.entries.values()].map((e) => ({ id: e.id, domainId: e.domainId, text: e.text }));
        const reading = await this.assistant.extractPreferences({ human: said, agentBefore, domains: this.briefs(), entries, otherDomainId: OTHER_DOMAIN_ID, canAddDomain: k.domains.size < KNOWLEDGE_LIMITS.domains }, choice);
        return { reading, entries };
      },
      (result) => {
        const reading = result?.reading;
        if (!reading || this.rt.closing || !this.capturing(sessionId)) return;
        if (!this.canApply(reading, result.entries)) {
          this.journal.write(sessionId, 'system', '読み取り中にこだわりが編集されたため、自動記録による上書きを見送りました。');
          return;
        }
        const changes = this.apply(reading, { sessionId, projectId: s.projectId, seen: false });
        const made = changes.filter((c) => c.kind === 'domain').map((c) => `「${c.domain}」`);
        const recorded = changes.filter((c) => c.kind === 'add' || c.kind === 'update').map((c) => `- [${c.domain}] ${c.text}`);
        const again = changes.filter((c) => c.kind === 'reinforce').map((c) => `「${c.text.slice(0, 60)}」`);
        const lines: string[] = [];
        if (made.length) lines.push(`こだわりの領域を追加しました: ${made.join(' ')}`);
        if (recorded.length) lines.push(`こだわりを記録しました（設定 → こだわり で編集できます）:\n${recorded.join('\n')}`);
        if (again.length) lines.push(`記録済みのこだわりがまた出てきました: ${again.join(' ')}`);
        if (lines.length) this.journal.write(sessionId, 'system', lines.join('\n'));
      },
    );
  }

  /** A delayed full rewrite or removal must never overwrite a section edited after the model read it. */
  canApply(edit: KnowledgeEdit, before: { id: string; domainId: string; text: string }[]): boolean {
    const expected = new Map(before.map((e) => [e.id, e]));
    return [...(edit.update ?? []).map((e) => e.id), ...(edit.remove ?? [])].every((id) => {
      const old = expected.get(id);
      const now = this.rt.core.state.knowledge.entries.get(id);
      return old && now && old.text === now.text && old.domainId === now.domainId;
    });
  }

  /**
   * Change the record as a helper model asked, and answer what changed. Text goes through the secret filter; an
   * addition the same as one already recorded counts as a repeat; a new area is made only when something goes into it
   * and there is room (otherwise what was meant for it goes to その他). Nothing here throws: a change that cannot be made
   * is left out. `seen`: false when recorded behind the human's back (counted in the inbox until looked at).
   */
  apply(edit: KnowledgeEdit, ctx: { sessionId: string | null; projectId: string | null; seen: boolean }): KnowledgeChange[] {
    const { core } = this.rt;
    const k = () => core.state.knowledge;
    const name = (domainId: string) => k().domains.get(domainId)?.name ?? '?';
    const out: KnowledgeChange[] = [];
    // New areas first, so additions and moves can go into them.
    const keys = new Map<string, string>();
    const wanted = new Set<string | null>([...(edit.add ?? []).map((a) => a.domainId), ...(edit.update ?? []).map((u) => u.domainId)]);
    for (const d of edit.newDomains ?? []) {
      if (!wanted.has(d.key) || keys.has(d.key)) continue;
      const same = [...k().domains.values()].find((x) => x.name === d.name.trim());
      if (same) {
        keys.set(d.key, same.id);
        continue;
      }
      try {
        const id = core.setKnowledgeDomain({ name: this.redact(d.name), description: this.redact(d.description) });
        keys.set(d.key, id);
        out.push({ kind: 'domain', domain: name(id), text: k().domains.get(id)?.description ?? '' });
      } catch {}
    }
    const area = (id: string): string => keys.get(id) ?? (k().domains.has(id) ? id : OTHER_DOMAIN_ID);
    for (const id of edit.remove ?? []) {
      const e = k().entries.get(id);
      if (!e) continue;
      core.removeKnowledgeEntry(id);
      out.push({ kind: 'remove', domain: name(e.domainId), text: e.text });
    }
    for (const u of edit.update ?? []) {
      const e = k().entries.get(u.id);
      if (!e) continue;
      const before = { text: e.text, domainId: e.domainId };
      try {
        core.updateKnowledgeEntry(u.id, { text: u.text === null ? undefined : this.redact(u.text), domainId: u.domainId === null ? undefined : area(u.domainId), seen: ctx.seen });
      } catch {
        continue;
      }
      const now = k().entries.get(u.id) ?? [...k().entries.values()].find((x) => x.domainId === (u.domainId ? area(u.domainId) : before.domainId));
      if (!now) continue;
      if (now.text !== before.text) out.push({ kind: 'update', domain: name(now.domainId), text: now.text });
      else if (now.domainId !== before.domainId) out.push({ kind: 'move', domain: name(now.domainId), text: now.text });
    }
    for (const x of edit.add ?? []) {
      const text = this.redact(x.text).trim();
      const domainId = area(x.domainId);
      const same = [...k().entries.values()].find((e) => e.domainId === domainId && e.text === text);
      if (same) {
        core.reinforceKnowledgeEntry(same.id, { sessionId: ctx.sessionId });
        out.push({ kind: 'reinforce', domain: name(same.domainId), text: same.text });
        continue;
      }
      const scope = x.scope === 'project' ? (ctx.projectId ?? 'all') : x.scope;
      const existed = [...k().entries.values()].some((e) => e.domainId === domainId);
      const id = core.addKnowledgeEntry({ domainId, text, sessionId: ctx.sessionId, scope, seen: ctx.seen });
      const e = id ? k().entries.get(id) : null;
      if (e) out.push({ kind: existed ? 'update' : 'add', domain: name(e.domainId), text: e.text });
    }
    for (const id of edit.reinforce ?? []) {
      const e = k().entries.get(id);
      if (!e) continue;
      core.reinforceKnowledgeEntry(id, { sessionId: ctx.sessionId });
      out.push({ kind: 'reinforce', domain: name(e.domainId), text: e.text });
    }
    return out;
  }

  // ---- sending ---------------------------------------------------------------------------------

  /** The preferences new work in `projectId` gets, as they go at the head of its first message. Never rejects. */
  async preferencesFor(projectId: string, prompt: string): Promise<RenderedKnowledge> {
    try {
      const { state } = this.rt.core;
      const plan = planKnowledge(state, projectId);
      if (plan.kind === 'none') return NOTHING;
      if (plan.kind === 'all') return renderKnowledge(state.knowledge, plan.domainIds, projectId);
      const ac = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<null>((done) => {
        timer = setTimeout(() => {
          ac.abort();
          done(null);
        }, this.routeTimeoutMs);
      });
      const chosen = await Promise.race([
        this.assistant.model.routeKnowledge({ prompt, domains: plan.candidates.map((d) => ({ id: d.id, name: d.name, description: d.description })) }, ac.signal).catch(() => null),
        late,
      ]);
      clearTimeout(timer);
      return renderKnowledge(this.rt.core.state.knowledge, chooseDomains(plan, chosen), projectId);
    } catch {
      return NOTHING;
    }
  }

  // ---- what the human does in the settings -----------------------------------------------------

  private attempt<T>(f: () => T): T {
    try {
      return f();
    } catch (e) {
      throw new HttpError(400, KNOWN[message(e)] ?? message(e));
    }
  }

  setDomain(input: { id?: unknown; name?: unknown; description?: unknown; always?: unknown }): string {
    return this.attempt(() =>
      this.rt.core.setKnowledgeDomain({
        id: typeof input.id === 'string' && input.id ? input.id : undefined,
        name: input.name === undefined ? undefined : String(input.name ?? ''),
        description: input.description === undefined ? undefined : String(input.description ?? ''),
        always: input.always === undefined ? undefined : input.always === true,
      }),
    );
  }

  removeDomain(domainId: string): void {
    this.attempt(() => this.rt.core.removeKnowledgeDomain(domainId));
  }

  addEntry(input: { domainId?: unknown; text?: unknown; scope?: unknown }): string {
    const id = this.rt.core.addKnowledgeEntry({ domainId: String(input.domainId ?? ''), text: String(input.text ?? ''), scope: typeof input.scope === 'string' ? input.scope : 'all', seen: true });
    if (!id) throw new HttpError(400, '空のプロンプトは保存できません');
    return id;
  }

  updateEntry(entryId: string, patch: { text?: unknown; domainId?: unknown; scope?: unknown }): void {
    this.attempt(() =>
      this.rt.core.updateKnowledgeEntry(entryId, {
        text: patch.text === undefined ? undefined : String(patch.text ?? ''),
        domainId: typeof patch.domainId === 'string' ? patch.domainId : undefined,
        scope: typeof patch.scope === 'string' ? patch.scope : undefined,
      }),
    );
  }

  removeEntry(entryId: string): void {
    this.rt.core.removeKnowledgeEntry(entryId);
  }

  markSeen(): void {
    this.rt.core.markKnowledgeSeen();
  }
}

const KNOWN: Record<string, string> = {
  'unknown domain': '該当する領域がありません',
  'unknown entry': '該当するこだわりがありません',
  'empty name': '名前が空です',
  'too many domains': '領域の数が上限に達しています',
  'domain full': '移動先の領域が上限に達しています',
  'the catch-all domain stays': '「その他」は削除できません',
};

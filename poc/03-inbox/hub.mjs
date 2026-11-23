// The PoC "control core": owns sessions and attention items, enforces the answer state machine,
// and is the only place that decides whether an answer may be sent.
//
// AttentionItem.status:
//   pending   -> waiting for the human
//   answering -> answer handed to the provider, provider has not confirmed yet
//   resolved  -> provider confirmed (acknowledgement recorded)
//   expired   -> provider withdrew the request / turn ended / session gone; can no longer be answered
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';

export class Hub extends EventEmitter {
  constructor({ eventLog } = {}) {
    super();
    this.eventLog = eventLog;
    this.sessions = new Map();
    this.items = new Map();
    this.replies = new Map(); // itemId -> reply fn (never serialised)
    this.bySource = new Map(); // `${sessionId}|${sourceRequestId}` -> itemId
  }

  #record(type, data) {
    const evt = { t: new Date().toISOString(), type, ...data };
    if (this.eventLog) appendFileSync(this.eventLog, JSON.stringify(evt) + '\n');
    this.emit('change', evt);
  }

  createSession({ provider, cwd, projectName, task }) {
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      provider,
      cwd,
      projectName,
      task,
      status: 'starting',
      createdAt: Date.now(),
      providerSessionId: null,
      lastText: null,
    });
    this.#record('session.created', { sessionId: id, provider, projectName });
    return id;
  }

  sessionUpdate(sessionId, patch) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    Object.assign(s, patch, { updatedAt: Date.now() });
    // A turn that ended (any way) cannot still be waiting on a request: retire leftovers.
    if (['turn_finished', 'interrupted', 'error'].includes(patch.status)) {
      for (const item of this.items.values()) {
        if (item.sessionId === sessionId && item.status === 'pending') this.#expire(item, `turn ended (${patch.status})`);
      }
    }
    this.#record('session.updated', { sessionId, patch: { ...patch, lastText: patch.lastText?.slice?.(0, 200) } });
  }

  attentionOpen({ sessionId, sourceRequestId, type, title, questions = null, approval = null, raw, reply }) {
    const key = `${sessionId}|${sourceRequestId}`;
    // Idempotent on redelivery of the same provider request.
    if (this.bySource.has(key)) return this.bySource.get(key);
    const s = this.sessions.get(sessionId);
    const id = randomUUID();
    const item = {
      id,
      sessionId,
      provider: s.provider,
      projectName: s.projectName,
      task: s.task,
      sourceSessionId: s.providerSessionId,
      sourceRequestId,
      type,
      title,
      questions,
      approval,
      raw,
      status: 'pending',
      createdAt: Date.now(),
      response: null,
      acknowledgement: null,
      expiredReason: null,
    };
    this.items.set(id, item);
    this.replies.set(id, reply);
    this.bySource.set(key, id);
    s.status = 'waiting_for_user';
    this.#record('attention.opened', { itemId: id, sessionId, sourceRequestId, itemType: type });
    return id;
  }

  /**
   * The human's answer. Returns { ok } or { ok:false, code, error }.
   * Guarantees: an item is handed to its provider at most once, and only while it is still pending.
   */
  answer(itemId, answer) {
    const item = this.items.get(itemId);
    if (!item) return { ok: false, code: 404, error: 'unknown item' };
    if (item.status !== 'pending') return { ok: false, code: 409, error: `item is ${item.status}; answer not sent` };
    const reply = this.replies.get(itemId);
    item.status = 'answering';
    item.response = { answer, sentAt: Date.now() };
    try {
      reply(answer);
    } catch (e) {
      item.status = 'pending';
      item.response = null;
      return { ok: false, code: 500, error: String(e?.message ?? e) };
    }
    this.replies.delete(itemId);
    this.#record('attention.answer_sent', { itemId, sessionId: item.sessionId, sourceRequestId: item.sourceRequestId });
    return { ok: true };
  }

  /** Provider confirmed the request is settled. */
  attentionAcknowledged(sessionId, sourceRequestId, evidence) {
    const item = this.items.get(this.bySource.get(`${sessionId}|${sourceRequestId}`));
    if (!item) return;
    if (item.status === 'answering') {
      item.status = 'resolved';
      item.acknowledgement = { at: Date.now(), evidence, latencyMs: Date.now() - item.response.sentAt };
      this.#record('attention.acknowledged', { itemId: item.id, sessionId, sourceRequestId, evidence });
    } else if (item.status === 'pending') {
      // Settled without us (withdrawn, turn transition, answered elsewhere).
      this.#expire(item, `settled by provider (${evidence.via})`);
    }
  }

  attentionWithdrawn(sessionId, sourceRequestId, reason) {
    const item = this.items.get(this.bySource.get(`${sessionId}|${sourceRequestId}`));
    if (item && item.status === 'pending') this.#expire(item, reason);
  }

  #expire(item, reason) {
    item.status = 'expired';
    item.expiredReason = reason;
    this.replies.delete(item.id);
    this.#record('attention.expired', { itemId: item.id, sessionId: item.sessionId, reason });
  }

  snapshot() {
    const items = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
    const sessions = [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
    return {
      now: Date.now(),
      counts: {
        needsAttention: items.filter((i) => i.status === 'pending').length,
        running: sessions.filter((s) => ['starting', 'running'].includes(s.status)).length,
        waiting: sessions.filter((s) => s.status === 'waiting_for_user').length,
        finished: sessions.filter((s) => s.status === 'turn_finished').length,
        problems: sessions.filter((s) => ['error', 'interrupted'].includes(s.status)).length,
      },
      items,
      sessions,
    };
  }
}

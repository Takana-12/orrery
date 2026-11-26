// Client state: the latest picture of the server plus what the human is in the middle of (drafts, open tickets,
// work being sent). No DOM here: the UI subscribes and redraws; logic changes the store and calls changed().
//
// Feedback rule: what the human does shows at once. An action first puts its expected effect on top of the server's
// picture (optimistic()), then asks the server. If the server refuses, the effect is taken back and the reason is
// shown; if it accepts, the effect stays until the server's own next picture replaces it.
import { recount } from './optimistic.js';

/** How long a confirmed effect is kept if the server sends no new picture (the action changed nothing visible). */
const CONFIRMED_KEEP_MS = 3000;
const NOTICE_MS = 7000;

export const store = {
  /** What the UI draws: the server's picture with the effects of unconfirmed actions on top. Null until the first picture. */
  state: null,
  /** The server's last picture, untouched. */
  server: null,
  /** Effects of actions the server has not shown yet: { apply(state), confirmed }. */
  effects: [],
  /** Per-start API token. */
  token: '',
  /** itemId -> { [questionId]: { picked:Set, free:string } } */
  drafts: new Map(),
  /** itemId -> deny message draft */
  notes: new Map(),
  /** itemId / sessionId -> message */
  errors: new Map(),
  /** sessionId -> text being written in its reply box */
  composerDrafts: new Map(),
  /** Sessions whose reply box was written to from elsewhere (voice input): the box takes its draft again when drawn. */
  composerFill: new Set(),
  /** sessionId -> effort selected for the next message, kept while other screens are open. Saved on send. */
  composerEfforts: new Map(),
  /** sessionId -> [{ id, text }] messages sent from here that the conversation record does not show yet. */
  outbox: new Map(),
  /** Sessions whose row in the inbox has its reply box open. */
  replying: new Set(),
  showAllFinished: false,
  /**
   * Works (by session id) and project checklists (`look:<projectId>`) whose every step is shown, also those that wait on
   * an earlier one. Otherwise only what can be done now shows, and the rest once that is ticked.
   */
  everyStep: new Set(),
  /** Requests expanded in the inbox. One opens by itself; answering it opens the next. Several may be open at once. */
  expanded: new Set(),
  /** The human closed every request on purpose: do not reopen one by itself. */
  userCollapsed: false,
  lastOpenIds: [],
  /** New work just sent: shown in the rail at once, before the control room has answered. */
  sending: [],
  /** What is being written on the new-work screen, kept while other screens are open. `planMode` belongs to this one
   *  request only: off by default, cleared once it is sent or another workspace is chosen, never saved anywhere.
   *  `fill`: words to put into the box the next time it is drawn (what was said by voice, to be corrected by hand). */
  // workspaces: the ones ticked in the box (main first), kept while another screen is open; null = not touched yet.
  newDraft: { prompt: '', error: '', sent: null, planMode: false, fill: null, workspaces: null },
  /** Voice input, the layer above the screens (see voice.js for the phases). */
  voice: { phase: 'off', mode: 'hold', live: false, text: '', tasks: [], error: '', replyTo: '' },
  /** Last plan-limit reading per service (from /api/usage), shared by the rail's batteries and the usage screen. */
  limitsCache: null,
  /** The human asked to stop the whole app: the page shows that it is stopping and takes no more input. */
  shuttingDown: false,
  updating: false,
  /** "今すぐ確認" was pressed and GitHub has not answered yet. */
  checkingUpdate: false,
  /** Short messages about something that just happened elsewhere on the page: [{ id, text, tone }]. */
  notices: [],
  /** Side chat windows, oldest first (see chats.js). */
  chatWindows: [],
  /** Chats closed from here: not given a window again while the server still lists them. */
  closingChats: new Set(),

  listeners: new Set(),
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  /** Something the UI shows changed: redraw now (synchronously, so callers can touch the new DOM right after). */
  changed() {
    for (const fn of this.listeners) fn();
  },

  /** A new picture from the server. Effects it already had the chance to include are dropped. */
  receive(snapshot) {
    this.server = snapshot;
    this.effects = this.effects.filter((e) => !e.confirmed);
    this.rebuild();
    this.changed();
  },

  rebuild() {
    if (!this.server || !this.effects.length) {
      this.state = this.server;
      return;
    }
    const state = structuredClone(this.server);
    for (const e of this.effects) e.apply(state);
    recount(state);
    this.state = state;
  },

  /**
   * Show the expected effect of an action from this instant. Returns a handle for when the server has answered:
   * confirm() (keep it until the server's next picture) or fail() (take it back).
   */
  optimistic(apply) {
    const effect = { apply, confirmed: false };
    this.effects.push(effect);
    this.rebuild();
    this.changed();
    const drop = () => {
      const at = this.effects.indexOf(effect);
      if (at < 0) return;
      this.effects.splice(at, 1);
      this.rebuild();
      this.changed();
    };
    return {
      confirm: () => {
        effect.confirmed = true;
        setTimeout(drop, CONFIRMED_KEEP_MS).unref?.();
      },
      fail: drop,
    };
  },

  /** Tell the human something that happened away from where they are looking (a refusal after they moved on). */
  notice(text, tone = 'bad') {
    const n = { id: `${Date.now()}-${Math.random()}`, text, tone };
    this.notices.push(n);
    this.changed();
    setTimeout(() => this.dismissNotice(n.id), NOTICE_MS).unref?.();
  },
  dismissNotice(id) {
    const at = this.notices.findIndex((n) => n.id === id);
    if (at < 0) return;
    this.notices.splice(at, 1);
    this.changed();
  },
};

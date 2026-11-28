// The API as a table: which request maps to which use case. Nothing here decides anything; it reads the request,
// calls the application, and shapes the answer.
import type { App } from '../../app.ts';
import { HttpError } from '../../application/errors.ts';
import { MAX_VOICE_BYTES } from '../../application/voice.ts';

/** Provided by the desktop app shell; absent when started from the console. */
export interface AppUpdater {
  status(): unknown;
  /** Rebuild from the source folder and restart into the new build. Returns once the build has started. */
  update(): Promise<void>;
  /** Restart without rebuilding. */
  restart(): Promise<void>;
  /** Ask GitHub now whether a newer version is there (also done by itself at start and every hour). */
  check?(): Promise<unknown>;
  /** A newer version waiting on GitHub, or null. Sent with every state so each screen can show it. */
  newVersion?(): unknown;
}

/** The state every screen is drawn from, plus whether the app itself has a newer version on GitHub. */
export const stateOf = (app: App, appUpdate?: AppUpdater) => ({ ...app.snapshot(), newVersion: appUpdate?.newVersion?.() ?? null });

export interface RouteContext {
  app: App;
  /** Capture groups of the route's path pattern. */
  params: string[];
  query: URLSearchParams;
  /** Parsed JSON body (POST), or the raw bytes for a `raw` route. */
  body: any;
  appUpdate?: AppUpdater;
  onShutdownRequest?: () => void;
}

/** An answer with a status other than 200, or something to do once the answer has gone out. */
export class Reply {
  readonly status: number;
  readonly body: unknown;
  readonly after?: () => void;
  constructor(status: number, body: unknown, after?: () => void) {
    this.status = status;
    this.body = body;
    this.after = after;
  }
}

export interface Route {
  method: 'GET' | 'POST';
  path: RegExp;
  /** The body is the file itself (no JSON), up to this many bytes. */
  rawLimit?: number;
  handle(c: RouteContext): unknown | Promise<unknown>;
}

/** Largest file that can be attached to a message. */
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const OK = { ok: true };
const ID = '([\\w-]+)';
const get = (path: string, handle: Route['handle']): Route => ({ method: 'GET', path: new RegExp(`^${path}$`), handle });
const post = (path: string, handle: Route['handle']): Route => ({ method: 'POST', path: new RegExp(`^${path}$`), handle });
const provider = (v: string | undefined) => v as 'claude' | 'codex';

export const ROUTES: Route[] = [
  // ---- reading ----
  get('/api/state', ({ app, appUpdate }) => stateOf(app, appUpdate)),
  get(`/api/sessions/${ID}/transcript`, ({ app, params, query }) => {
    const before = query.get('before');
    const after = query.get('after');
    return { entries: app.store.readTranscript(params[0]!, 200, { before: before ? Number(before) : undefined, after: after ? Number(after) : undefined }) };
  }),
  get('/api/models/(claude|codex)', async ({ app, params }) => ({ models: await app.listModels(provider(params[0])) })),
  get('/api/app-update', ({ appUpdate }) => (appUpdate ? appUpdate.status() : { mode: 'console' })),
  get('/api/storage', ({ app }) => app.storage()),
  get('/api/usage', ({ app }) => app.usageSummary()),
  get(`/api/projects/${ID}/env`, ({ app, params }) => ({ vars: app.listEnv(params[0]!) })),
  get(`/api/raw/${ID}`, ({ app, params }) => {
    const raw = app.store.readRaw(params[0]!);
    return raw === null ? new Reply(404, { error: 'not found' }) : raw;
  }),

  // ---- the app itself ----
  { method: 'POST', path: /^\/api\/attachments$/, rawLimit: MAX_ATTACHMENT_BYTES, handle: ({ app, query, body }) => app.saveAttachment(query.get('name') ?? '', body) },
  post('/api/projects', ({ app, body }) => ({ projectId: app.addProject(String(body.path ?? ''), body.name) })),
  post(`/api/projects/${ID}/rename`, ({ app, params, body }) => ({ name: app.renameProject(params[0]!, String(body.name ?? '')) })),
  post(`/api/projects/${ID}/options`, ({ app, params, body }) => {
    app.setProjectOptions(params[0]!, { useWorktree: body.useWorktree, preamble: body.preamble, approvalMode: body.approvalMode, captureKnowledge: body.captureKnowledge, description: body.description });
    return OK;
  }),
  post('/api/pick-folder', async ({ app }) => ({ path: await app.pickFolder() })),
  post('/api/open-path', ({ app, body }) => app.openPath(String(body.path ?? ''), typeof body.sessionId === 'string' ? body.sessionId : null)),
  post('/api/settings', ({ app, body }) => ({ settings: app.setSettings(body) })),
  // ---- the human's standing preferences (こだわり) ----
  post('/api/knowledge/domains', ({ app, body }) => ({ domainId: app.setKnowledgeDomain(body ?? {}) })),
  post(`/api/knowledge/domains/${ID}/remove`, ({ app, params }) => (app.removeKnowledgeDomain(params[0]!), OK)),
  post('/api/knowledge/entries', ({ app, body }) => ({ entryId: app.addKnowledgeEntry(body ?? {}) })),
  post(`/api/knowledge/entries/${ID}`, ({ app, params, body }) => (app.updateKnowledgeEntry(params[0]!, body ?? {}), OK)),
  post(`/api/knowledge/entries/${ID}/remove`, ({ app, params }) => (app.removeKnowledgeEntry(params[0]!), OK)),
  post('/api/knowledge/seen', ({ app }) => (app.markKnowledgeSeen(), OK)),
  post('/api/knowledge/tune', ({ app, body }) => (app.sendKnowledgeTune(body?.text), OK)),
  post('/api/app-update/check', async ({ appUpdate }) => {
    if (!appUpdate?.check) throw new HttpError(400, 'コンソールから起動しているため、ここからは確認できません。');
    return appUpdate.check();
  }),
  post('/api/app-update/(update|restart)', async ({ appUpdate, params }) => {
    if (!appUpdate) throw new HttpError(400, 'コンソールから起動しているため、ここからは更新できません。');
    try {
      await (params[0] === 'update' ? appUpdate.update() : appUpdate.restart());
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    return OK;
  }),
  post('/api/storage/purge', ({ app, body }) => app.purge(Number(body.olderThanDays ?? 30))),
  post('/api/auth/(claude|codex)/(login|refresh)', async ({ app, params }) => {
    if (params[1] === 'login') await app.startLogin(provider(params[0]));
    else await app.refreshAuth(provider(params[0]));
    return OK;
  }),
  post(`/api/projects/${ID}/env/(set|delete|reveal)`, ({ app, params, body }) => {
    const name = String(body.name ?? '');
    if (params[1] === 'set') app.setEnv(params[0]!, name, body.value);
    else if (params[1] === 'delete') app.deleteEnv(params[0]!, name);
    else return { value: app.revealEnv(params[0]!, name) };
    return OK;
  }),
  // ---- schedules: work that starts by itself ----
  post('/api/schedules', ({ app, body }) => ({ scheduleId: app.saveSchedule(body ?? {}) })),
  post('/api/schedules/test-hook', async ({ app, body }) => (await app.testScheduleHook(body ?? {}), OK)),
  post(`/api/schedules/${ID}/remove`, ({ app, params }) => (app.removeSchedule(params[0]!), OK)),
  post(`/api/schedules/${ID}/run`, async ({ app, params }) => ({ sessionId: await app.runSchedule(params[0]!) })),
  post('/api/shutdown', ({ onShutdownRequest }) => new Reply(200, OK, onShutdownRequest)),

  // ---- requests waiting for the human ----
  post(`/api/items/${ID}/answer`, ({ app, params, body }) => {
    const r = app.answer(params[0]!, body.answer);
    return new Reply(r.ok ? 200 : r.code === 'not_found' ? 404 : r.code === 'invalid' ? 400 : r.code === 'delivery_failed' ? 502 : 409, r);
  }),

  // ---- sessions ----
  post('/api/sessions', async ({ app, body }) => ({ sessionId: await app.startSession(body) })),
  post(`/api/sessions/${ID}/message`, ({ app, params, body }) => app.sendMessage(params[0]!, String(body.text ?? ''), { effort: body.effort })),
  post(`/api/sessions/${ID}/interrupt`, async ({ app, params }) => (await app.interrupt(params[0]!), OK)),
  post(`/api/sessions/${ID}/stop`, async ({ app, params }) => (await app.stop(params[0]!), OK)),
  post(`/api/sessions/${ID}/finish`, ({ app, params }) => (app.finishWaiting(params[0]!), OK)),
  post(`/api/sessions/${ID}/cleanup`, ({ app, params }) => app.cleanup(params[0]!)),
  post(`/api/sessions/${ID}/seen`, ({ app, params }) => (app.markSeen(params[0]!), OK)),
  post(`/api/sessions/${ID}/check`, ({ app, params }) => (void app.runCheck(params[0]!).catch(() => {}), OK)),
  post(`/api/sessions/${ID}/(accept|reopen)`, async ({ app, params }) => (await app.setAccepted(params[0]!, params[1] === 'accept'), OK)),
  post(`/api/sessions/${ID}/run`, ({ app, params, body }) => app.runForHuman(params[0]!, String(body.command ?? ''), typeof body.runId === 'string' ? body.runId : undefined)),
  post(`/api/sessions/${ID}/step`, ({ app, params, body }) => app.setStepDone(params[0]!, Number(body.index), body.done !== false)),
  post(`/api/sessions/${ID}/unsend`, ({ app, params }) => (app.cancelDeferred(params[0]!), OK)),
  post(`/api/sessions/${ID}/rename`, ({ app, params, body }) => (app.rename(params[0]!, String(body.title ?? '')), OK)),
  post(`/api/sessions/${ID}/kind`, ({ app, params, body }) => (app.setTaskKind(params[0]!, body.kind), OK)),
  // ---- voice input: a recording becomes text, the text becomes work to start (started through /api/sessions) ----
  { method: 'POST', path: /^\/api\/voice\/transcribe$/, rawLimit: MAX_VOICE_BYTES, handle: ({ app, body }) => app.transcribeVoice(body) },
  post('/api/voice/plan', ({ app, body }) => app.planVoice(body ?? {})),
  post('/api/voice/tidy', ({ app, body }) => app.tidyVoice(body ?? {})),
  post('/api/voice/prepare', ({ app }) => (app.prepareVoice(), OK)),
  // ---- side chats ----
  post('/api/chats', ({ app, body }) => ({ chatId: app.startChat(body ?? {}) })),
  post(`/api/chats/${ID}/message`, ({ app, params, body }) => (app.sendChat(params[0]!, String(body.text ?? '')), OK)),
  post(`/api/chats/${ID}/choice`, ({ app, params, body }) => (app.setChatChoice(params[0]!, body ?? {}), OK)),
  post(`/api/chats/${ID}/interrupt`, async ({ app, params }) => (await app.interruptChat(params[0]!), OK)),
  post(`/api/chats/${ID}/close`, async ({ app, params }) => (await app.closeChat(params[0]!), OK)),
  get(`/api/chats/${ID}/transcript`, ({ app, params, query }) => {
    const after = query.get('after');
    return { entries: app.store.readTranscript(params[0]!, 200, { after: after ? Number(after) : undefined }) };
  }),
  post(`/api/sessions/${ID}/(archive|unarchive)`, async ({ app, params }) => (await app.setArchived(params[0]!, params[1] === 'archive'), OK)),
];

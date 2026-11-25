// Read model: the one document the UI is sent. Assembled from the core's state plus what each service knows
// (queue places, processes, folders, sign-ins). Nothing here changes anything.
import { KNOWLEDGE_HEADING, KNOWLEDGE_LIMITS, MAX_FIX_ROUNDS, completionOf, domainsInOrder, enabledProviders } from '#core';
import type { AttentionItem, ProviderCapabilities, ProviderId } from '#core';
import type { Accounts } from './accounts.ts';
import type { Journal } from './journal.ts';
import type { KnowledgeTune } from './knowledge-tune.ts';
import type { Processes } from './processes.ts';
import type { PullRequests } from './pull-requests.ts';
import type { Runtime } from './runtime.ts';
import type { Scheduler } from './scheduler.ts';
import type { Secrets } from './secrets.ts';
import type { Sessions } from './sessions.ts';
import type { SideChats } from './side-chats.ts';
import type { Voice } from './voice.ts';
import type { Workspaces } from './workspaces.ts';

export interface ReadModelDeps {
  scheduler: Scheduler;
  processes: Processes;
  workspaces: Workspaces;
  journal: Journal;
  sessions: Sessions;
  chats: SideChats;
  knowledgeTune: KnowledgeTune;
  voice: Voice;
  accounts: Accounts;
  secrets: Secrets;
  pullRequests: PullRequests;
}

export function capabilities(rt: Runtime): Record<ProviderId, ProviderCapabilities> {
  return { claude: rt.adapters.claude.capabilities(), codex: rt.adapters.codex.capabilities() };
}

export function snapshot(rt: Runtime, d: ReadModelDeps) {
  const st = rt.core.state;
  const items = [...st.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  const working = [...st.sessions.values()].filter((s) => !s.archived);
  const queuePos = d.scheduler.positions();
  const sessions = [...st.sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s) => {
      const live = rt.adapters[s.provider].isLive(s.id);
      const t = st.tasks.get(s.taskId);
      return {
        ...s,
        projectName: st.projects.get(s.projectId)?.name ?? '?',
        // The other workspaces the work also touches, by name, so a list can say where it belongs at a glance.
        extraProjectNames: (s.extraProjectIds ?? []).map((id) => st.projects.get(id)?.name).filter((n) => n !== undefined),
        taskTitle: t?.title ?? '?',
        completion: t ? completionOf(t, s) : ('working' as const),
        task: t
          ? { humanSteps: t.humanSteps, acceptanceCriteria: t.acceptanceCriteria, checkCommand: t.checkCommand, autoFix: t.autoFix, fixRounds: t.fixRounds, maxFixRounds: MAX_FIX_ROUNDS, validation: t.validation, validating: t.validating, acceptedAt: t.acceptedAt }
          : null,
        worktree: d.workspaces.view(s.id),
        pullRequest: d.pullRequests.view(s.id),
        queuePosition: queuePos.get(s.id) ?? null,
        activity: d.journal.activityOf(s.id),
        deferredMessage: d.sessions.deferredOf(s.id),
        live,
        transcriptRev: d.journal.revOf(s.id),
        resources: d.processes.resourcesOf(s, live),
      };
    });
  const decorate = (i: AttentionItem) => ({
    ...i,
    projectName: st.projects.get(i.projectId)?.name ?? '?',
    taskTitle: st.tasks.get(st.sessions.get(i.sessionId)?.taskId ?? '')?.title ?? '?',
  });
  const { processCount, workingSetBytes } = d.processes.totals();
  const live = sessions.filter((s) => !s.archived);
  return {
    now: Date.now(),
    generation: st.generation,
    counts: {
      needsAttention: items.filter((i) => i.status === 'pending').length,
      running: working.filter((s) => s.lifecycle === 'running').length,
      queued: working.filter((s) => s.lifecycle === 'queued').length,
      waiting: working.filter((s) => s.lifecycle === 'waiting_for_user').length,
      turnFinished: working.filter((s) => s.lifecycle === 'turn_finished').length,
      problems: working.filter((s) => s.lifecycle === 'error' || s.lifecycle === 'interrupted' || s.lifecycle === 'unknown').length,
      candidates: live.filter((s) => s.completion === 'candidate').length,
      humanTasks: live.filter((s) => s.completion === 'human_steps').length,
      needsFix: live.filter((s) => s.completion === 'needs_fix').length,
      unread: working.filter((s) => s.unread).length,
      archived: st.sessions.size - working.length,
    },
    settings: { ...st.settings, providers: enabledProviders(st.settings) },
    auth: d.accounts.view(),
    queue: { length: d.scheduler.length, blockedBy: d.scheduler.blockedBy(), freeMemoryMB: d.scheduler.freeMemoryMB() },
    resources: { processCount, workingSetBytes, scope: 'Control Roomが起動した全エージェントプロセス群の合計（ワーキングセット、共有ページは重複計上）' },
    projects: [...st.projects.values()].map((p) => ({ ...p, envCount: d.secrets.count(p.id) })),
    // Open requests, plus a bounded tail of settled ones: the page never needs the whole history.
    items: [...items.filter((i) => i.status === 'pending' || i.status === 'answering'), ...items.filter((i) => i.status !== 'pending' && i.status !== 'answering').slice(-300)].sort((a, b) => a.createdAt - b.createdAt).map(decorate),
    sessions,
    /** The human's standing preferences, by area, with the limits the settings screen measures them against. */
    knowledge: {
      domains: domainsInOrder(st.knowledge),
      entries: [...st.knowledge.entries.values()].sort((a, b) => a.createdAt - b.createdAt),
      unseen: [...st.knowledge.entries.values()].filter((e) => !e.seen).length,
      limits: KNOWLEDGE_LIMITS,
      /** The heading the preferences go under, so the screen can measure what is sent exactly. */
      heading: KNOWLEDGE_HEADING,
      /** The こだわり chat: its conversation and whether a message is being read. */
      tune: d.knowledgeTune.view(),
    },
    /** Side chats: conversations beside the work. Not work: never in the lists, the counts or the inbox. */
    chats: d.chats.view(),
    /** Voice input: whether the speech recogniser's model is on this machine yet. */
    voice: d.voice.view(),
    capabilities: capabilities(rt),
  };
}

export type Snapshot = ReturnType<typeof snapshot>;

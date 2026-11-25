// What every application service works with: the core (decisions and state), the store (persistence), the provider
// adapters, and the few cross-cutting helpers. Built once by the composition root (app.ts) and handed to each service,
// so services depend on this small surface and on each other only through explicit constructor arguments.
import { PROVIDER_IDS, type AgentSession, type ControlCore, type ProviderAdapter, type ProviderId } from '#core';
import type { SqliteStore } from '../infrastructure/sqlite-store.ts';
import { HttpError } from './errors.ts';

/** Every provider there is an adapter for (core PROVIDER_IDS). Which the human uses: enabledProviders(settings). */
export const PROVIDERS = PROVIDER_IDS;

export interface Runtime {
  readonly core: ControlCore;
  readonly store: SqliteStore;
  /** Assigned right after construction (the adapters need the sink, which needs the services). */
  adapters: Record<ProviderId, ProviderAdapter>;
  /** Once true, late provider callbacks (process exits during shutdown) are dropped; the next start reconciles them. */
  closing: boolean;
  /** Tell the interface layer that what the UI shows may have changed. */
  notify(): void;
}

export function mustSession(rt: Runtime, id: string): AgentSession {
  const s = rt.core.state.sessions.get(id);
  if (!s) throw new HttpError(404, '該当するセッションがありません');
  return s;
}

export function mustProject(rt: Runtime, id: string): void {
  if (!rt.core.state.projects.has(id)) throw new HttpError(404, '該当するプロジェクトがありません');
}

export function mustProvider(provider: unknown): asserts provider is ProviderId {
  if (provider !== 'claude' && provider !== 'codex') throw new HttpError(400, 'provider は claude か codex');
}

export const message = (e: unknown): string => String((e as Error)?.message ?? e);

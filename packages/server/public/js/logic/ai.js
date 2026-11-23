// Which AI answers: the agents, the models each offers and how hard they think. A choice is
// { provider, model, effort }; an empty model or effort means "the agent's own default".
// Model lists come from the providers themselves, once per page, and are shared by every picker.
import { api } from './api.js';
import { store } from './store.js';

export const AGENTS = ['claude', 'codex'];

/** provider -> { models, status: 'loading' | 'ready' | 'failed', promise } */
const lists = new Map();

/** What is known of a provider's models right now (null: never asked). */
export const modelsOf = (provider) => lists.get(provider) ?? null;

/** Ask a provider for its models once; later calls share the answer. A failed answer is asked again next time. */
export function ensureModels(provider) {
  const have = lists.get(provider);
  if (have && have.status !== 'failed') return have.promise;
  const entry = { models: [], status: 'loading', promise: null };
  lists.set(provider, entry);
  entry.promise = api(`/api/models/${provider}`).then((r) => {
    // "default" is the agent's own default, which every picker offers as 既定 anyway.
    if (r.status === 200) entry.models = r.body.models.filter((m) => m.id !== 'default');
    entry.status = r.status === 200 ? 'ready' : 'failed';
    store.changed();
    return entry.models;
  });
  return entry.promise;
}

export const findModel = (provider, id) => modelsOf(provider)?.models.find((m) => m.id === id) ?? null;

/** The middle of what a model offers (medium where there is one). */
export const midEffort = (m) => {
  const e = m?.efforts ?? [];
  return e.includes('medium') ? 'medium' : (m?.defaultEffort ?? e[Math.floor(e.length / 2)] ?? '');
};

/** A provider's recommended model at a middle effort (or its own default while the list is not known). */
export function defaultChoice(provider) {
  const list = modelsOf(provider)?.models ?? [];
  const first = list.find((m) => m.isDefault) ?? list[0];
  return first ? { provider, model: first.id, effort: midEffort(first) } : { provider, model: '', effort: '' };
}

/** Switch to model `m` of `provider`: the effort is kept when the new model has it, else the middle one. */
export const withModel = (choice, provider, m) => ({ provider, model: m.id, effort: (m.efforts ?? []).includes(choice.effort) ? choice.effort : midEffort(m) });

/** A remembered choice, checked against what the provider offers now: a model it no longer has gives its default. */
export function stillValid(choice, provider) {
  if (!choice || choice.provider !== provider) return defaultChoice(provider);
  const entry = modelsOf(provider);
  if (choice.model === '' || entry?.status !== 'ready' || entry.models.some((m) => m.id === choice.model)) return choice;
  return defaultChoice(provider);
}

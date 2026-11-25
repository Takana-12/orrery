// The agents the app can drive, in the order every screen lists them (same as the server's PROVIDER_IDS). Pure data,
// so the pure modules (optimistic.js) can use it too. A new agent (e.g. 'gemini') is added here, in vocabulary
// PROVIDER, as an icon, and as a server adapter; it then appears in 設定 → 使うAI to be turned on.
export const AGENTS = ['claude', 'codex'];

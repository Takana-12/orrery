// Environment for an agent child process, as if launched from a plain desktop app.
// If the control room itself was started from inside another Claude Code / Agent SDK session, that session's
// CLAUDE_* / ANTHROPIC_* variables would leak into the child and change auth and behaviour, so they are dropped.
// ANTHROPIC_API_KEY is dropped as well unless explicitly opted in: with it set, headless Claude Code bills the API, not the plan.
export function cleanChildEnv(base: NodeJS.ProcessEnv = process.env, opts: { keepApiKey?: boolean } = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    if (opts.keepApiKey && k === 'ANTHROPIC_API_KEY') {
      env[k] = v;
      continue;
    }
    if (/^(CLAUDE|ANTHROPIC)/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

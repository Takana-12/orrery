// Build the environment for an agent child process as if it were launched from a plain desktop app.
// When the PoC itself is run from inside another Claude Code / Agent SDK session, that session's
// CLAUDE_* / ANTHROPIC_* variables would leak into the child and change auth and behaviour, so drop them.
// (ANTHROPIC_API_KEY is dropped too: with it set, headless Claude Code bills the API instead of the plan.)
export function cleanChildEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^(CLAUDE|ANTHROPIC)/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

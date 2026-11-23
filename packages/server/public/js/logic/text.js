// Reading what agents wrote: which spans are commands, and how a recorded tool entry reads as one line.
// (Their prose as Markdown is in markdown.js.)
// Pure: returns data, the UI decides how it looks.

/** Does this inline code look like a shell command a person would run? */
const COMMAND = /^(gh|git|npm|pnpm|yarn|npx|node|python|python3|py|pip|uv|docker|docker-compose|vercel|netlify|cargo|make|dotnet|az|aws|gcloud|kubectl|terraform|supabase|firebase|wrangler|flyctl|heroku|deno|bun|go|pytest|ruff|curl|pwsh|powershell|winget|scoop|choco|code)\s+\S/;
export const looksLikeCommand = (t) => t.length <= 400 && !t.includes('\n') && COMMAND.test(t.trim());

/** Turn a recorded tool entry into one readable line (+ the full text on demand). Display only; the record is untouched. */
export function toolSummary(text) {
  const short = (v, n = 110) => (v.length > n ? v.slice(0, n) + '…' : v);
  const call = text.match(/^▶ (\S+) ([\s\S]*)$/);
  if (call) {
    let hint = '';
    let pretty = call[2];
    try {
      const j = JSON.parse(call[2]);
      pretty = JSON.stringify(j, null, 2);
      hint = j.command ?? j.file_path ?? j.pattern ?? j.path ?? j.url ?? j.questions?.[0]?.question ?? j.plan ?? '';
    } catch {}
    return { glyph: 'terminal', line: short(`${call[1]}  ${String(hint).split('\n')[0]}`), more: pretty };
  }
  const result = text.match(/^([✔✖]) ([\s\S]*)$/);
  if (result) {
    const first = result[2].split('\n')[0];
    const long = result[2].includes('\n') || first.length > 110;
    return { glyph: result[1] === '✔' ? 'check' : 'x', line: short(first), more: long ? result[2] : null };
  }
  const nl = text.indexOf('\n');
  if (nl < 0) return { glyph: 'terminal', line: short(text, 160), more: text.length > 160 ? text : null };
  return { glyph: 'terminal', line: short(text.slice(0, nl), 160), more: text.slice(nl + 1).trim() ? text : null };
}

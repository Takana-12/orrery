// Reading what agents wrote: which spans are commands, and how a recorded tool entry reads as one line.
// (Their prose as Markdown is in markdown.js.)
// Pure: returns data, the UI decides how it looks.

/** Does this inline code look like a shell command a person would run? */
const COMMAND = /^(gh|git|npm|pnpm|yarn|npx|node|python|python3|py|pip|uv|docker|docker-compose|vercel|netlify|cargo|make|dotnet|az|aws|gcloud|kubectl|terraform|supabase|firebase|wrangler|flyctl|heroku|deno|bun|go|pytest|ruff|curl|pwsh|powershell|winget|scoop|choco|code)\s+\S/;
export const looksLikeCommand = (t) => t.length <= 400 && !t.includes('\n') && COMMAND.test(t.trim());

/**
 * The opening of a reply to show in place of the whole (plain text, Markdown marks already removed): up to `max`
 * characters, ended at a sentence or line when one ends late enough, so it does not stop mid-word. Blank lines go.
 * Returns { text, more }: `more` is true when something was left out.
 */
export function excerpt(plain, max = 240) {
  const t = String(plain ?? '').replace(/\n{2,}/g, '\n').trim();
  if (t.length <= max) return { text: t, more: false };
  const head = t.slice(0, max);
  const stop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('\n'), head.lastIndexOf('. '), head.lastIndexOf('！'), head.lastIndexOf('？'));
  return { text: (stop >= max * 0.6 ? head.slice(0, stop + 1) : head).trimEnd(), more: true };
}

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

/**
 * What the agent wrote before asking, minus a closing paragraph that is only the question itself (a question read from
 * a reply is usually its last paragraph, and the ticket shows it right below). Null when nothing else is left.
 */
export function leadInText(context, questionTexts) {
  if (!context) return null;
  const norm = (t) => String(t ?? '').replace(/[*_`#>\s]/g, '').replace(/[?？。.!！:：]+$/u, '');
  const asked = new Set(questionTexts.map(norm).filter(Boolean));
  const paras = context.trim().split(/\n\s*\n/);
  while (paras.length && asked.has(norm(paras[paras.length - 1]))) paras.pop();
  const left = paras.join('\n\n').trim();
  return left || null;
}

// ---- file and folder paths ---------------------------------------------------------------------------
// A path an agent wrote (C:\Users\me\notes.md, ~/work/app, `src/app.ts:42`) can be clicked to open it. Only the shape is
// read here; whether it exists, and whether it is opened or only shown in its folder, is the server's call.

/** Roots a Unix-style absolute path written in prose starts with (a bare "/api/run" is a route, not a file). */
const UNIX_ROOT = /^(?:~|\/(?:Users|home|tmp|var|opt|etc|usr|mnt|srv|private|Volumes|Library|Applications))(?:\/|$)/;
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;
/** "file.ts:42" or "file.ts:42:7": where in the file; the file is what opens. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
/** The last part of the path has an extension (notes.md), or the path ends at a separator (a folder). */
const fileLike = (p) => /[\\/]$/.test(p) || /\.[A-Za-z0-9]{1,10}$/.test(p.split(/[\\/]/).pop());

/**
 * What a piece of inline code means as a path, or null: { path, relative }. `path` is without a line suffix;
 * `relative` paths only mean something next to the work's own folder.
 */
export function pathTarget(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 400 || /[\r\n\t*?<>|"`$]/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;
  const p = t.replace(LINE_SUFFIX, '');
  if (/^(?:\\\\|\/\/)/.test(p)) return null; // network locations are not opened
  if (WIN_DRIVE.test(p)) return p.slice(2).includes(':') ? null : { path: p, relative: false };
  if (/\s/.test(p) || p.includes(':')) return null;
  if (UNIX_ROOT.test(p)) return { path: p, relative: false };
  if (p.startsWith('/')) return fileLike(p) && p.split('/').length > 2 ? { path: p, relative: false } : null;
  // Relative: it has to look like a file in a folder (src/app.ts, ./docs/, ..\x.md), not a word with a slash in it.
  if (!/[\\/]/.test(p) || !fileLike(p) || !/[A-Za-z]/.test(p) || p.startsWith('@')) return null;
  return { path: p, relative: true };
}

// Characters a path in prose can hold: not spaces, quotes or the punctuation that ends a Japanese phrase.
const PATH_CHARS = '[^\\s<>"\'`|*?、。，「」『』（）【】]';
const BARE_PATH = new RegExp(`^(?:[A-Za-z]:[\\\\/]|~/|/(?:Users|home|tmp|var|opt|etc|usr|mnt|srv|private|Volumes|Library|Applications)/)${PATH_CHARS}*`);

/**
 * An absolute path written as prose at the start of `rest` (C:\Users\me\notes.mdを開く → C:\Users\me\notes.md),
 * or null. Returns { text, path }: `text` is what was written (with any line suffix), `path` what to open.
 */
export function barePathAt(rest) {
  const m = rest.match(BARE_PATH);
  if (!m) return null;
  let text = m[0];
  // Words right after a file name are not part of it: "notes.mdなど" ends at ".md".
  const ext = text.match(/^(.*\.[A-Za-z0-9]{1,10})[^\x00-\x7F][^\\/]*$/);
  if (ext) text = ext[1];
  // Sentence punctuation after it is not part of it, nor a ")" that closes a bracket opened before it.
  for (;;) {
    const trimmed = text.replace(/[.,;:!]+$/, '');
    const unbalanced = trimmed.endsWith(')') && (trimmed.match(/\)/g).length > (trimmed.match(/\(/g) ?? []).length);
    const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
    if (next === text) break;
    text = next;
  }
  // "C:\x.md:12" keeps its line in the text; a colon elsewhere (past the drive) means it was not a path.
  const target = pathTarget(text);
  return target && !target.relative ? { text, path: target.path } : null;
}

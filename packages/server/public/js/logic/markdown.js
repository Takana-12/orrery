// Markdown that agents write, read into a tree. Pure: returns data, the UI decides how it looks.
// Nothing here produces HTML: raw HTML in the source stays text, and only http(s)/mailto links survive.
//
// Blocks:  { type: 'heading', level, inline } | { type: 'para', inline } | { type: 'code', lang, text, command }
//          | { type: 'list', ordered, start, items: [{ checked: true|false|null, blocks }] }
//          | { type: 'quote', blocks } | { type: 'hr' } | { type: 'table', align, head, rows }
// Inline:  { t: 'text', v } | { t: 'code', v, command } | { t: 'strong'|'em'|'del', c } | { t: 'link', href, c } | { t: 'br' }
//
// Line breaks inside a paragraph are kept (as 'br'): agents write as in a chat, one thought per line.
import { looksLikeCommand } from './text.js';

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const blank = (l) => !l.trim();

/** Lines that end a paragraph (or a lazy list line) when they start. */
const startsBlock = (l) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l);

export function parseMarkdown(src) {
  return blocks(String(src ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}[ \\t]*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      const text = body.join('\n');
      out.push({ type: 'code', lang: fence[2] || null, text, command: looksLikeCommand(text.trim()) ? text.trim() : null });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      out.push({ type: 'heading', level: heading[1].length, inline: inline(heading[2] ?? '') });
      i++;
      continue;
    }

    if (HR.test(line)) { out.push({ type: 'hr' }); i++; continue; }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || !startsBlock(lines[i]))) body.push(lines[i++].replace(QUOTE, ''));
      out.push({ type: 'quote', blocks: blocks(body) });
      continue;
    }

    if (ITEM.test(line)) { i = list(lines, i, out); continue; }

    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(cells(lines[i++]));
      const n = head.length;
      out.push({
        type: 'table',
        align: Array.from({ length: n }, (_, k) => align[k] ?? null),
        head: head.map(inline),
        rows: rows.map((r) => Array.from({ length: n }, (_, k) => inline(r[k] ?? ''))),
      });
      continue;
    }

    // A paragraph: up to a blank line or the start of another block.
    const para = [line];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i]) && !SETEXT.test(lines[i])) para.push(lines[i++]);
    // "Title\n===" is a heading; a longer paragraph followed by "---" is far more likely text, then a rule.
    const setext = para.length === 1 && i < lines.length && lines[i].match(SETEXT);
    if (setext) {
      out.push({ type: 'heading', level: setext[1][0] === '=' ? 1 : 2, inline: inline(para.map((l) => l.trim()).join('\n')) });
      i++;
      continue;
    }
    out.push({ type: 'para', inline: inline(para.map((l) => l.trim()).join('\n')) });
  }
  return out;
}

/** A list starting at lines[i]; pushes it to `out` and returns the index after it. */
function list(lines, i, out) {
  const first = lines[i].match(ITEM);
  const ordered = /\d/.test(first[2]);
  const indent = first[1].length;
  const node = { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
  while (i < lines.length) {
    const m = lines[i].match(ITEM);
    // Another item of this list: same kind of marker, not indented past this list's markers.
    if (!m || m[1].length > indent + 1 || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + 1;
    const body = [m[3] ?? ''];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) { body.push(''); sawBlank = true; i++; continue; }
      const lead = l.length - l.trimStart().length;
      // Indented under the marker: belongs to this item (a nested list may be indented less than the text).
      if (lead >= contentIndent || (lead > indent && ITEM.test(l))) { body.push(l.slice(Math.min(lead, contentIndent))); sawBlank = false; i++; continue; }
      // A wrapped line of the item's text.
      if (!sawBlank && !startsBlock(l)) { body.push(l.trim()); i++; continue; }
      break;
    }
    while (body.length && blank(body[body.length - 1])) body.pop();
    let checked = null;
    const task = body[0].match(/^\[([ xX])\][ \t]+/);
    if (task) { checked = task[1] !== ' '; body[0] = body[0].slice(task[0].length); }
    node.items.push({ checked, blocks: blocks(body) });
    // A blank line, then something that is not the next item: the list is over.
    if (i < lines.length && sawBlank && !ITEM.test(lines[i])) break;
  }
  out.push(node);
  return i;
}

function cells(row) {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  const out = [];
  let cur = '';
  let code = false;
  for (let k = 0; k < r.length; k++) {
    const ch = r[k];
    if (ch === '\\' && r[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// ---- inline ---------------------------------------------------------------------------------------

const PUNCT = /[!-/:-@[-`{-~]/;
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
const BARE_URL = /^https?:\/\/[^\s<>"'`）」』】、。]+/;
const wordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

export function inline(src) {
  const out = [];
  let text = '';
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
  const push = (node) => { flush(); out.push(node); };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    if (ch === '\\' && i + 1 < src.length && PUNCT.test(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
    if (ch === '\n') { push({ t: 'br' }); i++; continue; }

    if (ch === '`') {
      const run = rest.match(/^`+/)[0];
      const end = src.indexOf(run, i + run.length);
      // Only an exact run of the same length closes it.
      let close = end;
      while (close >= 0 && (src[close + run.length] === '`' || src[close - 1] === '`')) close = src.indexOf(run, close + 1);
      if (close >= 0) {
        let v = src.slice(i + run.length, close).replace(/\n/g, ' ');
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ')) v = v.slice(1, -1);
        push({ t: 'code', v, command: looksLikeCommand(v) ? v.trim() : null });
        i = close + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    if (ch === '!' && src[i + 1] === '[') {
      // Images are not loaded: shown as a link to them.
      const link = linkAt(src, i + 1);
      if (link) { flush(); out.push(...link.nodes); i = link.end; continue; }
    }
    if (ch === '[') {
      const link = linkAt(src, i);
      if (link) { flush(); out.push(...link.nodes); i = link.end; continue; }
    }
    if (ch === '<') {
      const auto = rest.match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i);
      if (auto) { push({ t: 'link', href: auto[1], c: [{ t: 'text', v: auto[1].replace(/^mailto:/i, '') }] }); i += auto[0].length; continue; }
    }
    if ((ch === 'h' || ch === 'H') && !wordChar(src[i - 1])) {
      const url = rest.match(BARE_URL);
      if (url) {
        // Sentence punctuation after a URL is not part of it, nor is a ")" that closes a bracket opened before it.
        let href = url[0];
        for (;;) {
          const trimmed = href.replace(/[.,:;!?*_~]+$/, '');
          const unbalanced = trimmed.endsWith(')') && (trimmed.match(/\)/g).length > (trimmed.match(/\(/g) ?? []).length);
          const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
          if (next === href) break;
          href = next;
        }
        push({ t: 'link', href, c: [{ t: 'text', v: href }] });
        i += href.length;
        continue;
      }
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      const em = emphasisAt(src, i);
      if (em) { push(em.node); i = em.end; continue; }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

/** `[label](href)` at src[i] === '['. A target that is not http(s)/mailto keeps only the label. */
function linkAt(src, i) {
  let depth = 0;
  let k = i;
  for (; k < src.length; k++) {
    if (src[k] === '\\') { k++; continue; }
    if (src[k] === '`') { const e = src.indexOf('`', k + 1); if (e > 0) k = e; continue; }
    if (src[k] === '[') depth++;
    else if (src[k] === ']' && --depth === 0) break;
  }
  if (k >= src.length || src[k + 1] !== '(') return null;
  const m = src.slice(k + 1).match(/^\(\s*<?([^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/);
  if (!m) return null;
  const label = inline(src.slice(i + 1, k));
  const end = k + 1 + m[0].length;
  if (!SAFE_HREF.test(m[1])) return { nodes: label, end };
  return { nodes: [{ t: 'link', href: m[1], c: label.length ? label : [{ t: 'text', v: m[1] }] }], end };
}

/** **strong**, *em*, _em_, __strong__, ~~del~~ at src[i]. */
function emphasisAt(src, i) {
  const ch = src[i];
  let run = src.slice(i).match(ch === '~' ? /^~+/ : ch === '*' ? /^\*+/ : /^_+/)[0];
  if (ch === '~' && run.length !== 2) return null;
  if (run.length > 3) return null;
  const after = src[i + run.length];
  if (!after || /\s/.test(after)) return null;
  // snake_case and 2*3*4 are not emphasis.
  if (ch === '_' && wordChar(src[i - 1])) return null;
  const tryLen = (n) => {
    const delim = ch.repeat(n);
    let k = i + n;
    while (k < src.length) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '`') { const e = src.indexOf('`', k + 1); k = e > 0 ? e + 1 : k + 1; continue; }
      if (src.startsWith(delim, k) && !/\s/.test(src[k - 1]) && k > i + n) {
        const next = src[k + n];
        const tooLong = next === ch && n < 3 && !src.startsWith(ch.repeat(n + 1), k + 1);
        if (!tooLong && !(ch === '_' && wordChar(next))) return k;
      }
      k++;
    }
    return -1;
  };
  for (let n = run.length; n >= 1; n--) {
    if (ch === '~' && n !== 2) continue;
    const close = tryLen(n);
    if (close < 0) continue;
    const inner = inline(src.slice(i + n, close));
    const node = ch === '~' ? { t: 'del', c: inner }
      : n === 3 ? { t: 'strong', c: [{ t: 'em', c: inner }] }
        : n === 2 ? { t: 'strong', c: inner } : { t: 'em', c: inner };
    return { node, end: close + n };
  }
  return null;
}

/** The words of a piece of Markdown without its markup, for one- or two-line previews. */
export function plainText(src) {
  const flat = (nodes) => nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? '\n' : flat(n.c ?? []))).join('');
  const walk = (bs) => bs.map((b) =>
    b.type === 'code' ? b.text
      : b.type === 'list' ? b.items.map((it) => walk(it.blocks)).join('\n')
        : b.type === 'quote' ? walk(b.blocks)
          : b.type === 'table' ? [b.head, ...b.rows].map((r) => r.map(flat).join(' | ')).join('\n')
            : b.type === 'hr' ? '' : flat(b.inline)).filter(Boolean).join('\n');
  return walk(parseMarkdown(src));
}

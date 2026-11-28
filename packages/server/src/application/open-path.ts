// Opening a file or folder an agent named in what it wrote (C:\Users\me\notes.md, `src/app.ts`). The page only reads
// the shape of a path; what it means on this computer, whether it is there, and how it is opened is decided here.
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, resolve } from 'node:path';
import { HttpError } from './errors.ts';

/**
 * Kinds of file that open as something to read, look at or edit. Anything else is shown selected in its folder instead:
 * opening a program, a script, a shortcut or an installer runs it (on Windows even a .js or .py does), and a click on
 * a name in a reply must never run anything.
 */
const OPENABLE = new Set([
  // text and data
  'md', 'markdown', 'mdx', 'txt', 'log', 'csv', 'tsv', 'json', 'jsonc', 'json5', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'env', 'lock', 'diff', 'patch', 'sql', 'graphql', 'proto',
  // source an editor opens (not the kinds the system runs)
  'ts', 'tsx', 'mts', 'cts', 'jsx', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro', 'rs', 'go', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'fs', 'dart', 'zig', 'lua', 'r', 'ex', 'exs', 'scala', 'gradle', 'cmake', 'dockerfile', 'tex', 'bib', 'rst', 'adoc', 'org',
  // documents, pictures, sound and video
  'html', 'htm', 'pdf', 'rtf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'epub',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'psd',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi',
  'zip',
]);

export type OpenHow = 'open' | 'reveal';

/**
 * Where `input` is on this computer and how it is opened. A relative path is found from `cwd` (the work's folder);
 * `~` is the home folder. Refuses network locations and anything that is not there.
 */
export function openTarget(input: string, cwd: string | null, home: string = homedir()): { path: string; how: OpenHow } {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 1000 || /[\0\r\n]/.test(raw)) throw new HttpError(400, '開けるのは、ファイルかフォルダの場所だけです');
  const fromHome = raw === '~' || /^~[\\/]/.test(raw);
  if (!fromHome && !isAbsolute(raw) && !cwd) throw new HttpError(400, `どこから探すかが分からないため開けません: ${raw}`);
  // Opening a network location would have this computer sign in to whoever runs it. Checked on what was written as
  // well as on the result: on macOS and Linux resolve() folds a leading // into one /, which would hide it.
  const network = /^(?:\\\\|\/\/)/;
  if (network.test(raw)) throw new HttpError(400, `ネットワーク上の場所は開きません: ${raw}`);
  const path = fromHome ? resolve(home, raw.slice(2)) : resolve(cwd ?? '', raw);
  if (network.test(path)) throw new HttpError(400, `ネットワーク上の場所は開きません: ${raw}`);
  // C:\x.md:stream names a hidden part of a file, not a file.
  if (/^[A-Za-z]:/.test(path) && path.slice(2).includes(':')) throw new HttpError(400, `開けるのは、ファイルかフォルダの場所だけです: ${raw}`);
  let dir: boolean;
  try {
    dir = statSync(path).isDirectory();
  } catch {
    throw new HttpError(404, `見つかりません: ${path}`);
  }
  if (dir) return { path, how: 'open' };
  return { path, how: OPENABLE.has(extname(path).slice(1).toLowerCase()) ? 'open' : 'reveal' };
}

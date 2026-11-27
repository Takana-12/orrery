// Keeps Orrery portable as it grows: code that depends on the operating system may live in two places only,
//   packages/host/            (the server side: processes, secrets, the shell)
//   apps/desktop/platform/    (the desktop shell: tray, menu, updating)
// and each of those has one implementation per OS behind one shape. Anything else that asks "which OS is this?",
// or names a Windows- or macOS-only program, fails here — with the line, and where it should go instead.
// (Tests and one-off maintenance scripts are not checked: they do not ship.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHECKED = ['packages', 'apps'];
const ALLOWED = ['packages/host/', 'apps/desktop/platform/'];
const SKIP_DIR = /^(node_modules|test|fixtures)$/;
const SOURCE = /\.(ts|mjs|cjs|js)$/;

/** What only OS-specific code has a reason to say. */
const TELLS: [RegExp, string][] = [
  [/\bprocess\.platform\b/, 'process.platform'],
  [/\bos\.platform\(\)|\bplatform\(\)\s*===/, 'os.platform()'],
  [/['"`](win32|darwin)['"`]/, "'win32' / 'darwin'"],
  [/['"`](powershell(\.exe)?|cmd\.exe|where\.exe|taskkill|tasklist)['"`]|(spawn|execFile|execFileSync)\(\s*['"`]cmd['"`]/, 'a Windows-only program'],
  [/['"`](\/usr\/bin\/|\/bin\/|\/usr\/sbin\/)[\w-]+['"`]|['"`](osascript|codesign|lsof|vm_stat)['"`]/, 'a macOS-only program'],
  [/\b(LOCALAPPDATA|APPDATA|ComSpec)\b/, 'a Windows-only environment variable'],
];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIR.test(name)) yield* sources(path);
    } else if (SOURCE.test(name) && !/\.test\.\w+$/.test(name)) yield path;
  }
}

test('nothing outside packages/host and apps/desktop/platform depends on the operating system', () => {
  const found: string[] = [];
  let files = 0;
  for (const top of CHECKED) {
    for (const file of sources(join(root, top))) {
      const rel = relative(root, file).split(sep).join('/');
      if (ALLOWED.some((a) => rel.startsWith(a))) continue;
      files++;
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''); // what the code does, not what its comments say
          for (const [tell, what] of TELLS) if (tell.test(code)) found.push(`${rel}:${i + 1}  ${what}:  ${line.trim().slice(0, 140)}`);
        });
    }
  }
  assert.ok(files > 80, `the check looked at the source (${files} files)`);
  assert.deepEqual(found, [], `OS-specific code outside the two places for it. Move it behind #host (packages/host/src/types.ts) or apps/desktop/platform, with an implementation for each OS:\n${found.join('\n')}\n`);
});

test('each OS has an implementation of the host, and they are chosen in one place', () => {
  for (const os of ['windows', 'mac']) assert.ok(statSync(join(root, 'packages/host/src', os, 'index.ts')).isFile());
  const others = [...sources(join(root, 'packages/host/src'))].map((f) => relative(root, f).split(sep).join('/')).filter((f) => /\bprocess\.platform\b/.test(readFileSync(join(root, f), 'utf8').replace(/\/\/.*$/gm, '')));
  assert.deepEqual(others, ['packages/host/src/index.ts'], 'only index.ts decides which implementation is used');
});

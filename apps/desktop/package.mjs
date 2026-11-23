// Builds the Windows app from this folder's source.
//   node apps/desktop/package.mjs [--out <dir>]      (default: release)
// Writes build-info.json into the packaged app so the running app can tell whether the source has moved on since.
// Also run by the app itself ("更新して再起動" in settings) with --out release/.staging, then swapped in by update-swap.ps1.
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceState } from './source-state.mjs';

// Run by the app's own exe as Node: Electron's fs would treat .asar files as folders and fail to copy/remove them.
if (process.versions.electron) process.noAsar = true;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outArg = process.argv.indexOf('--out');
const out = resolve(root, outArg > 0 ? process.argv[outArg + 1] : 'release');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Packager deletes the old folder first. If that app is running, Windows keeps the files in use (exe, DLLs) and deletes
// the rest (icudtl.dat, *.pak ...), leaving an app that no longer starts. So refuse instead; "更新" in the app builds
// into release\.staging and swaps after it has quit.
const target = join(out, `${pkg.productName}-win32-x64`);
if (process.platform === 'win32') {
  const ps = `Get-Process -Name '${pkg.productName}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (Split-Path -Parent $_.Path) -ieq '${target.replace(/'/g, "''")}' } | Select-Object -First 1 -ExpandProperty Id`;
  const running = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim();
  if (running) {
    console.error(`[package] ${pkg.productName} が起動中です（pid ${running}）。終了してから実行するか、アプリの設定から「更新」してください: ${target}`);
    process.exit(1);
  }
}

const started = Date.now();
const source = sourceState(root); // taken before copying, so edits made during the build count as "newer"
console.log(`[package] ${pkg.productName} ${pkg.version} -> ${out}`);
const [appDir] = await packager({
  dir: root,
  name: pkg.productName,
  platform: 'win32',
  arch: 'x64',
  out,
  overwrite: true,
  asar: false,
  icon: join(root, 'apps/desktop/icon.ico'),
  appVersion: pkg.version,
  ignore: [/^\/(poc|docs|release|\.git|fable_.*|control-room\.cmd)($|\/)/, /\/test($|\/)/],
});
writeFileSync(join(appDir, 'resources/app/build-info.json'), JSON.stringify({ version: pkg.version, builtAt: Date.now(), ...source }, null, 2));
console.log(`[package] done in ${Math.round((Date.now() - started) / 1000)}s: ${appDir}`);

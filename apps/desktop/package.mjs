// Builds the desktop app (Windows or macOS, whichever this machine is) from this folder's source.
//   node apps/desktop/package.mjs [--out <dir>]      (default: release)
// Writes build-info.json into the packaged app so the running app can tell whether the source has moved on since.
// Also run by the app itself ("更新して再起動" in settings) with --out release/.staging, then swapped in by the swap script.
// What differs between the systems (the bundle's name and layout, the icon, signing) is in platform/.
import { packager } from '@electron/packager';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceState } from './source-state.mjs';
import { platform } from './platform/index.mjs';

// Run by the app's own exe as Node: Electron's fs would treat .asar files as folders and fail to copy/remove them.
if (process.versions.electron) process.noAsar = true;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outArg = process.argv.indexOf('--out');
const out = resolve(root, outArg > 0 ? process.argv[outArg + 1] : 'release');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Packager deletes the old folder first, which must not happen under a running app. So refuse instead; "更新" in the
// app builds into release/.staging and swaps after it has quit.
const bundle = join(out, platform.bundleName(pkg.productName));
const running = platform.runningFrom(bundle, pkg.productName);
if (running) {
  console.error(`[package] ${pkg.productName} が起動中です（pid ${running}）。終了してから実行するか、アプリの設定から「更新」してください: ${bundle}`);
  process.exit(1);
}

const started = Date.now();
const source = sourceState(root); // taken before copying, so edits made during the build count as "newer"
console.log(`[package] ${pkg.productName} ${pkg.version} -> ${out}`);
const [appDir] = await packager({
  dir: root,
  name: pkg.productName,
  ...platform.target,
  out,
  overwrite: true,
  asar: false,
  appVersion: pkg.version,
  ignore: [/^\/(poc|docs|release|\.git|\.github|fable_.*|control-room\.cmd)($|\/)/, /\/test($|\/)/],
  ...platform.packagerOptions(root),
});
writeFileSync(join(platform.resourcesIn(appDir, pkg.productName), 'build-info.json'), JSON.stringify({ version: pkg.version, builtAt: Date.now(), ...source }, null, 2));
platform.finishBundle(appDir, pkg.productName);
console.log(`[package] done in ${Math.round((Date.now() - started) / 1000)}s: ${appDir}`);

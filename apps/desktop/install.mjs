// "npm run install-app": build the app, then register it where the person starts apps from
// (Windows: the Start menu; macOS: ~/Applications). Nothing is copied: what is registered points at release/ in this folder.
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from './platform/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
execFileSync(process.execPath, [join(root, 'apps/desktop/package.mjs')], { cwd: root, stdio: 'inherit' });
platform.installApp(root);
console.log(`[install] ${platform.installedNote}`);

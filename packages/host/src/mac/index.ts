// macOS: process groups for ownership (job.ts), the login keychain for secrets (keychain.ts), and the tools every
// Mac has (ps, vm_stat, open, osascript) for the rest.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { freemem, homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Host } from '../types.ts';
import { PosixJob } from './job.ts';
import { protect, unprotect } from './keychain.ts';
import { parseVmStat, processTable } from './ps.ts';

/** Where command-line tools are usually installed, for when PATH does not say (an app started from the Finder). */
const USUAL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin')];

const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

let memory: { at: number; bytes: number } | null = null;

export const host: Host = {
  os: 'mac',
  archTag: `macos-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`,
  createJob: () => new PosixJob(),
  ownedSpawn: { detached: true },
  protect,
  unprotect,
  executableName: (base) => base,
  findExecutable(base) {
    for (const dir of [...(process.env.PATH ?? '').split(delimiter), ...USUAL_DIRS]) {
      if (dir && isExecutable(join(dir, base))) return join(dir, base);
    }
    return null;
  },
  /** os.freemem() counts only pages nothing has touched, which on a Mac is next to nothing even when memory is plentiful. */
  freeMemoryBytes() {
    if (memory && Date.now() - memory.at < 3000) return memory.bytes;
    let bytes: number | null = null;
    try {
      bytes = parseVmStat(execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }));
    } catch {}
    memory = { at: Date.now(), bytes: bytes ?? freemem() };
    return memory.bytes;
  },
  defaultDataDir: () => join(homedir(), 'Library', 'Application Support', 'AgentControlRoom'),
  openExternal: (url) => void spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true }).unref(),
  openPath(path, reveal) {
    const child = spawn('/usr/bin/open', reveal ? ['-R', path] : [path], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  },
  openAppWindow(url, onFail) {
    const child = spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true });
    child.on('error', onFail);
    child.unref();
  },
  pickFolder() {
    return new Promise((resolvePick, reject) => {
      execFile('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "プロジェクトのフォルダを選択")'], { encoding: 'utf8', timeout: 300_000 }, (err, stdout, stderr) => {
        if (err) return /-128/.test(String(stderr)) ? resolvePick(null) : reject(err); // -128: the person pressed Cancel
        const path = stdout.trim();
        resolvePick(path.length > 1 ? path.replace(/\/$/, '') : path || null);
      });
    });
  },
  childImages(pid) {
    const out: string[] = [];
    for (const p of processTable({ fresh: true }).values()) if (p.ppid === pid) out.push(p.command.slice(p.command.lastIndexOf('/') + 1));
    return out;
  },
  adoptShellPath() {
    const mark = '__ORRERY_PATH__';
    let found = '';
    try {
      // Interactive login shell: the same files are read as when the person opens a terminal (.zprofile, .zshrc ...).
      const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', `printf '%s%s%s' '${mark}' "$PATH" '${mark}'`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });
      found = out.split(mark)[1] ?? '';
    } catch {}
    const dirs = [...found.split(delimiter), ...(process.env.PATH ?? '').split(delimiter), ...USUAL_DIRS].filter(Boolean);
    process.env.PATH = [...new Set(dirs)].join(delimiter);
  },
};

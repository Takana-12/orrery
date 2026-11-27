// Windows: Job Objects for process ownership, DPAPI for secrets, PowerShell / cmd for the few things Node cannot do.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { freemem, homedir } from 'node:os';
import { join } from 'node:path';
import type { Host } from '../types.ts';
import { WinJob } from './winjob.ts';
import { protect, unprotect } from './dpapi.ts';

/** `start` treats & as a command separator, so it is escaped. */
const start = (...args: string[]) => spawn('cmd', ['/c', 'start', '', ...args], { stdio: 'ignore', detached: true, windowsHide: true });

export const host: Host = {
  os: 'windows',
  archTag: `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`,
  createJob: () => new WinJob(),
  ownedSpawn: {},
  protect,
  unprotect,
  executableName: (base) => `${base}.exe`,
  findExecutable(base) {
    try {
      const out = execFileSync('where.exe', [`${base}.exe`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
    } catch {
      return null;
    }
  },
  freeMemoryBytes: () => freemem(),
  defaultDataDir: () => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AgentControlRoom'),
  openExternal: (url) => void start(url.replace(/&/g, '^&')).unref(),
  openAppWindow(url, onFail) {
    const child = start('msedge', `--app=${url}`);
    child.on('error', onFail);
    child.unref();
  },
  pickFolder() {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $o = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; Opacity=0}; $o.Show(); $o.Activate(); " +
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'プロジェクトのフォルダを選択'; $d.ShowNewFolderButton = $false; " +
      "if ($d.ShowDialog($o) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.SelectedPath }; $o.Close()";
    return new Promise((resolvePick, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8', timeout: 300_000, windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        resolvePick(stdout.trim() || null);
      });
    });
  },
  childImages(pid) {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | ForEach-Object { $_.Name }`], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  },
  adoptShellPath() {},
};

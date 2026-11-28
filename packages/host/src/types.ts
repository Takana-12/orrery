// The port to the operating system: everything Orrery needs from the machine it runs on, in one shape.
// Each supported OS has one folder that fills this shape in (windows/, mac/). Nothing outside packages/host (and
// apps/desktop/platform, the same idea for the Electron shell) may ask which OS it is on: a test enforces that
// (test/platform-guard.test.ts), and test/host.contract.test.ts runs the same expectations against whichever
// implementation this machine has. Design notes: docs/08-対応OSと移植層.md.
import type { SpawnOptions } from 'node:child_process';

export interface JobSample {
  sampledAt: string;
  /** What the numbers cover. Always stated, because "memory" without a definition is meaningless. */
  scope: string;
  processCount: number;
  /** Physical RAM currently mapped, summed per process (shared pages are counted in each, so this overstates). */
  workingSetBytes: number;
  /** Windows: committed private bytes (commit charge, NOT physical RAM). macOS has no cheap equivalent: same as workingSetBytes. */
  privateBytes: number;
  processes: { pid: number; image: string; workingSetBytes: number; privateBytes: number }[];
}

/**
 * The set of processes we own: a process we started and everything it spawns, including grandchildren whose parent
 * already exited. One call ends all of them, and nothing in it outlives Orrery.
 */
export interface Job {
  /** Put an already-running process (and everything it spawns from now on) into the job. */
  assign(pid: number): void;
  /** PIDs currently alive in the job. */
  pids(): number[];
  /** Memory of the job right now, summed over its live processes. */
  sample(): JobSample;
  /** Terminate every process in the job. */
  terminate(): boolean;
  /** Let go of the job; whatever is still inside it is ended. */
  close(): void;
}

export interface Host {
  os: 'windows' | 'mac';
  /** OS and CPU the way prebuilt command-line tools name their folders: windows-x86_64, macos-aarch64 ... */
  archTag: string;
  createJob(): Job;
  /**
   * Spread into the options of a spawn whose child is then given to a job. On macOS the child becomes the leader of
   * its own process group, which is how its descendants stay attributable; on Windows the job object needs nothing.
   */
  ownedSpawn: Pick<SpawnOptions, 'detached'>;
  /** Encrypt for the current user of this machine. Returns base64 ciphertext. */
  protect(plain: string): string;
  /** Decrypt something `protect` produced for this user on this machine. Throws otherwise. */
  unprotect(cipherBase64: string): string;
  /** File name of a program: claude.exe on Windows, claude elsewhere. */
  executableName(base: string): string;
  /** Full path of a program on PATH (and the usual install folders), or null. */
  findExecutable(base: string): string | null;
  /** Memory a new process could get without pushing others out, in bytes. */
  freeMemoryBytes(): number;
  /** Where the data lives unless CONTROL_ROOM_HOME says otherwise. */
  defaultDataDir(): string;
  /** Open a page in the person's default browser. */
  openExternal(url: string): void;
  /**
   * Open a file or folder on this computer with what the system opens it with (Explorer / Finder for a folder), or,
   * with `reveal`, show it selected in its folder without opening it. The caller has checked the path exists.
   */
  openPath(path: string, reveal: boolean): void;
  /** Console entry point only: show the UI in a window of its own if the machine has a browser that can, else a tab. */
  openAppWindow(url: string, onFail: () => void): void;
  /** The system's folder chooser. Resolves null if cancelled, rejects if it could not be shown. */
  pickFolder(): Promise<string | null>;
  /** Image names of the processes started directly by `pid` (acceptance tests: nothing may be left behind). */
  childImages(pid: number): string[];
  /**
   * An app started from the desktop (not from a terminal) may not have the PATH the person's shell has, so git, gh,
   * npm and the agents' own tools would not be found. Bring that PATH into this process. No-op where it is not needed.
   */
  adoptShellPath(): void;
}

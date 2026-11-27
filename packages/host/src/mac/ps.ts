// The process table and memory figures of a POSIX machine, read from the tools every macOS has (/bin/ps, vm_stat,
// lsof). The parsers are pure functions over the tools' text, so they are tested on every OS (test/mac-parsers.test.ts).
import { execFileSync } from 'node:child_process';

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  rssBytes: number;
  /** When it started, as ps prints it. Together with the pid this identifies a process even after the pid is reused. */
  started: string;
  /** Path of the executable. */
  command: string;
}

/**
 * Output of `ps -axo pid=,ppid=,pgid=,rss=,state=,lstart=,comm=` (lstart is five words: "Fri Nov 27 10:00:00 2026").
 * A process that has ended but not yet been collected by its parent (state Z) is left out: it runs nothing.
 */
export function parsePs(text: string): Map<number, Proc> {
  const table = new Map<number, Proc>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*\S)\s*$/.exec(line);
    if (!m || m[5]!.startsWith('Z')) continue;
    const pid = Number(m[1]);
    table.set(pid, { pid, ppid: Number(m[2]), pgid: Number(m[3]), rssBytes: Number(m[4]) * 1024, started: m[6]!.replace(/\s+/g, ' '), command: m[7]! });
  }
  return table;
}

/** Output of `vm_stat`: bytes that can be handed out without pushing anything to disk (free + inactive + speculative). */
export function parseVmStat(text: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (name: string): number => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? NaN);
  const free = pages('free');
  if (!page || Number.isNaN(free)) return null;
  return (free + (pages('inactive') || 0) + (pages('speculative') || 0)) * page;
}

/** Output of `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc`: who listens on the port ("p<pid>" then "c<command>"). */
export function parseLsofListener(text: string): { pid: number; command: string } | null {
  const pid = Number(/^p(\d+)$/m.exec(text)?.[1]);
  return pid ? { pid, command: /^c(.*)$/m.exec(text)?.[1] ?? '' } : null;
}

const CACHE_MS = 400;
let cached: { at: number; table: Map<number, Proc> } | null = null;

/** Every process on the machine. One `ps` (about 10 ms) serves all jobs sampled in the same moment. */
export function processTable({ fresh = false } = {}): Map<number, Proc> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.table;
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,rss=,state=,lstart=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  cached = { at: Date.now(), table: parsePs(out) };
  return cached.table;
}

/** After signalling processes: the table in hand no longer describes the machine. */
export function forgetProcessTable(): void {
  cached = null;
}

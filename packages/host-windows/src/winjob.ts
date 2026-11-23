// Windows Job Object helper (kernel32 via koffi FFI, no native build step).
// A job gives what parent-PID walking cannot: the exact set of processes we own, including grandchildren whose
// parent already exited, one atomic "terminate everything I started", and kill-on-close so nothing outlives the
// control room if it crashes.
import koffi from 'koffi';

export interface JobSample {
  sampledAt: string;
  /** What the numbers cover. Always stated, because "memory" without a definition is meaningless. */
  scope: string;
  processCount: number;
  /** Physical RAM currently mapped, summed per process (shared pages are counted in each, so this overstates). */
  workingSetBytes: number;
  /** Committed private bytes (PrivateUsage). Commit charge, NOT physical RAM in use. */
  privateBytes: number;
  processes: { pid: number; image: string; workingSetBytes: number; privateBytes: number }[];
}

const k32 = koffi.load('kernel32.dll');
const CreateJobObjectW = k32.func('void* __stdcall CreateJobObjectW(void* attrs, void* name)');
const SetInformationJobObject = k32.func('bool __stdcall SetInformationJobObject(void* job, int cls, void* info, uint32 len)');
const QueryInformationJobObject = k32.func('bool __stdcall QueryInformationJobObject(void* job, int cls, void* info, uint32 len, void* retLen)');
const AssignProcessToJobObject = k32.func('bool __stdcall AssignProcessToJobObject(void* job, void* process)');
const TerminateJobObject = k32.func('bool __stdcall TerminateJobObject(void* job, uint32 exitCode)');
const OpenProcess = k32.func('void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = k32.func('bool __stdcall CloseHandle(void* h)');
const K32GetProcessMemoryInfo = k32.func('bool __stdcall K32GetProcessMemoryInfo(void* process, void* counters, uint32 cb)');
const K32GetProcessImageFileNameW = k32.func('uint32 __stdcall K32GetProcessImageFileNameW(void* process, void* buf, uint32 size)');

const JobObjectBasicAccountingInformation = 1;
const JobObjectBasicProcessIdList = 3;
const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_VM_READ = 0x0010;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export class WinJob {
  private handle: unknown;

  constructor({ killOnClose = true }: { killOnClose?: boolean } = {}) {
    this.handle = CreateJobObjectW(null, null);
    if (!this.handle) throw new Error('CreateJobObjectW failed');
    if (killOnClose) {
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64; BasicLimitInformation.LimitFlags is at offset 16.
      const info = Buffer.alloc(144);
      info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
      if (!SetInformationJobObject(this.handle, JobObjectExtendedLimitInformation, info, info.length)) throw new Error('SetInformationJobObject failed');
    }
  }

  /** Put an already-running process (and everything it spawns from now on) into the job. */
  assign(pid: number): void {
    const h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
    if (!h) throw new Error(`OpenProcess(${pid}) failed`);
    try {
      if (!AssignProcessToJobObject(this.handle, h)) throw new Error(`AssignProcessToJobObject(${pid}) failed`);
    } finally {
      CloseHandle(h);
    }
  }

  /** PIDs currently alive in the job. */
  pids(): number[] {
    if (!this.handle) return [];
    const buf = Buffer.alloc(8 + 8 * 1024);
    if (!QueryInformationJobObject(this.handle, JobObjectBasicProcessIdList, buf, buf.length, null)) return [];
    const n = buf.readUInt32LE(4);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(Number(buf.readBigUInt64LE(8 + i * 8)));
    return out;
  }

  accounting(): { totalProcesses: number; activeProcesses: number; terminatedProcesses: number } {
    const buf = Buffer.alloc(48);
    if (this.handle) QueryInformationJobObject(this.handle, JobObjectBasicAccountingInformation, buf, buf.length, null);
    return { totalProcesses: buf.readUInt32LE(36), activeProcesses: buf.readUInt32LE(40), terminatedProcesses: buf.readUInt32LE(44) };
  }

  /** Memory of the job right now, summed over its live processes. */
  sample(): JobSample {
    const processes: JobSample['processes'] = [];
    for (const pid of this.pids()) {
      const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid);
      if (!h) continue;
      try {
        const c = Buffer.alloc(80); // PROCESS_MEMORY_COUNTERS_EX (x64)
        c.writeUInt32LE(80, 0);
        if (!K32GetProcessMemoryInfo(h, c, 80)) continue;
        const nameBuf = Buffer.alloc(1040);
        const len = K32GetProcessImageFileNameW(h, nameBuf, 520) as number;
        const full = nameBuf.toString('utf16le', 0, len * 2);
        const image = full.slice(full.lastIndexOf('\\') + 1);
        processes.push({ pid, image, workingSetBytes: Number(c.readBigUInt64LE(16)), privateBytes: Number(c.readBigUInt64LE(72)) });
      } finally {
        CloseHandle(h);
      }
    }
    return {
      sampledAt: new Date().toISOString(),
      scope: 'ジョブ内の全生存プロセス（ルート＋子孫）の瞬間値の合計',
      processCount: processes.length,
      workingSetBytes: processes.reduce((a, p) => a + p.workingSetBytes, 0),
      privateBytes: processes.reduce((a, p) => a + p.privateBytes, 0),
      processes,
    };
  }

  /** Terminate every process in the job. */
  terminate(exitCode = 1): boolean {
    if (!this.handle) return false;
    return TerminateJobObject(this.handle, exitCode) as boolean;
  }

  close(): void {
    if (this.handle) CloseHandle(this.handle);
    this.handle = null;
  }
}

export const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

// #host: the operating system, behind one shape (types.ts). The implementation is chosen here, once, when the
// module is first loaded; the other OS's code is never even read (it would try to open system libraries that are
// not there). To support another OS: add a folder next to windows/ and mac/ that exports `host`, and pick it here.
import type { Host } from './types.ts';

export type { Host, Job, JobSample } from './types.ts';

const impl: Host = process.platform === 'win32' ? (await import('./windows/index.ts')).host : (await import('./mac/index.ts')).host;

export const host = impl;
export const { createJob, protect, unprotect, executableName, findExecutable, freeMemoryBytes, defaultDataDir, openExternal, openAppWindow, pickFolder, childImages, adoptShellPath } = impl;
export const ownedSpawn = impl.ownedSpawn;
/** OS and CPU the way npm names prebuilt packages: win32-x64, darwin-arm64 ... */
export const npmTag = `${process.platform}-${process.arch}`;
export const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

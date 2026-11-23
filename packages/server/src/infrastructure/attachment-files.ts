// Files the human attached to a message, kept on disk. Agents are handed the path and read the file themselves.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class AttachmentFiles {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Store the bytes under a name Windows can hold; each file gets a folder of its own so names never collide. */
  save(name: string, data: Buffer): { name: string; path: string; size: number } {
    // The name is only a label for the agent: keep the last path segment, drop what Windows cannot store.
    const base = basename(String(name || '').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 120);
    const safe = !base || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base) ? `file-${base || 'attachment'}` : base;
    const dir = join(this.dir, randomUUID());
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safe);
    writeFileSync(path, data);
    return { name: safe, path, size: data.length };
  }

  /** Attached files are copies; remove the ones saved before `cutoff`. */
  purge(cutoff: number): void {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const dir = join(this.dir, e);
      try {
        if (statSync(dir).mtimeMs <= cutoff) rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

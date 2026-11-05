// From edspencer/cli-contract reference/service/logs.ts @ 0.2; local changes: `.ts` import specifiers → `.js`.
// `<tool> service logs [-f] [-n <lines>]` (SPEC §1, §7): one Node implementation on every OS, because every unit
// writes to `<home>/logs/service.log`. No `tail`: `tail -f` isn't on Windows, and which `tail` won a PATH lookup would
// change the output. Node built-ins only.

import fs from 'node:fs';

/** How many lines `logs` prints when nobody says (SPEC §1). */
export const DEFAULT_LOG_LINES = 50;

/** Only the end of the file is read for a tail: a log can reach tens of megabytes between rotations. */
const TAIL_WINDOW = 256 * 1024;

/** The last `lines` lines of `file`. A window that starts mid-line drops that fragment. */
export function tailFile(file: string, lines: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_WINDOW);
    if (size === start) return '';
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    const all = text.split('\n');
    if (all.at(-1) === '') all.pop();
    return all.slice(-lines).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

export interface FollowOptions {
  /** Where to start: the file's size after the tail. */
  from: number;
  intervalMs?: number;
  /** Return false to stop. */
  keepGoing?: () => boolean;
  write?: (s: string) => void;
}

/**
 * Prints what's appended to `file` until stopped. Polls the size (`fs.watch` on an appended file is unreliable across
 * platforms). The tool rotates by copy-and-truncate, so the size goes down; seeing that, it starts again from 0
 * rather than reading past the end for ever. A file that vanishes is waited for.
 */
export async function followFile(file: string, o: FollowOptions): Promise<void> {
  const write = o.write ?? ((s: string) => process.stdout.write(s));
  let offset = o.from;
  while (o.keepGoing?.() ?? true) {
    await new Promise<void>((r) => setTimeout(r, o.intervalMs ?? 400));
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0;
    if (size === offset) continue;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      write(buf.toString('utf8'));
      offset = size;
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** The file's size, or 0 if it isn't there: where a follow starts. */
export function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// cli/cli-session-sync/jsonl-tail.mjs
// Incremental, poll-driven reader for an append-only NDJSON / JSONL file (a backend's
// on-disk transcript). Shared by every `live` session-sync adapter: the core pump calls
// `readNew()` on an interval and once more at exit.
//
// Design notes:
//   • Polling, not fs.watch — fs.watch semantics differ across Linux/macOS/Windows and
//     can miss events on network filesystems; a cheap stat+read every ~1 s is portable.
//   • Byte-offset bookkeeping with a carried partial-line remainder, so a line that is
//     half-written when we read is completed on the next read (never parsed twice,
//     never dropped). Decoding happens on whole lines only, so a multi-byte UTF-8
//     character split across reads is never corrupted.
//   • A missing file is "nothing yet" (the backend creates it lazily on first message).
//   • A file that SHRINKS (truncated/replaced) restarts from offset 0.
//   • Never throws: an unreadable file or an unparsable line is reported through the
//     injected logger and skipped.
// Pure JS (node:fs only) — no native dependency (CLAUDE.md pitfall #9).

import { openSync, readSync, closeSync, statSync } from "node:fs";

const READ_CHUNK = 64 * 1024;
const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/**
 * @param {{ path: string, startAt?: "beginning"|"end",
 *   fs?: { openSync: typeof openSync, readSync: typeof readSync, closeSync: typeof closeSync, statSync: typeof statSync },
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 *   maxBytesPerRead?: number }} opts
 *   `startAt: "end"` skips whatever the file already holds at construction time (used
 *   when attaching to a conversation that already has history). Default "beginning".
 * @returns {{ path: string, readNew: () => any[], offset: () => number }}
 */
export function createJsonlTail(opts) {
  const fs = opts.fs ?? { openSync, readSync, closeSync, statSync };
  const logger = opts.logger ?? NOOP_LOGGER;
  const maxBytes = opts.maxBytesPerRead ?? 8 * 1024 * 1024;
  const path = opts.path;
  let offset = 0;
  /** @type {Buffer} */
  let remainder = Buffer.alloc(0);

  const size = () => {
    try {
      return fs.statSync(path).size;
    } catch {
      return null; // not created yet
    }
  };

  if (opts.startAt === "end") offset = size() ?? 0;

  function readNew() {
    const current = size();
    if (current === null) return [];
    if (current < offset) {
      logger.warn(`[sync] transcript file shrank (${offset} → ${current} bytes); re-reading from the start`);
      offset = 0;
      remainder = Buffer.alloc(0);
    }
    if (current === offset) return [];

    const chunks = [remainder];
    let fd;
    try {
      fd = fs.openSync(path, "r");
      let budget = Math.min(current - offset, maxBytes);
      while (budget > 0) {
        const buf = Buffer.alloc(Math.min(READ_CHUNK, budget));
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        if (!n) break;
        chunks.push(buf.subarray(0, n));
        offset += n;
        budget -= n;
      }
    } catch (err) {
      logger.warn(`[sync] could not read transcript file: ${err?.code ?? err?.message ?? err}`);
      return [];
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }

    const data = Buffer.concat(chunks);
    const out = [];
    let start = 0;
    for (let i = 0; i < data.length; i += 1) {
      if (data[i] !== 0x0a) continue;
      const line = data.subarray(start, i).toString("utf8").trim();
      start = i + 1;
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        logger.warn(`[sync] skipped an unparsable transcript line (${line.length} chars)`);
      }
    }
    remainder = Buffer.from(data.subarray(start));
    return out;
  }

  return { path, readNew, offset: () => offset };
}

// cli/__tests__/codex-session-map.test.mjs
// Covers daemon-codex-backend spec "Codex session anchoring via a persisted
// idea→thread-id map": round-trip across restarts, and best-effort degradation
// (missing file / corrupt JSON / write failure never throw into the wake path).
import { describe, it, expect, vi } from "vitest";
import {
  getThreadId,
  setThreadId,
  codexSessionMapPath,
} from "../codex-session-map.mjs";

const ANCHOR = "11111111-1111-4111-8111-111111111111";
const ANCHOR2 = "22222222-2222-4222-8222-222222222222";
const TID = "0199a213-aaaa-7bbb-cccc-dddddddddddd";

/** An in-memory fake FS implementing just the inject points the module uses. */
function makeFakeFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    read: (p) => {
      if (!(p in files)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = "ENOENT";
        throw err;
      }
      return files[p];
    },
    write: (p, c) => {
      files[p] = String(c);
    },
    mkdir: () => {},
    rename: (from, to) => {
      files[to] = files[from];
      delete files[from];
    },
  };
}

describe("codexSessionMapPath", () => {
  it("lives under the ~/.chorus config dir family", () => {
    expect(codexSessionMapPath()).toMatch(/[\\/]\.chorus[\\/]codex-sessions\.json$/);
  });
});

describe("get/set round-trip", () => {
  it("returns null for an unknown anchor on a missing file", () => {
    const io = makeFakeFs();
    expect(getThreadId(ANCHOR, { ...io, path: "/cfg/codex-sessions.json" })).toBeNull();
  });

  it("persists an anchor→thread_id and reads it back (separate calls = restart)", () => {
    const io = makeFakeFs();
    const path = "/cfg/codex-sessions.json";
    setThreadId(ANCHOR, TID, { ...io, path });
    // A fresh getThreadId call (new in-process read) sees the persisted value.
    expect(getThreadId(ANCHOR, { ...io, path })).toBe(TID);
  });

  it("keeps multiple anchors independent and preserves existing entries on set", () => {
    const io = makeFakeFs();
    const path = "/cfg/codex-sessions.json";
    setThreadId(ANCHOR, TID, { ...io, path });
    setThreadId(ANCHOR2, "second-thread", { ...io, path });
    expect(getThreadId(ANCHOR, { ...io, path })).toBe(TID);
    expect(getThreadId(ANCHOR2, { ...io, path })).toBe("second-thread");
  });

  it("overwrites the thread_id when set again for the same anchor", () => {
    const io = makeFakeFs();
    const path = "/cfg/codex-sessions.json";
    setThreadId(ANCHOR, TID, { ...io, path });
    setThreadId(ANCHOR, "new-thread", { ...io, path });
    expect(getThreadId(ANCHOR, { ...io, path })).toBe("new-thread");
  });

  it("writes atomically via a .tmp sibling then rename", () => {
    const io = makeFakeFs();
    const path = "/cfg/codex-sessions.json";
    const rename = vi.fn(io.rename);
    setThreadId(ANCHOR, TID, { ...io, path, rename });
    expect(rename).toHaveBeenCalledWith(`${path}.tmp`, path);
  });
});

describe("best-effort degradation (never throws into the wake path)", () => {
  it("getThreadId returns null on corrupt JSON (and logs)", () => {
    const io = makeFakeFs({ "/cfg/codex-sessions.json": "{ not json" });
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    expect(() => getThreadId(ANCHOR, { ...io, path: "/cfg/codex-sessions.json", logger })).not.toThrow();
    expect(getThreadId(ANCHOR, { ...io, path: "/cfg/codex-sessions.json", logger })).toBeNull();
  });

  it("getThreadId returns null when the stored value for the anchor is not a string", () => {
    const io = makeFakeFs({ "/cfg/codex-sessions.json": JSON.stringify({ [ANCHOR]: 123 }) });
    expect(getThreadId(ANCHOR, { ...io, path: "/cfg/codex-sessions.json" })).toBeNull();
  });

  it("setThreadId swallows a write failure (logs, does not throw)", () => {
    const io = makeFakeFs();
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const write = () => {
      throw new Error("EACCES");
    };
    expect(() =>
      setThreadId(ANCHOR, TID, { ...io, path: "/cfg/codex-sessions.json", write, logger })
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("setThreadId swallows a rename failure (logs, does not throw)", () => {
    const io = makeFakeFs();
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const rename = () => {
      throw new Error("EXDEV");
    };
    expect(() =>
      setThreadId(ANCHOR, TID, { ...io, path: "/cfg/codex-sessions.json", rename, logger })
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("ignores a blank anchor or blank threadId on set (no write)", () => {
    const io = makeFakeFs();
    const write = vi.fn(io.write);
    setThreadId("", TID, { ...io, path: "/cfg/codex-sessions.json", write });
    setThreadId(ANCHOR, "", { ...io, path: "/cfg/codex-sessions.json", write });
    expect(write).not.toHaveBeenCalled();
  });
});

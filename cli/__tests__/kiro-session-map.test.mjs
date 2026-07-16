// cli/__tests__/kiro-session-map.test.mjs
// Covers daemon-kiro-backend spec "Kiro session anchoring via a persisted
// idea→session-id map": round-trip across restarts, and best-effort degradation
// (missing file / corrupt JSON / write failure never throw into the wake path).
// Mirrors codex-session-map.test.mjs — both wrap the shared session-map factory.
import { describe, it, expect, vi } from "vitest";
import {
  getSessionId,
  setSessionId,
  kiroSessionMapPath,
} from "../kiro-session-map.mjs";

const ANCHOR = "11111111-1111-4111-8111-111111111111";
const ANCHOR2 = "22222222-2222-4222-8222-222222222222";
const SID = "540019be-35ec-4740-8880-a6c83f172646";

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

describe("kiroSessionMapPath", () => {
  it("lives under the ~/.chorus config dir family", () => {
    expect(kiroSessionMapPath()).toMatch(/[\\/]\.chorus[\\/]kiro-sessions\.json$/);
  });
});

describe("get/set round-trip", () => {
  it("returns null for an unknown anchor on a missing file", () => {
    const io = makeFakeFs();
    expect(getSessionId(ANCHOR, { ...io, path: "/cfg/kiro-sessions.json" })).toBeNull();
  });

  it("persists an anchor→sessionId and reads it back (separate calls = restart)", () => {
    const io = makeFakeFs();
    const path = "/cfg/kiro-sessions.json";
    setSessionId(ANCHOR, SID, { ...io, path });
    expect(getSessionId(ANCHOR, { ...io, path })).toBe(SID);
  });

  it("keeps multiple anchors independent and preserves existing entries on set", () => {
    const io = makeFakeFs();
    const path = "/cfg/kiro-sessions.json";
    setSessionId(ANCHOR, SID, { ...io, path });
    setSessionId(ANCHOR2, "second-session", { ...io, path });
    expect(getSessionId(ANCHOR, { ...io, path })).toBe(SID);
    expect(getSessionId(ANCHOR2, { ...io, path })).toBe("second-session");
  });

  it("overwrites the sessionId when set again for the same anchor", () => {
    const io = makeFakeFs();
    const path = "/cfg/kiro-sessions.json";
    setSessionId(ANCHOR, SID, { ...io, path });
    setSessionId(ANCHOR, "new-session", { ...io, path });
    expect(getSessionId(ANCHOR, { ...io, path })).toBe("new-session");
  });

  it("writes atomically via a .tmp sibling then rename", () => {
    const io = makeFakeFs();
    const path = "/cfg/kiro-sessions.json";
    const rename = vi.fn(io.rename);
    setSessionId(ANCHOR, SID, { ...io, path, rename });
    expect(rename).toHaveBeenCalledWith(`${path}.tmp`, path);
  });

  it("writes the temp file with mode 0600", () => {
    const io = makeFakeFs();
    const path = "/cfg/kiro-sessions.json";
    const write = vi.fn(io.write);
    setSessionId(ANCHOR, SID, { ...io, path, write });
    expect(write).toHaveBeenCalledWith(`${path}.tmp`, expect.any(String), { mode: 0o600 });
  });
});

describe("best-effort degradation (never throws into the wake path)", () => {
  it("getSessionId returns null on corrupt JSON (and logs)", () => {
    const io = makeFakeFs({ "/cfg/kiro-sessions.json": "{ not json" });
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    expect(() => getSessionId(ANCHOR, { ...io, path: "/cfg/kiro-sessions.json", logger })).not.toThrow();
    expect(getSessionId(ANCHOR, { ...io, path: "/cfg/kiro-sessions.json", logger })).toBeNull();
  });

  it("getSessionId returns null when the stored value for the anchor is not a string", () => {
    const io = makeFakeFs({ "/cfg/kiro-sessions.json": JSON.stringify({ [ANCHOR]: 123 }) });
    expect(getSessionId(ANCHOR, { ...io, path: "/cfg/kiro-sessions.json" })).toBeNull();
  });

  it("setSessionId swallows a write failure (logs, does not throw)", () => {
    const io = makeFakeFs();
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const write = () => {
      throw new Error("EACCES");
    };
    expect(() =>
      setSessionId(ANCHOR, SID, { ...io, path: "/cfg/kiro-sessions.json", write, logger })
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("setSessionId swallows a rename failure (logs, does not throw)", () => {
    const io = makeFakeFs();
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const rename = () => {
      throw new Error("EXDEV");
    };
    expect(() =>
      setSessionId(ANCHOR, SID, { ...io, path: "/cfg/kiro-sessions.json", rename, logger })
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("ignores a blank anchor or blank sessionId on set (no write)", () => {
    const io = makeFakeFs();
    const write = vi.fn(io.write);
    setSessionId("", SID, { ...io, path: "/cfg/kiro-sessions.json", write });
    setSessionId(ANCHOR, "", { ...io, path: "/cfg/kiro-sessions.json", write });
    expect(write).not.toHaveBeenCalled();
  });
});

// cli/__tests__/session-map.test.mjs
// Covers cli-daemon spec "Lineage-anchored session continuity" (mapping half):
// same root resumes, new root is fresh, persistence, corrupt/missing tolerance.
import { describe, it, expect } from "vitest";
import { SessionMap, sessionMapPath } from "../session-map.mjs";

const silent = { info() {}, warn() {}, error() {} };

/** In-memory fake fs for the map file. */
function fakeFs(initialContent) {
  const store = { content: initialContent };
  return {
    store,
    read: () => {
      if (store.content === undefined) {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      }
      return store.content;
    },
    write: (_p, c) => {
      store.content = c;
    },
    mkdir: () => {},
  };
}

describe("SessionMap resolve/record", () => {
  it("new root → isNew:true, sessionId null; after record → isNew:false, resume id", () => {
    const fs = fakeFs(undefined);
    const map = new SessionMap({ path: "/m.json", logger: silent, now: () => "T0", ...fs });

    expect(map.resolve("root-1")).toEqual({ sessionId: null, isNew: true });

    map.record("root-1", "claude-sid-1");
    expect(map.resolve("root-1")).toEqual({ sessionId: "claude-sid-1", isNew: false });

    // Different root is still new
    expect(map.resolve("root-2")).toEqual({ sessionId: null, isNew: true });
  });

  it("persists to disk and reloads in a fresh instance", () => {
    const fs = fakeFs(undefined);
    const a = new SessionMap({ path: "/m.json", logger: silent, now: () => "T1", ...fs });
    a.record("root-1", "sid-1");

    // New instance reading the same backing store
    const b = new SessionMap({ path: "/m.json", logger: silent, ...fs });
    expect(b.resolve("root-1")).toEqual({ sessionId: "sid-1", isNew: false });

    // Persisted JSON shape
    expect(JSON.parse(fs.store.content)["root-1"]).toEqual({ sessionId: "sid-1", updatedAt: "T1" });
  });

  it("record() writes 0600 and includes updatedAt", () => {
    const writes = [];
    const map = new SessionMap({
      path: "/m.json",
      logger: silent,
      now: () => "STAMP",
      read: () => {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
      write: (p, c, o) => writes.push([p, c, o]),
      mkdir: () => {},
    });
    map.record("k", "s");
    expect(writes[0][2]).toEqual({ mode: 0o600 });
    expect(JSON.parse(writes[0][1]).k).toEqual({ sessionId: "s", updatedAt: "STAMP" });
  });
});

describe("SessionMap fault tolerance", () => {
  it("missing file → starts empty (no crash, no warn)", () => {
    const warns = [];
    const map = new SessionMap({
      path: "/nope.json",
      logger: { ...silent, warn: (m) => warns.push(m) },
      read: () => {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      },
      write: () => {},
      mkdir: () => {},
    });
    expect(map.resolve("anything")).toEqual({ sessionId: null, isNew: true });
    expect(warns).toEqual([]); // missing file is normal, not a warning
  });

  it("corrupt JSON → starts empty + logs a warning (no crash)", () => {
    const warns = [];
    const map = new SessionMap({
      path: "/m.json",
      logger: { ...silent, warn: (m) => warns.push(m) },
      read: () => "{ this is not valid json ",
      write: () => {},
      mkdir: () => {},
    });
    expect(map.resolve("k")).toEqual({ sessionId: null, isNew: true });
    expect(warns.join("")).toMatch(/corrupt/i);
  });

  it("ignores entries without a string sessionId", () => {
    const map = new SessionMap({
      path: "/m.json",
      logger: silent,
      read: () => JSON.stringify({ good: { sessionId: "s" }, bad: { nope: 1 } }),
      write: () => {},
      mkdir: () => {},
    });
    expect(map.resolve("good").isNew).toBe(false);
    expect(map.resolve("bad").isNew).toBe(true);
  });

  it("a failed persist write is swallowed with a warning", () => {
    const warns = [];
    const map = new SessionMap({
      path: "/ro.json",
      logger: { ...silent, warn: (m) => warns.push(m) },
      read: () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
      write: () => { throw new Error("EACCES"); },
      mkdir: () => {},
      now: () => "T",
    });
    expect(() => map.record("k", "s")).not.toThrow();
    expect(warns.join("")).toMatch(/failed to persist/i);
  });
});

describe("sessionMapPath", () => {
  it("ends with .chorus/sessions.json", () => {
    expect(sessionMapPath().replace(/\\/g, "/")).toMatch(/\.chorus\/sessions\.json$/);
  });
});

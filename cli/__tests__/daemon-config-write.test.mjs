// cli/__tests__/daemon-config-write.test.mjs
// Covers the shared updateDaemonConfig(partial) read→merge→write(0600) helper
// (daemon-config-field-merge change). Every daemon.json writer routes through it,
// so a chorus login / credential-completion never clobbers cwds / yoloAckAt.
import { describe, it, expect } from "vitest";
import { updateDaemonConfig } from "../login.mjs";

/**
 * Build an injectable IO bundle that captures writes and renames in memory.
 * `existing` is the JSON string the read seam returns (or a function that throws).
 */
function ioHarness(existing) {
  const calls = { writes: [], renames: [], mkdirs: [] };
  const deps = {
    path: "/p/daemon.json",
    read: typeof existing === "function" ? existing : () => existing,
    mkdir: (p, o) => calls.mkdirs.push([p, o]),
    write: (p, c, o) => calls.writes.push([p, c, o]),
    rename: (from, to) => calls.renames.push([from, to]),
  };
  return { calls, deps };
}

describe("updateDaemonConfig — field-level merge", () => {
  it("preserves pre-existing unrelated keys while adding the partial", () => {
    const { calls, deps } = ioHarness(
      JSON.stringify({ cwds: ["/a", "/b"], yoloAckAt: "2026-06-20T00:00:00.000Z" })
    );
    const path = updateDaemonConfig(
      { url: "u", apiKey: "cho_x", agentUuid: "a", agentName: "n" },
      deps
    );
    expect(path).toBe("/p/daemon.json");
    const written = JSON.parse(calls.writes[0][1]);
    expect(written).toEqual({
      cwds: ["/a", "/b"],
      yoloAckAt: "2026-06-20T00:00:00.000Z",
      url: "u",
      apiKey: "cho_x",
      agentUuid: "a",
      agentName: "n",
    });
  });

  it("overwrites a key the partial also sets (partial wins)", () => {
    const { calls, deps } = ioHarness(
      JSON.stringify({ url: "old", cwds: ["/keep"] })
    );
    updateDaemonConfig({ url: "new" }, deps);
    const written = JSON.parse(calls.writes[0][1]);
    expect(written).toEqual({ url: "new", cwds: ["/keep"] });
  });

  it("missing file (ENOENT) → creates a file with just the partial (no throw)", () => {
    const { calls, deps } = ioHarness(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    updateDaemonConfig({ yoloAckAt: "2026-06-21T12:00:00.000Z" }, deps);
    const written = JSON.parse(calls.writes[0][1]);
    expect(written).toEqual({ yoloAckAt: "2026-06-21T12:00:00.000Z" });
  });

  it("malformed file → treated as empty (no throw)", () => {
    const { calls, deps } = ioHarness("}{ not json");
    updateDaemonConfig({ url: "u" }, deps);
    expect(JSON.parse(calls.writes[0][1])).toEqual({ url: "u" });
  });

  it("non-object JSON (e.g. an array) → treated as empty", () => {
    const { calls, deps } = ioHarness("[1,2,3]");
    updateDaemonConfig({ url: "u" }, deps);
    expect(JSON.parse(calls.writes[0][1])).toEqual({ url: "u" });
  });

  it("writes with 0600 mode and a trailing newline", () => {
    const { calls, deps } = ioHarness("{}");
    updateDaemonConfig({ url: "u" }, deps);
    expect(calls.writes[0][2]).toEqual({ mode: 0o600 });
    expect(calls.writes[0][1].endsWith("\n")).toBe(true);
  });

  it("is atomic: writes to <path>.tmp then renames over the target", () => {
    const { calls, deps } = ioHarness("{}");
    updateDaemonConfig({ url: "u" }, deps);
    // the write goes to the temp path, NOT the live file
    expect(calls.writes[0][0]).toBe("/p/daemon.json.tmp");
    // then the temp is renamed over the target
    expect(calls.renames[0]).toEqual(["/p/daemon.json.tmp", "/p/daemon.json"]);
    // mkdir of the parent dir happens (recursive)
    expect(calls.mkdirs[0][1]).toEqual({ recursive: true });
  });
});

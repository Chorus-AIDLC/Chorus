// cli/__tests__/daemon-permission-wiring.test.mjs
// Covers the runDaemon wiring of daemon-permission-mode: default yolo (no
// confirmation, always warns), --chorus-only restricted, and the permissionMode
// threaded into build(). Also covers recordYoloAck (preserve creds) and login
// PRESERVING the ack via field-level merge (daemon-config-field-merge) — those
// helpers still exist even though the daemon path no longer prompts/persists an ack.
import { describe, it, expect, vi } from "vitest";
import { runDaemon } from "../daemon.mjs";
import { recordYoloAck, writeLoginFile } from "../login.mjs";

/** Minimal happy-path deps; per-test overrides merge on top. */
function baseDeps(over = {}) {
  return {
    resolve: () => ({ url: "u", apiKey: "cho_x", source: "env" }),
    validate: async () => ({ uuid: "agent-1", name: "Daemon Bot" }),
    build: vi.fn(() => ({ async start() {}, async stop() {} })),
    log: () => {},
    errLog: () => {},
    waitForever: async () => {},
    ...over,
  };
}

describe("runDaemon — default yolo posture threading", () => {
  it("non-TTY default start runs yolo, warns once, no prompt, build gets permissionMode:yolo", async () => {
    const errs = [];
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const askPrompt = vi.fn();
    const code = await runDaemon(
      {},
      baseDeps({ isTTY: false, errLog: (m) => errs.push(m), build, prompt: askPrompt })
    );
    expect(code).toBe(0);
    expect(askPrompt).not.toHaveBeenCalled();
    expect(build.mock.calls[0][1].permissionMode).toBe("yolo");
    const warnings = errs.filter((m) => m.includes("YOLO"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--chorus-only");
  });

  it("--chorus-only forces restricted, no warning, build gets permissionMode:chorus", async () => {
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const errs = [];
    const code = await runDaemon(
      { chorusOnly: true },
      baseDeps({ isTTY: false, build, errLog: (m) => errs.push(m) })
    );
    expect(code).toBe(0);
    expect(build.mock.calls[0][1].permissionMode).toBe("chorus");
    expect(errs.join("")).not.toContain("YOLO");
  });
});

describe("runDaemon — TTY yolo starts without confirmation", () => {
  it("TTY default start runs yolo, warns, never prompts, build gets permissionMode:yolo", async () => {
    const errs = [];
    const askPrompt = vi.fn();
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const code = await runDaemon(
      {},
      baseDeps({ isTTY: true, prompt: askPrompt, build, errLog: (m) => errs.push(m) })
    );
    expect(code).toBe(0);
    expect(askPrompt).not.toHaveBeenCalled();
    expect(build.mock.calls[0][1].permissionMode).toBe("yolo");
    const warnings = errs.filter((m) => m.includes("YOLO"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--chorus-only");
  });
});

describe("recordYoloAck — preserves credentials, adds ack", () => {
  it("merges yoloAckAt into the existing file without touching creds", () => {
    const existing = { url: "u", apiKey: "cho_x", agentUuid: "a", agentName: "n" };
    let writtenContent;
    const path = recordYoloAck("2026-06-21T12:00:00.000Z", {
      path: "/p/daemon.json",
      read: () => JSON.stringify(existing),
      mkdir: () => {},
      write: (_p, c) => { writtenContent = c; },
      rename: () => {},
    });
    expect(path).toBe("/p/daemon.json");
    expect(JSON.parse(writtenContent)).toEqual({ ...existing, yoloAckAt: "2026-06-21T12:00:00.000Z" });
  });
});

describe("runDaemon — --agent validation", () => {
  it("unknown --agent errors non-zero before resolving credentials (no silent fallback)", async () => {
    const resolve = vi.fn();
    const build = vi.fn();
    const errs = [];
    const code = await runDaemon(
      { agent: "codex" },
      baseDeps({ resolve, build, errLog: (m) => errs.push(m) })
    );
    expect(code).toBe(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(errs.join("")).toContain("codex");
    expect(errs.join("")).toContain("claude-code");
  });

  it("a known --agent threads agentType into build()", async () => {
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));
    const code = await runDaemon(
      { agent: "claude-code" },
      baseDeps({ isTTY: false, build })
    );
    expect(code).toBe(0);
    expect(build.mock.calls[0][1].agentType).toBe("claude-code");
  });
});

describe("recordYoloAck — persists even with no prior login file (env/flag creds)", () => {
  it("treats a missing login file as empty and still writes yoloAckAt", () => {
    // A TTY user whose creds came from env/flags has no ~/.chorus/daemon.json yet.
    // recordYoloAck must NOT throw on ENOENT — it must write a file carrying the ack.
    let writtenContent;
    const path = recordYoloAck("2026-06-21T12:00:00.000Z", {
      path: "/p/daemon.json",
      read: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
      mkdir: () => {},
      write: (_p, c) => { writtenContent = c; },
      rename: () => {},
    });
    expect(path).toBe("/p/daemon.json");
    expect(JSON.parse(writtenContent)).toEqual({ yoloAckAt: "2026-06-21T12:00:00.000Z" });
  });

  it("treats a malformed login file as empty (does not throw)", () => {
    let writtenContent;
    recordYoloAck("2026-06-21T12:00:00.000Z", {
      path: "/p/daemon.json",
      read: () => "}{ not json",
      mkdir: () => {},
      write: (_p, c) => { writtenContent = c; },
      rename: () => {},
    });
    expect(JSON.parse(writtenContent)).toEqual({ yoloAckAt: "2026-06-21T12:00:00.000Z" });
  });
});

describe("writeLoginFile — a re-login PRESERVES any prior ack (field-level merge)", () => {
  it("writing fresh credentials keeps a pre-existing yoloAckAt and cwds", () => {
    // daemon-config-field-merge: login now merges, so the recorded yolo ack and
    // the served cwds survive a re-login (supersedes the old clear-on-login).
    const existing = { cwds: ["/a", "/b"], yoloAckAt: "2026-06-20T00:00:00.000Z" };
    let body;
    writeLoginFile(
      { url: "u2", apiKey: "cho_y", agentUuid: "a2", agentName: "n2" },
      {
        path: "/p/daemon.json",
        read: () => JSON.stringify(existing),
        mkdir: () => {},
        write: (_p, c) => (body = c),
        rename: () => {},
      }
    );
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({
      cwds: ["/a", "/b"],
      yoloAckAt: "2026-06-20T00:00:00.000Z",
      url: "u2",
      apiKey: "cho_y",
      agentUuid: "a2",
      agentName: "n2",
    });
  });
});

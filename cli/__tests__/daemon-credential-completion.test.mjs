// cli/__tests__/daemon-credential-completion.test.mjs
// Covers cli-auth ADDED requirement: interactive credential completion at
// daemon start (TTY only); non-TTY preserves the hard error.
import { describe, it, expect, vi } from "vitest";
import { runDaemon } from "../daemon.mjs";
import { writeLoginFile } from "../login.mjs";

const NO_CREDS = () => {
  throw new Error(
    "Could not resolve Chorus credentials (url + cho_ API key). Tried, in order:\n" +
      "  1. --url/--api-key flags\n  ...\n  • login:   chorus login"
  );
};

/** Deps that make the post-credential path a no-op success. */
function tailDeps(over = {}) {
  return {
    build: () => ({ async start() {}, async stop() {} }),
    waitForever: async () => {},
    // ack already present so the yolo path doesn't prompt in these cred tests
    readYoloAck: () => "2026-06-20T00:00:00.000Z",
    recordYoloAck: vi.fn(),
    log: () => {},
    errLog: () => {},
    ...over,
  };
}

describe("runDaemon — TTY interactive credential completion", () => {
  it("prompts URL + masked key, validates, persists 0600, and continues", async () => {
    const asks = [];
    const ask = vi.fn(async (q, opts) => {
      asks.push({ q, mask: opts?.mask ?? false });
      return q.startsWith("Chorus URL") ? "https://typed" : "cho_typed";
    });
    const validate = vi.fn(async () => ({ uuid: "agent-9", name: "Bot" }));
    const writeLoginFile = vi.fn(() => "/home/u/.chorus/daemon.json");
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));

    const code = await runDaemon(
      {},
      tailDeps({ isTTY: true, resolve: NO_CREDS, validate, prompt: ask, writeLoginFile, build })
    );

    expect(code).toBe(0);
    // URL prompt not masked; key prompt masked.
    expect(asks).toEqual([
      { q: "Chorus URL: ", mask: false },
      { q: "Chorus API key (cho_...): ", mask: true },
    ]);
    expect(validate).toHaveBeenCalledWith({ url: "https://typed", apiKey: "cho_typed" });
    expect(writeLoginFile).toHaveBeenCalledWith({
      url: "https://typed",
      apiKey: "cho_typed",
      agentUuid: "agent-9",
      agentName: "Bot",
    });
    // Continued into startup with the completed creds.
    expect(build).toHaveBeenCalledOnce();
    // Did NOT double-validate (completion's validate is the only call).
    expect(validate).toHaveBeenCalledOnce();
  });

  it("failed validation during completion writes nothing and exits non-zero", async () => {
    const validate = vi.fn(async () => {
      throw new Error("401 Unauthorized");
    });
    const writeLoginFile = vi.fn();
    const build = vi.fn();
    const errs = [];

    const code = await runDaemon(
      {},
      tailDeps({
        isTTY: true,
        resolve: NO_CREDS,
        validate,
        prompt: async (q) => (q.startsWith("Chorus URL") ? "https://x" : "cho_bad"),
        writeLoginFile,
        build,
        errLog: (m) => errs.push(m),
      })
    );

    expect(code).toBe(1);
    expect(writeLoginFile).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(errs.join("\n")).toMatch(/NOT saved/i);
  });

  it("the completion write field-merges — preserves pre-existing cwds AND yoloAckAt (regression)", async () => {
    // daemon.mjs preflight() writeCreds path: with the merge helper in place it must
    // NOT clobber a daemon.json that already carries cwds/yoloAckAt (the idea's bug,
    // second write site). Inject the REAL writeLoginFile over an in-memory store.
    const store = { json: JSON.stringify({ cwds: ["/srv/a"], yoloAckAt: "2026-06-20T00:00:00.000Z" }) };
    const realWriteCreds = (data) =>
      writeLoginFile(data, {
        path: "/p/daemon.json",
        read: () => store.json,
        mkdir: () => {},
        write: (_p, c) => { store.tmp = c; },
        rename: () => { store.json = store.tmp; },
      });
    const validate = vi.fn(async () => ({ uuid: "agent-9", name: "Bot" }));
    const build = vi.fn(() => ({ async start() {}, async stop() {} }));

    const code = await runDaemon(
      {},
      tailDeps({
        isTTY: true,
        resolve: NO_CREDS,
        validate,
        prompt: async (q) => (q.startsWith("Chorus URL") ? "https://typed" : "cho_typed"),
        writeLoginFile: realWriteCreds,
        build,
      })
    );

    expect(code).toBe(0);
    expect(build).toHaveBeenCalledOnce();
    expect(JSON.parse(store.json)).toEqual({
      cwds: ["/srv/a"],
      yoloAckAt: "2026-06-20T00:00:00.000Z",
      url: "https://typed",
      apiKey: "cho_typed",
      agentUuid: "agent-9",
      agentName: "Bot",
    });
  });

  it("aborts (no validate/write) when the user enters nothing", async () => {
    const validate = vi.fn();
    const writeLoginFile = vi.fn();
    const code = await runDaemon(
      {},
      tailDeps({
        isTTY: true,
        resolve: NO_CREDS,
        validate,
        prompt: async () => "", // empty for both prompts
        writeLoginFile,
        build: vi.fn(),
      })
    );
    expect(code).toBe(1);
    expect(validate).not.toHaveBeenCalled();
    expect(writeLoginFile).not.toHaveBeenCalled();
  });
});

describe("runDaemon — non-TTY missing credentials", () => {
  it("does NOT prompt; emits the multi-source error and exits non-zero", async () => {
    const ask = vi.fn();
    const errs = [];
    const code = await runDaemon(
      {},
      tailDeps({ isTTY: false, resolve: NO_CREDS, prompt: ask, errLog: (m) => errs.push(m), build: vi.fn() })
    );
    expect(code).toBe(1);
    expect(ask).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("Could not resolve Chorus credentials");
    expect(errs.join("\n")).toContain("chorus login");
  });
});

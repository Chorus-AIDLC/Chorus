// cli/__tests__/login.test.mjs
// Covers cli-auth spec "Interactive login command".
import { describe, it, expect, vi } from "vitest";
import { runLogin, writeLoginFile, prompt } from "../login.mjs";

describe("runLogin success path", () => {
  it("validates, persists with identity, echoes name+uuid, returns 0", async () => {
    const written = [];
    const logs = [];
    const validate = vi.fn(async () => ({ uuid: "agent-123", name: "Daemon Bot" }));
    const write = vi.fn((data) => {
      written.push(data);
      return "/home/u/.chorus/daemon.json";
    });

    const code = await runLogin(
      { url: "https://chorus.example", apiKey: "cho_valid" },
      { validate, write, log: (m) => logs.push(m), errLog: (m) => logs.push("ERR:" + m) }
    );

    expect(code).toBe(0);
    expect(validate).toHaveBeenCalledWith({ url: "https://chorus.example", apiKey: "cho_valid" });
    expect(written).toEqual([
      { url: "https://chorus.example", apiKey: "cho_valid", agentUuid: "agent-123", agentName: "Daemon Bot" },
    ]);
    expect(logs.join("\n")).toContain("Daemon Bot");
    expect(logs.join("\n")).toContain("agent-123");
  });
});

describe("runLogin failure path", () => {
  it("does NOT write the file when validation fails, returns non-zero", async () => {
    const validate = vi.fn(async () => {
      throw new Error("Invalid API key");
    });
    const write = vi.fn();
    const errs = [];

    const code = await runLogin(
      { url: "https://chorus.example", apiKey: "cho_bad" },
      { validate, write, log: () => {}, errLog: (m) => errs.push(m) }
    );

    expect(code).toBe(1);
    expect(write).not.toHaveBeenCalled();
    expect(errs.join("\n")).toContain("Invalid API key");
    expect(errs.join("\n")).toMatch(/NOT saved/i);
  });

  it("aborts (no validate, no write) when url or key missing after prompting", async () => {
    const validate = vi.fn();
    const write = vi.fn();
    const code = await runLogin(
      {},
      {
        validate,
        write,
        prompt: vi.fn(async () => ""), // user enters nothing
        log: () => {},
        errLog: () => {},
      }
    );
    expect(code).toBe(1);
    expect(validate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("runLogin interactive prompting", () => {
  it("prompts for url then masked api key when flags absent", async () => {
    const asks = [];
    const ask = vi.fn(async (q, opts) => {
      asks.push({ q, mask: opts?.mask ?? false });
      return q.startsWith("Chorus URL") ? "https://typed" : "cho_typed";
    });
    const validate = vi.fn(async () => ({ uuid: "u", name: "n" }));
    const write = vi.fn(() => "/p");

    const code = await runLogin({}, { validate, write, prompt: ask, log: () => {}, errLog: () => {} });

    expect(code).toBe(0);
    // URL prompt is not masked; API-key prompt IS masked
    expect(asks).toEqual([
      { q: "Chorus URL: ", mask: false },
      { q: "Chorus API key (cho_...): ", mask: true },
    ]);
    expect(validate).toHaveBeenCalledWith({ url: "https://typed", apiKey: "cho_typed" });
  });
});

describe("writeLoginFile", () => {
  it("creates the dir and writes JSON with 0600 mode", () => {
    const mkdirCalls = [];
    const writeCalls = [];
    const path = writeLoginFile(
      { url: "u", apiKey: "k", agentUuid: "a", agentName: "n" },
      {
        path: "/home/u/.chorus/daemon.json",
        mkdir: (p, o) => mkdirCalls.push([p, o]),
        write: (p, c, o) => writeCalls.push([p, c, o]),
      }
    );
    expect(path).toBe("/home/u/.chorus/daemon.json");
    expect(mkdirCalls[0][1]).toEqual({ recursive: true });
    expect(writeCalls[0][2]).toEqual({ mode: 0o600 });
    expect(JSON.parse(writeCalls[0][1])).toEqual({ url: "u", apiKey: "k", agentUuid: "a", agentName: "n" });
  });
});

describe("prompt masking", () => {
  it("masked prompt does not echo typed secret characters to output", async () => {
    // Simulate a readline-style input: feed the query, type chars, press enter.
    const { Readable, Writable } = await import("node:stream");
    const outChunks = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        outChunks.push(chunk.toString());
        cb();
      },
    });
    // Readable that emits the secret + newline
    const input = Readable.from(["cho_secret123\n"]);
    // node's readline needs a TTY-ish input; Readable.from works for line input.
    const answer = await prompt("Key: ", { mask: true, input, output });
    expect(answer).toBe("cho_secret123");
    // The secret must not appear verbatim in echoed output.
    expect(outChunks.join("")).not.toContain("cho_secret123");
  });
});

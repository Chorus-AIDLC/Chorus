// cli/__tests__/agent-backend-prompt.test.mjs
// Unit tests for the shared agent-backend menu (daemon-add-agent-type-prompt).
// promptAgentBackend is pure with injected IO — no real TTY. It returns the
// chosen backend value, or `undefined` ("no explicit choice → inherit the daemon
// default") on Enter / out-of-range / garbage / non-TTY.
import { describe, it, expect, vi } from "vitest";
import { AGENT_MENU, promptAgentBackend } from "../agent-backend-prompt.mjs";
import { KNOWN_AGENTS } from "../daemon-agent.mjs";

describe("AGENT_MENU", () => {
  it("advertises claude-code / codex / kiro / pi (dsh de-advertised)", () => {
    expect(AGENT_MENU.map((r) => r.value)).toEqual(["claude-code", "codex", "kiro", "pi"]);
    // Every advertised value must be a KNOWN_AGENTS backend.
    for (const row of AGENT_MENU) expect(KNOWN_AGENTS).toContain(row.value);
    // pi is a first-class wakeable backend now → advertised in the numbered menu.
    expect(AGENT_MENU.map((r) => r.value)).toContain("pi");
    // dsh stays reachable by name but is NOT advertised in the numbered menu.
    expect(AGENT_MENU.map((r) => r.value)).not.toContain("dsh");
  });
});

describe("promptAgentBackend", () => {
  function deps(over = {}) {
    return {
      ask: vi.fn(async () => ""),
      log: vi.fn(),
      isTTY: true,
      ...over,
    };
  }

  it("returns undefined immediately on a non-TTY (no prompt, no output)", async () => {
    const ask = vi.fn(async () => "2");
    const log = vi.fn();
    const r = await promptAgentBackend({ ask, log, isTTY: false });
    expect(r).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("returns undefined when no ask function is provided", async () => {
    const r = await promptAgentBackend({ isTTY: true });
    expect(r).toBeUndefined();
  });

  it("renders every AGENT_MENU row in the menu text", async () => {
    const o = deps({ ask: vi.fn(async () => "") });
    await promptAgentBackend(o);
    const printed = o.log.mock.calls.flat().join("\n");
    for (const row of AGENT_MENU) expect(printed).toContain(row.label);
  });

  it("Enter (empty answer) returns undefined → inherit the default", async () => {
    const r = await promptAgentBackend(deps({ ask: vi.fn(async () => "") }));
    expect(r).toBeUndefined();
  });

  it("a whitespace-only answer is treated as empty → undefined", async () => {
    const r = await promptAgentBackend(deps({ ask: vi.fn(async () => "   ") }));
    expect(r).toBeUndefined();
  });

  it("a numeric selection picks the matching backend", async () => {
    const r = await promptAgentBackend(deps({ ask: vi.fn(async () => "2") }));
    expect(r).toBe("codex"); // 2) Codex CLI
  });

  it("the first menu entry (1) selects claude-code", async () => {
    const r = await promptAgentBackend(deps({ ask: vi.fn(async () => "1") }));
    expect(r).toBe("claude-code");
  });

  it("accepts a backend typed by name", async () => {
    const r = await promptAgentBackend(deps({ ask: vi.fn(async () => "kiro") }));
    expect(r).toBe("kiro");
  });

  it("accepts a de-advertised backend (dsh) typed by name", async () => {
    const r = await promptAgentBackend(deps({ ask: vi.fn(async () => "dsh") }));
    expect(r).toBe("dsh");
  });

  it("accepts the non-wakeable 'offline' classification typed by name (it is a KNOWN agentType)", async () => {
    const r = await promptAgentBackend(deps({ ask: vi.fn(async () => "offline") }));
    expect(r).toBe("offline");
  });

  it("an out-of-range number returns undefined (no explicit choice)", async () => {
    const r = await promptAgentBackend(deps({ ask: vi.fn(async () => "99") }));
    expect(r).toBeUndefined();
  });

  it("garbage / unknown text returns undefined", async () => {
    const r = await promptAgentBackend(deps({ ask: vi.fn(async () => "banana") }));
    expect(r).toBeUndefined();
  });
});

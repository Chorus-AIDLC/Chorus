// cli/__tests__/init-agent-type-map.test.mjs
// Covers the init-selection → daemon-agentType mapping (idea broaden-init-plugin-
// install). The mapping is the single source of truth both credential-seed (writes
// each agents[] entry's agentType) and daemon-setup (wakeability gate) rely on, so
// the claude→claude-code rename and the offline classification are pinned here.
import { describe, it, expect } from "vitest";
import {
  agentTypeForSelection,
  isWakeableAgentType,
  SELECTION_TO_AGENT_TYPE,
} from "../init/agent-type-map.mjs";
import { KNOWN_AGENTS } from "../daemon-agent.mjs";

describe("agentTypeForSelection", () => {
  it("renames the init id 'claude' to the daemon agentType 'claude-code' (never verbatim)", () => {
    expect(agentTypeForSelection("claude")).toBe("claude-code");
    // The raw init id must never leak through as an agentType.
    expect(agentTypeForSelection("claude")).not.toBe("claude");
  });

  it("passes codex and kiro through unchanged (they already match the daemon vocabulary)", () => {
    expect(agentTypeForSelection("codex")).toBe("codex");
    expect(agentTypeForSelection("kiro")).toBe("kiro");
  });

  it("classifies non-wakeable backends (opencode/openclaw/pi/dsh) as offline", () => {
    expect(agentTypeForSelection("opencode")).toBe("offline");
    expect(agentTypeForSelection("openclaw")).toBe("offline");
    expect(agentTypeForSelection("pi")).toBe("offline");
    expect(agentTypeForSelection("dsh")).toBe("offline");
  });

  it("fails closed to offline for an unknown / unmapped id (never a wakeable default)", () => {
    expect(agentTypeForSelection("gemini")).toBe("offline");
    expect(agentTypeForSelection("")).toBe("offline");
    expect(agentTypeForSelection(undefined)).toBe("offline");
  });

  it("only ever produces values the daemon knows (KNOWN_AGENTS)", () => {
    for (const at of Object.values(SELECTION_TO_AGENT_TYPE)) {
      expect(KNOWN_AGENTS).toContain(at);
    }
    expect(KNOWN_AGENTS).toContain("offline");
  });
});

describe("isWakeableAgentType", () => {
  it("treats claude-code / codex / kiro as wakeable", () => {
    expect(isWakeableAgentType("claude-code")).toBe(true);
    expect(isWakeableAgentType("codex")).toBe(true);
    expect(isWakeableAgentType("kiro")).toBe(true);
  });

  it("treats offline as NOT wakeable", () => {
    expect(isWakeableAgentType("offline")).toBe(false);
  });
});

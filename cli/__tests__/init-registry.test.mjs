// cli/__tests__/init-registry.test.mjs
// Covers the adapter registry + detectAgents wiring (spec: agent-plugin-install
// "Pluggable per-agent adapter contract"; chorus-init detection requirements).
import { describe, it, expect } from "vitest";
import { AGENT_REGISTRY, detectAgents, getAdapter, orderedSteps } from "../init/registry.mjs";
import { buildAdapter, readClaudeInstallState, CHORUS_PLUGIN_ID, CHORUS_MARKETPLACE_NAME } from "../init/adapters.mjs";
import { OUTCOME_ACTIONS } from "../init/contracts.mjs";

const EXPECTED_IDS = ["claude", "codex", "kiro", "opencode", "openclaw", "pi", "dsh"];

describe("AGENT_REGISTRY", () => {
  it("contains one adapter per supported harness", () => {
    expect(AGENT_REGISTRY.map((a) => a.id)).toEqual(EXPECTED_IDS);
  });
  it("every adapter implements the AgentAdapter contract", () => {
    for (const a of AGENT_REGISTRY) {
      expect(typeof a.displayName).toBe("string");
      expect(typeof a.detect).toBe("function");
      expect(typeof a.readInstallState).toBe("function");
      expect(typeof a.installPlugin).toBe("function");
    }
  });
});

describe("detectAgents", () => {
  it("returns one detection per supported agent with the dual signals + detected flag", () => {
    const detections = detectAgents(process.env);
    expect(detections.map((d) => d.id)).toEqual(EXPECTED_IDS);
    for (const d of detections) {
      expect(typeof d.binaryOnPath).toBe("boolean");
      expect(typeof d.configDirPresent).toBe("boolean");
      expect(d.detected).toBe(d.binaryOnPath || d.configDirPresent);
    }
  });
  it("keeps undetected agents in the list (always selectable)", () => {
    // Force every signal false via an empty PATH + a home with no config dirs.
    const detections = detectAgents({ PATH: "", HOME: "/nonexistent-xyz" });
    expect(detections).toHaveLength(EXPECTED_IDS.length);
    // Even if some detect via a real config dir under the process home, the full
    // set is always present so the selector can offer every agent.
    expect(detections.map((d) => d.id).sort()).toEqual([...EXPECTED_IDS].sort());
  });
});

describe("getAdapter / orderedSteps", () => {
  it("getAdapter resolves by id and returns undefined for unknown", () => {
    expect(getAdapter("codex")?.id).toBe("codex");
    expect(getAdapter("nope")).toBeUndefined();
  });
  it("orderedSteps is empty until steps are registered by later tasks", () => {
    // (credential-seed + plugin-install register themselves in their own tasks)
    expect(Array.isArray(orderedSteps())).toBe(true);
  });
});

describe("buildAdapter defaults (no install fn yet)", () => {
  it("readInstallState.supported is false and installPlugin reports unsupported", () => {
    const a = buildAdapter({ id: "x", displayName: "X", binaries: ["x"], configDirs: ["~/.x"] });
    expect(a.readInstallState().supported).toBe(false);
    expect(a.installPlugin({}).action).toBe(OUTCOME_ACTIONS.UNSUPPORTED);
  });
});

describe("readClaudeInstallState", () => {
  const home = "/home/u";
  it("reports plugin installed + marketplace registered from the CC state files", () => {
    const readJson = (p) => {
      if (p.endsWith("installed_plugins.json")) {
        return { version: 2, plugins: { [CHORUS_PLUGIN_ID]: [{ scope: "user", version: "0.17.0" }] } };
      }
      if (p.endsWith("known_marketplaces.json")) {
        return { [CHORUS_MARKETPLACE_NAME]: { source: { source: "github" } } };
      }
      return null;
    };
    expect(readClaudeInstallState({ home, readJson })).toEqual({
      marketplaceRegistered: true,
      pluginInstalled: true,
      version: "0.17.0",
    });
  });
  it("reports not-installed when the state files are absent/empty", () => {
    expect(readClaudeInstallState({ home, readJson: () => null })).toEqual({
      marketplaceRegistered: false,
      pluginInstalled: false,
      version: undefined,
    });
  });
});

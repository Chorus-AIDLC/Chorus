// cli/__tests__/init-select.test.mjs
// Covers selection resolution (spec: chorus-init "Agent detection with dual
// signal and always-selectable list" + "Scriptable non-interactive surface").
import { describe, it, expect } from "vitest";
import { resolveSelection } from "../init/select.mjs";

const DETECTIONS = [
  { id: "claude", displayName: "Claude Code", binaryOnPath: true, configDirPresent: true, detected: true },
  { id: "codex", displayName: "Codex", binaryOnPath: false, configDirPresent: true, detected: true },
  { id: "kiro", displayName: "Kiro", binaryOnPath: false, configDirPresent: false, detected: false },
];

function io(overrides = {}) {
  return { log: () => {}, isTTY: false, ...overrides };
}

describe("resolveSelection — explicit flags", () => {
  it("--agents selects exactly the named ids (order preserved)", async () => {
    const r = await resolveSelection({ flags: { agents: ["codex", "claude"] }, detections: DETECTIONS, io: io() });
    expect(r).toEqual({ selectedIds: ["codex", "claude"] });
  });

  it("--agents with an unknown id errors and lists valid ids", async () => {
    const r = await resolveSelection({ flags: { agents: ["bogus"] }, detections: DETECTIONS, io: io() });
    expect(r.selectedIds).toBeUndefined();
    expect(r.error).toContain("bogus");
    expect(r.error).toContain("claude, codex, kiro");
  });

  it("--agents with no usable ids errors", async () => {
    const r = await resolveSelection({ flags: { agents: [] }, detections: DETECTIONS, io: io() });
    expect(r.error).toMatch(/No agent ids/);
  });

  it("--all selects every supported agent", async () => {
    const r = await resolveSelection({ flags: { all: true }, detections: DETECTIONS, io: io() });
    expect(r).toEqual({ selectedIds: ["claude", "codex", "kiro"] });
  });
});

describe("resolveSelection — non-TTY guard", () => {
  it("aborts when non-TTY and neither --agents nor --all is given", async () => {
    const r = await resolveSelection({ flags: {}, detections: DETECTIONS, io: io({ isTTY: false }) });
    expect(r.selectedIds).toBeUndefined();
    expect(r.error).toMatch(/Non-interactive/);
    expect(r.error).toContain("--all");
  });
});

describe("resolveSelection — interactive TTY", () => {
  it("Enter accepts the detected default", async () => {
    const ask = async () => "";
    const r = await resolveSelection({ flags: {}, detections: DETECTIONS, io: io({ isTTY: true, ask }) });
    expect(r.selectedIds).toEqual(["claude", "codex"]);
  });

  it("parses comma-separated numbers into ids (incl. an undetected one)", async () => {
    const ask = async () => "1,3";
    const r = await resolveSelection({ flags: {}, detections: DETECTIONS, io: io({ isTTY: true, ask }) });
    expect(r.selectedIds).toEqual(["claude", "kiro"]);
  });

  it("rejects out-of-range selections", async () => {
    const ask = async () => "9";
    const r = await resolveSelection({ flags: {}, detections: DETECTIONS, io: io({ isTTY: true, ask }) });
    expect(r.error).toMatch(/Invalid selection/);
  });

  it("errors when nothing is detected and Enter picks the empty default", async () => {
    const none = DETECTIONS.map((d) => ({ ...d, detected: false }));
    const ask = async () => "";
    const r = await resolveSelection({ flags: {}, detections: none, io: io({ isTTY: true, ask }) });
    expect(r.error).toMatch(/nothing to configure/i);
  });
});

// cli/__tests__/init-args.test.mjs
// Covers the `chorus init` flag surface + help text (spec: chorus-init
// "Scriptable non-interactive surface" + "Interactive chorus init command").
import { describe, it, expect } from "vitest";
import { parseInitFlags, initHelpText } from "../init-args.mjs";

describe("parseInitFlags", () => {
  it("parses --agents CSV (space + = forms) into a normalized id array", () => {
    expect(parseInitFlags(["--agents", "claude,codex"]).agents).toEqual(["claude", "codex"]);
    expect(parseInitFlags(["--agents=kiro,dsh"]).agents).toEqual(["kiro", "dsh"]);
  });

  it("lowercases, trims, drops empties, and de-dupes agent ids", () => {
    expect(parseInitFlags(["--agents", " Claude , codex ,claude,"]).agents).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("accumulates repeated --agents flags", () => {
    expect(parseInitFlags(["--agents", "claude", "--agents=codex"]).agents).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("exposes an empty array when --agents is given but yields no ids", () => {
    // Distinguishes 'tried to specify agents' from 'gave no --agents at all'.
    expect(parseInitFlags(["--agents", ","]).agents).toEqual([]);
    expect(parseInitFlags([]).agents).toBeUndefined();
  });

  it("parses --all / --yes / -y booleans", () => {
    expect(parseInitFlags(["--all"]).all).toBe(true);
    expect(parseInitFlags(["--yes"]).yes).toBe(true);
    expect(parseInitFlags(["-y"]).yes).toBe(true);
  });

  it("parses --url / --api-key (space + = forms)", () => {
    expect(parseInitFlags(["--url", "https://x", "--api-key", "cho_k"])).toMatchObject({
      url: "https://x",
      apiKey: "cho_k",
    });
    expect(parseInitFlags(["--url=https://y", "--api-key=cho_z"])).toMatchObject({
      url: "https://y",
      apiKey: "cho_z",
    });
  });

  it("parses --dsh-profile (space + = forms)", () => {
    expect(parseInitFlags(["--dsh-profile", "work"]).dshProfile).toBe("work");
    expect(parseInitFlags(["--dsh-profile=personal"]).dshProfile).toBe("personal");
    expect(parseInitFlags([]).dshProfile).toBeUndefined();
  });

  it("parses --help / -h", () => {
    expect(parseInitFlags(["--help"]).help).toBe(true);
    expect(parseInitFlags(["-h"]).help).toBe(true);
  });

  it("only sets keys that appear (unset vs false is distinguishable)", () => {
    expect(parseInitFlags([])).toEqual({});
  });
});

describe("initHelpText", () => {
  it("includes the version, usage, and the non-interactive rule", () => {
    const t = initHelpText("9.9.9");
    expect(t).toContain("Chorus init v9.9.9");
    expect(t).toContain("USAGE");
    expect(t).toContain("--agents");
    expect(t).toContain("NON-INTERACTIVE");
  });
});

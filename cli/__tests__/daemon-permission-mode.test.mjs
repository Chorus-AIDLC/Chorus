// cli/__tests__/daemon-permission-mode.test.mjs
// Covers daemon-permission-mode spec: default-yolo (no confirmation), non-TTY
// warn, --chorus-only reverse switch. The interactive yolo y/N confirmation +
// ack persistence were removed (daemon always starts yolo and warns instead),
// so there is no longer a `needConfirm` path, ack helpers, or confirm prompt.
import { describe, it, expect } from "vitest";
import { resolvePermissionMode, yoloWarningLine } from "../daemon-permission-mode.mjs";

const TTY = { isTTY: true };
const NONTTY = { isTTY: false };

describe("resolvePermissionMode — default + explicit yolo", () => {
  it("defaults to yolo with no flags/env", () => {
    expect(resolvePermissionMode({}, {}, TTY)).toMatchObject({ mode: "yolo" });
    expect(resolvePermissionMode({}, {}, NONTTY)).toMatchObject({ mode: "yolo" });
  });

  it("--yolo / CHORUS_YOLO=1 also select yolo", () => {
    expect(resolvePermissionMode({ yolo: true }, {}, TTY).mode).toBe("yolo");
    expect(resolvePermissionMode({}, { CHORUS_YOLO: "1" }, TTY).mode).toBe("yolo");
    expect(resolvePermissionMode({}, { CHORUS_YOLO: "true" }, TTY).mode).toBe("yolo");
  });
});

describe("resolvePermissionMode — restricted reverse switch", () => {
  it("--chorus-only forces chorus and never needs confirmation", () => {
    expect(resolvePermissionMode({ chorusOnly: true }, {}, TTY)).toEqual({
      mode: "chorus",
      needConfirm: false,
      warnUnattended: false,
    });
  });

  it("CHORUS_CHORUS_ONLY=1 forces chorus", () => {
    expect(resolvePermissionMode({}, { CHORUS_CHORUS_ONLY: "1" }, NONTTY).mode).toBe("chorus");
  });

  it("CHORUS_YOLO=0 / false is an explicit yolo opt-out → chorus", () => {
    expect(resolvePermissionMode({}, { CHORUS_YOLO: "0" }, TTY).mode).toBe("chorus");
    expect(resolvePermissionMode({}, { CHORUS_YOLO: "false" }, NONTTY).mode).toBe("chorus");
  });

  it("chorus-only beats a simultaneous --yolo (explicit restriction wins)", () => {
    expect(resolvePermissionMode({ yolo: true, chorusOnly: true }, {}, TTY).mode).toBe("chorus");
  });
});

describe("resolvePermissionMode — yolo starts with no confirmation", () => {
  it("TTY yolo never needs confirmation (always warns instead)", () => {
    expect(resolvePermissionMode({}, {}, TTY)).toEqual({
      mode: "yolo",
      needConfirm: false,
      warnUnattended: true,
    });
  });

  it("non-TTY yolo starts directly and flags an unattended warning, no confirm", () => {
    expect(resolvePermissionMode({}, {}, NONTTY)).toEqual({
      mode: "yolo",
      needConfirm: false,
      warnUnattended: true,
    });
  });
});

describe("yoloWarningLine", () => {
  it("warning names --chorus-only as the opt-out switch and flags yolo", () => {
    const w = yoloWarningLine();
    expect(w).toContain("--chorus-only");
    expect(w.toUpperCase()).toContain("YOLO");
  });
});

describe("workspace posture", () => {
  const mode = (flags, env = {}) => resolvePermissionMode(flags, env, { isTTY: false, hasAck: false }).mode;

  it("is opt-in via flag or env, and never a default", () => {
    expect(mode({ workspace: true })).toBe("workspace");
    expect(mode({}, { CHORUS_WORKSPACE: "1" })).toBe("workspace");
    expect(mode({}, { CHORUS_WORKSPACE: "true" })).toBe("workspace");
    expect(mode({})).toBe("yolo");
  });

  it("yields to --chorus-only when both are asked for", () => {
    // Honouring the tighter request can only cost capability; honouring the looser
    // one would grant more than the operator asked for.
    expect(mode({ workspace: true, chorusOnly: true })).toBe("chorus");
    expect(mode({ workspace: true }, { CHORUS_CHORUS_ONLY: "1" })).toBe("chorus");
    expect(mode({ workspace: true }, { CHORUS_YOLO: "0" })).toBe("chorus");
  });

  it("does not warn: the posture is restricted, so there is nothing to warn about", () => {
    const d = resolvePermissionMode({ workspace: true }, {}, { isTTY: false, hasAck: false });
    expect(d).toEqual({ mode: "workspace", needConfirm: false, warnUnattended: false });
  });

  it("the yolo warning names both tighter postures", () => {
    expect(yoloWarningLine()).toContain("--workspace");
    expect(yoloWarningLine()).toContain("--chorus-only");
  });
});

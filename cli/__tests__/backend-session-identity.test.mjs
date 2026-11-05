import { describe, expect, it } from "vitest";
import { backendSessionKey } from "../backend-session-identity.mjs";

describe("agent-scoped backend session identity", () => {
  it("deterministically isolates agents and anchors using canonical UUIDv5 ids", () => {
    const first = backendSessionKey("idea-1", "agent-1");
    expect(first).toBe("85d19e24-96dd-546e-bfcc-1d7d4201f641");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).toBe(backendSessionKey("idea-1", "agent-1"));
    expect(first).not.toBe(backendSessionKey("idea-1", "agent-2"));
    expect(first).not.toBe(backendSessionKey("idea-2", "agent-1"));
    expect(backendSessionKey("bc", "a")).not.toBe(backendSessionKey("c", "ab"));
  });

  it("preserves unbound caller identity and missing-anchor validation", () => {
    expect(backendSessionKey("idea-1", undefined)).toBe("idea-1");
    expect(backendSessionKey("idea-1", "")).toBe("idea-1");
    expect(backendSessionKey(null, "agent-1")).toBeNull();
    expect(backendSessionKey("", "agent-1")).toBe("");
  });
});

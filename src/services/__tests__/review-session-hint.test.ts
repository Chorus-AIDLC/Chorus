import { beforeEach, describe, expect, it, vi } from "vitest";
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => {
  const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  return { default: logger };
});
import { reviewSessionAnchorHint } from "@/services/mention.service";
beforeEach(() => vi.clearAllMocks());

describe("Team review envelope hints", () => {
  it.each([
    ["proposal", "proposal"], ["task", "task"], ["code", "idea"],
  ])("matches %s requests on %s", (kind, target) => {
    expect(reviewSessionAnchorHint(`Preface\nTeam review request — ${kind}, round 2\n@reviewer`, target, "target"))
      .toBe(`review:${target}:target`);
  });
  it("accepts the protocol's ASCII dash", () => {
    expect(reviewSessionAnchorHint("Team review request - task, round 1", "task", "T")).toBe("review:task:T");
  });
  it.each(["VERDICT: PASS", "VERDICT: FAIL", "VERDICT: PASS WITH NOTES"])("does not turn a %s reply into a review", (verdict) => {
    expect(reviewSessionAnchorHint(`Team review request — task, round 1\n${verdict}`, "task", "T")).toBeUndefined();
  });
  it("logs a mismatch and sets no hint", () => {
    expect(reviewSessionAnchorHint("Team review request — code, round 1", "task", "T")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ kind: "code", targetType: "task" }), expect.any(String));
  });
  it.each(["ordinary mention", "prefix Team review request — task", "Team review request — tasking"])("ignores non-envelopes: %s", (content) => {
    expect(reviewSessionAnchorHint(content, "task", "T")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

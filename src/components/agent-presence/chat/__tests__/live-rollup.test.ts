import { describe, expect, it } from "vitest";
import { rollupDeltaForTurn } from "../live-rollup";

const usage = (over: Partial<Record<string, unknown>> = {}) => ({
  inputTokens: 33,
  outputTokens: 29844,
  cacheCreationTokens: 588599,
  cacheReadTokens: 9738735,
  model: "claude-opus-4-8",
  source: "claude_code",
  ...over,
});

describe("rollupDeltaForTurn — live header-total increment (daemon-token-usage)", () => {
  it("returns the in/out delta for a newly-terminal turn carrying usage", () => {
    const d = rollupDeltaForTurn(new Set(), { uuid: "t7", status: "ended", usage: usage() });
    // Only input+output — cache is never rolled into the header total.
    expect(d).toEqual({ addInput: 33, addOutput: 29844 });
  });

  it("also rolls up an interrupted terminal turn", () => {
    const d = rollupDeltaForTurn(new Set(), { uuid: "t", status: "interrupted", usage: usage() });
    expect(d).not.toBeNull();
  });

  it("returns null on a → running edge (not terminal, no premature count)", () => {
    expect(rollupDeltaForTurn(new Set(), { uuid: "t", status: "running", usage: usage() })).toBeNull();
  });

  it("returns null when the turn carries no usage", () => {
    expect(rollupDeltaForTurn(new Set(), { uuid: "t", status: "ended", usage: null })).toBeNull();
    expect(rollupDeltaForTurn(new Set(), { uuid: "t", status: "ended" })).toBeNull();
  });

  it("returns null for a turn already counted (dedup vs baseline + prior live events)", () => {
    const counted = new Set(["t7"]);
    expect(rollupDeltaForTurn(counted, { uuid: "t7", status: "ended", usage: usage() })).toBeNull();
  });

  it("returns null for an all-zero-in/out usage (no-op increment; e.g. superseded turn)", () => {
    const d = rollupDeltaForTurn(new Set(), {
      uuid: "t8",
      status: "ended",
      usage: usage({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }),
    });
    expect(d).toBeNull();
  });

  it("treats null token fields as 0 in the delta", () => {
    const d = rollupDeltaForTurn(new Set(), {
      uuid: "t",
      status: "ended",
      usage: usage({ inputTokens: 10, outputTokens: null }),
    });
    expect(d).toEqual({ addInput: 10, addOutput: 0 });
  });
});

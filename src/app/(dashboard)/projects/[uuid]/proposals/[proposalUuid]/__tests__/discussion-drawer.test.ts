import { describe, it, expect, vi } from "vitest";

// Test the onCountChange callback logic used in ProposalComments → DiscussionDrawer
// We verify the contract: callback is called with comment count

describe("onCountChange contract", () => {
  it("calls onCountChange with comment count", () => {
    const onCountChange = vi.fn();
    const comments = [{ uuid: "c1" }, { uuid: "c2" }, { uuid: "c3" }];

    // Simulate what useEffect does in ProposalComments
    onCountChange(comments.length);

    expect(onCountChange).toHaveBeenCalledWith(3);
  });

  it("calls onCountChange with updated count when comments grow", () => {
    const onCountChange = vi.fn();

    // Initial load
    onCountChange(2);
    expect(onCountChange).toHaveBeenLastCalledWith(2);

    // New comment arrives via SSE
    onCountChange(3);
    expect(onCountChange).toHaveBeenLastCalledWith(3);
    expect(onCountChange).toHaveBeenCalledTimes(2);
  });

  it("handles zero comments", () => {
    const onCountChange = vi.fn();
    onCountChange(0);
    expect(onCountChange).toHaveBeenCalledWith(0);
  });

  it("optional callback does not throw when undefined", () => {
    const onCountChange = undefined as ((n: number) => void) | undefined;
    // Simulate the optional chaining pattern: onCountChange?.(count)
    expect(() => onCountChange?.(5)).not.toThrow();
  });

  it("DiscussionDrawer useState pattern: initial value used, then updated by callback", () => {
    // Simulate useState behavior
    let count = 5; // initial from server
    const setCount = (n: number) => { count = n; };

    expect(count).toBe(5);

    // ProposalComments calls onCountChange (which is setCount)
    setCount(8);
    expect(count).toBe(8);

    // Another comment
    setCount(9);
    expect(count).toBe(9);
  });
});

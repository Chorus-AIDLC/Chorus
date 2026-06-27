import { describe, it, expect } from "vitest";
import {
  formatCwd,
  formatHost,
  UNKNOWN_PATH_KEY,
  UNKNOWN_HOST_KEY,
} from "../daemon-instance-format";

describe("formatCwd", () => {
  it("shows the last 2 segments with a leading ellipsis for a long path", () => {
    const result = formatCwd(
      "/home/u/dev/payments-platform/services/billing-api",
    );
    // Abbreviated tail = last 2 segments, leading segments dropped with "…/".
    expect(result.label).toBe("…/services/billing-api");
    expect(result.isUnknown).toBe(false);
  });

  it("preserves the final segment intact when the path is over budget", () => {
    // last-2 tail "services/billing-api" is 20 chars; force a tight budget so
    // the leading segment of the tail must also be dropped.
    const result = formatCwd(
      "/home/u/dev/payments-platform/services/billing-api",
      { charBudget: 12 },
    );
    // Final segment kept whole; everything earlier collapsed to "…/".
    expect(result.label).toBe("…/billing-api");
    expect(result.label).toContain("billing-api");
  });

  it("never truncates the final segment even if it alone exceeds the budget", () => {
    const result = formatCwd("/srv/a-very-long-working-directory-name", {
      charBudget: 8,
    });
    // The working dir name is preserved whole; only a leading ellipsis is added.
    expect(result.label).toBe("…/a-very-long-working-directory-name");
  });

  it("exposes the full absolute path as the title", () => {
    const full = "/home/u/dev/payments-platform/services/billing-api";
    const result = formatCwd(full);
    expect(result.title).toBe(full);
  });

  it("returns the last-2 segments without ellipsis when nothing is dropped", () => {
    const result = formatCwd("/var/log");
    expect(result.label).toBe("var/log");
    expect(result.title).toBe("/var/log");
    expect(result.isUnknown).toBe(false);
  });

  it("normalizes a trailing slash before abbreviating", () => {
    const result = formatCwd("/home/user/dev/chorus/");
    expect(result.label).toBe("…/dev/chorus");
    expect(result.title).toBe("/home/user/dev/chorus/");
  });

  it("handles a single-segment path with no ellipsis", () => {
    const result = formatCwd("/chorus");
    expect(result.label).toBe("chorus");
    expect(result.title).toBe("/chorus");
    expect(result.isUnknown).toBe(false);
  });

  it("shows the root path as-is", () => {
    const result = formatCwd("/");
    expect(result.label).toBe("/");
    expect(result.title).toBe("/");
    expect(result.isUnknown).toBe(false);
  });

  it("normalizes Windows-style separators by tail", () => {
    const result = formatCwd("C:\\Users\\q\\dev\\chorus");
    expect(result.label).toBe("…/dev/chorus");
  });

  it("maps a null cwd to an explicit unknown-path sentinel", () => {
    const result = formatCwd(null);
    expect(result.isUnknown).toBe(true);
    expect(result.label).toBe(UNKNOWN_PATH_KEY);
    expect(result.title).toBe(UNKNOWN_PATH_KEY);
  });

  it("respects a custom tailSegments option", () => {
    const result = formatCwd("/home/u/dev/chorus/src/lib", {
      tailSegments: 3,
      charBudget: 100,
    });
    expect(result.label).toBe("…/chorus/src/lib");
  });
});

describe("formatHost", () => {
  it("right-truncates a long host with a trailing ellipsis within the cap", () => {
    const result = formatHost("ip-10-0-42-118.ec2.internal");
    expect(result.isUnknown).toBe(false);
    expect(result.label.endsWith("…")).toBe(true);
    // Default budget is 18 chars including the ellipsis.
    expect(result.label.length).toBeLessThanOrEqual(18);
    expect(result.label).toBe("ip-10-0-42-118.ec…");
  });

  it("exposes the full host as the title when truncated", () => {
    const result = formatHost("ip-10-0-42-118.ec2.internal");
    expect(result.title).toBe("ip-10-0-42-118.ec2.internal");
  });

  it("returns a short host unchanged with no ellipsis", () => {
    const result = formatHost("Laptop-Q3");
    expect(result.label).toBe("Laptop-Q3");
    expect(result.title).toBe("Laptop-Q3");
    expect(result.isUnknown).toBe(false);
  });

  it("respects a custom charBudget", () => {
    const result = formatHost("ci-runner-02.internal", { charBudget: 10 });
    // budget 10 = 9 kept chars + 1 ellipsis char.
    expect(result.label).toBe("ci-runner…");
    expect(result.label.length).toBe(10);
    expect(result.label.length).toBeLessThanOrEqual(10);
  });

  it("maps an empty host to the localized unknown-host placeholder key", () => {
    const result = formatHost("");
    expect(result.isUnknown).toBe(true);
    expect(result.label).toBe(UNKNOWN_HOST_KEY);
    expect(result.title).toBe(UNKNOWN_HOST_KEY);
  });
});

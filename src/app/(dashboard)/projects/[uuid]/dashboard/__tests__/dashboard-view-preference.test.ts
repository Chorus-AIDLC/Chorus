// @vitest-environment jsdom
//
// Unit tests for the dashboard view-preference helper: adaptive default,
// per-project localStorage override, invalid-value fallback, and lineage
// detection across status groups.

import { describe, it, expect, beforeEach } from "vitest";
import {
  readStoredView,
  storeView,
  adaptiveDefault,
  hasLineageInGroups,
  type DashboardView,
} from "../dashboard-view-preference";

const PROJECT_A = "project-aaaa";
const PROJECT_B = "project-bbbb";
const keyA = `chorus:dashboard-view:${PROJECT_A}`;

describe("adaptiveDefault", () => {
  it("returns 'lineage' when the project has lineage", () => {
    expect(adaptiveDefault(true)).toBe("lineage");
  });

  it("returns 'ideas' when the project has no lineage", () => {
    expect(adaptiveDefault(false)).toBe("ideas");
  });
});

describe("readStoredView / storeView", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when no preference is stored", () => {
    expect(readStoredView(PROJECT_A)).toBeNull();
  });

  it("round-trips a valid stored view", () => {
    storeView(PROJECT_A, "lineage");
    expect(readStoredView(PROJECT_A)).toBe("lineage");
  });

  it("returns null for an invalid stored value (e.g. older build)", () => {
    window.localStorage.setItem(keyA, "tree"); // not one of ideas/lineage/stats
    expect(readStoredView(PROJECT_A)).toBeNull();
  });

  it("scopes preferences per project", () => {
    storeView(PROJECT_A, "stats");
    expect(readStoredView(PROJECT_A)).toBe("stats");
    expect(readStoredView(PROJECT_B)).toBeNull();
  });

  it("accepts each valid view literal", () => {
    (["ideas", "lineage", "stats"] as DashboardView[]).forEach((v) => {
      storeView(PROJECT_A, v);
      expect(readStoredView(PROJECT_A)).toBe(v);
    });
  });
});

describe("hasLineageInGroups", () => {
  it("detects a parent (parentUuid set)", () => {
    const groups = { todo: [{ parentUuid: "p1", childCount: 0 }] };
    expect(hasLineageInGroups(groups)).toBe(true);
  });

  it("detects derived children (childCount > 0)", () => {
    const groups = { in_progress: [{ parentUuid: null, childCount: 2 }] };
    expect(hasLineageInGroups(groups)).toBe(true);
  });

  it("returns false when no idea has a parent or children", () => {
    const groups = {
      todo: [{ parentUuid: null, childCount: 0 }],
      done: [{ parentUuid: null }],
    };
    expect(hasLineageInGroups(groups)).toBe(false);
  });

  it("returns false when fields are entirely absent (no signal)", () => {
    const groups = { todo: [{}, {}] };
    expect(hasLineageInGroups(groups)).toBe(false);
  });

  it("returns false for empty or nullish groups", () => {
    expect(hasLineageInGroups({})).toBe(false);
    expect(hasLineageInGroups(null)).toBe(false);
    expect(hasLineageInGroups(undefined)).toBe(false);
  });
});

// @vitest-environment jsdom
//
// Unit tests for the project-list group-expansion preference helper:
// round-trip, absent key, malformed-value fallback, and graceful degradation
// when localStorage is unavailable or throws.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readExpandedGroups, writeExpandedGroups } from "../group-expansion-preference";

const STORAGE_KEY = "chorus_projects_expanded_groups";

describe("readExpandedGroups / writeExpandedGroups", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns an empty set when nothing is stored", () => {
    expect(readExpandedGroups()).toEqual(new Set());
  });

  it("round-trips a set of keys", () => {
    writeExpandedGroups(new Set(["group-a", "group-b", "__ungrouped__"]));
    expect(readExpandedGroups()).toEqual(new Set(["group-a", "group-b", "__ungrouped__"]));
  });

  it("round-trips an empty set (all collapsed)", () => {
    writeExpandedGroups(new Set());
    expect(readExpandedGroups()).toEqual(new Set());
  });

  it("serializes as a JSON string array", () => {
    writeExpandedGroups(new Set(["x", "y"]));
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual(["x", "y"]);
  });

  it("returns an empty set for malformed JSON", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(readExpandedGroups()).toEqual(new Set());
  });

  it("returns an empty set for a non-array JSON value", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "group-a": true }));
    expect(readExpandedGroups()).toEqual(new Set());
  });

  it("returns an empty set when the array has non-string members", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["group-a", 42, null]));
    expect(readExpandedGroups()).toEqual(new Set());
  });
});

describe("graceful degradation when localStorage is unavailable / throws", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("read returns an empty set when getItem throws (privacy mode)", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readExpandedGroups()).toEqual(new Set());
  });

  it("write is a no-op (does not throw) when setItem throws (quota / privacy mode)", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeExpandedGroups(new Set(["group-a"]))).not.toThrow();
  });
});

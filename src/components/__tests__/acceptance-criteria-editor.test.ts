/**
 * acceptance-criteria-editor.test.ts
 *
 * Unit tests for the change-detection helper exported alongside
 * AcceptanceCriteriaEditor. The component itself is rendered via React in the
 * panels — vitest here runs in node (no jsdom), so we cover the pure helper
 * that both panels consume to decide whether to call replaceAcceptanceCriteria
 * on save.
 */
import { describe, it, expect } from "vitest";
import {
  acCriteriaChanged,
  type AcceptanceCriteriaItemDraft,
} from "../acceptance-criteria-editor";

const item = (
  description: string,
  required: boolean
): AcceptanceCriteriaItemDraft => ({ description, required });

describe("acCriteriaChanged", () => {
  it("returns false for two empty arrays", () => {
    expect(acCriteriaChanged([], [])).toBe(false);
  });

  it("returns false when rows are byte-identical", () => {
    const original = [item("desc A", true), item("desc B", false)];
    const edited = [item("desc A", true), item("desc B", false)];
    expect(acCriteriaChanged(original, edited)).toBe(false);
  });

  it("ignores leading/trailing whitespace differences in description", () => {
    const original = [item("desc A", true)];
    const edited = [item("  desc A  ", true)];
    expect(acCriteriaChanged(original, edited)).toBe(false);
  });

  it("returns true when a description text changes", () => {
    const original = [item("desc A", true)];
    const edited = [item("desc A!", true)];
    expect(acCriteriaChanged(original, edited)).toBe(true);
  });

  it("returns true when the required flag flips", () => {
    const original = [item("desc A", true)];
    const edited = [item("desc A", false)];
    expect(acCriteriaChanged(original, edited)).toBe(true);
  });

  it("returns true when a row is added", () => {
    const original = [item("desc A", true)];
    const edited = [item("desc A", true), item("desc B", true)];
    expect(acCriteriaChanged(original, edited)).toBe(true);
  });

  it("returns true when a row is removed", () => {
    const original = [item("desc A", true), item("desc B", true)];
    const edited = [item("desc A", true)];
    expect(acCriteriaChanged(original, edited)).toBe(true);
  });

  it("returns true when rows are reordered", () => {
    const original = [item("desc A", true), item("desc B", false)];
    const edited = [item("desc B", false), item("desc A", true)];
    expect(acCriteriaChanged(original, edited)).toBe(true);
  });

  it("returns true when the only change is a required-flag flip mid-list", () => {
    const original = [
      item("desc A", true),
      item("desc B", true),
      item("desc C", false),
    ];
    const edited = [
      item("desc A", true),
      item("desc B", false), // flipped
      item("desc C", false),
    ];
    expect(acCriteriaChanged(original, edited)).toBe(true);
  });

  it("treats whitespace-only edits across multiple rows as unchanged", () => {
    const original = [item("desc A", true), item("desc B", false)];
    const edited = [item("desc A   ", true), item("\tdesc B\n", false)];
    expect(acCriteriaChanged(original, edited)).toBe(false);
  });

  it("returns true when comparing empty original to a populated edit", () => {
    expect(acCriteriaChanged([], [item("desc A", true)])).toBe(true);
  });

  it("returns true when comparing populated original to empty edit", () => {
    expect(acCriteriaChanged([item("desc A", true)], [])).toBe(true);
  });
});

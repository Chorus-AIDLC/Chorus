import { describe, it, expect } from "vitest";
import { findNew, findDeleted, findChangedDocs, findChangedTasks } from "../draft-diff";

describe("draft-diff", () => {
  describe("findNew", () => {
    it("detects new items", () => {
      const old = [{ uuid: "a" }, { uuid: "b" }];
      const current = [{ uuid: "a" }, { uuid: "b" }, { uuid: "c" }];
      expect(findNew(old, current)).toEqual(["c"]);
    });

    it("returns empty when no new items", () => {
      const old = [{ uuid: "a" }];
      const current = [{ uuid: "a" }];
      expect(findNew(old, current)).toEqual([]);
    });

    it("handles empty old array", () => {
      expect(findNew([], [{ uuid: "a" }])).toEqual(["a"]);
    });
  });

  describe("findDeleted", () => {
    it("detects deleted items", () => {
      const old = [{ uuid: "a" }, { uuid: "b" }, { uuid: "c" }];
      const current = [{ uuid: "a" }];
      expect(findDeleted(old, current)).toEqual(["b", "c"]);
    });

    it("returns empty when nothing deleted", () => {
      const old = [{ uuid: "a" }];
      const current = [{ uuid: "a" }, { uuid: "b" }];
      expect(findDeleted(old, current)).toEqual([]);
    });

    it("handles empty current array", () => {
      expect(findDeleted([{ uuid: "a" }], [])).toEqual(["a"]);
    });
  });

  describe("findChangedDocs", () => {
    const base = { uuid: "d1", title: "Doc", content: "body", type: "prd" };

    it("detects title change", () => {
      expect(findChangedDocs([base], [{ ...base, title: "New" }])).toEqual(["d1"]);
    });

    it("detects content change", () => {
      expect(findChangedDocs([base], [{ ...base, content: "updated" }])).toEqual(["d1"]);
    });

    it("detects type change", () => {
      expect(findChangedDocs([base], [{ ...base, type: "adr" }])).toEqual(["d1"]);
    });

    it("returns empty for identical docs", () => {
      expect(findChangedDocs([base], [{ ...base }])).toEqual([]);
    });

    it("ignores new docs (not in old)", () => {
      const newDoc = { uuid: "d2", title: "New", content: "", type: "prd" };
      expect(findChangedDocs([base], [base, newDoc])).toEqual([]);
    });
  });

  describe("findChangedTasks", () => {
    const base = {
      uuid: "t1",
      title: "Task",
      description: "desc",
      priority: "high",
      storyPoints: 3,
      acceptanceCriteriaItems: [{ description: "AC1", required: true }],
      dependsOnDraftUuids: ["dep1"],
    };

    it("detects title change", () => {
      expect(findChangedTasks([base], [{ ...base, title: "New" }])).toEqual(["t1"]);
    });

    it("detects priority change", () => {
      expect(findChangedTasks([base], [{ ...base, priority: "low" }])).toEqual(["t1"]);
    });

    it("detects storyPoints change", () => {
      expect(findChangedTasks([base], [{ ...base, storyPoints: 5 }])).toEqual(["t1"]);
    });

    it("detects acceptanceCriteriaItems change", () => {
      const changed = {
        ...base,
        acceptanceCriteriaItems: [{ description: "AC1 updated", required: true }],
      };
      expect(findChangedTasks([base], [changed])).toEqual(["t1"]);
    });

    it("detects dependsOnDraftUuids change", () => {
      const changed = { ...base, dependsOnDraftUuids: ["dep1", "dep2"] };
      expect(findChangedTasks([base], [changed])).toEqual(["t1"]);
    });

    it("handles reordered dependencies (sorted comparison)", () => {
      const old = { ...base, dependsOnDraftUuids: ["b", "a"] };
      const current = { ...base, dependsOnDraftUuids: ["a", "b"] };
      expect(findChangedTasks([old], [current])).toEqual([]);
    });

    it("returns empty for identical tasks", () => {
      expect(findChangedTasks([base], [{ ...base }])).toEqual([]);
    });
  });
});

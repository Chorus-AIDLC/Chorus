import { describe, it, expect } from "vitest";
import { buildTaskScopeQuery, parseTaskScopeFilter, taskMatchesScope } from "../task-scope-filter";

const params = (query: string) => new URLSearchParams(query);

describe("parseTaskScopeFilter", () => {
  it("returns null without any scope params", () => {
    expect(parseTaskScopeFilter(params(""))).toBeNull();
    expect(parseTaskScopeFilter(params("proposalUuids=,&ideaUuid="))).toBeNull();
  });

  it("parses proposalUuids and ideaUuid", () => {
    const scope = parseTaskScopeFilter(params("proposalUuids=p1,p2&ideaUuid=i1"));
    expect(scope).toEqual({ proposalUuids: new Set(["p1", "p2"]), ideaUuid: "i1" });
    expect(parseTaskScopeFilter(params("ideaUuid=i1"))).toEqual({ proposalUuids: new Set(), ideaUuid: "i1" });
  });
});

describe("taskMatchesScope", () => {
  const tasks = [
    { uuid: "a", proposalUuid: "p1", ideaUuid: null },
    { uuid: "b", proposalUuid: "p2", ideaUuid: null },
    { uuid: "q", proposalUuid: null, ideaUuid: "i1" },
    { uuid: "other", proposalUuid: null, ideaUuid: "i2" },
    { uuid: "loose", proposalUuid: null },
  ];
  const visible = (query: string) =>
    tasks.filter((t) => taskMatchesScope(t, parseTaskScopeFilter(params(query)))).map((t) => t.uuid);

  it("keeps every task without a scope", () => {
    expect(visible("")).toEqual(["a", "b", "q", "other", "loose"]);
  });

  it("proposal-only scope behaves as before", () => {
    expect(visible("proposalUuids=p1")).toEqual(["a"]);
  });

  it("idea scope selects the idea's linked Quick Tasks only", () => {
    expect(visible("ideaUuid=i1")).toEqual(["q"]);
  });

  it("combined scope is the union of proposal tasks and linked tasks", () => {
    expect(visible("proposalUuids=p1&ideaUuid=i1")).toEqual(["a", "q"]);
  });
});

describe("buildTaskScopeQuery", () => {
  it("builds the legacy proposal link format and appends the idea", () => {
    expect(buildTaskScopeQuery(["p1", "p2"])).toBe("proposalUuids=p1,p2");
    expect(buildTaskScopeQuery(["p1"], "i1")).toBe("proposalUuids=p1&ideaUuid=i1");
    expect(buildTaskScopeQuery([], "i1")).toBe("ideaUuid=i1");
    expect(buildTaskScopeQuery([], null)).toBe("");
  });

  it("round-trips through parseTaskScopeFilter", () => {
    expect(parseTaskScopeFilter(params(buildTaskScopeQuery(["p1", "p2"], "i1")))).toEqual({
      proposalUuids: new Set(["p1", "p2"]), ideaUuid: "i1",
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====
// lineage.service calls exactly four raw getters; mock those directly so each
// test controls the entity graph without touching prisma.

const { mockGetTaskByUuid, mockGetProposalByUuid, mockGetDocumentByUuid, mockGetIdeaByUuid } =
  vi.hoisted(() => ({
    mockGetTaskByUuid: vi.fn(),
    mockGetProposalByUuid: vi.fn(),
    mockGetDocumentByUuid: vi.fn(),
    mockGetIdeaByUuid: vi.fn(),
  }));

vi.mock("@/services/task.service", () => ({ getTaskByUuid: mockGetTaskByUuid }));
vi.mock("@/services/proposal.service", () => ({ getProposalByUuid: mockGetProposalByUuid }));
vi.mock("@/services/document.service", () => ({ getDocumentByUuid: mockGetDocumentByUuid }));
vi.mock("@/services/idea.service", () => ({ getIdeaByUuid: mockGetIdeaByUuid }));

import { resolveRootIdea, MAX_PARENT_HOPS } from "@/services/lineage.service";

const COMPANY = "company-1111";
const OTHER_COMPANY = "company-9999";

// ---- Builders. Getters are companyUuid-scoped, so the fakes return the entity
// only when asked for the right company (mirrors findFirst({ where:{uuid,companyUuid} })).

type IdeaRow = { uuid: string; title: string; parentUuid: string | null };
type TaskRow = { uuid: string; title: string; proposalUuid: string | null };
type DocRow = { uuid: string; title: string; proposalUuid: string | null };
type PropRow = { uuid: string; title: string; inputType: string; inputUuids: unknown };

function installGraph(graph: {
  ideas?: IdeaRow[];
  tasks?: TaskRow[];
  documents?: DocRow[];
  proposals?: PropRow[];
}) {
  const ideas = new Map((graph.ideas ?? []).map((r) => [r.uuid, r]));
  const tasks = new Map((graph.tasks ?? []).map((r) => [r.uuid, r]));
  const docs = new Map((graph.documents ?? []).map((r) => [r.uuid, r]));
  const props = new Map((graph.proposals ?? []).map((r) => [r.uuid, r]));

  mockGetIdeaByUuid.mockImplementation(async (company: string, uuid: string) =>
    company === COMPANY ? (ideas.get(uuid) ?? null) : null
  );
  mockGetTaskByUuid.mockImplementation(async (company: string, uuid: string) =>
    company === COMPANY ? (tasks.get(uuid) ?? null) : null
  );
  mockGetDocumentByUuid.mockImplementation(async (company: string, uuid: string) =>
    company === COMPANY ? (docs.get(uuid) ?? null) : null
  );
  mockGetProposalByUuid.mockImplementation(async (company: string, uuid: string) =>
    company === COMPANY ? (props.get(uuid) ?? null) : null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lineage.service / resolveRootIdea", () => {
  // ===== idea entity =====
  describe("entityType: idea", () => {
    it("walks parentUuid to the topmost idea (resolvedVia root_idea)", async () => {
      installGraph({
        ideas: [
          { uuid: "i-root", title: "Root", parentUuid: null },
          { uuid: "i-mid", title: "Mid", parentUuid: "i-root" },
          { uuid: "i-leaf", title: "Leaf", parentUuid: "i-mid" },
        ],
      });

      const res = await resolveRootIdea(COMPANY, "idea", "i-leaf");

      expect(res.rootIdeaUuid).toBe("i-root");
      expect(res.resolvedVia).toBe("root_idea");
      expect(res.lineage.map((n) => n.uuid)).toEqual(["i-leaf", "i-mid", "i-root"]);
      expect(res.lineage.every((n) => n.type === "idea")).toBe(true);
      expect(res.lineage[0].title).toBe("Leaf");
      expect(res.ambiguous).toBeUndefined();
    });

    it("a top-level idea resolves to itself", async () => {
      installGraph({ ideas: [{ uuid: "i-solo", title: "Solo", parentUuid: null }] });

      const res = await resolveRootIdea(COMPANY, "idea", "i-solo");

      expect(res.rootIdeaUuid).toBe("i-solo");
      expect(res.resolvedVia).toBe("root_idea");
      expect(res.lineage).toEqual([{ type: "idea", uuid: "i-solo", title: "Solo" }]);
    });

    it("a missing idea resolves to null/not_found (no throw)", async () => {
      installGraph({ ideas: [] });

      const res = await resolveRootIdea(COMPANY, "idea", "i-ghost");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("not_found");
      expect(res.lineage).toEqual([]);
    });
  });

  // ===== task entity =====
  describe("entityType: task", () => {
    it("task → idea-derived proposal → root (via_proposal)", async () => {
      installGraph({
        ideas: [
          { uuid: "i-root", title: "Root", parentUuid: null },
          { uuid: "i-child", title: "Child", parentUuid: "i-root" },
        ],
        proposals: [
          { uuid: "p1", title: "P1", inputType: "idea", inputUuids: ["i-child"] },
        ],
        tasks: [{ uuid: "t1", title: "T1", proposalUuid: "p1" }],
      });

      const res = await resolveRootIdea(COMPANY, "task", "t1");

      expect(res.rootIdeaUuid).toBe("i-root");
      expect(res.resolvedVia).toBe("via_proposal");
      expect(res.lineage.map((n) => `${n.type}:${n.uuid}`)).toEqual([
        "task:t1",
        "proposal:p1",
        "idea:i-child",
        "idea:i-root",
      ]);
    });

    it("quick task with no proposal → null/no_proposal", async () => {
      installGraph({ tasks: [{ uuid: "t-quick", title: "Quick", proposalUuid: null }] });

      const res = await resolveRootIdea(COMPANY, "task", "t-quick");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("no_proposal");
      expect(res.lineage).toEqual([{ type: "task", uuid: "t-quick", title: "Quick" }]);
    });

    it("missing task → null/not_found", async () => {
      installGraph({ tasks: [] });

      const res = await resolveRootIdea(COMPANY, "task", "t-ghost");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("not_found");
      expect(res.lineage).toEqual([]);
    });
  });

  // ===== document entity (the closed gap) =====
  describe("entityType: document", () => {
    it("document → idea-derived proposal → root (via_document_proposal)", async () => {
      installGraph({
        ideas: [{ uuid: "i-root", title: "Root", parentUuid: null }],
        proposals: [
          { uuid: "p1", title: "P1", inputType: "idea", inputUuids: ["i-root"] },
        ],
        documents: [{ uuid: "d1", title: "Spec", proposalUuid: "p1" }],
      });

      const res = await resolveRootIdea(COMPANY, "document", "d1");

      expect(res.rootIdeaUuid).toBe("i-root");
      expect(res.resolvedVia).toBe("via_document_proposal");
      expect(res.lineage.map((n) => `${n.type}:${n.uuid}`)).toEqual([
        "document:d1",
        "proposal:p1",
        "idea:i-root",
      ]);
    });

    it("standalone document (no proposalUuid) → null/standalone_document", async () => {
      installGraph({ documents: [{ uuid: "d-solo", title: "Note", proposalUuid: null }] });

      const res = await resolveRootIdea(COMPANY, "document", "d-solo");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("standalone_document");
      expect(res.lineage).toEqual([{ type: "document", uuid: "d-solo", title: "Note" }]);
    });

    it("missing document → null/not_found", async () => {
      installGraph({ documents: [] });

      const res = await resolveRootIdea(COMPANY, "document", "d-ghost");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("not_found");
    });
  });

  // ===== proposal entity =====
  describe("entityType: proposal", () => {
    it("idea-derived proposal resolves to the idea's root (root_idea)", async () => {
      installGraph({
        ideas: [
          { uuid: "i-root", title: "Root", parentUuid: null },
          { uuid: "i-child", title: "Child", parentUuid: "i-root" },
        ],
        proposals: [
          { uuid: "p1", title: "P1", inputType: "idea", inputUuids: ["i-child"] },
        ],
      });

      const res = await resolveRootIdea(COMPANY, "proposal", "p1");

      expect(res.rootIdeaUuid).toBe("i-root");
      expect(res.resolvedVia).toBe("root_idea");
      expect(res.lineage.map((n) => `${n.type}:${n.uuid}`)).toEqual([
        "proposal:p1",
        "idea:i-child",
        "idea:i-root",
      ]);
    });

    it("document-derived proposal → null/proposal_input_not_idea", async () => {
      installGraph({
        proposals: [
          { uuid: "p-doc", title: "PDoc", inputType: "document", inputUuids: ["d-src"] },
        ],
      });

      const res = await resolveRootIdea(COMPANY, "proposal", "p-doc");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("proposal_input_not_idea");
      expect(res.lineage.map((n) => n.uuid)).toEqual(["p-doc"]);
    });

    it("idea-typed proposal with empty inputUuids → null/proposal_input_not_idea", async () => {
      installGraph({
        proposals: [{ uuid: "p-empty", title: "PE", inputType: "idea", inputUuids: [] }],
      });

      const res = await resolveRootIdea(COMPANY, "proposal", "p-empty");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("proposal_input_not_idea");
    });

    it("non-array inputUuids is treated as empty", async () => {
      installGraph({
        proposals: [
          { uuid: "p-bad", title: "PB", inputType: "idea", inputUuids: "not-an-array" },
        ],
      });

      const res = await resolveRootIdea(COMPANY, "proposal", "p-bad");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("proposal_input_not_idea");
    });

    it("missing proposal → null/not_found", async () => {
      installGraph({ proposals: [] });

      const res = await resolveRootIdea(COMPANY, "proposal", "p-ghost");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("not_found");
    });

    it("proposal whose input idea is missing → null/not_found", async () => {
      installGraph({
        proposals: [
          { uuid: "p1", title: "P1", inputType: "idea", inputUuids: ["i-ghost"] },
        ],
      });

      const res = await resolveRootIdea(COMPANY, "proposal", "p1");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("not_found");
    });
  });

  // ===== multi-idea ambiguity =====
  describe("multi-idea proposal", () => {
    it("returns inputUuids[0] root, flags ambiguous, lists each input idea's root", async () => {
      installGraph({
        ideas: [
          { uuid: "i-root-a", title: "RootA", parentUuid: null },
          { uuid: "i-a", title: "A", parentUuid: "i-root-a" },
          { uuid: "i-root-b", title: "RootB", parentUuid: null },
          { uuid: "i-b", title: "B", parentUuid: "i-root-b" },
        ],
        proposals: [
          { uuid: "p-merge", title: "Merge", inputType: "idea", inputUuids: ["i-a", "i-b"] },
        ],
        tasks: [{ uuid: "t1", title: "T1", proposalUuid: "p-merge" }],
      });

      const res = await resolveRootIdea(COMPANY, "task", "t1");

      expect(res.rootIdeaUuid).toBe("i-root-a"); // single-valued main line
      expect(res.ambiguous).toBe(true);
      expect(res.candidates).toEqual(["i-root-a", "i-root-b"]);
      expect(res.candidates?.[0]).toBe(res.rootIdeaUuid);
      // lineage follows only the primary line
      expect(res.lineage.map((n) => `${n.type}:${n.uuid}`)).toEqual([
        "task:t1",
        "proposal:p-merge",
        "idea:i-a",
        "idea:i-root-a",
      ]);
    });

    it("skips a missing candidate idea without failing the primary resolution", async () => {
      installGraph({
        ideas: [{ uuid: "i-a", title: "A", parentUuid: null }],
        proposals: [
          {
            uuid: "p-merge",
            title: "Merge",
            inputType: "idea",
            inputUuids: ["i-a", "i-ghost"],
          },
        ],
      });

      const res = await resolveRootIdea(COMPANY, "proposal", "p-merge");

      expect(res.rootIdeaUuid).toBe("i-a");
      expect(res.ambiguous).toBe(true);
      expect(res.candidates).toEqual(["i-a"]); // ghost skipped
    });

    it("single-idea proposal is not ambiguous", async () => {
      installGraph({
        ideas: [{ uuid: "i-a", title: "A", parentUuid: null }],
        proposals: [{ uuid: "p1", title: "P1", inputType: "idea", inputUuids: ["i-a"] }],
      });

      const res = await resolveRootIdea(COMPANY, "proposal", "p1");

      expect(res.ambiguous).toBeUndefined();
      expect(res.candidates).toBeUndefined();
    });
  });

  // ===== cross-company isolation =====
  describe("company scoping", () => {
    it("an entity that exists only in another company → null/not_found", async () => {
      // installGraph wires entities under COMPANY only; query with OTHER_COMPANY.
      installGraph({ tasks: [{ uuid: "t1", title: "T1", proposalUuid: "p1" }] });

      const res = await resolveRootIdea(OTHER_COMPANY, "task", "t1");

      expect(res.rootIdeaUuid).toBeNull();
      expect(res.resolvedVia).toBe("not_found");
      // never traversed past the (scoped) task lookup
      expect(mockGetProposalByUuid).not.toHaveBeenCalled();
    });

    it("a parent idea in another company stops the walk at the boundary", async () => {
      // i-child is in COMPANY but its parent i-foreign is not returned for COMPANY.
      mockGetIdeaByUuid.mockImplementation(async (company: string, uuid: string) => {
        if (company !== COMPANY) return null;
        if (uuid === "i-child") return { uuid: "i-child", title: "Child", parentUuid: "i-foreign" };
        return null; // i-foreign not visible to COMPANY
      });

      const res = await resolveRootIdea(COMPANY, "idea", "i-child");

      expect(res.rootIdeaUuid).toBe("i-child"); // stops at boundary, not i-foreign
      expect(res.resolvedVia).toBe("root_idea");
      expect(res.lineage.map((n) => n.uuid)).toEqual(["i-child"]);
    });
  });

  // ===== cycle + depth guards =====
  describe("walk guards", () => {
    it("a parentUuid cycle terminates without looping", async () => {
      installGraph({
        ideas: [
          { uuid: "i-x", title: "X", parentUuid: "i-y" },
          { uuid: "i-y", title: "Y", parentUuid: "i-x" }, // cycle
        ],
      });

      const res = await resolveRootIdea(COMPANY, "idea", "i-x");

      // walk: x → y (parent x already visited) → stop at y
      expect(res.rootIdeaUuid).toBe("i-y");
      expect(res.resolvedVia).toBe("root_idea");
      expect(res.lineage.map((n) => n.uuid)).toEqual(["i-x", "i-y"]);
    });

    it("a chain longer than MAX_PARENT_HOPS stops at the hop bound", async () => {
      // Build a deep linear chain i-0 (root) ← i-1 ← ... ← i-(N+5).
      const depth = MAX_PARENT_HOPS + 5;
      const ideas: IdeaRow[] = [];
      for (let n = 0; n <= depth; n++) {
        ideas.push({
          uuid: `i-${n}`,
          title: `I${n}`,
          parentUuid: n === 0 ? null : `i-${n - 1}`,
        });
      }
      installGraph({ ideas });

      const res = await resolveRootIdea(COMPANY, "idea", `i-${depth}`);

      // Bounded: the start node plus MAX_PARENT_HOPS parent hops, never reaching i-0.
      expect(res.lineage.length).toBe(MAX_PARENT_HOPS + 1);
      expect(res.rootIdeaUuid).toBe(`i-${depth - MAX_PARENT_HOPS}`);
      expect(res.rootIdeaUuid).toBe(res.lineage[res.lineage.length - 1].uuid);
      expect(res.rootIdeaUuid).not.toBe("i-0");
    });
  });

  // ===== directIdeaUuid (the daemon's session-id anchor) =====
  describe("directIdeaUuid", () => {
    it("task via proposal: direct = inputUuids[0]'s idea (first idea node), root = topmost", async () => {
      installGraph({
        ideas: [
          { uuid: "i-root", title: "Root", parentUuid: null },
          { uuid: "i-child", title: "Child", parentUuid: "i-root" },
        ],
        proposals: [{ uuid: "p1", title: "P1", inputType: "idea", inputUuids: ["i-child"] }],
        tasks: [{ uuid: "t1", title: "T1", proposalUuid: "p1" }],
      });

      const res = await resolveRootIdea(COMPANY, "task", "t1");

      expect(res.directIdeaUuid).toBe("i-child"); // first idea node on lineage
      expect(res.rootIdeaUuid).toBe("i-root"); // last idea node
      expect(res.directIdeaUuid).not.toBe(res.rootIdeaUuid);
    });

    it("idea input with ancestors: direct = the idea itself, NOT its root", async () => {
      installGraph({
        ideas: [
          { uuid: "i-root", title: "Root", parentUuid: null },
          { uuid: "i-mid", title: "Mid", parentUuid: "i-root" },
          { uuid: "i-leaf", title: "Leaf", parentUuid: "i-mid" },
        ],
      });

      const res = await resolveRootIdea(COMPANY, "idea", "i-leaf");

      expect(res.directIdeaUuid).toBe("i-leaf");
      expect(res.rootIdeaUuid).toBe("i-root");
    });

    it("top-level idea: direct equals root (single idea node on lineage)", async () => {
      installGraph({ ideas: [{ uuid: "i-solo", title: "Solo", parentUuid: null }] });

      const res = await resolveRootIdea(COMPANY, "idea", "i-solo");

      expect(res.directIdeaUuid).toBe("i-solo");
      expect(res.directIdeaUuid).toBe(res.rootIdeaUuid);
    });

    it("document via proposal: direct = the proposal's input idea", async () => {
      installGraph({
        ideas: [
          { uuid: "i-root", title: "Root", parentUuid: null },
          { uuid: "i-child", title: "Child", parentUuid: "i-root" },
        ],
        proposals: [{ uuid: "p1", title: "P1", inputType: "idea", inputUuids: ["i-child"] }],
        documents: [{ uuid: "d1", title: "Spec", proposalUuid: "p1" }],
      });

      const res = await resolveRootIdea(COMPANY, "document", "d1");

      expect(res.directIdeaUuid).toBe("i-child");
      expect(res.rootIdeaUuid).toBe("i-root");
    });

    it("multi-idea proposal: direct = inputUuids[0]'s idea (primary line first idea node)", async () => {
      installGraph({
        ideas: [
          { uuid: "i-root-a", title: "RootA", parentUuid: null },
          { uuid: "i-a", title: "A", parentUuid: "i-root-a" },
          { uuid: "i-root-b", title: "RootB", parentUuid: null },
          { uuid: "i-b", title: "B", parentUuid: "i-root-b" },
        ],
        proposals: [
          { uuid: "p-merge", title: "Merge", inputType: "idea", inputUuids: ["i-a", "i-b"] },
        ],
        tasks: [{ uuid: "t1", title: "T1", proposalUuid: "p-merge" }],
      });

      const res = await resolveRootIdea(COMPANY, "task", "t1");

      expect(res.directIdeaUuid).toBe("i-a"); // primary line's direct idea
      expect(res.rootIdeaUuid).toBe("i-root-a");
    });

    it.each([
      ["quick task no proposal", "task", "t-quick"],
      ["standalone document", "document", "d-solo"],
      ["missing entity", "task", "t-ghost"],
    ] as const)("null in the same no-idea-ancestor case: %s", async (_label, type, uuid) => {
      installGraph({
        tasks: [{ uuid: "t-quick", title: "Quick", proposalUuid: null }],
        documents: [{ uuid: "d-solo", title: "Note", proposalUuid: null }],
      });

      const res = await resolveRootIdea(COMPANY, type, uuid);

      expect(res.directIdeaUuid).toBeNull();
      expect(res.rootIdeaUuid).toBeNull(); // direct is null exactly when root is
    });

    it("document-derived proposal (no idea input): direct is null, matching root", async () => {
      installGraph({
        proposals: [
          { uuid: "p-doc", title: "PDoc", inputType: "document", inputUuids: ["d-src"] },
        ],
      });

      const res = await resolveRootIdea(COMPANY, "proposal", "p-doc");

      expect(res.directIdeaUuid).toBeNull();
      expect(res.rootIdeaUuid).toBeNull();
    });
  });

  // ===== defensive default =====
  it("an unknown entityType → null/not_found (no throw)", async () => {
    installGraph({});
    // @ts-expect-error — exercising the runtime default branch
    const res = await resolveRootIdea(COMPANY, "comment", "c1");
    expect(res.rootIdeaUuid).toBeNull();
    expect(res.resolvedVia).toBe("not_found");
  });
});

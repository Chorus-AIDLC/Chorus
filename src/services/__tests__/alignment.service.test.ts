import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====
// The alignment service composes real resolveRootIdea (backed by the four raw
// getters) with getElaboration + listComments. We mock the four DB getters so the
// REAL resolver runs over a controlled entity graph (this genuinely exercises the
// direct-vs-root anchor + theme-nested + multi-input resolution), and mock the two
// bundle reads so the mapping/filtering logic is tested against controlled inputs.

const {
  mockGetTaskByUuid,
  mockGetProposalByUuid,
  mockGetDocumentByUuid,
  mockGetIdeaByUuid,
  mockGetElaboration,
  mockListComments,
} = vi.hoisted(() => ({
  mockGetTaskByUuid: vi.fn(),
  mockGetProposalByUuid: vi.fn(),
  mockGetDocumentByUuid: vi.fn(),
  mockGetIdeaByUuid: vi.fn(),
  mockGetElaboration: vi.fn(),
  mockListComments: vi.fn(),
}));

vi.mock("@/services/task.service", () => ({ getTaskByUuid: mockGetTaskByUuid }));
vi.mock("@/services/proposal.service", () => ({ getProposalByUuid: mockGetProposalByUuid }));
vi.mock("@/services/document.service", () => ({ getDocumentByUuid: mockGetDocumentByUuid }));
vi.mock("@/services/idea.service", () => ({ getIdeaByUuid: mockGetIdeaByUuid }));
vi.mock("@/services/elaboration.service", () => ({ getElaboration: mockGetElaboration }));
vi.mock("@/services/comment.service", () => ({ listComments: mockListComments }));

import { getAlignmentAnchor } from "@/services/alignment.service";
import type {
  ElaborationQuestionResponse,
  ElaborationResponse,
} from "@/types/elaboration";
import type { CommentResponse } from "@/services/comment.service";

const COMPANY = "company-1111";
const OTHER_COMPANY = "company-9999";

// ---- Entity graph fakes (mirror lineage.service.test.ts). Getters are
// companyUuid-scoped, so a fake returns the entity only for the right company.

type IdeaRow = { uuid: string; title: string; content?: string | null; parentUuid: string | null };
type TaskRow = { uuid: string; title: string; proposalUuid: string | null };
type DocRow = { uuid: string; title: string; proposalUuid: string | null };
type PropRow = { uuid: string; title: string; inputType: string; inputUuids: unknown };

function installGraph(graph: {
  ideas?: IdeaRow[];
  tasks?: TaskRow[];
  documents?: DocRow[];
  proposals?: PropRow[];
  elaborations?: Record<string, ElaborationResponse>;
  comments?: Record<string, CommentResponse[]>;
}) {
  const ideas = new Map((graph.ideas ?? []).map((r) => [r.uuid, r]));
  const tasks = new Map((graph.tasks ?? []).map((r) => [r.uuid, r]));
  const docs = new Map((graph.documents ?? []).map((r) => [r.uuid, r]));
  const props = new Map((graph.proposals ?? []).map((r) => [r.uuid, r]));
  const elaborations = graph.elaborations ?? {};
  const comments = graph.comments ?? {};

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
  mockGetElaboration.mockImplementation(
    async ({ ideaUuid }: { companyUuid: string; ideaUuid: string }) =>
      elaborations[ideaUuid] ?? emptyElaboration(ideaUuid)
  );
  mockListComments.mockImplementation(
    async ({ targetUuid }: { targetUuid: string }) => ({
      comments: comments[targetUuid] ?? [],
      total: (comments[targetUuid] ?? []).length,
    })
  );
}

// ---- Builders for the bundle reads.

function emptyElaboration(ideaUuid: string): ElaborationResponse {
  return {
    ideaUuid,
    depth: null,
    status: null,
    rounds: [],
    summary: { totalQuestions: 0, answeredQuestions: 0, validatedRounds: 0, pendingRound: null },
  };
}

function makeQuestion(opts: {
  text: string;
  options?: Array<{ id: string; label: string }>;
  selectedOptionId?: string | null;
  customText?: string | null;
  answered?: boolean;
  /** Actor TYPE that answered (defaults "user"); drives answeredByType classification. */
  answeredByType?: string;
}): ElaborationQuestionResponse {
  const options = opts.options ?? [];
  const answered = opts.answered ?? true;
  const answeredByType = opts.answeredByType ?? "user";
  return {
    uuid: `q-${opts.text}`,
    questionId: `qid-${opts.text}`,
    text: opts.text,
    category: "functional",
    options,
    required: true,
    answer: answered
      ? {
          selectedOptionId: opts.selectedOptionId ?? null,
          customText: opts.customText ?? null,
          answeredAt: "2026-01-01T00:00:00.000Z",
          answeredBy: { type: answeredByType, uuid: `${answeredByType}-1` },
        }
      : null,
    issue: null,
  };
}

function makeElaboration(
  ideaUuid: string,
  questions: ElaborationQuestionResponse[]
): ElaborationResponse {
  return {
    ideaUuid,
    depth: "standard",
    status: "resolved",
    rounds: [
      {
        uuid: `round-${ideaUuid}`,
        roundNumber: 1,
        status: "answered",
        isAppended: false,
        createdBy: { type: "agent", uuid: "a-1" },
        validatedAt: null,
        questions,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    summary: {
      totalQuestions: questions.length,
      answeredQuestions: questions.filter((q) => q.answer).length,
      validatedRounds: 1,
      pendingRound: null,
    },
  };
}

function makeComment(opts: {
  uuid: string;
  content: string;
  authorType: string;
  authorName: string;
  at?: string;
}): CommentResponse {
  return {
    uuid: opts.uuid,
    targetType: "idea",
    targetUuid: "ignored",
    content: opts.content,
    author: { type: opts.authorType, uuid: `${opts.authorType}-uuid`, name: opts.authorName },
    createdAt: opts.at ?? "2026-01-02T00:00:00.000Z",
    updatedAt: opts.at ?? "2026-01-02T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("alignment.service / getAlignmentAnchor", () => {
  // ===== proposal → idea =====
  it("resolves a single-idea proposal to its direct idea with content, decisions, comments", async () => {
    installGraph({
      ideas: [{ uuid: "i-1", title: "Ship dark mode", content: "Add a dark theme toggle", parentUuid: null }],
      proposals: [{ uuid: "p-1", title: "P1", inputType: "idea", inputUuids: ["i-1"] }],
      elaborations: {
        "i-1": makeElaboration("i-1", [
          makeQuestion({
            text: "Which surfaces?",
            options: [
              { id: "o1", label: "All pages" },
              { id: "o2", label: "Dashboard only" },
            ],
            selectedOptionId: "o1",
          }),
        ]),
      },
      comments: {
        "i-1": [
          makeComment({ uuid: "c-1", content: "Approved scope", authorType: "user", authorName: "Alice" }),
        ],
      },
    });

    const anchor = await getAlignmentAnchor(COMPANY, "proposal", "p-1");

    expect(anchor.anchorAvailable).toBe(true);
    expect(anchor.directIdeaUuid).toBe("i-1");
    expect(anchor.rootIdeaUuid).toBe("i-1");
    expect(anchor.resolvedVia).toBe("root_idea");
    expect(anchor.ideas).toHaveLength(1);
    expect(anchor.ideas[0]).toEqual({
      uuid: "i-1",
      title: "Ship dark mode",
      content: "Add a dark theme toggle",
      elaboration: [{ question: "Which surfaces?", answer: "All pages", answeredByType: "user" }],
      comments: [
        { authorType: "user", author: "Alice", at: "2026-01-02T00:00:00.000Z", content: "Approved scope" },
      ],
    });
  });

  // ===== task → proposal → idea =====
  it("walks task → proposal → idea and anchors on the direct idea, not the root", async () => {
    installGraph({
      ideas: [
        { uuid: "i-root", title: "Theme", content: "Umbrella theme", parentUuid: null },
        { uuid: "i-child", title: "Child idea", content: "The real intent", parentUuid: "i-root" },
      ],
      proposals: [{ uuid: "p-1", title: "P1", inputType: "idea", inputUuids: ["i-child"] }],
      tasks: [{ uuid: "t-1", title: "T1", proposalUuid: "p-1" }],
    });

    const anchor = await getAlignmentAnchor(COMPANY, "task", "t-1");

    expect(anchor.resolvedVia).toBe("via_proposal");
    expect(anchor.directIdeaUuid).toBe("i-child");
    expect(anchor.rootIdeaUuid).toBe("i-root");
    expect(anchor.ideas).toHaveLength(1);
    expect(anchor.ideas[0].uuid).toBe("i-child");
    expect(anchor.ideas[0].content).toBe("The real intent");
    // secondary context: ancestor titles ordered root → direct
    expect(anchor.lineageTitles).toEqual(["Theme", "Child idea"]);
  });

  // ===== idea-direct =====
  it("anchors an idea entity on itself", async () => {
    installGraph({
      ideas: [{ uuid: "i-solo", title: "Solo", content: "Standalone", parentUuid: null }],
    });

    const anchor = await getAlignmentAnchor(COMPANY, "idea", "i-solo");

    expect(anchor.anchorAvailable).toBe(true);
    expect(anchor.directIdeaUuid).toBe("i-solo");
    expect(anchor.rootIdeaUuid).toBe("i-solo");
    expect(anchor.ideas).toHaveLength(1);
    expect(anchor.ideas[0].uuid).toBe("i-solo");
    expect(anchor.lineageTitles).toEqual(["Solo"]);
  });

  // ===== THEME-NESTED idea (load-bearing) =====
  it("theme-nested idea anchors on the CHILD directIdeaUuid, NEVER the parent theme", async () => {
    installGraph({
      ideas: [
        { uuid: "i-theme", title: "Parent Theme", content: "Broad theme intent", parentUuid: null },
        { uuid: "i-nested", title: "Nested Idea", content: "The specific intent", parentUuid: "i-theme" },
      ],
      proposals: [{ uuid: "p-nested", title: "P", inputType: "idea", inputUuids: ["i-nested"] }],
      comments: {
        "i-theme": [
          makeComment({ uuid: "c-theme", content: "theme-level note", authorType: "user", authorName: "T" }),
        ],
        "i-nested": [
          makeComment({ uuid: "c-nested", content: "child-level note", authorType: "user", authorName: "N" }),
        ],
      },
    });

    const anchor = await getAlignmentAnchor(COMPANY, "proposal", "p-nested");

    // The anchor idea is the child, and its bundle is the child's — not the theme's.
    expect(anchor.directIdeaUuid).toBe("i-nested");
    expect(anchor.rootIdeaUuid).toBe("i-theme");
    expect(anchor.ideas).toHaveLength(1);
    expect(anchor.ideas[0].uuid).toBe("i-nested");
    expect(anchor.ideas[0].content).toBe("The specific intent");
    expect(anchor.ideas[0].comments).toEqual([
      { authorType: "user", author: "N", at: "2026-01-02T00:00:00.000Z", content: "child-level note" },
    ]);
    // The theme is NEVER the anchor idea.
    expect(anchor.ideas.map((i) => i.uuid)).not.toContain("i-theme");
    // ...but it IS surfaced as light lineage context.
    expect(anchor.lineageTitles).toEqual(["Parent Theme", "Nested Idea"]);
  });

  // ===== multi-input proposal =====
  it("returns ALL input ideas for a proposal that combines several ideas", async () => {
    installGraph({
      ideas: [
        { uuid: "i-a", title: "Idea A", content: "intent A", parentUuid: null },
        { uuid: "i-b", title: "Idea B", content: "intent B", parentUuid: null },
      ],
      proposals: [{ uuid: "p-merge", title: "Merge", inputType: "idea", inputUuids: ["i-a", "i-b"] }],
      elaborations: {
        "i-a": makeElaboration("i-a", [
          makeQuestion({ text: "QA", options: [{ id: "oa", label: "Ans A" }], selectedOptionId: "oa" }),
        ]),
      },
      comments: {
        "i-b": [makeComment({ uuid: "c-b", content: "B note", authorType: "agent", authorName: "Bot" })],
      },
    });

    const anchor = await getAlignmentAnchor(COMPANY, "proposal", "p-merge");

    expect(anchor.anchorAvailable).toBe(true);
    expect(anchor.directIdeaUuid).toBe("i-a"); // primary line = inputUuids[0]
    expect(anchor.ideas.map((i) => i.uuid)).toEqual(["i-a", "i-b"]);
    expect(anchor.ideas[0].elaboration).toEqual([{ question: "QA", answer: "Ans A", answeredByType: "user" }]);
    expect(anchor.ideas[1].comments).toEqual([
      { authorType: "agent", author: "Bot", at: "2026-01-02T00:00:00.000Z", content: "B note" },
    ]);
  });

  // ===== no attached idea =====
  it("returns anchorAvailable:false with empty ideas for a document-input proposal (no throw)", async () => {
    installGraph({
      proposals: [{ uuid: "p-doc", title: "PDoc", inputType: "document", inputUuids: ["d-src"] }],
    });

    const anchor = await getAlignmentAnchor(COMPANY, "proposal", "p-doc");

    expect(anchor.anchorAvailable).toBe(false);
    expect(anchor.ideas).toEqual([]);
    expect(anchor.directIdeaUuid).toBeNull();
    expect(anchor.rootIdeaUuid).toBeNull();
    expect(anchor.lineageTitles).toEqual([]);
    expect(anchor.resolvedVia).toBe("proposal_input_not_idea");
  });

  it("returns anchorAvailable:false for a quick task with no proposal", async () => {
    installGraph({ tasks: [{ uuid: "t-quick", title: "Quick", proposalUuid: null }] });

    const anchor = await getAlignmentAnchor(COMPANY, "task", "t-quick");

    expect(anchor.anchorAvailable).toBe(false);
    expect(anchor.ideas).toEqual([]);
    expect(anchor.resolvedVia).toBe("no_proposal");
  });

  it("returns anchorAvailable:false for a missing/cross-company entity", async () => {
    installGraph({
      ideas: [{ uuid: "i-a", title: "A", parentUuid: null }],
      proposals: [{ uuid: "p-1", title: "P1", inputType: "idea", inputUuids: ["i-a"] }],
      tasks: [{ uuid: "t-1", title: "T1", proposalUuid: "p-1" }],
    });

    const anchor = await getAlignmentAnchor(OTHER_COMPANY, "task", "t-1");

    expect(anchor.anchorAvailable).toBe(false);
    expect(anchor.ideas).toEqual([]);
    expect(anchor.resolvedVia).toBe("not_found");
  });

  // ===== comment authorType (escape-hatch enforcement input) =====
  it("carries each comment's authorType so a reviewer can enforce the human-authored escape hatch", async () => {
    installGraph({
      ideas: [{ uuid: "i-1", title: "I", content: null, parentUuid: null }],
      comments: {
        "i-1": [
          makeComment({ uuid: "c-user", content: "human authorized extra scope", authorType: "user", authorName: "Human" }),
          makeComment({ uuid: "c-agent", content: "agent self-note", authorType: "agent", authorName: "Agent X" }),
        ],
      },
    });

    const anchor = await getAlignmentAnchor(COMPANY, "idea", "i-1");

    expect(anchor.ideas[0].comments).toEqual([
      { authorType: "user", author: "Human", at: "2026-01-02T00:00:00.000Z", content: "human authorized extra scope" },
      { authorType: "agent", author: "Agent X", at: "2026-01-02T00:00:00.000Z", content: "agent self-note" },
    ]);
    // content is passed through untouched, including null idea bodies.
    expect(anchor.ideas[0].content).toBeNull();
  });

  // ===== N2: super_admin is a HUMAN actor, classified human-originated =====
  it("classifies a super_admin comment as human-originated ('user'), not agent", async () => {
    installGraph({
      ideas: [{ uuid: "i-1", title: "I", content: null, parentUuid: null }],
      comments: {
        "i-1": [
          makeComment({ uuid: "c-sa", content: "super-admin authorized this", authorType: "super_admin", authorName: "Root" }),
          makeComment({ uuid: "c-agent", content: "agent self-note", authorType: "agent", authorName: "Agent X" }),
        ],
      },
    });

    const anchor = await getAlignmentAnchor(COMPANY, "idea", "i-1");

    // super_admin → "user" so the reviewer's human-authored escape hatch accepts it;
    // the agent comment stays "agent" so a drifting agent still cannot self-clear.
    expect(anchor.ideas[0].comments).toEqual([
      { authorType: "user", author: "Root", at: "2026-01-02T00:00:00.000Z", content: "super-admin authorized this" },
      { authorType: "agent", author: "Agent X", at: "2026-01-02T00:00:00.000Z", content: "agent self-note" },
    ]);
  });

  // ===== N1: human-answered vs agent-answered elaboration are distinguishable =====
  it("tags each elaboration decision with answeredByType so agent-self-answered (YOLO) rounds are distinguishable from human-answered", async () => {
    installGraph({
      ideas: [{ uuid: "i-1", title: "I", content: "c", parentUuid: null }],
      elaborations: {
        "i-1": makeElaboration("i-1", [
          makeQuestion({ text: "Human decided", options: [{ id: "o1", label: "H" }], selectedOptionId: "o1", answeredByType: "user" }),
          makeQuestion({ text: "Agent decided", options: [{ id: "o2", label: "A" }], selectedOptionId: "o2", answeredByType: "agent" }),
          makeQuestion({ text: "Super-admin decided", options: [{ id: "o3", label: "S" }], selectedOptionId: "o3", answeredByType: "super_admin" }),
        ]),
      },
    });

    const anchor = await getAlignmentAnchor(COMPANY, "idea", "i-1");

    // Human and super_admin answers authorize ("user"); the agent-self-answered one
    // is flagged "agent" and cannot authorize drift.
    expect(anchor.ideas[0].elaboration).toEqual([
      { question: "Human decided", answer: "H", answeredByType: "user" },
      { question: "Agent decided", answer: "A", answeredByType: "agent" },
      { question: "Super-admin decided", answer: "S", answeredByType: "user" },
    ]);
  });

  // ===== resolved-decision label mapping =====
  it("maps only ANSWERED decisions, using option label, 'Other' customText, and id fallback", async () => {
    installGraph({
      ideas: [{ uuid: "i-1", title: "I", content: "c", parentUuid: null }],
      elaborations: {
        "i-1": makeElaboration("i-1", [
          // chosen option → its label
          makeQuestion({
            text: "Selected option",
            options: [{ id: "o1", label: "Chosen Label" }],
            selectedOptionId: "o1",
          }),
          // "Other" free-text → customText
          makeQuestion({ text: "Other answer", selectedOptionId: null, customText: "free text" }),
          // selected option whose row is gone → id fallback
          makeQuestion({ text: "Ghost option", options: [], selectedOptionId: "missing-opt" }),
          // answer with neither option nor customText (defensive) → ""
          makeQuestion({ text: "Empty answer", selectedOptionId: null, customText: null }),
          // unanswered → excluded entirely
          makeQuestion({ text: "Unanswered", answered: false }),
        ]),
      },
    });

    const anchor = await getAlignmentAnchor(COMPANY, "idea", "i-1");

    expect(anchor.ideas[0].elaboration).toEqual([
      { question: "Selected option", answer: "Chosen Label", answeredByType: "user" },
      { question: "Other answer", answer: "free text", answeredByType: "user" },
      { question: "Ghost option", answer: "missing-opt", answeredByType: "user" },
      { question: "Empty answer", answer: "", answeredByType: "user" },
    ]);
  });

  it("returns empty elaboration/comments when the idea has none", async () => {
    installGraph({
      ideas: [{ uuid: "i-1", title: "I", content: "c", parentUuid: null }],
    });

    const anchor = await getAlignmentAnchor(COMPANY, "idea", "i-1");

    expect(anchor.ideas[0].elaboration).toEqual([]);
    expect(anchor.ideas[0].comments).toEqual([]);
  });

  // ===== multi-input fallback: only inputUuids[0] readable =====
  it("falls back to the direct idea when a multi-input proposal's other ideas are unreadable", async () => {
    // i-a exists; i-ghost does not. resolveRootIdea resolves directIdeaUuid=i-a;
    // collectAnchorIdeaUuids reads inputUuids, keeps only i-a.
    installGraph({
      ideas: [{ uuid: "i-a", title: "A", content: "intent A", parentUuid: null }],
      proposals: [{ uuid: "p-merge", title: "Merge", inputType: "idea", inputUuids: ["i-a", "i-ghost"] }],
    });

    const anchor = await getAlignmentAnchor(COMPANY, "proposal", "p-merge");

    expect(anchor.directIdeaUuid).toBe("i-a");
    expect(anchor.ideas.map((i) => i.uuid)).toEqual(["i-a"]);
    expect(anchor.anchorAvailable).toBe(true);
  });
});

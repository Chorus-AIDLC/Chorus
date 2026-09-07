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
      baselineElaboration: [{ question: "Which surfaces?", answer: "All pages", answeredByType: "user" }],
      humanComments: [
        { authorType: "user", author: "Alice", at: "2026-01-02T00:00:00.000Z", content: "Approved scope" },
      ],
      agentContext: { elaboration: [], comments: [] },
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
    expect(anchor.ideas[0].humanComments).toEqual([
      { authorType: "user", author: "N", at: "2026-01-02T00:00:00.000Z", content: "child-level note" },
    ]);
    expect(anchor.ideas[0].agentContext.comments).toEqual([]);
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
    expect(anchor.ideas[0].baselineElaboration).toEqual([{ question: "QA", answer: "Ans A", answeredByType: "user" }]);
    // i-b's only comment is agent-authored → audit context, never the human baseline.
    expect(anchor.ideas[1].humanComments).toEqual([]);
    expect(anchor.ideas[1].agentContext.comments).toEqual([
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

  // ===== STRUCTURAL split: human comment → baseline, agent comment → agentContext =====
  it("routes a human-authored comment into humanComments (baseline) and an agent-authored comment into agentContext (audit-only)", async () => {
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

    // Only the human-authored comment is baseline (part of original intent).
    expect(anchor.ideas[0].humanComments).toEqual([
      { authorType: "user", author: "Human", at: "2026-01-02T00:00:00.000Z", content: "human authorized extra scope" },
    ]);
    // The agent-authored comment is audit-only context, never baseline.
    expect(anchor.ideas[0].agentContext.comments).toEqual([
      { authorType: "agent", author: "Agent X", at: "2026-01-02T00:00:00.000Z", content: "agent self-note" },
    ]);
    // content is passed through untouched, including null idea bodies.
    expect(anchor.ideas[0].content).toBeNull();
  });

  // ===== N1: human-answered vs agent-answered elaboration are distinguishable =====
  it("tags each elaboration decision with answeredByType so agent-self-answered (YOLO) rounds are distinguishable from human-answered", async () => {
    installGraph({
      ideas: [{ uuid: "i-1", title: "I", content: "c", parentUuid: null }],
      elaborations: {
        "i-1": makeElaboration("i-1", [
          makeQuestion({ text: "Human decided", options: [{ id: "o1", label: "H" }], selectedOptionId: "o1", answeredByType: "user" }),
          makeQuestion({ text: "Agent decided", options: [{ id: "o2", label: "A" }], selectedOptionId: "o2", answeredByType: "agent" }),
        ]),
      },
    });

    const anchor = await getAlignmentAnchor(COMPANY, "idea", "i-1");

    // A human-answered decision is baseline ("user"); the agent-self-answered (YOLO)
    // one is routed to agentContext and cannot authorize drift. (The only actor types
    // a real elaboration answer carries are "user" (dashboard) and "agent" (MCP).)
    expect(anchor.ideas[0].baselineElaboration).toEqual([
      { question: "Human decided", answer: "H", answeredByType: "user" },
    ]);
    expect(anchor.ideas[0].agentContext.elaboration).toEqual([
      { question: "Agent decided", answer: "A", answeredByType: "agent" },
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

    expect(anchor.ideas[0].baselineElaboration).toEqual([
      { question: "Selected option", answer: "Chosen Label", answeredByType: "user" },
      { question: "Other answer", answer: "free text", answeredByType: "user" },
      { question: "Ghost option", answer: "missing-opt", answeredByType: "user" },
      { question: "Empty answer", answer: "", answeredByType: "user" },
    ]);
    expect(anchor.ideas[0].agentContext.elaboration).toEqual([]);
  });

  it("returns empty baseline and empty agentContext when the idea has no elaboration/comments", async () => {
    installGraph({
      ideas: [{ uuid: "i-1", title: "I", content: "c", parentUuid: null }],
    });

    const anchor = await getAlignmentAnchor(COMPANY, "idea", "i-1");

    expect(anchor.ideas[0].baselineElaboration).toEqual([]);
    expect(anchor.ideas[0].humanComments).toEqual([]);
    expect(anchor.ideas[0].agentContext).toEqual({ elaboration: [], comments: [] });
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

  // ===== ANTI-SELF-AUTHORIZATION (Codex BLOCKER c3fecf2d) =====
  // The core guarantee: an agent claiming extra scope — via its own idea comment OR
  // by self-answering a YOLO elaboration — is STRUCTURALLY kept out of the baseline
  // (original intent). Only human-originated entries land in the baseline, so a
  // reviewer that anchors on the baseline can never silently absorb agent-claimed
  // scope and must still raise it as unauthorized drift.
  it("keeps an agent-claimed scope expansion (comment + self-answered elaboration) OUT of the baseline; only human entries are baseline", async () => {
    installGraph({
      ideas: [{ uuid: "i-1", title: "Login page", content: "Add an email/password login form", parentUuid: null }],
      elaborations: {
        "i-1": makeElaboration("i-1", [
          // Human-answered decision → baseline (a genuine authorization).
          makeQuestion({
            text: "Password reset in scope?",
            options: [{ id: "y", label: "Yes, add reset flow" }],
            selectedOptionId: "y",
            answeredByType: "user",
          }),
          // Agent self-answered (YOLO) decision claiming SSO scope → agentContext, NOT baseline.
          makeQuestion({
            text: "Add SSO?",
            options: [{ id: "sso", label: "Yes, add SSO/SAML" }],
            selectedOptionId: "sso",
            answeredByType: "agent",
          }),
        ]),
      },
      comments: {
        "i-1": [
          // Human comment authorizing scope → baseline.
          makeComment({ uuid: "c-h", content: "Approved: also add a Remember-me checkbox", authorType: "user", authorName: "Owner" }),
          // Agent comment claiming extra scope → agentContext, NOT baseline (the poison attempt).
          makeComment({ uuid: "c-a", content: "SSO is now in scope", authorType: "agent", authorName: "Worker Bot" }),
        ],
      },
    });

    const anchor = await getAlignmentAnchor(COMPANY, "idea", "i-1");
    const idea = anchor.ideas[0];

    // Baseline = human-answered elaboration + human-authored comments ONLY.
    expect(idea.baselineElaboration).toEqual([
      { question: "Password reset in scope?", answer: "Yes, add reset flow", answeredByType: "user" },
    ]);
    expect(idea.humanComments).toEqual([
      { authorType: "user", author: "Owner", at: "2026-01-02T00:00:00.000Z", content: "Approved: also add a Remember-me checkbox" },
    ]);

    // The agent's SSO scope-claim (both channels) is audit-only context, never baseline.
    expect(idea.agentContext.elaboration).toEqual([
      { question: "Add SSO?", answer: "Yes, add SSO/SAML", answeredByType: "agent" },
    ]);
    expect(idea.agentContext.comments).toEqual([
      { authorType: "agent", author: "Worker Bot", at: "2026-01-02T00:00:00.000Z", content: "SSO is now in scope" },
    ]);

    // No agent-originated text can leak into the baseline channels.
    const baselineText = [
      idea.content ?? "",
      ...idea.baselineElaboration.map((d) => `${d.question} ${d.answer}`),
      ...idea.humanComments.map((c) => c.content),
    ].join(" ");
    expect(baselineText).not.toContain("SSO");
    expect(idea.baselineElaboration.every((d) => d.answeredByType === "user")).toBe(true);
    expect(idea.humanComments.every((c) => c.authorType === "user")).toBe(true);
  });

  // ===== FAIL-CLOSED classifier (AC2) =====
  // toAnchorActorType is fail-closed: ONLY the exact stored type "user" is human.
  // agent / agent_instance / an unknown future type / a missing type all collapse to
  // "agent", so none of them can enter the baseline.
  it("is fail-closed: only stored type 'user' is baseline; agent_instance and unknown types are agentContext", async () => {
    installGraph({
      ideas: [{ uuid: "i-1", title: "I", content: "c", parentUuid: null }],
      elaborations: {
        "i-1": makeElaboration("i-1", [
          makeQuestion({ text: "Q-user", options: [{ id: "u", label: "U" }], selectedOptionId: "u", answeredByType: "user" }),
          makeQuestion({ text: "Q-inst", options: [{ id: "i", label: "I" }], selectedOptionId: "i", answeredByType: "agent_instance" }),
          makeQuestion({ text: "Q-unknown", options: [{ id: "k", label: "K" }], selectedOptionId: "k", answeredByType: "superadmin" }),
        ]),
      },
      comments: {
        "i-1": [
          makeComment({ uuid: "c-user", content: "human", authorType: "user", authorName: "H" }),
          makeComment({ uuid: "c-inst", content: "instance", authorType: "agent_instance", authorName: "AI" }),
          makeComment({ uuid: "c-unknown", content: "mystery", authorType: "robot", authorName: "R" }),
        ],
      },
    });

    const anchor = await getAlignmentAnchor(COMPANY, "idea", "i-1");
    const idea = anchor.ideas[0];

    // Exactly one human decision and one human comment reach the baseline.
    expect(idea.baselineElaboration).toEqual([
      { question: "Q-user", answer: "U", answeredByType: "user" },
    ]);
    expect(idea.humanComments).toEqual([
      { authorType: "user", author: "H", at: "2026-01-02T00:00:00.000Z", content: "human" },
    ]);

    // agent_instance AND the unknown type both collapse to "agent" and land in agentContext.
    expect(idea.agentContext.elaboration.map((d) => d.question)).toEqual(["Q-inst", "Q-unknown"]);
    expect(idea.agentContext.elaboration.every((d) => d.answeredByType === "agent")).toBe(true);
    expect(idea.agentContext.comments.map((c) => c.content)).toEqual(["instance", "mystery"]);
    expect(idea.agentContext.comments.every((c) => c.authorType === "agent")).toBe(true);
  });
});

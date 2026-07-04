// Tests for the conversational-idea dispatch (add-conversational-idea-root-session):
// createConversationalIdeaSession + the exported template/placeholder helpers.
//
// The dispatch writes the idea + session + turn DIRECTLY inside prisma.$transaction
// (bypassing resolveOrCreateSession/createPendingTurn — they run on the global client
// and cannot see uncommitted rows), so these tests assert against the tx-client writes
// and the post-commit side effects (transcript SSE, idea change event, deliver_turn
// ping) rather than composed-service spies.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock (global client + the $transaction tx client) =====
const mockTx = vi.hoisted(() => ({
  idea: { create: vi.fn() },
  daemonSession: { create: vi.fn() },
  daemonSessionTurn: { create: vi.fn() },
}));
const mockPrisma = vi.hoisted(() => ({
  agent: { count: vi.fn() },
  project: { findFirst: vi.fn() },
  daemonConnection: { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// event-bus: assert the idea `created` change event fires post-commit.
const mockEmitChange = vi.fn();
vi.mock("@/lib/event-bus", () => ({
  eventBus: { emitChange: (...a: unknown[]) => mockEmitChange(...a) },
}));

// daemon-session.service: the SUT imports publishTranscriptEvent (the one caller that
// emits turn_created outside createPendingTurn) — spy it; other imports are unused here.
const mockPublishTranscript = vi.fn();
vi.mock("@/services/daemon-session.service", () => ({
  resolveOrCreateSession: vi.fn(),
  assertContinuable: vi.fn(),
  getVisibleSessions: vi.fn(),
  getFirstInstructionBySessionUuid: vi.fn(),
  publishTranscriptEvent: (...a: unknown[]) => mockPublishTranscript(...a),
  STALE_THRESHOLD_MS: 90_000,
}));

vi.mock("@/services/notification.service", () => ({
  createReturningTurn: vi.fn(),
  create: vi.fn(),
}));

const mockConnectionBelongsToAgent = vi.fn();
const mockIsConnectionLive = vi.fn();
vi.mock("@/services/daemon-execution.service", () => ({
  connectionBelongsToAgent: (...a: unknown[]) => mockConnectionBelongsToAgent(...a),
  isConnectionLive: (...a: unknown[]) => mockIsConnectionLive(...a),
}));

const mockDispatchControl = vi.fn();
vi.mock("@/services/daemon-control.service", () => ({
  dispatchControl: (...a: unknown[]) => mockDispatchControl(...a),
}));

// Deterministic server-generated ideaUuid.
const STUB_IDEA_UUID = "idea-0000-0000-0000-00000000gen1";
vi.mock("crypto", () => ({ randomUUID: () => STUB_IDEA_UUID }));

import {
  createConversationalIdeaSession,
  composeConversationalIdeaInstruction,
  derivePlaceholderTitle,
  PLACEHOLDER_TITLE_MAX,
  MAX_INSTRUCTION_CHARS,
  ConnectionNotVisibleError,
  ConnectionOfflineError,
  ConnectionInstanceMissingError,
  ProjectNotVisibleError,
  InstructionTextError,
} from "@/services/daemon-instruction.service";

// ===== Fixtures =====
const companyUuid = "company-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const instanceUuid = "inst-0000-0000-0000-000000000001";
const projectUuid = "proj-0000-0000-0000-000000000001";
const sessionUuid = "sess-0000-0000-0000-000000000001";
const turnUuid = "turn-0000-0000-0000-000000000001";

const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
const NOW = new Date("2026-07-03T12:00:00.000Z");

const validParams = {
  projectUuid,
  agentUuid,
  connectionUuid,
  descriptionText: "Add CSV export to the report page\nwith per-column filters.",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.agent.count.mockResolvedValue(1);
  mockPrisma.project.findFirst.mockResolvedValue({ uuid: projectUuid, name: "Chorus" });
  mockPrisma.daemonConnection.findFirst.mockResolvedValue({
    agentInstanceUuid: instanceUuid,
  });
  mockConnectionBelongsToAgent.mockResolvedValue(true);
  mockIsConnectionLive.mockResolvedValue(true);

  // $transaction runs its callback against the tx client and returns its result.
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx),
  );
  mockTx.idea.create.mockImplementation(async ({ data, select: _select }) => ({
    uuid: data.uuid,
    title: data.title,
    content: data.content,
    status: data.status,
    projectUuid: data.projectUuid,
    createdAt: NOW,
  }));
  mockTx.daemonSession.create.mockImplementation(async ({ data }) => ({
    uuid: sessionUuid,
    agentUuid: data.agentUuid,
    sessionId: data.sessionId,
    directIdeaUuid: data.directIdeaUuid,
    originConnectionUuid: data.originConnectionUuid,
    status: data.status,
    title: null,
    lastTurnAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  mockTx.daemonSessionTurn.create.mockImplementation(async ({ data }) => ({
    uuid: turnUuid,
    sessionUuid: data.sessionUuid,
    seq: data.seq,
    trigger: data.trigger,
    promptText: data.promptText,
    status: data.status,
    executionUuid: null,
    startedAt: null,
    endedAt: null,
    createdAt: NOW,
  }));
});

// ===== derivePlaceholderTitle =====
describe("derivePlaceholderTitle", () => {
  it("takes the first non-empty line, trimmed", () => {
    expect(derivePlaceholderTitle("  Add CSV export  \nmore detail")).toBe(
      "Add CSV export",
    );
  });

  it("skips leading empty/whitespace-only lines", () => {
    expect(derivePlaceholderTitle("\n   \nActual first line\nrest")).toBe(
      "Actual first line",
    );
  });

  it("truncates a long first line to the max with an ellipsis", () => {
    const long = "x".repeat(PLACEHOLDER_TITLE_MAX + 40);
    const title = derivePlaceholderTitle(long);
    expect(title.length).toBe(PLACEHOLDER_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
  });

  it("keeps a line exactly at the max un-truncated", () => {
    const exact = "y".repeat(PLACEHOLDER_TITLE_MAX);
    expect(derivePlaceholderTitle(exact)).toBe(exact);
  });

  it("is total on blank input (unreachable via the endpoint)", () => {
    expect(derivePlaceholderTitle("")).toBe("-");
    expect(derivePlaceholderTitle("   \n  ")).toBe("-");
  });
});

// ===== composeConversationalIdeaInstruction =====
describe("composeConversationalIdeaInstruction", () => {
  const base = {
    ideaUuid: STUB_IDEA_UUID,
    projectUuid,
    projectName: "Chorus",
    descriptionText: "The user's exact words\nacross lines — 保留原文。",
  };

  it("embeds the ideaUuid, project identity, and the description verbatim", () => {
    const text = composeConversationalIdeaInstruction(base);
    expect(text).toContain(`ideaUuid: ${STUB_IDEA_UUID}`);
    expect(text).toContain(`"Chorus" (projectUuid: ${projectUuid})`);
    expect(text).toContain(base.descriptionText);
  });

  it("directs edit + immediate elaboration + panel guidance + end turn", () => {
    const text = composeConversationalIdeaInstruction(base);
    expect(text).toContain("chorus_edit_idea");
    expect(text).toContain("chorus_pm_start_elaboration");
    expect(text.toLowerCase()).toContain("elaboration panel");
    expect(text).toContain("End the turn");
  });

  it("contains NO create-idea or claim directives (the idea pre-exists, assigned)", () => {
    const text = composeConversationalIdeaInstruction(base);
    expect(text).not.toContain("chorus_pm_create_idea");
    expect(text).not.toContain("chorus_claim_idea");
  });

  it("degrades to the uuid-only project label when the name is missing/blank", () => {
    const text = composeConversationalIdeaInstruction({ ...base, projectName: "  " });
    expect(text).toContain(`project projectUuid: ${projectUuid}`);
    expect(text).not.toContain('""');
  });
});

// ===== createConversationalIdeaSession — happy path =====
describe("createConversationalIdeaSession", () => {
  it("creates idea + idea-anchored session + first turn in one transaction", async () => {
    const { idea, session, turn } = await createConversationalIdeaSession(
      userAuth,
      validParams,
    );

    // One transaction wraps all three writes.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

    // Idea: createdBy = the USER, placeholder title from the first line, verbatim
    // content, instance-assigned, elaborating (assignment-equals-claim).
    const ideaData = mockTx.idea.create.mock.calls[0][0].data;
    expect(ideaData).toMatchObject({
      uuid: STUB_IDEA_UUID,
      companyUuid,
      projectUuid,
      title: "Add CSV export to the report page",
      content: validParams.descriptionText,
      status: "elaborating",
      assigneeType: "agent_instance",
      assigneeUuid: instanceUuid,
      assignedByUuid: ownerUuid,
      createdByUuid: ownerUuid,
    });

    // Session: anchored from birth — sessionId === directIdeaUuid === ideaUuid,
    // origin = the picked connection.
    const sessionData = mockTx.daemonSession.create.mock.calls[0][0].data;
    expect(sessionData).toMatchObject({
      companyUuid,
      agentUuid,
      sessionId: STUB_IDEA_UUID,
      directIdeaUuid: STUB_IDEA_UUID,
      originConnectionUuid: connectionUuid,
      status: "active",
    });

    // Turn: seq 1, human_instruction, promptText = the composed template embedding the
    // ideaUuid and the verbatim description.
    const turnData = mockTx.daemonSessionTurn.create.mock.calls[0][0].data;
    expect(turnData.seq).toBe(1);
    expect(turnData.trigger).toBe("human_instruction");
    expect(turnData.status).toBe("pending");
    expect(turnData.promptText).toContain(`ideaUuid: ${STUB_IDEA_UUID}`);
    expect(turnData.promptText).toContain(validParams.descriptionText);

    // Returned views round-trip the created rows.
    expect(idea.uuid).toBe(STUB_IDEA_UUID);
    expect(session.sessionId).toBe(STUB_IDEA_UUID);
    expect(session.directIdeaUuid).toBe(STUB_IDEA_UUID);
    expect(turn.uuid).toBe(turnUuid);
    expect(turn.promptText).toContain(validParams.descriptionText);
  });

  it("emits exactly ONE deliver_turn ping (post-commit, precise turnUuid, origin only)", async () => {
    await createConversationalIdeaSession(userAuth, validParams);
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
    expect(mockDispatchControl).toHaveBeenCalledWith({
      companyUuid,
      targetConnectionUuid: connectionUuid,
      command: "deliver_turn",
      turnUuid,
    });
  });

  it("publishes the turn_created transcript trigger and the idea created change event", async () => {
    await createConversationalIdeaSession(userAuth, validParams);
    expect(mockPublishTranscript).toHaveBeenCalledTimes(1);
    expect(mockPublishTranscript.mock.calls[0][0]).toMatchObject({
      companyUuid,
      sessionUuid,
      trigger: "turn_created",
      messages: [],
    });
    expect(mockEmitChange).toHaveBeenCalledWith({
      companyUuid,
      projectUuid,
      entityType: "idea",
      entityUuid: STUB_IDEA_UUID,
      action: "created",
    });
  });

  it("a failed ping is non-fatal (turn persisted; backfill is the durability net)", async () => {
    mockDispatchControl.mockImplementation(() => {
      throw new Error("bus down");
    });
    const result = await createConversationalIdeaSession(userAuth, validParams);
    expect(result.turn.uuid).toBe(turnUuid);
  });
});

// ===== Gates — each fails BEFORE any mutation =====
describe("createConversationalIdeaSession gates", () => {
  async function expectNoMutation() {
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockTx.idea.create).not.toHaveBeenCalled();
    expect(mockTx.daemonSession.create).not.toHaveBeenCalled();
    expect(mockTx.daemonSessionTurn.create).not.toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
    expect(mockEmitChange).not.toHaveBeenCalled();
  }

  it("unowned agent → ConnectionNotVisibleError, nothing persisted", async () => {
    mockPrisma.agent.count.mockResolvedValue(0);
    await expect(
      createConversationalIdeaSession(userAuth, validParams),
    ).rejects.toBeInstanceOf(ConnectionNotVisibleError);
    await expectNoMutation();
  });

  it("foreign/absent connection → ConnectionNotVisibleError, nothing persisted", async () => {
    mockConnectionBelongsToAgent.mockResolvedValue(false);
    await expect(
      createConversationalIdeaSession(userAuth, validParams),
    ).rejects.toBeInstanceOf(ConnectionNotVisibleError);
    await expectNoMutation();
  });

  it("offline connection → ConnectionOfflineError, nothing persisted", async () => {
    mockIsConnectionLive.mockResolvedValue(false);
    await expect(
      createConversationalIdeaSession(userAuth, validParams),
    ).rejects.toBeInstanceOf(ConnectionOfflineError);
    await expectNoMutation();
  });

  it("foreign/absent project → ProjectNotVisibleError, nothing persisted", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);
    await expect(
      createConversationalIdeaSession(userAuth, validParams),
    ).rejects.toBeInstanceOf(ProjectNotVisibleError);
    await expectNoMutation();
  });

  it("instance-less connection → ConnectionInstanceMissingError, nothing persisted", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ agentInstanceUuid: null });
    await expect(
      createConversationalIdeaSession(userAuth, validParams),
    ).rejects.toBeInstanceOf(ConnectionInstanceMissingError);
    await expectNoMutation();
  });

  it("empty description → InstructionTextError(empty), nothing persisted", async () => {
    await expect(
      createConversationalIdeaSession(userAuth, {
        ...validParams,
        descriptionText: "   \n  ",
      }),
    ).rejects.toMatchObject({ name: "InstructionTextError", reason: "empty" });
    await expectNoMutation();
  });

  it("over-length COMPOSED instruction → InstructionTextError(too_long), nothing persisted", async () => {
    // The description alone fits, but template overhead pushes the composed text over.
    const nearCap = "z".repeat(MAX_INSTRUCTION_CHARS - 10);
    await expect(
      createConversationalIdeaSession(userAuth, {
        ...validParams,
        descriptionText: nearCap,
      }),
    ).rejects.toBeInstanceOf(InstructionTextError);
    await expectNoMutation();
  });

  it("mid-transaction failure propagates and persists nothing after it", async () => {
    // The tx callback throws at the session write → $transaction rejects (rollback);
    // no post-commit side effects fire.
    mockTx.daemonSession.create.mockRejectedValue(new Error("db down"));
    await expect(
      createConversationalIdeaSession(userAuth, validParams),
    ).rejects.toThrow("db down");
    expect(mockDispatchControl).not.toHaveBeenCalled();
    expect(mockPublishTranscript).not.toHaveBeenCalled();
    expect(mockEmitChange).not.toHaveBeenCalled();
  });
});

// ===== Agent-key caller scope =====
describe("agent-key caller", () => {
  it("an agent key may only dispatch to itself", async () => {
    const otherAgentAuth = { type: "agent", companyUuid, actorUuid: "someone-else" };
    await expect(
      createConversationalIdeaSession(otherAgentAuth, validParams),
    ).rejects.toBeInstanceOf(ConnectionNotVisibleError);
  });
});

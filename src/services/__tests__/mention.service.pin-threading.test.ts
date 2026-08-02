import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====
//
// This suite LOCKS IN the cwd-addressable-mention semantic contract (spec:
// "Mention markup identifies an instance without changing the wire format"):
// the `?cwd=…&host=…` suffix on a pinned `@[Name](agent:uuid?…)` token is the
// identity of the `AgentInstance` for that agent at `(host, cwd)`. It proves the
// mention.service SEAM that joins the two halves already covered elsewhere:
//   - parseMentions pin EXTRACTION → mention.service.instances.test.ts
//   - wake-side RESOLUTION (resolvePinnedTarget mention branch, directed /
//     offline_pin / online-first) → notification-turn.test.ts
// The seam itself — that createMentions THREADS the parsed (pinnedHost,
// pinnedCwd) into the NotificationCreateParams handed to createBatch, so the T6
// wake resolver can ever see the pin — had no direct test before this task.
//
// Prisma is mocked via vi.hoisted(); createBatch is captured so we can assert
// the exact pin payload that flows toward the wake-turn chokepoint.

const { mockPrisma, mockGetActorName, mockGetPreferences, mockCreateBatch, mockResolveCwd } =
  vi.hoisted(() => ({
    mockPrisma: {
      mention: { createMany: vi.fn() },
      user: { findFirst: vi.fn(), findMany: vi.fn() },
      agent: { findFirst: vi.fn(), findMany: vi.fn() },
      project: { findUnique: vi.fn() },
      comment: { findUnique: vi.fn() },
      daemonConnection: { findMany: vi.fn() },
      daemonExecution: { groupBy: vi.fn() },
    },
    mockGetActorName: vi.fn().mockResolvedValue("Test Actor"),
    mockGetPreferences: vi.fn().mockResolvedValue({ mentioned: true }),
    mockCreateBatch: vi.fn().mockResolvedValue([]),
    mockResolveCwd: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/uuid-resolver", () => ({ getActorName: mockGetActorName }));
vi.mock("@/services/notification.service", () => ({
  getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
  createBatch: (...args: unknown[]) => mockCreateBatch(...args),
}));
vi.mock("@/services/lineage.service", () => ({
  resolveRootIdea: vi.fn().mockResolvedValue({
    rootIdeaUuid: null,
    directIdeaUuid: null,
  }),
}));
vi.mock("@/services/project-agent-cwd.service", () => ({
  resolveProjectAgentCwdTarget: (...args: unknown[]) => mockResolveCwd(...args),
}));

import { createMentions } from "@/services/mention.service";
import { buildMentionMarker } from "@/lib/mention-format";

// ===== Test data (valid hex UUIDs so the mention regex matches) =====

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const PROJECT_UUID = "22222222-2222-2222-2222-222222222222";
const ACTOR_UUID = "33333333-3333-3333-3333-333333333333";
const AGENT_UUID = "55555555-5555-5555-5555-555555555555";
const SOURCE_UUID = "66666666-6666-6666-6666-666666666666";

const PINNED_HOST = "prod";
const PINNED_CWD = "/work";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPreferences.mockResolvedValue({ mentioned: true });
  mockGetActorName.mockResolvedValue("Test Actor");
  mockPrisma.agent.findFirst.mockResolvedValue({ uuid: AGENT_UUID });
  mockPrisma.mention.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.project.findUnique.mockResolvedValue({
    uuid: PROJECT_UUID,
    name: "Test Project",
  });
  mockResolveCwd.mockResolvedValue({
    actorUserUuid: ACTOR_UUID,
    source: "unconfigured",
    agentUuid: AGENT_UUID,
    host: null,
    cwd: null,
    availability: "ready",
    promptPolicy: "select",
    connectionUuid: null,
    agentInstanceUuid: null,
  });
});

/** Run createMentions with a single agent mention built from the given pin. */
async function mentionAgentWith(
  pinnedHost: string | null | undefined,
  pinnedCwd: string | null | undefined,
): Promise<void> {
  const content = `cc ${buildMentionMarker("DevBot", "agent", AGENT_UUID, pinnedHost, pinnedCwd)}`;
  await createMentions({
    companyUuid: COMPANY_UUID,
    sourceType: "comment",
    sourceUuid: SOURCE_UUID,
    content,
    actorType: "user",
    actorUuid: ACTOR_UUID,
    projectUuid: PROJECT_UUID,
    entityTitle: "Test Task",
  });
}

/** The single NotificationCreateParams pushed for the agent mention. */
function notifiedParams(): Record<string, unknown> {
  expect(mockCreateBatch).toHaveBeenCalledTimes(1);
  const batch = mockCreateBatch.mock.calls[0][0] as Record<string, unknown>[];
  const params = batch.find(
    (p) => p.recipientType === "agent" && p.recipientUuid === AGENT_UUID,
  );
  expect(params).toBeDefined();
  return params!;
}

describe("createMentions — threads the mention pin into the wake notification (T6 seam)", () => {
  it("an unpinned Agent comment uses the project-fixed cwd snapshot", async () => {
    mockResolveCwd.mockResolvedValue({
      actorUserUuid: ACTOR_UUID,
      source: "project_fixed",
      agentUuid: AGENT_UUID,
      host: "fixed-host",
      cwd: "/fixed/project",
      availability: "offline",
      promptPolicy: "suppress",
      connectionUuid: null,
      agentInstanceUuid: "fixed-instance",
    });

    await mentionAgentWith(undefined, undefined);

    expect(notifiedParams()).toMatchObject({
      resolvedCwdSource: "project_fixed",
      resolvedCwdHost: "fixed-host",
      resolvedRuntimeCwd: "/fixed/project",
      resolvedCwdAvailability: "offline",
    });
  });

  it("resolves an Agent-authored MCP comment through the author's owner preference", async () => {
    const authorAgentUuid = "77777777-7777-7777-7777-777777777777";
    const ownerUuid = "88888888-8888-8888-8888-888888888888";
    mockPrisma.agent.findFirst.mockImplementation(async ({ where }) =>
      where.uuid === authorAgentUuid
        ? { uuid: authorAgentUuid, ownerUuid }
        : { uuid: AGENT_UUID },
    );
    mockResolveCwd.mockResolvedValue({
      actorUserUuid: ownerUuid,
      source: "project_fixed",
      agentUuid: AGENT_UUID,
      host: "agent-owner-host",
      cwd: "/owner/project",
      availability: "ready",
      promptPolicy: "suppress",
      connectionUuid: "fixed-connection",
      agentInstanceUuid: "fixed-instance",
    });

    await createMentions({
      companyUuid: COMPANY_UUID,
      sourceType: "comment",
      sourceUuid: SOURCE_UUID,
      content: `cc ${buildMentionMarker("DevBot", "agent", AGENT_UUID)}`,
      actorType: "agent",
      actorUuid: authorAgentUuid,
      projectUuid: PROJECT_UUID,
      entityTitle: "Test Task",
    });

    expect(mockResolveCwd).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserUuid: ownerUuid }),
    );
    expect(notifiedParams()).toMatchObject({
      resolvedCwdSource: "project_fixed",
      resolvedCwdHost: "agent-owner-host",
      resolvedRuntimeCwd: "/owner/project",
    });
  });

  it("a PINNED mention threads (pinnedHost, pinnedCwd) onto the wake notification — the AgentInstance identity the resolver matches", async () => {
    // Spec scenario: a comment contains @[Name](agent:uuid?cwd=/work&host=prod)
    // → the mention resolves to the AgentInstance at (host="prod", cwd="/work")
    // for wake targeting. The seam proven here: the parsed pin survives onto the
    // NotificationCreateParams, where T6's resolvePinnedTarget(mentioned) reads
    // ctx.pinnedHost/ctx.pinnedCwd. Those exact values ARE the (host, cwd) tuple
    // resolveInstanceByTuple keys on, so threading them == "resolve the instance".
    await mentionAgentWith(PINNED_HOST, PINNED_CWD);

    const params = notifiedParams();
    expect(params).toMatchObject({
      action: "mentioned",
      recipientType: "agent",
      recipientUuid: AGENT_UUID,
      pinnedHost: PINNED_HOST,
      pinnedCwd: PINNED_CWD,
    });
  });

  it("an UN-PINNED mention threads no pin (both undefined) → wake stays agent-overall online-first", async () => {
    // The whole point of the additive design: an un-pinned token carries no pin,
    // so resolvePinnedTarget(mentioned) gets pinnedHost/pinnedCwd === undefined →
    // makePinnedTarget returns null → selectOriginConnection falls to online-first
    // (no specific instance). This is the "yields no instance" half of the AC.
    await mentionAgentWith(null, null);

    const params = notifiedParams();
    expect(params.action).toBe("mentioned");
    // No pin → both undefined (parseMentions omits the keys; createMentions reads
    // mention.pinnedHost/pinnedCwd which are absent on an un-pinned ref).
    expect(params.pinnedHost).toBeUndefined();
    expect(params.pinnedCwd).toBeUndefined();
  });

  it("threads an unknown-PATH pin (host pinned, cwd null) — the legacy null-cwd instance is still addressable", async () => {
    // host="prod", cwd unknown (null): the codec writes cwd= (empty) so the
    // decoder yields pinnedCwd:null, and that null IS the registry's unknown-path
    // sentinel (matched verbatim by resolveInstanceByTuple / selectOriginConnection).
    await mentionAgentWith(PINNED_HOST, null);

    const params = notifiedParams();
    expect(params.pinnedHost).toBe(PINNED_HOST);
    expect(params.pinnedCwd).toBeNull();
  });

  it("threads an unknown-HOST pin (host '' sentinel, cwd pinned)", async () => {
    // host="" (unknown-host sentinel), cwd="/work": both sentinels flow through
    // unchanged so the wake matches the host-less instance at /work.
    await mentionAgentWith("", PINNED_CWD);

    const params = notifiedParams();
    expect(params.pinnedHost).toBe("");
    expect(params.pinnedCwd).toBe(PINNED_CWD);
  });

  it("threads the pin per-recipient: only the pinned agent mention carries it, a co-mentioned user does not", async () => {
    const userUuid = "44444444-4444-4444-4444-444444444444";
    mockPrisma.user.findFirst.mockResolvedValue({ uuid: userUuid });
    mockPrisma.mention.createMany.mockResolvedValue({ count: 2 });

    const content =
      `${buildMentionMarker("Alice", "user", userUuid)} ` +
      `${buildMentionMarker("DevBot", "agent", AGENT_UUID, PINNED_HOST, PINNED_CWD)}`;
    await createMentions({
      companyUuid: COMPANY_UUID,
      sourceType: "comment",
      sourceUuid: SOURCE_UUID,
      content,
      actorType: "user",
      actorUuid: ACTOR_UUID,
      projectUuid: PROJECT_UUID,
      entityTitle: "Test Task",
    });

    const batch = mockCreateBatch.mock.calls[0][0] as Record<string, unknown>[];
    const agentP = batch.find((p) => p.recipientUuid === AGENT_UUID)!;
    const userP = batch.find((p) => p.recipientUuid === userUuid)!;
    // Agent carries the durable place; the user (no daemon) carries no pin.
    expect(agentP).toMatchObject({ pinnedHost: PINNED_HOST, pinnedCwd: PINNED_CWD });
    expect(userP.pinnedHost).toBeUndefined();
    expect(userP.pinnedCwd).toBeUndefined();
  });
});

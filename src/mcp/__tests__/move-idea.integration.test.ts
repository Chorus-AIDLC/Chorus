// src/mcp/__tests__/move-idea.integration.test.ts
//
// Integration test for the MCP path of the cross-project Idea cascade move.
//
// This is the MCP half of the three-surface checkpoint (task #5). It builds
// the shared `buildCascadeMoveFixture()` scenario, registers the MCP tool
// `chorus_move_idea` with a real `registerPmTools()` call against a fake
// McpServer, then drives the tool's handler exactly as a remote MCP client
// would. The handler calls `ideaService.moveIdea` against the in-memory
// store, so the assertion target is the parsed `moved` object the tool
// returns in its response text.
//
// The REST integration test in
// src/app/api/ideas/[uuid]/move/__tests__/integration.test.ts builds the
// same fixture and asserts the same `moved` object (byte-for-byte). Any
// divergence between the two would mean the surfaces report different
// counts for an identical pre-state — which is the exact bug this
// checkpoint is here to prevent.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  cascadeMoveStore,
  resetCascadeMoveStore,
  buildMockPrisma,
  buildActivityServiceMock,
  buildCascadeMoveFixture,
  COMPANY_UUID,
} from "@/__tests__/fixtures/cascadeMoveFixture";

// vi.mock factories are hoisted, so anything they reference must come from
// vi.hoisted(). The hoisted refs start null and pick up the real mock
// objects below (top-level execution still happens before any module's
// service body runs).
const { hoistedPrisma, hoistedActivity } = vi.hoisted(() => ({
  hoistedPrisma: { current: null as unknown },
  hoistedActivity: { current: null as unknown },
}));

const mockPrisma = buildMockPrisma();
const mockActivityService = buildActivityServiceMock(COMPANY_UUID);
hoistedPrisma.current = mockPrisma;
hoistedActivity.current = mockActivityService;

// ===== Module mocks =====

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return hoistedPrisma.current;
  },
}));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn() } }));
vi.mock("@/lib/uuid-resolver", () => ({
  formatAssigneeComplete: vi.fn().mockResolvedValue(null),
  formatCreatedBy: vi.fn().mockResolvedValue({ type: "user", uuid: "creator", name: "Creator" }),
}));
vi.mock("@/services/mention.service", () => ({
  parseMentions: vi.fn().mockReturnValue([]),
  createMentions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/activity.service", () => ({
  // The shared activity-service mock pushes to cascadeMoveStore.activities
  // every time moveIdea emits the "moved" event. We expose every named
  // export the tool module imports as a wildcard import — only
  // createActivity is actually called by moveIdea.
  get createActivity() {
    return (hoistedActivity.current as { createActivity: unknown }).createActivity;
  },
}));

// Other unrelated services pulled in by the PM tools module — no-op stubs
// keep registration of the move tool inert wrt those tools' service deps.
vi.mock("@/services/project.service", () => ({ projectExists: vi.fn() }));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/agent.service", () => ({ getAgentByUuid: vi.fn() }));

// ===== Drive the MCP handler =====
//
// `registerPmTools(server, auth)` wires every PM tool, including
// `chorus_move_idea`, by calling server.registerTool(name, meta, handler).
// We stand up a minimal fake McpServer that records the handler keyed by
// name, then invoke the move handler directly with the fixture's
// (ideaUuid, targetProjectUuid). This exercises:
//   1. The permission gate (registerPermissionedTool — auth.permissions
//      must include "idea:write" for the tool to be registered at all).
//   2. The tool body (calls ideaService.moveIdea against the in-memory store).
//   3. The response shape (a JSON-stringified { uuid, project, moved } —
//      we parse the text and compare `moved` to the fixture's expected
//      counts).

import type { AgentAuthContext } from "@/types/auth";
import { registerPmTools } from "@/mcp/tools/pm";

type ToolHandler = (
  params: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const toolHandlers: Record<string, ToolHandler> = {};

const fakeMcpServer = {
  registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
    toolHandlers[name] = handler;
  },
};

function buildPmAgentAuth(): AgentAuthContext {
  return {
    type: "agent",
    companyUuid: COMPANY_UUID,
    actorUuid: "20000000-0000-4000-8000-000000000aaa",
    ownerUuid: "20000000-0000-4000-8000-000000000bbb",
    roles: ["pm_agent"],
    // pm_agent's effective set includes idea:write — that's what gates
    // chorus_move_idea via registerPermissionedTool. We list a minimal
    // set here; only "idea:write" is needed for the move tool itself.
    permissions: ["idea:read", "idea:write"] as AgentAuthContext["permissions"],
    agentName: "test-pm",
  };
}

function registerWith(auth: AgentAuthContext) {
  for (const k of Object.keys(toolHandlers)) delete toolHandlers[k];
  registerPmTools(
    fakeMcpServer as unknown as Parameters<typeof registerPmTools>[0],
    auth,
  );
}

beforeEach(() => {
  resetCascadeMoveStore();
});

describe("MCP chorus_move_idea — integration with shared cascade-move fixture", () => {
  it("returns moved counts that match the shared fixture's expectedMoved", async () => {
    const fixture = buildCascadeMoveFixture();
    registerWith(buildPmAgentAuth());

    const handler = toolHandlers["chorus_move_idea"];
    expect(handler).toBeDefined();

    const result = await handler({
      ideaUuid: fixture.ideaUuid,
      targetProjectUuid: fixture.toProjectUuid,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    // The handler returns a JSON-stringified { uuid, project, moved } payload.
    const parsed = JSON.parse(result.content[0].text) as {
      uuid: string;
      project: { uuid: string; name: string };
      moved: { proposals: number; documents: number; tasks: number; activities: number };
    };

    // Identity of the moved Idea + new project.
    expect(parsed.uuid).toBe(fixture.ideaUuid);
    expect(parsed.project.uuid).toBe(fixture.toProjectUuid);

    // Counts: this is the load-bearing assertion for the cross-surface
    // checkpoint. The REST integration test asserts the same shape.
    expect(parsed.moved).toEqual({ ideas: 1, proposals: 1, documents: 1, tasks: 3, activities: 5 });
    expect(parsed.moved).toEqual(fixture.expectedMoved);

    // Sanity: the fixture's primary entities are now on P_NEW…
    expect(cascadeMoveStore.ideas.find((i) => i.uuid === fixture.ideaUuid)?.projectUuid).toBe(
      fixture.toProjectUuid,
    );
    expect(cascadeMoveStore.proposals.find((p) => p.uuid === fixture.proposalUuid)?.projectUuid).toBe(
      fixture.toProjectUuid,
    );
    expect(cascadeMoveStore.documents.find((d) => d.uuid === fixture.documentUuid)?.projectUuid).toBe(
      fixture.toProjectUuid,
    );
    for (const t of fixture.taskUuids) {
      expect(cascadeMoveStore.tasks.find((tk) => tk.uuid === t)?.projectUuid).toBe(fixture.toProjectUuid);
    }

    // …while the sibling Idea + its resources stay on P_OLD.
    expect(cascadeMoveStore.ideas.find((i) => i.uuid === fixture.siblingIdeaUuid)?.projectUuid).toBe(
      fixture.fromProjectUuid,
    );
    expect(
      cascadeMoveStore.proposals.find((p) => p.uuid === fixture.siblingProposalUuid)?.projectUuid,
    ).toBe(fixture.fromProjectUuid);
    expect(
      cascadeMoveStore.documents.find((d) => d.uuid === fixture.siblingDocumentUuid)?.projectUuid,
    ).toBe(fixture.fromProjectUuid);
    expect(cascadeMoveStore.tasks.find((tk) => tk.uuid === fixture.siblingTaskUuid)?.projectUuid).toBe(
      fixture.fromProjectUuid,
    );
  });

  it("does NOT register chorus_move_idea for an agent without idea:write", () => {
    registerWith({
      type: "agent",
      companyUuid: COMPANY_UUID,
      actorUuid: "20000000-0000-4000-8000-000000000ccc",
      ownerUuid: "20000000-0000-4000-8000-000000000ddd",
      roles: ["developer_agent"],
      permissions: ["idea:read"] as AgentAuthContext["permissions"],
      agentName: "no-write-agent",
    });

    // The tool isn't even registered when the gate fails — the client never
    // sees it in tool listings. This is the spec-mandated permission UX.
    expect(toolHandlers["chorus_move_idea"]).toBeUndefined();
  });
});

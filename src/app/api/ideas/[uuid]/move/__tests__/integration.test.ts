// src/app/api/ideas/[uuid]/move/__tests__/integration.test.ts
//
// REST integration test for the cross-project Idea cascade move.
//
// This is the REST half of the three-surface checkpoint (task #5). It builds
// the shared `buildCascadeMoveFixture()` scenario and drives the actual
// `PATCH /api/ideas/[uuid]/move` route handler against the in-memory store.
// The assertion target is the JSON `data.moved` field in the response — its
// shape MUST equal the MCP integration test's parsed `moved` and the
// fixture's `expectedMoved`.
//
// The narrow route.test.ts file in this same directory mocks the service
// layer and stops at the route's contract; this file goes one layer deeper
// and lets the real `moveIdea` service run against the shared in-memory
// store, so it actually exercises the cascade end-to-end.
//
// Sibling-isolation assertion: the fixture seeds a second Idea S in the same
// project P_OLD with its own approved proposal + document + task. After
// `PATCH .../move`, S's resources MUST stay on P_OLD — proving the cascade
// scopes by `inputUuids` not by project membership.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import {
  cascadeMoveStore,
  resetCascadeMoveStore,
  buildMockPrisma,
  buildActivityServiceMock,
  buildCascadeMoveFixture,
  COMPANY_UUID,
} from "@/__tests__/fixtures/cascadeMoveFixture";

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
  get createActivity() {
    return (hoistedActivity.current as { createActivity: unknown }).createActivity;
  },
}));

// Override `getAuthContext` so the route's auth gate passes with a synthetic
// human-user context for the fixture's company. The rest of @/lib/auth
// (checkAgentPermission etc.) is left intact — humans bypass the agent
// permission check, so the route reaches the service call.
const ACTOR_USER = "60000000-0000-4000-8000-000000000001";
const mockGetAuthContext = vi.fn().mockResolvedValue({
  type: "user",
  companyUuid: COMPANY_UUID,
  actorUuid: ACTOR_USER,
});
vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  };
});

import { PATCH } from "@/app/api/ideas/[uuid]/move/route";

function jsonRequest(ideaUuid: string, body: unknown) {
  return new NextRequest(new URL(`/api/ideas/${ideaUuid}/move`, "http://localhost:3000"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetCascadeMoveStore();
});

describe("PATCH /api/ideas/[uuid]/move — REST integration with shared fixture", () => {
  it("returns moved counts matching the MCP path's counts and the fixture's expectedMoved", async () => {
    const fixture = buildCascadeMoveFixture();

    const res = await PATCH(jsonRequest(fixture.ideaUuid, { targetProjectUuid: fixture.toProjectUuid }), {
      params: Promise.resolve({ uuid: fixture.ideaUuid }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    // Load-bearing assertion: equal to what the MCP test asserts and to
    // the fixture's stated expected counts.
    expect(body.data.moved).toEqual({ proposals: 1, documents: 1, tasks: 3, activities: 5 });
    expect(body.data.moved).toEqual(fixture.expectedMoved);

    // Sanity: the response identifies the moved Idea on the new project.
    expect(body.data.uuid).toBe(fixture.ideaUuid);
    expect(body.data.project.uuid).toBe(fixture.toProjectUuid);

    // The primary entities are now on P_NEW.
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
  });

  it("leaves the sibling Idea's proposals/documents/tasks untouched (cross-fixture isolation)", async () => {
    const fixture = buildCascadeMoveFixture();

    const res = await PATCH(jsonRequest(fixture.ideaUuid, { targetProjectUuid: fixture.toProjectUuid }), {
      params: Promise.resolve({ uuid: fixture.ideaUuid }),
    });
    expect(res.status).toBe(200);

    // The sibling Idea + its proposal + document + task were seeded in
    // P_OLD. The cascade is scoped by inputUuids, so the sibling row's
    // graph (which references SIBLING_IDEA_UUID, not the moved fixture
    // idea) must remain on P_OLD.
    expect(cascadeMoveStore.ideas.find((i) => i.uuid === fixture.siblingIdeaUuid)?.projectUuid).toBe(
      fixture.siblingSnapshot.ideaProjectUuid,
    );
    expect(
      cascadeMoveStore.proposals.find((p) => p.uuid === fixture.siblingProposalUuid)?.projectUuid,
    ).toBe(fixture.siblingSnapshot.proposalProjectUuid);
    expect(
      cascadeMoveStore.documents.find((d) => d.uuid === fixture.siblingDocumentUuid)?.projectUuid,
    ).toBe(fixture.siblingSnapshot.documentProjectUuid);
    expect(cascadeMoveStore.tasks.find((tk) => tk.uuid === fixture.siblingTaskUuid)?.projectUuid).toBe(
      fixture.siblingSnapshot.taskProjectUuid,
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Integration test for the container-idea rollup in the checkin/assignments
// idea tracker. Unlike idea-tracker.service.test.ts (which mocks the rollup
// source to test the seam in isolation), this mocks ONLY prisma and drives the
// REAL buildIdeaTracker + getIdeasWithDerivedStatus together — proving the two
// halves actually compose: a container whose children are all done is dropped.

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    idea: { findMany: vi.fn(), groupBy: vi.fn() },
    proposal: { findMany: vi.fn() },
    task: { findMany: vi.fn() },
    project: { findMany: vi.fn() },
    agentInstance: { findMany: vi.fn() },
    referenceArtifact: { groupBy: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { buildIdeaTracker } from "@/services/idea-tracker.service";
import type { AuthContext } from "@/types/auth";

const COMPANY = "company-1111-1111-1111-111111111111";
const AGENT = "agent-2222-2222-2222-222222222222";
const PROJECT = "project-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONTAINER = "idea-container-cccc-cccc-cccccccccccc";
const now = new Date("2026-05-01T10:00:00Z");

const agentAuth: AuthContext = {
  type: "agent",
  companyUuid: COMPANY,
  actorUuid: AGENT,
  roles: ["developer_agent"],
};

/**
 * Seed prisma so that:
 *   - the agent is assigned exactly the container idea (tracker Q1),
 *   - the project holds the container + N children with the given child derived
 *     statuses (board Q1), each child's status driven by its own proposal/tasks.
 *
 * `childDone` children get an approved proposal with all tasks done → derived
 * "done"; the rest are left "open" → derived "todo".
 */
function seed(childCount: number, childDone: number) {
  const children = Array.from({ length: childCount }, (_, i) => ({
    uuid: `child-${i}`,
    title: `Child ${i}`,
    status: i < childDone ? "elaborated" : "open",
    elaborationStatus: i < childDone ? "resolved" : null,
    parentUuid: CONTAINER,
    isContainer: false,
    projectUuid: PROJECT,
    createdAt: now,
    updatedAt: now,
  }));

  const container = {
    uuid: CONTAINER,
    title: "Theme",
    status: "elaborated",
    elaborationStatus: "resolved",
    parentUuid: null,
    isContainer: true,
    projectUuid: PROJECT,
    createdAt: now,
    updatedAt: now,
  };

  // idea.findMany is called by BOTH functions. Tracker Q1 carries where.OR
  // (assignee match) and returns only the agent's plate (the container). The
  // board query has no OR and returns every idea in the project.
  mockPrisma.idea.findMany.mockImplementation(async (args: { where?: { OR?: unknown } }) => {
    if (args?.where?.OR) return [container];
    return [container, ...children];
  });

  mockPrisma.idea.groupBy.mockResolvedValue([
    { parentUuid: CONTAINER, _count: { _all: childCount } },
  ]);

  // One approved proposal per done child. proposal.findMany is called by both;
  // the same rows satisfy each (board filters in-memory by inputUuids overlap).
  const proposals = Array.from({ length: childDone }, (_, i) => ({
    uuid: `p-${i}`,
    projectUuid: PROJECT,
    status: "approved",
    inputType: "idea",
    inputUuids: [`child-${i}`],
    createdAt: now,
  }));
  mockPrisma.proposal.findMany.mockResolvedValue(proposals);

  // Every task on those proposals is done.
  const tasks = proposals.map((p) => ({ proposalUuid: p.uuid, status: "done" }));
  mockPrisma.task.findMany.mockResolvedValue(tasks);

  mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT, name: "A" }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.agentInstance.findMany.mockResolvedValue([]);
  // Reference-count batching (Thread B) — default to none so the container
  // rollup assertions are unaffected. clearAllMocks wipes the impl, so re-set.
  mockPrisma.referenceArtifact.groupBy.mockResolvedValue([]);
});

describe("buildIdeaTracker container rollup (real getIdeasWithDerivedStatus)", () => {
  it("drops a container whose children are ALL done", async () => {
    seed(3, 3);
    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker).toEqual({});
  });

  it("keeps a container with a mix of done and not-done children, marked in_progress", async () => {
    seed(3, 1);
    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT].ideas.map((i) => i.uuid)).toEqual([CONTAINER]);
    expect(tracker[PROJECT].ideas[0].status).toBe("in_progress");
  });

  it("keeps a container whose children are ALL todo, marked todo", async () => {
    seed(3, 0);
    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT].ideas.map((i) => i.uuid)).toEqual([CONTAINER]);
    expect(tracker[PROJECT].ideas[0].status).toBe("todo");
  });

  it("keeps a childless container (no rollup to override its own status)", async () => {
    seed(0, 0);
    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT].ideas.map((i) => i.uuid)).toEqual([CONTAINER]);
  });
});

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAuthContext } from "@/types/auth";

const mocks = vi.hoisted(() => ({ agent: vi.fn(), distribution: vi.fn(), team: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { agent: { update: mocks.agent } } }));
vi.mock("@/services/idea-tracker.service", () => ({ buildActiveProjectDistribution: mocks.distribution }));
vi.mock("@/services/notification.service", () => ({ list: vi.fn(async () => ({ notifications: [], unreadCount: 0 })), emitAgentCheckin: vi.fn() }));
vi.mock("@/services/project-agent-team.service", () => ({
  getProjectAgentTeam: mocks.team,
  ProjectTeamError: class extends Error { constructor(public code: string, message: string) { super(message); } },
}));
import { buildCheckinResponse } from "../checkin.service";
import { ProjectTeamError } from "../project-agent-team.service";

const active = randomUUID();
const scoped = randomUUID();
const hidden = randomUUID();
const auth: AgentAuthContext = { type: "agent", companyUuid: randomUUID(), actorUuid: randomUUID(), ownerUuid: randomUUID(), roles: ["admin"], permissions: ["project:read"], agentName: "Agent" };
const agent = () => ({ uuid: auth.actorUuid, name: "Agent", roles: ["admin"], permissions: [], ownerUuid: auth.ownerUuid, owner: null, persona: null, systemPrompt: null });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agent.mockResolvedValue(agent());
  mocks.distribution.mockResolvedValue({ [active]: { name: "Active", activeIdeaCount: 3 } });
  mocks.team.mockResolvedValue(null);
});

describe("checkin private project Team context", () => {
  it("deduplicates active and request-scoped projects without changing counts", async () => {
    const team = { myRoles: ["lead"], roles: { lead: [{ agentUuid: auth.actorUuid, eligible: true, online: true, activeCount: 2 }] } };
    mocks.team.mockImplementation(async (_auth, projectUuid) => projectUuid === active ? team : null);
    const result = await buildCheckinResponse({ ...auth, projectUuids: [scoped, active] } as AgentAuthContext);
    expect(result.activeProjects).toEqual({ [active]: { name: "Active", activeIdeaCount: 3 } });
    expect(result.projectTeams).toEqual({ [active]: team, [scoped]: null });
    expect(mocks.team).toHaveBeenCalledTimes(2);
    expect(mocks.team).toHaveBeenCalledWith(expect.objectContaining({ ownerUuid: auth.ownerUuid }), active);
  });

  it("omits inaccessible scoped projects rather than leaking identifiers or aborting checkin", async () => {
    mocks.team.mockImplementation(async (_auth, projectUuid) => { if (projectUuid === hidden) throw new ProjectTeamError("NOT_FOUND", "Project not found"); return null; });
    const result = await buildCheckinResponse({ ...auth, projectUuids: [hidden] } as AgentAuthContext);
    expect(result.projectTeams).toEqual({ [active]: null });
  });

  it("returns empty context for a genuinely ownerless agent", async () => {
    mocks.agent.mockResolvedValue({ ...agent(), ownerUuid: null });
    expect((await buildCheckinResponse(auth)).projectTeams).toEqual({});
    expect(mocks.team).not.toHaveBeenCalled();
  });

  it("does not return Team data without current project:read permission", async () => {
    mocks.agent.mockResolvedValue({ ...agent(), roles: [], permissions: ["task:write"] });
    expect((await buildCheckinResponse(auth)).projectTeams).toEqual({});
    expect(mocks.team).not.toHaveBeenCalled();
  });

  it("uses current persisted owner, never a stale authentication owner", async () => {
    const currentOwner = randomUUID();
    mocks.agent.mockResolvedValue({ ...agent(), ownerUuid: currentOwner });
    await buildCheckinResponse(auth);
    expect(mocks.team).toHaveBeenCalledWith(expect.objectContaining({ ownerUuid: currentOwner }), active);
  });

  it("does not hide unexpected storage errors", async () => {
    mocks.team.mockRejectedValue(new Error("database unavailable"));
    await expect(buildCheckinResponse(auth)).rejects.toThrow("database unavailable");
  });
});

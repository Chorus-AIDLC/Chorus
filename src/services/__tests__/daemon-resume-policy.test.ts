import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execution: vi.fn(), connection: vi.fn(), session: vi.fn(), idea: vi.fn(), task: vi.fn(), proposalSources: vi.fn(), documentSources: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  daemonExecution: { findFirst: mocks.execution }, daemonConnection: { findFirst: mocks.connection },
  daemonSession: { findFirst: mocks.session }, idea: { findFirst: mocks.idea }, task: { findFirst: mocks.task },
} }));
vi.mock("../idea-team.service", () => ({ getProposalTeamIdeaUuids: mocks.proposalSources, resolveIdeaTeamInputs: mocks.documentSources }));
import { requiresFencedIdeaTeamResume } from "../daemon-resume-policy";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.connection.mockResolvedValue({ agentUuid: "agent" });
  mocks.proposalSources.mockResolvedValue([]);
  mocks.documentSources.mockResolvedValue([]);
});

describe("turnless resume policy", () => {
  it.each(["request", "execution", "session"])("detects managed work from the %s anchor independently", async (source) => {
    if (source === "execution") mocks.execution.mockResolvedValue({ directIdeaUuid: "idea" });
    if (source === "session") mocks.session.mockResolvedValue({ directIdeaUuid: "idea", sessionId: "idea" });
    mocks.idea.mockResolvedValueOnce(null).mockResolvedValue({ uuid: "idea" });
    expect(await requiresFencedIdeaTeamResume("company", "connection", source === "request" ? "idea" : "daemon_session", "idea")).toBe(true);
    expect(mocks.idea).toHaveBeenCalledWith({ where: {
      companyUuid: "company", uuid: { in: ["idea"] }, teamEnrollmentVersion: 1,
      OR: [{ teamOwnerUuid: { not: null } }, { teamLeadAgentUuid: { not: null } }],
    }, select: { uuid: true } });
  });

  it.each(["proposal", "task", "document"])("checks every %s source, not just a first root", async (entityType) => {
    mocks.task.mockResolvedValue({ proposalUuid: "proposal" });
    mocks.proposalSources.mockResolvedValue(["first", "second"]);
    mocks.documentSources.mockResolvedValue(["first", "second"]);
    mocks.idea.mockResolvedValueOnce(null).mockResolvedValue({ uuid: "second" });
    expect(await requiresFencedIdeaTeamResume("company", "connection", entityType, "resource")).toBe(true);
    expect(mocks.idea.mock.calls.at(-1)![0].where.uuid.in).toEqual(["first", "second"]);
  });

  it("allows legacy/unmanaged continuation without manufacturing a fence", async () => {
    mocks.idea.mockResolvedValue(null);
    expect(await requiresFencedIdeaTeamResume("company", "connection", "idea", "legacy")).toBe(false);
  });

  it.each(["idea", "daemon_session", "task", "proposal", "document"])("checks the business session key independently of the supplied %s label", async (entityType) => {
    mocks.idea.mockResolvedValue({ uuid: "managed" });
    expect(await requiresFencedIdeaTeamResume("company", "connection", entityType, "managed")).toBe(true);
    expect(mocks.idea).toHaveBeenCalledWith({ where: {
      companyUuid: "company", uuid: { in: ["managed"] }, teamEnrollmentVersion: 1,
      OR: [{ teamOwnerUuid: { not: null } }, { teamLeadAgentUuid: { not: null } }],
    }, select: { uuid: true } });
    expect(mocks.execution).not.toHaveBeenCalled();
  });

  it("does not turn an ancestry failure into an unfenced resume", async () => {
    mocks.proposalSources.mockRejectedValue(new Error("Missing ancestry"));
    await expect(requiresFencedIdeaTeamResume("company", "connection", "proposal", "missing")).rejects.toThrow("Missing ancestry");
  });
});

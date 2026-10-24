import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockHasPermission = vi.fn();
const mockAuthorizeConnectionControl = vi.fn();
const mockDispatchControl = vi.fn();
const mockResumeExecution = vi.fn();
const mockPublishExecutionChange = vi.fn();
const mockIsConnectionLive = vi.fn();
const mockResolveResourceOrchestrator = vi.fn();
const mockExecutionFindFirst = vi.fn();
const mockSessionFindFirst = vi.fn();
const mockConnectionFindFirst = vi.fn();
const mockCreateResumeTurn = vi.fn();
const mockRestoreInterruptedExecution = vi.fn();
const mockPriorTurnFindFirst = vi.fn();
const mockIdeaFindFirst = vi.fn();
const mockRequiresFencedResume = vi.fn();
vi.mock("@/services/daemon-resume-policy", () => ({ requiresFencedIdeaTeamResume: (...args: unknown[]) => mockRequiresFencedResume(...args) }));

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    daemonExecution: { findFirst: (...args: unknown[]) => mockExecutionFindFirst(...args) },
    daemonSession: { findFirst: (...args: unknown[]) => mockSessionFindFirst(...args) },
    daemonSessionTurn: { findFirst: (...args: unknown[]) => mockPriorTurnFindFirst(...args) },
    idea: { findFirst: (...args: unknown[]) => mockIdeaFindFirst(...args) },
    daemonConnection: { findFirst: (...args: unknown[]) => mockConnectionFindFirst(...args) },
  },
}));

vi.mock("@/services/daemon-session.service", () => ({
  createResumeTurn: (...args: unknown[]) => mockCreateResumeTurn(...args),
}));

vi.mock("@/services/daemon-control.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/services/daemon-control.service")>(),
  authorizeConnectionControl: (...args: unknown[]) => mockAuthorizeConnectionControl(...args),
  dispatchControl: (...args: unknown[]) => mockDispatchControl(...args),
}));

vi.mock("@/services/daemon-execution.service", () => ({
  resumeExecution: (...args: unknown[]) => mockResumeExecution(...args),
  restoreInterruptedExecution: (...args: unknown[]) => mockRestoreInterruptedExecution(...args),
  publishExecutionChange: (...args: unknown[]) => mockPublishExecutionChange(...args),
  isConnectionLive: (...args: unknown[]) => mockIsConnectionLive(...args),
}));

vi.mock("@/services/orchestrator.service", () => ({
  resolveResourceOrchestrator: (...args: unknown[]) =>
    mockResolveResourceOrchestrator(...args),
}));

import { POST } from "@/app/api/daemon/resume/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const t1 = "task-0000-0000-0000-000000000001";

const ownerUserAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
const emptyCtx = { params: Promise.resolve({}) };

const validBody = { connectionUuid, entityType: "task", entityUuid: t1 };

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/daemon/resume"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequiresFencedResume.mockResolvedValue(false);
  mockGetAuthContext.mockResolvedValue(ownerUserAuth);
  mockHasPermission.mockReturnValue(false);
  mockAuthorizeConnectionControl.mockResolvedValue({ ok: true, target: { agentUuid, ownerUuid } });
  mockResumeExecution.mockResolvedValue({ ok: true, resumedFrom: "user" });
  mockPublishExecutionChange.mockResolvedValue(undefined);
  mockIsConnectionLive.mockResolvedValue(true);
  mockResolveResourceOrchestrator.mockResolvedValue(null);
  mockExecutionFindFirst.mockResolvedValue(null);
  mockSessionFindFirst.mockResolvedValue(null);
  mockConnectionFindFirst.mockResolvedValue(null);
  mockCreateResumeTurn.mockResolvedValue({ uuid: "turn-resume" });
  mockRestoreInterruptedExecution.mockResolvedValue(undefined);
  mockPriorTurnFindFirst.mockResolvedValue(null);
  mockIdeaFindFirst.mockResolvedValue(null);
});

describe("POST /api/daemon/resume", () => {
  it("restores interruption when ancestry verification fails", async () => {
    mockRequiresFencedResume.mockRejectedValue(new Error("Missing ancestry"));
    expect((await POST(postRequest(validBody), emptyCtx)).status).toBe(409);
    expect(mockRestoreInterruptedExecution).toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });
  it("rejects ancestry-managed work when execution and session have lost their anchors", async () => {
    mockRequiresFencedResume.mockResolvedValue(true);
    expect((await POST(postRequest(validBody), emptyCtx)).status).toBe(409);
    expect(mockRestoreInterruptedExecution).toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });
  it.each(["codex", "claude_code", "openclaw", "hermes"])("rejects a missing session for a managed execution on %s", async (clientType) => {
    mockExecutionFindFirst.mockResolvedValue({ uuid: "exec-v1", directIdeaUuid: "idea-v1" });
    mockConnectionFindFirst.mockResolvedValue({ clientType });
    mockIdeaFindFirst.mockResolvedValue({ teamEnrollmentVersion: 1, teamOwnerUuid: ownerUuid, teamLeadAgentUuid: agentUuid });
    expect((await POST(postRequest({ connectionUuid, entityType: "idea", entityUuid: "idea-v1" }), emptyCtx)).status).toBe(409);
    expect(mockIdeaFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { uuid: "idea-v1", companyUuid } }));
    expect(mockCreateResumeTurn).not.toHaveBeenCalled();
    expect(mockRestoreInterruptedExecution).toHaveBeenCalledWith(companyUuid, connectionUuid, "idea", "idea-v1", "user");
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it.each([null, "other-idea"])("rejects missing or conflicting managed session anchor %s", async (directIdeaUuid) => {
    mockExecutionFindFirst.mockResolvedValue({ uuid: "exec-v1", directIdeaUuid: "idea-v1" });
    mockSessionFindFirst.mockResolvedValue({ uuid: "session-v1", directIdeaUuid });
    mockConnectionFindFirst.mockResolvedValue({ clientType: "codex" });
    mockIdeaFindFirst.mockImplementation(async ({ where }: { where: { uuid: string } }) => where.uuid === "idea-v1" ? { teamEnrollmentVersion: 1, teamOwnerUuid: ownerUuid, teamLeadAgentUuid: agentUuid } : null);
    expect((await POST(postRequest({ connectionUuid, entityType: "idea", entityUuid: "idea-v1" }), emptyCtx)).status).toBe(409);
    expect(mockCreateResumeTurn).not.toHaveBeenCalled();
    expect(mockRestoreInterruptedExecution).toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("uses the direct Idea request anchor even when execution metadata is absent", async () => {
    mockConnectionFindFirst.mockResolvedValue({ clientType: "codex" });
    mockIdeaFindFirst.mockResolvedValue({ teamEnrollmentVersion: 1, teamOwnerUuid: ownerUuid, teamLeadAgentUuid: agentUuid });
    expect((await POST(postRequest({ connectionUuid, entityType: "idea", entityUuid: "idea-v1" }), emptyCtx)).status).toBe(409);
    expect(mockRestoreInterruptedExecution).toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude_code", "openclaw"])("requires a fenced continuation for a new enrolled Idea on %s", async (clientType) => {
    mockExecutionFindFirst.mockResolvedValue({ uuid: "exec-1", directIdeaUuid: "idea-1" });
    mockSessionFindFirst.mockResolvedValue({ uuid: "session-1", directIdeaUuid: "idea-1" });
    mockConnectionFindFirst.mockResolvedValue({ clientType });
    mockIdeaFindFirst.mockResolvedValue({ teamEnrollmentVersion: 1, teamOwnerUuid: ownerUuid, teamLeadAgentUuid: agentUuid });
    mockCreateResumeTurn.mockRejectedValue(new Error("Stale generation"));
    expect((await POST(postRequest(validBody), emptyCtx)).status).toBe(409);
    expect(mockCreateResumeTurn).toHaveBeenCalled();
    expect(mockRestoreInterruptedExecution).toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });
  it("rejects an unauthenticated request (401)", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockResumeExecution).not.toHaveBeenCalled();
  });

  it("rejects a malformed body at the zod boundary (422)", async () => {
    const res = await POST(postRequest({ connectionUuid }), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockAuthorizeConnectionControl).not.toHaveBeenCalled();
  });

  it("resumes a user-interrupted row, dispatches a resume control command, and publishes", async () => {
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(200);
    expect(mockResumeExecution).toHaveBeenCalledWith(companyUuid, connectionUuid, "task", t1);
    // The daemon is told to re-spawn via the SAME control channel as interrupt, with
    // the prior reason threaded through so it can branch the continue instruction.
    expect(mockDispatchControl).toHaveBeenCalledWith({
      companyUuid,
      targetConnectionUuid: connectionUuid,
      command: "resume",
      entityType: "task",
      entityUuid: t1,
      resumeReason: "user",
      orchestrator: null,
    });
    expect(mockPublishExecutionChange).toHaveBeenCalledWith(companyUuid, connectionUuid);
  });

  it("resumes a crash-interrupted row and forwards resumeReason=crash (add-crash-execution-resume)", async () => {
    mockResumeExecution.mockResolvedValue({ ok: true, resumedFrom: "crash" });
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(200);
    expect(mockDispatchControl).toHaveBeenCalledWith({
      companyUuid,
      targetConnectionUuid: connectionUuid,
      command: "resume",
      entityType: "task",
      entityUuid: t1,
      resumeReason: "crash",
      orchestrator: null,
    });
    expect(mockPublishExecutionChange).toHaveBeenCalledWith(companyUuid, connectionUuid);
  });

  it("resolves and forwards the Task's current agent orchestrator", async () => {
    const orchestrator = {
      type: "agent",
      uuid: "agent-orchestrator",
      name: "Coordinator",
    };
    mockResolveResourceOrchestrator.mockResolvedValue(orchestrator);

    const res = await POST(postRequest(validBody), emptyCtx);

    expect(res.status).toBe(200);
    expect(mockResolveResourceOrchestrator).toHaveBeenCalledWith(
      companyUuid,
      "task",
      t1,
    );
    expect(mockDispatchControl).toHaveBeenCalledWith(
      expect.objectContaining({ orchestrator }),
    );
  });

  it("returns 404 non-disclosure for a connection the caller cannot control", async () => {
    mockAuthorizeConnectionControl.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(404);
    expect(mockResumeExecution).not.toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is neither owner nor task:admin", async () => {
    mockAuthorizeConnectionControl.mockResolvedValue({ ok: false, reason: "forbidden" });
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(403);
    expect(mockResumeExecution).not.toHaveBeenCalled();
  });

  it("rejects (400) when the target daemon is offline — leaves the row untouched, dispatches nothing", async () => {
    // A `resume` control command is a transient SSE event (no backfill replay); to an
    // offline daemon it would be dropped and the resume silently lost. The route must
    // refuse BEFORE mutating the row.
    mockIsConnectionLive.mockResolvedValue(false);
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(400);
    expect(mockResumeExecution).not.toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
    expect(mockPublishExecutionChange).not.toHaveBeenCalled();
  });

  it("returns 404 when there is no execution row to resume", async () => {
    mockResumeExecution.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(404);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("returns 400 for a not-resumable row (e.g. still running) and dispatches nothing", async () => {
    mockResumeExecution.mockResolvedValue({
      ok: false,
      reason: "not_resumable",
      status: "running",
      interruptedReason: null,
    });
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(400);
    expect(mockDispatchControl).not.toHaveBeenCalled();
    expect(mockPublishExecutionChange).not.toHaveBeenCalled();
  });

  describe("continuation turn for turn-gated clients (B4-resume-without-pending-turn)", () => {
    beforeEach(() => {
      mockExecutionFindFirst.mockResolvedValue({ uuid: "exec-1", directIdeaUuid: "idea-1" });
      mockSessionFindFirst.mockResolvedValue({ uuid: "session-1", runtimeCwd: null });
    });

    it.each(["hermes", "openclaw"])("creates a resume turn linked to the execution for %s and dispatches its uuid", async (clientType) => {
      mockConnectionFindFirst.mockResolvedValue({ clientType });
      const res = await POST(postRequest(validBody), emptyCtx);
      expect(res.status).toBe(200);
      expect(mockCreateResumeTurn).toHaveBeenCalledWith({
        sessionUuid: "session-1", executionUuid: "exec-1", resumedFrom: "user",
      });
      expect(mockDispatchControl).toHaveBeenCalledWith(
        expect.objectContaining({ command: "resume", turnUuid: "turn-resume" }),
      );
    });

    it("leaves the daemon resume unchanged: no turn is created and none is dispatched", async () => {
      mockConnectionFindFirst.mockResolvedValue({ clientType: "claude_code" });
      const res = await POST(postRequest(validBody), emptyCtx);
      expect(res.status).toBe(200);
      expect(mockCreateResumeTurn).not.toHaveBeenCalled();
      expect(mockDispatchControl.mock.calls[0][0]).not.toHaveProperty("turnUuid");
    });

    it.each(["hermes", "openclaw"])("undoes the %s resume and dispatches nothing when the turn cannot be created", async (clientType) => {
      mockConnectionFindFirst.mockResolvedValue({ clientType });
      mockResumeExecution.mockResolvedValue({ ok: true, resumedFrom: "crash" });
      mockCreateResumeTurn.mockRejectedValue(new Error("db down"));
      const res = await POST(postRequest(validBody), emptyCtx);
      expect(res.status).toBe(409);
      expect(mockRestoreInterruptedExecution).toHaveBeenCalledWith(companyUuid, connectionUuid, "task", t1, "crash");
      expect(mockDispatchControl).not.toHaveBeenCalled();
      expect(mockPublishExecutionChange).toHaveBeenCalledWith(companyUuid, connectionUuid);
    });

    it.each(["hermes", "openclaw"])("undoes the %s resume when the session cannot be found", async (clientType) => {
      mockConnectionFindFirst.mockResolvedValue({ clientType });
      mockSessionFindFirst.mockResolvedValue(null);
      const res = await POST(postRequest(validBody), emptyCtx);
      expect(res.status).toBe(409);
      expect(mockCreateResumeTurn).not.toHaveBeenCalled();
      expect(mockRestoreInterruptedExecution).toHaveBeenCalled();
      expect(mockDispatchControl).not.toHaveBeenCalled();
    });
  });
});

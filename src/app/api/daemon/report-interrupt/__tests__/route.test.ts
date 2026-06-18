import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockHasPermission = vi.fn();
const mockAuthorizeConnectionControl = vi.fn();
const mockReportExecutionInterrupt = vi.fn();
const mockPublishExecutionChange = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

vi.mock("@/services/daemon-control.service", () => ({
  CONTROL_ENTITY_TYPES: ["task", "idea", "proposal", "document"],
  authorizeConnectionControl: (...args: unknown[]) => mockAuthorizeConnectionControl(...args),
}));

vi.mock("@/services/daemon-execution.service", () => ({
  INTERRUPT_REASONS: ["user", "crash"],
  reportExecutionInterrupt: (...args: unknown[]) => mockReportExecutionInterrupt(...args),
  publishExecutionChange: (...args: unknown[]) => mockPublishExecutionChange(...args),
}));

import { POST } from "@/app/api/daemon/report-interrupt/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const t1 = "task-0000-0000-0000-000000000001";

const agentAuth = { type: "agent", companyUuid, actorUuid: agentUuid, permissions: [] };
const emptyCtx = { params: Promise.resolve({}) };

const validBody = { connectionUuid, entityType: "task", entityUuid: t1, reason: "user" };

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/daemon/report-interrupt"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(agentAuth);
  mockHasPermission.mockReturnValue(false);
  mockAuthorizeConnectionControl.mockResolvedValue({ ok: true, target: { agentUuid, ownerUuid } });
  mockReportExecutionInterrupt.mockResolvedValue(true);
  mockPublishExecutionChange.mockResolvedValue(undefined);
});

describe("POST /api/daemon/report-interrupt", () => {
  it("rejects an unauthenticated request (401), records nothing", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockReportExecutionInterrupt).not.toHaveBeenCalled();
  });

  it("rejects a bad reason at the zod boundary (422), records nothing", async () => {
    const res = await POST(postRequest({ ...validBody, reason: "bogus" }), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockAuthorizeConnectionControl).not.toHaveBeenCalled();
    expect(mockReportExecutionInterrupt).not.toHaveBeenCalled();
  });

  it("records reason=user on the execution row and publishes the change (authorized)", async () => {
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(200);
    expect(mockReportExecutionInterrupt).toHaveBeenCalledWith(
      companyUuid,
      connectionUuid,
      "task",
      t1,
      "user",
    );
    expect(mockPublishExecutionChange).toHaveBeenCalledWith(companyUuid, connectionUuid);
  });

  it("records reason=crash too (entity-generic: an idea wake)", async () => {
    const res = await POST(
      postRequest({ connectionUuid, entityType: "idea", entityUuid: "idea-1", reason: "crash" }),
      emptyCtx,
    );
    expect(res.status).toBe(200);
    expect(mockReportExecutionInterrupt).toHaveBeenCalledWith(
      companyUuid,
      connectionUuid,
      "idea",
      "idea-1",
      "crash",
    );
  });

  it("returns 404 non-disclosure for a connection the caller cannot control", async () => {
    mockAuthorizeConnectionControl.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(404);
    expect(mockReportExecutionInterrupt).not.toHaveBeenCalled();
    expect(mockPublishExecutionChange).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is neither owner nor task:admin", async () => {
    mockAuthorizeConnectionControl.mockResolvedValue({ ok: false, reason: "forbidden" });
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(403);
    expect(mockReportExecutionInterrupt).not.toHaveBeenCalled();
  });

  it("returns 404 when no active execution row matches (wake already ended)", async () => {
    mockReportExecutionInterrupt.mockResolvedValue(false);
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(404);
    expect(mockPublishExecutionChange).not.toHaveBeenCalled();
  });
});

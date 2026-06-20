import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UserAuthContext } from "@/types/auth";

const mockGetServerAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: mockGetServerAuthContext,
}));

const mockVerifyElaboration = vi.hoisted(() => vi.fn());
vi.mock("@/services/elaboration.service", () => ({
  // Sibling actions in the same module import these; stub them so the module
  // loads without pulling in prisma transitively.
  getElaboration: vi.fn(),
  answerElaboration: vi.fn(),
  skipElaboration: vi.fn(),
  verifyElaboration: mockVerifyElaboration,
}));

const mockIdeaFindFirst = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({
  prisma: { idea: { findFirst: mockIdeaFindFirst } },
}));

const mockRevalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("@/lib/logger", () => {
  const noopLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => noopLogger),
  };
  return { default: noopLogger };
});

import { verifyElaborationAction } from "../elaboration-actions";

const COMPANY_UUID = "company-1111";
const IDEA_UUID = "idea-2222";
const PROJECT_UUID = "project-3333";

function userAuth(companyUuid = COMPANY_UUID): UserAuthContext {
  return {
    type: "user",
    companyUuid,
    actorUuid: "user-1",
    email: "u@test.com",
  };
}

describe("verifyElaborationAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns Unauthorized when there is no auth context", async () => {
    mockGetServerAuthContext.mockResolvedValue(null);

    const result = await verifyElaborationAction(IDEA_UUID);

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(mockVerifyElaboration).not.toHaveBeenCalled();
  });

  it("rejects an agent caller and never calls the service", async () => {
    // getServerAuthContext only ever returns a user context in production, but
    // the gate must defensively reject any non-user/non-super_admin actor type.
    mockGetServerAuthContext.mockResolvedValue({
      type: "agent",
      companyUuid: COMPANY_UUID,
      actorUuid: "agent-1",
    } as unknown as UserAuthContext);

    const result = await verifyElaborationAction(IDEA_UUID);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Only users can verify elaboration");
    expect(mockVerifyElaboration).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  // NOTE: the action's gate also allows `auth.type === "super_admin"` for
  // parity with sibling user-server-actions (e.g. criteria-actions.ts). That
  // branch is defensive-only: getServerAuthContext() is typed
  // `UserAuthContext | null` and only reads the OIDC / user_session cookies, so
  // production never yields a super_admin context here (and SuperAdminAuthContext
  // carries no companyUuid/actorUuid). We deliberately do NOT fabricate an
  // impossible super_admin shape to "prove" that path works end-to-end — the
  // user path below is the only reachable success path.

  it("succeeds for a user, passing companyUuid/actorUuid/actorType to the service and revalidating", async () => {
    mockGetServerAuthContext.mockResolvedValue(userAuth());
    mockVerifyElaboration.mockResolvedValue({ ideaUuid: IDEA_UUID, rounds: [] });
    mockIdeaFindFirst.mockResolvedValue({ uuid: IDEA_UUID, projectUuid: PROJECT_UUID });

    const result = await verifyElaborationAction(IDEA_UUID);

    expect(result).toEqual({ success: true, data: { ideaUuid: IDEA_UUID, rounds: [] } });
    expect(mockVerifyElaboration).toHaveBeenCalledWith({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
      actorUuid: "user-1",
      actorType: "user",
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/projects/${PROJECT_UUID}/ideas/${IDEA_UUID}`
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/projects/${PROJECT_UUID}/ideas`
    );
  });

  it("returns the underlying error message when the service throws (precondition failure)", async () => {
    mockGetServerAuthContext.mockResolvedValue(userAuth());
    mockVerifyElaboration.mockRejectedValue(
      new Error("Cannot resolve: 1 round(s) still have unanswered questions")
    );

    const result = await verifyElaborationAction(IDEA_UUID);

    expect(result).toEqual({
      success: false,
      error: "Cannot resolve: 1 round(s) still have unanswered questions",
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

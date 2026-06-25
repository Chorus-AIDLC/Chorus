import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UserAuthContext } from "@/types/auth";

const mockGetServerAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: mockGetServerAuthContext,
}));

const mockListComments = vi.hoisted(() => vi.fn());
const mockResolveAgentOwners = vi.hoisted(() => vi.fn());
vi.mock("@/services/comment.service", () => ({
  // Sibling actions in the same module reference these — stub so the module
  // loads without pulling in prisma.
  listComments: mockListComments,
  createComment: vi.fn(),
  resolveProjectUuid: vi.fn(),
  resolveAgentOwners: mockResolveAgentOwners,
}));

vi.mock("@/services/activity.service", () => ({
  createActivity: vi.fn(),
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

import { getCommentsAction } from "../comment-actions";

const COMPANY = "company-a";
const TARGET = "idea-1";

function humanAuth(): UserAuthContext {
  return { type: "user", companyUuid: COMPANY, actorUuid: "user-1", email: "u@test.com" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerAuthContext.mockResolvedValue(humanAuth());
  // resolveAgentOwners passes comments through unchanged in these tests.
  mockResolveAgentOwners.mockImplementation(async (comments: unknown[]) => comments);
});

describe("getCommentsAction (cursor pagination)", () => {
  it("defaults to cursor mode with limit 10 and no cursor when opts omitted (back-compat call shape)", async () => {
    mockListComments.mockResolvedValue({
      comments: [{ uuid: "c1" }],
      total: 1,
      nextCursor: null,
      hasMore: false,
    });

    const result = await getCommentsAction("idea", TARGET);

    expect(result).toEqual({
      success: true,
      comments: [{ uuid: "c1" }],
      total: 1,
      nextCursor: null,
      hasMore: false,
    });
    expect(mockListComments).toHaveBeenCalledWith({
      companyUuid: COMPANY,
      targetType: "idea",
      targetUuid: TARGET,
      cursor: null,
      limit: 10,
    });
  });

  it("passes cursor + limit through to listComments and returns continuation metadata", async () => {
    mockListComments.mockResolvedValue({
      comments: [{ uuid: "older-1" }],
      total: 30,
      nextCursor: "older-1",
      hasMore: true,
    });

    const result = await getCommentsAction("idea", TARGET, { cursor: "c-cursor", limit: 5 });

    expect(result).toEqual({
      success: true,
      comments: [{ uuid: "older-1" }],
      total: 30,
      nextCursor: "older-1",
      hasMore: true,
    });
    expect(mockListComments).toHaveBeenCalledWith({
      companyUuid: COMPANY,
      targetType: "idea",
      targetUuid: TARGET,
      cursor: "c-cursor",
      limit: 5,
    });
  });

  it("resolves agent owners on the page slice", async () => {
    const enriched = [{ uuid: "c1", author: { type: "agent", uuid: "a1", owner: { uuid: "o1", name: "Owner" } } }];
    mockListComments.mockResolvedValue({ comments: [{ uuid: "c1" }], total: 1, nextCursor: null, hasMore: false });
    mockResolveAgentOwners.mockResolvedValue(enriched);

    const result = await getCommentsAction("idea", TARGET, { limit: 10 });

    expect(mockResolveAgentOwners).toHaveBeenCalledWith([{ uuid: "c1" }]);
    expect(result.success && result.comments).toEqual(enriched);
  });

  it("returns Unauthorized when there is no auth context", async () => {
    mockGetServerAuthContext.mockResolvedValue(null);

    const result = await getCommentsAction("idea", TARGET);

    expect(result).toEqual({ success: false, error: "Unauthorized" });
    expect(mockListComments).not.toHaveBeenCalled();
  });

  it("rejects an invalid target type", async () => {
    const result = await getCommentsAction("bogus" as "idea", TARGET);

    expect(result.success).toBe(false);
    expect(mockListComments).not.toHaveBeenCalled();
  });

  it("returns an error result when listComments throws", async () => {
    mockListComments.mockRejectedValue(new Error("DB down"));

    const result = await getCommentsAction("idea", TARGET, { limit: 10 });

    expect(result).toEqual({ success: false, error: "Failed to load comments" });
  });
});

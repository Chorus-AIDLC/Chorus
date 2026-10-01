import { vi, describe, it, expect, beforeEach } from "vitest";

const mockCreateProject = vi.hoisted(() => vi.fn());
const mockGetServerAuthContext = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth-server", () => ({ getServerAuthContext: mockGetServerAuthContext }));
vi.mock("@/services/project.service", () => ({ createProject: mockCreateProject }));

import { createProject } from "@/actions/project";

describe("createProject server action — access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerAuthContext.mockResolvedValue({ type: "user", companyUuid: "company-1", actorUuid: "u-1" });
    mockCreateProject.mockResolvedValue({ uuid: "p-1" });
  });

  it("records the user as creator/admin with default public visibility", async () => {
    const res = await createProject("N");
    expect(res).toEqual({ success: true, data: { uuid: "p-1" } });
    expect(mockCreateProject).toHaveBeenCalledWith(expect.objectContaining({
      visibility: "public",
      createdByUuid: "u-1",
      actor: { type: "user", uuid: "u-1" },
    }));
  });

  it("accepts private and rejects invalid visibility", async () => {
    await createProject("N", undefined, "private");
    expect(mockCreateProject).toHaveBeenCalledWith(expect.objectContaining({ visibility: "private" }));

    const res = await createProject("N", undefined, "secret" as never);
    expect(res).toEqual({ success: false, error: "Invalid visibility" });
  });
});

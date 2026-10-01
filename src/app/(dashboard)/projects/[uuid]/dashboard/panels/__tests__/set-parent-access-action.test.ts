import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDeny = vi.hoisted(() => vi.fn());
const mockSetIdeaParent = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: vi.fn(async () => ({ type: "user", companyUuid: "c", actorUuid: "u" })),
}));
vi.mock("@/lib/project-access-action", () => ({
  denyUnlessEntityAccess: mockDeny,
  denyUnlessProjectAccess: vi.fn(async () => null),
}));
vi.mock("@/services/idea.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/idea.service")>()),
  setIdeaParent: mockSetIdeaParent,
}));

import { setIdeaParentAction } from "../actions";

describe("setIdeaParentAction — hidden parent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetIdeaParent.mockResolvedValue({ uuid: "child", parentUuid: "p" });
  });

  it("reports a hidden private parent exactly like a missing one and writes nothing", async () => {
    mockDeny.mockImplementation(async (_a: unknown, _t: string, uuid: string) =>
      uuid === "child" ? null : { success: false, error: "Idea not found" },
    );
    expect(await setIdeaParentAction("child", "secret-parent")).toEqual({ success: false, error: "Parent idea not found" });
    expect(mockDeny).toHaveBeenCalledWith(expect.anything(), "idea", "secret-parent", "viewer");
    expect(mockSetIdeaParent).not.toHaveBeenCalled();
  });

  it("detaching (null parent) skips the parent check", async () => {
    mockDeny.mockResolvedValue(null);
    expect(await setIdeaParentAction("child", null)).toMatchObject({ success: true });
    expect(mockDeny).toHaveBeenCalledTimes(1);
  });

  it("visible parent proceeds", async () => {
    mockDeny.mockResolvedValue(null);
    expect(await setIdeaParentAction("child", "p")).toMatchObject({ success: true });
    expect(mockSetIdeaParent).toHaveBeenCalledWith("child", "p", "c", expect.anything());
  });
});

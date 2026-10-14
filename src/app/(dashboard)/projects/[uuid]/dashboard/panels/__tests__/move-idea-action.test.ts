import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMoveIdea = vi.hoisted(() => vi.fn());
const mockMoveIdeaPreview = vi.hoisted(() => vi.fn());
const mockGetIdeaByUuid = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: vi.fn(async () => ({ type: "user", companyUuid: "c", actorUuid: "u" })),
}));
vi.mock("@/lib/project-access-action", () => ({
  denyUnlessEntityAccess: vi.fn(async () => null),
  denyUnlessProjectAccess: vi.fn(async () => null),
}));
vi.mock("@/services/idea.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/idea.service")>()),
  moveIdea: mockMoveIdea,
  moveIdeaPreview: mockMoveIdeaPreview,
  getIdeaByUuid: mockGetIdeaByUuid,
}));

import { moveIdeaAction, moveIdeaPreviewAction } from "../actions";
import { AssigneeAccessError } from "@/services/task.service";

const MOVED = { ideas: 1, proposals: 1, documents: 0, tasks: 2, activities: 3 };
const BLOCKED = [
  {
    assigneeType: "agent",
    assigneeUuid: "a1",
    name: "Bob",
    entities: [{ type: "task", uuid: "t1", title: "Wire the API" }],
  },
];

describe("moveIdeaPreviewAction — blockedAssignees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdeaByUuid.mockResolvedValue({ uuid: "i", projectUuid: "src" });
  });

  it("passes the preview's blockedAssignees through", async () => {
    mockMoveIdeaPreview.mockResolvedValue({ moved: MOVED, blockedAssignees: BLOCKED });
    expect(await moveIdeaPreviewAction("i", "dst")).toEqual({
      success: true,
      moved: MOVED,
      blockedAssignees: BLOCKED,
    });
  });

  it("returns an empty list when nobody is blocked", async () => {
    mockMoveIdeaPreview.mockResolvedValue({ moved: MOVED, blockedAssignees: [] });
    expect(await moveIdeaPreviewAction("i", "dst")).toMatchObject({ success: true, blockedAssignees: [] });
  });
});

describe("moveIdeaAction — AssigneeAccessError details", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns blockedAssignees from an AssigneeAccessError with details", async () => {
    mockMoveIdea.mockRejectedValue(
      new AssigneeAccessError("Assignee does not have access to this project: Bob (1 task)", {
        blockedAssignees: BLOCKED,
      }),
    );
    expect(await moveIdeaAction("i", "dst")).toEqual({
      success: false,
      error: "Assignee does not have access to this project: Bob (1 task)",
      blockedAssignees: BLOCKED,
    });
  });

  it("an AssigneeAccessError without details returns only the message", async () => {
    mockMoveIdea.mockRejectedValue(new AssigneeAccessError());
    const result = await moveIdeaAction("i", "dst");
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty("blockedAssignees");
  });

  it("other errors return only the message", async () => {
    mockMoveIdea.mockRejectedValue(new Error("boom"));
    expect(await moveIdeaAction("i", "dst")).toEqual({ success: false, error: "boom" });
  });

  it("success returns the moved counts", async () => {
    mockMoveIdea.mockResolvedValue({ moved: MOVED });
    expect(await moveIdeaAction("i", "dst")).toEqual({ success: true, moved: MOVED });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), context: vi.fn() }));
vi.mock("@/lib/auth", async (original) => ({ ...await original<typeof import("@/lib/auth")>(), getAuthContext: mocks.auth }));
vi.mock("@/services/project-access.service", () => ({ requireEntityAccess: mocks.access }));
vi.mock("@/services/idea-team.service", () => ({ getIdeaTeamContext: mocks.context }));
import { GET } from "@/app/api/ideas/[uuid]/team-context/route";

const call = () => GET(new NextRequest("http://localhost/api/ideas/idea/team-context"), { params: Promise.resolve({ uuid: "idea" }) });

describe("GET /api/ideas/[uuid]/team-context", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ type: "user", companyUuid: "company", actorUuid: "owner" });
    mocks.context.mockResolvedValue({ ideaUuid: "idea", managed: true, state: "active", taskGate: "orchestrator", routing: { ownerUuid: "owner", roles: {} } });
  });

  it("returns the gate summary but never the private routing roster", async () => {
    const body = await (await call()).json();
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), "idea", "idea", "viewer");
    expect(body.data).toMatchObject({ managed: true, taskGate: "orchestrator" });
    expect(body.data.routing).toBeUndefined();
  });

  it("rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });
});

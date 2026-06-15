import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockResolveRootIdea = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/services/lineage.service", () => ({
  resolveRootIdea: (...args: unknown[]) => mockResolveRootIdea(...args),
}));

import { GET } from "@/app/api/entities/[type]/[uuid]/root-idea/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const agentAuth = { type: "agent", companyUuid, actorUuid: "agent-1", permissions: [] };

function makeRequest(): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/entities/task/t1/root-idea"));
}

function makeContext(type: string, uuid: string) {
  return { params: Promise.resolve({ type, uuid }) };
}

async function readJson(res: Response) {
  return JSON.parse(await res.text());
}

describe("GET /api/entities/[type]/[uuid]/root-idea", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(agentAuth);
  });

  it("resolves and returns the service result in a success envelope", async () => {
    const data = {
      rootIdeaUuid: "root-1",
      lineage: [{ type: "task", uuid: "t1", title: "T1" }],
      resolvedVia: "via_proposal",
    };
    mockResolveRootIdea.mockResolvedValue(data);

    const res = await GET(makeRequest(), makeContext("task", "t1"));
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(data);
    expect(mockResolveRootIdea).toHaveBeenCalledWith(companyUuid, "task", "t1");
  });

  it("passes a null rootIdeaUuid through as a 200 success (not an error)", async () => {
    mockResolveRootIdea.mockResolvedValue({
      rootIdeaUuid: null,
      lineage: [],
      resolvedVia: "no_proposal",
    });

    const res = await GET(makeRequest(), makeContext("task", "quick"));
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.rootIdeaUuid).toBeNull();
  });

  it("requires NO fine-grained permission — an agent with empty permissions succeeds", async () => {
    mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid: "r", lineage: [], resolvedVia: "root_idea" });

    const res = await GET(makeRequest(), makeContext("idea", "i1"));

    expect(res.status).toBe(200);
    // resolution ran — no 403 short-circuit despite empty permissions
    expect(mockResolveRootIdea).toHaveBeenCalledTimes(1);
  });

  it("accepts each valid entity type", async () => {
    mockResolveRootIdea.mockResolvedValue({ rootIdeaUuid: null, lineage: [], resolvedVia: "not_found" });
    for (const type of ["task", "document", "proposal", "idea"]) {
      const res = await GET(makeRequest(), makeContext(type, "x"));
      expect(res.status).toBe(200);
    }
    expect(mockResolveRootIdea).toHaveBeenCalledTimes(4);
  });

  it("returns 400 for an invalid entity type and never calls the service", async () => {
    const res = await GET(makeRequest(), makeContext("comment", "c1"));
    const body = await readJson(res);

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(mockResolveRootIdea).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const res = await GET(makeRequest(), makeContext("task", "t1"));

    expect(res.status).toBe(401);
    expect(mockResolveRootIdea).not.toHaveBeenCalled();
  });
});

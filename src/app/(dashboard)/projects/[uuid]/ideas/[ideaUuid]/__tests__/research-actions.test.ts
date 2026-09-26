import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), request: vi.fn(), eligibility: vi.fn(), temporary: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/auth-server", () => ({ getServerAuthContext: mocks.auth }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.log } }));
vi.mock("@/services/research.service", () => ({
  requestResearch: mocks.request,
  ResearchError: class extends Error { constructor(public code: string) { super(code); } },
}));
vi.mock("@/services/research-eligibility.service", () => ({ getResearchEligibility: mocks.eligibility }));
vi.mock("@/services/project-agent-cwd.service", () => ({ resolveTemporaryRuntimeCwd: mocks.temporary }));
import { researchEligibilityAction, researchIdeaAction } from "../research-actions";
import { ResearchError } from "@/services/research.service";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ type: "user", companyUuid: "company", actorUuid: "user" });
  mocks.eligibility.mockResolvedValue({ eligible: true });
  mocks.request.mockResolvedValue({ session: { uuid: "session" }, sessionUuid: "session", turnUuid: "turn", agentUuid: "agent" });
});
describe("Research server actions", () => {
  it.each([null, { type: "agent", companyUuid: "company", actorUuid: "agent" }])("rejects non-human/unauthenticated mutation and preview", async (auth) => {
    mocks.auth.mockResolvedValue(auth);
    expect(await researchIdeaAction("idea")).toEqual({ success: false, errorCode: "unauthorized" });
    expect(await researchEligibilityAction("idea")).toEqual({ eligible: false, reason: "unauthorized" });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.eligibility).not.toHaveBeenCalled();
  });
  it("stamps authenticated tenant and actor and returns the exact root/turn", async () => {
    const result = await researchIdeaAction("idea");
    expect(result).toMatchObject({ success: true, sessionUuid: "session", turnUuid: "turn" });
    expect(mocks.request).toHaveBeenCalledWith({
      companyUuid: "company", actorUuid: "user", actorType: "user", ideaUuid: "idea", temporaryCwd: null,
    });
  });
  it("validates a temporary cwd with the existing directory service", async () => {
    mocks.temporary.mockResolvedValue({ host: "host", cwd: "/project" });
    await researchIdeaAction("idea", { agentUuid: "agent", validationRequestUuid: "validation" });
    expect(mocks.temporary).toHaveBeenCalledWith({
      companyUuid: "company", userUuid: "user", agentUuid: "agent", validationRequestUuid: "validation",
    });
    expect(mocks.request.mock.calls[0][0].temporaryCwd).toEqual({ host: "host", cwd: "/project" });
  });
  it.each(["development_started", "idea_completed", "already_running", "permission_denied", "origin_conflict", "agent_offline"] as const)(
    "returns precise %s failures without claiming success", async (code) => {
      mocks.request.mockRejectedValue(new ResearchError(code));
      expect(await researchIdeaAction("idea")).toEqual({ success: false, errorCode: code });
    },
  );
  it("logs unexpected failures and returns a localized generic code", async () => {
    mocks.request.mockRejectedValue(new Error("database credentials must not be exposed"));
    expect(await researchIdeaAction("idea")).toEqual({ success: false, errorCode: "unknown" });
    expect(mocks.log).toHaveBeenCalledOnce();
  });
});

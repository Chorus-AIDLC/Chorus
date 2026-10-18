import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-handler";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext: mocks.auth, isUser: (auth: { type: string }) => auth.type === "user" }));
vi.mock("@/services/user-avatar.service", () => ({ updateUserAvatar: mocks.update }));
import { PATCH } from "../route";

const avatarSeed = "639d12a3-0ee3-4561-8f8d-80c6f9c3b5bc";
const auth = { type: "user", actorUuid: "self", companyUuid: "tenant" };
const context = { params: Promise.resolve({}) };
function request(body: unknown = { avatarSeed }, origin: string | null = "https://chorus.test", authorization?: string) {
  return new NextRequest("http://internal:8637/api/users/me/avatar", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
      ...(authorization ? { authorization } : {}),
      cookie: "user_session=valid-cookie",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXTAUTH_URL", "https://chorus.test");
  mocks.auth.mockResolvedValue(auth);
  mocks.update.mockResolvedValue({ uuid: "self", avatarSeed });
});
afterEach(() => vi.unstubAllEnvs());

describe("PATCH self avatar", () => {
  it("saves exactly the preview using only the authenticated identity", async () => {
    const response = await PATCH(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { user: { uuid: "self", avatarSeed } } });
    expect(mocks.update).toHaveBeenCalledWith(auth, avatarSeed);
  });
  it.each([{}, null, { avatarSeed: "bad" }, { avatarSeed, userUuid: "other" }, { avatarSeed, companyUuid: "other" }, { avatarSeed, name: "changed" }, "invalid-json"])("rejects invalid body %j", async body => {
    expect((await PATCH(request(body), context)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([null, "https://attacker.test"])("rejects missing/foreign Origin despite Bearer cookie fallback: %s", async origin => {
    expect((await PATCH(request({ avatarSeed }, origin, "Bearer invalid"), context)).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not trust forwarded Host headers", async () => {
    const forged = request({ avatarSeed }, "https://attacker.test");
    forged.headers.set("x-forwarded-host", "attacker.test");
    expect((await PATCH(forged, context)).status).toBe(403);
  });
  it("uses the direct application origin without configured public URL", async () => {
    vi.stubEnv("NEXTAUTH_URL", "");
    expect((await PATCH(request({ avatarSeed }, "http://internal:8637"), context)).status).toBe(200);
  });
  it.each([[null, 401], [{ type: "agent" }, 403]])("rejects unauthenticated and agent requests", async (identity, status) => {
    mocks.auth.mockResolvedValue(identity);
    expect((await PATCH(request(), context)).status).toBe(status);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("returns 404 for disappeared scoped user", async () => {
    mocks.update.mockRejectedValue(new ApiError("NOT_FOUND", "User not found", 404));
    expect((await PATCH(request(), context)).status).toBe(404);
  });
  it("does not claim success for a database failure", async () => {
    mocks.update.mockRejectedValue(new Error("database offline"));
    expect((await PATCH(request(), context)).status).toBe(500);
  });
});

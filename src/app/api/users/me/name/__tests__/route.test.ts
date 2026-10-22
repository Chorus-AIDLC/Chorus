import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-handler";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext: mocks.auth, isUser: (auth: { type: string }) => auth.type === "user" }));
vi.mock("@/services/user-name.service", () => ({ updateUserName: mocks.update }));
import { PATCH } from "../route";

const auth = { type: "user", actorUuid: "self", companyUuid: "tenant" };
const context = { params: Promise.resolve({}) };
function request(body: unknown = { name: " New  Name " }, origin: string | null = "https://chorus.test") {
  return new NextRequest("http://internal:8637/api/users/me/name", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}), cookie: "user_session=valid-cookie", authorization: "Bearer invalid" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXTAUTH_URL", "https://chorus.test");
  mocks.auth.mockResolvedValue(auth);
  mocks.update.mockResolvedValue({ uuid: "self", name: "New  Name" });
});
afterEach(() => vi.unstubAllEnvs());

describe("PATCH self display name", () => {
  it("returns the persisted name and uses only the authenticated identity", async () => {
    const response = await PATCH(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { user: { uuid: "self", name: "New  Name" } } });
    expect(mocks.update).toHaveBeenCalledWith(auth, "New  Name");
  });

  it.each([{}, null, [], { name: 12 }, { name: "" }, { name: " \n " }, { name: "😀".repeat(33) }, { name: "\uD800" }, { name: "\uDC00" }, { name: "a\u0000b" }, { name: "Valid", actorUuid: "other" }, { name: "Valid", userUuid: "other" }, { name: "Valid", companyUuid: "other" }, { name: "Valid", nameCustomized: false }, { name: "Valid", avatarSeed: "other" }, "invalid-json"])("rejects invalid body %j", async body => {
    expect((await PATCH(request(body), context)).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("accepts 32 astral code points", async () => {
    expect((await PATCH(request({ name: "😀".repeat(32) }), context)).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(auth, "😀".repeat(32));
  });

  it.each([null, "null", "https://attacker.test"])("rejects missing or foreign Origin despite cookie fallback: %s", async origin => {
    expect((await PATCH(request({ name: "Valid" }, origin), context)).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not trust forwarded Host headers", async () => {
    const forged = request({ name: "Valid" }, "https://attacker.test");
    forged.headers.set("x-forwarded-host", "attacker.test");
    expect((await PATCH(forged, context)).status).toBe(403);
  });

  it.each(["http://192.168.31.153:18637", "http://127.0.0.1:18637", "http://[::1]:18637", "https://192.168.31.153:18638"])("accepts the request Host origin: %s", async origin => {
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:18637");
    const url = new URL(origin);
    const direct = new NextRequest(`${url.protocol}//internal:8637/api/users/me/name`, {
      method: "PATCH", headers: { host: url.host, origin, "content-type": "application/json" }, body: JSON.stringify({ name: "Valid" }),
    });
    expect((await PATCH(direct, context)).status).toBe(200);
  });

  it("accepts nextUrl origin without Host or configured origin", async () => {
    vi.stubEnv("NEXTAUTH_URL", "");
    expect((await PATCH(request({ name: "Valid" }, "http://internal:8637"), context)).status).toBe(200);
  });

  it.each(["http://192.168.31.153:9999", "https://192.168.31.153:18637"])("rejects mismatched port or protocol: %s", async origin => {
    const direct = request({ name: "Valid" }, origin);
    direct.headers.set("host", "192.168.31.153:18637");
    expect((await PATCH(direct, context)).status).toBe(403);
  });

  it.each(["attacker.test/path", "user@attacker.test", "[invalid", "attacker.test?query", "attacker.test#hash"])("rejects malformed Host %s", async host => {
    const forged = request({ name: "Valid" }, "http://attacker.test");
    forged.headers.set("host", host);
    expect((await PATCH(forged, context)).status).toBe(403);
  });

  it.each(["agent", "super_admin"])("rejects principal %s", async type => {
    mocks.auth.mockResolvedValue({ ...auth, type });
    expect((await PATCH(request(), context)).status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await PATCH(request(), context)).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns 404 for absent, inactive, deleted or wrong-tenant targets", async () => {
    mocks.update.mockRejectedValue(new ApiError("NOT_FOUND", "User not found", 404));
    expect((await PATCH(request(), context)).status).toBe(404);
  });
});

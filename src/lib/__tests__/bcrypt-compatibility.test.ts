import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySuperAdminPassword } from "../super-admin";
import { legacyBcryptFixtures } from "./bcrypt-compatibility.fixture";

afterEach(() => vi.unstubAllEnvs());

describe("Super Admin real bcrypt compatibility", () => {
  it("verifies the bcryptjs 2.4.3 environment hash and rejects a wrong password", async () => {
    const fixture = legacyBcryptFixtures.superAdmin;
    vi.stubEnv("SUPER_ADMIN_PASSWORD_HASH", fixture.hash);

    expect(await verifySuperAdminPassword(fixture.password)).toBe(true);
    expect(await verifySuperAdminPassword("wrong-admin-password-123")).toBe(false);
    expect(process.env.SUPER_ADMIN_PASSWORD_HASH).toBe(fixture.hash);
  });

  it("verifies a current-library synchronous cost-10 CDK-style hash", async () => {
    const password = "current-admin-password-123";
    const hash = bcrypt.hashSync(password, 10);
    vi.stubEnv("SUPER_ADMIN_PASSWORD_HASH", hash);

    expect(bcrypt.getRounds(hash)).toBe(10);
    expect(await verifySuperAdminPassword(password)).toBe(true);
    expect(await verifySuperAdminPassword("wrong-admin-password-123")).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  company: { findFirst: vi.fn() },
  user: { findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn(), updateManyAndReturn: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
import { findOrCreateUserByOidc } from "../user.service";
import { updateUserName } from "../user-name.service";

const auth = { type: "user" as const, actorUuid: "self", companyUuid: "tenant" };
const input = { oidcSub: "subject", email: "user@example.test", name: "Provider name", companyUuid: "tenant" };
let stored: {
  id: number; uuid: string; companyUuid: string; name: string; nameCustomized: boolean;
  email: string; oidcSub: string; status: string; deletedAt: null; authType: string;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  stored = { id: 1, uuid: "self", companyUuid: "tenant", name: "Old name", nameCustomized: false, email: "old@example.test", oidcSub: "subject", status: "active", deletedAt: null, authType: "oidc" };
  mockPrisma.company.findFirst.mockResolvedValue({ localAuthEnabled: false });
  mockPrisma.user.findFirst.mockImplementation(async () => ({ ...stored }));
  mockPrisma.user.findUniqueOrThrow.mockImplementation(async () => ({ ...stored }));
  mockPrisma.user.update.mockImplementation(async ({ data }) => Object.assign(stored, data));
  mockPrisma.user.updateMany.mockImplementation(async ({ where, data }) => {
    if (where.nameCustomized !== stored.nameCustomized) return { count: 0 };
    Object.assign(stored, data);
    return { count: 1 };
  });
  mockPrisma.user.updateManyAndReturn.mockImplementation(async ({ data }) => {
    Object.assign(stored, data);
    return [{ uuid: stored.uuid, name: stored.name }];
  });
});

describe.each(["subject", "email-link"])("OIDC %s display names", path => {
  beforeEach(() => {
    if (path === "email-link") mockPrisma.user.findFirst.mockResolvedValueOnce(null);
  });

  it("continues synchronizing uncustomized provider names without self-service restrictions", async () => {
    const name = `  ${"😀".repeat(33)}  `;
    expect((await findOrCreateUserByOidc({ ...input, name })).name).toBe(name);
    expect(stored.nameCustomized).toBe(false);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 1, companyUuid: "tenant", nameCustomized: false }, data: { name },
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      data: path === "subject" ? { email: input.email } : { oidcSub: input.oidcSub },
    }));
  });

  it("preserves customized names and returns the persisted user", async () => {
    stored.nameCustomized = true;
    expect((await findOrCreateUserByOidc(input)).name).toBe("Old name");
    expect(mockPrisma.user.findUniqueOrThrow).toHaveBeenCalled();
  });

  it("leaves the persisted name untouched when the provider omits it", async () => {
    expect((await findOrCreateUserByOidc({ ...input, name: undefined })).name).toBe("Old name");
    expect(mockPrisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("does not overwrite a self-save after OIDC read but before its conditional write", async () => {
    const entered = deferred();
    const resume = deferred();
    const write = mockPrisma.user.updateMany.getMockImplementation()!;
    mockPrisma.user.updateMany.mockImplementationOnce(async args => {
      entered.resolve();
      await resume.promise;
      return write(args);
    });
    const syncing = findOrCreateUserByOidc(input);
    await entered.promise;
    await updateUserName(auth, "Custom name");
    resume.resolve();
    expect((await syncing).name).toBe("Custom name");
    expect(stored.nameCustomized).toBe(true);
  });

  it("returns a self-save made after the OIDC write but before its final read", async () => {
    const entered = deferred();
    const resume = deferred();
    mockPrisma.user.findUniqueOrThrow.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return { ...stored };
    });
    const syncing = findOrCreateUserByOidc(input);
    await entered.promise;
    expect(stored.name).toBe(input.name);
    await updateUserName(auth, "Custom name");
    resume.resolve();
    expect((await syncing).name).toBe("Custom name");
    expect(stored.nameCustomized).toBe(true);
  });
});

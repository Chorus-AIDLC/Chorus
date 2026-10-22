import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import { publishAccountAccessChanged } from "@/lib/account-access-events";
import type { User } from "@/generated/prisma/client";
import type { AuthContext, SuperAdminAuthContext } from "@/types/auth";
import type { CredentialLink, CredentialPurpose, InitialAdminMutationResult, InitialAdminState, LocalUserDto, LocalUserMutationResult, LocalUserStatus } from "@/types/local-user";

export const LOCAL_PASSWORD_WORK_FACTOR = 12;
export const CREDENTIAL_LINK_TTL_MS = 24 * 60 * 60 * 1000;
type Tx = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;
const invalid = (message: string) => new ApiError("BAD_REQUEST", message, 400);
const forbidden = () => new ApiError("FORBIDDEN", "Active local Workspace Admin required", 403);
const invalidLink = () => invalid("Invalid or expired credential link");

export function normalizeLocalIdentifier(value: string): string {
  return value.trim().toLowerCase();
}
export function normalizeLocalUsername(value: unknown): string {
  if (typeof value !== "string") throw invalid("Username is required");
  const username = normalizeLocalIdentifier(value);
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) {
    throw invalid("Username must be 3-64 ASCII letters, numbers, dots, underscores or hyphens, without @");
  }
  return username;
}
export function normalizeLocalEmail(value: unknown): string {
  if (typeof value !== "string") throw invalid("Email is required");
  const email = normalizeLocalIdentifier(value);
  if (!z.string().max(254).email().safeParse(email).success) throw invalid("Valid email is required");
  return email;
}
export function validateLocalPassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || [...value].length < 8 || Buffer.byteLength(value, "utf8") > 72) {
    throw invalid("Password must contain at least 8 characters and at most 72 UTF-8 bytes");
  }
}
export function publicLocalUser(user: User): LocalUserDto {
  return {
    uuid: user.uuid, companyUuid: user.companyUuid, username: user.username ?? "",
    email: user.localEmail ?? user.email ?? "", name: user.name, workspaceAdmin: user.workspaceAdmin,
    status: user.status as LocalUserStatus, createdAt: user.createdAt.toISOString(),
  };
}
const nameSchema = z.string().trim().min(1).max(200);
const invitationNameSchema = z.string().trim().max(200).transform(value => value || undefined).optional();
const initialAdminSchema = z.object({ username: z.unknown(), email: z.unknown(), name: invitationNameSchema }).strict();
const createSchema = z.object({ username: z.unknown(), email: z.unknown(), name: invitationNameSchema, workspaceAdmin: z.boolean().optional() }).strict();
const updateSchema = z.object({ username: z.string().optional(), email: z.string().optional(), name: nameSchema.optional(), workspaceAdmin: z.boolean().optional(), status: z.enum(["active", "disabled"]).optional() }).strict().refine(v => Object.keys(v).length > 0);
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw invalid("Invalid account input");
  return result.data;
}
function createInput(input: unknown) {
  const value = parse(createSchema, input);
  return { ...value, username: normalizeLocalUsername(value.username), email: normalizeLocalEmail(value.email) };
}

// Never reflect Prisma query arguments (which may contain credentials) into API logs.
async function safeTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try { return await prisma.$transaction(fn, { timeout: 15000 }); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      throw new ApiError("CONFLICT", "Username or email already exists in this workspace", 409);
    }
    throw new ApiError("INTERNAL_ERROR", "Local account operation failed", 500);
  }
}
async function lockCompany(tx: Tx, companyUuid: string) {
  // READ COMMITTED + row lock: all subsequent reads see the preceding mutation's commit.
  await tx.$queryRaw`SELECT "uuid" FROM "Company" WHERE "uuid" = ${companyUuid} FOR UPDATE`;
  const company = await tx.company.findUnique({ where: { uuid: companyUuid } });
  if (!company?.localAuthEnabled || company.oidcEnabled) throw forbidden();
  return company;
}
async function requireAdmin(tx: Tx, auth: AuthContext) {
  if (auth.type !== "user") throw forbidden();
  const actor = await tx.user.findFirst({ where: { uuid: auth.actorUuid, companyUuid: auth.companyUuid } });
  if (!actor || actor.authType !== "local" || actor.status !== "active" || actor.deletedAt || !actor.passwordHash || !actor.workspaceAdmin) throw forbidden();
  return actor;
}
async function managed<T>(auth: AuthContext, fn: (tx: Tx) => Promise<T>, changedUserUuid?: string): Promise<T> {
  if (auth.type !== "user") throw forbidden();
  const result = await safeTransaction(async tx => {
    await lockCompany(tx, auth.companyUuid);
    await requireAdmin(tx, auth);
    return fn(tx);
  });
  if (changedUserUuid) publishAccountAccessChanged({ companyUuid: auth.companyUuid, userUuid: changedUserUuid });
  return result;
}
async function targetUser(tx: Tx, companyUuid: string, uuid: string) {
  const user = await tx.user.findFirst({ where: { companyUuid, uuid, authType: "local", deletedAt: null, status: { not: "deleted" } } });
  if (!user) throw new ApiError("NOT_FOUND", "Local user not found", 404);
  return user;
}
async function audit(tx: Tx, companyUuid: string, actorType: string, actorUuid: string, targetUuid: string, action: string) {
  await tx.localUserAudit.create({ data: { companyUuid, actorType, actorUuid, targetUuid, action } });
}
async function issueToken(tx: Tx, user: User, purpose: CredentialPurpose): Promise<CredentialLink> {
  await tx.userCredentialToken.deleteMany({ where: { companyUuid: user.companyUuid, userUuid: user.uuid } });
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CREDENTIAL_LINK_TTL_MS);
  await tx.userCredentialToken.create({ data: {
    companyUuid: user.companyUuid, userUuid: user.uuid, tokenHash: createHash("sha256").update(token).digest("hex"),
    purpose, sessionVersion: user.sessionVersion, expiresAt,
  } });
  return { url: `/login/local/accept?token=${token}`, expiresAt: expiresAt.toISOString(), purpose };
}
async function insertInvitedUser(tx: Tx, companyUuid: string, input: ReturnType<typeof createInput>) {
  return tx.user.create({ data: {
    companyUuid, oidcSub: `local_${randomUUID()}`, authType: "local", username: input.username,
    email: input.email, localEmail: input.email, name: input.name, workspaceAdmin: input.workspaceAdmin ?? false, status: "invited",
  } });
}

export async function bootstrapLocalCompany(auth: SuperAdminAuthContext, input: unknown) {
  if (auth.type !== "super_admin") throw new ApiError("FORBIDDEN", "Super Admin required", 403);
  const body = parse(z.object({ name: nameSchema, initialAdmin: initialAdminSchema }).strict(), input);
  const admin = createInput({ ...body.initialAdmin, workspaceAdmin: true });
  return safeTransaction(async tx => {
    const company = await tx.company.create({ data: { name: body.name, localAuthEnabled: true, oidcEnabled: false } });
    const user = await insertInvitedUser(tx, company.uuid, admin);
    const credentialLink = await issueToken(tx, user, "invite");
    await audit(tx, company.uuid, "super_admin", auth.email, user.uuid, "local_workspace_bootstrapped");
    return { company: { uuid: company.uuid, name: company.name, localAuthEnabled: true, oidcEnabled: false }, user: publicLocalUser(user), credentialLink };
  });
}

const initialAdminMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reinvite"), expectedUserUuid: z.string().min(1) }).strict(),
  z.object({ action: z.literal("revoke"), expectedUserUuid: z.string().min(1) }).strict(),
  z.object({ action: z.literal("replace"), expectedUserUuid: z.string().min(1).nullable(), initialAdmin: initialAdminSchema }).strict(),
]);
const bootstrapActions = ["local_workspace_bootstrapped", "local_initial_admin_replaced"];
const revokedAction = "local_initial_admin_revoked";
function requireBootstrapSuperAdmin(auth: SuperAdminAuthContext) {
  if (auth.type !== "super_admin") throw new ApiError("FORBIDDEN", "Super Admin required", 403);
}
const bootstrapConflict = () => new ApiError("CONFLICT", "Initial admin setup has changed or is no longer manageable", 409);
async function initialAdminState(tx: Tx, companyUuid: string) {
  // Do not infer bootstrap identity from roles or creation time. Revocations are
  // durable even after tombstoning, and every replacement has a fresh identity.
  const history = await tx.localUserAudit.findMany({ where: {
    companyUuid, actorType: "super_admin", action: { in: [...bootstrapActions, revokedAction] },
  } });
  const principals = history.filter(entry => bootstrapActions.includes(entry.action)).map(entry => entry.targetUuid);
  const revoked = new Set(history.filter(entry => entry.action === revokedAction).map(entry => entry.targetUuid));
  const current = [...new Set(principals)].filter(uuid => !revoked.has(uuid));
  const accepted = principals.length ? await tx.localUserAudit.findFirst({ where: {
    companyUuid, targetUuid: { in: principals }, action: "local_invite_accepted",
  } }) : null;
  const user = current.length === 1 ? await tx.user.findFirst({ where: {
    companyUuid, uuid: current[0], authType: "local",
  } }) : null;
  const liveUser = user && !user.deletedAt && user.status !== "deleted" ? user : null;
  const bootstrapped = history.filter(entry => entry.action === "local_workspace_bootstrapped").length === 1;
  const manageable = bootstrapped && !accepted && current.length <= 1 &&
    (current.length === 0 || !!liveUser && liveUser.status === "invited" && !liveUser.passwordHash && liveUser.workspaceAdmin);
  return { user: liveUser, manageable };
}
export async function getInitialAdmin(auth: SuperAdminAuthContext, companyUuid: string): Promise<InitialAdminState> {
  requireBootstrapSuperAdmin(auth);
  return safeTransaction(async tx => {
    await lockCompany(tx, companyUuid);
    const state = await initialAdminState(tx, companyUuid);
    return { user: state.user ? publicLocalUser(state.user) : null, manageable: state.manageable };
  });
}
export async function manageInitialAdmin(auth: SuperAdminAuthContext, companyUuid: string, input: unknown): Promise<InitialAdminMutationResult> {
  requireBootstrapSuperAdmin(auth);
  const body = parse(initialAdminMutationSchema, input);
  const replacement = body.action === "replace" ? createInput({ ...body.initialAdmin, workspaceAdmin: true }) : null;
  return safeTransaction(async tx => {
    // Acceptance uses this same lock and writes local_invite_accepted before
    // committing. No recovery operation can race activation or erase its marker.
    await lockCompany(tx, companyUuid);
    const state = await initialAdminState(tx, companyUuid);
    if (!state.manageable || body.expectedUserUuid !== (state.user?.uuid ?? null)) throw bootstrapConflict();
    if (body.action === "reinvite") {
      if (!state.user) throw bootstrapConflict();
      const user = await tx.user.update({ where: { uuid: state.user.uuid }, data: { sessionVersion: { increment: 1 } } });
      const credentialLink = await issueToken(tx, user, "invite");
      await audit(tx, companyUuid, "super_admin", auth.email, user.uuid, "local_initial_admin_reinvited");
      return { user: publicLocalUser(user), manageable: true, credentialLink };
    }
    if (state.user) {
      // Explicit preactivation setup recovery only: never bypass the ordinary
      // last-admin guard for active users. History stays on the tombstone UUID.
      await tx.user.update({ where: { uuid: state.user.uuid }, data: {
        status: "deleted", deletedAt: new Date(), username: null, localEmail: null,
        passwordHash: null, workspaceAdmin: false, sessionVersion: { increment: 1 },
      } });
      await tx.userCredentialToken.deleteMany({ where: { companyUuid, userUuid: state.user.uuid } });
      await audit(tx, companyUuid, "super_admin", auth.email, state.user.uuid, revokedAction);
    }
    if (body.action === "revoke") return { user: null, manageable: true };
    const user = await insertInvitedUser(tx, companyUuid, replacement!);
    const credentialLink = await issueToken(tx, user, "invite");
    await audit(tx, companyUuid, "super_admin", auth.email, user.uuid, "local_initial_admin_replaced");
    return { user: publicLocalUser(user), manageable: true, credentialLink };
  });
}

export async function listLocalUsers(auth: AuthContext, page = 1, pageSize = 20) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger((page - 1) * pageSize)) throw invalid("Invalid pagination");
  return managed(auth, async tx => {
    const where = { companyUuid: auth.companyUuid, authType: "local", deletedAt: null, status: { not: "deleted" } };
    const [users, total] = await Promise.all([
      tx.user.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: [{ createdAt: "desc" }, { uuid: "asc" }] }),
      tx.user.count({ where }),
    ]);
    return { users: users.map(publicLocalUser), total };
  });
}
export async function createLocalUser(auth: AuthContext, input: unknown): Promise<LocalUserMutationResult> {
  const body = createInput(input);
  return managed(auth, async tx => {
    const user = await insertInvitedUser(tx, auth.companyUuid, body);
    const credentialLink = await issueToken(tx, user, "invite");
    await audit(tx, auth.companyUuid, "user", auth.actorUuid, user.uuid, "local_user_created");
    return { user: publicLocalUser(user), credentialLink };
  });
}
async function guardLastAdmin(tx: Tx, user: User, next: { workspaceAdmin: boolean; status: string }) {
  const effective = user.workspaceAdmin && user.status === "active" && !!user.passwordHash && !user.deletedAt;
  const remainsEffective = next.workspaceAdmin && next.status === "active" && !!user.passwordHash;
  const removesInvitedAdmin = user.workspaceAdmin && user.status === "invited" && (!next.workspaceAdmin || next.status !== "invited");
  if ((!effective || remainsEffective) && !removesInvitedAdmin) return;
  const otherActive = await tx.user.count({ where: {
    companyUuid: user.companyUuid, uuid: { not: user.uuid }, authType: "local", workspaceAdmin: true,
    status: "active", passwordHash: { not: null }, deletedAt: null,
  } });
  if (!otherActive) throw new ApiError("CONFLICT", "Cannot remove the last effective Workspace Admin", 409);
}
export async function updateLocalUser(auth: AuthContext, uuid: string, input: unknown): Promise<LocalUserMutationResult> {
  const body = parse(updateSchema, input);
  const username = body.username === undefined ? undefined : normalizeLocalUsername(body.username);
  const email = body.email === undefined ? undefined : normalizeLocalEmail(body.email);
  return managed(auth, async tx => {
    const current = await targetUser(tx, auth.companyUuid, uuid);
    // Re-enable a suspended invitation as invited, never as an active passwordless account.
    const status = body.status === "active" && current.status === "disabled" && !current.passwordHash
      ? "invited" : body.status;
    if (status === "active" && (!current.passwordHash || current.status === "invited")) throw invalid("Accept an invitation before activating this user");
    await guardLastAdmin(tx, current, { workspaceAdmin: body.workspaceAdmin ?? current.workspaceAdmin, status: status ?? current.status });
    // Every account edit revokes sessions and stale links, including identity changes.
    const user = await tx.user.update({ where: { uuid: current.uuid }, data: {
      username, localEmail: email, email, name: body.name, workspaceAdmin: body.workspaceAdmin, status,
      sessionVersion: { increment: 1 },
    } });
    await tx.userCredentialToken.deleteMany({ where: { companyUuid: auth.companyUuid, userUuid: uuid } });
    const credentialLink = user.status === "invited" ? await issueToken(tx, user, "invite") : undefined;
    await audit(tx, auth.companyUuid, "user", auth.actorUuid, uuid, "local_user_updated");
    return { user: publicLocalUser(user), ...(credentialLink ? { credentialLink } : {}) };
  }, uuid);
}
export async function removeLocalUser(auth: AuthContext, uuid: string): Promise<LocalUserMutationResult> {
  return managed(auth, async tx => {
    const current = await targetUser(tx, auth.companyUuid, uuid);
    await guardLastAdmin(tx, current, { workspaceAdmin: false, status: "deleted" });
    // Release login identifiers, not identity: all history and ownership stay on
    // this deleted UUID. A later invitation always inserts a fresh account.
    const user = await tx.user.update({ where: { uuid }, data: { status: "deleted", deletedAt: new Date(), username: null, localEmail: null, passwordHash: null, workspaceAdmin: false, sessionVersion: { increment: 1 } } });
    await tx.userCredentialToken.deleteMany({ where: { companyUuid: auth.companyUuid, userUuid: uuid } });
    await audit(tx, auth.companyUuid, "user", auth.actorUuid, uuid, "local_user_removed");
    return { user: publicLocalUser(user) };
  }, uuid);
}
export async function issueLocalUserCredential(auth: AuthContext, uuid: string, input: unknown): Promise<LocalUserMutationResult> {
  const { purpose } = parse(z.object({ purpose: z.enum(["invite", "reset"]) }).strict(), input);
  return managed(auth, async tx => {
    const current = await targetUser(tx, auth.companyUuid, uuid);
    if (purpose === "invite" ? current.status !== "invited" : current.status !== "active" || !current.passwordHash) throw invalid("Invitation requires an invited user; reset requires an active user");
    const user = await tx.user.update({ where: { uuid }, data: { sessionVersion: { increment: 1 } } });
    const credentialLink = await issueToken(tx, user, purpose);
    await audit(tx, auth.companyUuid, "user", auth.actorUuid, uuid, `local_${purpose}_issued`);
    return { user: publicLocalUser(user), credentialLink };
  }, uuid);
}

export async function acceptLocalCredential(input: unknown): Promise<{ accepted: true }> {
  const result = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.unknown() }).strict().safeParse(input);
  if (!result.success) throw invalidLink();
  validateLocalPassword(result.data.password);
  const password = result.data.password;
  const tokenHash = createHash("sha256").update(result.data.token).digest("hex");
  const accepted = await safeTransaction(async tx => {
    const hint = await tx.userCredentialToken.findUnique({ where: { tokenHash } });
    if (!hint) throw invalidLink();
    try { await lockCompany(tx, hint.companyUuid); } catch (error) {
      if (error instanceof ApiError && error.status === 403) throw invalidLink();
      throw error;
    }
    // Re-read after acquiring the lock: another acceptance/edit may have committed.
    const token = await tx.userCredentialToken.findUnique({ where: { tokenHash } });
    const now = new Date();
    if (!token || token.usedAt || token.expiresAt <= now || !["invite", "reset"].includes(token.purpose)) throw invalidLink();
    const user = await tx.user.findFirst({ where: { uuid: token.userUuid, companyUuid: token.companyUuid, authType: "local" } });
    if (!user || user.deletedAt || user.sessionVersion !== token.sessionVersion ||
        (token.purpose === "invite" ? user.status !== "invited" || !!user.passwordHash : user.status !== "active" || !user.passwordHash)) throw invalidLink();
    // Only a valid, current credential may trigger expensive bcrypt work. Keep
    // the workspace lock through hashing and consumption to prevent stale replay.
    const passwordHash = await bcrypt.hash(password, LOCAL_PASSWORD_WORK_FACTOR);
    const consumed = await tx.userCredentialToken.updateMany({
      where: { uuid: token.uuid, tokenHash, companyUuid: user.companyUuid, userUuid: user.uuid, sessionVersion: user.sessionVersion, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw invalidLink();
    await tx.user.update({ where: { uuid: user.uuid }, data: { passwordHash, status: "active", sessionVersion: { increment: 1 } } });
    await tx.userCredentialToken.deleteMany({ where: { companyUuid: user.companyUuid, userUuid: user.uuid, uuid: { not: token.uuid } } });
    // Owner keys are retained on password reset. Owner state is checked on every
    // API-key authentication by Task 2; disable/delete makes them unusable.
    await audit(tx, user.companyUuid, "user", user.uuid, user.uuid, `local_${token.purpose}_accepted`);
    return { companyUuid: user.companyUuid, userUuid: user.uuid };
  });
  publishAccountAccessChanged(accepted);
  return { accepted: true };
}

export async function getUserAccountState(companyUuid: string, userUuid: string) {
  const user = await prisma.user.findFirst({ where: { uuid: userUuid, companyUuid }, select: {
    uuid: true, companyUuid: true, email: true, name: true, username: true,
    authType: true, status: true, sessionVersion: true, deletedAt: true, workspaceAdmin: true,
    company: { select: { localAuthEnabled: true, oidcEnabled: true } },
  } });
  return user;
}

// Lazily computed constant-work dummy comparison for missing/ineligible users.
let dummyHash: Promise<string> | undefined;
export async function verifyLocalLoginCredentials(companyUuid: string, identifier: string, password: string) {
  let validPassword = true;
  try { validateLocalPassword(password); } catch { validPassword = false; }
  const normalized = typeof identifier === "string" ? normalizeLocalIdentifier(identifier) : "";
  const user = normalized.length <= 254 && validPassword ? await prisma.user.findFirst({ where: {
    companyUuid, authType: "local", ...(normalized.includes("@") ? { localEmail: normalized } : { username: normalized }),
    company: { localAuthEnabled: true, oidcEnabled: false },
  } }) : null;
  const eligible = !!user && user.status === "active" && !user.deletedAt && !!user.passwordHash;
  const comparisonHash = eligible ? user.passwordHash! : await (dummyHash ??= bcrypt.hash("local-dummy-password", LOCAL_PASSWORD_WORK_FACTOR));
  const matches = await bcrypt.compare(validPassword ? password : "invalid-password", comparisonHash);
  if (!eligible || !matches || !user) return null;
  // Credentials never leave this service. Caller issues a version-bound session.
  return { ...publicLocalUser(user), authType: "local" as const, sessionVersion: user.sessionVersion };
}

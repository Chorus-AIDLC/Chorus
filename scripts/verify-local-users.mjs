#!/usr/bin/env node
// Destructive fixtures are restricted to an explicitly isolated local test stack.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const base = process.env.LOCAL_USERS_TEST_URL;
const database = process.env.LOCAL_USERS_TEST_DATABASE_URL;
if (process.env.LOCAL_USERS_TEST_ISOLATED !== "1" || !base || !database) {
  throw new Error("Set LOCAL_USERS_TEST_ISOLATED=1, LOCAL_USERS_TEST_URL and LOCAL_USERS_TEST_DATABASE_URL for a disposable stack.");
}
const app = new URL(base), dbUrl = new URL(database);
assert(["localhost", "127.0.0.1"].includes(app.hostname) && app.port !== "8637", "Refusing normal application port or nonlocal app");
assert(["localhost", "127.0.0.1"].includes(dbUrl.hostname) && dbUrl.port === "5435", "Refusing non-test database");
assert(process.env.LOCAL_USERS_TEST_ADMIN_EMAIL && process.env.LOCAL_USERS_TEST_ADMIN_PASSWORD, "Explicit test administrator credentials required");
const db = new pg.Client({ connectionString: database });
const password = "integration-local-password-123";
const suffix = Date.now().toString(36);
let checks = 0;
function check(label, condition) { assert(condition, label); checks++; console.log(`PASS ${label}`); }
async function api(path, { method = "GET", body, cookie, key } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    ...(body ? { "Content-Type": "application/json" } : {}),
    ...(cookie ? { Cookie: cookie } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, (Number(response.headers.get("retry-after")) || 60) * 1000 + 100));
    return api(path, { method, body, cookie, key });
  }
  const json = await response.json();
  const cookies = response.headers.getSetCookie?.() ?? [];
  return { status: response.status, json, cookie: cookies.map((value) => value.split(";")[0]).join("; ") };
}
function token(link) { return new URL(link.url).searchParams.get("token"); }
async function accept(link) { return api("/api/auth/local/accept", { method: "POST", body: { token: token(link), password } }); }
async function login(companyUuid, identifier) {
  const result = await api("/api/auth/local/login", { method: "POST", body: { companyUuid, identifier, password } });
  check("active tenant-bound local login", result.status === 200 && result.cookie.includes("user_session="));
  return result.cookie;
}
async function issue(cookie, username, admin = false) {
  const result = await api("/api/workspace/users", { method: "POST", cookie, body: { username, email: `${username}@integration.local`, workspaceAdmin: admin } });
  check("admin invites local user", result.status === 200 && result.json.data.user.status === "invited");
  return result.json.data;
}
async function mcp(key) {
  const response = await fetch(`${base}/api/mcp`, { method: "POST", headers: {
    Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "isolated-local-user-verifier", version: "1" } } }) });
  await response.text();
  return response.status;
}
try {
  await db.connect();
  const adminLogin = await api("/api/admin/login", { method: "POST", body: { email: process.env.LOCAL_USERS_TEST_ADMIN_EMAIL, password: process.env.LOCAL_USERS_TEST_ADMIN_PASSWORD } });
  check("Superadmin authentication", adminLogin.status === 200 && adminLogin.cookie.includes("admin_session="));
  const username = `admin-${suffix}`;
  async function bootstrap(name) {
    const result = await api("/api/admin/companies/local", { method: "POST", cookie: adminLogin.cookie, body: { name: `local-user-integration-${suffix}-${name}`, initialAdmin: { username, email: `${username}@integration.local` } } });
    check("atomic local workspace bootstrap", result.status === 200 && result.json.data.company.localAuthEnabled && !result.json.data.company.oidcEnabled);
    return result.json.data;
  }
  const a = await bootstrap("A"), b = await bootstrap("B");
  check("first invitation acceptance", (await accept(a.credentialLink)).status === 200);
  check("invitation replay denied", (await accept(a.credentialLink)).status >= 400);
  const adminCookie = await login(a.company.uuid, username);
  check("invited second-tenant login denied", (await api("/api/auth/local/login", { method: "POST", body: { companyUuid: b.company.uuid, identifier: username, password } })).status === 401);
  const discovery = await api("/api/auth/identify", { method: "POST", body: { identifier: username } });
  check("duplicate identifiers discover both workspaces", discovery.json.data.type === "multi_role" && discovery.json.data.roles.filter((r) => r.kind === "local").length === 2);
  const emailDiscovery = await api("/api/auth/identify", { method: "POST", body: { email: `${username}@integration.local` } });
  check("email discovery supports duplicate tenant identities", emailDiscovery.json.data.roles.filter((r) => r.kind === "local").length === 2);
  const member = await issue(adminCookie, `member-${suffix}`);
  check("same-tenant normalized duplicate denied", (await api("/api/workspace/users", { method: "POST", cookie: adminCookie, body: { username: `MEMBER-${suffix}`, email: `other-${suffix}@integration.local` } })).status === 409);
  check("member accepts invitation", (await accept(member.credentialLink)).status === 200);
  const memberCookie = await login(a.company.uuid, member.user.username);
  check("ordinary user cannot manage users", (await api("/api/workspace/users", { cookie: memberCookie })).status === 403);
  check("active account wrong tenant denied", (await api("/api/auth/local/login", { method: "POST", body: { companyUuid: b.company.uuid, identifier: member.user.username, password } })).status === 401);
  check("cross-tenant user mutation denied", (await api(`/api/workspace/users/${b.user.uuid}`, { method: "PATCH", cookie: adminCookie, body: { name: "must-not-change" } })).status === 404);
  const agent = await api("/api/agents", { method: "POST", cookie: memberCookie, body: { name: `owned-integration-${suffix}`, roles: ["developer_agent"] } });
  check("ordinary user retains agent creation access", agent.status === 200);
  const keyResult = await api("/api/api-keys", { method: "POST", cookie: memberCookie, body: { agentUuid: agent.json.data.uuid } });
  check("ordinary owner creates key", keyResult.status === 200);
  const key = keyResult.json.data.key;
  check("owned key authenticates REST", (await api("/api/projects", { key })).status === 200);
  check("owned key authenticates MCP", (await mcp(key)) === 200);
  check("owned key never gains human user-management privilege", (await api("/api/workspace/users", { key })).status === 403);
  check("disable user succeeds", (await api(`/api/workspace/users/${member.user.uuid}`, { method: "PATCH", cookie: adminCookie, body: { status: "disabled" } })).status === 200);
  check("disabled session denied", (await api("/api/auth/me", { cookie: memberCookie })).status === 401);
  check("disabled owner key denied REST", (await api("/api/projects", { key })).status === 401);
  check("disabled owner key denied MCP", (await mcp(key)) === 401);
  check("enable established user succeeds", (await api(`/api/workspace/users/${member.user.uuid}`, { method: "PATCH", cookie: adminCookie, body: { status: "active" } })).status === 200);
  check("old session stays invalid after enable", (await api("/api/auth/me", { cookie: memberCookie })).status === 401);
  const newMemberCookie = await login(a.company.uuid, member.user.email);
  const reset = await api(`/api/workspace/users/${member.user.uuid}/credentials`, { method: "POST", cookie: adminCookie, body: { purpose: "reset" } });
  check("admin issues reset", reset.status === 200);
  check("reset revokes existing session", (await api("/api/auth/me", { cookie: newMemberCookie })).status === 401);
  check("reset acceptance succeeds", (await accept(reset.json.data.credentialLink)).status === 200);
  check("reset replay denied", (await accept(reset.json.data.credentialLink)).status >= 400);
  const expiredReset = await api(`/api/workspace/users/${member.user.uuid}/credentials`, { method: "POST", cookie: adminCookie, body: { purpose: "reset" } });
  assert.equal(expiredReset.status, 200, "expiry reset issuance");
  const resetExpiryUpdate = await db.query('UPDATE "UserCredentialToken" SET "expiresAt"=$2::timestamp WHERE "tokenHash"=$1', [createHash("sha256").update(token(expiredReset.json.data.credentialLink)).digest("hex"), new Date(Date.now() - 60_000).toISOString()]);
  assert.equal(resetExpiryUpdate.rowCount, 1, "reset expiry fixture updated");
  check("expired reset denied", (await accept(expiredReset.json.data.credentialLink)).status >= 400);
  const expired = await issue(adminCookie, `expired-${suffix}`);
  const expiredUpdate = await db.query('UPDATE "UserCredentialToken" SET "expiresAt" = $2::timestamp WHERE "tokenHash"=$1', [createHash("sha256").update(token(expired.credentialLink)).digest("hex"), new Date(Date.now() - 60_000).toISOString()]);
  assert.equal(expiredUpdate.rowCount, 1, "expiry fixture updated");
  check("expired invitation denied", (await accept(expired.credentialLink)).status >= 400);
  const suspended = await issue(adminCookie, `suspended-${suffix}`);
  await api(`/api/workspace/users/${suspended.user.uuid}`, { method: "PATCH", cookie: adminCookie, body: { status: "disabled" } });
  const enabledInvite = await api(`/api/workspace/users/${suspended.user.uuid}`, { method: "PATCH", cookie: adminCookie, body: { status: "active" } });
  check("suspended invitation enable reissues link without premature activation", enabledInvite.json.data.user.status === "invited" && !!enabledInvite.json.data.credentialLink);
  check("suspended old invitation denied", (await accept(suspended.credentialLink)).status >= 400);
  check("suspended replacement invitation succeeds", (await accept(enabledInvite.json.data.credentialLink)).status === 200);
  check("last administrator disable denied", (await api(`/api/workspace/users/${a.user.uuid}`, { method: "PATCH", cookie: adminCookie, body: { status: "disabled" } })).status === 409);
  check("last administrator delete denied", (await api(`/api/workspace/users/${a.user.uuid}`, { method: "DELETE", cookie: adminCookie })).status === 409);
  const admin2 = await issue(adminCookie, `second-admin-${suffix}`, true);
  await accept(admin2.credentialLink);
  const results = await Promise.all([a.user.uuid, admin2.user.uuid].map((uuid) => api(`/api/workspace/users/${uuid}`, { method: "PATCH", cookie: adminCookie, body: { workspaceAdmin: false } })));
  check("concurrent admin demotions cannot remove all admins", results.filter((r) => r.status === 200).length === 1);
  const activeAdmins = await db.query('SELECT count(*)::int AS count FROM "User" WHERE "companyUuid"=$1 AND "workspaceAdmin"=true AND status=\'active\'', [a.company.uuid]);
  check("persistence retains one active admin", activeAdmins.rows[0].count === 1);
  const survivor = results[0].status === 200 ? admin2.user : a.user;
  const survivorCookie = await login(a.company.uuid, survivor.username);
  const removedCookie = await login(a.company.uuid, member.user.username);
  const groupUuid = randomUUID(), projectUuid = randomUUID(), ideaUuid = randomUUID();
  await db.query('INSERT INTO "ProjectGroup" (uuid,"companyUuid",name,visibility,"createdByUuid","updatedAt") VALUES ($1,$2,$3,\'private\',$4,now())', [groupUuid, a.company.uuid, `identity-reuse-group-${suffix}`, member.user.uuid]);
  await db.query('INSERT INTO "Project" (uuid,"companyUuid",name,visibility,"createdByUuid","groupUuid","updatedAt") VALUES ($1,$2,$3,\'private\',$4,$5,now())', [projectUuid, a.company.uuid, `identity-reuse-project-${suffix}`, member.user.uuid, groupUuid]);
  await db.query('INSERT INTO "ProjectMember" (uuid,"companyUuid","projectUuid","userUuid",role,"updatedAt") VALUES ($1,$2,$3,$4,\'admin\',now())', [randomUUID(), a.company.uuid, projectUuid, member.user.uuid]);
  await db.query('INSERT INTO "ProjectGroupMember" (uuid,"companyUuid","groupUuid","userUuid",role,"updatedAt") VALUES ($1,$2,$3,$4,\'admin\',now())', [randomUUID(), a.company.uuid, groupUuid, member.user.uuid]);
  await db.query('INSERT INTO "Idea" (uuid,"companyUuid","projectUuid",title,"createdByUuid","assigneeType","assigneeUuid","updatedAt") VALUES ($1,$2,$3,$4,$5,\'user\',$5,now())', [ideaUuid, a.company.uuid, projectUuid, `identity-reuse-history-${suffix}`, member.user.uuid]);
  check("remove user succeeds", (await api(`/api/workspace/users/${member.user.uuid}`, { method: "DELETE", cookie: survivorCookie })).status === 200);
  check("removed session denied", (await api("/api/auth/me", { cookie: removedCookie })).status === 401);
  check("removed owner key denied REST/MCP", (await api("/api/projects", { key })).status === 401 && (await mcp(key)) === 401);
  const tombstone = await db.query('SELECT uuid,status,"passwordHash",username,"localEmail",email FROM "User" WHERE uuid=$1', [member.user.uuid]);
  check("removed account retains historical UUID and no password", tombstone.rows[0].status === "deleted" && tombstone.rows[0].passwordHash === null);
  check("removal releases both login identifiers but keeps display email", tombstone.rows[0].username === null && tombstone.rows[0].localEmail === null && tombstone.rows[0].email === member.user.email);
  const replacement = await issue(survivorCookie, member.user.username);
  check("identity reuse creates fresh UUID and no admin privilege", replacement.user.uuid !== member.user.uuid && !replacement.user.workspaceAdmin && replacement.user.status === "invited");
  check("old invitation and reset remain invalid after recreation", (await accept(member.credentialLink)).status >= 400 && (await accept(expiredReset.json.data.credentialLink)).status >= 400);
  check("replacement accepts its own invitation", (await accept(replacement.credentialLink)).status === 200);
  const replacementCookie = await login(a.company.uuid, replacement.user.email);
  check("replacement cannot administer users", (await api("/api/workspace/users", { cookie: replacementCookie })).status === 403);
  check("replacement does not inherit private project access", (await api(`/api/projects/${projectUuid}`, { cookie: replacementCookie })).status === 404);
  check("old session and key still denied after replacement activates", (await api("/api/auth/me", { cookie: removedCookie })).status === 401 && (await api("/api/projects", { key })).status === 401 && (await mcp(key)) === 401);
  const preserved = await db.query('SELECT "createdByUuid","assigneeUuid" FROM "Idea" WHERE uuid=$1', [ideaUuid]);
  check("historical creator and assignee stay on old UUID", preserved.rows[0].createdByUuid === member.user.uuid && preserved.rows[0].assigneeUuid === member.user.uuid);
  for (const table of ["ProjectMember", "ProjectGroupMember"]) {
    const memberships = await db.query(`SELECT "userUuid" FROM "${table}" WHERE "companyUuid"=$1 AND "userUuid" IN ($2,$3)`, [a.company.uuid, member.user.uuid, replacement.user.uuid]);
    check(`${table} retained only for old UUID`, memberships.rows.length === 1 && memberships.rows[0].userUuid === member.user.uuid);
  }
  const ownership = await db.query('SELECT "ownerUuid" FROM "Agent" WHERE uuid=$1', [agent.json.data.uuid]);
  check("Agent ownership stays on deleted UUID", ownership.rows[0].ownerUuid === member.user.uuid);
  const audit = await db.query('SELECT action FROM "LocalUserAudit" WHERE "targetUuid"=$1', [member.user.uuid]);
  check("lifecycle audit persists", audit.rows.length >= 4);
  console.log(`Local-user integration complete: ${checks} checks passed. Disposable fixtures retained for inspection.`);
} finally { await db.end(); }

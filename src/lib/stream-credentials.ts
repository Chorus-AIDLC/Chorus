import type { AuthContext, AgentAuthContext } from "@/types/auth";
import { prisma } from "@/lib/prisma";
import { getUserAccountState } from "@/services/local-user.service";
import { computeEffectivePermissions } from "@/lib/authz/permissions";

export type StreamCredential =
  | { kind: "session"; sessionVersion?: number; authType?: string; expiresAt?: number }
  | { kind: "oidc"; issuer: string; expiresAt?: number }
  | { kind: "key"; keyUuid: string; expiresAt?: number };

// Keep verified credential details internal, not in public auth/profile DTOs.
const credentials = new WeakMap<object, StreamCredential>();
export function rememberStreamCredential(identity: object, credential: StreamCredential) {
  credentials.set(identity, credential);
  return identity;
}
export function streamCredential(identity: object) { return credentials.get(identity); }

/** Low-frequency state check of an already verified identity. No token crypto,
 * profile refresh, auth fallback or API-key lastUsed write on this path. */
export async function validateStreamCredential(auth: AuthContext, credential: StreamCredential): Promise<boolean> {
  if (credential.expiresAt !== undefined && Date.now() >= credential.expiresAt) return false;
  if (credential.kind === "key") {
    const key = await prisma.apiKey.findUnique({ where: { uuid: credential.keyUuid }, include: { agent: true } });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt.getTime() <= Date.now()) ||
        key.agent.uuid !== auth.actorUuid || key.agent.companyUuid !== auth.companyUuid ||
        (key.agent.ownerUuid ?? undefined) !== auth.ownerUuid) return false;
    const effective = computeEffectivePermissions(key.agent.roles, key.agent.permissions);
    if ((auth as AgentAuthContext).permissions.some(permission => !effective.has(permission))) return false;
    // Expiry may be shortened after this connection was established.
    credential.expiresAt = key.expiresAt?.getTime();
    if (!auth.ownerUuid) return true;
    const owner = await getUserAccountState(auth.companyUuid, auth.ownerUuid);
    return !!owner && owner.companyUuid === auth.companyUuid && !owner.deletedAt && owner.status === "active" &&
      (owner.authType !== "local" || (owner.company.localAuthEnabled && !owner.company.oidcEnabled));
  }
  const user = await getUserAccountState(auth.companyUuid, auth.actorUuid);
  if (!user || user.companyUuid !== auth.companyUuid || user.deletedAt || user.status !== "active") return false;
  if (credential.kind === "oidc") {
    const company = await prisma.company.findFirst({ where: { uuid: auth.companyUuid, oidcEnabled: true, oidcIssuer: credential.issuer, localAuthEnabled: false }, select: { uuid: true } });
    return user.authType !== "local" && !!company;
  }
  if (user.authType === "local") {
    return user.company.localAuthEnabled && !user.company.oidcEnabled && credential.authType === "local" &&
      Number.isInteger(credential.sessionVersion) && credential.sessionVersion === user.sessionVersion;
  }
  return credential.authType !== "local" && !user.company.localAuthEnabled;
}

// src/lib/project-access-action.ts
// Server-action adapters for the project-access service.
// Server actions return `{ success: false, error }` instead of throwing, so these
// helpers translate ProjectNotFoundError / ProjectAccessDeniedError into that
// shape. Usage at the top of an action:
//
//   const denied = await denyUnlessEntityAccess(auth, "task", taskUuid, "editor");
//   if (denied) return denied;

import {
  requireEntityAccess,
  requireProjectAccess,
  requireProjectOperation,
  requireProposalInputsAccess,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  type AccessEntityType,
  type ProjectMemberRole,
  type ProjectOperation,
} from "@/services/project-access.service";
import type { AuthContext } from "@/types/auth";

export interface AccessDeniedResult {
  success: false;
  error: string;
}

async function translate(check: () => Promise<unknown>): Promise<AccessDeniedResult | null> {
  try {
    await check();
    return null;
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof ProjectAccessDeniedError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
}

export function denyUnlessProjectAccess(
  auth: AuthContext,
  projectUuid: string,
  min: ProjectMemberRole,
): Promise<AccessDeniedResult | null> {
  return translate(() => requireProjectAccess(auth, projectUuid, min));
}

export function denyUnlessEntityAccess(
  auth: AuthContext,
  entityType: AccessEntityType,
  entityUuid: string,
  min: ProjectMemberRole,
): Promise<AccessDeniedResult | null> {
  return translate(() => requireEntityAccess(auth, entityType, entityUuid, min));
}

export function denyUnlessProjectOperation(
  auth: AuthContext,
  projectUuid: string,
  op: ProjectOperation,
): Promise<AccessDeniedResult | null> {
  return translate(() => requireProjectOperation(auth, projectUuid, op));
}

// Every stored input of the proposal must still be readable by the caller.
export function denyUnlessProposalInputsAccess(
  auth: AuthContext,
  proposalUuid: string,
): Promise<AccessDeniedResult | null> {
  return translate(() => requireProposalInputsAccess(auth, proposalUuid));
}

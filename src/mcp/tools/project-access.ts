// Resolve every project touched by an MCP call before its handler or presence.
// Entity resolution is company-scoped; caller-supplied projectUuid is never
// trusted as the project of an existing entity.
import { prisma } from "@/lib/prisma";
import {
  getProjectAccess,
  levelAtLeast,
  ProjectAccessDeniedError,
  requireProjectOperation,
  resolveEntityProjectUuid,
  type AccessEntityType,
} from "@/services/project-access.service";
import type { AgentAuthContext } from "@/types/auth";
import type { ToolProjectAccessPolicy } from "./permission-map";

export interface AuthorizedResource {
  entityType: AccessEntityType;
  entityUuid: string;
  projectUuid: string;
  subEntityType?: string;
  subEntityUuid?: string;
}

interface ResourceInput {
  entityType: AccessEntityType;
  entityUuid: string;
  // Existing entities supplied alongside a project must actually belong to it.
  matchDeclaredProject?: boolean;
  requiredLevel?: "viewer" | "editor";
  subEntityType?: string;
  subEntityUuid?: string;
}

export class McpResourceNotFoundError extends Error {}

function notFound(toolName: string, entityType: string, entityUuid: string): never {
  let text = `${entityType[0].toUpperCase()}${entityType.slice(1)} not found`;
  if (toolName === "chorus_add_comment") text = `${entityType} not found`;
  if (toolName === "chorus_admin_move_project_to_group") text = "Project or project group not found";
  if (toolName === "chorus_admin_delete_project_group") text = "Project group not found";
  if (toolName === "chorus_add_reference") {
    text = `Failed to add reference: Target ${entityType} with UUID ${entityUuid} not found`;
  }
  if (toolName === "chorus_update_reference" || toolName === "chorus_remove_reference") {
    const action = toolName === "chorus_update_reference" ? "update" : "remove";
    text = `Failed to ${action} reference: Reference with UUID ${entityUuid} not found`;
  }
  throw new McpResourceNotFoundError(text);
}

const ENTITY_FIELDS = {
  ideaUuid: "idea",
  taskUuid: "task",
  proposalUuid: "proposal",
  documentUuid: "document",
  commentUuid: "comment",
} as const;

function isEntityType(value: unknown): value is AccessEntityType {
  return typeof value === "string" &&
    ["project", "idea", "task", "proposal", "document", "comment"].includes(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Only reviewed company / filtered tools skip the single-resource gate.
 * Authorization errors propagate to the wrapper; a DB failure never runs a
 * handler and never emits presence.
 */
export async function authorizeToolProjectAccess(
  toolName: string,
  params: Record<string, unknown>,
  auth: AgentAuthContext,
  policy: ToolProjectAccessPolicy,
): Promise<AuthorizedResource[]> {
  if (policy.scope !== "resource") return [];

  const inputs: ResourceInput[] = [];
  let allowEmpty = false;
  const declaredProject = typeof params.projectUuid === "string" ? params.projectUuid : undefined;
  const add = (
    entityType: AccessEntityType,
    entityUuid: string,
    matchDeclaredProject = false,
    requiredLevel?: "viewer" | "editor",
  ) => inputs.push({ entityType, entityUuid, matchDeclaredProject, requiredLevel });

  // Mention search remains company-wide without a complete entity context.
  // With one, authorize the actual entity before the service can inspect its
  // project membership or idea-assignment context.
  if (toolName === "chorus_search_mentionables") {
    allowEmpty = true;
    if (isEntityType(params.entityType) && typeof params.entityUuid === "string") {
      add(params.entityType, params.entityUuid);
    }
  }

  if (toolName === "chorus_admin_delete_project_group" && typeof params.groupUuid === "string") {
    const group = await prisma.projectGroup.findFirst({
      where: { companyUuid: auth.companyUuid, uuid: params.groupUuid },
      select: { uuid: true },
    });
    if (!group) notFound(toolName, "project group", params.groupUuid);
    // Deliberately enumerate the full group, not the caller's accessible subset:
    // deleteProjectGroup deletes or ungroups every contained project.
    const projects = await prisma.project.findMany({
      where: { companyUuid: auth.companyUuid, groupUuid: params.groupUuid },
      select: { uuid: true },
    });
    for (const project of projects) add("project", project.uuid);
    allowEmpty = true;
  }

  if (declaredProject) add("project", declaredProject);
  for (const [field, entityType] of Object.entries(ENTITY_FIELDS)) {
    if (typeof params[field] === "string") add(entityType, params[field], true);
  }
  if (isEntityType(params.targetType) && typeof params.targetUuid === "string") {
    add(params.targetType, params.targetUuid, true);
  }
  if (typeof params.targetProjectUuid === "string") add("project", params.targetProjectUuid);
  if (typeof params.parentUuid === "string") add("idea", params.parentUuid, true);

  // Reference tools historically name the artifact identifier `uuid`.
  const referenceUuid = typeof params.referenceUuid === "string" ? params.referenceUuid :
    ["chorus_update_reference", "chorus_remove_reference"].includes(toolName) &&
    typeof params.uuid === "string" ? params.uuid : undefined;
  if (referenceUuid) {
    const reference = await prisma.referenceArtifact.findFirst({
      where: { companyUuid: auth.companyUuid, uuid: referenceUuid },
      select: { targetType: true, targetUuid: true },
    });
    if (!reference || !isEntityType(reference.targetType)) notFound(toolName, "reference", referenceUuid);
    inputs.push({
      entityType: reference.targetType,
      entityUuid: reference.targetUuid,
      matchDeclaredProject: true,
      subEntityType: "reference",
      subEntityUuid: referenceUuid,
    });
  }

  // Sessions have no project of their own. Resolve their active task checkins
  // without getSession(), which updates lastActiveAt before returning.
  if (typeof params.sessionUuid === "string") {
    const session = await prisma.agentSession.findFirst({
      where: { companyUuid: auth.companyUuid, uuid: params.sessionUuid },
      select: {
        agentUuid: true,
        taskCheckins: { where: { checkoutAt: null }, select: { taskUuid: true } },
      },
    });
    if (!session) notFound(toolName, "session", params.sessionUuid);
    if (session.agentUuid !== auth.actorUuid) {
      throw new ProjectAccessDeniedError("No permission to access this Session");
    }
    // Explicit checkin/checkout and work-report operations touch only taskUuid.
    // Session-only reads and batch close touch every active checkin.
    if (typeof params.taskUuid !== "string") {
      for (const checkin of session.taskCheckins) add("task", checkin.taskUuid);
    }
  }

  if (toolName === "chorus_pm_create_proposal" &&
      (params.inputType === "idea" || params.inputType === "document")) {
    // Sources may come from another accessible project; authorize every source
    // without changing the existing cross-project proposal-input contract.
    for (const uuid of strings(params.inputUuids)) add(params.inputType, uuid);
  }
  // Validation reads saved sources, including private ideas' titles and
  // elaboration status. Submission runs the same validator. The request only
  // contains proposalUuid, so authorizing request fields alone is insufficient
  // after a source becomes private or its owner's membership is revoked.
  if (["chorus_pm_validate_proposal", "chorus_pm_submit_proposal"].includes(toolName) &&
      typeof params.proposalUuid === "string") {
    const proposal = await prisma.proposal.findFirst({
      where: { companyUuid: auth.companyUuid, uuid: params.proposalUuid },
      select: { inputType: true, inputUuids: true },
    });
    if (!proposal) notFound(toolName, "proposal", params.proposalUuid);
    if (proposal.inputType === "idea" || proposal.inputType === "document") {
      for (const uuid of strings(proposal.inputUuids)) {
        // Sources are inspected, not changed. The destination proposal still
        // requires editor access, while a source in another project needs viewer.
        add(proposal.inputType, uuid, false, "viewer");
      }
    }
  }
  for (const field of ["addDependsOn", "removeDependsOn", "dependsOnTaskUuids"]) {
    for (const uuid of strings(params[field])) add("task", uuid);
  }
  if (toolName === "chorus_create_tasks" && Array.isArray(params.tasks)) {
    for (const task of params.tasks) {
      if (typeof task === "object" && task !== null && "dependsOnTaskUuids" in task) {
        for (const uuid of strings(task.dependsOnTaskUuids)) add("task", uuid);
      }
    }
  }
  // proposalUuids on list/available tools are filters, not entities being
  // mutated. Those services combine them with the authorized project scope.
  // Inline references on create tools contain external URLs, not entity UUIDs.

  if (inputs.length === 0 && !allowEmpty && typeof params.sessionUuid !== "string") {
    notFound(toolName, "project", declaredProject ?? "");
  }

  const authorized: AuthorizedResource[] = [];
  const resolved = new Map<string, string>();
  for (const input of inputs) {
    const key = `${input.entityType}:${input.entityUuid}`;
    let projectUuid = resolved.get(key);
    if (!projectUuid) {
      projectUuid = (await resolveEntityProjectUuid(auth.companyUuid, input.entityType, input.entityUuid)) ?? undefined;
      if (!projectUuid) notFound(toolName, input.entityType, referenceUuid ?? input.entityUuid);
      resolved.set(key, projectUuid);
    }
    const { project, level } = await getProjectAccess(auth, projectUuid);
    if (!project || level === "none") notFound(toolName, input.entityType, referenceUuid ?? input.entityUuid);
    // Check access before comparing projects so hidden entities never disclose
    // whether they exist via a mismatch error.
    if (input.matchDeclaredProject && declaredProject && projectUuid !== declaredProject) {
      notFound(toolName, input.entityType, referenceUuid ?? input.entityUuid);
    }
    const required = input.requiredLevel ?? policy.required;
    if (required === "manage_project") {
      await requireProjectOperation(auth, projectUuid, "manage_project");
    } else if (!levelAtLeast(level, required)) {
      throw new ProjectAccessDeniedError();
    }
    authorized.push({
      entityType: input.entityType,
      entityUuid: input.entityUuid,
      projectUuid,
      ...(input.subEntityType ? { subEntityType: input.subEntityType, subEntityUuid: input.subEntityUuid } : {}),
    });
  }
  return authorized;
}

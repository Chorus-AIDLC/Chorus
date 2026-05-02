import { ROLE_PRESETS, type PresetKey } from "./presets";
import {
  ACTIONS,
  ALL_PERMISSIONS,
  RESOURCES,
  type Action,
  type Permission,
  type Resource,
} from "./types";

const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isValidPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

export function computeEffectivePermissions(
  roles: readonly string[] | null | undefined,
  customPermissions: readonly string[] | null | undefined,
): Set<Permission> {
  const result = new Set<Permission>();

  if (roles) {
    for (const role of roles) {
      const normalized = role.endsWith("_agent") ? role : `${role}_agent`;
      const preset = ROLE_PRESETS[normalized as PresetKey];
      if (preset) {
        for (const p of preset) result.add(p);
      }
    }
  }

  if (customPermissions) {
    for (const p of customPermissions) {
      if (isValidPermission(p)) result.add(p);
    }
  }

  return result;
}

/**
 * Aggregate a flat permission set into `{ resource: [action, ...] }` shape.
 * Resources with no granted actions are omitted. Used for compact check-in
 * output where a nested object saves tokens vs. repeating each resource prefix
 * in a flat array.
 */
export function groupPermissionsByResource(
  permissions: Iterable<Permission | string>,
): Partial<Record<Resource, Action[]>> {
  const grouped: Partial<Record<Resource, Action[]>> = {};
  for (const p of permissions) {
    if (!isValidPermission(p)) continue;
    const [resource, action] = p.split(":") as [Resource, Action];
    (grouped[resource] ??= []).push(action);
  }
  // Sort actions in canonical order (read, write, admin) for stable output.
  for (const resource of RESOURCES) {
    const actions = grouped[resource];
    if (actions) actions.sort((a, b) => ACTIONS.indexOf(a) - ACTIONS.indexOf(b));
  }
  return grouped;
}

export type Resource = "idea" | "proposal" | "document" | "task" | "project";

export type Action = "read" | "write" | "admin";

export type Permission = `${Resource}:${Action}`;

export const RESOURCES: readonly Resource[] = [
  "idea",
  "proposal",
  "document",
  "task",
  "project",
] as const;

export const ACTIONS: readonly Action[] = ["read", "write", "admin"] as const;

export const ALL_PERMISSIONS: readonly Permission[] = RESOURCES.flatMap(
  (resource) => ACTIONS.map((action) => `${resource}:${action}` as Permission),
);

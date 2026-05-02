import type { Permission } from "./types";

export const ROLE_PRESETS = {
  developer_agent: [
    "idea:read",
    "proposal:read",
    "document:read",
    "project:read",
    "task:read",
    "task:write",
  ],
  pm_agent: [
    "idea:read",
    "idea:write",
    "proposal:read",
    "proposal:write",
    "document:read",
    "document:write",
    "task:read",
    "task:write",
    "project:read",
    "project:write",
  ],
  admin_agent: [
    "idea:read",
    "idea:write",
    "idea:admin",
    "proposal:read",
    "proposal:write",
    "proposal:admin",
    "document:read",
    "document:write",
    "document:admin",
    "task:read",
    "task:write",
    "task:admin",
    "project:read",
    "project:write",
    "project:admin",
  ],
} as const satisfies Record<string, readonly Permission[]>;

export type PresetKey = keyof typeof ROLE_PRESETS;

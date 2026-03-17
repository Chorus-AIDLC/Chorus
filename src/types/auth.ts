// src/types/auth.ts
// Authentication related type definitions (ARCHITECTURE.md §6)
// UUID-Based Architecture: All IDs are UUIDs

export type ActorType = "user" | "agent" | "super_admin";
export type AgentRole = "pm" | "developer" | "admin" | "pm_agent" | "developer_agent" | "admin_agent";

// Authentication context for the current request (UUID-based)
export interface AuthContext {
  type: ActorType;
  companyUuid: string;  // Company UUID
  actorUuid: string;    // User UUID or Agent UUID
  roles?: AgentRole[];  // Agent role list
  ownerUuid?: string;   // Agent's Owner User UUID
}

// User authentication context
export interface UserAuthContext extends AuthContext {
  type: "user";
  email?: string;
  name?: string;
}

// Agent authentication context
export interface AgentAuthContext extends AuthContext {
  type: "agent";
  roles: AgentRole[];
  ownerUuid?: string;
  agentName: string;
  projectUuids?: string[]; // Default projects from X-Chorus-Project/X-Chorus-Project-Group headers (optional)
}

// Super Admin authentication context
export interface SuperAdminAuthContext {
  type: "super_admin";
  email: string;
}

// API Key validation result (UUID-based)
export interface ApiKeyValidationResult {
  valid: boolean;
  agent?: {
    uuid: string;
    companyUuid: string;
    name: string;
    roles: string[];
    ownerUuid: string | null;
  };
  apiKey?: {
    uuid: string;
  };
  error?: string;
}

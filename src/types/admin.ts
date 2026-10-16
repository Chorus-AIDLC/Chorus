// src/types/admin.ts
// Super Admin related type definitions

// Company list item
export interface CompanyListItem {
  uuid: string;
  name: string;
  emailDomains: string[];
  oidcEnabled: boolean;
  userCount: number;
  agentCount: number;
  createdAt: string;
}

// Company detail
export interface CompanyDetail extends CompanyListItem {
  oidcIssuer: string | null;
  oidcClientId: string | null;
  updatedAt: string;
}

// Company creation input
export interface CompanyCreateInput {
  name: string;
  emailDomains?: string[];
  oidcIssuer?: string;
  oidcClientId?: string;
}

// Company update input
export interface CompanyUpdateInput {
  name?: string;
  emailDomains?: string[];
  oidcIssuer?: string | null;
  oidcClientId?: string | null;
  oidcEnabled?: boolean;
}

// Candidate workspace entry for oidc_multi_match responses.
// oidcIssuerHost is the parsed hostname of the Company's oidcIssuer URL
// (falls back to the raw string when URL parsing fails).
export interface IdentifyCandidate {
  uuid: string;
  name: string;
  oidcIssuerHost: string;
}

// A single resolvable login path for an email, used in multi_role responses.
// super_admin / default_auth entries carry no company (no secret material);
// oidc entries carry the full company payload needed to start the OIDC flow.
export type IdentifyRoleOption =
  | { kind: "super_admin" | "default_auth"; company?: never }
  | { kind: "local"; company: { uuid: string; name: string } }
  | { kind: "oidc"; company: { uuid: string; name: string; oidcIssuer: string; oidcClientId: string } };

// Email identification response
export type IdentifyResponse =
  | { type: "super_admin" | "default_auth"; company?: never; candidates?: never; roles?: never; message?: never }
  | { type: "local"; company: { uuid: string; name: string }; candidates?: never; roles?: never; message?: never }
  | { type: "oidc"; company: { uuid: string; name: string; oidcIssuer: string; oidcClientId: string }; candidates?: never; roles?: never; message?: never }
  | { type: "oidc_multi_match"; candidates: IdentifyCandidate[]; company?: never; roles?: never; message?: never }
  | { type: "multi_role"; roles: IdentifyRoleOption[]; company?: never; candidates?: never; message?: never }
  | { type: "not_found"; message: string; company?: never; candidates?: never; roles?: never };

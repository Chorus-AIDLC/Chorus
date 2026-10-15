export type LocalUserStatus = "invited" | "active" | "disabled" | "deleted";
export type CredentialPurpose = "invite" | "reset";

export interface LocalUserDto {
  uuid: string;
  companyUuid: string;
  username: string;
  email: string;
  name: string | null;
  workspaceAdmin: boolean;
  status: LocalUserStatus;
  createdAt: string;
}

export interface CredentialLink {
  url: string;
  expiresAt: string;
  purpose: CredentialPurpose;
}

export interface CreateLocalUserInput {
  username: string;
  email: string;
  name?: string;
  workspaceAdmin?: boolean;
}

export interface BootstrapLocalCompanyInput {
  name: string;
  initialAdmin: Omit<CreateLocalUserInput, "workspaceAdmin">;
}

export interface UpdateLocalUserInput {
  username?: string;
  email?: string;
  name?: string;
  workspaceAdmin?: boolean;
  status?: "active" | "disabled";
}

export interface IssueCredentialInput { purpose: CredentialPurpose }
export interface AcceptLocalCredentialInput { token: string; password: string }
export interface LocalUserMutationResult { user: LocalUserDto; credentialLink?: CredentialLink }

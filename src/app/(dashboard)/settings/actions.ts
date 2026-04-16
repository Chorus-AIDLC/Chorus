"use server";

import { redirect } from "next/navigation";
import { getServerAuthContext } from "@/lib/auth-server";
import {
  listApiKeys,
  createAgent,
  createApiKey,
  deleteAgent,
  getApiKey,
  updateAgent,
  syncApiKeyNames,
} from "@/services/agent.service";
import {
  listAgentSessions,
  closeSession,
  reopenSession,
  type SessionResponse,
} from "@/services/session.service";
import logger from "@/lib/logger";

interface ApiKeyResponse {
  uuid: string;
  keyPrefix: string;
  name: string | null;
  lastUsed: string | null;
  expiresAt: string | null;
  createdAt: string;
  roles: string[];
  agentUuid: string;
  persona: string | null;
}

export async function getApiKeysAction(): Promise<{
  success: boolean;
  data?: ApiKeyResponse[];
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  try {
    const { apiKeys } = await listApiKeys(auth.companyUuid, 0, 100, auth.actorUuid);

    const data = apiKeys.map((key) => ({
      uuid: key.uuid,
      keyPrefix: key.keyPrefix,
      name: key.agent?.name || key.name,
      lastUsed: null,
      expiresAt: key.expiresAt?.toISOString() || null,
      createdAt: key.createdAt.toISOString(),
      roles: key.agent?.roles || [],
      agentUuid: key.agent?.uuid || "",
      persona: key.agent?.persona || null,
    }));

    return { success: true, data };
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch API keys");
    return { success: false, error: "Failed to fetch API keys" };
  }
}

interface CreateAgentKeyInput {
  name: string;
  roles: string[];
  persona: string | null;
}

export async function createAgentAndKeyAction(input: CreateAgentKeyInput): Promise<{
  success: boolean;
  key?: string;
  agentUuid?: string;
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  try {
    // Create agent with specified roles and persona
    const agent = await createAgent({
      companyUuid: auth.companyUuid,
      name: input.name,
      roles: input.roles,
      ownerUuid: auth.actorUuid,
      persona: input.persona,
    });

    // Create API key for the agent
    const apiKey = await createApiKey({
      companyUuid: auth.companyUuid,
      agentUuid: agent.uuid,
      name: input.name,
    });

    return { success: true, key: apiKey.key, agentUuid: agent.uuid };
  } catch (error) {
    logger.error({ err: error }, "Failed to create agent and API key");
    return { success: false, error: "Failed to create API key" };
  }
}

export async function deleteApiKeyAction(uuid: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  try {
    // Verify the API key belongs to the current user
    const apiKey = await getApiKey(auth.companyUuid, uuid, auth.actorUuid);
    if (!apiKey) {
      return { success: false, error: "API key not found" };
    }

    await deleteAgent(apiKey.agentUuid);
    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to delete API key");
    return { success: false, error: "Failed to delete API key" };
  }
}

export async function getAgentSessionsAction(agentUuid: string): Promise<{
  success: boolean;
  data?: SessionResponse[];
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  try {
    const sessions = await listAgentSessions(auth.companyUuid, agentUuid);
    return { success: true, data: sessions };
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch agent sessions");
    return { success: false, error: "Failed to fetch agent sessions" };
  }
}

export async function closeSessionAction(sessionUuid: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  try {
    await closeSession(auth.companyUuid, sessionUuid);
    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to close session");
    return { success: false, error: "Failed to close session" };
  }
}

export async function reopenSessionAction(sessionUuid: string): Promise<{
  success: boolean;
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  try {
    await reopenSession(auth.companyUuid, sessionUuid);
    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to reopen session");
    return { success: false, error: "Failed to reopen session" };
  }
}

interface UpdateAgentInput {
  agentUuid: string;
  name: string;
  roles: string[];
  persona: string | null;
}

export async function updateAgentAction(input: UpdateAgentInput): Promise<{
  success: boolean;
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    await updateAgent(input.agentUuid, {
      name: input.name,
      roles: input.roles,
      persona: input.persona,
    }, auth.companyUuid);

    // Sync API key names to match the updated agent name
    await syncApiKeyNames(input.agentUuid, input.name);

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to update agent");
    return { success: false, error: "Failed to update agent" };
  }
}

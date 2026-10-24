import { z } from "zod";

const fenceSchema = z.object({
  ideaUuid: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  ownerUuid: z.string().uuid(),
  agentUuid: z.string().uuid(),
  role: z.enum(["orchestrator", "product"]),
});

export const wakeContextSchema = z.object({
  version: z.literal(1),
  ideaTeam: fenceSchema.optional(),
  ideaTeams: z.array(fenceSchema).min(1).optional(),
  notificationUuid: z.string().min(1),
  notification: z.object({
    uuid: z.string().min(1),
    action: z.string().min(1),
    entityType: z.string().min(1),
    entityUuid: z.string().min(1),
    entityTitle: z.string(),
    projectUuid: z.string(),
    message: z.string(),
  }).passthrough(),
}).refine((context) => context.notificationUuid === context.notification.uuid)
  .refine((context) => !context.ideaTeams || Boolean(context.ideaTeam && context.ideaTeams.some((fence) =>
    fence.ideaUuid === context.ideaTeam!.ideaUuid && fence.generation === context.ideaTeam!.generation &&
    fence.ownerUuid === context.ideaTeam!.ownerUuid && fence.agentUuid === context.ideaTeam!.agentUuid &&
    fence.role === context.ideaTeam!.role)));

export type WakeContext = z.infer<typeof wakeContextSchema>;

const proofSchema = z.object({
  turnUuid: z.string().uuid(),
  admissionUuid: z.string().uuid(),
}).strict();

export type TurnProof = z.infer<typeof proofSchema>;

export function turnHeaders(primary: TurnProof, supplementary?: TurnProof[]): Record<string, string> {
  const proof = proofSchema.parse(primary);
  const headers: Record<string, string> = {
    "X-Chorus-Turn-Uuid": proof.turnUuid,
    "X-Chorus-Admission-Uuid": proof.admissionUuid,
  };
  if (supplementary !== undefined) {
    const encoded = JSON.stringify(z.array(proofSchema).max(16).parse(supplementary));
    if (encoded.length > 4096) throw new Error("Idea Team turn proofs exceed 4096 characters");
    headers["X-Chorus-Idea-Team-Turns"] = encoded;
  }
  return headers;
}

export function isTurnHeader(name: string): boolean {
  return ["x-chorus-turn-uuid", "x-chorus-admission-uuid", "x-chorus-idea-team-turns"].includes(name.toLowerCase());
}

export function withRunMcpConfig(config: unknown, proof?: TurnProof, supplementary?: TurnProof[]): unknown {
  if (supplementary !== undefined && !proof) throw new Error("Supplementary Idea Team proofs require primary turn/admission identity");
  const snapshot = (config ?? {}) as { mcp?: { servers?: Record<string, unknown> } };
  const servers = { ...snapshot.mcp?.servers };
  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { headers?: Record<string, string> };
    const headers = Object.fromEntries(Object.entries(entry.headers ?? {}).filter(([key]) => !isTurnHeader(key)));
    servers[name] = { ...entry, headers };
  }
  if (proof) {
    const chorus = servers.chorus as { url?: string; transport?: string; headers?: Record<string, string> } | undefined;
    if (!chorus?.url || chorus.transport !== "streamable-http") {
      throw new Error("Exact Chorus wakes require the native Chorus streamable-http MCP server");
    }
    servers.chorus = { ...chorus, headers: { ...chorus.headers, ...turnHeaders(proof, supplementary) } };
  }
  return { ...snapshot, mcp: { ...snapshot.mcp, servers } };
}

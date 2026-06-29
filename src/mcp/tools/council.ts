// src/mcp/tools/council.ts
// Optional external deliberation tool backed by a locally configured council engine.
// The tool is permission-gated and fails closed when the council service is absent.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";
import { registerPermissionedTool } from "./register-helpers";

const COUNCIL_URL = process.env.COUNCIL_ENGINE_URL ?? "http://127.0.0.1:8778";
const COUNCIL_TIMEOUT_MS = 120_000;

interface CouncilQueryResponse {
  text?: string;
  verdict?: string;
  receipt_hash?: string;
  scores?: Record<string, { score: number; note: string }>;
  metadata?: {
    agreements?: string[];
    disagreements?: string[];
    structured?: {
      consensus?: string[];
      contradictions?: string[];
      gaps?: string[];
      unique_insights?: string[];
      blind_spots?: string[];
    } | null;
    session_id?: string;
    receipt_hash?: string;
  };
}

export function registerCouncilTools(server: McpServer, auth: AgentAuthContext) {
  registerPermissionedTool(
    server,
    auth,
    "proposal:write",
    "chorus_council_deliberate",
    {
      description: [
        "Ask the configured council engine to deliberate on a prompt and return a synthesized verdict.",
        "Use before approving proposals, resolving ambiguous requirements, or taking high-stakes project actions.",
        "Returns verdict text plus any agreements, disagreements, structured notes, model scores, and receipt hash supplied by the council service.",
        "Requires proposal:write because prompts can contain project/proposal context and may leave Chorus for the configured council endpoint.",
      ].join(" "),
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe("The question, proposal, or action to deliberate on"),
        strategy: z
          .enum(["fanout", "compete"])
          .default("fanout")
          .describe("fanout: independent answers then synthesis. compete: higher-signal comparison when supported by the council service."),
      }),
    },
    async ({ prompt, strategy }) => {
      let response: Response;
      try {
        response = await fetch(`${COUNCIL_URL}/goat/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, strategy }),
          signal: AbortSignal.timeout(COUNCIL_TIMEOUT_MS),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Council unreachable (${COUNCIL_URL}): ${msg}` }],
          isError: true,
        };
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          content: [{ type: "text" as const, text: `Council HTTP ${response.status}: ${body}` }],
          isError: true,
        };
      }

      const data: CouncilQueryResponse = await response.json();

      const result = {
        verdict: data.text ?? data.verdict ?? "",
        agreements: data.metadata?.agreements ?? [],
        disagreements: data.metadata?.disagreements ?? [],
        structured: data.metadata?.structured ?? null,
        receipt_hash: data.receipt_hash ?? data.metadata?.receipt_hash ?? null,
        session_id: data.metadata?.session_id ?? null,
        model_scores: data.scores
          ? Object.entries(data.scores)
              .map(([model, s]) => ({ model, score: s.score, note: s.note }))
              .sort((a, b) => b.score - a.score)
          : [],
        model_count: Object.keys(data.scores ?? {}).length,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

// src/mcp/tools/council.ts
// Sovereign multi-model council deliberation — wires council-engine into every Chorus agent.
//
// Every Chorus agent (with public-tool access) can call chorus_council_deliberate before
// executing irreversible actions, approving proposals, or resolving ambiguous tasks.
// The council fans out to N independent AI models, synthesizes a verdict, and returns
// an Ed25519 receipt hash proving model independence (receipts-not-vibes).
//
// Council-engine runs locally at COUNCIL_ENGINE_URL (default: http://127.0.0.1:8778).
// Fails gracefully if the council is unreachable — never blocks Chorus operation.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentAuthContext } from "@/types/auth";

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

export function registerCouncilTools(server: McpServer, _auth: AgentAuthContext) {
  server.registerTool(
    "chorus_council_deliberate",
    {
      description: [
        "Ask the sovereign multi-model council to deliberate on a prompt and return a synthesized verdict.",
        "The council fans out to multiple independent AI models; their responses are synthesized into a single structured verdict.",
        "Returns: verdict text, agreements, disagreements, knowledge gaps, blind spots, and an Ed25519 receipt hash proving model independence.",
        "Use before: executing irreversible actions, approving proposals, resolving ambiguous requirements, or whenever a second opinion is needed that cannot be gamed by a single model.",
        "The receipt_hash in the response can be cryptographically verified — it proves which models participated and what they said.",
      ].join(" "),
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .describe("The question, proposal, or action to deliberate on"),
        strategy: z
          .enum(["fanout", "compete"])
          .default("fanout")
          .describe(
            "fanout: all models answer independently then synthesize (default). " +
            "compete: models debate and score each other — higher signal, slower."
          ),
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

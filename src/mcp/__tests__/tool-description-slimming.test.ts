// Guard test for the 7 slimmed MCP tool descriptions
// (slim-mcp-tool-descriptions-enums, P1). Asserts:
//   1. each top-level description is ≤2 sentences and carries no multi-step
//      numbered/bulleted usage procedure (a floor guard against regressing to
//      the old prose-heavy descriptions),
//   2. relocated red-lines landed where the elaboration decided:
//      - create_report's 3-section contract → content param .describe(),
//      - pm_start_elaboration "no Other option" → questions/options param,
//        while the record-outside-conversation rule STAYS in the description.
//
// Uses the same registration harness as reference-notes-describe.test.ts:
// register the tool modules against a capturing fake server, read each tool's
// description + inputSchema (projected to JSON Schema for nested param text).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/project.service", () => ({}));
vi.mock("@/services/task.service", () => ({}));
vi.mock("@/services/proposal.service", () => ({}));
vi.mock("@/services/activity.service", () => ({}));
vi.mock("@/services/session.service", () => ({}));
vi.mock("@/services/checkin.service", () => ({}));
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/comment.service", () => ({}));
vi.mock("@/services/assignment.service", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/search.service", () => ({}));
vi.mock("@/services/agent.service", () => ({ getAgentByUuid: vi.fn() }));
vi.mock("@/services/reference-artifact.service", () => ({
  createReferences: vi.fn(),
  REFERENCE_TYPES: ["docs", "repo", "issue_pr", "paper_blog"],
  REFERENCE_TARGET_TYPES: ["proposal", "task", "idea"],
}));

import type { AgentAuthContext } from "@/types/auth";
import type { Permission } from "@/lib/authz/types";
import { registerPmTools } from "@/mcp/tools/pm";
import { registerPublicTools } from "@/mcp/tools/public";

const toolMeta: Record<string, { description: string; inputSchema: z.ZodType }> = {};
const fakeMcpServer = {
  registerTool: (name: string, meta: unknown) => {
    toolMeta[name] = meta as never;
  },
};

function buildAuth(): AgentAuthContext {
  return {
    type: "agent",
    companyUuid: "company-1",
    actorUuid: "agent-1",
    ownerUuid: "owner-1",
    roles: ["pm_agent"],
    permissions: [
      "idea:write",
      "idea:admin",
      "proposal:write",
      "document:write",
      "task:write",
    ] as Permission[],
    agentName: "PM Agent",
  };
}

beforeEach(() => {
  for (const k of Object.keys(toolMeta)) delete toolMeta[k];
  registerPmTools(
    fakeMcpServer as unknown as Parameters<typeof registerPmTools>[0],
    buildAuth(),
  );
  registerPublicTools(
    fakeMcpServer as unknown as Parameters<typeof registerPublicTools>[0],
    buildAuth(),
  );
});

const SLIMMED_TOOLS = [
  "chorus_create_report",
  "chorus_get_proposal",
  "chorus_pm_start_elaboration",
  "chorus_create_tasks",
  "chorus_update_task",
  "chorus_pm_assign_task",
  "chorus_add_reference",
];

function descOf(tool: string): string {
  const d = toolMeta[tool]?.description;
  if (d === undefined) throw new Error(`tool not registered: ${tool}`);
  return d;
}

// Count sentences by terminal punctuation (. ! ?), ignoring the "." inside
// common non-terminal tokens we use (e.g. "http://", "chorus_get_idea /").
// Heuristic floor guard, not a grammar parser.
function sentenceCount(s: string): number {
  const matches = s.match(/[.!?](\s|$)/g);
  return matches ? matches.length : (s.trim() ? 1 : 0);
}

type JsonSchemaNode = {
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
};

function jsonSchema(tool: string): JsonSchemaNode {
  const schema = toolMeta[tool]?.inputSchema;
  if (!schema) throw new Error(`tool not registered: ${tool}`);
  return z.toJSONSchema(schema, { io: "input" }) as JsonSchemaNode;
}

describe("slimmed tool descriptions — concise what/when", () => {
  for (const tool of SLIMMED_TOOLS) {
    it(`${tool} description is ≤2 sentences`, () => {
      expect(sentenceCount(descOf(tool)), descOf(tool)).toBeLessThanOrEqual(2);
    });

    it(`${tool} description has no multi-step numbered/bulleted procedure`, () => {
      const d = descOf(tool);
      // No markdown bullets ("\n- " / "\n* ") and no "1." / "2." numbered steps.
      expect(/\n\s*[-*]\s/.test(d), `bullet in ${tool}`).toBe(false);
      expect(/\b[1-9]\.\s/.test(d), `numbered step in ${tool}`).toBe(false);
    });
  }
});

describe("relocated red-lines landed in the right place", () => {
  it("create_report: 3-section contract moved OUT of description, INTO content param", () => {
    const d = descOf("chorus_create_report");
    // The section headers must not remain in the top-level description...
    expect(d).not.toMatch(/## Summary/);
    expect(d).not.toMatch(/## Decisions/);
    expect(d).not.toMatch(/## Follow-ups/);
    // ...but must be present in the content param's describe.
    const content = jsonSchema("chorus_create_report").properties?.content;
    expect(content?.description).toMatch(/## Summary/);
    expect(content?.description).toMatch(/## Decisions/);
    expect(content?.description).toMatch(/## Follow-ups/);
  });

  it("pm_start_elaboration: 'no Other option' on options param, record-outside rule in description", () => {
    // The whole-call red-line survives in the description.
    expect(descOf("chorus_pm_start_elaboration")).toMatch(/outside the tool|discussed outside|audit trail/i);
    // The param-bound red-line lives on the nested options param.
    const options =
      jsonSchema("chorus_pm_start_elaboration").properties?.questions?.items?.properties?.options;
    expect(options?.description).toMatch(/other/i);
    expect(options?.description).toMatch(/do not include|don't include|do not add/i);
  });

  it("pm_assign_task: instance-pin detail moved into instanceUuid param", () => {
    const instanceUuid = jsonSchema("chorus_pm_assign_task").properties?.instanceUuid;
    expect(instanceUuid?.description).toMatch(/agent_instance/);
  });

  it("pm_assign_idea: documents project-fixed auto-pinning and same-agent wake deduplication", () => {
    expect(descOf("chorus_pm_assign_idea")).toMatch(/project-fixed/i);
    expect(descOf("chorus_pm_assign_idea")).toMatch(/overriding `instanceUuid`/);
    expect(descOf("chorus_pm_assign_idea")).toMatch(/deduplicated/i);
    expect(descOf("chorus_pm_assign_idea")).toMatch(/same agent/i);
    expect(descOf("chorus_pm_assign_idea")).toMatch(/does not request another wake/i);
  });
});

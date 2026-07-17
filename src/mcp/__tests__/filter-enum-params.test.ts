// Strict-enum coverage for the MCP filter/type params converted from
// z.string().describe("...: a,b,c") to z.enum([...]) (slim-mcp-tool-descriptions-enums, P1).
//
// The elaboration chose `strict`: each enum lists only the CURRENT stored value
// domain — no legacy/derived/never-written values. This test asserts, per param:
//   1. every in-domain value parses,
//   2. an out-of-domain value is REJECTED at the schema layer (before any service call),
//   3. the previously-optional params stay optional (omitting them parses),
//   4. the dropped stale values (idea proposal_created/completed/closed;
//      proposal rejected/revised) are absent from the enum domain.
//
// Mirrors the tool-registration harness from reference-notes-describe.test.ts:
// register the tool modules against a capturing fake server, then read each
// tool's inputSchema and drive it with safeParse (accept/reject) + project to
// JSON Schema (enum-membership introspection).
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

const toolMeta: Record<string, { inputSchema: z.ZodType }> = {};
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

function schemaOf(tool: string): z.ZodType {
  const s = toolMeta[tool]?.inputSchema;
  if (!s) throw new Error(`tool not registered: ${tool}`);
  return s;
}

type JsonSchemaNode = {
  enum?: string[];
  properties?: Record<string, JsonSchemaNode>;
};

// enum members for a given tool.param, robust across optional() wrappers.
function enumMembers(tool: string, param: string): string[] {
  const js = z.toJSONSchema(schemaOf(tool), { io: "input" }) as JsonSchemaNode;
  const node = js.properties?.[param];
  if (!node) throw new Error(`no param ${param} on ${tool}`);
  if (!node.enum) throw new Error(`param ${param} on ${tool} is not an enum`);
  return node.enum;
}

// Each row: tool, param, the base (valid-required) args, the strict domain,
// one out-of-domain value, and whether the param is optional.
const CASES: Array<{
  tool: string;
  param: string;
  base: Record<string, unknown>;
  domain: string[];
  bad: string;
  optional: boolean;
}> = [
  {
    tool: "chorus_get_ideas",
    param: "status",
    base: { projectUuid: "p-1" },
    domain: ["open", "elaborating", "elaborated"],
    bad: "proposal_created",
    optional: true,
  },
  {
    tool: "chorus_list_tasks",
    param: "status",
    base: { projectUuid: "p-1" },
    domain: ["open", "assigned", "in_progress", "to_verify", "done", "closed"],
    bad: "verifying",
    optional: true,
  },
  {
    tool: "chorus_list_tasks",
    param: "priority",
    base: { projectUuid: "p-1" },
    domain: ["low", "medium", "high"],
    bad: "urgent",
    optional: true,
  },
  {
    tool: "chorus_get_documents",
    param: "type",
    base: { projectUuid: "p-1" },
    domain: ["prd", "tech_design", "adr", "spec", "guide", "report"],
    bad: "runbook",
    optional: true,
  },
  {
    tool: "chorus_get_proposals",
    param: "status",
    base: { projectUuid: "p-1" },
    domain: ["draft", "pending", "approved", "closed"],
    bad: "rejected",
    optional: true,
  },
  {
    tool: "chorus_pm_add_document_draft",
    param: "type",
    base: { proposalUuid: "pr-1", title: "t", content: "c" },
    domain: ["prd", "tech_design", "adr", "spec", "guide", "report"],
    bad: "runbook",
    optional: false,
  },
  {
    tool: "chorus_pm_update_document_draft",
    param: "type",
    base: { proposalUuid: "pr-1", draftUuid: "d-1" },
    domain: ["prd", "tech_design", "adr", "spec", "guide", "report"],
    bad: "runbook",
    optional: true,
  },
];

describe("filter/type params — strict enum domains", () => {
  for (const c of CASES) {
    describe(`${c.tool}.${c.param}`, () => {
      it("declares exactly the strict enum domain", () => {
        expect(new Set(enumMembers(c.tool, c.param))).toEqual(new Set(c.domain));
      });

      it("accepts every in-domain value", () => {
        for (const v of c.domain) {
          const r = schemaOf(c.tool).safeParse({ ...c.base, [c.param]: v });
          expect(r.success, `${c.param}=${v}`).toBe(true);
        }
      });

      it("rejects an out-of-domain value at the schema layer", () => {
        const r = schemaOf(c.tool).safeParse({ ...c.base, [c.param]: c.bad });
        expect(r.success, `${c.param}=${c.bad} should be rejected`).toBe(false);
      });

      it(c.optional ? "is optional (omitting parses)" : "is required (omitting fails)", () => {
        const r = schemaOf(c.tool).safeParse({ ...c.base });
        expect(r.success).toBe(c.optional);
      });
    });
  }
});

describe("dropped stale values are absent from the enum domain", () => {
  it("chorus_get_ideas.status excludes proposal_created/completed/closed", () => {
    const m = new Set(enumMembers("chorus_get_ideas", "status"));
    for (const stale of ["proposal_created", "completed", "closed"]) {
      expect(m.has(stale), stale).toBe(false);
    }
  });

  it("chorus_get_proposals.status excludes rejected/revised", () => {
    const m = new Set(enumMembers("chorus_get_proposals", "status"));
    for (const stale of ["rejected", "revised"]) {
      expect(m.has(stale), stale).toBe(false);
    }
  });
});

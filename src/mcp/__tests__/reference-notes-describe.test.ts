// Docs-nudge coverage for the reference `notes` MCP parameter
// (clamp-reference-notes). The elaboration chose a docs-only soft nudge
// (~200 chars / ≤2 lines) with NO server-side length cap, so this test asserts:
//   1. the concise-summary wording is present on the shared inline schema, on
//      chorus_add_reference, and on chorus_update_reference `notes` describe,
//   2. `notes` stays an optional, UNBOUNDED string (no maxLength introduced)
//      — an arbitrarily long value still parses.
// It mirrors the tool-registration harness from inline-references-create.test.ts,
// then reads descriptions via zod's JSON-Schema projection (robust across the
// z.preprocess/optional wrappers that zArray/optional add).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

vi.mock("@/services/reference-artifact.service", () => ({
  createReferences: vi.fn(),
  REFERENCE_TYPES: ["docs", "repo", "issue_pr", "paper_blog"],
  REFERENCE_TARGET_TYPES: ["proposal", "task", "idea"],
}));
vi.mock("@/services/idea.service", () => ({ createIdea: vi.fn() }));
vi.mock("@/services/proposal.service", () => ({
  createProposal: vi.fn(),
  checkIdeasAssignee: vi.fn(),
  checkIdeasAvailability: vi.fn(),
  getProposalByUuid: vi.fn(),
}));
vi.mock("@/services/project.service", () => ({
  projectExists: vi.fn(),
  getProjectByUuid: vi.fn(),
}));
vi.mock("@/services/task.service", () => ({
  createTask: vi.fn(),
  addTaskDependency: vi.fn(),
  createAcceptanceCriteria: vi.fn(),
}));
vi.mock("@/services/activity.service", () => ({ createActivity: vi.fn() }));
vi.mock("@/services/document.service", () => ({}));
vi.mock("@/services/agent.service", () => ({ getAgentByUuid: vi.fn() }));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/comment.service", () => ({}));
vi.mock("@/services/assignment.service", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/session.service", () => ({}));
vi.mock("@/services/search.service", () => ({}));
vi.mock("@/services/checkin.service", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

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
  vi.clearAllMocks();
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

type JsonSchemaNode = {
  description?: string;
  maxLength?: number;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
};

// Project a registered tool's input schema to input-side JSON Schema so nested
// descriptions survive the z.preprocess/optional wrappers.
function jsonSchema(tool: string): JsonSchemaNode {
  const schema = toolMeta[tool]?.inputSchema;
  if (!schema) throw new Error(`tool not registered: ${tool}`);
  return z.toJSONSchema(schema, { io: "input" }) as JsonSchemaNode;
}

// Top-level `notes` param (chorus_add_reference / chorus_update_reference).
function topNotes(tool: string): JsonSchemaNode {
  const n = jsonSchema(tool).properties?.notes;
  if (!n) throw new Error(`no top-level notes on ${tool}`);
  return n;
}

// Inline `references[].notes` item. On chorus_pm_create_idea / _create_proposal
// the references[] param is top-level; on chorus_create_tasks it is nested under
// each task (tasks[].references[]).
function inlineNotes(tool: string): JsonSchemaNode {
  const root = jsonSchema(tool).properties;
  const refs =
    root?.references?.items?.properties?.notes ??
    root?.tasks?.items?.properties?.references?.items?.properties?.notes;
  if (!refs) throw new Error(`no references[].notes on ${tool}`);
  return refs;
}

const CONCISE = /concise/i;
const TWO_HUNDRED = /200/;

describe("reference notes describe — concise nudge", () => {
  it("chorus_add_reference notes describe nudges a concise ~200-char summary", () => {
    const n = topNotes("chorus_add_reference");
    expect(n.description).toMatch(CONCISE);
    expect(n.description).toMatch(TWO_HUNDRED);
  });

  it("chorus_update_reference notes describe nudges concise + keeps clear/omit semantics", () => {
    const n = topNotes("chorus_update_reference");
    expect(n.description).toMatch(CONCISE);
    expect(n.description).toMatch(TWO_HUNDRED);
    expect(n.description).toMatch(/null clears/i);
    expect(n.description).toMatch(/omit to leave unchanged/i);
  });

  it("shared inline references[] notes describe (create idea/proposal/tasks) nudges concise", () => {
    for (const tool of [
      "chorus_pm_create_idea",
      "chorus_pm_create_proposal",
      "chorus_create_tasks",
    ]) {
      const n = inlineNotes(tool);
      expect(n.description, `${tool} inline notes`).toMatch(CONCISE);
      expect(n.description, `${tool} inline notes`).toMatch(TWO_HUNDRED);
    }
  });
});

describe("reference notes — no length cap introduced (docs-only nudge)", () => {
  it("chorus_add_reference notes has no maxLength", () => {
    expect(topNotes("chorus_add_reference").maxLength).toBeUndefined();
  });

  it("chorus_update_reference notes has no maxLength", () => {
    expect(topNotes("chorus_update_reference").maxLength).toBeUndefined();
  });

  it("inline references[] notes has no maxLength on every create tool", () => {
    for (const tool of [
      "chorus_pm_create_idea",
      "chorus_pm_create_proposal",
      "chorus_create_tasks",
    ]) {
      expect(inlineNotes(tool).maxLength, `${tool} inline notes`).toBeUndefined();
    }
  });
});

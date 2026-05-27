// src/__tests__/integration/idea-completion-report.integration.test.ts
//
// Integration smoke for the idea-completion-report change (T7 / AC #1).
//
// Drives the full end-to-end flow that ships with the feature:
//   1. The MCP tool `chorus_create_report` (registered by registerPublicTools,
//      gated on document:write) is invoked with a 5-section Markdown body.
//   2. The Document row is asserted to have type="report", proposalUuid set,
//      version=1, and content stored byte-faithfully.
//   3. The server action `getReportsForIdeaAction(projectUuid, ideaUuid)`
//      that powers the overview-tab Reports list is asserted to return the
//      newly-created report.
//
// Why integration: each piece (tool, service, action) has its own pure unit
// test; this test wires them together against a single in-memory Prisma stub
// to catch any seam mismatch — e.g. type label, proposalUuid plumbing,
// approved-only filter in the action, sort order. We don't spin up real
// Postgres for unit-suite speed.

import { vi, describe, it, expect, beforeEach } from "vitest";

// ===== In-memory Prisma stub =====
//
// Stores just enough state for the three operations the flow exercises:
//   - proposal.findFirst (used by tool's Proposal lookup; proposal.findMany used by action via getProposalsByIdeaUuid)
//   - document.create    (used by createDocument)
//   - document.findMany  (used by listDocumentsByProposalUuids)

interface ProposalRow {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  title: string;
  description: string | null;
  inputType: string;
  inputUuids: string[];
  documentDrafts: unknown;
  taskDrafts: unknown;
  status: string;
  createdByUuid: string;
  createdByType: string;
  reviewedByUuid: string | null;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DocumentRow {
  uuid: string;
  companyUuid: string;
  projectUuid: string;
  type: string;
  title: string;
  content: string | null;
  version: number;
  proposalUuid: string | null;
  createdByUuid: string;
  createdAt: Date;
  updatedAt: Date;
}

const store = vi.hoisted(() => ({
  proposals: [] as Array<{
    uuid: string;
    companyUuid: string;
    projectUuid: string;
    title: string;
    description: string | null;
    inputType: string;
    inputUuids: string[];
    documentDrafts: unknown;
    taskDrafts: unknown;
    status: string;
    createdByUuid: string;
    createdByType: string;
    reviewedByUuid: string | null;
    reviewNote: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
  documents: [] as Array<{
    uuid: string;
    companyUuid: string;
    projectUuid: string;
    type: string;
    title: string;
    content: string | null;
    version: number;
    proposalUuid: string | null;
    createdByUuid: string;
    createdAt: Date;
    updatedAt: Date;
  }>,
  docCounter: 0,
}));

const mockPrisma = vi.hoisted(() => {
  // Defined lazily so each call sees the live mutated `store`.
  return {
    prisma: {
      proposal: {
        findFirst: vi.fn(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
          // store is captured via closure — use globalThis to dodge hoisting init order
          const all = (globalThis as unknown as { __reportStore?: typeof store }).__reportStore;
          if (!all) return null;
          return (
            all.proposals.find(
              (p) => p.uuid === where.uuid && p.companyUuid === where.companyUuid,
            ) ?? null
          );
        }),
        findMany: vi.fn(async ({ where }: { where: { projectUuid: string; companyUuid: string } }) => {
          const all = (globalThis as unknown as { __reportStore?: typeof store }).__reportStore;
          if (!all) return [];
          return all.proposals.filter(
            (p) => p.projectUuid === where.projectUuid && p.companyUuid === where.companyUuid,
          );
        }),
      },
      document: {
        create: vi.fn(async ({ data, select }: { data: Omit<DocumentRow, "createdAt" | "updatedAt" | "version"> & { version?: number }; select?: Record<string, boolean> }) => {
          const all = (globalThis as unknown as { __reportStore?: typeof store }).__reportStore;
          if (!all) throw new Error("store not initialized");
          all.docCounter += 1;
          const now = new Date(`2026-05-25T07:0${all.docCounter % 10}:00.000Z`);
          const row: DocumentRow = {
            uuid: data.uuid ?? `doc-${all.docCounter}`,
            companyUuid: data.companyUuid,
            projectUuid: data.projectUuid,
            type: data.type,
            title: data.title,
            content: data.content ?? null,
            version: data.version ?? 1,
            proposalUuid: data.proposalUuid ?? null,
            createdByUuid: data.createdByUuid,
            createdAt: now,
            updatedAt: now,
          };
          all.documents.push(row);
          // Honor `select` shape just enough — service uses `select` with all
          // fields we already populate, so a shallow copy is sufficient.
          if (select) {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(select)) {
              if (select[key]) out[key] = (row as unknown as Record<string, unknown>)[key];
            }
            return out;
          }
          return row;
        }),
        findMany: vi.fn(async ({ where, orderBy, select }: {
          where: { companyUuid: string; proposalUuid?: { in: string[] }; type?: string };
          orderBy?: { createdAt?: "asc" | "desc" };
          select?: Record<string, boolean>;
        }) => {
          const all = (globalThis as unknown as { __reportStore?: typeof store }).__reportStore;
          if (!all) return [];
          let rows = all.documents.filter((d) => d.companyUuid === where.companyUuid);
          if (where.proposalUuid?.in) {
            const inSet = new Set(where.proposalUuid.in);
            rows = rows.filter((d) => d.proposalUuid !== null && inSet.has(d.proposalUuid));
          }
          if (where.type) {
            rows = rows.filter((d) => d.type === where.type);
          }
          if (orderBy?.createdAt === "desc") {
            rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          if (select) {
            return rows.map((row) => {
              const out: Record<string, unknown> = {};
              for (const key of Object.keys(select)) {
                if (select[key]) out[key] = (row as unknown as Record<string, unknown>)[key];
              }
              return out;
            });
          }
          return rows;
        }),
        count: vi.fn(async () => 0),
      },
    },
  };
});

// Make the store reachable from the prisma stub closure without hitting
// hoisted-init ordering issues.
(globalThis as unknown as { __reportStore?: typeof store }).__reportStore = store;

vi.mock("@/lib/prisma", () => mockPrisma);

// formatCreatedBy hits the user/agent table; stub the whole resolver module
// so neither user nor proposal-review formatting touches Prisma.
vi.mock("@/lib/uuid-resolver", () => ({
  formatCreatedBy: vi.fn(async (uuid: string) => ({
    type: "agent",
    uuid,
    name: "Test Agent",
  })),
  formatAssigneeComplete: vi.fn(async () => null),
  formatAssignee: vi.fn(async () => null),
  formatReview: vi.fn(async () => null),
  getActorName: vi.fn(async () => "Test Actor"),
  batchGetActorNames: vi.fn(async () => new Map()),
  batchFormatCreatedBy: vi.fn(async () => new Map()),
  getSessionName: vi.fn(async () => null),
  validateTargetExists: vi.fn(async () => true),
}));

// The server action calls getServerAuthContext (cookie-backed). Replace it
// with a deterministic user identity scoped to the same companyUuid as the
// agent that created the report — this is the realistic shape of "agent
// writes report, user opens dashboard and the page-action loads it".
const HUMAN_USER_UUID = "44444444-4444-4444-8444-444444444444";
const COMPANY_UUID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/auth-server", () => ({
  getServerAuthContext: vi.fn(async () => ({
    type: "user",
    companyUuid: COMPANY_UUID,
    actorUuid: HUMAN_USER_UUID,
    email: "human@example.com",
    name: "Human",
  })),
}));

// Capture tool registrations so we can drive the chorus_create_report handler
// directly (same pattern as src/mcp/tools/__tests__/create-report.test.ts).
type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;
type ToolConfig = {
  description?: string;
  inputSchema?: { parse?: (input: unknown) => unknown };
};
const tools: Record<string, { config: ToolConfig; handler: ToolHandler }> = {};
function makeServer() {
  return {
    registerTool: (name: string, config: ToolConfig, handler: ToolHandler) => {
      tools[name] = { config, handler };
    },
  };
}

import type { AgentAuthContext } from "@/types/auth";
import { registerPublicTools } from "@/mcp/tools/public";
import { getReportsForIdeaAction } from "@/app/(dashboard)/projects/[uuid]/dashboard/panels/actions";

// Test fixture identity bag.
const PROJECT_UUID = "22222222-2222-4222-8222-222222222222";
const IDEA_UUID = "33333333-3333-4333-8333-333333333333";
const APPROVED_PROPOSAL_UUID = "55555555-5555-4555-8555-555555555555";
const SECOND_APPROVED_PROPOSAL_UUID = "66666666-6666-4666-8666-666666666666";
const DRAFT_PROPOSAL_UUID = "77777777-7777-4777-8777-777777777777";
const AGENT_UUID = "88888888-8888-4888-8888-888888888888";

function makeAgentAuth(permissions: string[]): AgentAuthContext {
  return {
    type: "agent",
    companyUuid: COMPANY_UUID,
    actorUuid: AGENT_UUID,
    agentName: "Yolo Agent",
    roles: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    permissions: permissions as any,
  };
}

function seedFinishedIdea() {
  const baseProposal = {
    companyUuid: COMPANY_UUID,
    projectUuid: PROJECT_UUID,
    title: "Approved proposal",
    description: null,
    inputType: "idea",
    inputUuids: [IDEA_UUID],
    documentDrafts: null,
    taskDrafts: null,
    createdByUuid: HUMAN_USER_UUID,
    createdByType: "user",
    reviewedByUuid: null,
    reviewNote: null,
    reviewedAt: null,
    createdAt: new Date("2026-05-20T00:00:00Z"),
    updatedAt: new Date("2026-05-20T00:00:00Z"),
  };
  store.proposals.push(
    { ...baseProposal, uuid: APPROVED_PROPOSAL_UUID, status: "approved", title: "Proposal A" },
    { ...baseProposal, uuid: SECOND_APPROVED_PROPOSAL_UUID, status: "approved", title: "Proposal B" },
    // Draft proposal — same Idea — must be filtered out by the action.
    { ...baseProposal, uuid: DRAFT_PROPOSAL_UUID, status: "draft", title: "Proposal Draft" },
  );
}

const REPORT_BODY = [
  "## Summary",
  "Shipped feature X. Some 中文 characters and a code fence.",
  "",
  "```ts",
  "const k = 'value';",
  "```",
  "",
  "## Decisions",
  "- Chose A over B because of latency.",
  "",
  "## Follow-ups",
  "None.",
].join("\n");

beforeEach(() => {
  // Reset store + tool registry between tests; do NOT clearAllMocks because
  // that would also wipe the prisma stub implementations.
  store.proposals.length = 0;
  store.documents.length = 0;
  store.docCounter = 0;
  Object.keys(tools).forEach((k) => delete tools[k]);
});

describe("idea-completion-report end-to-end (AC #1)", () => {
  it("chorus_create_report writes a Document(type=report, version=1, byte-faithful) and getReportsForIdeaAction surfaces it", async () => {
    seedFinishedIdea();

    // ----- 1. Register tools with document:write permission -----
    const server = makeServer();
    registerPublicTools(server as never, makeAgentAuth(["document:write"]));
    expect(tools["chorus_create_report"]).toBeDefined();

    // ----- 2. Drive the MCP tool with a real Markdown body -----
    const result = await tools["chorus_create_report"].handler({
      proposalUuid: APPROVED_PROPOSAL_UUID,
      title: "Idea X — completion report",
      content: REPORT_BODY,
    });

    // Tool returns success envelope (not an error).
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    const payload = JSON.parse(result.content[0].text) as {
      documentUuid: string;
      projectUuid: string;
      version: number;
    };
    expect(payload.projectUuid).toBe(PROJECT_UUID);
    expect(payload.version).toBe(1);
    expect(payload.documentUuid).toBeTypeOf("string");

    // ----- 3. Inspect the persisted Document row directly -----
    expect(store.documents.length).toBe(1);
    const persisted = store.documents[0];
    expect(persisted.type).toBe("report");
    expect(persisted.title).toBe("Idea X — completion report");
    expect(persisted.proposalUuid).toBe(APPROVED_PROPOSAL_UUID);
    expect(persisted.projectUuid).toBe(PROJECT_UUID);
    expect(persisted.companyUuid).toBe(COMPANY_UUID);
    expect(persisted.version).toBe(1);
    expect(persisted.createdByUuid).toBe(AGENT_UUID);

    // Byte-faithful: the persisted body equals the input bytes verbatim.
    // The tool MUST NOT mutate, prefix, or suffix content (spec: "Server
    // preserves report content byte-faithfully").
    expect(persisted.content).toBe(REPORT_BODY);
    // The three required headers are all present in the persisted body.
    for (const header of [
      "## Summary",
      "## Decisions",
      "## Follow-ups",
    ]) {
      expect(persisted.content).toContain(header);
    }

    // ----- 4. The dashboard's server action returns the report -----
    const action = await getReportsForIdeaAction(PROJECT_UUID, IDEA_UUID);
    expect(action.success).toBe(true);
    if (!action.success) return; // type-narrow

    // Single approved-proposal-rooted report; draft proposal is filtered out.
    expect(action.data.length).toBe(1);
    expect(action.data[0].uuid).toBe(payload.documentUuid);
    expect(action.data[0].type).toBe("report");
    expect(action.data[0].title).toBe("Idea X — completion report");
    expect(action.data[0].content).toBe(REPORT_BODY);
    expect(action.data[0].version).toBe(1);
  });

  it("aggregates across multiple approved Proposals of the same Idea (createdAt desc)", async () => {
    seedFinishedIdea();

    const server = makeServer();
    registerPublicTools(server as never, makeAgentAuth(["document:write"]));

    // First report on Proposal A.
    const firstResult = await tools["chorus_create_report"].handler({
      proposalUuid: APPROVED_PROPOSAL_UUID,
      title: "First wave recap",
      content: REPORT_BODY,
    });
    const firstUuid = JSON.parse(firstResult.content[0].text).documentUuid;

    // Second report on Proposal B — later createdAt (store mock increments
    // a deterministic counter into the timestamp).
    const secondResult = await tools["chorus_create_report"].handler({
      proposalUuid: SECOND_APPROVED_PROPOSAL_UUID,
      title: "Second wave recap",
      content: REPORT_BODY,
    });
    const secondUuid = JSON.parse(secondResult.content[0].text).documentUuid;

    // Both reports persist with type=report.
    expect(store.documents.length).toBe(2);
    expect(store.documents.every((d) => d.type === "report")).toBe(true);

    // Action aggregates across all approved proposals and returns
    // newest-first.
    const action = await getReportsForIdeaAction(PROJECT_UUID, IDEA_UUID);
    expect(action.success).toBe(true);
    if (!action.success) return;
    expect(action.data.length).toBe(2);
    expect(action.data[0].uuid).toBe(secondUuid); // newest first
    expect(action.data[1].uuid).toBe(firstUuid);
  });

  it("returns an empty list before any report is written (UI hides the section)", async () => {
    seedFinishedIdea();

    const action = await getReportsForIdeaAction(PROJECT_UUID, IDEA_UUID);
    expect(action.success).toBe(true);
    if (!action.success) return;
    expect(action.data).toEqual([]);
  });

  it("rejects writes targeting a non-approved proposal (tool returns isError, no Document persists)", async () => {
    seedFinishedIdea();

    const server = makeServer();
    registerPublicTools(server as never, makeAgentAuth(["document:write"]));

    // Server-side gate (added during PR review): only proposals whose
    // status==='approved' can bear a completion report. A misrouted call
    // against a draft proposal must be rejected — not silently persisted
    // and then hidden by the dashboard filter. The tool short-circuits
    // BEFORE the createDocument call.
    const result = await tools["chorus_create_report"].handler({
      proposalUuid: DRAFT_PROPOSAL_UUID,
      title: "Misrouted to draft",
      content: REPORT_BODY,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("'draft'");
    // No Document was persisted.
    expect(store.documents.length).toBe(0);
    // Reports list (which already filters to approved proposals) stays empty.
    const action = await getReportsForIdeaAction(PROJECT_UUID, IDEA_UUID);
    expect(action.success).toBe(true);
    if (!action.success) return;
    expect(action.data).toEqual([]);
  });

  it("rejects when proposalUuid does not exist (tool surfaces 'Proposal not found', no Document persists)", async () => {
    seedFinishedIdea();

    const server = makeServer();
    registerPublicTools(server as never, makeAgentAuth(["document:write"]));

    const bogusProposalUuid = "99999999-9999-4999-8999-999999999999";
    const result = await tools["chorus_create_report"].handler({
      proposalUuid: bogusProposalUuid,
      title: "Should fail",
      content: REPORT_BODY,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Proposal not found");
    expect(store.documents.length).toBe(0);
  });
});

// End-to-end coverage of the duplicate-rejection gate (spec
// `create-report-force`). Walks the same code path as the AC#1 happy-path
// suite above but exercises the second-call-rejected and force-bypass
// branches against the same in-memory Prisma store.
describe("chorus_create_report duplicate-rejection gate (force flag)", () => {
  it("first call with force omitted succeeds; exactly one report Document persists", async () => {
    seedFinishedIdea();

    const server = makeServer();
    registerPublicTools(server as never, makeAgentAuth(["document:write"]));

    const result = await tools["chorus_create_report"].handler({
      proposalUuid: APPROVED_PROPOSAL_UUID,
      title: "First report",
      content: REPORT_BODY,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as { documentUuid: string };
    expect(payload.documentUuid).toBeTypeOf("string");

    const reportRows = store.documents.filter(
      (d) => d.type === "report" && d.proposalUuid === APPROVED_PROPOSAL_UUID,
    );
    expect(reportRows.length).toBe(1);
    expect(reportRows[0].uuid).toBe(payload.documentUuid);
  });

  it("second call with force omitted is rejected (semantic substring match, not verbatim)", async () => {
    seedFinishedIdea();

    const server = makeServer();
    registerPublicTools(server as never, makeAgentAuth(["document:write"]));

    // First call seeds the prior report.
    const firstResult = await tools["chorus_create_report"].handler({
      proposalUuid: APPROVED_PROPOSAL_UUID,
      title: "First report",
      content: REPORT_BODY,
    });
    expect(firstResult.isError).toBeUndefined();

    // Second call default-rejects.
    const secondResult = await tools["chorus_create_report"].handler({
      proposalUuid: APPROVED_PROPOSAL_UUID,
      title: "Second report",
      content: REPORT_BODY,
    });

    expect(secondResult.isError).toBe(true);
    const text = secondResult.content[0].text.toLowerCase();
    // Implementer's choice of wording — assert on two semantic substrings.
    expect(text).toContain("force");
    expect(text).toMatch(/report|already|exist/);

    // No second row written.
    const reportRows = store.documents.filter(
      (d) => d.type === "report" && d.proposalUuid === APPROVED_PROPOSAL_UUID,
    );
    expect(reportRows.length).toBe(1);
  });

  it("explicit force=false matches the omitted-force behavior (rejected with semantic substrings)", async () => {
    seedFinishedIdea();

    const server = makeServer();
    registerPublicTools(server as never, makeAgentAuth(["document:write"]));

    await tools["chorus_create_report"].handler({
      proposalUuid: APPROVED_PROPOSAL_UUID,
      title: "First report",
      content: REPORT_BODY,
    });

    const secondResult = await tools["chorus_create_report"].handler({
      proposalUuid: APPROVED_PROPOSAL_UUID,
      title: "Second report",
      content: REPORT_BODY,
      force: false,
    });

    expect(secondResult.isError).toBe(true);
    const text = secondResult.content[0].text.toLowerCase();
    expect(text).toContain("force");
    expect(text).toMatch(/report|already|exist/);

    const reportRows = store.documents.filter(
      (d) => d.type === "report" && d.proposalUuid === APPROVED_PROPOSAL_UUID,
    );
    expect(reportRows.length).toBe(1);
  });

  it("force=true succeeds when a prior report exists; a second row is persisted with a different documentUuid", async () => {
    seedFinishedIdea();

    const server = makeServer();
    registerPublicTools(server as never, makeAgentAuth(["document:write"]));

    const firstResult = await tools["chorus_create_report"].handler({
      proposalUuid: APPROVED_PROPOSAL_UUID,
      title: "First report",
      content: REPORT_BODY,
    });
    const firstUuid = JSON.parse(firstResult.content[0].text).documentUuid;

    const secondResult = await tools["chorus_create_report"].handler({
      proposalUuid: APPROVED_PROPOSAL_UUID,
      title: "Second report (forced)",
      content: REPORT_BODY,
      force: true,
    });

    expect(secondResult.isError).toBeUndefined();
    const secondUuid = JSON.parse(secondResult.content[0].text).documentUuid;
    expect(secondUuid).not.toBe(firstUuid);

    // Two report rows now under the proposal — both persisted, second is a
    // new row, not an update of the first.
    const reportRows = store.documents.filter(
      (d) => d.type === "report" && d.proposalUuid === APPROVED_PROPOSAL_UUID,
    );
    expect(reportRows.length).toBe(2);
    expect(new Set(reportRows.map((r) => r.uuid))).toEqual(
      new Set([firstUuid, secondUuid]),
    );

    // The dashboard surfaces both reports under the same Idea (newest first
    // — same ordering contract as the AC#1 multi-proposal aggregation test).
    const action = await getReportsForIdeaAction(PROJECT_UUID, IDEA_UUID);
    expect(action.success).toBe(true);
    if (!action.success) return;
    expect(action.data.length).toBe(2);
  });

  it("force=true on a fresh proposal still works (no regression for callers that always pass force=true)", async () => {
    seedFinishedIdea();

    const server = makeServer();
    registerPublicTools(server as never, makeAgentAuth(["document:write"]));

    const result = await tools["chorus_create_report"].handler({
      proposalUuid: SECOND_APPROVED_PROPOSAL_UUID,
      title: "Solo forced report",
      content: REPORT_BODY,
      force: true,
    });

    expect(result.isError).toBeUndefined();
    const reportRows = store.documents.filter(
      (d) => d.type === "report" && d.proposalUuid === SECOND_APPROVED_PROPOSAL_UUID,
    );
    expect(reportRows.length).toBe(1);
  });
});

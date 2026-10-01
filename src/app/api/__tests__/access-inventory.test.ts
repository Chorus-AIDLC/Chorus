// Inventory guards for project-level access control (task: REST, pages &
// server actions enforcement). These are deliberately source-level: they fail
// when a NEW route or server action is added without an access check, which
// behavioural tests cannot catch.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const API_DIR = join(ROOT, "src", "app", "api");
const DASHBOARD_DIR = join(ROOT, "src", "app", "(dashboard)");
const ACTIONS_DIR = join(ROOT, "src", "actions");

function walk(dir: string, pick: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...walk(full, pick));
    } else if (pick(full)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split(sep).join("/");

// Any of these in a route file counts as an access check.
const ROUTE_ACCESS = /\b(requireProjectAccess|requireEntityAccess|requireProjectOperation|getProjectAccess)\b|project-member\.service/;

// Routes that address a single project or one of its entities MUST check access.
const PROJECT_OR_ENTITY_ROUTE = [
  /^src\/app\/api\/projects\/\[uuid\]\//,
  /^src\/app\/api\/(tasks|ideas|proposals|documents|references)\/\[uuid\]\//,
  /^src\/app\/api\/(comments|references)\/route\.ts$/,
  /^src\/app\/api\/entities\//,
  /^src\/app\/api\/mentionables\/route\.ts$/,
  // DELETE ungroups/deletes every project in the group → per-project manage_project.
  /^src\/app\/api\/project-groups\/\[uuid\]\/route\.ts$/,
];

// Every other route must be listed here with the reason it needs no per-project
// check. Adding a route to the API without classifying it fails the test.
const NON_PROJECT_ROUTES: Record<string, string> = {
  "src/app/api/admin/companies/[uuid]/route.ts": "SuperAdmin panel (unchanged by design)",
  "src/app/api/admin/companies/route.ts": "SuperAdmin panel",
  "src/app/api/admin/login/route.ts": "SuperAdmin auth",
  "src/app/api/admin/session/route.ts": "SuperAdmin auth",
  "src/app/api/agent-connections/route.ts": "agent/daemon connection registry (owner-scoped)",
  "src/app/api/agents/[uuid]/route.ts": "agent management (owner-scoped)",
  "src/app/api/agents/[uuid]/sessions/route.ts": "agent sessions (owner-scoped)",
  "src/app/api/agents/route.ts": "agent management",
  "src/app/api/api-keys/[uuid]/route.ts": "API keys",
  "src/app/api/api-keys/route.ts": "API keys",
  "src/app/api/auth/callback/route.ts": "auth",
  "src/app/api/auth/check-default/route.ts": "auth",
  "src/app/api/auth/company-oidc/route.ts": "auth",
  "src/app/api/auth/default-login/route.ts": "auth",
  "src/app/api/auth/identify/route.ts": "auth",
  "src/app/api/auth/logout/route.ts": "auth",
  "src/app/api/auth/me/route.ts": "auth",
  "src/app/api/auth/sync-token/route.ts": "auth",
  "src/app/api/daemon-directory-requests/[uuid]/route.ts": "daemon directory discovery (owner-scoped)",
  "src/app/api/daemon-directory-requests/route.ts": "daemon directory discovery",
  "src/app/api/daemon-sessions/[sessionUuid]/instruction/route.ts": "daemon session (owner-scoped; wake paths filtered by realtime/notification task)",
  "src/app/api/daemon-sessions/[sessionUuid]/repoint/route.ts": "daemon session (owner-scoped)",
  "src/app/api/daemon-sessions/[sessionUuid]/route.ts": "daemon session (owner-scoped)",
  "src/app/api/daemon-sessions/ad-hoc/route.ts": "daemon session (owner-scoped)",
  "src/app/api/daemon-sessions/route.ts": "daemon session (owner-scoped)",
  "src/app/api/daemon/connection-heartbeat/route.ts": "daemon transport",
  "src/app/api/daemon/control/route.ts": "daemon transport",
  "src/app/api/daemon/directory-request/report/route.ts": "daemon transport",
  "src/app/api/daemon/execution-state/route.ts": "daemon transport",
  "src/app/api/daemon/executions/route.ts": "daemon transport",
  "src/app/api/daemon/pending-turns/route.ts": "daemon transport",
  "src/app/api/daemon/report-interrupt/route.ts": "daemon transport",
  "src/app/api/daemon/resume/route.ts": "daemon transport",
  "src/app/api/daemon/transcript/route.ts": "daemon transport",
  "src/app/api/daemon/turn-advance/route.ts": "daemon transport",
  "src/app/api/events/notifications/route.ts": "per-actor notification channel",
  "src/app/api/events/route.ts": "SSE — filtered by accessible project set (realtime/notifications task)",
  "src/app/api/health/route.ts": "health check",
  "src/app/api/ideas/conversational/route.ts": "conversational idea entry — project checked in daemon-instruction.service (realtime/notifications task)",
  "src/app/api/mcp/route.ts": "MCP transport — central gate in tool wrapper (MCP task)",
  "src/app/api/me/assignments/route.ts": "multi-project — service-layer filtering (listings task)",
  "src/app/api/notifications/[uuid]/archive/route.ts": "own notifications",
  "src/app/api/notifications/[uuid]/read/route.ts": "own notifications",
  "src/app/api/notifications/preferences/route.ts": "own notifications",
  "src/app/api/notifications/read-all/route.ts": "own notifications",
  "src/app/api/notifications/route.ts": "own notifications",
  "src/app/api/notifications/unread-count/route.ts": "own notifications",
  "src/app/api/project-groups/[uuid]/dashboard/route.ts": "multi-project — service-layer filtering (listings task)",
  "src/app/api/project-groups/route.ts": "multi-project — service-layer filtering (listings task)",
  "src/app/api/project-visits/pin/route.ts": "multi-project — service-layer filtering (listings task)",
  "src/app/api/project-visits/route.ts": "multi-project — service-layer filtering (listings task)",
  "src/app/api/project-visits/visit/route.ts": "multi-project — service-layer filtering (listings task)",
  "src/app/api/projects/agent-cwd-options/route.ts": "user's own agent cwd options (no project data)",
  "src/app/api/projects/route.ts": "project list (listings task) + create (creator auto-admin, access core)",
  "src/app/api/search/route.ts": "multi-project — service-layer filtering (listings task)",
  "src/app/api/session/route.ts": "auth session",
  "src/app/api/sessions/[uuid]/route.ts": "agent session (owner-scoped)",
};

describe("API route access inventory", () => {
  const routes = walk(API_DIR, (f) => f.endsWith(`${sep}route.ts`)).map((f) => ({ file: f, path: rel(f) }));

  it("finds the API routes", () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it("every project/entity route calls a project-access helper", () => {
    const missing = routes
      .filter((r) => PROJECT_OR_ENTITY_ROUTE.some((re) => re.test(r.path)))
      .filter((r) => !ROUTE_ACCESS.test(readFileSync(r.file, "utf8")))
      .map((r) => r.path);
    expect(missing).toEqual([]);
  });

  it("every other route is explicitly classified as non-project", () => {
    const unclassified = routes
      .filter((r) => !PROJECT_OR_ENTITY_ROUTE.some((re) => re.test(r.path)))
      .filter((r) => !(r.path in NON_PROJECT_ROUTES))
      .map((r) => r.path);
    expect(unclassified).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    const existing = new Set(routes.map((r) => r.path));
    expect(Object.keys(NON_PROJECT_ROUTES).filter((p) => !existing.has(p))).toEqual([]);
  });
});

// ===== Server actions =====

const ACTION_ACCESS = /\b(denyUnlessProjectAccess|denyUnlessEntityAccess|denyUnlessProjectOperation|requireProjectAccess|requireEntityAccess|requireProjectOperation)\b/;

// Exported server actions that intentionally carry no per-project check.
const NON_PROJECT_ACTIONS: Record<string, string> = {
  "src/actions/project.ts#createProject": "creates a new project; creator becomes admin (access core)",
  "src/app/(dashboard)/projects/[uuid]/dashboard/panels/actions.ts#getProjectsAndGroupsAction":
    "company-wide move-target picker; listProjects/listProjectGroups filter by accessibleProjectWhere(auth)",
  "src/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/actions.ts#getPmAgentsAction":
    "company-wide assignee candidates (caller's agents + company users); no project argument",
  "src/app/(dashboard)/projects/[uuid]/tasks/[taskUuid]/actions.ts#getDeveloperAgentsAction":
    "company-wide assignee candidates (caller's agents + company users); no project argument",
};

// Whole files of server actions that are not project-scoped.
const NON_PROJECT_ACTION_FILES: Record<string, string> = {
  "src/app/(dashboard)/settings/actions.ts": "user/agent settings — no project data",
};

// Split a module into its exported async functions' source text.
function exportedFunctions(source: string): { name: string; body: string }[] {
  const re = /^export async function (\w+)/gm;
  const starts: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) starts.push({ name: m[1], index: m.index });
  return starts.map((s, i) => ({
    name: s.name,
    body: source.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : source.length),
  }));
}

describe("server action access inventory", () => {
  const files = [
    ...walk(DASHBOARD_DIR, (f) => f.endsWith(".ts") && !f.endsWith(".d.ts")),
    ...walk(ACTIONS_DIR, (f) => f.endsWith(".ts")),
  ].filter((f) => /^\s*["']use server["']/m.test(readFileSync(f, "utf8").slice(0, 200)));

  it("finds the server action modules", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("every exported project-scoped server action checks project access", () => {
    const missing: string[] = [];
    for (const file of files) {
      const path = rel(file);
      if (path in NON_PROJECT_ACTION_FILES) continue;
      for (const fn of exportedFunctions(readFileSync(file, "utf8"))) {
        const key = `${path}#${fn.name}`;
        if (key in NON_PROJECT_ACTIONS) continue;
        if (!ACTION_ACCESS.test(fn.body)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("allowlists have no stale entries", () => {
    const paths = new Set(files.map(rel));
    expect(Object.keys(NON_PROJECT_ACTION_FILES).filter((p) => !paths.has(p))).toEqual([]);
    const keys = new Set(
      files.flatMap((f) => exportedFunctions(readFileSync(f, "utf8")).map((fn) => `${rel(f)}#${fn.name}`)),
    );
    expect(Object.keys(NON_PROJECT_ACTIONS).filter((k) => !keys.has(k))).toEqual([]);
  });
});

import type { ChorusMcpClient } from "./mcp-client.js";

// ===== Response types from Chorus MCP tools =====
//
// These mirror the CURRENT (Chorus 0.17.0+) tool output shapes:
//   - chorus_checkin           → { checkinTime, agent, activeProjects, guidance, notifications }
//   - chorus_get_my_assignments → { ideaTracker, taskTracker }
// chorus_checkin returns a per-project `activeProjects` distribution (name +
// activeIdeaCount, NOT a per-idea list); the full per-idea `ideaTracker` lives
// only in chorus_get_my_assignments. Both trackers are Records keyed by project
// UUID. Every field is read defensively (optional chaining) so a missing/renamed
// field degrades to "0"/"none" rather than throwing.

interface IdeaTrackerEntry {
  uuid: string;
  title: string;
  status: string;
  proposals?: number;
  tasks?: number;
}

interface TaskTrackerEntry {
  uuid: string;
  title: string;
  status: string;
  priority: string;
  ac?: { passed?: number; total?: number };
}

interface IdeaTrackerProject {
  name: string;
  ideas?: IdeaTrackerEntry[];
}

interface TaskTrackerProject {
  name: string;
  tasks?: TaskTrackerEntry[];
}

interface CheckinActiveProject {
  name?: string;
  activeIdeaCount?: number;
}

interface CheckinResponse {
  checkinTime?: string;
  agent?: {
    uuid?: string;
    name?: string;
    persona?: string | null;
  };
  activeProjects?: Record<string, CheckinActiveProject>;
  guidance?: string[];
  notifications?: {
    unread?: number;
  };
}

interface AssignmentsResponse {
  ideaTracker?: Record<string, IdeaTrackerProject>;
  taskTracker?: Record<string, TaskTrackerProject>;
}

// ===== Skill catalog =====
//
// All 9 skills bundled with the Chorus OpenClaw plugin
// (packages/openclaw-plugin/skills/*/SKILL.md). The `name` here matches each
// skill's SKILL.md frontmatter `name`, which is exactly the slash command
// OpenClaw exposes (see invocation hint below).

const PLUGIN_SKILLS = [
  { name: "chorus", description: "Platform overview, common tools, setup, and workflow routing" },
  { name: "idea", description: "Claim ideas, run elaboration rounds, prepare for proposal" },
  { name: "brainstorm", description: "Optional divergent-then-convergent dialogue for fuzzy ideas" },
  { name: "proposal", description: "Create proposals with document & task drafts, manage the dependency DAG" },
  { name: "develop", description: "Claim tasks, report work, manage sessions, run wave-based execution" },
  { name: "quick-dev", description: "Skip Idea→Proposal — create tasks directly, execute, verify" },
  { name: "review", description: "Approve/reject proposals, verify tasks, project governance" },
  { name: "yolo", description: "Full-auto AI-DLC pipeline — from prompt to done" },
  { name: "openspec-aware", description: "Opt-in OpenSpec authoring for PM workflows when the openspec CLI is present" },
  { name: "chorus-cli", description: "Install, configure agents (chorus agents add|remove|list), env vars, and chorus mcp operations" },
] as const;

// ===== Formatting helpers =====

// OpenClaw invokes a skill via a BARE slash command of its SKILL.md `name`
// (verified against OpenClaw 2026.5.30 docs/tools/skills.md: "the skill's
// visible name, slash command ... come from SKILL.md frontmatter name ... a
// nested skill with name: research is still invoked as /research"). OpenClaw
// does NOT use Claude Code's `/chorus:<skill>` namespace form.
function skillInvocation(name: string): string {
  return `/${name}`;
}

function formatSkillsList(): string {
  const nameWidth = Math.max(...PLUGIN_SKILLS.map((s) => skillInvocation(s.name).length));
  const lines = PLUGIN_SKILLS.map(
    (s) => `  ${skillInvocation(s.name).padEnd(nameWidth)}  ${s.description}`
  );
  return [
    `Chorus skills (${PLUGIN_SKILLS.length}):`,
    ...lines,
    "",
    "Invoke a skill with its slash command, e.g. /develop or /idea.",
  ].join("\n");
}

function formatStatus(checkin: CheckinResponse, connectionStatus: string): string {
  const projects = Object.values(checkin?.activeProjects ?? {});
  const activeIdeaTotal = projects.reduce(
    (total, p) => total + (p.activeIdeaCount ?? 0),
    0
  );
  const lines: string[] = [
    `Connection: ${connectionStatus}`,
    `Agent: ${checkin?.agent?.name ?? "unknown"}`,
    `Active projects: ${projects.length} (${activeIdeaTotal} active idea(s))`,
    ...projects.map((p) => `  - ${p.name ?? "(unnamed)"}: ${p.activeIdeaCount ?? 0}`),
    `Notifications: ${checkin?.notifications?.unread ?? 0} unread`,
    `Skills: ${PLUGIN_SKILLS.map((s) => s.name).join(", ")}`,
  ];
  return lines.join("\n");
}

function formatTaskList(taskTracker: Record<string, TaskTrackerProject> | undefined): string {
  const lines: string[] = [];
  let total = 0;
  for (const project of Object.values(taskTracker ?? {})) {
    for (const t of project.tasks ?? []) {
      total += 1;
      const ac =
        t.ac && typeof t.ac.total === "number" && t.ac.total > 0
          ? ` (AC ${t.ac.passed ?? 0}/${t.ac.total})`
          : "";
      lines.push(`[${t.status}] [${t.priority}] ${t.title}  (${project.name})${ac}`);
    }
  }
  if (total === 0) {
    return "No assigned tasks.";
  }
  return `Assigned tasks (${total}):\n${lines.join("\n")}`;
}

function formatIdeaList(ideaTracker: Record<string, IdeaTrackerProject> | undefined): string {
  const lines: string[] = [];
  let total = 0;
  for (const project of Object.values(ideaTracker ?? {})) {
    for (const i of project.ideas ?? []) {
      total += 1;
      lines.push(`[${i.status}] ${i.title}  (${project.name})`);
    }
  }
  if (total === 0) {
    return "No assigned ideas.";
  }
  return `Assigned ideas (${total}):\n${lines.join("\n")}`;
}

const HELP_TEXT = [
  "Chorus commands:",
  "  /chorus           Show connection status and summary",
  "  /chorus status    Same as above",
  "  /chorus tasks     List assigned tasks",
  "  /chorus ideas     List assigned ideas",
  "  /chorus skills    List available Chorus skills",
].join("\n");

function errorText(prefix: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${detail}`;
}

// ===== Registration =====

export function registerChorusCommands(
  api: { registerCommand: (command: unknown) => void },
  mcpClient: ChorusMcpClient,
  getStatus: () => string
): void {
  api.registerCommand({
    name: "chorus",
    description: "Chorus plugin commands: status, tasks, ideas, skills",
    acceptsArgs: true,
    async handler(ctx: { args?: string }) {
      const sub = (ctx.args ?? "").trim().toLowerCase();

      // /chorus or /chorus status — connection + checkin summary via slim client.
      if (!sub || sub === "status") {
        try {
          const checkin = (await mcpClient.callTool("chorus_checkin", {})) as CheckinResponse;
          return { text: formatStatus(checkin, getStatus()) };
        } catch (err) {
          return { text: errorText("Failed to check in", err), isError: true };
        }
      }

      // /chorus tasks — assigned tasks via chorus_get_my_assignments.
      if (sub === "tasks") {
        try {
          const data = (await mcpClient.callTool(
            "chorus_get_my_assignments",
            {}
          )) as AssignmentsResponse;
          return { text: formatTaskList(data?.taskTracker) };
        } catch (err) {
          return { text: errorText("Failed to fetch tasks", err), isError: true };
        }
      }

      // /chorus ideas — assigned ideas via chorus_get_my_assignments.
      if (sub === "ideas") {
        try {
          const data = (await mcpClient.callTool(
            "chorus_get_my_assignments",
            {}
          )) as AssignmentsResponse;
          return { text: formatIdeaList(data?.ideaTracker) };
        } catch (err) {
          return { text: errorText("Failed to fetch ideas", err), isError: true };
        }
      }

      // /chorus skills — static catalog of all 9 bundled skills.
      if (sub === "skills") {
        return { text: formatSkillsList() };
      }

      // Unknown subcommand → help.
      return { text: HELP_TEXT };
    },
  });
}

import type { ChorusMcpClient } from "./mcp-client.js";

// ===== Response types from Chorus MCP tools =====

interface CheckinResponse {
  checkinTime: string;
  agent: {
    uuid: string;
    name: string;
    roles: string[];
    persona: string | null;
    systemPrompt: string | null;
  };
  assignments: {
    ideas: AssignedIdea[];
    tasks: AssignedTask[];
  };
  pending: {
    ideasCount: number;
    tasksCount: number;
  };
  notifications: {
    unreadCount: number;
  };
}

interface AssignedIdea {
  uuid: string;
  title: string;
  status: string;
  project: { uuid: string; name: string };
}

interface AssignedTask {
  uuid: string;
  title: string;
  status: string;
  priority: string;
  project: { uuid: string; name: string };
}

interface AssignmentsResponse {
  ideas: AssignedIdea[];
  tasks: AssignedTask[];
}

// ===== Formatting helpers =====

const PLUGIN_SKILLS = [
  { name: "chorus", emoji: "🎵", description: "Platform overview, tools, setup, and workflow routing" },
  { name: "idea", emoji: "💡", description: "Claim ideas, run elaboration, prepare for proposal" },
  { name: "proposal", emoji: "📋", description: "Create proposals with document & task drafts, manage DAG" },
  { name: "develop", emoji: "🔨", description: "Claim tasks, report work, submit for verification" },
  { name: "quick-dev", emoji: "⚡", description: "Skip Idea→Proposal, create tasks directly" },
  { name: "review", emoji: "✅", description: "Approve/reject proposals, verify tasks, governance" },
] as const;

function formatSkillsList(): string {
  const lines = PLUGIN_SKILLS.map(
    (s) => `  ${s.emoji} ${s.name.padEnd(12)} ${s.description}`
  );
  return `Chorus skills (${PLUGIN_SKILLS.length}):\n${lines.join("\n")}\n\nUse: /chorus:<skill-name>  (e.g. /chorus:idea)`;
}

function formatStatus(checkin: CheckinResponse, connectionStatus: string): string {
  const lines: string[] = [
    `Connection: ${connectionStatus}`,
    `Assignments: ${checkin?.pending?.ideasCount ?? 0} ideas, ${checkin?.pending?.tasksCount ?? 0} tasks`,
    `Notifications: ${checkin?.notifications?.unreadCount ?? 0} unread`,
    `Skills: ${PLUGIN_SKILLS.map((s) => s.name).join(", ")}`,
  ];
  return lines.join("\n");
}

function formatTaskList(tasks: AssignedTask[] | undefined): string {
  if (!tasks?.length) {
    return "No assigned tasks.";
  }

  const lines = tasks.map(
    (t) => `[${t.status}] [${t.priority}] ${t.title}  (${t.project.name})`
  );
  return `Assigned tasks (${tasks.length}):\n${lines.join("\n")}`;
}

function formatIdeaList(ideas: AssignedIdea[] | undefined): string {
  if (!ideas?.length) {
    return "No assigned ideas.";
  }

  const lines = ideas.map(
    (i) => `[${i.status}] ${i.title}  (${i.project.name})`
  );
  return `Assigned ideas (${ideas.length}):\n${lines.join("\n")}`;
}

const HELP_TEXT = [
  "Chorus commands:",
  "  /chorus           Show connection status and summary",
  "  /chorus status    Same as above",
  "  /chorus tasks     List assigned tasks",
  "  /chorus ideas     List assigned ideas",
  "  /chorus skills    List available Chorus skills",
].join("\n");

// ===== Registration =====

export function registerChorusCommands(
  api: any,
  mcpClient: ChorusMcpClient,
  getStatus: () => string
): void {
  api.registerCommand({
    name: "chorus",
    description: "Chorus plugin commands: status, tasks, ideas",
    async handler(ctx: { args: string }) {
      const sub = (ctx.args ?? "").trim().toLowerCase();

      // /chorus or /chorus status
      if (!sub || sub === "status") {
        try {
          const checkin = (await mcpClient.callTool("chorus_checkin", {})) as CheckinResponse;
          return { text: formatStatus(checkin, getStatus()) };
        } catch (err) {
          return { text: `Failed to check in: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      // /chorus tasks
      if (sub === "tasks") {
        try {
          const data = (await mcpClient.callTool(
            "chorus_get_my_assignments",
            {}
          )) as AssignmentsResponse;
          return { text: formatTaskList(data?.tasks) };
        } catch (err) {
          return { text: `Failed to fetch tasks: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      // /chorus skills
      if (sub === "skills") {
        return { text: formatSkillsList() };
      }

      // /chorus ideas
      if (sub === "ideas") {
        try {
          const data = (await mcpClient.callTool(
            "chorus_get_my_assignments",
            {}
          )) as AssignmentsResponse;
          return { text: formatIdeaList(data?.ideas) };
        } catch (err) {
          return { text: `Failed to fetch ideas: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      // Unknown subcommand
      return { text: HELP_TEXT };
    },
  });
}

import { describe, it, expect, vi } from "vitest";
import { registerChorusCommands } from "../commands.js";
import type { SpecModeResult } from "../spec-mode.js";

type CommandHandler = (ctx: { args?: string }) => Promise<{ text: string; isError?: boolean }>;

interface RegisteredCommand {
  name: string;
  description: string;
  acceptsArgs: boolean;
  handler: CommandHandler;
}

/** A deterministic spec-mode result so command tests don't depend on cwd/PATH. */
function specResult(overrides: Partial<SpecModeResult> = {}): SpecModeResult {
  return {
    specMode: "lite",
    specReason: "default — OpenSpec not usable (no openspec/ directory)",
    specFail: "",
    openspecUsable: false,
    openspecUsableReason: "no openspec/ directory",
    openspecHint: "npm i -g @fission-ai/openspec && openspec init",
    chorusOpenspecActive: false,
    ...overrides,
  };
}

/** Capture the command object the plugin registers. */
function register(
  responses: Record<string, unknown> | ((name: string) => unknown),
  status = "connected",
  spec: SpecModeResult = specResult(),
) {
  let command: RegisteredCommand | undefined;
  const api = {
    registerCommand: (c: unknown) => {
      command = c as RegisteredCommand;
    },
  };
  const callTool = vi.fn(async (name: string) =>
    typeof responses === "function" ? responses(name) : (responses[name] ?? null),
  );
  const mcpClient = { callTool } as never;
  registerChorusCommands(api as never, mcpClient, () => status, () => spec);
  if (!command) throw new Error("command was not registered");
  return { command, callTool };
}

describe("registerChorusCommands", () => {
  it("registers a single 'chorus' command that accepts args", () => {
    const { command } = register({});
    expect(command.name).toBe("chorus");
    expect(command.acceptsArgs).toBe(true);
  });

  it("/chorus (no args) → status summary from chorus_checkin", async () => {
    const { command, callTool } = register({
      chorus_checkin: {
        agent: { name: "Admin Claude" },
        activeProjects: { p1: { name: "Proj", activeIdeaCount: 2 } },
        notifications: { unread: 3 },
      },
    });
    const res = await command.handler({});
    expect(callTool).toHaveBeenCalledWith("chorus_checkin", {});
    expect(res.text).toContain("Connection: connected");
    expect(res.text).toContain("Agent: Admin Claude");
    expect(res.text).toContain("Active projects: 1 (2 active idea(s))");
    expect(res.text).toContain("- Proj: 2");
    expect(res.text).toContain("Notifications: 3 unread");
    // Spec mode is surfaced in the status block (OpenClaw has no SessionStart hook).
    expect(res.text).toContain("CHORUS_SPEC_MODE=lite");
  });

  it("/chorus status shows CHORUS_OPENSPEC_ACTIVE when OpenSpec is the resolved mode", async () => {
    const { command } = register(
      { chorus_checkin: { agent: { name: "Bot" } } },
      "connected",
      specResult({
        specMode: "openspec",
        specReason: "default — openspec/ directory + openspec CLI both present",
        openspecUsable: true,
        openspecUsableReason: "openspec/ directory + openspec CLI both present",
        chorusOpenspecActive: true,
      }),
    );
    const res = await command.handler({ args: "status" });
    expect(res.text).toContain("CHORUS_SPEC_MODE=openspec");
    expect(res.text).toContain("CHORUS_OPENSPEC_ACTIVE=1");
  });

  it("/chorus spec shows the resolved mode, usability, and install hint", async () => {
    const { command, callTool } = register(
      {},
      "connected",
      specResult({
        specMode: "lite",
        specReason: "default — OpenSpec not usable (no openspec/ directory at /proj/openspec)",
        openspecUsable: false,
        openspecUsableReason: "no openspec/ directory at /proj/openspec",
        openspecHint: "npm i -g @fission-ai/openspec && openspec init",
      }),
    );
    const res = await command.handler({ args: "spec" });
    // spec view does not require a checkin
    expect(callTool).not.toHaveBeenCalled();
    expect(res.text).toContain("Spec mode");
    expect(res.text).toContain("CHORUS_SPEC_MODE=lite");
    expect(res.text).toContain("OpenSpec usable: no");
    expect(res.text).toContain("npm i -g @fission-ai/openspec");
  });

  it("/chorus spec surfaces a halt warning when explicit openspec cannot be honored", async () => {
    const { command } = register(
      {},
      "connected",
      specResult({
        specMode: "openspec",
        specReason: "explicit, but OpenSpec is not installed",
        specFail: "OpenSpec not usable (no openspec/ directory at /proj/openspec)",
        openspecUsable: false,
        openspecUsableReason: "no openspec/ directory at /proj/openspec",
      }),
    );
    const res = await command.handler({ args: "spec" });
    expect(res.text).toContain("WARNING: spec-mode halt");
    expect(res.text).toContain("OpenSpec not usable");
  });

  it("/chorus status behaves the same as no-arg", async () => {
    const { command } = register({ chorus_checkin: { agent: { name: "Bot" } } });
    const res = await command.handler({ args: "status" });
    expect(res.text).toContain("Agent: Bot");
    expect(res.text).toContain("Active projects: 0");
  });

  it("/chorus status surfaces an error result when checkin throws", async () => {
    const { command } = register(() => {
      throw new Error("401 unauthorized");
    });
    const res = await command.handler({ args: "status" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Failed to check in");
    expect(res.text).toContain("401");
  });

  it("/chorus tasks lists assigned tasks with AC counts", async () => {
    const { command, callTool } = register({
      chorus_get_my_assignments: {
        taskTracker: {
          p1: {
            name: "Proj",
            tasks: [
              { uuid: "t1", title: "Do X", status: "open", priority: "high", ac: { passed: 1, total: 3 } },
            ],
          },
        },
      },
    });
    const res = await command.handler({ args: "tasks" });
    expect(callTool).toHaveBeenCalledWith("chorus_get_my_assignments", {});
    expect(res.text).toContain("Assigned tasks (1)");
    expect(res.text).toContain("[open] [high] Do X");
    expect(res.text).toContain("(AC 1/3)");
  });

  it("/chorus tasks → 'No assigned tasks.' when empty", async () => {
    const { command } = register({ chorus_get_my_assignments: { taskTracker: {} } });
    const res = await command.handler({ args: "tasks" });
    expect(res.text).toBe("No assigned tasks.");
  });

  it("/chorus ideas lists assigned ideas", async () => {
    const { command } = register({
      chorus_get_my_assignments: {
        ideaTracker: { p1: { name: "Proj", ideas: [{ status: "in_progress", title: "Cool idea" }] } },
      },
    });
    const res = await command.handler({ args: "ideas" });
    expect(res.text).toContain("Assigned ideas (1)");
    expect(res.text).toContain("[in_progress] Cool idea");
  });

  it("/chorus skills lists all 11 bundled skills with slash-command invocation", async () => {
    const { command } = register({});
    const res = await command.handler({ args: "skills" });
    expect(res.text).toContain("Chorus skills (11)");
    for (const slug of [
      "/chorus",
      "/idea",
      "/brainstorm",
      "/proposal",
      "/develop",
      "/quick-dev",
      "/review",
      "/yolo",
      "/openspec-aware",
      "/spec-lite",
      "/chorus-cli",
    ]) {
      expect(res.text).toContain(slug);
    }
  });

  it("unknown subcommand → help text (includes /chorus spec)", async () => {
    const { command } = register({});
    const res = await command.handler({ args: "frobnicate" });
    expect(res.text).toContain("Chorus commands:");
    expect(res.text).toContain("/chorus skills");
    expect(res.text).toContain("/chorus spec");
  });

  it("/chorus tasks surfaces an error result when the fetch fails", async () => {
    const { command } = register((name) => {
      if (name === "chorus_get_my_assignments") throw new Error("boom");
      return null;
    });
    const res = await command.handler({ args: "tasks" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Failed to fetch tasks");
  });
});

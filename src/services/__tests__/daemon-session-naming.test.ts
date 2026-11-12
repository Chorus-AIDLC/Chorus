// Tests for the shared conversation-naming helpers (daemon-session-naming.ts), incl. the
// cli-agent-session-sync rule: a terminal-started conversation is named by the first
// message the human typed in the terminal (cli_session turn transcript).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  daemonSessionTurn: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  CONVERSATION_NAME_MAX,
  conversationNameFromInstruction,
  getFirstInstructionBySessionUuid,
} from "@/services/daemon-session-naming";

beforeEach(() => {
  mockPrisma.daemonSessionTurn.findMany.mockReset();
});

describe("conversationNameFromInstruction", () => {
  it("collapses whitespace and clamps long text", () => {
    expect(conversationNameFromInstruction("  a\n  b ")).toBe("a b");
    expect(conversationNameFromInstruction(null)).toBe("");
    const long = "x".repeat(CONVERSATION_NAME_MAX + 5);
    expect(conversationNameFromInstruction(long)).toBe(`${"x".repeat(CONVERSATION_NAME_MAX)}…`);
  });
});

describe("getFirstInstructionBySessionUuid", () => {
  it("returns an empty map without querying for no sessions", async () => {
    expect((await getFirstInstructionBySessionUuid([])).size).toBe(0);
    expect(mockPrisma.daemonSessionTurn.findMany).not.toHaveBeenCalled();
  });

  it("queries human_instruction bodies and cli_session first user messages in one batched read", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([]);
    await getFirstInstructionBySessionUuid(["s1", "s2"]);
    const arg = mockPrisma.daemonSessionTurn.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      sessionUuid: { in: ["s1", "s2"] },
      OR: [
        { trigger: "human_instruction", promptText: { not: null } },
        { trigger: "cli_session" },
      ],
    });
    expect(arg.select.messages).toEqual({
      where: { role: "user" },
      orderBy: { seq: "asc" },
      take: 1,
      select: { text: true },
    });
    expect(arg.orderBy).toEqual([{ sessionUuid: "asc" }, { seq: "asc" }]);
  });

  it("names a terminal-started conversation by the first message typed in the terminal", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      { sessionUuid: "cli", seq: 1, trigger: "cli_session", promptText: null, messages: [{ text: "Remember PINEAPPLE" }] },
      { sessionUuid: "cli", seq: 2, trigger: "human_instruction", promptText: "What was it?", messages: [] },
      { sessionUuid: "daemon", seq: 1, trigger: "human_instruction", promptText: "Hello", messages: [] },
    ]);
    const map = await getFirstInstructionBySessionUuid(["cli", "daemon"]);
    expect(map.get("cli")).toBe("Remember PINEAPPLE");
    expect(map.get("daemon")).toBe("Hello");
  });

  it("falls through a cli_session turn with no synced user text to the next human instruction", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      { sessionUuid: "s", seq: 1, trigger: "cli_session", promptText: null, messages: [] },
      { sessionUuid: "s", seq: 2, trigger: "human_instruction", promptText: "Queued ask", messages: [] },
      { sessionUuid: "blank", seq: 1, trigger: "cli_session", promptText: null, messages: [{ text: "   " }] },
    ]);
    const map = await getFirstInstructionBySessionUuid(["s", "blank"]);
    expect(map.get("s")).toBe("Queued ask");
    expect(map.has("blank")).toBe(false);
  });

  it("keeps the legacy row shape (no trigger) working as a human instruction", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockResolvedValue([
      { sessionUuid: "s", seq: 1, promptText: "Legacy" },
    ]);
    expect((await getFirstInstructionBySessionUuid(["s"])).get("s")).toBe("Legacy");
  });

  it("propagates a query failure", async () => {
    mockPrisma.daemonSessionTurn.findMany.mockRejectedValue(new Error("db down"));
    await expect(getFirstInstructionBySessionUuid(["s"])).rejects.toThrow("db down");
  });
});

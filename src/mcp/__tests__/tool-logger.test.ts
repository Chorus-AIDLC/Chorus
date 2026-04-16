import { describe, it, expect, vi, beforeEach } from "vitest";
import { truncateParams, extractErrorText } from "../tools/tool-logger";
import type { AgentAuthContext } from "@/types/auth";

// Mock logger — vi.hoisted ensures fns exist before vi.mock runs
const { mockDebug, mockWarn, mockError } = vi.hoisted(() => ({
  mockDebug: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    child: () => ({
      debug: mockDebug,
      warn: mockWarn,
      error: mockError,
    }),
  },
}));

// Import after mock so enableToolCallLogging gets the mocked logger
import { enableToolCallLogging } from "../tools/tool-logger";

// Minimal McpServer stub
function createMockServer() {
  const tools = new Map<string, { config: unknown; handler: Function }>();
  return {
    registerTool: vi.fn((name: string, config: unknown, handler: Function) => {
      tools.set(name, { config, handler });
    }),
    _tools: tools,
    async callTool(name: string, params: Record<string, unknown>) {
      const entry = tools.get(name);
      if (!entry) throw new Error(`Tool ${name} not registered`);
      return entry.handler(params, {});
    },
  };
}

const mockAuth: AgentAuthContext = {
  type: "agent",
  companyUuid: "company-1",
  actorUuid: "agent-1",
  agentName: "Test Agent",
  roles: ["developer_agent"],
};

describe("tool-logger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("truncateParams", () => {
    it("keeps short strings intact", () => {
      const result = truncateParams({ taskUuid: "abc-123", title: "Short" });
      expect(result).toEqual({ taskUuid: "abc-123", title: "Short" });
    });

    it("truncates strings longer than 500 characters", () => {
      const longString = "A".repeat(600);
      const result = truncateParams({ content: longString });
      const truncated = result.content as string;
      expect(truncated.length).toBeLessThan(600);
      expect(truncated).toContain("...");
      expect(truncated.startsWith("A".repeat(250))).toBe(true);
      expect(truncated.endsWith("A".repeat(250))).toBe(true);
    });

    it("does not truncate exactly 500 character strings", () => {
      const exact = "B".repeat(500);
      const result = truncateParams({ content: exact });
      expect(result.content).toBe(exact);
    });

    it("passes through non-string values unchanged", () => {
      const result = truncateParams({ count: 42, flag: true, nested: { a: 1 } });
      expect(result).toEqual({ count: 42, flag: true, nested: { a: 1 } });
    });
  });

  describe("extractErrorText", () => {
    it("extracts text from MCP error result", () => {
      const result = {
        isError: true,
        content: [{ type: "text", text: "Task already claimed" }],
      };
      expect(extractErrorText(result)).toBe("Task already claimed");
    });

    it("joins multiple text content items", () => {
      const result = {
        isError: true,
        content: [
          { type: "text", text: "Error 1." },
          { type: "text", text: "Error 2." },
        ],
      };
      expect(extractErrorText(result)).toBe("Error 1. Error 2.");
    });

    it("returns undefined for non-object input", () => {
      expect(extractErrorText(null)).toBeUndefined();
      expect(extractErrorText("string")).toBeUndefined();
    });

    it("returns undefined when no text content", () => {
      const result = { isError: true, content: [{ type: "image", data: "..." }] };
      expect(extractErrorText(result)).toBeUndefined();
    });
  });

  describe("enableToolCallLogging", () => {
    it("logs successful calls at debug level", async () => {
      const server = createMockServer();
      enableToolCallLogging(server as unknown as Parameters<typeof enableToolCallLogging>[0], mockAuth);

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"uuid":"t-1"}' }],
      });
      server.registerTool("chorus_get_task", {}, handler);

      await server.callTool("chorus_get_task", { taskUuid: "t-1" });

      expect(mockDebug).toHaveBeenCalledOnce();
      const [logObj, msg] = mockDebug.mock.calls[0];
      expect(msg).toBe("MCP tool call");
      expect(logObj.tool).toBe("chorus_get_task");
      expect(logObj.agent).toEqual({ uuid: "agent-1", name: "Test Agent" });
      expect(logObj.params).toEqual({ taskUuid: "t-1" });
      expect(typeof logObj.durationMs).toBe("number");
    });

    it("logs business rejections at warn level", async () => {
      const server = createMockServer();
      enableToolCallLogging(server as unknown as Parameters<typeof enableToolCallLogging>[0], mockAuth);

      const handler = vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "Task already claimed" }],
      });
      server.registerTool("chorus_claim_task", {}, handler);

      await server.callTool("chorus_claim_task", { taskUuid: "t-1" });

      expect(mockWarn).toHaveBeenCalledOnce();
      const [logObj, msg] = mockWarn.mock.calls[0];
      expect(msg).toBe("MCP tool business rejection");
      expect(logObj.tool).toBe("chorus_claim_task");
      expect(logObj.error).toBe("Task already claimed");
      expect(typeof logObj.durationMs).toBe("number");
    });

    it("logs unhandled exceptions at error level and re-throws", async () => {
      const server = createMockServer();
      enableToolCallLogging(server as unknown as Parameters<typeof enableToolCallLogging>[0], mockAuth);

      const thrownError = new Error("DB connection failed");
      const handler = vi.fn().mockRejectedValue(thrownError);
      server.registerTool("chorus_create_tasks", {}, handler);

      await expect(
        server.callTool("chorus_create_tasks", { projectUuid: "p-1" })
      ).rejects.toThrow("DB connection failed");

      expect(mockError).toHaveBeenCalledOnce();
      const [logObj, msg] = mockError.mock.calls[0];
      expect(msg).toBe("MCP tool unhandled exception");
      expect(logObj.tool).toBe("chorus_create_tasks");
      expect(logObj.err).toBe(thrownError);
    });

    it("truncates long params in logs", async () => {
      const server = createMockServer();
      enableToolCallLogging(server as unknown as Parameters<typeof enableToolCallLogging>[0], mockAuth);

      const handler = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      });
      server.registerTool("chorus_pm_create_idea", {}, handler);

      const longContent = "X".repeat(600);
      await server.callTool("chorus_pm_create_idea", {
        projectUuid: "p-1",
        content: longContent,
      });

      expect(mockDebug).toHaveBeenCalledOnce();
      const logObj = mockDebug.mock.calls[0][0];
      expect(logObj.params.projectUuid).toBe("p-1");
      expect((logObj.params.content as string).length).toBeLessThan(600);
      expect((logObj.params.content as string)).toContain("...");
    });
  });
});

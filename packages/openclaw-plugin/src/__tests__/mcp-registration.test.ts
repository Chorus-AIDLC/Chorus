import { describe, it, expect, vi } from "vitest";
import { ensureChorusMcpServer } from "../mcp-registration.js";
import type { ChorusPluginConfig } from "../config.js";

// Minimal logger spy.
function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const FULL_CFG: ChorusPluginConfig = {
  chorusUrl: "https://chorus.example.com",
  apiKey: "cho_secret",
};

const EXPECTED_ENTRY = {
  url: "https://chorus.example.com/api/mcp",
  transport: "streamable-http" as const,
  headers: { Authorization: "Bearer cho_secret" },
};

/**
 * Build a fake `api` whose runtime.config mirrors OpenClaw's PluginRuntimeCore
 * surface: `current()` returns a snapshot, `mutateConfigFile({mutate})` applies
 * the in-place draft mutation to a mutable backing config and records calls.
 */
function makeApi(initial: { mcp?: { servers?: Record<string, unknown> } } = {}) {
  const logger = makeLogger();
  // backing config the host would persist
  const backing: { mcp?: { servers?: Record<string, unknown> } } = structuredClone(initial);
  const mutateConfigFile = vi.fn(
    async (params: {
      afterWrite: { mode: "auto" };
      mutate: (draft: { mcp?: { servers?: Record<string, unknown> } }) => void;
    }) => {
      // Emulate the host: hand the mutate callback a draft, then persist it.
      const draft = structuredClone(backing);
      params.mutate(draft);
      backing.mcp = draft.mcp;
      return { ok: true };
    },
  );
  const api = {
    logger,
    runtime: {
      config: {
        current: () => backing,
        mutateConfigFile,
      },
    },
  } as never;
  return { api, logger, backing, mutateConfigFile };
}

describe("ensureChorusMcpServer", () => {
  it("writes the chorus MCP server entry on first activation", async () => {
    const { api, backing, mutateConfigFile, logger } = makeApi();
    await ensureChorusMcpServer(api, FULL_CFG);
    expect(mutateConfigFile).toHaveBeenCalledOnce();
    expect(mutateConfigFile.mock.calls[0][0].afterWrite).toEqual({ mode: "auto" });
    expect(backing.mcp?.servers?.chorus).toEqual(EXPECTED_ENTRY);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("derives /api/mcp from chorusUrl with a trailing path/slash correctly", async () => {
    const { api, backing } = makeApi();
    await ensureChorusMcpServer(api, { ...FULL_CFG, chorusUrl: "https://h.example.com/" });
    expect((backing.mcp?.servers?.chorus as { url: string }).url).toBe(
      "https://h.example.com/api/mcp",
    );
  });

  it("is idempotent: skips the write when the existing entry already matches", async () => {
    const { api, mutateConfigFile, logger } = makeApi({
      mcp: { servers: { chorus: { ...EXPECTED_ENTRY } } },
    });
    await ensureChorusMcpServer(api, FULL_CFG);
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("already up to date"),
    );
  });

  it("rewrites when the apiKey (Authorization header) changed", async () => {
    const { api, backing, mutateConfigFile } = makeApi({
      mcp: { servers: { chorus: { ...EXPECTED_ENTRY, headers: { Authorization: "Bearer cho_OLD" } } } },
    });
    await ensureChorusMcpServer(api, FULL_CFG);
    expect(mutateConfigFile).toHaveBeenCalledOnce();
    expect((backing.mcp?.servers?.chorus as typeof EXPECTED_ENTRY).headers.Authorization).toBe(
      "Bearer cho_secret",
    );
  });

  it("preserves operator-added extra fields by only comparing load-bearing keys", async () => {
    // Existing entry matches on url/transport/Authorization but has an extra
    // field. Should be treated as a match → no rewrite (no reload churn).
    const { api, mutateConfigFile } = makeApi({
      mcp: { servers: { chorus: { ...EXPECTED_ENTRY, connectionTimeoutMs: 5000 } } },
    });
    await ensureChorusMcpServer(api, FULL_CFG);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("does not write and warns when chorusUrl is missing", async () => {
    const { api, mutateConfigFile, logger } = makeApi();
    await ensureChorusMcpServer(api, { ...FULL_CFG, chorusUrl: undefined });
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toContain("chorusUrl");
  });

  it("does not write and warns when apiKey is missing", async () => {
    const { api, mutateConfigFile, logger } = makeApi();
    await ensureChorusMcpServer(api, { ...FULL_CFG, apiKey: undefined });
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toContain("apiKey");
  });

  it("logs an error (and does not throw) when mutateConfigFile is unavailable on the host", async () => {
    const logger = makeLogger();
    const api = { logger, runtime: { config: { current: () => ({}) } } } as never;
    await expect(ensureChorusMcpServer(api, FULL_CFG)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("mutateConfigFile is unavailable"),
    );
  });

  it("swallows a rejection from mutateConfigFile (never crashes the gateway)", async () => {
    const logger = makeLogger();
    const api = {
      logger,
      runtime: {
        config: {
          current: () => ({}),
          mutateConfigFile: vi.fn().mockRejectedValue(new Error("disk full")),
        },
      },
    } as never;
    await expect(ensureChorusMcpServer(api, FULL_CFG)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });
});

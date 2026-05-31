import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { ChorusPluginConfig } from "./config.js";

/**
 * Shape of the `mcp.servers.chorus` entry we write into OpenClaw config.
 *
 * Mirrors the relevant subset of OpenClaw's `McpServerConfig`
 * (`../openclaw/src/config/types.mcp.ts:12`): a remote streamable-http MCP
 * server reachable at `<chorusUrl>/api/mcp` with a Bearer auth header.
 */
interface ChorusMcpServerEntry {
  url: string;
  transport: "streamable-http";
  headers: { Authorization: string };
}

/**
 * Build the desired `mcp.servers.chorus` entry for the current config.
 */
function buildDesiredEntry(chorusUrl: string, apiKey: string): ChorusMcpServerEntry {
  return {
    url: new URL("/api/mcp", chorusUrl).toString(),
    transport: "streamable-http",
    headers: { Authorization: `Bearer ${apiKey}` },
  };
}

/**
 * Shallow-equal the fields that define the desired entry. We only compare the
 * three load-bearing fields (url, transport, Authorization header) so an
 * operator-added extra field — e.g. `connectionTimeoutMs` — does not force a
 * rewrite-and-reload on every activation.
 */
function entryMatches(existing: unknown, desired: ChorusMcpServerEntry): boolean {
  if (!existing || typeof existing !== "object") return false;
  const e = existing as {
    url?: unknown;
    transport?: unknown;
    headers?: { Authorization?: unknown } | undefined;
  };
  return (
    e.url === desired.url &&
    e.transport === desired.transport &&
    e.headers?.Authorization === desired.headers.Authorization
  );
}

/**
 * Ensure the Chorus MCP server is registered with OpenClaw so the agent gains
 * the native `chorus__*` tools.
 *
 * Writes (idempotently) an `mcp.servers.chorus` entry into the OpenClaw config
 * via `api.runtime.config.mutateConfigFile` — a remote streamable-http MCP
 * server with Bearer auth. OpenClaw then connects to the remote Chorus MCP
 * server on (re)load and auto-exposes its tools under the `chorus__` prefix; we
 * never re-declare those tools with `api.registerTool`.
 *
 * Behavior:
 * - Missing `chorusUrl`/`apiKey`: do NOT write; warn naming the missing field(s).
 * - Existing entry already equals the desired entry: return without writing
 *   (idempotent — no config reload triggered).
 * - Otherwise: `mutateConfigFile({ afterWrite: { mode: "auto" }, mutate })`,
 *   mutating the draft in place (OpenClaw's `mutate` callback receives a
 *   structuredClone draft and persists the in-place mutation).
 * - Any rejection from `mutateConfigFile` (or the runtime API being absent) is
 *   logged at error level and swallowed — registration failure must never crash
 *   the gateway, so the SSE service and `/chorus` command still register.
 */
export async function ensureChorusMcpServer(
  api: OpenClawPluginApi,
  cfg: ChorusPluginConfig,
): Promise<void> {
  const logger = api.logger;

  // 1. Required-config guard: do not write a half-formed entry.
  const missing: string[] = [];
  if (!cfg.chorusUrl) missing.push("chorusUrl");
  if (!cfg.apiKey) missing.push("apiKey");
  if (missing.length > 0) {
    logger.warn(
      `[Chorus] Skipping MCP server registration — missing required config: ${missing.join(", ")}`,
    );
    return;
  }

  const desired = buildDesiredEntry(cfg.chorusUrl!, cfg.apiKey!);

  try {
    // `api.runtime` is permissively typed via the SDK shim; narrow to the
    // config surface we use (current() + mutateConfigFile). At runtime the host
    // provides the real `PluginRuntimeCore.config` API
    // (../openclaw/src/plugins/runtime/types-core.ts:145).
    const runtimeConfig = (
      api.runtime as
        | {
            config?: {
              current?: () => { mcp?: { servers?: Record<string, unknown> } } | undefined;
              mutateConfigFile?: (params: {
                afterWrite: { mode: "auto" };
                mutate: (draft: {
                  mcp?: { servers?: Record<string, unknown> };
                }) => void;
              }) => Promise<unknown>;
            };
          }
        | undefined
    )?.config;

    if (!runtimeConfig?.mutateConfigFile) {
      logger.error(
        "[Chorus] MCP server registration failed — runtime.config.mutateConfigFile is unavailable on this host",
      );
      return;
    }

    // 2. Idempotency: skip the write (and the reload it triggers) when the
    //    existing entry already matches.
    const existing = runtimeConfig.current?.()?.mcp?.servers?.chorus;
    if (entryMatches(existing, desired)) {
      logger.info("[Chorus] MCP server entry already up to date — no config change");
      return;
    }

    // 3. Write the entry, mutating the draft in place.
    await runtimeConfig.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const mcp = (draft.mcp ??= {});
        const servers = (mcp.servers ??= {});
        servers.chorus = desired;
      },
    });

    logger.info(`[Chorus] Registered MCP server entry — ${desired.url}`);
  } catch (err) {
    // 4. Never crash the gateway: log at error level and continue so the SSE
    //    service and /chorus command still register.
    logger.error(
      `[Chorus] MCP server registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

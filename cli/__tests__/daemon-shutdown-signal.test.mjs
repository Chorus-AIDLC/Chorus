// cli/__tests__/daemon-shutdown-signal.test.mjs
// End-to-end regression for the server-signal-handler leak (root-cause discriminator).
//
// Before the fix, a `chorus daemon` process ALSO registered the server's
// SIGINT/SIGTERM handler (it was never guarded by `!isSubcommand`). That handler
// runs first (registration order) and synchronously calls process.exit(0) after
// logging a bare "Shutting down..." — pre-empting the daemon's own graceful
// `daemon.stop()` (which logs "[Chorus] shutting down daemon...").
//
// This test spawns the REAL `node chorus.mjs daemon` entry against a hermetic
// in-process MCP server (answers chorus_checkin so preflight passes and the daemon
// reaches "daemon running"), sends the child SIGTERM, and asserts the captured
// output shows the daemon's graceful line and NOT the server's bare one. The SSE
// subscription fails fast against the fake server (no /api/events stream) — the
// daemon tolerates that and still reaches "daemon running", which is the only state
// this test needs before signalling.
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const ENTRY = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "chorus.mjs");

/**
 * Start a hermetic, stateless MCP HTTP server that answers chorus_checkin with a
 * fake agent identity — enough for the daemon's preflight (validateAndFetchIdentity)
 * to succeed. Mirrors the real stateless route: a fresh server+transport per request.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
function startFakeChorus() {
  return new Promise((resolve) => {
    const httpServer = createServer(async (req, res) => {
      if (!req.url || !req.url.startsWith("/api/mcp")) {
        // Anything else (notably the SSE /api/events/notifications subscription)
        // gets a 404 — the daemon treats a non-ok SSE response as a reconnectable
        // failure and still reaches "daemon running".
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => transport.close());
      const server = new McpServer({ name: "fake-chorus", version: "0.0.0" });
      server.registerTool(
        "chorus_checkin",
        { description: "fake checkin", inputSchema: {} },
        async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({ agent: { uuid: "agent-e2e", name: "E2E Daemon Bot" } }),
            },
          ],
        })
      );
      await server.connect(transport);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }
        await transport.handleRequest(req, res, parsed);
      });
    });
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (httpServer.address());
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => httpServer.close(() => r())),
      });
    });
  });
}

let fake;
let child;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  child = undefined;
  if (fake) {
    await fake.close();
    fake = undefined;
  }
});

describe("chorus daemon graceful shutdown on SIGTERM (signal-handler-leak regression)", () => {
  it("shuts down via the daemon's own graceful path, never the server's bare 'Shutting down...'", async () => {
    fake = await startFakeChorus();

    let out = "";
    child = spawn(process.execPath, [ENTRY, "daemon"], {
      env: {
        ...process.env,
        CHORUS_URL: fake.url,
        CHORUS_API_KEY: "cho_e2e_test_key",
        // Force a clean, non-interactive, headless-equivalent run: no TTY prompts,
        // no plugin-config fallback, throwaway HOME so we never read a real login file.
        HOME: "/tmp/chorus-daemon-shutdown-test-home",
        CHORUS_DAEMON_HEADLESS: "1",
        CHORUS_YOLO: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));

    // Wait for the daemon to reach "daemon running" (its SIGTERM handler is now
    // registered), then send SIGTERM. Poll the captured output up to ~12s.
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !/daemon running/.test(out)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(out, `daemon never reached "daemon running". Output so far:\n${out}`).toMatch(
      /daemon running/
    );

    // Capture the exit, then signal.
    const exited = new Promise((resolve) => child.on("close", () => resolve()));
    child.kill("SIGTERM");
    // Give the graceful path a moment to log + exit; kill hard if it hangs.
    const hardKill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 5000);
    await exited;
    clearTimeout(hardKill);

    // The daemon's own graceful handler ran...
    expect(out).toMatch(/\[Chorus\] shutting down daemon\.\.\./);
    // ...and the server's bare line did NOT (that string is server-only; the
    // daemon's line always carries the "[Chorus] " prefix). Assert no bare
    // "Shutting down..." appears at the start of a line.
    expect(out).not.toMatch(/^Shutting down\.\.\./m);
  }, 25000);
});

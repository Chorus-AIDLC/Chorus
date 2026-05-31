import { defineConfig } from "vitest/config";

/**
 * Standalone Vitest config for the Chorus OpenClaw plugin.
 *
 * This package is intentionally EXCLUDED from the repo's root pnpm workspace
 * (see `pnpm-workspace.yaml` → `"!packages/openclaw-plugin"`) and from the root
 * `vitest.config.ts` (`exclude: ['packages']`). It ships pure TS + a compiled
 * `dist/`, so its tests run on the source under its own config.
 *
 * Tests exercise the plugin's own modules (config, mcp-registration, wake,
 * event-router, commands, sse-listener) with lightweight fakes for the host
 * `api` and the MCP client — no live OpenClaw host is required. The entry
 * (`src/index.ts`) value-imports `openclaw/plugin-sdk/plugin-entry`, a subpath
 * the locally-resolvable `openclaw` build (2026.3.2) does not export, so it is
 * deliberately NOT imported here; its composed units are covered individually.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});

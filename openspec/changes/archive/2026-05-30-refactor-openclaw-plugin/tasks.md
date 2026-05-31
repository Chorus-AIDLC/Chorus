# Tasks: refactor-openclaw-plugin

## 1. SDK entry, manifest & packaging
- [ ] 1.1 Rewrite `src/index.ts` to `definePluginEntry` default export with `registrationMode === "full"` guard
- [ ] 1.2 Rewrite `openclaw.plugin.json` (id, JSON-Schema configSchema, skills, uiHints.apiKey.sensitive)
- [ ] 1.3 Rewrite `package.json` openclaw block (extensions, runtimeExtensions, compat.pluginApi, build) — verify required fields against a bundled extension
- [ ] 1.4 Trim `src/config.ts` zod schema to in-code typing, aligned with the manifest

## 2. Native MCP integration
- [ ] 2.1 Add `src/mcp-registration.ts` `ensureChorusMcpServer()` via `runtime.config.mutateConfigFile` (idempotent)
- [ ] 2.2 Delete `src/tools/*` and remove all `registerTool` calls
- [ ] 2.3 Slim `src/mcp-client.ts` to plugin-internal calls only

## 3. Event bridge
- [ ] 3.1 Keep SSE listener; register via `api.registerService`
- [ ] 3.2 Swap `event-router.ts` wake from `/hooks/wake` to `runtime.system.enqueueSystemEvent` (contextKey dedupe, graceful no-session)
- [ ] 3.3 Preserve autoStart claim-then-wake

## 4. Commands
- [ ] 4.1 Update `/chorus` command for slim client + new skill list

## 5. Skills & agents
- [ ] 5.1 Port 9 skills into `skills/`, adapting Claude-Code-only mechanics with documented fallbacks
- [ ] 5.2 Port `openspec-aware` with inline self-detection
- [ ] 5.3 Add `agents/proposal-reviewer.md` and `agents/task-reviewer.md`

## 6. Docs & validation
- [ ] 6.1 Rewrite README for new install flow + bundle-mcp sandbox caveat + skill catalog
- [ ] 6.2 `tsc --noEmit` green; build dist/
- [ ] 6.3 `openclaw plugins build --check` + `openclaw plugins validate` pass

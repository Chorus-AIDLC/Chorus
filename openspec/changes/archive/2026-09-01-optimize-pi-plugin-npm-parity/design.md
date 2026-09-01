# Design — Optimize the Pi Plugin

## Context

`packages/chorus-pi/` is a working-but-unproductionized pi package: `extensions/chorus.ts` (native-event extension doing MCP-over-HTTP for checkin/session bookkeeping), `lib/lib.ts` (pure helpers), 11 skills, 3 reviewer agents, a `bin/chorus-mcp-call.sh` wrapper. It is workspace-excluded, unpublished, version-drifted (0.17.0 vs app 0.17.1), depends on third-party `@narumitw/pi-subagents`, needs a manual `agents/*.md` copy, lacks the `brainstorm` skill, and is a non-wakeable `offline` daemon backend.

Reference implementation (idea reference): pi harness `earendil-works/pi`, esp. `packages/coding-agent/examples/extensions/subagent/`.

## Decisions

### A. Distribution — publish TS as-is, dsh-shaped packaging

- **No build step.** pi loads `.ts` via jiti, so `main` stays `extensions/chorus.ts` and we publish source. This is the key divergence from the dsh package (which compiles to `dist/`). `files` allowlist = `["extensions","lib","skills","agents","bin","README.md"]`; add `.npmignore` (defense-in-depth so npm never falls back to `.gitignore` and drops source), `publishConfig.access=public`, `repository.directory="packages/chorus-pi"`.
- **Version** synced to root `package.json` version (lockstep), and added to the `release` / `plugin-maintenance` skill bump checklists.
- **Validation scripts** modeled on dsh: `scripts/validate-package.mjs` (`check:package`) asserting name/version, the expected skill set, the 3 reviewer agents, and the `pi` manifest shape; `scripts/check-pack.sh` (`check:pack`) packing into a tmp dir and asserting required files present + forbidden artifacts absent (`test/`, `node_modules/`, `.env`, `cho_…`). `prepublishOnly` runs `check:package`.
  - **Skill-set decoupling (A1↔B).** `validate-package.mjs` declares its expected skill list. Task A1 lands it with the **current** skill set (the 11 skills present today); task B, which adds the `brainstorm` skill, **also extends that expected list to include `brainstorm`** in the same task. This keeps A1 and B independent DAG roots — each self-consistent — with no cross-dependency: A1's `check:package` passes on 11, B's passes on 12.
- **Workspace re-add without the #458 dashboard-build regression.** Removing `!packages/chorus-pi` from `pnpm-workspace.yaml` makes it a workspace member again. #458 was that its `.ts` got pulled into the root/dashboard `tsc` build. Mitigation: ensure the root `tsconfig.json` `exclude` covers `packages/**` (or specifically `packages/chorus-pi`) and that the root lint/typecheck globs (see the CLI package `checkCommands`: `eslint src cli chorus.mjs …` + `tsc --noEmit`) do not include the package. The executing task MUST verify `pnpm build` + root `tsc --noEmit` still pass and do not compile `packages/chorus-pi/**` after the exclusion is removed.
- **Coordinated release.** Add a 4th entry to `manifest.json` (`packages/chorus-pi`, `@chorus-aidlc/chorus-pi`): `installCommands` = `pnpm install --frozen-lockfile`; `checkCommands` = `pnpm run check:package`; no `buildCommands`; `packageCommands` = `pnpm run check:pack`; `requiredFiles` = `["package.json","extensions/chorus.ts","skills/chorus/SKILL.md","agents/chorus-code-reviewer.md","README.md"]` (final list at implementation time); `forbiddenPatterns` = node_modules/test/.env; `postPackCheck` = `none`. Extend `expectedPackages` in `lib.mjs` to 4 entries **in publish order** and update the guard message + the release-contract `__tests__`.

### B. CC parity — official subagent pattern, package-relative discovery, brainstorm

- **Adopt the official pattern by copy-in** (it is example code, not a published package): copy pi's `examples/extensions/subagent/{index.ts,agents.ts}` into `packages/chorus-pi/extensions/subagent/`. Its only runtime deps are public `@earendil-works/pi-coding-agent` exports (`parseFrontmatter`, `getAgentDir`, `CONFIG_DIR_NAME`, `ExtensionAPI`) + `pi-tui` render primitives + TypeBox — all already available to a pi extension. **Drop the `@narumitw/pi-subagents` peer dependency.**
- **Package-relative discovery (zero copy).** `discoverAgents(cwd, scope)` hard-codes two dirs (`~/.pi/agent/agents/`, nearest `.pi/agents/`) and takes no extra-dir param, but the per-dir loader `loadAgentsFromDir(dir, source)` is standalone. Edit our copy of `agents.ts` to also call `loadAgentsFromDir(BUNDLED_DIR, "user")` where `BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents")` — i.e. the package's own `agents/` dir resolved from the extension module. This is the intended customization path and eliminates the manual copy into `~/.pi/agent/agents/`.
- **Tool rename + bookkeeping adaptation.** The official tool is named `subagent` (single/parallel/chain modes, **ephemeral** children spawned as `pi --mode json -p --no-session … "Task: …"`), replacing narumitw's `subagent_spawn` + `subagent_manage close` (persistent). `extensions/chorus.ts` references those old tool names in its `tool_call`/`tool_result` handlers and `NUDGE_TOOL_NAMES`; update them to the `subagent` tool. Because official children are ephemeral (spawn→run→exit within one tool call), the Chorus session bookkeeping shifts from "create on spawn / close on manage-close" to "create a Chorus AgentSession when a `subagent` tool call starts, close it when its `tool_result`/`tool_execution_end` fires." Reviewer nudges still key off the reviewer-agent invocation.
- **Reviewers unchanged in intent.** The 3 agent defs (`agents/chorus-{code,task,proposal}-reviewer.md`) keep their read-only reviewer bodies; ensure their frontmatter matches the official parser (`name`, `description` required; `tools` comma-or-array; body = system prompt).
- **Add `brainstorm` skill** ported from `public/chorus-plugin/skills/brainstorm/SKILL.md` into `packages/chorus-pi/skills/brainstorm/`.
- **Scope boundary:** skip Claude-only hooks (plan-mode Enter/Exit, TeammateIdle, TaskCompleted) — no pi analog; functional parity only (elaboration decision `parity_scope=functional`).

### C. Wakeable daemon backend — `cli/pi-spawner.mjs`

- **Contract:** implement the shared `Spawner.wake({prompt, sessionId, isNew, cwd, onMessage, onChild})` (see `codex-spawner.mjs` / `claude-spawner.mjs`). Resolve `pi` from PATH honoring `CHORUS_PI_PATH`; cross-platform spawn helper like codex's `resolveSpawnCommand` (Windows `.cmd` shim). Prompt over **stdin** (`pi -p` merges piped stdin), NDJSON stdout parsed with the shared `parseNdjsonChunk`; forward `message_end` / `tool_result_end` events through `onMessage`; hand child to `onChild`; POSIX detached process group for group-kill on interrupt; export `CHORUS_URL`/`CHORUS_API_KEY`/`CHORUS_AGENT_PROFILE` + `CHORUS_DAEMON_HEADLESS=1` into child env.
- **Session model — client-owned id (like Claude, unlike Codex).** pi accepts a caller-provided `--session-id <id>`, so the daemon owns the anchor: new wake → `pi --mode json -p --session-id <anchor>`; resume → resume that same anchor (via `--session <anchor>` / `--session-id <anchor>`, whichever pi's `args.ts` treats as idempotent-create-or-resume; the task MUST verify against pi's CLI which flag creates-if-absent vs. requires-existing, and fall back to a persisted anchor→session-id map like `codex-session-map.mjs` if pi generates its own id in `-p` mode). No `--no-session` for the top-level daemon session (that flag is for ephemeral subagent children only).
- **No permission flag.** pi has no permission system, so `permissionMode` is a no-op — do NOT emit any sandbox/skip-permissions flag. Both `chorus` and `yolo` modes run identically.
- **Wiring:** `KNOWN_AGENTS` += `pi` and `backendCli`/`backendClientType` branches in `daemon-agent.mjs`; `selectSpawner("pi")` → `PiSpawner` in `spawner-select.mjs`; `agent-type-map.mjs` `pi` → `pi` (drop the `offline` mapping); `"pi"` added to `DAEMON_CLIENT_TYPES` in `src/services/daemon-connection.service.ts` (+ its test). Unit tests for `pi-spawner.mjs` mirroring `codex-spawner`'s (arg build new/resume, missing-binary, event parse).
- **MCP caveat (documented risk).** pi has no native MCP; a woken pi reaches Chorus tools only via the chorus-pi extension / `pi-mcp-adapter`. The wakeable backend therefore presumes that layer is installed in the woken environment. This is made reliable by A (npm publish) + D (init auto-install). The spawner itself does not inject MCP; it exports creds the extension consumes.

### E. Integration checkpoint

A dedicated verification task (E), depending on A1/A2/B/C/D, exercises the assembled pipeline as far as is possible headlessly — it does NOT re-verify each module, it verifies they compose:
- Build the tarball (`pnpm pack` in `packages/chorus-pi`) and install it into a throwaway pi env (`pi install <tarball>` or `pi install <path>`); confirm the extension loads.
- Confirm the `subagent` tool is registered and the 3 reviewer agents are discovered **package-relative** (no copy into `~/.pi/agent/agents/`).
- Confirm the daemon recognizes `--agent pi` end-to-end at the wiring level: `resolveAgentType`→`selectSpawner`→`PiSpawner`, and `chorus init` seeds pi as wakeable.
- Run the full repo gates: `pnpm test`, `tsc --noEmit`, `pnpm lint`, `pnpm test:release-contract`, and the chorus-pi `check:package`/`check:pack`.
Live remote wake→turn→transcript across a real Chorus instance is flagged for human live verification (not headlessly reproducible), consistent with prior daemon-backend changes.

### D. init automation

- `cli/init/adapters.mjs`: flip the `pi` adapter from `guided("pi", …)` to an automated installer running `pi install npm:@chorus-aidlc/chorus-pi`, retaining binary/config-dir detection and graceful degradation (surface the manual command if `pi` is absent). Because C maps `pi`→`pi` (wakeable), init seeds a selected pi agent as wakeable and the daemon-setup auto-start gate includes it.
- Update `docs/CONNECT_PI.md` + `packages/chorus-pi/README.md`: npm install primary, drop the local-path/sparse-git workaround and the manual agents-copy step, document `--agent pi` wakeability.

## Risks / Open Questions

1. **pi session-id semantics in `-p` mode** — whether `--session-id` creates-or-resumes idempotently, or pi generates its own id (needing an anchor→id map). Resolve in the pi-spawner task by testing against the installed pi CLI; the spec allows either implementation.
2. **#458 dashboard-build regression** — re-adding to the workspace must be verified not to re-break the root build; the distribution task owns that verification.
3. **MCP bridge for woken pi** — out of this change's spawner scope but a real dependency for a woken pi to act; relies on the extension/`pi-mcp-adapter` being installed (A+D). If the woken pi cannot see Chorus MCP tools in live testing, that is a follow-up, not a spawner bug.
4. **Live end-to-end wake** cannot be exercised headlessly here; the daemon-backend task's ACs are unit-level + wiring, with live E2E flagged for human verification (consistent with prior daemon-backend changes).

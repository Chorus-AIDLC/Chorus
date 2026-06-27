# Proposal: daemon Codex backend — cash in the `--agent` extension point so `--agent codex` wakes a local headless Codex

## Why

The daemon's remote-wake path today can spawn **only Claude Code**. The `--agent <type>` flag and `CHORUS_AGENT` env already exist (`cli/daemon-agent.mjs`), but `KNOWN_AGENTS = ["claude-code"]` and the comment is explicit: *"reserve the extension point for future agents (e.g. codex) … Only claude-code is implemented."* The existing `daemon-agent-selection` capability spec says the same. This change cashes that reservation in: `--agent codex` (or `CHORUS_AGENT=codex`) wakes a local **headless Codex** subprocess instead of Claude Code.

The whole spawn path is Claude-specific (`cli/claude-spawner.mjs`): resolve executable → `buildArgs` → spawn headless → parse stream-json → feed prompt over stdin → process-group kill for interrupt. Codex's headless interface exists but **diverges structurally** from Claude's, so a clean abstraction is needed rather than a copy-paste.

Verified on this host (Codex CLI **0.142.3**, source at `../codex`):

1. **Non-interactive interface is sufficient.** `codex exec --json` emits JSONL events (`thread.started` / `turn.completed` / `item.*`); the prompt is read from **stdin** (`-` or no positional arg). `codex exec resume <SESSION_ID> [prompt]` continues a session. The stdin-not-argv security constraint is satisfiable.
2. **Session id is *reversed*.** Claude accepts a client-supplied `--session-id`; **Codex generates its own `thread_id`** (surfaced in the first stream event — `session_meta.payload.id` in the rollout JSONL / `thread.started.thread_id` per the docs). The daemon's "anchor the session on the Chorus idea uuid" model therefore needs an extra **persisted `idea uuid → codex thread_id` map** to resume.
3. **No `--mcp-config`.** Codex loads MCP from `~/.codex/config.toml` / `-c key=value` overrides / `CODEX_HOME`. HTTP MCP is supported (`[mcp_servers.<name>]` with `url` + `bearer_token_env_var`). **Trap:** relocating `CODEX_HOME` also moves Codex's *model* auth (this host authenticates the model via a Bedrock profile), so we must not naively swap `CODEX_HOME`.
4. **No per-tool allowlist.** Claude's `--allowedTools mcp__chorus__*` has no Codex equivalent. Codex permission is a **sandbox mode** (`read-only` / `workspace-write` / `danger-full-access` / `--dangerously-bypass-approvals-and-sandbox`).

> Provenance: idea `b8335370-3698-4944-92ae-b65620ebcb3f` (project Chorus 0.12.1), elaborated and **human-verified** (Round 1, 5 questions, resolved). The decisions below encode those answers verbatim. The elaboration dogfooded the headless flow — it ran from a daemon-woken headless session that routed its questions to the Chorus elaboration panel.

## What Changes

The verified elaboration answers set a deliberately scoped v1: **new wake + permission (yolo) + per-idea session-id cache for resume + interrupt**, with MCP injection **best-effort** (the user already configures the Chorus plugin's MCP, so the daemon need not inject it).

- **Backend-agnostic spawner interface (Q1).** Extract the shape `ClaudeSpawner` and a new `CodexSpawner` both satisfy: `wake({ prompt, sessionId, isNew, mcpConfigPath, cwd, onMessage, onChild }) → { sessionId, exitCode, isNew }`. The daemon picks which spawner to inject from `resolveAgentType(flags, env)` — the upper layers (wake-queue, waker, directed delivery, headless guard, turn/transcript reporters) stay backend-agnostic. The contract is the **same JS interface already used at the `daemon.mjs` injection seam**; no waker rewrite.

- **`codex` becomes a known backend (Q1).** `cli/daemon-agent.mjs` adds `codex` to `KNOWN_AGENTS` so `resolveAgentType` no longer rejects it; the startup banner shows the resolved backend (already wired). Selecting `claude-code` (explicitly or by default) behaves byte-for-byte as today.

- **`CodexSpawner` — new wake (Q1).** Spawns `codex exec --json` headless: prompt over **stdin** (never argv), JSONL parsed from stdout (reusing the platform-neutral `parseNdjsonChunk`), `onMessage` fed each event, `onChild` handed the live child the instant it spawns. Cross-platform executable resolution mirrors `resolveClaudePath` (PATH walk + `.cmd`/`.bat` via `cmd.exe` on Windows + a `CHORUS_CODEX_PATH` override).

- **Session anchoring via a persisted id map (Q2 = a).** Because Codex owns the id, `CodexSpawner` captures the generated `thread_id` from the first stream event and persists `idea uuid → thread_id` under the daemon's config dir. A subsequent wake for the same anchor resolves the stored `thread_id` and runs `codex exec resume <thread_id>`; with no mapping it starts fresh. **new-vs-resume is decided inside the spawner** (each backend owns its session model) — Claude probes the on-disk transcript, Codex consults the id map — so the waker passes its `sessionId` (the Chorus anchor) and lets the spawner translate.

- **Permission posture: yolo first (Q3 = "先做 yolo").** Map the daemon's existing backend-agnostic permission switch: `yolo → codex exec --dangerously-bypass-approvals-and-sandbox` (full autonomy for code-writing AI-DLC work). The daemon default is already `yolo`. The restricted `chorus` posture maps to `--sandbox read-only` (MCP calls still work; no shell / file writes) so the switch stays meaningful, but yolo is the path this version targets and tests.

- **MCP wiring: rely on the user's config, do not inject (Q4 = c).** The daemon does **not** synthesize a Codex MCP config. It relies on the user's existing `~/.codex/config.toml` carrying `[mcp_servers.chorus]` (the Chorus plugin / `codex mcp add` already sets this up with `bearer_token_env_var`). To make the woken Codex authenticate as **this daemon's agent**, the spawner exports the daemon's own resolved key into the child env under the variable the user's config references (default `CHORUS_API_KEY`) — key via **env, never argv**. If the user's config has no `chorus` MCP server, the woken Codex simply runs without Chorus tools (best-effort, logged, no crash) — acceptable for v1 per the answer ("mcp 看情况，不行就算了").

- **Interrupt via process-group kill (Q5 = a).** `codex exec` forks child shells when running tools, so `CodexSpawner` spawns `detached: true` (POSIX process-group leader) exactly like `ClaudeSpawner`, and the existing two-stage `killProcessTree` (SIGINT → escalate → SIGKILL group; Windows `taskkill /T /F`) is reused unchanged. Post-interrupt resume rides on the Q2 id map (a re-wake after interrupt resumes the stored `thread_id`).

## Capabilities

### New Capabilities

- `daemon-codex-backend`: the contract for the Codex spawn path — `codex exec --json` headless wake with prompt over stdin and JSONL stream parsing, cross-platform `codex` executable resolution with a `CHORUS_CODEX_PATH` override, the persisted `idea uuid → codex thread_id` map driving new-vs-`resume`, the permission-mode → sandbox-flag mapping (`yolo → --dangerously-bypass-approvals-and-sandbox`), the MCP-from-user-config posture with the daemon key exported via the configured `bearer_token_env_var`, and detached-process-group interrupt parity.
- `daemon-spawner-interface`: the backend-agnostic `wake(...)` spawner contract and the `resolveAgentType`-driven selection of which spawner the daemon injects — the seam that keeps wake-queue / waker / directed-delivery / reporters backend-neutral.

### Modified Capabilities

- `daemon-agent-selection`: the existing requirement says only `claude-code` is implemented and the flag merely *reserves* the codex slot. This change implements `codex`, so the requirement is updated: `codex` is now a known, accepted backend that wakes a local headless Codex; unknown values are still rejected non-zero; `claude-code` remains the default and behaves exactly as before.

## Impact

- **Schema**: none. No migration, no Prisma model, no enum. The `idea→thread_id` map is a daemon-local JSON file under the daemon config dir, not a DB entity.
- **Daemon client code** (in-repo, `cli/`):
  - `cli/daemon-agent.mjs` — add `codex` to `KNOWN_AGENTS`.
  - `cli/codex-spawner.mjs` *(new)* — `CodexSpawner` implementing the shared `wake(...)` contract: executable resolution, `buildArgs` (`exec --json` / `exec resume <id>` + sandbox flag), spawn (detached, stdin prompt, JSONL parse), thread-id capture.
  - `cli/codex-session-map.mjs` *(new)* — persist/read the `idea uuid → codex thread_id` map under the daemon config dir (atomic write, never throws into the wake path).
  - `cli/daemon.mjs` — at the spawner injection seam (`const spawner = deps.spawner ?? …`), choose `CodexSpawner` vs `ClaudeSpawner` from the resolved agent type; thread `permissionMode` through unchanged.
  - `cli/claude-spawner.mjs` — no behavior change; if a shared interface typedef is extracted it lives here or in a small `spawner.mjs`, with `ClaudeSpawner` left byte-equivalent (claude-code must not regress).
  - `cli/__tests__/` — unit tests for: agent resolution accepting `codex`; `CodexSpawner` argv (new vs resume, sandbox flag per mode, prompt never in argv); thread-id capture + map round-trip; permission-mode mapping; executable resolution incl. Windows `.cmd` and `CHORUS_CODEX_PATH`; spawner selection in `daemon.mjs`.
- **Codex is an external dependency**: all `codex exec` flags, event field names (`thread_id`, `session_meta`), and config keys (`bearer_token_env_var`) MUST be verified against the installed `codex --help` and `../codex` source at implementation time, not assumed from this proposal (versions drift — verified here against 0.142.3).
- **MCP tools / `docs/MCP_TOOLS.md`**: unchanged — no new Chorus tool.
- **Skill docs / blog**: the daemon README/blog draft (`docs/blogs/v2ex-daemon-remote-wake.zh.md`) currently says "only Claude Code; `--agent` reserved for codex" — update the wording once shipped (tracked in the doc task, not blocking the backend).
- **`docs/design.pen`**: not applicable — daemon CLI behavior change, no user-facing screen.
- **Cross-platform / deps**: no new npm dependency (pitfall #9); spawn stays `shell:false` with argv arrays; Windows `.cmd` handled via `cmd.exe` like the Claude path; all new shell-free.

## Out of Scope

- **Transcript upload for Codex.** The Claude path uploads user/assistant text to `/api/daemon/transcript`. Codex's JSONL event shape differs; mapping it is deferred (the wake still runs and reports turn lifecycle). Tracked as a follow-up.
- **Codex model authentication.** `codex login` / Bedrock profile setup is the user's responsibility (per Q4); the daemon does not manage model creds.
- **Daemon-side synthesis of a Codex MCP config** (Q4 = c rejected option a/b): not done in v1.
- **A non-`claude-code`/`codex` third backend.** The interface is general, but only these two are implemented.

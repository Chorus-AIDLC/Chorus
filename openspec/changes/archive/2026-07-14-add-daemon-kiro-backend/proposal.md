# Proposal: daemon Kiro backend — `--agent kiro` wakes a local headless Amazon Kiro CLI

## Why

The daemon's remote-wake path can spawn Claude Code (`--agent claude-code`, default) and Codex (`--agent codex`). This change adds a **third** backend: `--agent kiro` (or `CHORUS_AGENT=kiro`) wakes a local **headless Amazon Kiro CLI** subprocess (`kiro-cli chat --no-interactive`), routed into the same Chorus AI-DLC skill workflow as the other backends. It is the "daemon 唤醒" deliverable of the Kiro-integration theme (`a1e25b50`), sibling to the already-merged Kiro plugin.

The wake pipeline (SSE → EventRouter → WakeQueue → Waker) is already backend-agnostic — the `daemon-spawner-interface` capability defines the `wake(...)` contract, and `selectSpawner(agentType, opts)` is the single dispatch seam. Adding Kiro means adding a `KiroSpawner` that satisfies that contract, plus registering `kiro` as a known backend and daemon client type. No waker rewrite.

**The framed "primary risk" is largely dissolved.** The idea flagged Kiro#5958 (MCP tools not loading under `--no-interactive`) as a blocker requiring a REST/agent-key fallback. Live verification (2026-07-14, `gh issue view 5958`): the issue is **closed COMPLETED**, and the reporter's own root cause was *"NodeJS22 missing in the workspace, due to which Kiro was not able to pull the MCP server tools correctly"* — an **environment prerequisite, not a Kiro bug** (the failure was on Amazon Linux 2 without node; it worked on macOS; a duplicate-detector bot mislabeled it before the reporter self-closed). This daemon host already runs **node v22.22.0 + kiro-cli 2.12.1** and carries the shipped Kiro plugin's `.kiro/settings/mcp.json`. So headless MCP should load; the fallback becomes "validate live, then build only if it actually fails," not a v1 blocker.

Verified on this host (Kiro CLI **2.12.1** — newer than the pinned 1.26.2 docs at kiro.dev/docs/cli/headless, which are stale on several points):

1. **Non-interactive interface exists and is sufficient.** `kiro-cli chat --no-interactive "<prompt>"` runs a single headless turn. `--trust-all-tools` / `--trust-tools=<names>` (e.g. `fs_read,fs_write`) / `--trust-tools=` (trust nothing) set the tool-approval posture so a headless turn never blocks on a prompt. `--require-mcp-startup` exits with code 3 if any MCP server fails to start. `--agent <name>` selects a context profile. Auth is inherited from the environment (the interactive login / `KIRO_API_KEY`), like Codex's model auth.
2. **Native per-cwd resume exists — Kiro owns the id (like Codex).** `kiro-cli chat --resume-id <SESSION_ID>` resumes a specific conversation; `-r/--resume` resumes the most-recent-per-cwd; `--list-sessions [--format json]` enumerates them. Kiro **generates** its own UUID `sessionId` per conversation. Because the daemon works one repo cwd, many ideas share that cwd, so "resume most recent" would cross-contaminate — the daemon needs a persisted **`idea uuid → kiro sessionId`** map and `--resume-id`, exactly the model the Codex backend uses.
3. **No structured chat-turn stream.** `--format json` is **list-commands-only** (`--list-models` / `--list-sessions`); `chat --no-interactive` emits plain text/markdown on stdout — there is no `exec --json`-style NDJSON event stream to parse per message. Transcript capture therefore cannot reuse the Codex/Claude `parseNdjsonChunk` path.
4. **But Kiro persists a structured session store on disk.** `~/.kiro/sessions/cli/<sessionId>.jsonl` is per-message JSONL (`{version, kind: "Prompt" | "AssistantMessage" | …, data.content[], data.message_id}`), with a `<sessionId>.json` metadata sibling (`{session_id, cwd, created_at, updated_at, title, parent_session_id, session_created_reason, session_state}`). This store is the source behind `--list-sessions messageCount` and is convertible to structured transcript entries.
5. **Engine fork.** `kiro-cli chat` exposes `--agent-engine v2|v3` (v2 default) and `--v3` (+ `--mode default|spec`). V3 is breaking and early-release; a separate sibling idea (`d4a59bab`) owns the full V3 adaptation. This backend targets **v2**.

> Provenance: idea `dc53a459-5f61-4c32-a02e-359babb41d76` (project chorus 0.14.1, child of theme `a1e25b50`), elaborated and **human-verified** (Round 1, 6 questions, resolved). The decisions below encode those answers verbatim. The elaboration dogfooded the headless flow — it ran from a daemon-woken headless Claude session that routed its questions to the Chorus elaboration panel.

## What Changes

The verified elaboration answers set a scoped v1 that mirrors the Codex backend's shape wherever Kiro behaves like Codex, and diverges only where Kiro's surface differs (transcript, resume flag, agent profile).

- **`kiro` becomes a known backend (fallback = a).** `cli/daemon-agent.mjs` adds `kiro` to `KNOWN_AGENTS`, a `backendCli` branch (`{ name: "kiro", envVar: "CHORUS_KIRO_PATH" }`), and a `backendClientType` branch (`"kiro"`). Server-side, `DAEMON_CLIENT_TYPES` gains `"kiro"` (else the Kiro daemon's connection self-report is refused) and the presence-UI label map gets a `kiro` case. Selecting `claude-code`/`codex` behaves exactly as today.

- **`KiroSpawner` — new wake (all decisions).** New `cli/kiro-spawner.mjs` implementing the shared `wake({ prompt, sessionId, isNew, cwd, onMessage, onChild }) → { sessionId, exitCode, isNew }` contract. Spawns `kiro-cli chat --no-interactive` with the prompt over **stdin** (never argv), `detached: true` on POSIX so the existing `killProcessTree` reaches Kiro's child shells. Cross-platform executable resolution mirrors `resolveCodexPath`/`resolveClaudePath` (PATH walk + `.cmd`/`.bat` via `cmd.exe` on Windows + a `CHORUS_KIRO_PATH` override).

- **Agent profile: `--agent chorus` (profile = a).** The woken session runs `kiro-cli chat --agent chorus` so it loads the Kiro plugin's Chorus agent (Chorus MCP server + AI-DLC skills + steering) — parity with an interactive plugin user. This makes the Kiro backend **depend on the Kiro plugin being installed**, exactly as the Codex backend depends on `~/.codex/config.toml`. Documented as a prereq.

- **Engine: v2 (engine = a).** Spawn on the default v2 engine (do not pass `--v3`); the V3 adaptation stays with its dedicated sibling idea.

- **Tool trust mirrors Codex (trust = a).** The daemon's backend-agnostic permission mode maps to Kiro trust flags: `yolo → --trust-all-tools` (full autonomy for code-writing AI-DLC work; the daemon default is already `yolo`), and the restricted `chorus` posture → a scoped `--trust-tools=` read-ish subset (`fs_read` + the Chorus MCP tool names) so MCP calls still work while shell/file-writes are withheld.

- **Session anchoring via a persisted id map (resume = a).** Because Kiro owns the id, `KiroSpawner` captures the generated `sessionId` after a run and persists `idea uuid → kiro sessionId` under the daemon config dir (`~/.chorus/kiro-sessions.json`), reusing the `codex-session-map.mjs` shape (atomic write, never throws into the wake path). A subsequent wake for the same anchor runs `kiro-cli chat --resume-id <sessionId>`; with no mapping it starts fresh. new-vs-resume is decided inside the spawner from this map — the on-disk transcript probe the waker does for Claude does not apply.

- **MCP wiring: rely on the user's config, do not inject (fallback = a).** Like Codex, the daemon does **not** synthesize a Kiro MCP config. It relies on the Kiro plugin's `.kiro/settings/mcp.json` (which references `${env:CHORUS_API_KEY}` as a static Bearer header) and exports the daemon's resolved key into the child env as `CHORUS_API_KEY` (via env, never argv), plus `CHORUS_DAEMON_HEADLESS=1`. The first integration task **validates headless MCP loading live on this host**; the `chorus-api.sh` REST fallback (already shipped in the Kiro plugin) is built **only if** live MCP proves unreliable — it is not a v1 deliverable by default.

- **Transcript: reconstruct from the session store, fall back to plain-text (transcript = human steer "优先选择2，回退到1").** Since Kiro has no per-message stream, after each turn `KiroSpawner` reads Kiro's on-disk v2 session store for the run's `sessionId` (`~/.kiro/sessions/cli/<sessionId>.jsonl` + metadata sibling), converts each `{kind, data.content[]}` line to a structured transcript entry, and feeds them to the existing transcript-upload hook. Reviewer subagents spawn **child** sessions (`session_created_reason:"subagent"` + `parent_session_id`), so reconstruction walks child sessions too. **If** the (undocumented) store schema proves unstable at implementation time, the backend falls back to capturing raw stdout as one **plain-text blob per turn** — the fallback is explicitly authorized so a schema surprise never blocks the wake.

## Capabilities

### New Capabilities

- `daemon-kiro-backend`: the contract for the Kiro spawn path — `kiro-cli chat --no-interactive` headless wake with the prompt over stdin, `--agent chorus` profile coupling, the v2 engine target, cross-platform `kiro-cli` executable resolution with a `CHORUS_KIRO_PATH` override, the persisted `idea uuid → kiro sessionId` map driving new-vs-`--resume-id`, the permission-mode → trust-flag mapping (`yolo → --trust-all-tools`; `chorus → scoped --trust-tools=`), the MCP-from-plugin-config posture with the daemon key exported via env, transcript reconstruction from Kiro's on-disk session store (with a plain-text-blob fallback), and detached-process-group interrupt parity.

### Modified Capabilities

- `daemon-agent-selection`: the current requirement enumerates `claude-code` and `codex` as the known backends. This change implements `kiro`, so the requirement is updated: `kiro` is now a known, accepted backend that wakes a local headless Kiro CLI; unknown values are still rejected non-zero; `claude-code` remains the default and behaves exactly as before.

> The `daemon-spawner-interface` capability is **not** changed — `KiroSpawner` satisfies the existing `wake(...)` contract as-is; adding a third implementer requires no interface change.

## Impact

- **Schema**: none. No migration, no Prisma model, no enum. The `idea → sessionId` map is a daemon-local JSON file, not a DB entity.
- **Server code** (`src/`):
  - `src/services/daemon-connection.service.ts` — add `"kiro"` to `DAEMON_CLIENT_TYPES` (else `isValidClientType` refuses the Kiro daemon's registration).
  - `src/components/agent-presence/hooks.ts` — add a `case "kiro"` to the `useClientTypeLabel` switch (else the presence UI mislabels a Kiro daemon).
- **Daemon client code** (in-repo, `cli/`, shipped verbatim in the npm package):
  - `cli/daemon-agent.mjs` — add `kiro` to `KNOWN_AGENTS`; `backendCli` (`CHORUS_KIRO_PATH`) and `backendClientType` (`"kiro"`) branches. Reconcile the stale `client-args.mjs` `KNOWN_AGENTS` (currently only `claude-code`, unused for validation) while here.
  - `cli/kiro-spawner.mjs` *(new)* — `KiroSpawner` implementing the shared `wake(...)`: executable resolution, `buildArgs` (`chat --no-interactive` / `--resume-id <id>` + `--agent chorus` + trust flags), spawn (detached, stdin prompt), sessionId capture, transcript reconstruction from the session store.
  - `cli/kiro-session-map.mjs` *(new)* — persist/read the `idea uuid → kiro sessionId` map (same atomic-write, never-throw shape as `codex-session-map.mjs`; may share a generic helper).
  - `cli/spawner-select.mjs` — add `if (agentType === "kiro") return new KiroSpawner({ logger, permissionMode, creds })`.
  - `cli/claude-spawner.mjs` / `cli/codex-spawner.mjs` — no behavior change (claude-code and codex must not regress).
  - `cli/__tests__/` — unit tests for: agent resolution accepting `kiro` / rejecting unknown; `KiroSpawner` argv (new vs resume, `--agent chorus`, trust flag per mode, prompt never in argv); sessionId capture + map round-trip; executable resolution incl. Windows `.cmd` and `CHORUS_KIRO_PATH`; transcript reconstruction from a fixture session store incl. a child (subagent) session; spawner selection.
- **Kiro is an external dependency**: all `kiro-cli chat` flags (`--no-interactive`, `--resume-id`, `--trust-tools`, `--agent`, `--agent-engine`), the session-store path/schema (`~/.kiro/sessions/cli/<id>.jsonl`), and the plugin agent name (`chorus`) MUST be verified against the installed `kiro-cli chat --help` and the on-disk store at implementation time, not assumed from this proposal (versions drift — verified here against 2.12.1). The store schema is undocumented — the transcript task treats reconstruction as best-effort with a plain-text fallback.
- **MCP tools / `docs/MCP_TOOLS.md`**: unchanged — no new Chorus tool.
- **Skill / onboarding docs**: the daemon onboarding surface (`--agent kiro` command, connection identity) is the sibling **onboarding-UI** child idea (`4181e7b1`), not this backend. This change only updates the daemon's own agent-type docs/banner wording as needed.
- **`docs/design.pen`**: not applicable — daemon CLI behavior change, no user-facing screen (the connection UI is the sibling idea).
- **Cross-platform / deps**: no new npm dependency (pitfall #9); spawn stays `shell:false` with argv arrays; Windows `.cmd` handled via `cmd.exe` like the Claude/Codex path; node-22 documented as a prereq for headless MCP (per the #5958 root cause).

## Out of Scope

- **The REST/agent-key fallback as a default deliverable.** Per `fallback = a`, native MCP is the path; the `chorus-api.sh` fallback is built only if the live-validation task shows headless MCP is unreliable on the daemon host. If validation passes, no fallback ships in v1.
- **Kiro V3 engine.** `--v3` / `--agent-engine v3` / `--mode spec` are owned by the dedicated V3-adaptation sibling idea (`d4a59bab`). This backend targets v2.
- **Kiro model / login authentication.** `kiro-cli` login / `KIRO_API_KEY` setup is the user's responsibility (like Codex model auth); the daemon does not manage Kiro's model credentials.
- **Daemon-side synthesis of a Kiro MCP config.** Not done in v1 — the backend relies on the plugin's `.kiro/settings/mcp.json`.
- **Onboarding / connection UI.** The `npx … daemon --agent kiro` onboarding command, `clientType=kiro` connection identity presentation, and connect/login docs are the sibling onboarding-UI child idea — this change only adds the minimum server-side `clientType` registration + label so a Kiro daemon can connect at all.
- **A fourth backend.** The interface is general, but only `claude-code`, `codex`, and `kiro` are implemented.

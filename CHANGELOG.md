# Changelog

## [0.17.1] - 2026-09-01

### Added
- **Installed agent plugin refresh**: Added one-time update confirmation and native refresh flows for Claude Code, Codex, OpenCode, dsh, OpenClaw, and Kiro. (#516)
- **Live daemon activity on Ideas**: Added real-time daemon activity indicators across Tracker, Graph, and Idea detail views, including mobile session drilldown. (#517)
- **Automated coordinated npm releases**: Added tokenless GitHub Actions publishing for the Chorus CLI, OpenClaw plugin, and dsh plugin with reproducible validation, provenance checks, and safe reruns. (#522)

### Fixed
- **Non-ASCII working-directory resume**: Daemon-backed agent sessions now resume correctly when their working directory contains non-ASCII characters. (#518)
- **Daemon chat initial loading**: Bounded and coalesced initial chat loading work to avoid excessive requests and processing. (#519)
- **Idea assignment targeting**: Project-fixed working-directory targets now take precedence correctly, while reassignment wakes are deduplicated for an unchanged owner; skill documentation now reflects these semantics. (#520, #525)
- **Mobile project creation**: Restored the New Project entry on the mobile project-group bar. (#523)
- **Live-session indicator flicker**: Prevented the active-session popover from reopening when the pointer leaves its trigger. (#524)

---

## [0.17.0] - 2026-08-28

### Added
- **Unified agent management CLI**: Added `chorus agents add/list/remove` for configuring Claude Code, Codex, Kiro, OpenCode, OpenClaw, Pi, and dsh, including plugin installation where supported, credential seeding, per-agent daemon wake controls, and Linux/macOS auto-start. (#503, #504, #506, #507)
- **Native MCP client**: Added `chorus mcp call`, `whoami`, and `list` with multi-agent selection, file-backed arguments, and byte-compatible output for plugin and OpenSpec workflows. (#505)
- **Export-free Claude Code and Codex setup**: `chorus agents add` now configures Claude Code through `~/.claude/settings.json` and Codex through `~/.codex/.env` plus keyless `bearer_token_env_var` MCP authentication. (#509, #510)

### Changed
- **Bootstrap and plugin workflows**: Retired per-agent installation scripts in favor of the unified CLI; plugin MCP wrappers now prefer `chorus mcp call`, with compatibility fallbacks when the CLI is unavailable. (#507)
- **Agent check-in context**: Replaced the per-Idea check-in list with a bounded active-project distribution while preserving full assignments on demand and adding AI-DLC/search guidance at session start. (#512)

### Fixed
- **Codex sub-agent orchestration**: Updated worker and reviewer spawning to use the current object-based spawn API, explicit skill mounting, and correct lifecycle handling. (#511)
- **Nested theme status**: Container Idea status now rolls up bottom-up across nested themes while preserving direct-child progress and deterministic cycle handling. (#513)

### Plugin
- **Plugin and skill versions → 0.17.0**: Claude Code, Codex, OpenClaw, Kiro, Pi, dsh, and standalone skill distributions now share version 0.17.0 and include the new `chorus-cli` skill. (#507)

---

## [0.16.4] - 2026-08-19

### Added
- **DeepSeek Harness (dsh) plugin**: Ships `@chorus-aidlc/chorus-dsh` as an installable npm bundle — Chorus's sixth plugin surface — with the full skill set, a Node `chorus-mcp-call` wrapper, a served credential-provisioning script, a dedicated onboarding tab, and `CONNECT_DSH` docs. (#499)
- **Backend-session resume**: Daemon-spawned backends now persist a `backendSessionId` (new Prisma migration) so a turn can resume the underlying agent session across the daemon turn-advance path. (#499)
- **Prompt for agent backend when adding a daemon agent**: `daemon login`, `--add`, and the install "Add another agent?" loop now ask which backend to use (Claude Code / Codex / Kiro), reusing the install backend menu. `--agent` still wins; choosing nothing omits the field so the agent inherits the daemon default instead of a hardcoded `claude-code`. (#501)

### Fixed
- **Approve/reject proposal without a cwd picker**: Approving or rejecting a proposal in the UI no longer pops the cwd picker. The assignee wake target resolves entirely server-side (follow pin → online idea-session origin → agent-owner project cwd); with no pin it wakes only when exactly one connection is online and suppresses to notify-only on two or more. (#500)

### Plugin
- **Plugin & skill versions → 0.16.4**: Claude Code, Codex, OpenClaw, Kiro, Pi, and dsh plugin/skill distributions plus the standalone skill all bumped to 0.16.4.

---

## [0.16.3] - 2026-08-17

### Added
- **Assign an idea to an agent or user (MCP)**: New `chorus_pm_assign_idea` tool (idea:admin) assigns an Idea to a specified agent or user, reusing the existing `idea_claimed` wake; the wake prompt now names the assigner and advances from the current stage. Ships alongside a new `chorus:orchestrate` multi-agent-collaboration skill across all six skill surfaces with entry-skill routing. (#494)
- **DiceBear agent avatars**: Agents now render as deterministic, animated DiceBear (Voxel Bot) avatars via a single shared `<AgentAvatar>` component, swept across ~30 surfaces — collaboration/comments, idea & task assignees, real-time presence/connections, proposal creators, onboarding, cwd pins, API-key list, and daemon chat. Humans keep their initials/User icon; the presence graph canvas keeps its name-hashed color ring. (#497)

### Changed
- **Gateway resolve/skip of an assigned idea's elaboration**: A non-assignee holding `idea:admin` can now resolve or skip an assigned idea's elaboration; doing so emits `elaboration_verified` to wake the assignee agent to write the proposal — MCP parity with the UI Verify-Elaborate handoff. Assignee self-validate/skip is unchanged. (#495)

### Fixed
- **Concurrent daemon sessions duplicating work**: An autonomous idea-anchored wake still resolving to `online_first` after all pin steps now deterministically narrows to a single connection instead of broadcasting to every online connection of the agent, closing the Case-4 fan-out that produced duplicate elaboration rounds and near-duplicate comments. (#496)

### Plugin
- **Plugin & skill versions → 0.16.3**: Claude Code, Codex, OpenClaw, Kiro, and Pi plugin/skill distributions plus the standalone skill all bumped to 0.16.3.

---

## [0.16.2] - 2026-08-16

### Added
- **Daemon wake coalescing**: When a session's wake-queue slot frees, all still-pending same-session wakes now drain into ONE `claude --resume` turn instead of one turn per wake (human instructions exempt, so chat backlog is never dropped). (#489)
- **Persisted orchestrator handoff**: Agent orchestrator handoff is now persisted, and daemon/OpenClaw wake prompts carry handback guidance — leave a human-gated resource pending and hand a finished or gated resource back to whoever engaged you. (#487)

### Changed
- **Merged-turn transcript collapse**: Coalesced-away turns collapse into a single band with a dedicated "Merged" label and an expandable merged-events section, with live SSE convergence so a viewer no longer sees them stuck at "pending". (#490)
- **Reviewers enforce project context files**: Proposal, task, and aggregate code reviewers across all five plugin ports and the standalone skill now flag any plan or code that violates a repo's declared context-file rules (CLAUDE.md / AGENTS.md / .cursorrules) as a BLOCKER. (#492)
- **Repositioned landing + slim READMEs**: "Harness" now names Chorus one level above your coding agents; all four READMEs slimmed from ~461 to ~130 lines, with deep reference content moved to doc.chorus-ai.dev. (#491)

### Plugin
- **Plugin & skill versions → 0.16.2**: Claude Code, Codex, OpenClaw, Kiro, and Pi plugin/skill distributions plus the standalone skill bumped to 0.16.2. (#492)

---

## [0.16.1] - 2026-08-14

### Added
- **Multi-agent daemon configs**: One daemon can now serve N independent agents, each with its own credentials and working directory. (#483)
- **GitHub + Docs resource links**: Added quick links to the GitHub repo and documentation site in settings and onboarding. (#481)

### Changed
- **Multi-agent project-scope polish**: cwd badge/tooltip, autonomous-wake project-owner pin, and presence count for multi-agent daemon setups. (#484)

### Fixed
- **@mention wake cwd**: @mention wakes now respect the pinned cwd, and directed wakes spawn in the resolved connection's cwd rather than a stale/random one. (#485)
- **Daemon chat list empty state**: The conversation list shows a loading skeleton instead of an ambiguous empty state while loading. (#482)
- **Claude session anchor**: The daemon reports the Claude `--resume` anchor as `backendSessionId`, restoring the Copy session ID action. (#480)

---

## [0.16.0] - 2026-08-09

### Added
- **Documentation site surfaced to agents & users**: Wired the live docs site (https://doc.chorus-ai.dev) into three entry points — a new `docs` router skill on all six skill surfaces (Claude Code, Codex, OpenClaw, Kiro, Pi, standalone) that reads the root-only `/llms.txt` index and fetches raw Markdown per page, a localized Documentation link in each README (en/zh/ko/ja) header, and a language-aware Documentation entry in the landing-page nav. (#477)

### Fixed
- **Codex skill-invocation hints**: Corrected Codex skill docs to use the proper `$`-prefix invocation form (e.g. `$develop`, `$yolo`) instead of the slash form. (#477)

### Plugin
- **Plugin & skill versions → 0.16.0**: Claude Code, Codex, OpenClaw, Kiro, and Pi plugin and skill distributions plus the standalone skill bumped to 0.16.0. (#477)

---

## [0.15.1] - 2026-08-05

### Added
- **Lifecycle-wide Idea reassignment**: Ideas can now be reassigned throughout their lifecycle while preserving project cwd routing and wake behavior. (#473)

### Fixed
- **Unified project cwd persistence**: Project creation and settings now share validated cwd persistence, with refreshed status after saving. (#472)
- **Cleaner assignment modal**: Removed the redundant Idea summary from the assignment dialog. (#474)
- **Cleaner Proposal header**: Removed the redundant cwd card from Proposal actions. (#475)

---

## [0.15.0] - 2026-08-03

### Added
- **Project Agent cwd configuration**: Added daemon-backed directory discovery and per-project Agent working-directory preferences, with safe browsing, path autocomplete, and keyboard-friendly selection across fixed and temporary cwd flows. (#468, #469)
- **Authoritative project cwd anchoring**: Project cwd settings now consistently govern Idea, Task, mention, conversational, stage-advance, wake, resume, and continuation routing while preserving existing assignment targets and active-session stickiness. (#470)

### Changed
- **Session-free Codex workflows**: Removed obsolete Chorus session-management guidance from Codex skills and hooks while retaining compact startup context and structured hook error handling. (#466)

### Fixed
- **Resumable Codex session IDs**: Persisted the backend Codex thread ID separately from Chorus routing identifiers so interrupted daemon conversations resume correctly and the existing copy action returns the usable session ID. (#467)

### Plugin
- **Plugin & skill versions → 0.15.0**: Claude Code, Codex, OpenClaw, Kiro, and Pi plugin and skill distributions bumped to 0.15.0.

---

## [0.14.6] - 2026-07-30

### Added
- **Pi coding agent integration**: Added a complete Chorus AI-DLC extension for Pi, including eight workflow skills, three reviewer agents, automatic session lifecycle management, OpenSpec support, configuration fallback, tests, and installation documentation. (#457)
- **Automated code-review blocker remediation**: Aggregate code-review BLOCKERs now create Quick Dev fix tasks on the approved Proposal, require independent review, and either self-verify with explicit `task:admin` permission or hand off asynchronously with evidence. The workflow is aligned across Claude Code, Codex, OpenClaw, Kiro, Pi, and standalone skills. (#462)

### Changed
- **Bounded MCP collection responses**: Collection tools now return bounded, consistently paginated results with authoritative payloads and aligned paging metadata, reducing context growth from large list responses. (#463)
- **Global Claude Code plugin state**: Hook coordination state now lives under `~/.chorus/plugin/<cwd>/<session>/` instead of creating `.chorus/` state in each project. (#461)
- **Pi package layout**: Moved the Pi extension into `packages/chorus-pi` and registered it in the workspace. (#460)

### Fixed
- **Pi excluded from dashboard type checking**: Prevented the standalone Pi extension from being incorrectly included in the dashboard TypeScript build. (#458)

### Plugin
- **Plugin & skill versions → 0.14.6**: Chorus plugin and skill distributions bumped to 0.14.6.

---

## [0.14.5] - 2026-07-27

### Fixed
- **Daemon didn't pass its Chorus URL to woken sessions**: The daemon now exports both `CHORUS_URL` and `CHORUS_API_KEY` into every spawner's child environment (Claude Code, Codex, and Kiro) instead of just the API key, so a woken session's SessionStart hook and shell-based Chorus tooling know which Chorus instance the wake belongs to. Both values are set in the child env (never argv) and explicitly overwrite inherited values so the hook and daemon can't disagree. Codex additionally logs a diagnostic warning when the user's `~/.codex/config.toml` has no `[mcp_servers.chorus]` entry, so a wake that will run without Chorus MCP tools says so instead of failing silently. (#454)

### Plugin
- **Plugin & skill versions → 0.14.5**: Claude Code, Codex, OpenClaw, and Kiro plugins plus the standalone skill bumped to 0.14.5.

---

## [0.14.4] - 2026-07-25

### Added
- **Configure the daemon's agent backend from `daemon.json` + an install prompt**: The daemon's agent backend can now be persisted instead of re-passed on every start. `resolveAgentType` reads an `agent` field from `~/.chorus/daemon.json`, closing the gap with its siblings (`cwds`, `sigintTimeoutMs`) — precedence is `--agent` flag → `CHORUS_AGENT` env → `daemon.json` `agent` → `claude-code` default, with unknown values still a hard error from any source. `chorus daemon install` now prompts interactively for the backend (Claude Code / Codex / Kiro; Enter accepts the default), persists the choice to `daemon.json`, and probes the selected CLI on PATH with a loud but non-fatal warning when it is missing. The generated service unit no longer bakes `--agent` into `ExecStart` — the backend lives in `daemon.json` as the single source of truth, mirroring how `--cwd`/`cwds` is already handled. `-y`/`--yes` and non-TTY installs skip the prompt and take the default. (#452)

---

## [0.14.3] - 2026-07-25

### Added
- **Per-turn token usage in daemon conversations**: Daemon-driven turns now capture, upload, persist, and display token usage per turn for both backends. Claude Code usage is read from the authoritative `result` envelope of the `stream-json` stream (snake_case `result.usage`; model sourced from `modelUsage[<id>].canonicalModel`, never the usage object; on-disk JSONL is never read, avoiding the upstream placeholder bug); Codex usage is normalized from the CLI's cumulative snapshots into persisted per-turn deltas. Threaded end-to-end through the wire chain (`upload-hooks` → `waker` → `turn-reporter` → REST client → `turn-advance` route → `daemon-session` service) with a shared `TokenUsage` contract mirrored byte-for-byte into the OpenClaw REST client. (#446, #447)

### Fixed
- **Daemon went silently deaf after a long idle (SSE partition)**: A long-idle daemon on Linux could lose its SSE stream without noticing — the listener relied on undici's unconfigured body timeout and the server's split-brain kept the origin "online", so wakes silently no-op'd. Added an explicit client-side heartbeat watchdog (~75s) that detects the dead stream and reconnects, plus a `connection-heartbeat` route and server-side recovery so partitions surface instead of hanging. (#449)
- **Codex session lost across an interrupt**: Interrupting a Codex-backed daemon turn no longer discards the session — the `thread_id` is preserved so the conversation resumes on the next turn instead of forking a fresh thread. (#448)
- **Idle-session transcript relay dropped replies (#444)**: After a daemon session sat idle, continuing the conversation repeated the same instruction across turns, each showing "no reply retained". The turns actually ran but the transcript relay lost the reply (no flush-on-exit, no retry). Now flushes the debounced transcript before advancing to a terminal status, retries the upload with backoff, drains on stop, collapses duplicate pending instructions onto the existing turn, and surfaces a genuine upload failure inline (distinct from an honestly empty turn). (#445)
- **OpenSpec round-trip verification is now exact**: The document round-trip verifier that guards OpenSpec-mirrored drafts now compares content exactly rather than approximately, catching mirror drift that the looser check let through. (#450)

### Plugin
- **Plugin & skill versions → 0.14.3**: Claude Code, Codex, OpenClaw, and Kiro plugins plus the standalone skill bumped to 0.14.3.

---

## [0.14.2] - 2026-07-19

### Added
- **Sidebar project quick-access (recent + pinned)**: The left sidebar gains a project quick-access region — one merged list of pinned projects (unlimited, pin-time order) followed by up to 5 recently visited, each row showing its project-group sub-line and the same hash-computed color+initials icon as the /projects list. Pin/unpin works from both sidebar rows and /projects cards via a shared client provider (reflects across surfaces with no reload). Recent (unpinned) rows get a ⋯ overflow menu with Pin / Remove-from-recent; remove is a soft-remove (returns on next visit). Backed by an account-level, cross-device `ProjectVisit` model (per user × project, `lastVisitedAt` + nullable `pinnedAt`) under user-only `/api/project-visits`. (#438, #440)

### Changed
- **Unified daemon presence into one bottom-right entry**: The two disjoint bottom-corner daemon affordances — the bottom-left sidebar presence pill and the bottom-right pixel-canvas widget — are merged into a single bottom-right floating entry. One click opens a slim online-agent roster with a prominent "Open chat" action (collapsing the old pill → popover → "View all" → modal chain); the pixel-canvas view is retained as a project-scoped "Open pixel workspace" secondary. Global Settings also moved from the project-conditional global nav into the resident sidebar footer. Frontend-only refactor over the existing presence spine. (#437)
- **Slimmer MCP tool surface for long-context stability**: Compressed 7 over-long MCP tool descriptions to ≤2 sentences and converted 6 filter/type params from free-form strings to strict enums, cutting every-turn `tools/list` cost that drives long-context tool-call degradation (top-level descriptions −71%). Enums use verified current stored domains; behavior red-lines relocated to per-param `.describe()`. (#436)

### Fixed
- **Daemon session running indicator disagreed with Interrupt**: The conversation-list running dot read only the origin-connection execution slice while Interrupt searched all slices, so after a cwd/agent switch or session re-point the dot could read idle while Interrupt still worked — now both derive from the same matched set via `sessionExecStatusForRow`. Also emits a visible warn on the "non-null root idea, null `directIdeaUuid`" lineage gap (a pre-`directIdeaUuid` server fingerprint that breaks child-wake matching). (#439)

### Plugin
- **Plugin & skill versions → 0.14.2**: Claude Code, Codex, OpenClaw, and Kiro plugins plus the standalone skill bumped to 0.14.2. (#441)
- **SessionStart nudges OpenSpec setup when off**: When OpenSpec mode is inactive because it isn't set up, the SessionStart banner now shows `(OpenSpec off — run `/chorus enable openspec` to set it up)` (`$chorus` on Codex), while an explicit opt-out still shows a neutral `(OpenSpec off)`. A new "Enable OpenSpec Mode (Optional)" skill section on all four plugin surfaces instructs the agent to run the install/init for the user. (#442)

---

## [0.14.1] - 2026-07-16

### Added
- **Amazon Kiro CLI integration (4th plugin surface)**: A Chorus plugin for Amazon Kiro CLI — installed via a one-shot `install-kiro.sh` that merges loose `.kiro/{agents,skills,steering,settings}` templates (the Chorus MCP server, eight `chorus-*` workflow skills, a `chorus` main agent with session-lifecycle hooks, and three read-only reviewer subagents) into your Kiro config, global or `--workspace`-local. Paired with a `--agent kiro` daemon backend (wake / resume / interrupt / transcript) so a remote dispatch can drive a local Kiro headlessly. Documented in `docs/CONNECT_KIRO.md`, linked from every README locale. (#425, #427)
- **Pin a cwd before waking a daemon**: Waking a daemon-hosted agent now prompts for the target working directory instead of defaulting to the first daemon — a cwd picker on wake, non-waking reassign, HARD pins that stick, and `@mention` inheriting the idea's pin. (#431)
- **Persist project-group expand/collapse state**: The project-list group open/closed state is now remembered across visits via `localStorage`. (#424)

### Changed
- **External-reference attachment is now an agent reflex**: The idea/skill workflow nudges agents to attach reference artifacts (a `### References` step + wake-prompt nudge), and reference `notes` are clamped to 2 lines in the UI with a hover tooltip + tap-to-expand; the MCP docs nudge concise notes. (#423, #432)
- **Offline hint on stage-advance buttons moved into a tooltip**: The Start Development / Yolo buttons show their offline hint as a tooltip rather than inline text. (#422)

### Fixed
- **`chorus daemon install` drops credentials under systemd**: The install path now persists + validates `CHORUS_URL` / `CHORUS_API_KEY` into `daemon.json` for the boot service (systemd `--user` clean-env stripped them), plus an interactive multi-cwd setup wizard. (#430)
- **Daemon conversation forks on cwd/agent switch**: Switching an idea's cwd or agent re-points the existing conversation instead of forking a residual chat, and interrupt is now reachable from any thread. (#429)
- **Child-idea wake lit the parent chat**: Child-idea wake is now anchored to the child conversation, and the approve note is delivered inline. (#428)

### Plugin
- **Plugin & skill versions → 0.14.1**: Claude Code, Codex, and OpenClaw plugins plus the standalone skill are bumped to 0.14.1, with the new Kiro plugin surface added. (#423)

---

## [0.14.0] - 2026-07-11

### Added
- **Dark mode across the entire app**: A light/dark/system theme (next-themes, `.dark` class on `<html>`, default = system, per-device `chorus-theme`, FOUC-safe), with a combined language/theme control in the sidebar footer. ~2000 hardcoded hex utility classes were migrated to semantic design tokens (byte-identical in light) with hue-matched `dark:` variants for status colors; the three surfaces `dark:` can't reach were handled explicitly — inline-style colors (CSS-var + scoped `.dark` rule), the project graph `<canvas>` (live `.dark` read + MutationObserver repaint), and @xyflow/react's unlayered chrome (`colorMode` prop). Shiki code blocks are theme-aware. (#414)
- **Korean (ko) locale**: Full Korean translation of the app (1482 keys at parity with en/zh), registered as a first-class locale with automatic browser detection. (#411, #419)
- **Japanese (ja) locale**: Full Japanese translation (1482 keys at parity), kanji/wago-first glossary (着想/課題/提案/文書), です・ます polite form, auto-detected for ja/ja-JP. (#420)
- **First-class research/reference artifacts**: A new `ReferenceArtifact` entity so external evidence (docs, reference repos, issue/PR threads, papers/blogs) can be attached to ideas, proposals, and tasks and read back inline. REST `GET/POST /api/references` + `GET/PATCH/DELETE /api/references/[uuid]` (gated on `document:read`/`document:write`, no new permission bit), MCP `chorus_add_reference` / `update_reference` / `remove_reference` plus inline `references[]` on get/create tools, and read-only References sections on idea/proposal/task detail with a batched per-idea reference count in the tracker. (#399, #418)
- **Top-of-page navigation progress bar**: A slim NProgress-style loading bar pinned to the viewport top during App Router client navigations, themed via the `--primary` token (adapts to light/dark with zero per-theme JS). Programmatic navigation is covered via a shared `use-progress-router` hook. (#416)

### Plugin
- **Plugin & skill versions → 0.14.0**: Claude Code plugin, Codex plugin, OpenClaw plugin, and standalone skill versions bumped to 0.14.0. The reference MCP tools (`chorus_add_reference` / `update_reference` / `remove_reference`) are documented in the skill tool rows. (#418)

---

## [0.13.2] - 2026-07-09

### Added
- **Theme (container) ideas**: A new `Idea.isContainer` "theme" — a parent idea that groups related child ideas under a shared direction. A theme can elaborate but cannot create a proposal; to deliver, derive a child idea and write the proposal there. The flag is orthogonal to lineage, freely reversible, and guarded at the single `createProposal` choke point (company-scoped, no bypass across action/REST/MCP). Full UI chain: one-step empty-theme creation in the new-idea dialog, a THEME-vs-IDEA type-eyebrow across tracker rows and the detail panel, a Linear-style x/y progress ring rolling a theme's status up from its children (no N+1), and a daemon-assisted "decompose into child ideas" flow that reuses the conversational-idea entry + elaboration re-wake (no new wake action or plugin ports). (#409)
- **Trackpad zoom & pan gestures for project graph views**: A Figma/Miro-style trackpad model across both graph surfaces — two-finger swipe pans, pinch zooms — while keeping mouse users supported. The canvas mind-map gains an on-screen +/- / fit control cluster; the ReactFlow task DAG gets a shared pan/zoom prop set (pinch + Ctrl/Cmd + Controls zoom), with the readonly dashboard preview excluded. (#408)

### Changed
- **Idea panel reassign moves onto the assignee block**: The dashboard idea-tracker detail panel drops its icon-only footer reassign button; reassign now triggers from the assignee block shown in the elaboration tab (same `status !== "elaborated"` gate). The shared Yolo button is restored to a full rocket icon + "Yolo" label (purple styling and confirm dialog kept). The `/ideas` panel keeps its own footer reassign button. (#410)

### Fixed
- **Slow/high-resolution mouse wheel intermittently panned instead of zoomed on graphs**: The #408 trackpad gestures introduced a mouse-vs-trackpad device classifier that misfired — a smooth-scroll mouse is indistinguishable from a trackpad on the wheel event stream. Settled on a deterministic model: a plain wheel **always** zooms around the cursor at any speed, pinch zooms, and drag pans. The classifier (`wheel-gesture.ts`, `dag-wheel-nav.tsx`) is removed and the task DAG returns to ReactFlow default scroll/pinch zoom, converging with the readonly preview. (#412)

### Plugin
- **Plugin & skill versions → 0.13.2**: Claude Code plugin, standalone skill, and OpenClaw plugin versions bumped to 0.13.2. The "container" idea concept is renamed to **"Theme"** across i18n values, MCP tool descriptions, and skill docs (the underlying `isContainer` field, keys, and tool names are unchanged). (#409)

---

## [0.13.1] - 2026-07-07

### Added
- **Stage-advance framework — Start Development & Yolo**: A generic stage-advance framework replaces the elaboration-only path. Both idea-detail panels now expose a **Start Development** button (server preconditions + activity + `start_development` wake) and a **Yolo** button (`yolo_requested` wake) so a human can hand an idea straight to autonomous development from the UI. (#389, #404)
- **Conversational idea entry**: The new-idea dialog gains a conversational mode — describe your idea to an agent and hand off directly into chat. The agent-name Select always shows, even with a single online agent. (#391)
- **Conversational idea root session**: Conversational idea creation now dispatches transactionally through `/api/ideas/conversational` — it pre-creates the idea, an idea-anchored root session, and the first instruction in one step, via a pluggable dispatch surface. (#392)
- **One-click Resume for crash-exited daemon executions**: Crash-interrupted executions (`interruptedReason=crash`) are now manually resumable from the chat window and connection deck, with a crash-specific continue instruction injected into the resumed wake. Covers both Claude Code and Codex backends. (#390)
- **Graceful daemon shutdown + orphan-turn reconcile**: The daemon now reports an outcome-aware turn exit on shutdown, the server reconciles orphan turns for dead daemons (and on new-generation daemon re-registration), turns gain a terminal `interrupted` state, and the daemon conversation surface renders interrupted turns. (#397, #398)
- **`chorus daemon install`**: A systemd supervisor unit generator for running the daemon as a background service, with quoted `ExecStart` tokens and restart-on-reinstall. (#402)

### Fixed
- **iOS resume login-bounce**: Middleware OIDC refresh failures are now non-destructive — middleware never destroys auth state. Browser auth is cookie-only (keepalive and the resume gate deleted; `sync-token` is recovery-only), with last-resort refresh-token recovery after an iOS cookie purge and structured refresh-token diagnostics. Agent-presence polling pauses after consecutive dead-session 401s. (#400)
- **Daemon stop misreads a live daemon as stale after an NTP clock step**: A boot-time NTP step shifted `ps lstart`, so `startedAt` string-equality vetoed the pidfile match and cleared a live daemon as stale. (#401)
- **Daemon stale-PID identity**: `stop` now identity-verifies pidfile liveness so recycled PIDs read as stale, adds a `stop --force` escape hatch + exit-code contract, and uses a busybox-compatible `ps` fallback. (#390)

### Changed
- **Idea panel action row**: Decluttered — Reassign and Yolo are now icon buttons with shadcn Tooltips. (#406)

### Plugin
- **OpenClaw plugin → 0.13.1**: The OpenClaw plugin router now handles the daemon stage-advance wake events (`start_development`, `yolo_requested`). Version bumped 0.11.1 → 0.13.1. (#405)

---

## [0.13.0] - 2026-07-02

### Added
- **Per-project resource mind-map**: A new per-project graph view renders the Idea → Proposal → Document/Task lineage as a deterministic, collapsible mind-map tree (d3-hierarchy) on a Canvas-2D renderer that works on every viewport, including two-finger pinch and double-tap zoom on touch. Every node card shows the entity's status at a glance — ideas carry the 8-state derived badge that mirrors the idea tracker, proposals/tasks show native lifecycle status, documents show their type — updating live via the existing SSE full-refetch. A title search box auto-expands the ancestor hubs of every match, highlights hits while dimming the rest, and offers current/total count with prev/next navigation that centers each match (Enter / Shift+Enter step through, IME-guarded); clearing the query drops only the search visuals and leaves the located branches expanded. Desktop nodes gain a hover tooltip with the full untruncated title, and a compact top-right control card holds search, the type filter/legend, and expand-all (folding to an icon button on narrow viewports). (#376, #377, #378, #380, #383, #386)

### Fixed
- **Proposal approve/reject wakes hit a random cwd instead of the idea's session origin**: `proposal_approved` / `proposal_rejected` map to the `task_assigned` turn trigger, so they missed the session-origin upgrade that was gated only on `elaboration_verified` and fell back to online-first (a random online cwd) instead of the connection where the idea's conversation lives. The upgrade is now generalized to the autonomous idea-anchored trigger family (`task_assigned`, `elaboration`, `elaboration_verified`), which also fixes `idea_claimed` and task wakes. (#381)
- **First-run P1000 when the embedded PGlite port was occupied**: A first `chorus` run hit Prisma P1000 when a foreign Postgres already held the embedded PGlite port — the forked PGlite child died of `EADDRINUSE` but exited code 0, so `waitForTcp` mistook the foreign listener for PGlite, printed a false "PGlite ready", and migrate failed auth (a residual `DATABASE_URL` hit the same wall). The launch is extracted into a pure, dependency-injected `cli/embedded-db.mjs` with a pre-flight port probe and a child-exit latch that is fatal for any exit code. (#384)
- **@mention cwd picker wasn't keyboard-completable**: The secondary cwd picker (`MentionInstancePickerDialog`) opened with nothing selected, so the keyboard couldn't confirm and Pin was disabled until a click. It now default-selects the first cwd on open (Pin enabled immediately, roving focus lands on a concrete row), and Enter confirms the current selection — scoped to the list region so it never double-fires with the footer, and IME-guarded per the CLAUDE.md rule. (#385)

---

## [0.12.1] - 2026-06-29

### Added
- **Codex daemon backend (`chorus daemon --agent codex`)**: A remote-dispatched wake can now spawn a local headless **Codex** instead of Claude Code. Codex generates its own `thread_id` (persisted per-anchor for `codex exec resume`), permission posture is subcommand-aware (yolo → bypass-approvals-and-sandbox; chorus → read-only sandbox), MCP comes from the user's `~/.codex/config.toml` with the daemon key passed via the configured `bearer_token_env_var`, and interrupt parity is preserved via a detached process group. The Claude Code path is byte-unchanged. (#370)
- **Conflicting daemon connections warn + skip instead of silent takeover**: A second `chorus daemon` registering at the same (agent, host, cwd) as a live different-process daemon previously upserted (silently took over) the connection row, racing two processes on the same dispatch/control channel. The server now detects a fresh different-process incumbent and returns a conflict that writes nothing; the daemon warns and permanently skips that cwd, exiting non-zero only if every declared path conflicts. Stale/crash incumbents and same-process reconnects still take over / refresh as before. (#372)

### Fixed
- **Skill bodies leaked into daemon transcripts**: A loaded skill body is delivered to the headless Claude Code session as a synthetic user turn (`type:"user"` + `isSynthetic:true`), and the block-level text filter kept it — leaking the full skill body into the Chorus transcript. These envelopes are now dropped (structural match only, so real human instructions and agent replies are never affected), with defense-in-depth stripping of `<system-reminder>` spans. (#373)
- **Daemon presence list jittered on every refresh**: Connection order was driven by `lastSeenAt` (which changes on each heartbeat), so equivalent refreshes reshuffled the agent list and per-cwd rows. Ordering is now online-first then by stable identity, with `lastSeenAt` display-only; a defensive frontend comparator prevents re-introducing jitter. (#371)
- **Root route / login bounced already-authenticated users**: After a long idle, reopening onto the root route (`/`) could bounce a still-valid session to `/login`, and `/login` never checked auth state so the user was stranded on the form. The root route now uses the same prime-and-retry session contract as the dashboard layout (redirecting only on a true post-prime 401), and `/login` redirects an already-authenticated visitor straight into the app.
- **`chorus login` clobbered `daemon.json`**: `chorus login` and the daemon's TTY credential-completion path overwrote the entire `~/.chorus/daemon.json`, destroying pre-existing `cwds` / `yoloAckAt` (a crash-loop + re-prompt footgun when running the daemon as a boot service). Every config write now goes through a single read → shallow-merge → atomic write helper, and a loud `claude`-not-found warning is emitted at startup. (#367)

### Changed
- **Landing page integrations refreshed**: The "Plug Into Your Agent Stack" section now lists Claude Code, Codex, OpenClaw, and the universal skill as four equal cards (was three, no Codex), with corrected counts and capabilities (Codex backend, OpenClaw embedded-agent wake + interrupt/resume).

---

## [0.12.0] - 2026-06-27

### Added
- **Multi-path daemon — one daemon, many working directories**: A single `chorus daemon` can now serve multiple working directories via `--cwd` / `CHORUS_DAEMON_CWDS` / `daemon.json cwds:[]`, opening one independent connection per cwd with no project binding. Each spawn runs in its own cwd; resume pins to the origin (host, cwd) connection and cross-cwd resume is rejected rather than silently misrouted. (#353)
- **(agent, host, cwd) addressable daemon instances**: Each (agent, host, cwd) is now individually visible and addressable across presence, @mention, task assignment, ad-hoc send, and the chat header. Path-first / host-conditional display with left/right truncation; presence is a collapsible per-cwd drill-down showing **online instances only**; pickers auto-pin a lone live instance and offer a secondary cwd picker when 2+ are live. A conversation whose origin cwd goes offline can be re-pointed to another online cwd of the same agent, preserving its `sessionId`. (#354)
- **Idea-rooted pin-once-inherit (AgentInstance as a first-class actor)**: `AgentInstance` is promoted to a durable, third polymorphic assignee type (`agent_instance`), and the **idea** is the authoritative pin root — proposals / tasks / wakes for the same agent inherit the idea's pinned instance instead of each entity carrying its own pin. Soft (assignment) pins degrade gracefully to online-first when the instance is offline; hard (mention) pins stay notify-only. REST claim routes and `chorus_pm_assign_task` accept an optional `instanceUuid`. (#359)
- **Comment agent @mentions render as online-status badges**: Agent @mentions in the comment area become interactive badges — name + online dot, a click popover with identity (and cwd/host for a pinned mention), and an owner-only, online-only "Open conversation" button that opens the daemon chat focused on the agent or pinned instance. User mentions and all other surfaces are unchanged. (#358)
- **Cursor-based infinite-scroll comments**: `UnifiedComments` now first-paints only the newest page and auto-loads older pages on scroll, with a burst-safe SSE merge that no longer reloads the whole list. Additive cursor mode in `listComments` (selected by `limit`); the offset path and `chorus_get_comments` are byte-for-byte unchanged. (#360)

### Fixed
- **Pinned autonomous wakes hit the wrong cwd instance**: A pinned @mention / task dispatch (and the `elaboration_verified` proposal-writing wake) woke any online instance because the daemon-side live wake was an agent-wide broadcast. Wakes are now routed directionally to the resolved online target connection via a `deliver_turn` control ping; offline pin = notify-only, no wake. (#357)
- **`chorus daemon` didn't shut down gracefully**: The server's SIGINT/SIGTERM handlers were registered unconditionally and pre-empted the daemon's graceful stop (stale presence, misleading message). Signal handlers are now confined to the server launch path so a daemon/login process shuts down through its own path. (#356)
- **Instance picker: second cwd row unselectable**: An id collision + label double-fire made the 2nd cwd unselectable once a conversation was open (and disabled mobile @mention "Pin instance"). Fixed across new-conversation, @mention (incl. mobile Pin), and assign. (#355)
- **Assign Idea/Task modals overflowed short mobile viewports**: Both assign modals now use a shared `ScrollableDialog` (capped at `max-h-[85svh]`, pinned header/footer, single internal scroll region), keeping the Assign/Cancel buttons reachable with a soft keyboard. (#362)
- **@mention cwd picker overflowed on mobile**: The `MentionInstancePickerDialog` gains a mobile-safe `svh`-based layout with an internal-scroll list and is lifted above the idea detail panel's z-index. (#361)

### Changed
- **Daemon help & config documentation**: Top-level `chorus --help` now matches the yolo-default posture (with `--chorus-only` as the opt-out), the multi-path daemon and the full `~/.chorus/daemon.json` field set are documented in README (en + zh), and the startup banner shows the resolved `daemon.json` path. (#363)

---

## [0.11.1] - 2026-06-22

### Added
- **Ship-time code-review gateway**: A new read-only `code-reviewer` agent runs as the final AI-DLC gateway — after the last task of an idea-rooted proposal is verified, it reviews the idea's *aggregate* code change (cross-task integration, architecture consistency, security, regression, feature-level coverage) and posts one VERDICT comment on the idea. Advisory/behavioral like the proposal/task reviewers (it never changes the idea's stored status). Wired across all four plugin surfaces (Claude Code, Codex, OpenClaw, standalone); the `on-post-verify-task.sh` hook gains a last-task-verify branch gated by `enableCodeReviewer` (default on) and bounded by `maxCodeReviewRounds` (default 3). Workflow skills document the gateway and the FAIL → quick-dev fix-task loop. (#350)
- **Copy session ID in daemon chat**: The daemon chat transcript header gains a "Copy session ID" button that copies the bare `claude --resume` anchor so a human can take a conversation over locally. Works for both idea-anchored and ad-hoc sessions; icon-only on mobile, icon + label on desktop, with accessible copy confirmation. (#348)

### Changed
- **Online agents rank first in @-mention candidates**: `searchMentionables` now enriches → sorts → slices (previously sliced before computing liveness, so a flood of matching users could cut online agents out before they were known to be online). Online agents sort ahead of offline agents and users, idle-first among online agents. Pure server-side; both `GET /api/mentionables` and the MCP `chorus_search_mentionables` benefit. (#349)
- **Project description renders as collapsible markdown**: The dashboard project description now renders through the Streamdown markdown pipeline (previously a plain `<p>`) and clamps to a fixed height with a Show more / Show less toggle. Clamping is by rendered height (not char-slicing) so markdown is never cut mid-token; the toggle only appears on actual overflow. (#351)

### Plugin
- **All plugin packages → 0.11.1**: Lockstep bump across Claude Code (marketplace.json + plugin.json), Codex, OpenClaw, every skill `SKILL.md` on all four surfaces, and the standalone `public/skill/` distribution — carrying the code-review gateway. (#350)

---

## [0.11.0] - 2026-06-21

### Added
- **Chorus Daemon — run your local Claude Code as a Chorus agent**: A new `chorus daemon` CLI client mode (plus `chorus login`) authenticates as an agent, subscribes to the notification SSE stream, and on each wake (task assigned / @mention / elaboration / human instruction) spawns a local headless `claude -p` wired to the Chorus MCP server. No new npm deps (headless subprocess, not the Agent SDK; cross-platform). Sessions are deterministically anchored on the dispatched entity's **direct idea uuid** — humans can take over any run with `claude --resume <idea-uuid>`, and a WakeQueue serializes per-anchor so two wakes never resume the same session at once. A headless guard forbids `AskUserQuestion` and routes human-decision points back to Chorus. Ships with TTY credential completion, default-yolo posture (`--chorus-only` for restricted), a startup banner, per-wake lifecycle logs, and `-d` detached background mode (stop/status/restart/logs). (#317, #318, #325, #341, + CLI UX follow-ups)
- **Agent Connections — live daemon observability + control**: A sidebar presence pill → popover → "View all" chat modal for watching and steering daemon agents, backed by a DB-backed, cross-instance `DaemonConnection` registry (self-reported clientType/host/version, generation-fenced liveness) and a persistent per-connection `DaemonExecution` state (running/queued, `execution:{connectionUuid}` SSE channel, deep links). Each session is a persistent conversation: every wake is a turn on a `DaemonSession` with live transcript relay (message-level pagination), continuation pinned to the origin connection. Humans can **inject free-text instructions** (origin-only precise delivery) and **interrupt / resume** a running run via a server→daemon reverse control channel (sticky interrupted status, two-stage process-tree kill). Ad-hoc conversations are first-class. Empty states carry a `npx @chorus-aidlc/chorus daemon` connect CTA. (#319, #320, #322–#327, #330–#337, #342, #343)
- **Verify Elaborate button wakes the daemon PM agent**: A human-clickable "Verify Elaborate" resolves an Idea's elaboration from the UI and wakes the assigned daemon PM agent to write the proposal — closing the Reversed Conversation loop. New user-side `elaboration_verified` wake, distinct from the unchanged agent-only `chorus_pm_validate_elaboration`. (#335)
- **Agent online presence in the @-mention dropdown**: Each agent candidate shows a green presence dot and a status line ("N active" / "Idle"), sourced from the daemon-connection registry, owner-scoped and batched. (#324)

### Changed
- **Daemon defaults to full-autonomy (yolo) mode**: The `chorus daemon` posture defaults to yolo with a prominent banner warning instead of an interactive confirmation; `--chorus-only` (or `CHORUS_CHORUS_ONLY=1`) reclaims the restricted `mcp__chorus__*`-only posture. (de5f4db)
- **README CLI & Daemon usage guide**: New Quick Start section documenting daemon setup (currently Claude Code only).

### Fixed
- **Dashboard idea panel out of sync on soft navigation**: Notification / SSE-toast / search / presence idea links changed the URL but never opened or switched the detail panel. Selection now derives from `useSearchParams()` with the SSR seed gated to first render, so deep-linking and closing a deep-linked panel both behave. (#340)
- **Lineage UI scroll/overflow defects**: Fixed the set-parent picker's non-scrolling candidate list and long-title overflow across picker rows, breadcrumb, and grid-item wrappers. (#339)
- **Daemon chat modal display**: Mobile now fills the viewport edge-to-edge (input pinned to bottom), and wide markdown blocks (tables/code/URLs) are contained instead of overflowing horizontally. (#336)

### Plugin
- **OpenClaw plugin → bidirectional daemon parity**: The OpenClaw plugin now implements the same bidirectional daemon protocol as the `chorus` CLI host, re-mapped to the in-process `runEmbeddedAgent` host — shared pure-REST daemon client, reverse control channel (interrupt/resume/deliver_turn), turn-advance + execution-state + streaming transcript reporting, real mid-run interrupt via AbortController, and pending-turns backfill. The real OpenClaw SDK surface is now typed. (#338)
- **All plugin packages → 0.11.0**: Lockstep bump across Claude Code (marketplace.json + plugin.json), Codex (plugin.json + `chorus-mcp-call.sh` clientInfo), OpenClaw (package.json), every skill `SKILL.md` on all four surfaces, and the standalone `public/skill/` distribution.

---

## [0.10.0] - 2026-06-14

### Added
- **Single-parent idea lineage**: Ideas now form a forest via an `Idea.parentUuid` self-relation. You can derive a child idea from a parent, reparent an existing idea (cycle-checked, same-project), and see a weak read-only "+N derived" rollup that never blocks either idea's elaboration / proposal / task flow. New `chorus_edit_idea` MCP tool (title / content / parentUuid, gated on `idea:write`) replaces the interim `set_idea_parent`; `chorus_pm_create_idea` gains `parentUuid`; `chorus_get_idea` / `chorus_get_ideas` expose lineage. REST adds `parentUuid` on idea-create and `PATCH /api/ideas/[uuid]/parent`. UI gains a tracker flat/lineage toggle with an indented blood-lineage view and an idea-detail Lineage section (parent breadcrumb, set-parent picker with descendant cycle-block, derived children). Human web edits and reparenting now record activity-timeline entries. DDL-only migration. (#307, #309)

### Changed
- **Dashboard is now the primary idea surface**: Unified the Overview tab's two segmented controls into one adaptive Ideas / Lineage / Stats 3-way switch with New Idea standalone, defaulting to the lineage view when a project has derivation and persisting manual choice per-project. The standalone Idea List page is removed — its RESTful URLs (`/projects/:p/ideas`, `/ideas/:ideaUuid`, `?idea=`) now 308-redirect into the Dashboard, the Ideas sidebar nav item is dropped, and internal idea links (search, notifications, stat cards) point straight at `/dashboard`. (#310, #311)
- **Idea Tracker header shows project identity**: The dashboard header now promotes the project name to the H1 and surfaces the project description as the subtitle (falling back to the generic subtitle when empty), with "Overview" demoted to a small eyebrow label. (#312)

### Fixed
- **Superadmin login on email collision**: When `SUPER_ADMIN_EMAIL` matches a registered/default user (common in local dev), the login flow gave the superadmin no way in. `identify()` now returns a `multi_role` response on collision and the login page renders a role-picker routing each choice to its existing flow; `/login/admin` accepts an editable email in the up-front collision flow. Auth endpoints unchanged; i18n en + zh. (#306)
- **Lineage navigation in Overview**: Clicking a parent/child idea (or the post-derive child) in the Overview Lineage section changed the URL but kept the same idea rendered, because the query-only `router.push` fired no popstate. Lineage navigation now threads the parent's `openPanel`, behaving identically to a list-row click. (#313)

### Plugin
- **Claude Code & Codex plugins → 0.10.0, OpenClaw plugin → 0.10.0** (from 0.5.3): Lockstep bump for the idea-lineage feature. All four skill surfaces (Claude Code, Codex, OpenClaw, standalone) updated with the derive / reparent / weak-rollup guidance and the `chorus_edit_idea` tool. (#307)

---

## [0.9.4] - 2026-06-08

### Added
- **Agent install guide in Settings key-creation dialog**: Creating an agent API key from Settings used to dead-end on the raw key with no setup guidance, while onboarding had a full 5-client install guide. The guide is extracted into a shared `AgentInstallGuide` component (single source of truth for both surfaces) and rendered inline in the create-key success state with the freshly created key embedded, so users can connect their agent right where they got the key. Onboarding refactored to consume the same component (behavior-preserving). (#295)

### Changed
- **Elaboration flow simplified — unified round generation, optional roundUuid, idea-level resolve**: `chorus_pm_start_elaboration` now generates any round (first, follow-up, or appended-after-resolution) and is callable both while elaborating and after the Idea is resolved; appended rounds set `isAppended=true` and keep the Idea resolved so an in-flight proposal is never re-blocked. `chorus_answer_elaboration`'s `roundUuid` is optional — auto-locates the single active (`pending_answers`) round. `chorus_pm_validate_elaboration` is re-scoped to a pure idea-level resolve action: takes only `ideaUuid` (no `roundUuid`), gated on `idea:admin`, requires human confirmation (except YOLO), with precondition "≥1 round and every round answered" — never mutates round status. A round's only active states are now `pending_answers → answered`; `validated`/`needs_followup` are legacy-only. New `ElaborationRound.isAppended` column (DDL-only migration); UI surfaces a "Follow-up" badge on appended round cards. Skills across all four surfaces (Claude Code, Codex, OpenClaw, standalone) make the loop explicit: re-enter `start_elaboration` when answers derive new questions or the human raises a concern at the resolve gate; resolve only once the loop has settled. (#296, #297)
- **Task edit UI's acceptance-criteria editor aligned with Task Draft**: The real Task edit form previously rendered AC as a single legacy Markdown textarea while the Task Draft panel used a structured rows editor — the two surfaces had drifted apart. The structured AC editor is extracted into a shared controlled component so both panels render the same UI by construction. Real-task edits persist through the existing `replaceAcceptanceCriteria` service via a small extension to `updateTaskFieldsAction`. Client-side change detection ensures the destructive replace runs only when the criteria set actually changed, so verification marks survive non-AC edits. (#299)

### Plugin
- **Claude Code plugin → 0.9.4** and **Codex plugin → 0.9.4**: Lockstep version bump for the elaboration flow simplification. All four skill surfaces (Claude Code, Codex, OpenClaw, standalone) updated with the explicit ask→answer loop guidance, `validate` reduced to ideaUuid-only, and the appended-round semantics. (#296, #297)
- **OpenClaw plugin → 0.5.3** (skills 0.9.4): Independent package version bump tracking the elaboration flow simplification. (#296)

---

## [0.9.3] - 2026-06-03

### Changed
- **Acceptance criteria now required on task create/edit**: A non-empty acceptance-criteria set is now an invariant of every task and task draft. A shared validator (`src/lib/acceptance-criteria.ts`) is the single source of truth for both the proposal service and the public MCP tool handlers. `chorus_pm_add_task_draft` / `chorus_create_tasks` reject missing or all-blank AC at creation (`create_tasks` is all-or-nothing — one bad task rejects the whole batch). `chorus_pm_update_task_draft` / `chorus_update_task` use partial semantics: AC provided must be non-empty (replaces existing), AC omitted is preserved — so status transitions and dependency edits keep working without resending AC. `chorus_update_task` gains an optional `acceptanceCriteriaItems` param with replace semantics. No schema/migration change; existing AC-less tasks are untouched until next edited. (#291)

### Plugin
- **Standalone skill surface aligned to 0.9.3**: The curl-installable `/skill/` distribution gains a `yolo-chorus` full-auto lifecycle skill plus `proposal-reviewer-chorus` and `task-reviewer-chorus` read-only adversarial reviewer skills (learning from the Codex plugin's skill-based reviewers). All reviewer references are unified to a framework-neutral "spawn a read-only sub-agent, load the reviewer skill, read its VERDICT comment" pattern instead of the Claude-Code-only `chorus:*-reviewer` agent types. Also registers the previously-unregistered `quick-dev-chorus` and `brainstorm-chorus` skills. (#293)
- **Codex plugin hook loading fixed**: The Codex plugin now uses plugin-bundled hooks instead of copied user hooks, refreshes its docs/skills for current hook support, and the installer offers to clean legacy Chorus hook entries. (#292)
- **Claude Code & Codex plugins → 0.9.3**: Version bump across marketplace.json, plugin.json, and all 9 skills to match. The "acceptance criteria required" guidance is synced across all four skill surfaces (Claude Code, Codex, OpenClaw, standalone). OpenClaw intentionally stays on its own version sequence. (#291, #293)

---

## [0.9.2] - 2026-06-01

### Added
- **`section` param on `chorus_get_proposal`**: New optional `section` enum (`basic` | `documents` | `tasks` | `full`), defaulting to `basic`. The default now returns proposal metadata plus a lightweight index of the drafts (uuid/type/title/contentLength for docs; uuid/title/priority/storyPoints/acceptanceCriteriaCount/dependsOnDraftUuids for tasks) with no heavy bodies, instead of the entire proposal on every call. Callers drill into `documents`/`tasks`/`full` on the same `proposalUuid` when they need content. Implemented as a pure `getProposalSection()` projection layered on the untouched `getProposal()`, so the REST route and frontend are unaffected. (#287)

### Fixed
- **@-mention popup not clickable inside modal dialogs**: The mention suggestion popup was appended to `document.body`, so when the editor was hosted inside a Radix Dialog (e.g. the proposal comments Sheet) it inherited `pointer-events:none` and could be selected by keyboard but not clicked — and clicking it dismissed the dialog. The popup now mounts inside the editor's own wrapper (a descendant of the dialog content), inheriting `pointer-events:auto` while `position:fixed` still escapes overflow clipping. (#289)
- **Long notification content clipped off-screen**: Notifications with very long project names, titles, or actor names overflowed the dropdown and were clipped invisible. Bound the ScrollArea viewport content column to the popup width and switched badge/title/action/actor lines to `break-words` so long content wraps instead of overflowing. (#288)

### Plugin
- **OpenClaw plugin rewritten for the OpenClaw 2026.4.27+ Plugin SDK** (→ 0.5.1): Replaces the legacy hand-wrapped-tools + HTTP-hook design with native MCP registration (`mutateConfigFile`), a `definePluginEntry` entry with `activation.onStartup`, SSE→agent wake via `runEmbeddedAgent`, reviewers converted from Claude-Code agent definitions into OpenClaw skills, an npm publish path shipping `src` + compiled `dist`, and 66 new unit tests. (#286)
- **Claude Code & Codex plugins → 0.9.1**: Patch bump tracking the `chorus_get_proposal` section work across all skill trees (proposal-reviewer → `section:full`, task-reviewer/develop → `section:documents`), plus the Codex `chorus-mcp-call.sh` clientInfo fix. (#287)

---

## [0.9.1] - 2026-05-28

### Added
- **Real-time notifications for report creation**: Creating a Document with `type="report"` via `chorus_create_report` now emits SSE events (`document/created` + `idea/updated`) and records an idea-targeted Activity that fans out to bell-popup notifications for the Idea creator, assignee, and their human owners. Bell clicks deep-link to the dashboard's Idea panel. Side-effect steps in `document.service` are best-effort so emit failures cannot roll back the document insert. (#279)
- **`force` flag on `chorus_create_report`**: New optional `force: boolean` (default `false`) parameter. When omitted/false against a proposal that already has a report, the call returns an MCP error and writes nothing — closes a duplicate-report bug observed in `/yolo` runs where two independent paths (PostToolUse hook reminder + skill Phase 5b end-step) both fired against the same proposal. `force=true` preserves the prior multi-report semantics for explicit re-authoring. (#281)

### Fixed
- **IME composition lost text on Enter**: CJK / Japanese / Korean IME users were losing in-progress text when they pressed Enter to confirm a candidate word — the keystroke fired form submit / dialog close / search navigation instead. New shared `isImeComposing(e)` helper in `src/lib/ime.ts` (checks `nativeEvent.isComposing` + Safari `keyCode === 229` fallback) short-circuits 7 affected handlers across 6 files. CLAUDE.md gains a Frontend UI Rule so future Enter handlers route through the helper. (#280, #282)

---

## [0.9.0] - 2026-05-25

### Added
- **Idea-completion summary reports**: New `report` Document subtype captures the post-delivery summary of a finished Idea. New `chorus_create_report` MCP tool (gated on `document:write`) writes a Markdown summary as `Document(type="report")` under an approved proposal — service-side guard rejects writes to non-approved proposals. `chorus_get_idea` now returns `reports[]` (full Markdown content, sorted newest-first across the idea's approved+closed proposals); `chorus_get_ideas` adds a `reportCount` per row. UI surfaces a new Reports list under `IdeaDetailPanel` overview (hidden when zero reports exist). `/yolo` Phase 5b mandates a report at end-of-Idea; `/develop` advises one on the last task; a PostToolUse hook injects a one-line reminder when the verified task's proposal is fully done with no report yet. (#274)
- **Brainstorm skill (idea-stage elaboration prelude)**: Opt-in skill that runs a divergent-then-convergent dialogue and synthesizes the conversation into one ElaborationRound of decision-point Q&A. Solves the failure mode where idea-stage elaboration's structured multi-choice schema forced agents to fabricate options when an idea arrived in "still rephrasing" shape. Distributed to all four packages (Claude Code plugin, Codex plugin, public/skill/, OpenClaw plugin); per-package translation for OpenClaw to match its unprefixed tool surface. Pure producer — calls `start_elaboration` + `answer_elaboration` and returns; lifecycle decision (validate vs follow-up) stays in the idea skill. Zero backend / schema / UI changes. (#273)

### Changed (Breaking)
- **MCP tool surface trimmed (slice 1)**: Removed three redundant tool registrations to reduce same-shape ambiguity that hurts model tool selection. `chorus_pm_create_tasks` is dropped (use `chorus_create_tasks`); `chorus_add_task_dependency` and `chorus_remove_task_dependency` are dropped (use `chorus_update_task` with `addDependsOn` / `removeDependsOn`). Direct break — no deprecation step. Agent-facing surface goes from 80 → 77 tools. (#271)
- **Session lifecycle simplified to `{active, closed}`**: Dropped the `inactive` status and the unused `expiresAt` field on `AgentSession`. "Stale" is now a query-time predicate on `lastActiveAt` (cutoff: 1h). Default UI listings (Settings page per-agent sessions, project worker-avatar header) only show active+fresh sessions; MCP-facing reads (`chorus_list_sessions`, `chorus_get_session`) and Activity-stream lookups remain unfiltered so plugin reuse and audit-trail navigation continue to see everything. Every session-touching MCP tool now refreshes `lastActiveAt` as a side effect of success — plugins no longer need standalone heartbeats during normal operation. The standalone `chorus_session_heartbeat` is retained for explicit keep-alives. The `expiresAt` parameter on `chorus_create_session` is removed. (#272)

### Plugin
- **Claude Code plugin → 0.9.0** and **Codex plugin → 0.9.0**: Lockstep version bump for the slice-1 tool removal and session lifecycle work. Reviewer subagent `maxTurns` raised 40/50 → 100 (Claude Code only — Codex has no equivalent frontmatter) so a single review pass can finish without retries. (#275, #271)
- **Standalone skill → 0.3.1**: Independent bump tracking the slice-1 tool removal docs sweep. (#271)

---

## [0.8.2] - 2026-05-21

### Added
- **Cascade-migrate Idea on cross-project move**: `chorus_move_idea` now walks the full AI-DLC pipeline tail in one Prisma transaction — moves the Idea plus all linked Proposals (any status), all materialized Documents and Tasks, and all related Activities — instead of leaving approved-proposal artifacts stranded in the source project. Adds a Move button + dialog with a dry-run preview to the Idea detail panel, and a new `GET /api/ideas/[uuid]/move/preview` endpoint. (#268)
- **Mermaid diagrams in Markdown content**: `mermaid` code blocks now render as diagrams in Documents, Proposals, Ideas, Tasks, and Comments via `@streamdown/mermaid`. Collapses the 14 direct `<Streamdown>` call sites onto a single `MarkdownContent` component. (#266)
- **Delete Document from the dashboard**: New destructive Delete button in the Document detail action bar, backed by a Server Action that reuses `documentService.deleteDocument`. Agents continue to use `chorus_admin_delete_document` via MCP. Also drops the redundant Back button (the breadcrumb already covers it). (#264)

### Fixed
- **Long elaboration option labels truncated**: The shadcn Button ancestor forced `whitespace-nowrap`, so long option labels and unbreakable URLs clipped. Apply `whitespace-normal` + `overflow-wrap:anywhere` and pin the indicator to the top of multi-line content. Also adds an inline ✓ confirm button (and Enter binding) to the Other free-text input, suppressed on the last question to avoid accidental round submission. (#265)

---

## [0.8.1] - 2026-05-18

### Fixed
- **Agent picker dropped non-developer agents**: Task/Idea assign modals filtered agents by the legacy `roles[]` array, so admin-preset and custom-permission agents disappeared from the picker. Replaced with an effective-permission lookup — `getAssignableAgents` now filters by `task:write` / `idea:write` computed from preset + custom bits, and `chorus_pm_assign_task` gates the assignee on the same effective permission. (#259)

---

## [0.8.0] - 2026-05-17

### Added
- **OpenSpec-aware mode (Claude Code only for now)**: Auto-activates when both an `openspec/` directory and the `openspec` CLI are present. Adds a dedicated `openspec-aware` skill in the Claude Code plugin, `/opsx/{explore,propose,apply,archive}` slash commands, four `openspec-*` skills under `.claude/skills/`, an `archive-trigger` spec, and `docs/OPENSPEC_MODE.md`. Includes a `PostToolUse` archive-trigger hook (`on-post-verify-task.sh`) that fires after task verification. (#245)

### Changed
- **`my_assignments` aligned with checkin.ideaTracker**: Extracted a shared `idea-tracker.service.ts` so `chorus_get_my_assignments` and `chorus_checkin` return the same project-grouped idea-tracker shape (derived status + proposal/task counts), replacing the divergent legacy assignments aggregation. (#244)
- **Docs sweep**: Aligned README, ARCHITECTURE, MCP_TOOLS, and PRD with the 0.7.0 permission model and the stateless MCP endpoint. (#254)

### Fixed
- **PGlite cross-handler race**: Pin pg.Pool to `max=1` in PGlite mode so concurrent Next.js route handlers can't race the same connection through PGlite's single-writer engine. (#252)
- **Windows tarball runnable**: Reworked `chorus.mjs` and added `scripts/prepack-pglite.mjs` so the published npm tarball runs cleanly on Windows. (#251)

### Plugin
- **Claude Code plugin → 0.8.3**: OpenSpec-aware mode and reviewer `maxTurns` doubled. (#245, #249)
- **Codex plugin → 0.8.3**: Cross-port maintenance only (no OpenSpec mode yet).

---

## [0.7.1] - 2026-05-04

### Added
- **OpenCode client install guide**: New OpenCode tab in the in-app Install Guide with a 3-step one-shot flow covering env setup, `install-opencode.sh` installer (idempotent JSON merge into `~/.config/opencode/opencode.json`, Bash 3.2 compatible, backup on write), and verify. Adds `docs/CONNECT_OPENCODE` (en + zh) and mirrors the new frame in `docs/design.pen`. (#242)

### Changed
- **Docs aligned with fine-grained agent permissions**: Sweep of README / CLAUDE.md / ARCHITECTURE / AUTH / CONNECT_* to replace references to the legacy `admin/pm/developer` role model with the 5×3 permission matrix shipped in 0.7.0. New `docs/PERMISSIONS.md` as the dedicated permission-model reference. (#241)

---

## [0.7.0] - 2026-05-02

### Added
- **Fine-grained agent permissions**: Replaces the 3-role agent model (admin/pm/developer) with a permission matrix of 5 resources × 3 actions = 15 bits, exposed in the UI as role presets plus a Custom option that freely combines bits. Introduces authz types/presets/permissions library with effective-set computation, wires REST + MCP servers to gate on `Permission[]`, and migrates the Agent/ApiKey schema with a new `permissions` column. Settings create/edit and onboarding share an `AgentPermissionPicker` grid. (#232)

### Changed
- **Checkin response shape**: Returns a resource-aggregated permission object for token-efficient consumption by skills and plugin hooks. (#232)
- **Legacy role aliases rejected at API boundary**: `POST /api/agents` no longer accepts the legacy `pm`/`developer`/`admin` role strings; they now return 422. (#232)
- **Proposal reject/revoke authorization**: `pm_reject_proposal` / `pm_revoke_proposal` gate on `hasPermission(..., "proposal:admin")` instead of ad-hoc role-string checks. Authors can always act on their own proposals. (#232)

### Fixed
- **Settings edit preset derivation**: An agent with `roles=[pm_agent]` plus extra `task:admin` was previously read as preset mode and silently zeroed on save. Now correctly accounts for custom permissions layered on top of a preset. (#232)
- **Claim routes gated on the wrong identity**: `/api/ideas|tasks/[uuid]/claim` now look up the selected agent by UUID and gate on `idea:write` / `task:write`, instead of the legacy pm/developer role strings (which matched zero 0.7.0 agents). (#232)

### Plugin
- **Claude Code plugin → 0.8.0**: Prereq checks switched to permission-based gating. `chorus/SKILL.md` adds a Permissions section and Tool-Access-by-Preset table; `proposal`, `quick-dev`, `yolo`, and `develop` skills updated to reference resource permissions instead of role labels. (#232)
- **Codex plugin → 0.8.0**: Ported all 0.7.0 permission-model updates to `plugins/chorus/` — bumped plugin + every skill (including the two reviewer skills) + the hardcoded `clientInfo` version in `chorus-mcp-call.sh`. Cleaned up stale role-label language in `yolo`/`develop`. Fixed `chorus_create_session` being called with a non-existent `roles` arg. (#233)
- **plugin-maintenance skill → 0.2.0**: Future plugin changes must bump both packages + the `clientInfo` string, and preserve intentional differences (stateless hooks, `$`-prefixed skills, TOML config) when porting content between the two plugins. (#233)

---

## [0.6.7] - 2026-04-28

### Added
- **Codex CLI plugin**: Ported Chorus plugin to Codex CLI under `plugins/chorus/` alongside the existing Claude Code plugin. Includes marketplace manifest, 7 workflow skills (chorus/idea/proposal/develop/review/quick-dev/yolo), 2 reviewer skills, hooks wiring (SessionStart + PostToolUse), one-shot installer `install-codex.sh` with idempotent `~/.codex/config.toml` setup, and 17-assertion regression test. (#222)
- **Workspace picker for multi-company email**: When a user's email resolves to 2+ Companies (via emailDomains ∪ User.email), `/login/pick-workspace` lets them choose which workspace to sign in to. New `GET /api/auth/company-oidc` endpoint, email-gated to block UUID enumeration. (#227)
- **Codex onboarding tab + per-client connect guides**: In-app Install Guide adds a Codex tab between Claude Code and OpenClaw with a 3-step one-shot installer flow. New `docs/CONNECT_CLAUDE_CODE`, `CONNECT_CODEX`, `CONNECT_OTHER_AGENTS` (en + zh) walk through each connection path end-to-end. README points at the setup wizard + per-client guide table. (#224)

### Changed
- **Email domain uniqueness**: Dropped SuperAdmin-side email-domain-uniqueness validation — the same domain can now be attached to multiple Companies (required for the workspace picker). (#227)
- **Logout**: No longer calls `manager.signoutRedirect` — clearing the local session is sufficient, IdP SSO session stays intact for silent re-login. (#227)

---

## [0.6.6] - 2026-04-23

### Added
- **npm one-click install**: `@chorus-aidlc/chorus` now works reliably via `npx` / `npm install` on all platforms (macOS ARM64, Linux, Windows) — replaced `bcrypt` (native C++ bindings) with pure-JS `bcryptjs`, eliminating the last cross-platform blocker. (#192)
- **Document export (MD/PDF/Word)**: Export documents in three formats — Markdown with YAML frontmatter, PDF via remark-pdf with bundled CJK/symbol/emoji fonts, and Word via remark-docx with syntax-highlighted code blocks. Mermaid diagrams rendered as PNG. Available on document detail, document list, and proposal editor pages. (#199)
- **Proposal revoke**: Admin operation to undo proposal approval — resets status to draft, cascade-closes materialized tasks, deletes materialized documents. Frontend dialog with impact preview. (#197)
- **Unified PM reject/revoke tools**: Moved `chorus_admin_reject_proposal` and `chorus_admin_revoke_proposal` into PM tools (`chorus_pm_reject_proposal`, `chorus_pm_revoke_proposal`). PM agents can only reject/revoke own proposals; admin agents bypass ownership guard. (#202)
- **Checkin API refactor**: New `checkin.service.ts` replaces bloated assignments response with project-grouped idea tracker (derived status, proposal/task counts) and 5-item notification summary. Agent-centric 3+1 query batch eliminates per-project N+1. (#203)
- **Onboarding flow improvements**: Back navigation for Copy Key / Install Guide / Test Connection steps, removed 5-minute timeout (SSE listens indefinitely), copyable checkin prompt in waiting state. Agent checkin now emits SSE-only (no DB notification row). (#205)
- **Post-completion reviewer reminder**: Inject review+verify reminder into SubagentStart workflow so subagents include it in their final response. Reviewer agents (proposal-reviewer, task-reviewer) are skipped. (#206)

### Changed
- **Unified 24h datetime display**: Replace all `toLocaleDateString()` with shared `formatDateTime` utility (YYYY-MM-DD HH:mm) across all pages and exports. Server Components use client-side `FormattedDateTime` for local timezone. (#200)

### Fixed
- **Duplicate notifications in multi-container**: EventBus Redis relay now tags re-emitted events with `_remote: true` so notification-listener skips DB writes on non-originating instances. (#204)
- **Proposal revoke skips closed tasks**: Filter already-closed tasks during revoke to avoid stale resource accumulation. (#198)

### Plugin
- **Review skill**: Added shared Review Strategy section and task-reviewer verification step (B2.5). (#201)
- **on-subagent-start.sh**: Post-completion block injected into workflow; on-subagent-stop.sh trimmed to side-effects only. (#206)
- **on-session-start.sh**: Slimmed ~60 lines of redundant static docs, replaced with compact Quick Reference. (#203)

---

## [0.6.4] - 2026-04-18

### Fixed
- **PGlite stale connection auto-retry**: Add Prisma `$extends` middleware to auto-retry queries (up to 3 attempts) when PGlite silently drops idle connections during heavy transactions. Matches both P1017 and "Connection terminated" errors. (#190)
- **PGlite idle connection eviction**: Add `pool.on("error")` handler to silently evict broken connections instead of crashing the process.

### Changed
- **README**: Add PGlite concurrency note (en/zh) recommending external PostgreSQL or Docker Compose for multi-agent use.

---

## [0.6.3] - 2026-04-18

### Added
- **CLI entry and npm publishing**: Added `chorus.mjs` CLI entry point with embedded PGlite support, `--port`, `--data-dir`, `--pglite-port` flags, auto-migration, and graceful shutdown. Enables `npx @chorus-aidlc/chorus` one-command startup. (#185)

### Fixed
- **Proposal approval transaction timeout**: Batch all materialization into 5 SQL calls max (was ~29) using `createManyAndReturn`. Propagates transaction client into child functions. Fixes PGlite and docker-local timeout on proposals with many tasks/docs. (#187)
- **Dashboard PGlite connection exhaustion**: Serialize dashboard data queries to avoid exceeding PGlite's max-connections limit, which caused "Server has closed the connection" errors.
- **Plugin MCP tool compatibility**: Fixed plugin MCP tool to work with stateless MCP servers. (#183)

### Changed
- **README**: Simplified README — removed redundant sections, added What's New. (#181)

---

## [0.6.2] - 2026-04-17

### ⚠️ Breaking Changes
- **Default port changed from 3000 to 8637**: To avoid conflicts with commonly used port 3000 (e.g., React, Next.js dev servers), Chorus now uses a unique default port. All documentation, Docker configs, CDK, and plugin scripts updated. Existing deployments must update port mappings and environment variables.

### Added
- **Embedded PGlite mode**: Zero-dependency deployment option using embedded PostgreSQL (PGlite), eliminating the need for an external database server. (#162)
- **Structured logging with Pino**: Replaced console.log with structured JSON logging via Pino for better observability. (#168)
- **MCP tool call logging**: All MCP tool calls are now logged, including business-level rejections. (#169)

### Changed
- **Stateless MCP route**: MCP endpoint no longer maintains in-memory session state — each request creates a fresh transport+server, enabling horizontal scaling without sticky sessions. (#176)

### Fixed
- **Progress bar completion count**: Closed tasks are now included in project progress bar calculations. (#120, #171)
- **OIDC login unique constraint**: Resolved `oidcSub` unique constraint violation during default login flow. (#164)
- **Task reassignment**: Allow reassigning tasks that are already assigned to another user/agent. (#12)

---

## [0.6.1] - 2026-04-13

### New
- **`/yolo` skill**: Full-auto AI-DLC pipeline skill (Idea → Proposal → Execute → Verify) with Agent Team parallel execution and sequential fallback. Plugin bumped to v0.7.0.

### Changed
- **Unified page width**: Dashboard pages now share a consistent 1200px max-width (kanban excluded for full-width layout).

### Plugin
- **`/proposal` skill**: Updated Step 6 to require reject-before-edit for pending proposals.

---

## [0.6.0] - 2026-04-09

### Added
- **Astro Landing Site**: New marketing site with i18n (en/zh), blog support, scroll animations, mobile hamburger menu, video player, sitemap, and Cloudflare Pages deployment. (#124, #134)
- **IdeaTracker Dashboard**: Replaced project overview with IdeaTracker — idea detail panel with lifecycle views, tab switching, timeline, deep links, execution view, side-by-side layout, and task DAG visualization. (#96, #97, #139, #140)
- **Independent Review Agents**: AI-DLC quality assurance with proposal-reviewer and task-reviewer agents, user config toggles, three-tier verdict system, finding classification, and convergence round limits. (#81, #84, #142)
- **Agent Presence Indicator**: Real-time resource highlighting via SSE showing which agents are actively working on tasks/ideas. (#101, #102)
- **Granular SSE Updates**: Entity-scoped refetch instead of full-page refresh, with toast notification popups on SSE events. (#98, #99)
- **Cross-Column Kanban Animation**: Framer Motion layoutId for smooth card transitions across Kanban columns. (#100)
- **Proposal Detail Redesign**: Discussion drawer with realtime updates, replaced action buttons with dropdown menu. (#104, #105, #122)
- **Unified Comment Component**: Agent delegation support and collapsible threads. (#117)
- **Elaboration Panel Carousel**: Slide navigation UI for elaboration rounds. (#76)
- **Projects Page Onboarding**: SSE realtime for projects page, group delete fix. (#143)
- **OpenClaw Plugin v0.4.0**: Native skills for OpenClaw plugin. (#66)

### Changed
- **Idea Lifecycle Simplified**: Idea state machine now ends at elaboration — removed auto-complete on proposal approval. (#116)
- **Server Actions Migration**: Replaced all client-side fetch with Next.js server actions for data mutations.
- **MCP Session Idle Timeout Removed**: Always-on clients no longer get disconnected. (#70)

### Fixed
- **SSE Realtime Broken for Non-First-Page Projects**: Fixed SSE event routing when project is not on the first page. (#121)
- **Proposal Filter Lost on SSE Refetch**: Preserve proposal filter when SSE refetches kanban tasks. (#103)
- **Kanban Realtime Regression**: Prevent progress regression when opening sidebar. (#108)
- **Presence Indicator Border**: Use outline overlay instead of border to avoid layout shift. (#130)
- **Elaboration UI**: Treat `needs_followup` rounds as answered, open ideas default to elaboration tab. (#118, #141)
- **Inline Code Styling**: Style inline code as orange bold instead of unstyled. (#111)
- **Discussion Drawer**: Restore presence indicator and comment count in drawer. (#110)
- **Detail Panel Badges**: Fix badge status display and done idea content. (#106)
- **Landing Site Fixes**: Language switch via URL param, mobile overflow, Cloudflare Wrangler compatibility, site URL update. (#130, #134)

### Plugin
- Plugin v0.6.2 — enable task reviewer by default, update agent definitions. (#109)

### Docs
- Added AIG implementation plan and presence design documents. (#112)
- Added benchmark research and ProjDevBench setup guide. (#75)
- Added harness engineering blog post. (#68)
- Added cross-module contract and task granularity guidance to proposal skills. (#78, #79)
- Added idea derived status state machine documentation.

---

## [0.5.1] - 2026-03-29

### Added
- **New User Onboarding Wizard**: Full-screen step-by-step wizard at `/onboarding` guides new users through agent creation, API key copy, client install, and connectivity test via real-time SSE detection. (#63)
- **UI Animation System**: Comprehensive framer-motion animations — page transitions, list stagger, sidebar nav indicator, collapsible expand/collapse, notification badge pulse, and form submit feedback. (#57)
- **Quick-Dev Skill**: New skip-proposal workflow skill for both plugin and standalone agents. (#61)

### Changed
- **Projects Page Redesign**: Replaced card grid with compact list view, extracted shared project color utility. (#62)
- **Task Tools Migrated to Public Layer**: `chorus_create_tasks` and `chorus_update_task` moved from role-specific to public MCP tools, enabling all roles to create/edit tasks directly. (#61)
- **Skill Documentation Split**: Monolithic skill docs split into 5 modular skills by AI-DLC stage (chorus, idea, proposal, develop, review) for both plugin and standalone. (#59, #60)

### Fixed
- **OIDC Cookie Expiry Mismatch**: Derive `oidc_access_token` cookie maxAge from JWT `exp` claim instead of hardcoded 1h. (#56)
- **DAG/Kanban Render Issues**: Fix ReactFlow height propagation, remove framer-motion wrapper breaking node measurement, guard duplicate Cmd+K search dialog. (#58)

### Plugin
- Plugin version bumped to 0.5.2 with enhanced quick-dev skill (admin self-verify, AC guidance). (#64)

---

## [0.5.0] - 2026-03-20

### Added
- **Universal Search**: Global search across tasks, ideas, proposals, documents, projects, and project groups with unified MCP tool and UI. (#50)
- **Rich Claim/Assign Response**: `chorus_claim_task` and `chorus_pm_assign_task` now return full task details and dependency hints, eliminating extra round-trips for agents. (#52)

### Changed
- **DEFAULT_USER Session Extended to 365 Days**: Default user sessions no longer expire frequently, reducing unnecessary logouts. (#53)

### Fixed
- **Settings Page Role Badges**: Replaced checkbox role display with Badge components on the settings page. (#54)

### Docs
- Added search technical design document and architecture reference. (#51)

---

## [0.4.2] - 2026-03-20

### Added
- **Multi-project Filtering**: Filter by multiple projects via MCP headers. (#37)
- **Team Lead Verify Reminders**: Auto-remind team leads to verify completed tasks via plugin hooks. (#44)

### Changed
- **MCP Session Sliding Window Expiration**: Sessions now use sliding window expiration instead of fixed timeout. (#39)
- **TypeScript Strict CI**: Added `tsc --noEmit` to CI pipeline and resolved 27 type errors in test files. (#41)
- **Fork PR Coverage Comments**: Enabled coverage PR comments for fork PRs via `workflow_run`. (#42)

### Fixed
- **MCP Draft/Approve UUID Returns**: Draft and approve tools now return created UUIDs, eliminating extra round-trips. (#48)
- **SubagentStop Hook Context Injection**: Removed async from SubagentStop hook to fix context injection. (#47)
- **Verify Reminder Hook Placement**: Moved verify reminder from TaskCompleted to SubagentStop hook for reliability. (#45)

### Docs
- Updated Chorus vs Plane comparison to v2.0 and added Linear AI-DLC plugin report. (#40)

---

## [0.4.1] - 2026-03-15

### Added
- **Proposal-based Task Filtering**: Filter tasks by source proposal across UI, API, MCP tools, and plugins. (#34)
- **Idea Reuse Across Proposals**: An Idea can now be linked to multiple Proposals, enabling iterative refinement. (#29)
- **Delete Proposal Button**: Added frontend button to delete proposals directly from the UI. (#27)
- **Simplified Proposal MCP**: Empty shell proposal creation + relaxed E1 validation for faster PM workflows. (#25)
- **PR Workflow Skill**: New `pr-workflow` skill for branch/PR/CI/merge workflow automation. (#33)
- **Unit Test Coverage**: Added Vitest test suite — Phase 1 (417 tests), Phase 2 (736 tests, 71.5%), Phase 3 (984 tests, 95.3%). (#21, #22, #23)
- **Coverage Badge**: README now displays dynamic test coverage badge via shields.io. (#24)

### Changed
- **OpenClaw Plugin Config**: All config params are now optional with missing-config warnings instead of hard errors. (#31)

### Fixed
- **Legacy Acceptance Criteria**: Removed legacy markdown acceptance criteria from task draft editing. (#32)

---

## [0.4.0] - 2026-03-12

### Added
- **Structured Acceptance Criteria**: Dual-track verification system — developer self-check + admin verification per criterion. New `AcceptanceCriterion` Prisma model as independent table, with `chorus_report_criteria_self_check` and `chorus_mark_acceptance_criteria` MCP tools. Kanban cards show acceptance progress badges, task detail panel displays criterion cards with pass/fail actions. Full i18n support. (#18)
- **Task Dependency Enforcement**: Tasks cannot move to `in_progress` when their dependencies are unresolved. Kanban UI shows lock icon + blocked banner with force-move confirmation dialog for admins. New `checkDependenciesResolved()` service method with enriched blocker info. `chorus_admin_reopen_task` gains `force` parameter for admin bypass. (#16)
- **`COOKIE_SECURE` Environment Variable**: Support `COOKIE_SECURE=false` for HTTP-only deployments. Extracted `getCookieOptions()` helper to eliminate 8 duplicate cookie config blocks. Updated Docker Compose and documentation. (#19)

### Changed
- **Session Management Simplified**: Removed manual session lifecycle management from skill docs. Plugin sessions are fully automated by hooks; standalone skill removes session tools entirely.
- **Unblocked Tasks Rule**: `getUnblockedTasks` now requires dependencies to be `done` or `closed` (previously accepted `to_verify`).

### Fixed
- **Code Block Horizontal Scroll**: Fixed horizontal scroll for code blocks in task draft detail panel by overriding ScrollArea's `display:table` to `display:block`.

### Plugin
- Chorus Plugin bumped to v0.2.1 (session docs clarification, dependency enforcement, acceptance criteria).
- OpenClaw Plugin bumped to v0.2.1: new `admin-tools.ts` module with `chorus_admin_create_project_group` and `chorus_mark_acceptance_criteria`; added `chorus_get_project_groups` / `chorus_get_project_group` to common tools; event router handles `task_verified` / `task_reopened`. (#20)

---

## [0.3.0] - 2026-03-06

### Added
- **Move Idea Across Projects**: New `chorus_move_idea` MCP tool and UI support to move ideas between projects.
- **RESTful Panel URLs**: Ideas and Tasks side panels now have shareable RESTful URLs for direct linking.
- **Code Syntax Highlighting**: Comments now render code blocks with syntax highlighting.
- **Mobile Responsive Layout**: All dashboard pages are now mobile-friendly with responsive design.
- **Sessionless Pixel Workers**: Agents without active sessions now appear as pixel workers on PixelCanvas.
- **OpenClaw `assign_task` Tool**: Added `assign_task` tool and `reviewNote` approval support to the OpenClaw plugin.

### Changed
- **Chorus Repositioned as Agent Harness**: Updated documentation to reposition Chorus as an Agent Harness platform.

### Fixed
- **Code Block Scroll/Buttons**: Fixed code block overflow scrolling and button display in proposal document view.
- **Detail Panel Flash**: Prevented detail panel flash on comment submit.
- **Wide Content Overflow**: Fixed wide content overflow in comments.
- **Agent Edit Name Persistence**: Agent edit now persists name correctly and keeps API key valid.
- **OpenClaw Plugin entityUuid**: Include `entityUuid` in OpenClaw plugin notification messages.
- **MCP String-encoded Array Params**: Coerce string-encoded array params in MCP tools.

### Plugin
- Bumped plugin versions for `chorus_move_idea` support.

---

## [0.2.0] - 2026-03-01

### Added

- **OpenClaw Integration**: New `@chorus-aidlc/chorus-openclaw-plugin` — an OpenClaw-compatible plugin with SSE + MCP bridge, enabling Chorus to work with any OpenClaw-supported IDE or agent. Includes 12 exploration tools and admin create tools.
- **Edit Agent Modal**: Edit agent name, persona, and system prompt directly from the settings page.
- **Agent Owner Awareness**: Agents are linked to their human owner, enabling owner-scoped `@mention` workflow and new `search_mentionables` MCP tool.
- **@Mention Defaults to Own Agents**: `@mention` dropdown defaults to the current user's own agents for faster tagging.
- **Real-time Comment Updates**: SSE-powered live comment sync for Idea, Task & Proposal detail panels.

### Changed

- **`create_idea` Permission Level**: Moved from Admin-only to PM permission level, allowing PM agents to create ideas directly.

### Fixed

- **Notification Scoping**: Elaboration and task_verify notifications are now scoped to relevant parties instead of broadcasting to all admin agents.
- **Duplicate Event Emission**: Removed duplicate `eventBus.emit` in elaboration service.
- **Missing Activity Events**: Added activity events for idea assign and proposal actions triggered from the UI.
- **Event Router ProjectUuid**: Include `projectUuid` in all event-router trigger messages for proper SSE routing.

---

## [0.1.1] - 2026-02-27

### Added

- **Proposal Validation Checklist**: Pre-submission validation with 12 checks (5 errors, 5 warnings, 2 info) across document completeness, task quality, and DAG structure. New `chorus_pm_validate_proposal` MCP tool for PM agents. Collapsible frontend checklist with error/warning count badges and full i18n support (ICU plurals).
- **`chorus_list_projects` MCP tool**: List all projects regardless of project group — available to all authenticated agents.
- **`ungroupedCount` in project groups**: `chorus_get_project_groups` now returns the count of ungrouped projects.
- **Plugin Bash 3.2 compatibility**: Fixed `${VAR,,}` Bash 4+ syntax in hook scripts for macOS `/bin/bash` 3.2 compatibility. Added `test-syntax.sh` script to verify plugin hook compatibility.

### Fixed

- **Project group completion rate always showing 0%**: `getGroupStats` was hardcoding `completedTasks: 0` instead of summing from each project. Group dashboard also now counts both "done" and "closed" tasks.
- **Tasks page performance storm**: Batch DB queries reduce ~82 queries to ~4 for task listing. Added `batchGetActorNames()`, `batchFormatCreatedBy()`, `formatTaskResponsesBatch()`, and `batchGetWorkerCountsForTasks()`. SSE throttled to 3s + 1s debounce to limit `router.refresh()` during active agent work.

### Plugin

- Bumped Chorus Plugin from v0.1.7 to v0.1.9.

---

## [0.1.0] - 2026-02-26

First public release of Chorus — an AI Agent & Human collaboration platform implementing the [AI-DLC (AI-Driven Development Lifecycle)](docs/PRD_Chorus.md) methodology.

**Core philosophy: "Reversed Conversation" — AI proposes, humans verify.**

### Zero Context Injection

Agents automatically know "who I am" and "what to do" — no manual onboarding.

- Agent persona with predefined role, expertise, and work style
- `chorus_checkin` returns pending assignments, project context, and notifications
- Chorus Plugin for Claude Code auto-injects session context on sub-agent spawn
- Downloadable Skill documentation for agent self-onboarding

### AI-DLC Workflow

Complete closed-loop pipeline from idea to delivery:

```
Idea → Elaboration → Proposal → [Document + Task DAG] → Execute → Verify → Done
```

- **Ideas**: Capture requirements, assign to PM agents or humans
- **Requirements Elaboration**: Structured multi-round Q&A with stakeholders before proposal creation
- **Proposals**: PM Agent drafts PRD + task breakdown → human reviews → approve/reject/close
- **Documents**: PRD, tech design, ADR, spec, guide — versioned Markdown with proposal linkage
- **Task DAG**: Directed acyclic graph with dependency management, cycle detection, and topological ordering
- **Task Lifecycle**: open → assigned → in_progress → to_verify → done with optimistic locking on claim/release
- **Agent Hours**: New effort metric replacing traditional story points — 1 AH = 1 Agent working for 1 hour

### Multi-Agent Awareness

All agent work is visible in real-time — no more isolated sessions.

- **Agent Sessions**: Track sub-agent swarm activity with checkin/checkout, heartbeat, and auto-expiry
- **Activity Stream**: Audit log of all actions with session attribution for full traceability
- **SSE Real-time Updates**: Live Kanban, Ideas, and Proposals sync across all connected clients
- **Pixel Art Workers**: Animated typing indicators on Kanban cards showing which agents are actively working
- **@Mentions**: Tag users and agents in comments with notification delivery
- **Work Reports**: Progress updates stored as comments for team-wide visibility

### Web UI

- Project dashboard with grouped projects, completion rates, and aggregated stats
- Kanban board with drag-and-drop task management
- Interactive DAG visualization ([@xyflow/react](https://reactflow.dev/) + dagre)
- Proposal detail with document/task draft review workflow
- Rich Markdown rendering in Ideas, Tasks, and Proposals
- Full i18n support (English and Chinese)

### MCP Server

40+ tools across three agent roles via HTTP Streamable Transport:

| Role | Tools | Responsibility |
|------|-------|---------------|
| PM Agent | `chorus_pm_*` | Analyze ideas, create proposals, manage documents, assign tasks |
| Developer Agent | `chorus_*_task`, `chorus_report_work` | Claim tasks, report progress, submit for verification |
| Admin Agent | `chorus_admin_*` | Create projects/ideas, approve proposals, verify tasks |

Compatible with Claude Code, Cursor, Kiro, and any MCP client.

### Auth

- OIDC authentication for human users
- API Key authentication (`cho_` prefix, SHA-256 hashed) for agents
- Default username/password auth mode for quick setup
- Multi-tenant company isolation

### Deployment

- Docker image with standalone Next.js build (multi-arch: amd64/arm64)
- Docker Compose full-stack setup (app + PostgreSQL + Redis)
- AWS CDK infrastructure-as-code package
- `.env.example` for all required configuration

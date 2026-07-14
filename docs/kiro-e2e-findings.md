# Kiro CLI plugin — live e2e verification findings

Verification evidence for the Chorus Kiro CLI plugin (idea `97ccd334`, proposal `add-kiro-cli-plugin`). This documents an actual end-to-end run of the AI-DLC surface through a real, logged-in `kiro-cli` — not a file-level check. It exists because an earlier pass wrongly deferred live Kiro interaction as a "human step"; doing it live both proved the loop works and caught a shipped BLOCKER (see below).

## Environment

- **`kiro-cli --version`**: `kiro-cli 2.12.1`
- **Auth**: logged in via IAM Identity Center (`yfeichen@amazon.com`) — `kiro-cli whoami` confirms. So `kiro-cli chat --no-interactive --agent <name> --trust-all-tools "<prompt>"` runs headlessly with a live model.
- **Chorus**: production instance from `~/.chorus/daemon.json` (`CHORUS_URL` + `CHORUS_API_KEY` exported). The `initialize` handshake to `$CHORUS_URL/api/mcp` returns `serverInfo:{name:"chorus",version:"1.0.0"}` + `capabilities.tools.listChanged:true`.
- **Install used**: `bash public/install-kiro.sh --workspace` into a throwaway dir (does not touch the user's `~/.kiro`).

## `kiro-cli mcp list workspace`

After the `--workspace` install, all four agents show the `chorus` MCP server wired in (the `[legacy]` tag is Kiro's config-source label — it also appears on the user's own global `pencil` server, so it is not a defect):

```
📄 workspace:
  chorus                      • chorus [legacy]  • pencil [legacy]
  chorus-code-reviewer        • chorus [legacy]  • pencil [legacy]
  chorus-proposal-reviewer    • chorus [legacy]  • pencil [legacy]
  chorus-task-reviewer        • chorus [legacy]  • pencil [legacy]
```

## Turns run (each `kiro-cli chat --no-interactive --agent chorus --trust-all-tools`)

| # | Prompt intent | MCP tool(s) exercised live | Result |
|---|---|---|---|
| 1 | Checkin (identity + tracker) | `chorus_checkin` | ✅ "Admin Claude" / `yfeichen@amazon.com` / 10 ideas across 8 projects |
| 2 | Discovery — list a project's ideas | `chorus_get_ideas` | ✅ returned the 8 ideas of `chorus 0.14.1` with correct statuses |
| 3 | Read a specific idea + its elaboration | `chorus_get_idea`, `chorus_get_elaboration` (chained in one turn) | ✅ correctly summarized 2 rounds / 9 questions / the packaging decision |
| 4 | Skill activation — load `chorus-idea` | (Kiro `read` of `.kiro/skills/chorus-idea/SKILL.md`) | ✅ activated the skill and quoted the ported 3-state lifecycle (`open → elaborating → elaborated`) verbatim |
| 5 | **Reviewer subagent** reaches `@chorus` | `chorus_get_task` **as `--agent chorus-task-reviewer`** | ✅ "Chorus MCP reachable" — returned this task's title + status |

## Hook firing

The `chorus` main agent's `agentSpawn` and `stop` hooks fire on every turn — the CLI prints `✓ 1 of 1 hooks finished` at turn start and end. The `agentSpawn` hook runs `chorus_checkin` and injects the result into the agent's startup context (Kiro adds hook STDOUT as plain text). No hook aborted a turn.

## The BLOCKER this live run caught (now fixed)

The three reviewer agents originally shipped with `tools: ["read","@chorus"]` but **no `includeMcpJson`** and no `mcpServers` block. In a real Kiro session `kiro-cli mcp list workspace` showed their server as `(empty)` — `@chorus` was a dangling reference, so a reviewer subagent could not call any Chorus tool or post its VERDICT. File-level review missed it because it only checked the `tools` array existed, never ran Kiro to see whether the server actually loaded. Fix: added `includeMcpJson: true` to `chorus-code-reviewer.json` / `chorus-proposal-reviewer.json` / `chorus-task-reviewer.json` (matching the main agent). **Turn 5 above is the live proof the fix works** — the reviewer subagent reached `@chorus` at runtime.

## Chorus pollution

None. Every turn used read/discovery tools only (`chorus_checkin`, `chorus_get_ideas`, `chorus_get_idea`, `chorus_get_elaboration`, `chorus_get_task`). No idea/proposal/task was created or mutated in production Chorus as a side effect of this e2e. Throwaway workspace dirs under `/tmp` were used for the install and cleaned up.

## Gaps / limitations (honest)

- **Full write-path AI-DLC round not driven end-to-end here.** The turns exercise the read/discovery/skill-activation surface and prove MCP connectivity for both the main agent and a reviewer subagent. Driving a *mutating* full loop (create idea → elaborate → propose → execute → verify) through Kiro would create real entities in the connected Chorus; that was deliberately not done against production. To exercise the write path safely, point `CHORUS_URL` at a local/test Chorus (e.g. `localhost:8637`, which was not running during this session) and repeat turns 1–5 plus create/claim/submit turns.
- **Interactive TTY affordances untested.** `--no-interactive` covers the headless path (which is what the daemon backend child `dc53a459` will use). The interactive `/chorus-idea` slash-command UX and any TUI-only behavior are not covered by these headless turns — those remain a genuine manual human check in a real terminal.
- **`[legacy]` tag** is unexplained by us beyond "config-source label"; harmless (server connects and tools load), but if Kiro later distinguishes legacy vs native config semantics it is worth revisiting.

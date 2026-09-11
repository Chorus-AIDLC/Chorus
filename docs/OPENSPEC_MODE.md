# OpenSpec Mode

OpenSpec mode is an **opt-in** authoring style for Chorus PM agents. The proposal-authoring flow switches from free-form Markdown to a structured `proposal.md` + `design.md` + `specs/<capability>/spec.md` layout that lives on disk and is mirrored into Chorus `documentDrafts` — preferring the `chorus` CLI (`chorus mcp call … --arg-file content=<file>`), with the plugin's bash MCP wrapper script as a fallback when `chorus` is not on `PATH`. The local files are the working copy; the Chorus drafts are a mirror that reviewers can read on the proposal page.

> **Spec mode: OpenSpec stays the default when usable; [spec-lite](./SPEC_LITE.md) is the lightweight fallback (Claude Code plugin).** `CHORUS_SPEC_MODE` resolves to `{lite, openspec, off}`. An explicit value wins; when **unset**, the mode is **OpenSpec whenever it is usable** (`openspec/` dir + CLI on PATH, not disabled) and falls back to **lite** (a Chorus-native lightweight folder format) only when OpenSpec is absent or disabled. So a repo that has run `openspec init` keeps using OpenSpec by default — no env var needed. `CHORUS_SPEC_MODE=lite` forces lite even where OpenSpec is usable; `CHORUS_SPEC_MODE=openspec` with OpenSpec **not** usable fails fast (install hint / config-conflict) rather than falling back; `=off` is free-form. The Claude Code SessionStart hook computes this once (`bin/resolve-spec-mode.sh`) and writes a `## Spec Mode` section stating the resolved mode; when the mode is a usable OpenSpec it additionally carries the `CHORUS_OPENSPEC_ACTIVE=1` line the stage skills branch on. (The **Codex** plugin still uses the prior OpenSpec-only detection until spec-lite propagates there — a follow-up.)

This document is a user-facing summary. The authoritative behavior lives in the hand-maintained `openspec-aware` skill files. All prefer `chorus mcp call --arg-file` and keep the surface's bash wrapper as a CLI-absent fallback:

- **Claude Code plugin:** [`public/chorus-plugin/skills/openspec-aware/SKILL.md`](../public/chorus-plugin/skills/openspec-aware/SKILL.md) — fallback wrapper `chorus-api.sh mcp-tool`.
- **Codex plugin:** [`plugins/chorus/skills/openspec-aware/SKILL.md`](../plugins/chorus/skills/openspec-aware/SKILL.md) — fallback wrapper `chorus-mcp-call.sh` (different invocation shape; no `mcp-tool` subcommand).

The two skills carry the same core logic, but each is hand-edited to match its plugin's wrapper path, conventions, and host runtime. **There is no shared canonical file and no sync script.** When this guide diverges from a SKILL.md, the SKILL.md wins.

OpenSpec mode is **not** available for the standalone `public/skill/` distribution — that channel ships no plugin wrappers, so the wrapper-driven mirror flow has no implementation there.

---

## What it does

OpenSpec mode gives every spec draft on a Proposal a predictable shape: top-level delta blocks (`## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`, `## RENAMED Requirements`) containing `### Requirement:` entries with `SHALL` / `MUST` wording, and `#### Scenario:` blocks written in `**WHEN** ... **THEN** ...` form. Reviewers (human and agent) can lean on that structure instead of reading every PRD as a free-form essay. When OpenSpec is **not** installed, behavior is unchanged: drafts are free-form Markdown.

The mode is purely client-side. **Chorus ships no new MCP tools, no schema changes, and no server-side OpenSpec awareness for this.** The skill authors local files with `openspec`, then calls the same `chorus_pm_create_proposal` / `chorus_pm_add_document_draft` / `chorus_pm_update_document_draft` / `chorus_pm_update_document` tools that already existed — but for document mirror calls it fills `content` from the file's raw bytes instead of re-emitting it through the LLM: preferring `chorus mcp call … --arg-file content=<file>`, or (when `chorus` is not on `PATH`) the plugin's bash wrapper (`chorus-api.sh` for Claude Code, `chorus-mcp-call.sh` for Codex) with `json_encode_file` streaming through `jq -Rs '.'` byte-for-byte.

---

## When it activates (detection contract)

Mode resolution runs **once per session**, in the plugin's SessionStart hook. In the **Claude Code** plugin the pure helper `bin/resolve-spec-mode.sh` (sourced by `bin/on-session-start.sh`) resolves `CHORUS_SPEC_MODE` and writes a `## Spec Mode` section into the additional-context block; when the resolved mode is a usable OpenSpec, that section also carries a `CHORUS_OPENSPEC_ACTIVE=1` line. (The **Codex** plugin's `hooks/on-session-start.sh` still writes the older OpenSpec-only `## OpenSpec Mode` / `CHORUS_OPENSPEC_ACTIVE` detection until spec-lite propagates there.) Stage skills (proposal, develop, yolo) read the resolved mode when they need to branch — they do not re-detect.

The resolved mode is a **usable OpenSpec** (and the hook emits `CHORUS_OPENSPEC_ACTIVE=1`) when `CHORUS_SPEC_MODE` is `openspec` **or unset**, **and all three** of:

1. `CHORUS_OPENSPEC_MODE` is **not** set to `off`, and the `enableOpenSpec` toggle is on (explicit opt-out wins).
2. The project root contains an `openspec/` directory — i.e. someone has run `openspec init` here. This is the "this repo intends to use OpenSpec" signal.
3. The `openspec` CLI is on `PATH`. The OpenSpec authoring path needs the CLI to scaffold (`openspec new change`), validate, and archive — the folder alone is not enough.

When `CHORUS_SPEC_MODE` is unset and any of those fails, the mode falls back to **lite** (not an error). When `CHORUS_SPEC_MODE=openspec` is explicit and any fails, the hook marks OpenSpec **not usable** and the stage skill fails fast (below).

If `CHORUS_SPEC_MODE=openspec` but one of these fails, the hook writes a `## Spec Mode` section marking OpenSpec as **not usable** with a one-line reason, and the stage skill **fails fast** — surfacing the install hint (no `openspec/` dir or CLI) or a config-conflict message (`CHORUS_OPENSPEC_MODE=off` / toggle off), never silently falling back. The user-visible toast then reads:

```
Chorus connected at <URL> (Spec: openspec — not usable)
```

When the mode resolves to a usable OpenSpec, the user-visible toast reads:

```
Chorus connected at <URL> (Spec: openspec)
```

(For the default and disabled cases the toast reads `(Spec: lite)` or `(Spec: off)`.)

### Why folder + CLI both, not just one

Either signal alone leaves the workflow unrunnable:

- Folder without CLI: `openspec new change "$SLUG"` errors immediately — there's nothing to scaffold with. Activating OpenSpec mode in this state would point the agent at a dead end.
- CLI without folder: `openspec new change` complains it's not in a project ("Run `openspec init` first"). The repo isn't OpenSpec-init'd, so this likely isn't where OpenSpec is wanted.

Requiring both makes the activation predicate match what's actually needed at runtime.

### Sub-agents and sub-shells

Detection runs in the plugin's session-start hook, which fires once per top-level session. Sub-agents that get the parent's context forwarded inherit `CHORUS_OPENSPEC_ACTIVE` for free. If you spawn a sub-agent without forwarding context, the `openspec-aware` skill §1 has a manual fallback that **sources the same `${CLAUDE_PLUGIN_ROOT}/bin/resolve-spec-mode.sh`** the hook uses (not a re-implemented check) — use only when SessionStart context is genuinely unavailable.

---

## Install + initialize

OpenSpec is a Node CLI from Fission AI. Install it globally:

```bash
npm install -g @fission-ai/openspec
openspec --version    # Chorus 0.8.0 was tested against 1.3.1
```

Then, inside the repository where the agent will author proposals:

```bash
openspec init
```

`openspec init` creates the `openspec/` working directory (`changes/`, `specs/`, `config.yaml`, instruction files). Without it, the `openspec new change <slug>` step in the skill's §3.2 will fail.

---

## Opt-out

Two switches, in precedence order:

**1. `enableOpenSpec` userConfig toggle** (Claude Code plugin only, default `true`). Configurable from the plugin install UI like the reviewer toggles. When set to `false`, SessionStart detection short-circuits with reason `enableOpenSpec userConfig=false (plugin-level opt-out)`, and the post-verify archive hook also exits 0 immediately. Equivalent to "OpenSpec is uninstalled" from the agent's perspective.

**2. `CHORUS_OPENSPEC_MODE=off` env var** (both plugins). Per-shell / CI-friendly opt-out:

```bash
export CHORUS_OPENSPEC_MODE=off
```

This forces *not*-openspec even when both the `openspec/` directory and the `openspec` CLI are present (the legacy opt-out is still honored). With OpenSpec disabled this way, an **unset** `CHORUS_SPEC_MODE` then resolves to **lite** (OpenSpec is no longer usable, so the fallback applies). The SessionStart hook checks the userConfig toggle first, then this env var, before the folder/CLI signals. If `CHORUS_SPEC_MODE=openspec` is set at the same time, that's a **config conflict** and the stage skill fails fast; if `CHORUS_SPEC_MODE=off`, the mode is free-form.

After resolution, no `openspec/` folder is created or referenced (existing folders on disk are untouched), and the proposal description gets no `OpenSpec change slug:` line.

The Codex plugin has no userConfig surface, so only the env var applies there.

---

## What gets mirrored to Chorus

| OpenSpec local file | Chorus `Document.type` | Mirrored? |
|---|---|---|
| `openspec/changes/<slug>/proposal.md` | `prd` | yes |
| `openspec/changes/<slug>/design.md` | `tech_design` | yes |
| `openspec/changes/<slug>/specs/<capability>/spec.md` | `spec` | yes (one draft per capability) |
| `openspec/changes/<slug>/tasks.md` | _(not mapped)_ | **no** |

All three mapped types (`prd`, `tech_design`, `spec`) are pre-existing valid `Document.type` values — no schema change required.

The proposal description must contain a single line in the exact format `OpenSpec change slug: <slug>` so the post-verify-task hook (and future runs of the skill) can recover the slug from a fresh shell.

---

## How mirror calls are made (Rule 1)

This is the rule most likely to bite you, so it gets its own section.

When `CHORUS_OPENSPEC_ACTIVE=1`, **every** call to `chorus_pm_add_document_draft`, `chorus_pm_update_document_draft`, or `chorus_pm_update_document` MUST fill `content` from the local file's bytes, never from a hand-typed body. Two transports, preferred first:

- **Primary — the `chorus` CLI:** `chorus mcp call <tool_name> '<json-without-content>' --arg-file content=<file>`. `--arg-file` reads the file's raw bytes as the JSON `content` string, byte-exact — the CLI's built-in replacement for `json_encode_file`.
- **Fallback — the plugin's bash wrapper (when `chorus` is not on `PATH`):** build `$PAYLOAD` with `json_encode_file` (defined in the skill's §3.6 fallback block) and call it:
  - Claude Code: `chorus-api.sh mcp-tool <tool_name> "$PAYLOAD"` (on `PATH`)
  - Codex: `"$CHORUS_PLUGIN_DIR/hooks/chorus-mcp-call.sh" <tool_name> "$PAYLOAD"`

Calling these tools directly from the agent's MCP harness with a hand-typed `content` field is a **protocol violation** in OpenSpec mode and will fail review. Three reasons (full version in skill §2 Rule 1):

1. **Token cost.** Re-typing thousands of lines of markdown body through the LLM burns 20k+ content tokens per proposal. Both `--arg-file` and the fallback's `json_encode_file` stream the file's bytes; content never enters LLM context.
2. **Byte-equality.** A file-fill path (CLI `--arg-file`, or the fallback's `jq -Rs '.'`) is a byte-faithful encoder. LLM re-emission of long markdown drifts (table alignment, fence escapes, long-URL wraps). The exact byte-equality guarantee holds **only** on a file-fill path.
3. **Single source of truth.** With a file-fill mirror, the local `openspec/changes/<slug>/*.md` is authoritative; Chorus is a mirror. With agent re-typing, authority splits and a future diff cannot tell which side is correct.

The `chorus_check_response` halt-on-error discipline applies to **both** OpenSpec transports. When `CHORUS_OPENSPEC_ACTIVE=0`, Rule 1 (this OpenSpec mirror rule) doesn't apply — but note `=0` now covers **two** resolved modes, and only one of them is free-form: `SPEC_MODE=off` is free-form (no spec artifact; author drafts with inline `content` via direct MCP), whereas `SPEC_MODE=lite` (spec-lite) still mirrors its per-change dated-folder docs `.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/<type>.md` **byte-exact via `--arg-file`** (the durable `.chorus/specs/<slug>/spec.md` is never mirrored) and must NOT re-type document `content` inline. Don't infer "inline content is fine" from `CHORUS_OPENSPEC_ACTIVE=0` alone — check the resolved `SPEC_MODE`.

---

## FAQ

### What happens if I edit the local file but not Chorus?

The local file under `openspec/changes/<slug>/` is the working copy. The Chorus draft is a mirror written by the wrapper-driven `chorus_pm_add_document_draft` / `chorus_pm_update_document_draft` calls. If you edit the local file out-of-band, the mirror drifts.

To resync, re-run the relevant mirror snippet from `openspec-aware` §3.7 — prefer `chorus mcp call … --arg-file content=<file>`, with the bash wrapper + `json_encode_file` as the CLI-absent fallback, and `chorus_check_response` halting on error on either path.

Round-trip verification is exact. A trailing newline difference is content drift and must not be normalized or ignored.

After approval the draft becomes a Document with a fresh `documentUuid`. Use `chorus_pm_update_document` (skill §3.8) instead of `chorus_pm_update_document_draft`.

### What about `openspec archive`?

After the **last** task of an OpenSpec-mode idea is verified via `chorus_admin_verify_task`, both the Claude Code and Codex plugins' PostToolUse hook automatically inject a reminder telling the main agent to run `openspec archive <slug>` and mirror the resulting `openspec/specs/<capability>/spec.md` files back to the corresponding Chorus Documents via `chorus_pm_update_document` (still a file-fill mirror: `chorus mcp call … --arg-file content=<file>`, or the bash wrapper fallback).

The hook fires only when:

- the proposal description carries an `OpenSpec change slug: <slug>` line, AND
- the `openspec` CLI is on `PATH`, AND
- every task under the proposal is `done`.

Otherwise it exits 0 silently. See `openspec-aware` §3.9 for the full agent action sequence (run with `-y` / `--yes`, halt on error, byte-equal round-trip check).

### Why isn't `tasks.md` mirrored?

OpenSpec's `tasks.md` is the OpenSpec-side task list. Chorus already has its own task model — task drafts on the Proposal, materialized into Tasks with acceptance criteria, dependencies, assignees, and status — and that is the source of truth for task tracking. Mirroring `tasks.md` would duplicate state and create a second place to keep in sync. The skill explicitly skips it.

If you want Chorus tasks to reflect a `tasks.md`, write the Chorus task drafts directly via `chorus_pm_add_task_draft` (no wrapper required — task drafts are not document content).

---

## Known limitations (0.8.0)

- **`chorus-api.sh mcp-tool` is silent on HTTP 4xx (bash fallback path).** Known wrapper bug in `public/chorus-plugin/bin/chorus-api.sh`: on HTTP 4xx (e.g. `401 Unauthorized` from a bad `CHORUS_API_KEY`), the wrapper's final `jq -r '.result.content[]?'` filter produces empty stdout, and the wrapper itself exits **0**. A bare `RC=$?` check would not halt on the most common runtime failure mode. (`chorus mcp call` on the primary path exits non-zero on tool/transport errors, so `RC` is reliable there.) The skill works around the wrapper case with a `chorus_check_response` helper that checks **three** signals (exit code, `"error":` field in body, empty body) and halts on any of them; every mirror call — CLI or wrapper — uses this helper. See `openspec-aware` §6 for the helper and rationale. The wrapper bug itself is tracked separately.

- **Materialized-Document path requires re-deriving UUIDs.** After approval, the draft's `draftUuid` no longer applies; the Document has a fresh `documentUuid`. From a fresh shell you re-derive it via `chorus_get_documents` for the proposal's project, matching by `title` and `type`, and re-derive `$SLUG` by grepping the proposal description for `^OpenSpec change slug: `. See skill §3.8.

- **Standalone `public/skill/` distribution does not support OpenSpec mode.** The standalone skill ships without a plugin wrapper. Since a file-fill mirror (the `chorus` CLI, or a bundled bash wrapper as fallback) is mandatory in OpenSpec mode, the standalone channel skips it entirely. Users on that channel always run free-form.

---

## See also

- [`public/chorus-plugin/skills/openspec-aware/SKILL.md`](../public/chorus-plugin/skills/openspec-aware/SKILL.md) — Claude Code plugin skill (authoritative for that runtime).
- [`plugins/chorus/skills/openspec-aware/SKILL.md`](../plugins/chorus/skills/openspec-aware/SKILL.md) — Codex plugin skill (authoritative for that runtime).
- OpenSpec upstream: <https://github.com/Fission-AI/OpenSpec>.

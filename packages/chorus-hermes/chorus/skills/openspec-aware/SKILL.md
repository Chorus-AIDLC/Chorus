---
name: openspec-aware
description: OpenSpec-mode authoring for Chorus PM workflows in Hermes. The default whenever OpenSpec is usable; consumes the resolved `## Spec Mode` (never re-detects). Scaffolds `openspec/changes/<slug>/` on disk, and mirrors Markdown files into Chorus document drafts via `chorus mcp call --arg-file` (the native Chorus MCP tool as fallback when the `chorus` CLI is missing). Required reading for the proposal, develop, and yolo skills. When OpenSpec is not the resolved mode, this skill no-ops and the caller follows the resolved mode (spec-lite or free-form).
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.21.1"
  category: project-management
  mcp_server: chorus
---

# OpenSpec-aware Authoring (Hermes plugin)

This skill is a **shared sub-procedure** invoked by the Chorus stage skills (proposal, develop, yolo) when the resolved spec mode is a **usable OpenSpec** — spec-driven authoring through the [OpenSpec CLI](https://github.com/Fission-AI/OpenSpec):

- Activates when the resolved spec mode is a **usable OpenSpec** (see §1): `CHORUS_SPEC_MODE=openspec` *or* unset, **and** `CHORUS_OPENSPEC_MODE` not `off`, an `openspec/` directory exists at the project root, and the `openspec` CLI is on `PATH`.
- Otherwise the calling skill follows the resolved mode — **spec-lite** (the default when OpenSpec isn't usable) or free-form (`CHORUS_SPEC_MODE=off`).

> **See also — `spec-lite` (the lightweight fallback):** OpenSpec (this skill) stays the default whenever usable. When OpenSpec is absent or disabled — or `CHORUS_SPEC_MODE=lite` — the mode resolves to **spec-lite**: a durable local `.chorus/specs/<slug>/spec.md` (never synced) + per-change dated folders `<slug>/<YYYY-MM-DD>-<change-slug>/` of Chorus-typed docs mirrored 1:1 into Chorus via the same `--arg-file` transport. See `skill_view("chorus:spec-lite")`.

When you reach a point in proposal / develop / yolo where this skill is referenced, **read the resolved mode from the `## Spec Mode` section** (see §1) and branch on it. Do not re-derive the detection — the Chorus Hermes plugin's `pre_llm_call` session-start check-in has already resolved it once for this session.

> **Hermes specifics:** the document-mirror transport is the `chorus` CLI (`chorus mcp call … --arg-file content=<file>`, §2 Rule 1), run through the `terminal` tool. When `chorus` is not on `PATH`, the fallback is the native Chorus MCP tool (`mcp__chorus__chorus_pm_add_document_draft`, `mcp__chorus__chorus_pm_update_document_draft`, `mcp__chorus__chorus_pm_update_document`) with `content` read from the file via `read_file`. There is no bundled shell wrapper on Hermes. The helper snippets below are Bash; run multi-line blocks under `bash -lc` (or save them as a `.sh` script with a Bash shebang) if the `terminal` shell is not Bash.

---

## §1. Spec mode — already resolved at session start

The Chorus Hermes plugin's `pre_llm_call` hook resolves the spec mode on the first turn of each session (and again after `/reset` or context compression) via its `spec_mode.py` — the single source of truth, a Python port of the canonical resolver with the same rules — and writes a `## Spec Mode` section into the injected context stating `CHORUS_SPEC_MODE=<lite|openspec|off>`; when the resolved mode is a usable OpenSpec it also carries a `CHORUS_OPENSPEC_ACTIVE=1` line. That line is present only when `CHORUS_SPEC_MODE` is `openspec` **or unset**, **and all three** of these hold:

1. OpenSpec is not disabled (`CHORUS_OPENSPEC_MODE` not `off`, `CHORUS_ENABLE_OPENSPEC` not `false`).
2. The project root contains an `openspec/` directory (i.e. someone ran `openspec init` here).
3. The `openspec` CLI is on `PATH`.

Both signals (2) and (3) are required because the OpenSpec authoring path needs the working directory **and** the CLI. If signal (2) holds but (3) does not, the `## Spec Mode` section carries an install hint (`npm i -g @fission-ai/openspec`); pass it through if asked.

### How to read the value

You should already see something like this in your context (look for the `## Spec Mode` section near the top of the conversation):

```
## Spec Mode

CHORUS_SPEC_MODE=openspec (default — openspec/ directory + openspec CLI both present)

CHORUS_OPENSPEC_ACTIVE=1 (openspec/ directory + openspec CLI both present)
```

or (resolved to lite / off — no `CHORUS_OPENSPEC_ACTIVE=1` line):

```
## Spec Mode

CHORUS_SPEC_MODE=lite (default — OpenSpec not usable: no openspec/ directory at /path/to/repo/openspec)
```

Branch:

- `CHORUS_OPENSPEC_ACTIVE=1` line present → follow §3 (OpenSpec authoring).
- No `CHORUS_OPENSPEC_ACTIVE=1` line → this skill is a no-op; return to the caller, which follows the resolved `CHORUS_SPEC_MODE` (**spec-lite** or free-form). **Do not** scaffold `openspec/changes/`. **Do not** add the slug line to the proposal description.

If the `## Spec Mode` section shows an explicit `CHORUS_SPEC_MODE=openspec` that **cannot be honored** (OpenSpec disabled or not installed — it carries a config-conflict / not-installed reason and no `CHORUS_OPENSPEC_ACTIVE=1` line), the caller MUST **halt** and surface it — do not silently fall back.

### Manual fallback

The mode is resolved by the Chorus Hermes plugin (`spec_mode.py`) at session start — there is no resolver for you to source, and you must **not** hand-roll the rule (a hand-rolled OpenSpec-only check ignores `CHORUS_SPEC_MODE` and the lite/off cases). If the `## Spec Mode` section is genuinely absent:

- **You are a `delegate_task` child** (children start with an isolated context): the parent must pass the resolved `## Spec Mode` lines verbatim in your `context`. If it did not, report back to the parent that the spec mode is missing and stop, rather than guessing.
- **Otherwise** (e.g. the checkin/connection failed): set `CHORUS_SPEC_MODE` explicitly (`lite` | `openspec` | `off`) and start a fresh session (`/reset`, or restart `hermes gateway` for Chorus-woken sessions) so the plugin re-resolves it — rather than guessing.

---

## §2. ⛔ Two non-negotiable rules

Both are enforced at review time. Both have caused incidents in past releases.

### Rule 1 — Fill `content` from the file (CLI preferred, native-tool fallback); never re-type document content from agent output

Document/draft mirror calls (`chorus_pm_add_document_draft`, `chorus_pm_update_document_draft`, `chorus_pm_update_document`) **MUST** fill the `content` field from the local file's bytes, never from a hand-typed body. Calling these tools directly from the native MCP tools with a hand-typed `content` field is a **protocol violation** for OpenSpec mode and will fail review. Use whichever transport is available, preferred first:

- **Primary — the `chorus` CLI:** `chorus mcp call <tool_name> '<json-without-content>' --arg-file content=<file>`. `--arg-file content=<path>` reads the file's raw bytes and injects them as the JSON `content` string, byte-exact, so no encoding helper is needed. See §3.6. **Requires chorus >= 0.17.0** (the `chorus mcp` subcommand was added then; an older CLI errors with "unknown command"); on any version or unknown-command failure, upgrade with `npm install -g @chorus-aidlc/chorus`.
- **Primary transport runs through `terminal`.** The `chorus` CLI is a Node binary on `PATH`; run it with the Hermes `terminal` tool so the file bytes never pass through model context.
- **Fallback — the native Chorus MCP tool, when `chorus` is not on `PATH`:** read the file with `read_file` and call `mcp__chorus__chorus_pm_add_document_draft` / `mcp__chorus__chorus_pm_update_document_draft` / `mcp__chorus__chorus_pm_update_document` with `content` set to the file's text **exactly as read** — no edits, no reflow, no "fixes", and none of any line-number prefix the reader adds for display. This is a degraded path: the body does pass through model context (token cost) and loses the byte-exact guarantee, so after each call spot-check the round-trip (§3.9 step 4) and prefer installing the CLI (`npm install -g @chorus-aidlc/chorus`) before any multi-document mirror. There is no bundled shell wrapper on Hermes.

> **New to the `chorus` CLI?** See `skill_view("chorus:chorus-cli")` for install, configuring agents (`chorus agents add|remove|list`), the connection env vars, and `chorus mcp` basics.

> **Acting identity — which agent the call acts as.** `chorus mcp call` resolves the agent from, in order: `CHORUS_AGENT_PROFILE` (a name or UUID) → `CHORUS_URL` + `CHORUS_API_KEY` in the environment → the single agent configured in `~/.chorus/daemon.json`. On Hermes the credentials come from the environment (`CHORUS_URL`, `CHORUS_API_KEY`) or `~/.hermes/.env`; export them in the `terminal` command if the shell does not see them. If a mirror call fails with `Multiple agents … specify --agent` (several agents configured and no profile/creds in the env), pass your own identity explicitly: `chorus mcp call <tool> … --agent <your-agentUuid>` — your UUID is in your `chorus_checkin` result, and `chorus agents` lists every configured name/UUID.

Reasons (they are why the CLI path is preferred, and why the fallback must copy the file text verbatim):

1. **Token cost.** Re-typing a multi-thousand-line markdown body through the LLM burns input + output tokens for every draft. The CLI's `--arg-file` streams the file's bytes into the JSON string — content never enters LLM context. A typical 3-doc proposal mirror costs roughly zero content-tokens this way; via direct MCP with a re-typed body it routinely costs 20k+.
2. **Byte-equality.** The CLI's `--arg-file` is a byte-faithful encoder: backslashes, quotes, newlines, code-fence content, zero-width chars all survive. LLM re-emission has a non-zero failure rate on long markdown — table alignment drifts, fence escapes get "fixed", long URLs wrap. The exact byte-equality guarantee holds **only** on the `--arg-file` path, never on LLM re-emission — which is why the native-tool fallback needs a round-trip spot check.
3. **Single source of truth.** With a file-fill mirror, the local `openspec/changes/<slug>/*.md` is authoritative and Chorus is a mirror. With agent re-typing, authority splits between local file and whatever the LLM happened to output — a future diff cannot tell which one is correct.

### Rule 2 — Halt on error via `chorus_check_response`

Every `chorus mcp call` must check three signals: exit code, `"error":` in body, empty body. Bare `RC=$?` is defense in depth only — an auth failure or a tool-level error can surface in the body rather than the exit code, so a single-signal check can silently miss the most common runtime failure. See §6 for the helper definition. On the native-tool fallback, treat any error result (or an empty/unexpected result) from the tool as a halt.

---

## §3. OpenSpec mode authoring

### 3.1 Pick a slug

`openspec/changes/<slug>/` is the local change folder. The slug must be:

- kebab-case (`add-export-csv`, not `addExportCsv` or `add_export_csv`),
- derived from the source Idea title,
- unique within `openspec/changes/`.

Record it for later steps:

```bash
SLUG="add-export-csv"
```

### 3.2 Scaffold the change folder

```bash
openspec new change "$SLUG" --description "<one-line idea summary>"
```

This creates `openspec/changes/$SLUG/` with `README.md` and `.openspec.yaml`. Then author by hand:

| Local file | Purpose | Mirror as `Document.type` |
|---|---|---|
| `proposal.md` | Why + What Changes + Capabilities + Impact | `prd` |
| `design.md` | Architecture, contracts, risks | `tech_design` |
| `specs/<capability>/spec.md` | Delta spec (`## ADDED Requirements` + Scenarios) | `spec` (one draft per capability) |
| `tasks.md` | OpenSpec tasks list | _(not mirrored — Chorus task drafts are source of truth)_ |

Use `openspec instructions <artifact> --change "$SLUG"` (artifacts: `proposal`, `specs`, `design`, `tasks`) for templates.

### 3.3 Spec file shape (verified against `openspec instructions specs`)

A delta spec lists one or more block headers — `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`, `## RENAMED Requirements` — and within each, `### Requirement:` entries. Mix freely in the same file; only include the blocks you actually need.

#### `## ADDED Requirements`

Append a brand-new Requirement to the long-term spec.

```
## ADDED Requirements

### Requirement: <name>
<requirement text — use SHALL / MUST for normative behavior>

#### Scenario: <name>
- **WHEN** <condition>
- **THEN** <expected outcome>
```

#### `## MODIFIED Requirements`

**Whole-block replacement, not merge.** Whatever you write here completely replaces the existing same-named Requirement in the long-term spec — title, description, and *all* scenarios. Half-writing it deletes the rest.

```
## MODIFIED Requirements

### Requirement: <existing name>
<full updated requirement text>

#### Scenario: <name>
- **WHEN** <condition>
- **THEN** <expected outcome>

#### Scenario: <other name>
- **WHEN** <condition>
- **THEN** <expected outcome>
```

Always include every scenario you want the post-archive spec to have, even ones that were already present and unchanged.

#### `## REMOVED Requirements`

Delete a Requirement from the long-term spec. The block under the heading is just the requirement name(s) you're removing — no scenarios needed.

```
## REMOVED Requirements

### Requirement: <existing name>
```

#### `## RENAMED Requirements`

Rename a Requirement's title. Body and scenarios are preserved as-is in the long-term spec; use `MODIFIED` instead if you need to change anything besides the title.

```
## RENAMED Requirements

### Requirement: <old name> -> <new name>
```

**Critical formatting rules (verified):**

- Scenarios MUST use **exactly 4 hashtags** (`#### Scenario:`). 3 hashtags or a bullet list silently fail validation.
- Every `### Requirement:` under `ADDED` or `MODIFIED` MUST have at least one `#### Scenario:`.
- `MODIFIED` blocks MUST include the **full updated content** — they overwrite, not patch.
- Use `SHALL` / `MUST` for normative requirements; avoid `should` / `may`.
- The merge into `openspec/specs/<capability>/spec.md` happens at `openspec archive` time (§3.9), not at proposal time. While the proposal is in flight, Chorus only sees the delta file as one `spec` Document — there is no half-merged state for the skill to reason about.

Optional:

```bash
openspec validate "$SLUG"
```

### 3.4 Filling the `content` field byte-exact

The document `content` must be inserted **byte-for-byte** from the local file — never re-typed by the LLM. Two mechanisms, preferred first:

- **Primary — `chorus mcp call … --arg-file content=<path>`** (§3.6). The CLI reads the file's raw bytes and injects them as the JSON `content` string. This is byte-faithful, so **no encoding helper is needed** — pass the base JSON without a `content` field and let `--arg-file` fill it.
- **Fallback — the native MCP tool** (§3.6 fallback, used only when `chorus` is not on `PATH`). `content` is the `read_file` text copied verbatim; verify the round-trip afterwards.

Round-trip verification is exact: a trailing newline difference is real drift and MUST NOT be normalized or ignored.

### 3.5 Create the proposal container with the slug provenance line

Use the regular `chorus_pm_create_proposal` MCP tool (no CLI required for this single call — the description is short, the LLM-emitted version is fine). The description **must** carry exactly one line:

```
OpenSpec change slug: <slug>
```

- on its own line (no other text on that line),
- literal prefix `OpenSpec change slug: ` (capital O, capital S, single space after colon),
- no trailing punctuation,
- value matches the slug passed to `openspec new change`.

This line is machine-grep-able by future runs of this skill and by the §3.9 archive trigger.

### 3.6 Mirror each document draft (CLI primary, native-tool fallback)

> **Rule 1 reminder:** `content` comes from the file's bytes, never a hand-typed body. The agent must not retype the document body.

Define the halt-on-error helper from §6 once at the top. **Primary path — the `chorus` CLI:** pass the base JSON *without* a `content` field and let `--arg-file content=<file>` fill it byte-exact. One call per file:

```bash
# PRD draft — --arg-file fills content byte-exact from the file; no encoding helper needed.
RESULT=$(chorus mcp call chorus_pm_add_document_draft \
  "{\"proposalUuid\":\"$PROPOSAL_UUID\",\"type\":\"prd\",\"title\":\"PRD: $HUMAN_TITLE\"}" \
  --arg-file content="openspec/changes/$SLUG/proposal.md")
RC=$?
chorus_check_response "chorus_pm_add_document_draft (prd)" "$RC" "$RESULT"
PRD_DRAFT_UUID=$(printf '%s' "$RESULT" | grep -o '"draftUuid"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
```

Repeat with `type: "tech_design"` for `design.md`, and one call per capability with `type: "spec"` for each `specs/<capability>/spec.md`. Do **not** mirror `tasks.md` — Chorus task drafts (created via the `chorus_pm_add_task_draft` MCP tool, no CLI needed) are the source of truth for tasks.

> Why parsing uses `printf '%s' "$RESULT" | grep` not `echo "$RESULT" | jq`: `echo` interprets backslash sequences inside the captured JSON, turning embedded `\n` into a real newline. `jq` then aborts with `Invalid string: control characters from U+0000 through U+001F must be escaped`. `printf '%s'` emits the captured bytes verbatim. Same pattern applies to all CLI-result parsing in this skill.

#### Fallback — when the `chorus` CLI is not on `PATH`

If `command -v chorus` fails, mirror through the native Chorus MCP tool instead. There is no shell wrapper or encoding helper on Hermes. Per file:

1. `read_file("openspec/changes/<slug>/proposal.md")` — take the file text exactly as stored (drop any display-only line-number prefix).
2. Call the native tool with that text as `content`:

   ```
   mcp__chorus__chorus_pm_add_document_draft({
     proposalUuid: "<proposalUuid>",
     type: "prd",
     title: "PRD: <human title>",
     content: "<the file text, verbatim>"
   })
   ```

3. Treat any error (or empty) result as a halt (§6). Record the returned `draftUuid`.

Repeat for `design.md` (`tech_design`) and each `specs/<capability>/spec.md` (`spec`). Because this path re-emits the body, spot-check the round-trip once the drafts materialize (§3.9 step 4), and install the `chorus` CLI before the next mirror if you can.

### 3.7 Editing a draft after the first mirror

Local file changes propagate via `chorus_pm_update_document_draft` — same primary/fallback split as §3.6, same halt check. Primary (CLI):

```bash
RESULT=$(chorus mcp call chorus_pm_update_document_draft \
  "{\"proposalUuid\":\"$PROPOSAL_UUID\",\"draftUuid\":\"$PRD_DRAFT_UUID\"}" \
  --arg-file content="openspec/changes/$SLUG/proposal.md")
RC=$?
chorus_check_response "chorus_pm_update_document_draft" "$RC" "$RESULT"
```

Fallback (no `chorus` on `PATH`) — the native tool, same rules as the §3.6 fallback:

```
mcp__chorus__chorus_pm_update_document_draft({
  proposalUuid: "<proposalUuid>",
  draftUuid: "<prdDraftUuid>",
  content: "<read_file text of openspec/changes/<slug>/proposal.md, verbatim>"
})
```

### 3.8 Editing a Document after proposal approval

Once the proposal is approved, drafts materialize into Documents with their own UUIDs. To keep `openspec/changes/$SLUG/` and the Chorus Document in sync, mirror file edits via `chorus_pm_update_document`. Primary (CLI):

```bash
RESULT=$(chorus mcp call chorus_pm_update_document \
  "{\"documentUuid\":\"$SPEC_DOCUMENT_UUID\"}" \
  --arg-file content="openspec/changes/$SLUG/specs/<capability>/spec.md")
RC=$?
chorus_check_response "chorus_pm_update_document" "$RC" "$RESULT"
```

Fallback (no `chorus` on `PATH`) — the native tool, same rules as the §3.6 fallback:

```
mcp__chorus__chorus_pm_update_document({
  documentUuid: "<specDocumentUuid>",
  content: "<read_file text of openspec/changes/<slug>/specs/<capability>/spec.md, verbatim>"
})
```

To re-derive `$SPEC_DOCUMENT_UUID` from a fresh shell, look it up via `chorus_get_documents` for the proposal's project and match by `title` + `type`. Re-derive `$SLUG` by grepping the proposal's `description` for `^OpenSpec change slug: `.

### 3.9 Archive after the last task is verified

When the **LAST** task of an OpenSpec-mode idea is admin-verified via `chorus_admin_verify_task`, the Chorus Hermes plugin's `transform_tool_result` hook appends an **OpenSpec Archive Trigger** reminder (branch A of its post-verify reminders) to the tool result. It contains the literal substring `openspec archive <slug>` and the project/proposal UUIDs, so you can act without re-reading the slug.

The reminder is only a reminder — the plugin does not archive anything; you (the agent) perform the archive:

1. **Run archive locally.** Use `--yes` for non-interactive mode. Do NOT pass `--skip-specs` (defeats the mirror-back) or `--no-validate` (lets malformed deltas corrupt cumulative specs).

   ```bash
   openspec archive "$SLUG" --yes
   ```

   This moves `openspec/changes/$SLUG/` under `openspec/changes/archive/<date>-<slug>/` and emits/updates `openspec/specs/<capability>/spec.md` for each capability. (Run `openspec archive --help` against your installed version to confirm the current flag set — flags can drift between releases.)

2. **Mirror each updated `openspec/specs/<capability>/spec.md` back** to the matching post-approval Chorus Document (§3.8 contract). `chorus_get_documents` only supports `projectUuid` + `type` server-side filters; filter by title client-side. One `chorus_pm_update_document` call per capability.

3. **Halt on any error** from `openspec archive` or `chorus_pm_update_document`. Print stderr verbatim, post a comment on the proposal recording the failure (`chorus_add_comment` with `targetType: "proposal"`, `targetUuid: <proposalUuid>`), then stop. No retry. Matches §6 "no silent errors." (Comment on the proposal, not the idea: the failure is in archiving proposal-derived specs, and proposals can be `inputType: "document"` with no idea attached.)

4. **Confirm success.** For each capability, verify that
   `openspec/specs/<capability>/spec.md` round-trips **byte-equal** with its
   Chorus Document. The `--arg-file` mirror path already guarantees this, so a
   spot check is enough: fetch the Document with
   `chorus mcp call chorus_get_document '{"documentUuid":"<uuid>"}'`, write its
   `content` to a temp file, and `cmp` (or compare SHA-256 of) both files.
   **Do NOT use `jq -r`** to extract the content — it appends a trailing newline
   and manufactures a phantom 1-byte drift (a spec that mirrored correctly will
   read as 1 byte longer on the server). Use `jq -j` (no trailing newline), and
   never rely on recursive `jq`, `head`, command substitution, or newline
   normalization. On mismatch report only byte counts and hashes. (The Chorus
   Hermes plugin ships no round-trip verifier script — the `--arg-file`
   byte-equality guarantee makes it unnecessary.) If the mirror went through the
   native-tool fallback (no `chorus` CLI), fetch with `chorus_get_document` and
   compare the content against the local file as closely as you can; flag any
   visible drift and recommend a CLI re-mirror.

**Strict opt-in:** if the verified task is not the last of its idea, OR the proposal description carries no `OpenSpec change slug: <slug>` line, OR the local shell has no `openspec` CLI, the plugin appends no archive reminder (branch A stays silent; the code-review and report reminders, branches C and B, are independent). Existing free-form behavior is preserved.

---

## §4. When OpenSpec is not the resolved mode

When the resolved mode is not a usable OpenSpec (no `CHORUS_OPENSPEC_ACTIVE=1` line), this skill is a **no-op** — return to the calling skill, which follows the resolved `CHORUS_SPEC_MODE`: **spec-lite** (the default when OpenSpec isn't usable) or free-form (`=off`). From this skill's side:

- No `openspec/changes/` folder is created or referenced.
- No `OpenSpec change slug: …` line is added to the proposal description.
- In **spec-lite**, the caller follows `skill_view("chorus:spec-lite")` (durable `.chorus/specs/<slug>/spec.md` + dated per-change folders mirrored via `--arg-file`); in **free-form**, document drafts are authored via direct MCP `chorus_pm_add_document_draft` calls with inline `content` — same as before this skill existed.
- Rule 1 (file-fill mirror) still applies in spec-lite (mirror from the local file); in free-form there is no local file source of truth.
- The §3.9 archive reminder never fires (no slug → branch A silent); spec-lite has no archive step at all.

---

## §5. Document type mapping (reference table)

| Local file | Chorus `Document.type` | Mirrored? |
|---|---|---|
| `openspec/changes/<slug>/proposal.md` | `prd` | yes |
| `openspec/changes/<slug>/design.md` | `tech_design` | yes |
| `openspec/changes/<slug>/specs/<capability>/spec.md` | `spec` | yes (one draft per capability) |
| `openspec/changes/<slug>/tasks.md` | _(not mapped)_ | **no** — Chorus task drafts are source of truth |

`prd`, `tech_design`, `spec` are pre-existing valid `Document.type` values — no schema change required.

---

## §6. Failure visibility — the `chorus_check_response` helper

This helper guards every `chorus mcp call` on the primary path. `chorus mcp call` exits non-zero on tool/transport errors, so `RC` is usually reliable — but an error can also arrive as an `"error"` object in an otherwise successful body, and an empty body means the call produced nothing usable. Run the three-signal check after every call, as defense in depth. (On the native-tool fallback there is no shell result to check: halt on any error or empty tool result.)

Define this helper **once** at the top of the authoring session and use it after every `chorus mcp call` mirror:

```bash
chorus_check_response() {
  local _tool="$1"
  local _rc="$2"
  local _body="$3"
  local _has_error=0
  local _is_empty=0

  local _trimmed
  _trimmed=$(printf '%s' "$_body" | tr -d ' \t\n\r')
  [ -z "$_trimmed" ] && _is_empty=1

  if [ "$_is_empty" -eq 0 ]; then
    if command -v jq >/dev/null 2>&1; then
      if printf '%s' "$_body" | jq -e 'try ([.. | objects | has("error")] | any) catch false' >/dev/null 2>&1; then
        _has_error=1
      fi
    else
      printf '%s' "$_body" | grep -qE '"error"[[:space:]]*:' && _has_error=1
    fi
  fi

  if [ "$_rc" -ne 0 ] || [ "$_has_error" -eq 1 ] || [ "$_is_empty" -eq 1 ]; then
    echo "ERROR: $_tool failed (exit=$_rc, error_in_body=$_has_error, empty_body=$_is_empty)" >&2
    echo "Output: $_body" >&2
    [ "$_rc" -ne 0 ] && exit "$_rc" || exit 1
  fi
}
```

**Anti-patterns** — do **not**:

- Collapse to `|| true`.
- Redirect stderr to `/dev/null`.
- Bury the `chorus mcp call` inside a pipeline (masks `$?`).
- Skip capturing `$RESULT` into a variable; the helper needs the body.
- Use only `if [ "$RC" -ne 0 ]; then ...` — that misses the HTTP-error path.

**Minimal call site shape:**

```bash
RESULT=$(chorus mcp call <tool_name> '<json-without-content>' --arg-file content=<file>)
RC=$?
chorus_check_response "<tool_name>" "$RC" "$RESULT"
# ...if we reach here, the call succeeded; parse RESULT and continue.
```

This is project-wide policy: no silent errors.

---

## §7. Quick reference checklist

When invoked from a stage skill (proposal / develop / yolo):

1. Read the `## Spec Mode` section injected by the Chorus Hermes plugin at session start (§1) — proceed only if it carries the `CHORUS_OPENSPEC_ACTIVE=1` line. If the section is absent, use the fallback in §1 (parent-forwarded mode, or set `CHORUS_SPEC_MODE` explicitly + `/reset`).
2. No `CHORUS_OPENSPEC_ACTIVE=1` line → no-op; return to the caller per the resolved `CHORUS_SPEC_MODE` (spec-lite or free-form) — see §4.
3. Otherwise:
   a. Pick `$SLUG` (§3.1).
   b. `openspec new change "$SLUG"` (§3.2).
   c. Author `proposal.md`, `design.md`, `specs/<capability>/spec.md` (§3.2–§3.3). Mix `ADDED` / `MODIFIED` / `REMOVED` / `RENAMED` blocks as needed; remember `MODIFIED` overwrites the whole Requirement.
   d. Optional: `openspec validate "$SLUG"`.
   e. `chorus_pm_create_proposal` (direct MCP) with the `OpenSpec change slug: $SLUG` line in description (§3.5).
   f. Define the `chorus_check_response` helper. Use `chorus mcp call … --arg-file content=<file>` via `terminal` for mirrors (§3.6). Only when `chorus` is not on `PATH`, fall back to the native MCP tool with the `read_file` text verbatim (§2 Rule 1).
   g. For each row in §5 with "yes" — mirror via `chorus mcp call chorus_pm_add_document_draft … --arg-file content=<file>` (§3.6; fallback = native `mcp__chorus__chorus_pm_add_document_draft`). Record each `$DRAFT_UUID`.
   h. On any failed `chorus_check_response` — halt, surface the error, do NOT proceed.
4. Edits before approval → §3.7. Edits after approval → §3.8.
5. Last task verified → the plugin's post-verify reminder (branch A) appears → run §3.9 archive flow.

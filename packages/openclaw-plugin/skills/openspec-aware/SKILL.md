---
name: openspec-aware
description: Opt-in OpenSpec-mode authoring for Chorus PM workflows on OpenClaw. Runs inline three-check detection for the local `openspec` CLI, scaffolds `openspec/changes/<slug>/` on disk, and mirrors Markdown files into Chorus document drafts via the `chorus-api.sh` wrapper. Required reading for the proposal, develop, and yolo skills whenever the user has the `openspec` CLI installed.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.10.0"
  category: project-management
  mcp_server: chorus
---

# OpenSpec-aware Authoring (OpenClaw plugin)

This skill is a **shared sub-procedure** invoked by the Chorus stage skills (proposal, develop, yolo) whenever the user wants spec-driven authoring through the [OpenSpec CLI](https://github.com/Fission-AI/OpenSpec). It is opt-in:

- Activates when **all three** signals hold (see §1): `CHORUS_OPENSPEC_MODE` is not `off`, an `openspec/` directory exists at the project root, and the `openspec` CLI is on `PATH`.
- Otherwise the calling skill falls back to its existing free-form behavior.

> **Tool namespace:** Chorus MCP tools are exposed under a `chorus__` prefix on OpenClaw (e.g. `chorus__chorus_pm_create_proposal`). Bare names are used in prose for readability — prepend `chorus__` when invoking the MCP tools directly. **Document-mirror calls do NOT go through the MCP harness at all** — they go through the `chorus-api.sh` wrapper (see §2 Rule 1), which talks to the Chorus MCP endpoint over HTTP using your API key, independent of the `chorus__` namespacing.

---

## §1. Detection — run inline, every time (no SessionStart hook on OpenClaw)

> **OpenClaw difference:** the Claude Code plugin precomputes `CHORUS_OPENSPEC_ACTIVE` once in a SessionStart hook and injects it into context. **OpenClaw does not run that hook.** You MUST compute activeness yourself, inline, the moment you reach this skill from a stage skill. Do not look for an injected `CHORUS_OPENSPEC_ACTIVE` value — it will not exist on OpenClaw.

Compute the value with the **three checks**. `CHORUS_OPENSPEC_ACTIVE` is `1` only when **all three** hold:

1. `CHORUS_OPENSPEC_MODE` is **not** set to `off` (explicit opt-out wins).
2. The project root contains an `openspec/` directory (i.e. someone ran `openspec init` here).
3. The `openspec` CLI is on `PATH`.

Both signals (2) and (3) are required because the OpenSpec authoring path needs the working directory **and** the CLI — having one without the other leaves the workflow unrunnable. If signal (2) holds but (3) does not, surface a hint to the user — "OpenSpec repo detected — install with: `npm i -g @fission-ai/openspec`" — rather than silently choosing free-form.

### Inline detection block (run this)

```bash
# Run the three checks directly. PROJECT_DIR is your project root
# (OpenClaw does not export CLAUDE_PROJECT_DIR — default to $PWD).
PROJECT_DIR="${PWD}"
if [ "${CHORUS_OPENSPEC_MODE:-}" = "off" ]; then
  CHORUS_OPENSPEC_ACTIVE=0
elif [ ! -d "${PROJECT_DIR}/openspec" ]; then
  CHORUS_OPENSPEC_ACTIVE=0
elif ! openspec --version >/dev/null 2>&1; then
  CHORUS_OPENSPEC_ACTIVE=0   # consider surfacing the install hint to the user
else
  CHORUS_OPENSPEC_ACTIVE=1
fi
echo "CHORUS_OPENSPEC_ACTIVE=$CHORUS_OPENSPEC_ACTIVE"
```

Branch on the result:

- `CHORUS_OPENSPEC_ACTIVE=1` → follow §3 (OpenSpec authoring).
- `CHORUS_OPENSPEC_ACTIVE=0` → return to the calling skill's free-form path. **Do not** scaffold `openspec/changes/`. **Do not** add the slug line to the proposal description.

Run this detection inline whenever proposal / develop / yolo reference this skill. There is no host-injected value to read on OpenClaw; recomputing the three checks is the contract.

---

## §2. ⛔ Two non-negotiable rules

Both are enforced at review time. Both have caused incidents in past releases.

### Rule 1 — Mirror via the wrapper, never re-type document content from agent output

Document/draft mirror calls (`chorus_pm_add_document_draft`, `chorus_pm_update_document_draft`, `chorus_pm_update_document`) **MUST** go through:

```
chorus-api.sh mcp-tool <tool_name> "$PAYLOAD"
```

with `$PAYLOAD` built using `json_encode_file` (defined in §3.4). Calling these tools directly from the agent's MCP harness with a hand-typed `content` field is a **protocol violation** for OpenSpec mode and will fail review. Reasons:

1. **Token cost.** Re-typing a multi-thousand-line markdown body through the LLM burns input + output tokens for every draft. The wrapper streams bytes through `jq -Rs '.'` — content never enters LLM context. A typical 3-doc proposal mirror via the script costs roughly zero content-tokens; via direct MCP it routinely costs 20k+.
2. **Byte-equality.** `jq -Rs '.'` is a byte-faithful encoder: backslashes, quotes, newlines, code-fence content, zero-width chars all survive. LLM re-emission has a non-zero failure rate on long markdown — table alignment drifts, fence escapes get "fixed", long URLs wrap. The byte-equality guarantee (modulo trailing `\n`) holds **only** on the wrapper path.
3. **Single source of truth.** With the wrapper, the local `openspec/changes/<slug>/*.md` is authoritative and Chorus is a mirror. With agent re-typing, authority splits between local file and whatever the LLM happened to output — a future diff cannot tell which one is correct.

> **`chorus-api.sh` availability on OpenClaw.** This wrapper is the document-mirror transport. It must be reachable as `chorus-api.sh` on `PATH` (the Chorus standalone skill bundle ships it; if you installed via that bundle it is already on `PATH`). If it is **not** on `PATH` in your OpenClaw environment, do one of:
> - call it by its absolute path (e.g. `"$HOME/.chorus/bin/chorus-api.sh" mcp-tool ...`), or
> - reproduce its single behavior inline — POST a JSON-RPC `tools/call` for `<tool_name>` with arguments `$PAYLOAD` to `"$CHORUS_URL/api/mcp"` with header `Authorization: Bearer $CHORUS_API_KEY` using `curl`, capturing the raw body for the §6 halt-on-error check.
>
> The wrapper requires `CHORUS_URL` and `CHORUS_API_KEY` in the environment (same values as your plugin config `chorusUrl` / `apiKey`). Export them before the first call if they are not already set. What you must NOT do is re-type the document body through the model — the wrapper-only rule stands regardless of how you invoke the wrapper.

### Rule 2 — Halt on error via `chorus_check_response`

Every wrapper call must check three signals: wrapper exit code, `"error":` in body, empty body. Bare `RC=$?` is **insufficient** — the wrapper exits 0 on HTTP 401 (auth failure) with empty body, so a single-signal check silently misses the most common runtime failure. See §6 for the helper definition.

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

### 3.4 Helper: `json_encode_file`

Define once at the top of the authoring session. With `jq` available it streams the file into a JSON string; the fallback matches `chorus-api.sh`'s own escaping when `jq` is missing.

```bash
json_encode_file() {
  local _path="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -Rs '.' < "$_path"
  else
    local _content
    _content=$(cat "$_path")
    _content=${_content//\\/\\\\}
    _content=${_content//\"/\\\"}
    _content=${_content//$'\n'/\\n}
    printf '"%s"' "$_content"
  fi
}
```

Round-trip: the Chorus backend appends a single `\n` to draft content on write, so server `content` is **byte-equal modulo a trailing newline**. Reviewers diffing local file vs server should ignore that one byte.

### 3.5 Create the proposal container with the slug provenance line

Use the regular `chorus_pm_create_proposal` MCP tool (no wrapper required for this single call — the description is short, the LLM-emitted version is fine). The description **must** carry exactly one line:

```
OpenSpec change slug: <slug>
```

- on its own line (no other text on that line),
- literal prefix `OpenSpec change slug: ` (capital O, capital S, single space after colon),
- no trailing punctuation,
- value matches the slug passed to `openspec new change`.

This line is machine-grep-able by future runs of this skill and by the §3.9 archive trigger.

### 3.6 Mirror each document draft via the wrapper

> **Rule 1 reminder:** these calls go through `chorus-api.sh`, not direct MCP. The agent must not retype the document body.

Ensure `CHORUS_URL` and `CHORUS_API_KEY` are exported (Rule 1 note). Define the halt-on-error helper from §6 once at the top, then run one call per file:

```bash
# PRD draft
CONTENT=$(json_encode_file "openspec/changes/$SLUG/proposal.md")
PAYLOAD=$(cat <<JSON
{
  "proposalUuid": "$PROPOSAL_UUID",
  "type": "prd",
  "title": "PRD: $HUMAN_TITLE",
  "content": $CONTENT
}
JSON
)
RESULT=$(chorus-api.sh mcp-tool chorus_pm_add_document_draft "$PAYLOAD")
RC=$?
chorus_check_response "chorus_pm_add_document_draft (prd)" "$RC" "$RESULT"
PRD_DRAFT_UUID=$(printf '%s' "$RESULT" | grep -o '"draftUuid"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
```

Repeat with `type: "tech_design"` for `design.md`, and one call per capability with `type: "spec"` for each `specs/<capability>/spec.md`. Do **not** mirror `tasks.md` — Chorus task drafts (created via the `chorus_pm_add_task_draft` MCP tool, no wrapper needed) are the source of truth for tasks.

> Why parsing uses `printf '%s' "$RESULT" | grep` not `echo "$RESULT" | jq`: `echo` interprets backslash sequences inside the captured JSON, turning embedded `\n` into a real newline. `jq` then aborts with `Invalid string: control characters from U+0000 through U+001F must be escaped`. `printf '%s'` emits the captured bytes verbatim. Same pattern applies to all wrapper-result parsing in this skill.

### 3.7 Editing a draft after the first mirror

Local file changes propagate via `chorus_pm_update_document_draft` — same wrapper, same `json_encode_file`, same halt check.

```bash
CONTENT=$(json_encode_file "openspec/changes/$SLUG/proposal.md")
PAYLOAD=$(cat <<JSON
{
  "proposalUuid": "$PROPOSAL_UUID",
  "draftUuid": "$PRD_DRAFT_UUID",
  "content": $CONTENT
}
JSON
)
RESULT=$(chorus-api.sh mcp-tool chorus_pm_update_document_draft "$PAYLOAD")
RC=$?
chorus_check_response "chorus_pm_update_document_draft" "$RC" "$RESULT"
```

### 3.8 Editing a Document after proposal approval

Once the proposal is approved, drafts materialize into Documents with their own UUIDs. To keep `openspec/changes/$SLUG/` and the Chorus Document in sync, mirror file edits via `chorus_pm_update_document`:

```bash
CONTENT=$(json_encode_file "openspec/changes/$SLUG/specs/<capability>/spec.md")
PAYLOAD=$(cat <<JSON
{
  "documentUuid": "$SPEC_DOCUMENT_UUID",
  "content": $CONTENT
}
JSON
)
RESULT=$(chorus-api.sh mcp-tool chorus_pm_update_document "$PAYLOAD")
RC=$?
chorus_check_response "chorus_pm_update_document" "$RC" "$RESULT"
```

To re-derive `$SPEC_DOCUMENT_UUID` from a fresh shell, look it up via `chorus_get_documents` for the proposal's project and match by `title` + `type`. Re-derive `$SLUG` by grepping the proposal's `description` for `^OpenSpec change slug: `.

### 3.9 Archive after the last task is verified

> **OpenClaw difference:** the Claude Code plugin has a PostToolUse hook (`bin/on-post-verify-task.sh`) that fires after `chorus_admin_verify_task` and injects an `openspec archive <slug>` reminder. **OpenClaw has no such hook.** You (the agent) must detect the trigger yourself: after each `chorus_admin_verify_task`, check whether the just-verified task was the **LAST** task of its OpenSpec-mode idea (every Task across every approved Proposal of that idea is now `done`/`closed`, and the proposal `description` carries an `OpenSpec change slug: <slug>` line). If so, run the archive flow below. If not, do nothing.

When the trigger holds, you perform the archive:

1. **Run archive locally.** Use `--yes` for non-interactive mode. Do NOT pass `--skip-specs` (defeats the mirror-back) or `--no-validate` (lets malformed deltas corrupt cumulative specs).

   ```bash
   openspec archive "$SLUG" --yes
   ```

   This moves `openspec/changes/$SLUG/` under `openspec/changes/archive/<date>-<slug>/` and emits/updates `openspec/specs/<capability>/spec.md` for each capability. (Run `openspec archive --help` against your installed version to confirm the current flag set — flags can drift between releases.)

2. **Mirror each updated `openspec/specs/<capability>/spec.md` back** to the matching post-approval Chorus Document (§3.8 contract). `chorus_get_documents` only supports `projectUuid` + `type` server-side filters; filter by title client-side. One `chorus_pm_update_document` call per capability.

3. **Halt on any error** from `openspec archive` or `chorus_pm_update_document`. Print stderr verbatim, post a comment on the proposal recording the failure (`chorus_add_comment` with `targetType: "proposal"`, `targetUuid: <proposalUuid>`), then stop. No retry. Matches §6 "no silent errors." (Comment on the proposal, not the idea: the failure is in archiving proposal-derived specs, and proposals can be `inputType: "document"` with no idea attached.)

4. **Confirm success.** List `openspec/specs/<capability>/spec.md` files and verify they round-trip byte-equal (modulo trailing newline) with their Chorus Document counterparts.

**Strict opt-in:** if the verified task is not the last of its idea, OR the proposal description carries no `OpenSpec change slug: <slug>` line, OR the local shell has no `openspec` CLI, do nothing — no archive. Existing free-form behavior is preserved.

---

## §4. Fallback authoring (no openspec)

When the §1 detection puts the agent in fallback mode (`CHORUS_OPENSPEC_ACTIVE=0`), this skill is a **no-op**. Return to the calling skill's free-form path:

- No `openspec/changes/` folder is created or referenced.
- No `OpenSpec change slug: …` line is added to the proposal description.
- Document drafts are authored via direct MCP `chorus_pm_add_document_draft` calls with inline `content` — same as before this skill existed.
- Rule 1 (wrapper-only mirror) does not apply — there is no local file source of truth.
- The §3.9 archive flow does nothing (no slug → no archive).

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

There is a known wrapper edge case: when the server returns HTTP 4xx (e.g. 401 from a bad `CHORUS_API_KEY`), `chorus-api.sh mcp-tool` captures the JSON-RPC error body internally, pipes it through a `.result.content[]?` jq filter that produces no output when `.result` is absent, and exits 0 with empty stdout. A bare `RC=$?` check would not halt on this — the most common runtime failure mode would be invisible. (If you reproduced the wrapper inline via `curl` per the Rule 1 note, the same three-signal check still applies to the raw HTTP body.)

Define this helper **once** at the top of the authoring session and use it after every wrapper call:

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
- Bury the wrapper call inside a pipeline (masks `$?`).
- Skip capturing `$RESULT` into a variable; the helper needs the body.
- Use only `if [ "$RC" -ne 0 ]; then ...` — that misses the HTTP-error path.

**Minimal call site shape:**

```bash
RESULT=$(chorus-api.sh mcp-tool <tool_name> "$PAYLOAD")
RC=$?
chorus_check_response "<tool_name>" "$RC" "$RESULT"
# ...if we reach here, the call succeeded; parse RESULT and continue.
```

This is project-wide policy: no silent errors.

---

## §7. Quick reference checklist

When invoked from a stage skill (proposal / develop / yolo):

1. **Run the §1 inline three-check detection yourself** (no SessionStart hook on OpenClaw). Compute `CHORUS_OPENSPEC_ACTIVE` from: `CHORUS_OPENSPEC_MODE != off` + `openspec/` dir present + `openspec` CLI on PATH.
2. If `CHORUS_OPENSPEC_ACTIVE=0` → return to caller's free-form path (§4).
3. Otherwise:
   a. Pick `$SLUG` (§3.1).
   b. `openspec new change "$SLUG"` (§3.2).
   c. Author `proposal.md`, `design.md`, `specs/<capability>/spec.md` (§3.2–§3.3). Mix `ADDED` / `MODIFIED` / `REMOVED` / `RENAMED` blocks as needed; remember `MODIFIED` overwrites the whole Requirement.
   d. Optional: `openspec validate "$SLUG"`.
   e. `chorus_pm_create_proposal` (direct MCP) with the `OpenSpec change slug: $SLUG` line in description (§3.5).
   f. Export `CHORUS_URL` / `CHORUS_API_KEY`; define `json_encode_file`, `chorus_check_response` helpers; confirm `chorus-api.sh` is reachable (Rule 1 note).
   g. For each row in §5 with "yes" — mirror via `chorus-api.sh mcp-tool chorus_pm_add_document_draft` (§3.6). Record each `$DRAFT_UUID`.
   h. On any failed `chorus_check_response` — halt, surface the error, do NOT proceed.
4. Edits before approval → §3.7. Edits after approval → §3.8.
5. Last task verified → detect the trigger yourself (no hook) → run §3.9 archive flow.

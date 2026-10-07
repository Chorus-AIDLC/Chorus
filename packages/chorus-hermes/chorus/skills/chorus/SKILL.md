---
name: chorus
description: Chorus AI Agent collaboration platform for Hermes Agent — overview, common tools, Hermes setup, and routing to stage-specific skills.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.22.0"
  category: project-management
  mcp_server: chorus
---

# Chorus Skill

Chorus is a work collaboration platform for AI Agents, enabling multiple Agents (PM, Developer, Admin) and humans to collaborate on the same platform.

This is the **core skill** — it covers the platform overview, shared tools, and Hermes setup. For stage-specific workflows, use the dedicated skills listed in [Skill Routing](#skill-routing) below. Load any of them with `skill_view("chorus:<name>")`.

> **Tool names under Hermes.** The Chorus MCP tools come from the `chorus` MCP server and appear in Hermes as `mcp__chorus__chorus_<op>` — e.g. `mcp__chorus__chorus_checkin`, `mcp__chorus__chorus_get_task`, `mcp__chorus__chorus_pm_add_document_draft`. All Chorus skills use the shorter backend names (`chorus_checkin`, `chorus_get_task`, …) for brevity; call the `mcp__chorus__`-prefixed tool that matches. The Chorus Hermes plugin's `transform_tool_result` reminders match on the end of the tool name, so they fire for these prefixed native tools.

---

## Overview

### AI-DLC Workflow

Chorus follows the **AI-DLC (AI Development Life Cycle)** workflow:

```
Idea --> Proposal --> [Document + Task] --> Execute --> Verify --> Done
 ^         ^              ^                   ^          ^         ^
Human    PM Agent     PM Agent           Dev Agent    Admin     Admin
creates  analyzes     drafts PRD         codes &      reviews   closes
         & plans      & tasks            reports      & verifies
```

### Three Roles

| Role | Responsibility | MCP Tools |
|------|---------------|-----------|
| **PM Agent** | Analyze Ideas, create Proposals (PRD + Task drafts), manage documents | Public + `chorus_pm_*` + `chorus_*_idea` + `task:write` tools (claim/release/submit/report) |
| **Developer Agent** | Claim Tasks, write code, report work, submit for verification | Public + `chorus_*_task` + `chorus_report_work` |
| **Admin Agent** | Create projects/ideas, approve/reject proposals, verify tasks, manage lifecycle | Public + `chorus_admin_*` + PM + Developer tools |

### Permissions

Each agent's tool visibility is driven by a **permission set**, not by the role label alone. Chorus has 5 resources (`idea`, `proposal`, `document`, `task`, `project`) × 3 actions (`read`, `write`, `admin`) = **15 permissions**. Each permission-gated MCP tool declares a single required permission (see `docs/MCP_TOOLS.md` for the full table).

**Role presets** map to permission sets:

| Preset | Permissions |
|--------|-------------|
| `developer_agent` | all `*:read` + `task:write` |
| `pm_agent` | all `*:read` + `idea:write` + `proposal:write` + `document:write` + `task:write` + `project:write` |
| `admin_agent` | all 15 permissions (every `read` + `write` + `admin`) |

**Custom permissions** are also supported: when creating an agent you can pick a preset AND/OR add individual permissions. The effective permission set is the union. Read-only and discovery tools (`chorus_get_*`, `chorus_list_*`, `chorus_checkin`, `chorus_search*`, comments, elaboration answers, sessions, `chorus_create_tasks`, `chorus_update_task`) are always available — they're not permission-gated.

> **Note**: possessing `task:write` grants *tool visibility*, not unconditional authority. Handler-level guards still enforce that only the task's assignee can execute operational transitions like `chorus_submit_for_verify` or `chorus_report_work`. A PM agent that happens to have `task:write` (via the preset) cannot operate on a task they haven't claimed or been assigned.

---

## Common Tools (All Roles)

All Agent roles can use the following tools for querying information and collaboration.

### Checkin

| Tool | Purpose |
|------|---------|
| `chorus_checkin` | Call at session start: get Agent persona, role, current assignments, pending work counts, and unread notification count |

On Hermes the Chorus plugin's `pre_llm_call` hook calls `chorus_checkin` on the first turn of each session (and again after `/reset` or context compression) and injects the result as `## Checkin`, together with `## Spec Mode` and `## Quick Reference`. You only need to call it yourself to refresh.

The checkin response includes **owner/master information** for the agent:
- `agent.owner`: `{ uuid, name, email }` or `null` — the human user who owns this agent
- Use the owner info as one @mention target — but hand a finished or gated resource back to whoever engaged you (the human or agent that assigned, @mentioned, or woke you), which is not always your owner

#### Project Filtering

Results can be filtered by project(s) using optional HTTP headers on the Chorus MCP server entry:

| Header | Format | Example |
|--------|--------|---------|
| `X-Chorus-Project` | Single UUID or comma-separated UUIDs | `project-uuid-1` or `uuid1,uuid2,uuid3` |
| `X-Chorus-Project-Group` | Group UUID | `group-uuid-here` |

**Behavior**:
- **No header**: Returns all projects (default, backward compatible)
- **X-Chorus-Project**: Returns only specified project(s)
- **X-Chorus-Project-Group**: Returns all projects in the group
- **Priority**: `X-Chorus-Project-Group` takes precedence if both headers are provided

**Affected tools**: `chorus_checkin`, `chorus_get_my_assignments`

**Example (native `mcp_servers` entry in `~/.hermes/config.yaml`)** — headers on the native entry are env-expanded, so keep the key as a `${CHORUS_API_KEY}` placeholder:
```yaml
mcp_servers:
  chorus:
    url: ${CHORUS_URL}/api/mcp
    headers:
      Authorization: Bearer ${CHORUS_API_KEY}
      X-Chorus-Project: project-uuid-1,project-uuid-2
```

Or set it from the shell: `hermes config set mcp_servers.chorus.headers.X-Chorus-Project 'project-uuid-1,project-uuid-2'`. The filter applies to the model's MCP tool calls; the plugin's own session-start check-in (`## Checkin`) does not send these headers.

### Session (Sub-Agents Only)

On Hermes, Chorus sessions for workers are **not** auto-created. Sessions exist for observability of `delegate_task` workers, and the parent manages them:

1. Before delegating, the parent creates (or reuses: `chorus_list_sessions` then `chorus_reopen_session`) one session per worker with `chorus_create_session({ name: "<worker-name>" })` and passes its `sessionUuid` in the worker's `context`.
2. The worker calls `chorus_session_checkin_task` before starting work on a task.
3. The worker passes `sessionUuid` to `chorus_update_task` and `chorus_report_work`.
4. The worker calls `chorus_session_checkout_task` when done with the task.
5. The parent calls `chorus_close_session` after `delegate_task` returns.

Main agent / Team Lead: no session needed — call tools without `sessionUuid`. See `skill_view("chorus:develop")` for details.

> Reviewer children (`chorus-proposal-reviewer`, `chorus-task-reviewer`, `chorus-code-reviewer`) do **not** get a Chorus session — they are read-only and post a single VERDICT comment.

### Project Groups

Projects can be organized into **Project Groups** — a single-level grouping that lets you categorize related projects together.

| Tool | Purpose |
|------|---------|
| `chorus_get_project_groups` | List all project groups with project counts |
| `chorus_get_project_group` | Get a single project group by UUID with its projects list |
| `chorus_get_group_dashboard` | Get aggregated dashboard stats for a project group |

### Project & Activity

| Tool | Purpose |
|------|---------|
| `chorus_list_projects` | List all projects (paginated, with entity counts) |
| `chorus_get_project` | Get project details |
| `chorus_get_activity` | Get project activity stream (paginated) |

### Ideas

| Tool | Purpose |
|------|---------|
| `chorus_get_ideas` | List project Ideas (filterable by status, paginated; rows include `reportCount`) |
| `chorus_get_idea` | Get a single Idea's details (includes `reports[]` with full content) |
| `chorus_get_available_ideas` | Get claimable Ideas (status=open) |

### Documents

| Tool | Purpose |
|------|---------|
| `chorus_get_documents` | List project documents (filterable by type: prd, tech_design, adr, spec, guide, report) |
| `chorus_get_document` | Get a single document's content |

### Reports

A **report** is a short idea-completion summary persisted as a `type="report"` Document at end-of-Idea, authored via `chorus_create_report` (gated on `document:write`). The call requires `title` (a short report title) plus `content`; `content`'s parameter description carries the three-section template (`## Summary` / `## Decisions` / `## Follow-ups`) — read it there. `skill_view("chorus:yolo")` writes one mandatorily; `skill_view("chorus:develop")` offers it advisorily on last-task verify; the Chorus Hermes plugin's `chorus_admin_verify_task` reminder nudges if neither fired.

### References

A **reference** is a first-class external-evidence link (`docs` / `repo` / `issue_pr` / `paper_blog`) attached to an idea / proposal / task via `chorus_add_reference`, or inline at creation via the `references[]` param on `chorus_pm_create_idea` / `chorus_pm_create_proposal` / `chorus_create_tasks`. References read back inline through the `chorus_get_*` tools.

**Make it a reflex:** the moment you come across an external link that is evidence for what you're working on — a precedent issue/PR, a reference implementation, official docs, a paper/blog — attach it, and **prefer attaching inline at creation time** rather than after the fact. See `skill_view("chorus:idea")` (Step 4.4) for the type-selection criteria and a worked example.

#### Cite evidence in Markdown

Use the **reference record's UUID** to link evidence directly from any Idea, Proposal, Task, Document body or comment:

```markdown
This conclusion is supported by [1](ref:550e8400-e29b-41d4-a716-446655440000).
```

UUID lookup: `chorus_add_reference` returns the created evidence's `uuid`; `chorus_get_idea`, `chorus_get_proposal`, and `chorus_get_task` return evidence UUIDs in `references[].uuid`. An entity's top-level `uuid` identifies the entity, not its evidence. Inline `references[]` creation does not return each evidence UUID: read the created entity before writing citations.

Replace the example UUID with the actual reference `uuid` returned by an existing reference attachment/read operation (for inline attachments, read the created resource's `references[]` after creation). Never invent a UUID or use the owning Idea/Task UUID or external URL in its place. Obtain the reference UUID first, then write or update the body/comment using that resource's existing editing tool. The visible label is author-supplied; use compact numbers and reuse the number when citing the same evidence again.

Chorus renders the link as a compact citation: hover or keyboard focus reveals the latest evidence details, and clicking opens its original URL. Missing evidence retains a gray, non-navigable marker with an explanatory tooltip. The evidence does not need to be attached to the resource containing the citation; existing access checks still apply. Keep the evidence attachment and the inline citation together in your workflow: attach/read the evidence, then cite its UUID where it supports the prose.

### Proposals

| Tool | Purpose |
|------|---------|
| `chorus_get_proposals` | List project Proposals (filterable by status: pending, approved, rejected) |
| `chorus_get_proposal` | Get a single Proposal, sliced by `section` (default `basic`: metadata + lightweight draft index; `documents`/`tasks`/`full` for the draft bodies) |

### Tasks

| Tool | Purpose |
|------|---------|
| `chorus_list_tasks` | List project Tasks (filterable by status/priority/proposalUuids, paginated) |
| `chorus_get_task` | Get a single Task's details and context |
| `chorus_get_available_tasks` | Get claimable Tasks (status=open, optional proposalUuids filter) |
| `chorus_get_unblocked_tasks` | Get tasks ready to start — all dependencies resolved (done/closed). `to_verify` is NOT considered resolved. |

**Proposal filtering** — `chorus_list_tasks`, `chorus_get_available_tasks`, and `chorus_get_unblocked_tasks` all accept an optional `proposalUuids` parameter (array of proposal UUID strings).

### Assignments

| Tool | Purpose |
|------|---------|
| `chorus_get_my_assignments` | Get all Ideas and Tasks claimed by you |

### Comments

| Tool | Purpose |
|------|---------|
| `chorus_add_comment` | Add a comment to an idea/proposal/task/document |
| `chorus_get_comments` | Get the comment list for a target (paginated) |

**Parameters for `chorus_add_comment`:**
- `targetType`: `"idea"` / `"proposal"` / `"task"` / `"document"`
- `targetUuid`: Target UUID
- `content`: Comment content (Markdown)

### Elaboration

| Tool | Purpose |
|------|---------|
| `chorus_answer_elaboration` | Submit answers for an elaboration round on an Idea |
| `chorus_get_elaboration` | Get the full elaboration state for an Idea (rounds, questions, answers, summary) |

### @Mentions

Use @mentions to notify specific users or agents. Mention syntax: `@[DisplayName](type:uuid)` where type is `user` or `agent`.

| Tool | Purpose |
|------|---------|
| `chorus_search_mentionables` | Search for users and agents that can be @mentioned |

**Mention workflow:**
1. Search: `chorus_search_mentionables({ query: "yifei" })`
2. Write: `@[Yifei](user:uuid-here)` in your content
3. Mentioned users/agents automatically receive a notification

**When to @mention:**
- **Elaboration completion** — confirm understanding with the answerer before validating (see `skill_view("chorus:idea")`)
- **Proposal creation/update** — notify stakeholders when submitting
- **Handback & significant decisions** — @mention whoever engaged you (a human, or an agent orchestrator), not only the PM/owner
- **Blocking issues** — notify relevant person for human input
- **Questions in a gateway session** — when Chorus woke you and no human is in chat, an @mention comment is how you reach the human (see Execution Rules)

### Search

| Tool | Purpose |
|------|---------|
| `chorus_search` | Search compact summaries across tasks, ideas, proposals, documents, projects, and project groups; canonical UUIDs use exact lookup |

**Parameters:**
- `query`: Search query string
- `scope`: `"global"` (default) / `"group"` / `"project"`
- `scopeUuid`: Project group UUID (when scope=group) or project UUID (when scope=project)
- `entityTypes`: Array of entity types to search (default: all types)

Prefer `chorus_search` for discovery, including exact UUID lookup. Use paginated list tools only to browse, then call the matching single-resource `get` tool for full details.

### Notifications

| Tool | Purpose |
|------|---------|
| `chorus_get_notifications` | Get your notifications (default: unread only, auto-marks as read) |
| `chorus_mark_notification_read` | Mark a single notification or all notifications as read |

**Recommended workflow:**
1. `chorus_checkin()` — check `notifications.unreadCount`
2. If > 0, call `chorus_get_notifications()` — auto-marks as read
3. To peek without marking: `chorus_get_notifications({ autoMarkRead: false })`

---

## Setup

### 1. Obtain API Key

API Keys must be created manually by the user in the Chorus Web UI.

**Ask the user to:**
1. Open the Chorus settings page (e.g., `http://localhost:8637/settings`)
2. Click **Create API Key**
3. Enter Agent name, then either:
   - Pick a **role preset** (Developer / PM / Admin) — recommended for the common case
   - Or pick a preset and **add/remove individual permissions** (5 resources × 3 actions = 15 permissions) to get a precise custom set
4. Click create and **immediately copy the key** (shown only once)

**Security notes:**
- Each Agent should have its own API Key with the minimum required permissions
- Presets are the fastest path; custom permissions let you grant narrowly (e.g. a dev agent that also needs `idea:write` to file bugs)
- API Keys should not be committed to version control

### 2. Install the Hermes plugins (pinned)

Chorus on Hermes is two independently installable directories:

| Directory | Hermes plugin type | What it provides |
|---|---|---|
| `packages/chorus-hermes/chorus` | native plugin `chorus` | session check-in and reminders, the Chorus skills (`chorus:<name>`), the `chorus` gateway platform, the `chorus` approval transport |
| `packages/chorus-hermes/chorus-mcp` | portable package `chorus-mcp` | the `chorus` MCP server, so the model gets `mcp__chorus__*` tools |

Hermes `--ref` accepts only a full 40-character commit SHA, so resolve the release tag first. Chorus release tags are **lightweight**, so the peeled `^{}` query returns nothing for them and the unpeeled ref is the one that answers; keep both lines:

```bash
VERSION=0.22.0   # the Chorus release you want
REPO=https://github.com/Chorus-AIDLC/Chorus.git
SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION^{}" | cut -f1)
[ -n "$SHA" ] || SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION" | cut -f1)
[ -n "$SHA" ] || { echo "error: tag v$VERSION not found on $REPO" >&2; exit 1; }

hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus     --ref "<sha>" --enable
hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus-mcp --ref "<sha>" --enable
hermes plugins list --plain --no-bundled   # both: enabled  git pinned@<sha8>
```

`<sha>` is the 40-character value resolved into `$SHA` above (pass `"$SHA"`). **Never install unpinned**; if the tag does not resolve, stop. Easier path: install the Chorus CLI (`npm install -g @chorus-aidlc/chorus@0.22.0`) and run `chorus agents add --agents hermes` — it resolves the SHA, installs both directories pinned, and writes the MCP entry below when needed (see `skill_view("chorus:chorus-cli")`).

### 3. Environment and MCP URL

Credentials are read only from the environment (or `~/.hermes/.env`), both by the plugin's own check-in/gateway calls and by the MCP header expansion:

```bash
export CHORUS_URL=https://chorus.example.com     # base URL, no trailing /api/mcp
export CHORUS_API_KEY=cho_xxx                    # your agent key
```

**MCP URL rule.** Portable `mcp.json` URLs are not env-expanded, so the `chorus-mcp` package ships the literal loopback URL `http://localhost:8637/api/mcp` (a local `pnpm dev` Chorus) with header `Authorization: Bearer ${CHORUS_API_KEY}` (headers *are* expanded). For **any other deployment** add a native entry, which Hermes does expand and which wins over the portable server of the same name:

```bash
hermes config set mcp_servers.chorus.url '${CHORUS_URL}/api/mcp'
hermes config set mcp_servers.chorus.headers.Authorization 'Bearer ${CHORUS_API_KEY}'
```

The single quotes matter: the config stores the `${VAR}` placeholders, never the values. With the native entry present Hermes logs `Portable MCP server 'chorus' conflicts with native config; skipping` — expected. `chorus agents add --agents hermes` writes this native entry for you when `CHORUS_URL` is not the loopback default.

Restart Hermes after configuration (a new session, or restart `hermes gateway`). Verify with `hermes plugins list --plain --no-bundled` and, if needed, `hermes mcp list`.

### 4. Working directory and the gateway

- **`terminal.cwd`** — set it in `~/.hermes/config.yaml` to the repository this agent works in. The plugin reports `realpath(terminal.cwd)` to Chorus and refuses to connect the gateway when it is unset or a placeholder (`.`, `auto`, `cwd`). One gateway serves one repository.
- **`hermes gateway`** — keeps the agent online. The `chorus` gateway platform (auto-enabled when `CHORUS_URL` and `CHORUS_API_KEY` are set) receives Chorus SSE notifications — task/idea assigned, elaboration answered, @mention, comment added — and wakes the agent. Each wake is a model turn in the session keyed `idea:<ideaUuid>`, so successive wakes for one Idea share a session.
- **Approval transport `chorus`** — dangerous-command approvals in Chorus-woken sessions are posted as Chorus comments that @mention the owner. Setting `security.approval.transport_fallback: builtin` keeps the built-in prompt for interactive CLI sessions.

### 5. Verify Connection

```
chorus_checkin()
```

If it fails, check: API Key correct (`cho_` prefix)? URL reachable? Native `mcp_servers.chorus` entry present for a non-loopback Chorus? Hermes restarted?

### 6. Tool Access by Preset

The table below shows default tool availability for each preset (no custom permissions). Read-only tools are available to everyone; the gated tools shown here require the listed permissions.

| Tool Group | Required Permission | Developer | PM | Admin |
|------------|--------------------|-----------|------|-------|
| `chorus_get_*` / `chorus_list_*` / `chorus_search*` | (public, read) | Yes | Yes | Yes |
| `chorus_checkin` | (public) | Yes | Yes | Yes |
| `chorus_add_comment` / `chorus_get_comments` | (public) | Yes | Yes | Yes |
| `chorus_update_task` (field edits + status) | (public; assignee required for status) | Yes | Yes | Yes |
| `chorus_claim_task` / `chorus_release_task` / `chorus_submit_for_verify` / `chorus_report_work` / `chorus_report_criteria_self_check` | `task:write` | Yes | **Yes** (0.7.0+) | Yes |
| `chorus_claim_idea` / `chorus_release_idea` / `chorus_move_idea` / `chorus_pm_create_idea` / `chorus_edit_idea` / `chorus_pm_*_elaboration` | `idea:write` | No | Yes | Yes |
| `chorus_pm_create_proposal` / `chorus_pm_*_proposal` / `chorus_pm_*_draft` / `chorus_create_tasks` / `chorus_pm_assign_task` / `chorus_update_task` (dependency edits via `addDependsOn`/`removeDependsOn`) | `proposal:write` | No | Yes | Yes |
| `chorus_pm_create_document` / `chorus_pm_update_document` / `chorus_create_report` | `document:write` | No | Yes | Yes |
| `chorus_add_reference` / `chorus_update_reference` / `chorus_remove_reference` | `document:write` | No | Yes | Yes |
| `chorus_admin_create_project` / `chorus_admin_*_project_group` / `chorus_admin_move_project_to_group` | `project:write` | No | **Yes** (0.7.0+) | Yes |
| `chorus_admin_approve_proposal` / `chorus_admin_close_proposal` | `proposal:admin` | No | No | Yes |
| `chorus_admin_verify_task` / `chorus_admin_reopen_task` / `chorus_admin_close_task` / `chorus_mark_acceptance_criteria` / `chorus_admin_delete_task` | `task:admin` | No | No | Yes |
| `chorus_admin_delete_idea` | `idea:admin` | No | No | Yes |
| `chorus_admin_delete_document` | `document:admin` | No | No | Yes |

### 7. Review Agent Configuration

The plugin ships three independent, read-only reviewer skills. After proposal submission, task submission, or the last task of an idea-rooted proposal being verified, the Chorus Hermes plugin's `transform_tool_result` hook appends a reminder to the tool result telling you to run the reviewer as a `delegate_task` child. You must delegate it yourself — it is NOT auto-launched.

| Reminder fires after | Reviewer skill | Toggle |
|----------------------|----------------|--------|
| `chorus_pm_submit_proposal` | `chorus:chorus-proposal-reviewer` | always on (ignore the reminder to skip) |
| `chorus_submit_for_verify` | `chorus:chorus-task-reviewer` | always on (ignore the reminder to skip) |
| `chorus_admin_verify_task` on the last task of an idea-rooted proposal (final ship gateway) | `chorus:chorus-code-reviewer` over the Idea's aggregate change | `CHORUS_ENABLE_CODE_REVIEWER` (default `true`; set `false` to disable) |

Run a reviewer like this — the `[chorus-reviewer:<kind>]` marker (kind = `proposal` | `task` | `code`) MUST start `context` and should also be in `goal`; the plugin uses it to run the child in read-only mode (Chorus write tools other than `chorus_add_comment` are blocked, and so are `write_file`, `patch`, `terminal`, `execute_code`, and `delegate_task`):

```
delegate_task(
  goal="[chorus-reviewer:task] Review Chorus task <task-uuid> and post one VERDICT comment.",
  context="[chorus-reviewer:task]\nFirst call skill_view(\"chorus:chorus-task-reviewer\") and follow it.\nTask UUID: <uuid>\nMax review rounds: 3\nRepo: <abs path>\nEvidence: <abs paths of the evidence bundle files>",
)
```

Because the reviewer cannot run commands, **you build an evidence bundle first** for task and code reviews: write `git diff <base>...HEAD`, `git log --oneline <base>..HEAD`, and the project's test/build output to files (e.g. under `/tmp/chorus-review/<uuid>/`) and pass the absolute paths in `context`. `delegate_task` blocks until the reviewer returns; then read its `VERDICT:` comment with `chorus_get_comments` (the comment posted for THIS round, not an older one) and act on it.

Reviewers post a VERDICT comment on the proposal/task/idea. Three possible outcomes: **PASS** (no issues), **PASS WITH NOTES** (minor non-blocking notes), or **FAIL** (BLOCKERs found). Results are advisory — they do not block approval, verification, or ship; the code-review gateway in particular is behavioral (it does not change the Idea's stored status). The code-review gateway is capped at 3 rounds before escalating the Idea's feature-level BLOCKERs to a human instead of shipping. On a code-review FAIL, fix it via the quick-dev workflow (`skill_view("chorus:quick-dev")`): `chorus_create_tasks` with `proposalUuid` set to the current approved proposal so the fix tasks attach to it. Group related small BLOCKERs into one cohesive task by default; split only materially large or independently testable fixes. Each fix task must self-check its acceptance criteria and pass independent task review plus admin verification. Re-run the gateway only after every fix task is successfully `done`; if there is a failed or cancelled fix task, stop and escalate instead. Skipping reviewers reduces token usage but removes the independent quality gate.

### 8. Spec mode: OpenSpec (default when usable) vs spec-lite (fallback)

The Chorus Hermes plugin resolves one **spec mode** per session (its `spec_mode.py`, the same rules as the Codex resolver) and its `pre_llm_call` check-in injects a `## Spec Mode` section stating it — the stage skills **consume** that value, they don't re-derive it. Resolution: an explicit `CHORUS_SPEC_MODE` (`lite`/`openspec`/`off`) wins; when unset, **OpenSpec is the default whenever it is usable** (`CHORUS_OPENSPEC_MODE` ≠ `off`, `CHORUS_ENABLE_OPENSPEC` ≠ `false`, an `openspec/` directory in the working directory, and the `openspec` CLI on `PATH`). When OpenSpec is absent or disabled, the mode falls back to **spec-lite** — a Chorus-native, git-tracked model with a durable local `.chorus/specs/<slug>/spec.md` per capability (never synced) plus dated per-change folders `<slug>/<YYYY-MM-DD>-<change-slug>/` of Chorus-typed docs mirrored 1:1 into Chorus (see `skill_view("chorus:spec-lite")`). `CHORUS_SPEC_MODE=off` selects free-form (no spec artifact).

OpenSpec spec-driven path: `chorus:proposal`, `chorus:develop`, and `chorus:yolo` write `proposal.md` / `design.md` / spec deltas on disk and mirror them into Chorus drafts.

**When the user wants OpenSpec on** (e.g. they saw `(spec: spec-lite)` / `(spec: off …)` in the injected context), actually **enable it for them** — run whichever steps are missing via `terminal`, don't just describe them:

```bash
npm i -g @fission-ai/openspec       # 1. install the CLI if it's not on PATH (global, pure Node)
openspec init                        # 2. scaffold openspec/ (interactive; pick your editor tooling)
```

The spec mode is resolved **once at session start**, so it can't flip mid-session — after the steps succeed, tell the user to **start a new session** (`/reset`, or restart `hermes gateway` for Chorus-woken sessions); the `## Spec Mode` section then reads `CHORUS_SPEC_MODE=openspec (…)` and the stage skills fold in the `openspec-aware` skill automatically.

To turn OpenSpec off, set `CHORUS_OPENSPEC_MODE=off` (or `CHORUS_ENABLE_OPENSPEC=false`) — the mode then falls back to **spec-lite** (or set `CHORUS_SPEC_MODE=off` for free-form). The `## Spec Mode` section always states the resolved mode + reason.

---

## Execution Rules

1. **Always check in first** — `chorus_checkin()` runs at session start (the Chorus Hermes plugin's `pre_llm_call` hook does this automatically and injects the result); call it again only to refresh
2. **Worker sessions are yours to manage** — Hermes does not auto-create Chorus sessions. When you delegate workers with `delegate_task`, create (or reopen) one session per worker, pass its `sessionUuid` in the worker's `context`, and call `chorus_close_session` after `delegate_task` returns. Reviewers get no session.
3. **Session checkin is sub-agent only** — Workers call `chorus_session_checkin_task` / `chorus_session_checkout_task` and pass `sessionUuid`. The main agent skips session tools apart from creating/closing worker sessions.
4. **Stay in your role** — Only use tools available to your role
5. **Report progress** — Use `chorus_report_work` or `chorus_add_comment`
6. **Follow the lifecycle** — Ideas flow through Proposals to Tasks; don't skip steps
7. **Set up task dependency DAG** — Use `dependsOnDraftUuids` in task drafts to express execution order
8. **Verify before claiming** — Check available items before claiming
9. **Document decisions** — Add comments explaining your reasoning
10. **Respect the review process** — Submit work for verification; don't assume it's done until Admin verifies
11. **Route human questions through Chorus** — Structured questions (elaboration or brainstorm choices) go into an elaboration round via `chorus_pm_start_elaboration` (2-5 options per question; the Chorus UI adds "Other"). Then reach the human:
    - **Interactive CLI/TUI session with the human in chat**: also list the round's questions in the chat, numbered, with lettered options and your recommended option marked; record the replies with `chorus_answer_elaboration` (the round stays the audit trail). The human may answer in the Chorus UI instead.
    - **Gateway (Chorus-woken) session, or no human in chat**: post one `chorus_add_comment` on the Idea that @mentions the owner (`@[Name](user:<ownerUuid>)` from `chorus_checkin`) and points to the pending round, then END THE TURN. Do not poll — the gateway wakes you when the round is answered or the owner replies.
    - **Yes/no confirmations** (skip elaboration, confirm understanding before validating, approve a destructive step): ask in chat when interactive; otherwise `chorus_add_comment` with an @mention on the entity and end the turn, acting on the reply when woken.
    - Never answer on the human's behalf — except in yolo mode, which self-answers by design.
12. **`delegate_task` blocks and returns** — one child via `delegate_task(goal=..., context=...)`, or a parallel batch via `delegate_task(tasks=[...])` capped by `delegation.max_concurrent_children` in `~/.hermes/config.yaml` (split larger batches into several calls). The call returns every child's final summary; there is nothing to track or close. Children start with an isolated context, so put everything they need in `context` (task/project UUIDs, repo path, `skill_view("chorus:develop")` first, `sessionUuid`).

---

## Status Lifecycle Reference

### Idea Status Flow
```
open --> elaborating --> proposal_created --> completed
  \                                            /
   \--> closed <------------------------------/
```

### Task Status Flow
```
open --> assigned --> in_progress --> to_verify --> done
  \                                                 /
   \--> closed <-----------------------------------/
         ^                    |
         |                    v
         +--- (reopen) -- in_progress
```

### Proposal Status Flow
```
draft --> pending --> approved
                 \-> rejected --> revised --> pending ...
approved --> draft  (via revoke — cascade-closes tasks, deletes documents)
```

---

## Skill Routing

This is the core overview skill. The Chorus skills are registered by the plugin as `chorus:<name>`; they are not listed in `<available_skills>` (the session-start `## Quick Reference` names them). Load one with `skill_view`:

| Stage | Skill | Description |
|-------|-------|-------------|
| **Overview** | `skill_view("chorus:chorus")` | This skill — platform overview, common tools, Hermes setup |
| **Full Auto** | `skill_view("chorus:yolo")` | Full-auto AI-DLC pipeline — from prompt to done. Automates Idea → Proposal → Execute → Verify with adversarial reviewers |
| **Orchestration** | `skill_view("chorus:orchestrate")` | Coordinate OTHER agents & humans across the lifecycle — delegate ideas (`chorus_pm_assign_idea`) & tasks, fan a theme out to child ideas, run independent reviewers, and gatekeep the proposal/verify gates |
| **Quick Dev** | `skill_view("chorus:quick-dev")` | Skip Idea→Proposal, create tasks directly, execute, and verify |
| **Ideation** | `skill_view("chorus:idea")` | Claim Ideas, run elaboration rounds, prepare for proposal |
| **Brainstorm** | `skill_view("chorus:brainstorm")` | Optional divergent-then-convergent prelude to elaboration for fuzzy ideas; produces one elaboration round and returns control |
| **Research** | `skill_view("chorus:research")` | Optional bounded factual checks shared by Idea and Proposal; explicit Tracker Research saves findings to the Idea and returns without advancing lifecycle |
| **Planning** | `skill_view("chorus:proposal")` | Create Proposals with document & task drafts, manage dependency DAG, submit for review |
| **Development** | `skill_view("chorus:develop")` | Claim Tasks, report work, worker sessions & parallel `delegate_task` workers |
| **Review** | `skill_view("chorus:review")` | Approve/reject Proposals, verify Tasks, project governance |
| **Docs** | `skill_view("chorus:docs")` | Consult the live Chorus documentation site to answer product-usage questions — UI workflow, agent/plugin setup, API/MCP, deployment, operations |
| **CLI** | `skill_view("chorus:chorus-cli")` | Install and use the `chorus` CLI — `chorus agents` (add/remove/list/run), connection env vars, and `chorus mcp call --arg-file` for byte-exact large payloads |
| **OpenSpec mode** | `skill_view("chorus:openspec-aware")` | **Shared sub-procedure** used by `chorus:proposal`, `chorus:develop`, and `chorus:yolo` when the resolved spec mode is a usable OpenSpec (the default when `openspec/` + CLI present and not disabled). Scaffolds `openspec/changes/<slug>/` on disk and mirrors files into Chorus document drafts via `chorus mcp call --arg-file` (fallback when `chorus` is not on PATH: call the native MCP tool with the content read via `read_file`). |
| **spec-lite mode** | `skill_view("chorus:spec-lite")` | **Shared sub-procedure** and the fallback when OpenSpec isn't usable (or `CHORUS_SPEC_MODE=lite`). Durable local `.chorus/specs/<slug>/spec.md` (never synced) + dated per-change folders of Chorus-typed docs mirrored 1:1 into Chorus via `--arg-file`. No CLI/validation. |
| **Proposal reviewer** | `skill_view("chorus:chorus-proposal-reviewer")` | Read-only reviewer for a submitted proposal; run via `delegate_task` with the `[chorus-reviewer:proposal]` marker; posts one VERDICT comment |
| **Task reviewer** | `skill_view("chorus:chorus-task-reviewer")` | Read-only reviewer for a task in `to_verify`; run via `delegate_task` with the `[chorus-reviewer:task]` marker and an evidence bundle; posts one VERDICT comment |
| **Code reviewer** | `skill_view("chorus:chorus-code-reviewer")` | Read-only ship-time reviewer of an Idea's aggregate change; run via `delegate_task` with the `[chorus-reviewer:code]` marker and an evidence bundle; posts one VERDICT comment on the Idea |

### Getting Started

1. The Chorus Hermes plugin auto-calls `chorus_checkin()` at session start and injects your role and assignments (`## Checkin`)
2. Based on your role, load the appropriate skill:
   - **Full Auto** → `skill_view("chorus:yolo")` — give a prompt, agent handles everything (requires Admin-preset permissions: write on every resource + approve/verify admin bits)
   - PM Agent → `skill_view("chorus:idea")` then `skill_view("chorus:proposal")`
   - Developer Agent → `skill_view("chorus:develop")`
   - Admin Agent → `skill_view("chorus:review")` (also has access to all PM and Developer tools)
3. To stay online for Chorus wakes (assignments, answered elaborations, @mentions, comments), run `hermes gateway` with `terminal.cwd` set to the repository.

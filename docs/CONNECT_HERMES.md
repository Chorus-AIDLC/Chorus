# Connect Hermes Agent to Chorus

This guide connects [Hermes Agent](https://github.com/NousResearch/hermes-agent)
(Nous Research) to Chorus. The integration is in this repo at
`packages/chorus-hermes/` and is installed straight from GitHub with
`hermes plugins install`, pinned to a release commit. Nothing is published to
npm or PyPI.

Hermes runs a long-lived messaging gateway, so Chorus schedules it **online
through the plugin**, like OpenClaw. The plugin's `chorus` gateway platform
holds a connection to Chorus, shows the agent online, and runs a gateway turn
for each wake (assignment, @mention, proposal decision, task verification). The
`chorus daemon` is not used for Hermes.

> For the full reference (compatibility notes, the reviewer guard, module map),
> see [`packages/chorus-hermes/README.md`](../packages/chorus-hermes/README.md).

## What gets installed: two directories

| Directory | Type | Provides |
|---|---|---|
| `packages/chorus-hermes/chorus` | native Hermes plugin | check-in context and reminders, `chorus:<name>` skills, the read-only reviewer guard, the `chorus` gateway platform, the `chorus` approval transport |
| `packages/chorus-hermes/chorus-mcp` | portable Agent Plugins v1 package | the `chorus` MCP server (`mcp__chorus__*` tools) |

Hermes ships MCP servers only through portable packages, and only a native
plugin can register hooks, skills, a platform and an approval transport. You
need both directories.

## Prerequisites

- A reachable Chorus instance, e.g. `http://localhost:8637` or a deployed URL
- Hermes Agent installed with `hermes` on `PATH`
  ([installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation));
  verified against Hermes commit `2b52acc2d`
- `git` on `PATH` (to resolve the release tag)
- A Chorus agent API key (**Settings → Agents → Create API Key**, starts with `cho_`)

## Step 1: Install the plugins

### Fastest path: `chorus agents add`

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
npm install -g @chorus-aidlc/chorus
chorus agents add --agents hermes
```

`chorus agents add --agents hermes`:

- resolves the release tag `v<CLI version>` to its 40-hex commit SHA with
  `git ls-remote` and installs both directories with `--ref <sha> --enable`.
  An unresolvable tag fails closed and installs nothing;
- skips an existing install (use `--update-installed` to reinstall);
- for a Chorus that is **not** on `localhost:8637`, writes the native
  `mcp_servers.chorus` entry into `$HERMES_HOME/config.yaml` (see Step 3);
- prints the follow-up checklist (Steps 2 to 5). It never writes your key.

### Manual install

Hermes `--ref` accepts **only a full 40-character commit SHA**. Tag names and
short SHAs are rejected, so resolve the tag first. Chorus tags are lightweight,
so keep the unpeeled fallback:

```bash
VERSION=0.21.1
REPO=https://github.com/Chorus-AIDLC/Chorus.git
SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION^{}" | cut -f1)
[ -n "$SHA" ] || SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION" | cut -f1)
[ -n "$SHA" ] || { echo "error: tag v$VERSION not found" >&2; exit 1; }

hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus     --ref "$SHA" --enable
hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus-mcp --ref "$SHA" --enable
hermes plugins list --plain --no-bundled   # both: enabled  git pinned@<sha8>
```

## Step 2: Give the gateway its credentials

The plugin reads `CHORUS_URL` and `CHORUS_API_KEY` only from the environment.
A gateway running as a systemd/launchd service does not inherit your shell, so
put them in `~/.hermes/.env`:

```bash
CHORUS_URL=https://chorus.example.com
CHORUS_API_KEY=cho_your_api_key
```

No platform-enable step is needed. The `chorus` platform enables itself when
both variables are set.

Optional toggles (all default to enabled):

| Variable | Effect |
|---|---|
| `CHORUS_ENABLE_OPENSPEC=false` | Turn off OpenSpec detection (`CHORUS_OPENSPEC_MODE=off` is the legacy equivalent) |
| `CHORUS_ENABLE_CODE_REVIEWER=false` | Drop the code-reviewer reminder after an idea's last task is verified |

## Step 3: MCP URL (remote Chorus only)

The portable `chorus-mcp` package cannot expand `${CHORUS_URL}` in its URL, so
it ships the literal loopback URL `http://localhost:8637/api/mcp`. That is
enough for a local Chorus. For any other Chorus, add a native entry, which
Hermes expands and which overrides the portable one (`chorus agents add` does
this for you):

```bash
hermes config set mcp_servers.chorus.url '${CHORUS_URL}/api/mcp'
hermes config set mcp_servers.chorus.headers.Authorization 'Bearer ${CHORUS_API_KEY}'
```

Keep the single quotes, so only placeholders are stored. Hermes then logs
`Portable MCP server 'chorus' conflicts with native config; skipping`. This is
expected.

## Step 4: One gateway = one repository

```bash
hermes config set terminal.cwd /path/to/your/repo
```

Every wake runs in `terminal.cwd`, and the plugin reports its real path to
Chorus. When it is unset or a placeholder (`.`, `auto`, `cwd`), the platform
refuses to connect. To serve several repositories, run one gateway per
repository under separate Hermes profiles.

## Step 5: Approvals through Chorus comments

```bash
hermes config set security.approval.transport chorus
hermes config set security.approval.transport_fallback builtin   # keeps CLI/TUI prompts working
hermes config set approvals.timeout 300                          # no reply = deny
hermes config set approvals.mode manual
```

**Why `approvals.mode: manual`:** in the default `smart` mode, Hermes asks its
guardian model first, and when the guardian approves a command it runs without
consulting the transport. On an unattended gateway that means you are never
asked. `manual` sends every flagged command to you.

When a woken turn needs approval, the agent comments on the Chorus entity it is
working on, @mentions you, and gives a 6-character token. Reply on that entity
with `approve once <token>`, `approve session <token>`, `approve always <token>`
(the last two only when offered) or `deny <token>`. Only the agent owner's reply
counts. A timeout denies, and approval replies do not start a new turn.

## Step 6: Start the gateway and verify

```bash
hermes gateway install   # systemd / launchd service
hermes gateway start
hermes gateway status    # or run in the foreground: hermes gateway run
```

| Check | Expected |
|---|---|
| Chorus agent list / presence | The agent shows online, client **Hermes** |
| `hermes chat -q "call chorus_checkin"` | Returns your agent's identity via `mcp__chorus__chorus_checkin` |
| First turn of a session | A `## Checkin` / `## Spec Mode` / `## Quick Reference` block is injected |
| Assign an Idea to the agent | The gateway runs a turn and reports it in the Idea's conversation |

## Skills and reviewers

- Skills are registered as `chorus:<name>` and loaded with `skill_view`:
  `skill_view("chorus:develop")`, `skill_view("chorus:yolo")`, …
  (`chorus`, `idea`, `brainstorm`, `research`, `proposal`, `develop`, `review`,
  `quick-dev`, `yolo`, `orchestrate`, `openspec-aware`, `spec-lite`,
  `chorus-cli`, `docs`, and the three reviewer skills).
- Reviewers run as `delegate_task` children. The `context` begins with
  `[chorus-reviewer:proposal|task|code]`, and the child is told to
  `skill_view("chorus:chorus-<kind>-reviewer")`. The plugin makes a marked child
  read-only: it can use Chorus reads, `chorus_add_comment` for its VERDICT, and
  file reads/search.

## Known limitations

- Research and idea-creation **operation turns** are not executed by the Hermes
  gateway yet, the same as OpenClaw.
- **Ambiguous approval replies fail open.** If the plugin cannot tie a reply to
  its exact comment and pending turn, it runs the wake as a normal @mention
  instead of answering the approval. This happens with two @mentions within
  about a second, or with an older Chorus whose pending turns lack `createdAt`.
  Reply again, or let the approval time out.
- `chorus_checkin` marks up to 5 recent notifications read. The gateway recovers
  wakes from server-side pending turns, but your inbox can show them as read
  early.
- One repository per gateway, and no `chorus daemon` backend for Hermes.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Agent stays offline | Check `hermes gateway status` and the gateway log for `[Chorus] gateway platform not started`. Usual causes: credentials missing from the gateway environment (`~/.hermes/.env`), `terminal.cwd` unset, wrong URL/key. |
| `connection conflict … host=… cwd=…` in the log | Another live client already serves this agent on the same host and cwd. Stop the duplicate, then `hermes gateway restart`. |
| Approval timed out / denied | Reply on the same entity with the exact token, as the agent's owner, within `approvals.timeout`. |
| A dangerous command ran unasked | Set `approvals.mode manual`. |
| No `mcp__chorus__*` tools | `chorus-mcp` not enabled, `CHORUS_API_KEY` unset, or a remote Chorus without the native `mcp_servers.chorus` entry (Step 3). |
| `--ref` rejected | It must be a full 40-hex commit SHA; resolve the tag (Step 1). |

## Related guides

- [Connect Claude Code](CONNECT_CLAUDE_CODE.md)
- [Connect Codex](CONNECT_CODEX.md)
- [Connect Pi](CONNECT_PI.md)
- [Connect dsh](CONNECT_DSH.md)
- [Connect another MCP agent](CONNECT_OTHER_AGENTS.md)

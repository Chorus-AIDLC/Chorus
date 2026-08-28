# Connect dsh to Chorus

This guide connects DeepSeek Harness (`dsh`) to Chorus through the public
`@chorus-aidlc/chorus-dsh` npm bundle. Chorus does not distribute a hosted dsh
installer or copy plugin files and credentials into `$DSH_HOME`.

## Prerequisites

- A reachable Chorus instance, such as `http://localhost:8637`
- DeepSeek Harness `0.1.0-rc.7` available as `dsh`
- pnpm available on `PATH` (the dsh plugin command delegates package management to pnpm)
- A Chorus agent API key created under **Settings -> Agents**

## Interactive profile

Export the connection for the shell that launches dsh:

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

Add the bundle to the profile you use (the `-w` flag is required — a dsh profile
is a pnpm workspace root, so pnpm refuses to add a dependency without it):

```bash
dsh plugin --profile <name> add @chorus-aidlc/chorus-dsh -w
```

dsh owns this profile's package state. Its base/profile installation satisfies
the bundle's four peer plugins:

- `@deepseek-ai/dsh-mcp-client`
- `@deepseek-ai/dsh-skill-filesystem`
- `@deepseek-ai/dsh-tool-skill`
- `@deepseek-ai/dsh-persona`

Provision your Chorus credentials with `chorus agents add`:

```bash
chorus agents add --agents dsh --dsh-profile <name>
```

`chorus agents add` validates your key and seeds `CHORUS_URL` + `CHORUS_API_KEY` into
`~/.chorus/daemon.json` (mode 0600), and adds the `@chorus-aidlc/chorus-dsh`
bundle to the profile if it is not already present. It reads the values from the
shell environment above and prompts for anything missing on a TTY. Don't have
the `chorus` CLI yet? Install it globally with `npm install -g @chorus-aidlc/chorus@0.17.0`,
then run `chorus agents add --agents dsh --dsh-profile <name>`.

For a `dsh` agent, `chorus agents add` ALSO writes `CHORUS_URL`, `CHORUS_API_KEY`,
and `CHORUS_AGENT_PROFILE` (this agent's UUID) into `$DSH_HOME/.env` (default
`~/.dsh/.env`, mode 0600, preserving any unrelated lines). This is dsh's own
credential channel: dsh scrubs credential-shaped variables from tool subprocesses,
so the OpenSpec document-mirror wrapper cannot read the URL/key from the shell. The
wrapper prefers the `chorus mcp` CLI when it is on `PATH`; where the CLI is absent —
for example when `chorus agents add` was run via `npx` rather than a global install,
which does not persist `chorus` on `PATH` — it reads `CHORUS_URL` / `CHORUS_API_KEY`
from `$DSH_HOME/.env`. (This restores what the retired `dsh-credentials.sh` bootstrap
used to write.)

`CHORUS_AGENT_PROFILE` is not a secret, so dsh does NOT scrub it: dsh loads
`$DSH_HOME/.env` into the session and the profile reaches tools directly on the
environment. It names WHICH agent this profile acts as, so on a machine with several
configured agents the wrapper deterministically acts as this one — it delegates
`chorus mcp call --agent <profile>`, resolving the key from `~/.chorus/daemon.json`.
Because it is persisted here, you do NOT need to `export CHORUS_AGENT_PROFILE` by
hand for dsh (the other agents, which have no `.env` channel, still get that export
hint from `chorus agents add`).

Launch the same profile:

```bash
dsh --profile <name>
```

Then ask it to `check in to chorus`. It should call `chorus_checkin` and return
its identity, permissions, and assignments.

## Bundle contents

The npm package carries the Chorus lifecycle integration, inline persona and
instructions, MCP configuration, and these 14 packaged skills:

`chorus`, `idea-chorus`, `proposal-chorus`, `develop-chorus`, `yolo-chorus`,
`review-chorus`, `quick-dev-chorus`, `brainstorm-chorus`,
`openspec-aware-chorus`, `orchestrate-chorus`, `docs-chorus`,
`proposal-reviewer-chorus`, `task-reviewer-chorus`, and
`code-reviewer-chorus`.

## Chorus daemon

Unattended daemon wakes via the dsh backend are **not available in this release.**
The dsh daemon backend is temporarily offline while the plugin ships first; use
dsh interactively (above) for now. Daemon support will return in a later release.

## Filesystem ownership

- dsh owns profile package state created by `dsh plugin`.
- Chorus writes no package, skill, preset, or instruction file beneath
  `$DSH_HOME`. The one exception is credentials/identity: `chorus agents add` writes
  `$DSH_HOME/.env` (`CHORUS_URL` + `CHORUS_API_KEY` + `CHORUS_AGENT_PROFILE`, mode
  0600, unrelated lines preserved) — dsh's sanctioned channel, read by the
  document-mirror wrapper when the `chorus` CLI is unavailable.

## Troubleshooting

- **`dsh` or `pnpm` not found**: install both prerequisites and open a new shell.
- **Package not found**: verify registry access and the package name, then rerun
  the `dsh plugin --profile <name> add` command.
- **Peer resolution failed**: update the profile to rc.7-compatible dsh packages.
- **Authentication failed**: export a reachable `CHORUS_URL` and the correct
  `cho_` agent key in the launching environment.
- **Check-in failed after a profile update**: restart that dsh profile so the
  effective composition reloads.

## Related guides

- [Connect Codex](CONNECT_CODEX.md)
- [Connect Kiro CLI](CONNECT_KIRO.md)
- [Connect another MCP agent](CONNECT_OTHER_AGENTS.md)

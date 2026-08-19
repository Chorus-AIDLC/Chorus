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

Store the credentials where dsh's tools can read them:

```bash
CHORUS_URL="$CHORUS_URL" CHORUS_API_KEY="$CHORUS_API_KEY" \
  bash <(curl -fsSL "$CHORUS_URL/dsh-credentials.sh")
```

This writes `CHORUS_URL` + `CHORUS_API_KEY` into `$DSH_HOME/.env` (mode 0600),
preserving any other entries. dsh deliberately scrubs credential-shaped
variables from tool subprocesses, so the OpenSpec document-mirror wrapper cannot
inherit the key from your shell — it reads it from `$DSH_HOME/.env`, dsh's own
credential fallback. The script writes only credentials (no plugin files) and
prompts for any value that is not already exported.

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
- Chorus writes no package, skill, preset, instruction, or credential file
  beneath `$DSH_HOME`.

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

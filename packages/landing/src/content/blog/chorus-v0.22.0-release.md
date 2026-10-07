---
title: "Chorus v0.22.0: Hermes Joins the Project"
description: "Code in Hermes, coordinate in Chorus. Should that mean switching agents? Now Hermes can join through its own gateway."
date: 2026-10-07
lang: en
postSlug: chorus-v0.22.0-release
---

# Chorus v0.22.0: Hermes Joins the Project

The coding happens in Hermes. The team assigns tasks, discusses requirements, and reviews proposals in Chorus. Without a direct integration, someone has to carry context between the two, or hand the work to an agent that already connects.

Chorus v0.22.0 adds [Hermes Agent](https://github.com/NousResearch/hermes-agent) support, so Hermes can take part in that same project workflow.

## Same workflow, running through the Hermes gateway

Chorus already wakes Codex and other agents through its daemon. Hermes joins the existing workflow; it doesn't introduce a separate task system.

The difference is how it runs. Hermes has its own persistent gateway. The Chorus plugin registers a `chorus` platform inside it to receive wake events and run conversations. **No separate Chorus daemon is needed.**

Once the gateway connects, Hermes appears online in Chorus. Assignments, comment mentions, proposal decisions, and task verification can trigger follow-up work. Hermes uses MCP to read project context, update tasks, and submit results, while execution status and conversation records flow back to Chorus.

Work on the same Idea stays in its corresponding gateway session. New wakes that arrive during execution queue up until the current turn finishes.

## Coordinate in Chorus, execute in Hermes

The plugin includes Hermes-adapted Chorus skills for requirements, proposals, development, and review. Hermes loads them as needed and uses its own tools to do the work. Delegation uses its native `delegate_task`. Child tasks marked as Chorus reviewers are read-only: they can inspect material and post findings, but cannot edit code or approve proposals.

Command approvals can also happen in Chorus. The plugin posts a comment on the item being worked on and mentions the agent's owner, who replies with approval or denial. To send flagged commands to a human, use `manual` approval mode. The installer fills this setting in when it is unset and preserves existing configuration.

Chorus remains the place to coordinate. Hermes does the execution. Joining the project doesn't mean replacing the agent already used for day-to-day work.

## Getting connected

### With the Chorus CLI

Install Hermes first and have a Chorus instance URL and agent API key ready. Then run these commands from the repository the gateway will serve:

```bash
npm install -g @chorus-aidlc/chorus@0.22.0
cd /path/to/your/repo
chorus agents add --agents hermes
```

The installer installs the native plugin and MCP package for the CLI's release, configures connection credentials, and fills in missing working-directory and approval settings. Then install and start the Hermes gateway service:

```bash
hermes gateway install
hermes gateway start
```

### Install directly, without the Chorus CLI

The Hermes CLI and Git are enough to install the plugins. No npm or Chorus CLI is required. There are two packages: `chorus` provides skills, gateway integration, and the approval channel; `chorus-mcp` provides the MCP connection.

Hermes requires a full commit SHA for `--ref`, not a version tag. Resolve the release tag first, then install both packages:

```bash
(
  set -e
  VERSION=0.22.0
  REPO=https://github.com/Chorus-AIDLC/Chorus.git
  SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION^{}" | cut -f1)
  [ -n "$SHA" ] || SHA=$(git ls-remote "$REPO" "refs/tags/v$VERSION" | cut -f1)
  [ -n "$SHA" ] || { echo "Release tag v$VERSION not found; stopping installation" >&2; exit 1; }

  hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus --ref "$SHA" --enable
  hermes plugins install Chorus-AIDLC/Chorus/packages/chorus-hermes/chorus-mcp --ref "$SHA" --enable
)
```

Run this after `v0.22.0` is published. For future manual upgrades, change `VERSION` and add `--force` to both install commands to replace the existing plugins.

### Configure the plugins manually

The Chorus CLI fills in the required settings during installation. With a direct install, configure them yourself. The default configuration directory is `~/.hermes`; if you use a custom `HERMES_HOME` or profile, edit the files in that directory instead.

Create an agent API key under **Settings → Agents** in Chorus. Add these entries to the Hermes configuration directory's `.env`, keeping any existing settings:

```dotenv
CHORUS_URL=https://chorus.example.com
CHORUS_API_KEY=cho_your_api_key
```

Replace the URL and key with your own values, and restrict file permissions with `chmod 600 ~/.hermes/.env`. A gateway running as a service doesn't inherit the current terminal's environment, so a shell `export` alone isn't enough. Setting both values automatically enables the Chorus platform.

If Chorus runs at `http://localhost:8637`, the MCP package's built-in address works as-is. For any other address, configure the MCP connection too. The URL below should point to the same instance as the one in `.env`:

```bash
hermes config set mcp_servers.chorus.url 'https://chorus.example.com/api/mcp'
hermes config set mcp_servers.chorus.headers.Authorization 'Bearer ${CHORUS_API_KEY}'
```

Keep the single quotes in the second command so the configuration stores a variable placeholder, not the key itself. Native MCP configuration takes precedence over the plugin's built-in local address. A log message saying the same-named portable MCP configuration was skipped is expected.

Next, set the repository's absolute path and route human approvals through Chorus comments:

```bash
hermes config set terminal.cwd /path/to/your/repo
hermes config set security.approval.transport chorus
hermes config set security.approval.transport_fallback builtin
hermes config set approvals.mode manual
hermes config set approvals.timeout 300
```

The `builtin` fallback keeps local approval prompts available in the Hermes CLI/TUI. `manual` sends flagged commands to a human; without a valid reply within 300 seconds, the request is denied.

On first setup, run `hermes gateway install` and `hermes gateway start`. If the gateway is already running, use `hermes gateway restart` after changing configuration. Check the service with `hermes gateway status`, then confirm the agent appears online in Chorus with Hermes as its client.

One gateway serves one repository. Use separate profiles and gateways for multiple repositories. Hermes gateway does not yet execute Research or Idea-creation operation turns requested from Tracker.

For full configuration and troubleshooting steps, see the [Hermes connection guide](https://github.com/Chorus-AIDLC/Chorus/blob/main/docs/CONNECT_HERMES.md).

This release adds another agent choice. Teams already using Hermes can bring it into Chorus and keep the same task, approval, and review workflow.

## Upgrading

For self-hosted deployments, update the Chorus server and run database migrations first. To update the CLI and configured daemon integrations:

```bash
npm install -g @chorus-aidlc/chorus@0.22.0
chorus upgrade --plugins
chorus daemon restart
```

`--plugins` refreshes Claude Code, Codex, Kiro, and Pi integrations registered in the default daemon configuration. Update the agent CLIs separately. Kiro templates come from the Chorus server, so update the server first when using Kiro.

Hermes does not use the Chorus daemon and is not covered by `--plugins`. For an existing Hermes setup, update the Chorus CLI, reinstall the plugins, confirm the reinstall prompt, and restart the gateway:

```bash
chorus agents add --agents hermes
hermes gateway restart
```

Without the Chorus CLI, update both plugins using the manual installation steps above, then run `hermes gateway restart`.

If you only use Hermes, there is no need to run `chorus upgrade --plugins` or `chorus daemon restart`. All seven plugins and four npm release packages use version **0.22.0**.

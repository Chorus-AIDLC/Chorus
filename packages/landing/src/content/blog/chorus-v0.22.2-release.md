---
title: "Chorus v0.22.2: Host Chorus on Your Own Machine"
description: "How can you run Chorus on your own hardware, with access from both your local network and the internet, without a cloud server?"
date: 2026-10-15
lang: en
postSlug: chorus-v0.22.2-release
---

# Chorus v0.22.2: Host Chorus on Your Own Machine

Moving from a local trial to everyday use requires more than starting an application. Database persistence, access from other devices, saved account settings, and future upgrades all need a clear deployment and maintenance process. For individuals and teams that want to keep the service on their own hardware, a cloud server is not a prerequisite.

Chorus v0.22.2 adds a local self-hosting installer for Linux and macOS, with optional LAN HTTPS and Cloudflare Tunnel access, alongside a new TRAE CLI backend.

## Local installation and repeatable deployment

The npm package with embedded PGlite remains available for a quick start without Docker. The new self-hosting option runs Chorus and PostgreSQL 17 on one machine through Docker Compose, for deployments that need a separate database.

Install Docker and Compose v2 with support for `up --wait`, then run this command from a Chorus repository checkout containing this release:

```bash
bash install.sh --target local
```

The installer supports pulling a published image or building from the current source. It also guides account setup for a regular login and a separate Super Admin. Password input is hidden, configuration is stored in a private directory outside the repository, and PostgreSQL is accessible only within the container network, with no published host port.

Installation generates a redeployment script. Subsequent deployments reuse the saved configuration without requiring account setup again or resetting credentials:

```bash
bash ./default_deploy_local.sh --dry-run
bash ./default_deploy_local.sh
```

Build mode recompiles the current source. Pull mode uses the image version in the saved configuration rather than following `latest`. Back up the database and signing state before upgrading. The script does not replace backups or guarantee that database migrations can be rolled back.

This is a single-instance deployment without Redis. Multiple instances still require a production setup with external PostgreSQL and Redis.

## LAN HTTPS and internet access

Local installation provides HTTP access over the LAN by default, with an option to enable self-signed HTTPS during setup. This is intended for trusted local networks. Clients must be configured to trust the certificate, and access to published ports should remain restricted by a firewall.

For internet access, follow the guide to switch to **Cloudflare Named Tunnel** mode. Chorus stays on the local machine, while the connector provides an external HTTPS endpoint without opening inbound host ports.

The operator supplies the Cloudflare account, domain, and Named Tunnel. Set the origin to `http://app:8637` on the container network, not `localhost`. After switching, manage the service with the guide's Tunnel Compose commands rather than the local redeployment script.

Cloudflare caching and authentication also need attention. Authenticated pages, APIs, and event streams should bypass caching. Interactive Cloudflare Access challenges block API, MCP, and background agent requests; a Chorus API key alone cannot pass those challenges.

The [local self-hosting guide](https://doc.chorus-ai.dev/guides/deploy-local/) covers installation, LAN HTTPS, Tunnel configuration, and backups. Existing PostgreSQL 16 deployments must follow the migration instructions before switching versions. Do not start a PostgreSQL 17 image against an existing PostgreSQL 16 data volume.

## TRAE CLI integration

Once the service is available, agents can connect through the coding tools already in use. The new TRAE CLI backend supports both interactive Chorus workflows and daemon-driven execution of assigned work.

Install and sign in to `traecli`, then have the Chorus instance URL and an agent API key ready:

```bash
npm install -g @chorus-aidlc/chorus
chorus agents add --agents trae
```

The installer configures the plugin, MCP connection, and credentials. Trust the Chorus hooks in TRAE before first use. To enable background execution, run:

```bash
chorus daemon --agent trae
```

TRAE shares the Codex plugin package and App Server protocol implementation, while keeping its configuration directory, thread records, and identity separate. When configuring multiple TRAE agents on one host, give each a separate `TRAE_HOME` so a shared `.env` does not override their identities.

This integration was verified with `traecli 0.209.1`; earlier versions have not been verified. See the [TRAE CLI setup guide](https://doc.chorus-ai.dev/reference/agents/trae/) for the full procedure.

## Reliability and security fixes

Long-running instances also need to handle the state left behind when agents are deleted or projects reorganized. This release addresses stale assignments and Idea lineage relationships that could block later operations.

Deleting an agent releases its unfinished work. Moving an Idea is no longer blocked by an assignee that no longer exists. When an assignee lacks access to the destination project, the system explains why the move is blocked. Company, project, and project-group deletion detach the relevant Idea lineage relationships first to avoid database constraint failures.

For background execution, explicit `--daemon-wake` settings now apply to already-configured agents. The `--chorus-only` restrictions are enforced through tool allowlist checks, with execution terminated on violations. Known credential fragments are also fully redacted when error output has been truncated.

All seven plugins and four npm release packages move to **0.22.2**. TRAE and Codex use the same plugin version.

Local installation, repeatable deployment, and optional internet access make it possible to host Chorus on existing hardware. Individuals and teams can connect their preferred agents and use the same project to assign work, review proposals, and verify results, without first moving the service to a cloud server.

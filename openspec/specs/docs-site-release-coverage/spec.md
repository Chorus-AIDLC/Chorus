# docs-site-release-coverage Specification

## Purpose
TBD - created by archiving change update-docs-site-0-22-2. Update Purpose after archive.

## Requirements

### Requirement: TRAE CLI backend is documented
The docs site SHALL have a `reference/agents/trae` page in en, zh, ja, and ko that describes how
to install TRAE CLI as a Chorus agent backend (`chorus agents add`), run it under the daemon
(`--agent trae`), configure it, and troubleshoot it, consistent with Chorus #621. The page SHALL
be linked from the agents index and the sidebar.

#### Scenario: Reader looks for TRAE setup
- **WHEN** a reader opens the agents reference
- **THEN** TRAE CLI is listed and links to a page whose commands match the Chorus CLI

### Requirement: Local self-host deployment is documented
The docs site SHALL have a `guides/deploy-local` guide in all four locales that covers local
installation via `install.sh`, the opt-in self-signed LAN HTTPS, redeployment, and the PostgreSQL 17
default with the PG16→17 migration guidance from Chorus #616. The guide SHALL be linked from
`deployment-overview` and the sidebar.

#### Scenario: Reader self-hosts on a LAN
- **WHEN** a reader follows the deployment overview to the local guide
- **THEN** they find the HTTPS opt-in step and the PG16 upgrade warning

### Requirement: Daemon and CLI behaviour matches 0.22.x
Pages that describe `--chorus-only`, `--daemon-wake`, wake errors, or mention recovery SHALL describe the
enforced allowlist-and-kill behaviour (#614, #621), the applied-to-existing-agent `--daemon-wake`
(#615), credential redaction (#613), and persisted mention recovery (#609), in all four locales.

#### Scenario: Operator reads about --chorus-only
- **WHEN** an operator reads daemon-operations
- **THEN** the docs say that non-Chorus tools are removed and that a violation kills the wake

### Requirement: Stale facts are corrected
`reference/realtime` SHALL NOT claim that agents do not use SSE; it SHALL describe the daemon's
Bearer-key SSE subscription and the pending-turns recovery (#618). Idea-move docs SHALL describe
blocked assignees (#622), and the Pi page SHALL reflect the restored role-scoped tools (#608).

#### Scenario: Reader checks how agents get woken
- **WHEN** a reader opens reference/realtime
- **THEN** it states that the daemon consumes SSE with a Bearer cho_ key

### Requirement: Quality gate passes
The `Chorus-Doc` `pnpm check` gate SHALL pass, and the change SHALL be committed locally on
`docs/chorus-0.22.2` without pushing.

#### Scenario: Gate run
- **WHEN** `pnpm check` runs on the branch
- **THEN** it exits 0, or any stage the environment cannot run is reported explicitly

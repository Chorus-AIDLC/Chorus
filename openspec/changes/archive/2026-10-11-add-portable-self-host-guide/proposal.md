## Why

Readers need a reproducible, low-cost local/self-hosted Chorus guide, not a configuration tied to the author's workstation. Existing examples separate embedded PGlite from a PostgreSQL/Redis stack but do not cover a single-instance PostgreSQL deployment with an optional Cloudflare Named Tunnel and a complete operations checklist.

## What Changes

- Add a portable Linux/Docker Compose example for one Chorus instance plus PostgreSQL 16, without Redis or public database ports; provide optional Named Tunnel and loopback-only local access.
- Add a Chinese guide and an English companion covering prerequisites, replaceable configuration, cost/security boundaries, local HTTP versus public HTTPS, login, API/MCP, SSE, daemon reconnect, persistence, upgrades, rollback and backup/restore.
- Keep the current machine strictly a test fixture. Publish a separate, sanitized acceptance record with exact versions and actual outcomes. External-domain/Tunnel-dependent checks remain explicitly unverified until user-provisioned resources are available; no claim of public production readiness follows from local tests.
- Link from the existing Docker guide. Do not change business logic, migrate existing data, modify DNS, provision cloud resources, release, push or merge.

## Capabilities

### New Capabilities
- `portable-self-host-guide`: Portable deployment configuration, reader-oriented operations and evidence-based local validation.

### Modified Capabilities
None.

## Impact

Changes are limited to `deploy/self-host/`, deployment contract tests, `docs/`, and this OpenSpec change. Existing Docker examples remain compatible. The user supplies any future Named Tunnel and domain routing; credentials never enter documentation or Git. Default-password login is a smoke-test/bootstrap path, not a substitute for per-user OIDC in a team deployment. No unsupported operating system or workload-capacity claim is made.

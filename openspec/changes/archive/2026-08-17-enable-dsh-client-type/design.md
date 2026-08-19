## Context

Daemon backends cross four explicit registration boundaries: the server allowlist that accepts a connection's self-report, the CLI backend selector and metadata mappings, the shared presence label hook, and locale messages. Codex and Kiro already establish the pattern. DeepSeek Harness must use the exact wire value `dsh` at every boundary so later daemon bridge work can rely on one stable client type.

The persisted `DaemonConnection.clientType` is a string, and daemon turn usage is JSON. Supporting another enumerated application value therefore does not require a database schema change.

## Goals / Non-Goals

**Goals:**

- Make `dsh` a valid server-side daemon client type.
- Make `--agent dsh` resolve through the existing CLI selection contract.
- Define the dsh executable descriptor as `{ name: "dsh", envVar: "CHORUS_DSH_PATH" }`.
- Self-report the CLI backend as `clientType=dsh`.
- Display a localized DeepSeek Harness label wherever `useClientTypeLabel()` is used.
- Protect the registration contract with focused tests.

**Non-Goals:**

- Implement the dsh spawner, bridge, transcript collection, token accounting, plugin installation, or onboarding.
- Add a new API or change daemon wire framing.
- Change the default backend from `claude-code`.
- Add or alter database models or migrations.

## Decisions

### Extend the existing explicit registration points

Add `dsh` beside Codex and Kiro in `DAEMON_CLIENT_TYPES`, `KNOWN_AGENTS`, `backendCli()`, and `backendClientType()`. This follows the current architecture and keeps unknown values rejected. A plugin registry abstraction was considered but would add unnecessary scope for one additive backend and diverge from established code.

### Keep one wire identifier

Use `dsh` for both the CLI backend name and server `clientType`. Unlike `claude-code` / `claude_code`, no compatibility translation is needed. This minimizes mismatch risk between selection, self-report, server validation, and presentation.

### Reuse the shared presence label path

Add a `dsh` branch to `useClientTypeLabel()` and `clientDsh` to `en`, `zh`, `ja`, and `ko`. Existing presence, connection, and session components already consume this hook, so no component-specific rendering changes are required. The product label is `DeepSeek Harness` in every locale because it is a product name.

### Verify the contract at its pure boundaries

Extend `cli/__tests__/daemon-agent.test.mjs` to cover dsh acceptance, membership, CLI metadata, and self-reported type. Extend the daemon connection service constant assertion and pass a parsed dsh self-report through `registerConnection()` so the private `isDaemonClientType()` gate is exercised through its public registration boundary. Add a shared-label hook test backed by the real locale messages so dsh presentation is verified beyond key existence.

## Risks / Trade-offs

- [Risk] The later dsh spawner is not part of this change, so selecting `--agent dsh` may progress past parsing before downstream bridge support lands. -> The parent plan sequences this registration as a base change; implementation must not claim end-to-end dsh execution.
- [Risk] One missed locale key would surface a translation lookup failure. -> Add all four keys in the same change and run the repository's locale/type validation through focused tests and lint/type checks as available.
- [Risk] Registration values can drift across CLI and server. -> Pin both sides to the literal `dsh` and cover each mapping with unit tests.

## Migration Plan

Deploy as an additive code change. Existing client types and stored rows remain valid. Rollback removes `dsh` from the explicit registration points and locale files; no data migration or rollback procedure is needed.

## Open Questions

None.

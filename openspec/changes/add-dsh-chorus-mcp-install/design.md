## Context

DeepSeek Harness `0.1.0-rc.7` composes every profile from bundle patches, then a profile-local patch, then `$DSH_HOME/cordis.patch.yml`. Its launcher loads inherited environment values over project `.env` and home `.env` before evaluating Loader `!!js` expressions. The built-in `@deepseek-ai/dsh-mcp-client` registers remote tools as `mcp__<serverName>__<tool>` and supports Streamable HTTP with reconnect, but its header configuration accepts final strings rather than credential references.

The installer must work through `curl | bash`, preserve existing user configuration, remain compatible with Bash 3.2, and avoid exposing the Chorus key in argv or logs.

## Goals / Non-Goals

**Goals:**

- Configure one Chorus MCP client row for all current and future dsh profiles.
- Keep the patch free of secrets and protect the credential file with mode `0600`.
- Support clean first install, rerun, URL change, and key rotation without duplicate rows or keys.
- Continue starting dsh when Chorus is temporarily unavailable and reconnect in the background.
- Verify the effective dsh composition and a model-facing Chorus MCP tool call.

**Non-Goals:**

- Port Chorus skills or lifecycle hooks; those are separate child ideas.
- Implement daemon wake, resume, transcript, or usage transport.
- Bridge MCP resources or prompts, which dsh's current MCP client does not expose.
- Modify dsh itself or introduce an additional npm plugin package.

## Decisions

### Use the home-wide user patch

The installer inserts an id-stable `chorus-mcp` row in `$DSH_HOME/cordis.patch.yml`. The home layer applies to headless, web, and future profiles, matching dsh's role as a first-class Chorus harness and making the same tools available to interactive users.

A headless-only row was rejected because it would make interactive dsh sessions unable to claim, comment, or report work. The row sets:

- `name: '@deepseek-ai/dsh-mcp-client'`
- `transport: streamable-http`
- `serverName: chorus`
- a Loader expression producing `<CHORUS_URL>/api/mcp`
- an Authorization Loader expression producing `Bearer <CHORUS_API_KEY>`
- `failOnStartupError: false`

Reconnect remains enabled through dsh defaults.

### Store connection values in the home environment file

The installer writes or replaces only `CHORUS_URL` and `CHORUS_API_KEY` in `$DSH_HOME/.env`, preserving unrelated lines, and enforces file mode `0600`. The patch references `process.env` through `!!js`, so neither the key nor its value appears in the patch.

Using `.credentials.yaml` was rejected because the current MCP client does not consume dsh credential references. Writing the key directly into the patch was rejected because it mixes shareable configuration with secrets.

Input validation rejects empty values, control characters, unsupported URL schemes, and keys that do not use the `cho_` prefix. The installer prints the normalized endpoint and credential source, never the credential value.

### Replace only an installer-owned patch region

The patch row is surrounded by stable Chorus begin/end comments. On rerun, portable `awk` removes the prior complete region and appends the canonical region once. An unmatched marker is a hard error so a damaged file is not silently rewritten. Existing content remains byte-for-byte unchanged outside the managed region.

This avoids requiring a globally installed YAML editor while keeping the mutation deterministic under Bash 3.2. The generated file is validated through `dsh --profile headless --dump-config`, which uses dsh's own YAML parser and composition logic.

### Keep startup non-blocking

`failOnStartupError` is false. A home-wide integration must not make every dsh profile unavailable during a transient Chorus outage. The MCP client reconnects using its bounded exponential-backoff defaults, and tools appear after synchronization succeeds.

The trade-off is that a daemon turn can briefly start without Chorus tools. The existing dsh MCP supervisor keeps this state visible by logging `mcp-client(chorus): connection attempt failed` followed by the retry delay and attempt count. The smoke suite must assert that an unreachable endpoint produces that diagnostic while dsh startup remains non-blocking. Stronger daemon-level readiness coordination and turn compensation remain outside this MVP.

The supported dsh profiles do not install a console logger and their default logger threshold does not retain warning records. The installer therefore writes a small dependency-free `$DSH_HOME/chorus-mcp-readiness.mjs` exporter and loads it immediately before the MCP row. It emits only warning/error records containing `mcp-client(chorus):`, leaving unrelated dsh logs unchanged. The exporter is installer-owned, mode `0600`, and participates in the same validation rollback as `.env` and the managed patch.

### Test the installed contract, not only shell syntax

`public/test-install-dsh.sh` selects Bash 3.2 when available, statically rejects Bash 4-only constructs, parses the installer, and runs it against isolated `HOME` and `DSH_HOME` directories with a fake `dsh` for deterministic mutation tests. It verifies:

- exactly one managed patch row and one copy of each environment key after rerun;
- rotated values replace prior values without leaking into captured output or argv;
- unrelated patch and `.env` content survive;
- owner-only mode on `.env`;
- malformed managed markers fail without changing the file.

When the real dsh CLI is available, a separate smoke path composes the installed headless profile and connects it to a local Streamable HTTP MCP fixture, then asserts a `mcp__chorus__*` tool is visible and callable. It also boots against an unreachable endpoint and asserts a clear `mcp-client(chorus)` failure/retry diagnostic without a fatal startup error.

## Risks / Trade-offs

- **A project-local `.env` can override the home Chorus values.** -> Document dsh's established inherited/project/home precedence and make the isolated smoke run outside a project containing competing Chorus variables.
- **Marker-based editing cannot structurally understand arbitrary YAML.** -> Own only an appended, clearly delimited top-level region and validate the final composition with dsh's parser before reporting success.
- **The installed dsh release may not ship `@deepseek-ai/dsh-mcp-client`.** -> Probe the effective configuration and fail with an actionable minimum-version message.
- **Chorus can be unavailable at session start.** -> Preserve dsh availability and use the MCP client's reconnect defaults; daemon readiness coordination is a follow-up.
- **Current dsh profiles have no visible warning exporter.** -> Install a filtered local exporter before the MCP client so only Chorus connection readiness diagnostics reach stderr.

## Migration Plan

1. Publish `public/install-dsh.sh` and its test harness with the Chorus web artifact.
2. Users run the installer with `CHORUS_URL` and `CHORUS_API_KEY`, or provide them through a terminal prompt.
3. Rerunning rotates credentials and refreshes the managed patch region in place.
4. Rollback removes the marked Chorus region and the two Chorus keys from `$DSH_HOME/.env`; all unrelated dsh configuration remains.

## Open Questions

None for the MVP.

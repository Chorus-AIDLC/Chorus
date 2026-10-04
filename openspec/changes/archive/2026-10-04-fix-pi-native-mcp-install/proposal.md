# Pi native MCP installation and legacy compatibility

## Why

Chorus unconditionally installs and refreshes `pi-mcp-adapter`. Pi now includes MCP: an extension registering `/mcp` replaces the built-in implementation, so installing the adapter prevents the intended native path. Pi's installed 1.0.2 documentation confirms this behavior and the shared environment-referenced `mcpServers` configuration [1](ref:caac36e3-bef7-46ab-81e4-4cd97e6adf56). Its changelog introduces built-in MCP in **0.99.0**, not 1.0.0 [2](ref:e4f8d21e-9c7c-43d4-823e-029c85e784e4).

Idea `fee5109f-80b7-476f-bc19-f20f5e3f6f55` has resolved human decisions: native MCP first, retain older Pi support through version detection, and warn rather than uninstall existing adapters. Historical Proposal `1e831855-b9c5-4307-85b1-2ded89f48e6e` is no longer retrievable; this proposal restores reviewable planning, not approval or implementation authorization.

## What Changes

### Confirmed compatibility direction

Human comment `23315604-0e8b-4d37-aaad-682a69e0fcf0` (2026-10-04T06:51:37Z) explicitly reverses Round 2's Pi-1-only answer: retain older Pi compatibility, use native MCP on newer hosts. Round 3 records that correction without overwriting the previous answer. Existing-adapter handling remains warning-only.

Independent review `B1-pre1-package-support-contract` identified that PR #597 currently declares the Chorus Pi artifact for `>=1.0.0 <2.0.0`. This proposal therefore adds a prerequisite **package compatibility implementation and verification task**, not merely an installer branch: adapt the current package to the maintained pre-1.0 host matrix and widen its peer contract only after actual packaged extension loading and local-fixture MCP tests pass. Pi 1.x workflow behavior and reviewer security remain intact. No historical release is assumed compatible or silently pinned. The proposed maintained floor is Pi 0.84.4 (the preceding workspace SDK baseline); older hosts get an explicit unsupported result, not a guessed installation. No pre-1.0 runtime compatibility is claimed verified yet.

- Share version-based backend selection across `chorus agents add` / `init` and plugin upgrade. Within the maintained package range, stable Pi >=0.99.0 uses native MCP; supported older versions retain adapter installation/update. Unknown versions never cause speculative adapter installation, and unsupported hosts do not install a falsely compatible Chorus package.
- Correct installed-state checks: native Pi needs Chorus only; legacy Pi needs Chorus plus adapter. Preserve targeted updates and configured version constraints.
- Warn about existing adapters and explicit native-MCP disabling without removing packages, changing extension filters, or claiming the native connection has been repaired.
- Preserve environment-based credentials and unrelated MCP servers/settings; explain native versus legacy configuration discovery.
- Prefer native tool names in Pi guidance and support native and legacy direct names in generic normalization. Any non-workflow legacy gateway helper remains separate from the workflow event resolver, which must inspect outer names only. Reuse the separate workflow-matching effort instead of duplicating it.
- Require actual SDK/packaged-artifact compatibility tests for Pi 0.84.4, 0.87.1, 0.99.0, and 1.0.2 using local fixtures and dummy credentials. Production-provider smoke is optional; missing mandatory compatibility evidence blocks completion rather than being waived as an unavailable smoke test.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `pi-init-integration`: version-aware installation, upgrade parity, warning-only migration, MCP credential continuity, and Pi tool guidance.

## Impact

CLI install/state/upgrade and credential messages; `packages/chorus-pi` host-API compatibility, tested peer metadata, generic tool resolution and Pi-specific skills/worker guidance; focused lockfile updates as needed; `docs/CONNECT_PI.md`, package README/metadata, and any other installation docs that prescribe unconditional adapter installation. Shared skill wording changes require auditing all seven plugin/standalone surfaces; no unrelated host runtime changes. Package compatibility precedes CLI integration and generic normalization; documentation/aggregate verification follows both.

Out of scope: automatically uninstalling adapters or re-enabling built-ins, removing legacy Pi support, changing MCP server/API contracts, implementing arbitrary workflow suffix matching in Pi/dsh (owned by approved Proposal `05a19157-d028-47a1-8887-c05c33b3274a`), release/version bumps, commits, pushes, or merges. Stop for human proposal approval before implementation.

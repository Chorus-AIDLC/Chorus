## Why

PR #615 fixes explicit daemon-wake updates for existing agents, but currently forwards a resolver's implicit cwd default into an existing agent. A no-flags rerun from another directory can overwrite served directories; a legacy flat config can fail instead of being skipped.

## What Changes

- Return cwd provenance from the installer resolver and only update existing-agent cwds for explicit flags or interactive answers.
- Preserve implicit/default behavior for new-agent creation and preserve explicit daemon-wake semantics.
- Support explicit settings updates to legacy flat single-agent configs by migrating them into agents[], retaining connection identity and unrelated settings.
- Add real-resolver regression coverage with isolated config writers.
- Prepare the fix against PR #615, targeting develop. Do not merge. Keep remote publishing behind explicit human approval.

## Capabilities

### New Capabilities
- `explicit-agent-settings-update`: safe, intent-aware updates of existing modern and legacy agent settings.

### Modified Capabilities
None.

## Impact

CLI only: cli/daemon-install-config.mjs, cli/init/steps/credential-seed.mjs, cli/login.mjs and adjacent tests. No server/API changes or release/version bump. Existing filtered-index and non-object-entry behavior is explicitly out of scope.

## Acceptance

Default and inherited cwds never update an existing agent; explicit cwd and wake requests still work; no-flags flat-config reruns skip without writes; explicit flat updates preserve settings and identity. Focused and broader CLI tests run with no access to actual user configuration.

# pi-init-integration Specification

## Purpose
TBD - created by archiving change optimize-pi-plugin-npm-parity. Update Purpose after archive.
## Requirements
### Requirement: chorus init installs the pi plugin automatically
The `pi` adapter in `cli/init/adapters.mjs` SHALL change from a `guided` (manual-instructions) adapter to an automated install that runs `pi install npm:@chorus-aidlc/chorus-pi`, matching how the other npm-published plugins are installed. The adapter SHALL still detect the `pi` binary and pi config dirs (`~/.pi`, `~/.config/pi`) as before, and SHALL fail gracefully (surface the manual command) when `pi` is not installed.

#### Scenario: init auto-installs when pi is present
- **WHEN** `chorus init` runs with the pi adapter selected and the `pi` binary available
- **THEN** it runs `pi install npm:@chorus-aidlc/chorus-pi` rather than only printing manual guidance

#### Scenario: init degrades gracefully without pi
- **WHEN** the `pi` binary is absent
- **THEN** init surfaces the manual install command instead of failing hard

### Requirement: CONNECT_PI docs reflect npm install and wakeability
`docs/CONNECT_PI.md` and `packages/chorus-pi/README.md` SHALL document the npm install path (`pi install npm:@chorus-aidlc/chorus-pi`) as the primary route, remove the obsolete local-path / sparse-git-checkout workaround as the recommended path, remove the manual `agents/*.md` copy step (now package-relative), and document that pi can run as a wakeable `--agent pi` daemon backend.

#### Scenario: docs recommend npm install
- **WHEN** a user reads CONNECT_PI.md
- **THEN** the primary install instruction is `pi install npm:@chorus-aidlc/chorus-pi`, with no manual agents-copy step


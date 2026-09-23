# Enforce the Kiro reviewers' read-only shell with the Kiro 2.x mechanism

## Why

The plugin templates target **Kiro 2.x**. The previous change machine-enforced the reviewers' read-only shell with `permissions.rules`, which is the CLI 3.0 key; on a 2.x installation its handling is undocumented, and it is exactly the unresolved risk that change recorded. Priority is 2.x compatibility, so enforcement moves to `toolsSettings.shell`, the mechanism 2.x actually has.

Two further facts from the 2.x reference change the design rather than only the key name:

**`deniedCommands` and `allowedCommands` are regular expressions anchored with `\A` and `\z`.** Prefix-style patterns carried over from the `permissions` attempt — `git commit`, `rm `, `pip install` — would have matched only those exact full command lines and silently enforced nothing. `git commit -m "msg"` would have passed. Every pattern intended to match a command with arguments needs an explicit wildcard tail. Look-around is unsupported.

**`denyByDefault` exists**, denying any command outside `allowedCommands` that `autoAllowReadonly` has not auto-approved. That is a stronger primitive than a deny list, and it fits the proposal reviewer exactly: its contract already forbids test and build runs, so a read-only allow-list plus `denyByDefault` machine-enforces the contract without naming a single project-specific command. It does not fit the code and task reviewers, which must run the project's own test and build commands — commands these templates cannot know.

## What Changes

- The 3.0 `permissions` key is removed from all three Kiro reviewer profiles.
- All three gain `toolsSettings.shell` with `autoAllowReadonly: true` and 47 anchored-regex `deniedCommands` covering file writes, git write operations, package installs, privilege escalation and mutating HTTP verbs.
- `chorus-proposal-reviewer` additionally gains `denyByDefault: true` plus 21 read-only `allowedCommands`, machine-enforcing "no test or build runs".
- The code and task reviewers deliberately omit `denyByDefault`, so the project's test and build commands still run.
- The parity test's structural check is rewritten for the 2.x shape and additionally asserts anchor-safety — that every pattern meant to take arguments ends in a wildcard — and evaluates the patterns against real command lines rather than only checking that strings are present.

## Capabilities

- `kiro-plugin-templates` — MODIFIED: the reviewer tool-scope requirement.

## Impact

- **Changed:** the three Kiro reviewer JSON files; `src/__tests__/reviewer-rule-parity.test.ts`.
- **Unchanged:** every non-Kiro surface; all `tools` arrays; every reviewer prompt; the verdict set.

## Verified behaviour

Patterns were evaluated as anchored regexes against real command lines: `git commit -m "x"`, `pip install requests`, `rm -rf build`, `sudo apt install x` and `curl -X POST https://host/path` are denied, while `git log --oneline`, `grep -rn foo src/` and `pnpm test` are not. For the proposal reviewer, `pnpm test`, `make build` and `cargo test` are absent from the allow-list and therefore denied under `denyByDefault`, while `ls -la`, `git ls-files` and `grep -rn x src/` are allowed.

## Trade-off

`toolsSettings` is deprecated in CLI 3.0 for shell rules, where the replacement is `permissions.rules`. On a 3.0 installation these shell settings may be ignored, in which case that reviewer falls back to prompt-only enforcement — the posture before machine enforcement existed, which the prompt contract already covers on its own. Given the stated priority, 2.x enforcement is preferred over 3.0 enforcement rather than attempting both: shipping both keys would depend on each version tolerating the other's unknown key, which is undocumented in both directions.

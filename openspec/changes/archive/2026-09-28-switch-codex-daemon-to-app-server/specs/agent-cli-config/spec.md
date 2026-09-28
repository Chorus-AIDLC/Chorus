## MODIFIED Requirements

### Requirement: Guard managed runtime controls
Configured args SHALL NOT override known backend controls for protocol, output, session, prompt, cwd, managed MCP or permission posture, including supported aliases and equals/attached forms. Configured env SHALL NOT override CHORUS_* variables or nested-Claude context names CLAUDECODE / CLAUDE_CODE_ENTRYPOINT, case-insensitively. Bare argument terminators SHALL be rejected in persistent args.

#### Scenario: Protected configuration
- **WHEN** configured args attempt a protected flag or configured env includes a protected name
- **THEN** validation fails before a child starts with an actionable, value-free error.

#### Scenario: Persistent option arity
- **WHEN** configured args place a positional token after a known boolean (for example Pi `--verbose`), omit a required value, or supply an ambiguous separated value after an unknown option
- **THEN** validation fails before daemon or foreground spawn without disclosing values; unknown standalone flags and backend-supported inline values remain pass-through.

#### Scenario: Literal known option values
- **WHEN** a known value-taking option receives option-looking literal data
- **THEN** validation consumes that value without treating it as a managed control; persistent bare sentinels remain forbidden.

#### Scenario: Reserved nested-Claude context
- **WHEN** persistent env includes CLAUDECODE or CLAUDE_CODE_ENTRYPOINT in any casing, including a Claude type alias
- **THEN** validation rejects the entry rather than accepting and silently deleting it; absent configuration retains existing inherited-context sanitation.

#### Scenario: Ordinary variables and fresh environment
- **WHEN** env overrides an ordinary inherited variable
- **THEN** only the selected child sees the override, with case-insensitive replacement on Windows and existing managed identity/headless sanitation preserved.

Codex daemon configuration SHALL additionally protect App Server transport and remote-host selection, including --listen in separated/equals forms and code-mode-host controls. Supported model and permitted -c/--config options SHALL retain their effective meaning through documented App Server argv/config/RPC translation for both fresh and resumed wakes. Unsupported exec-only options SHALL fail clearly without displaying values or silently dropping the option. Foreground launch behavior SHALL remain unchanged.

#### Scenario: App Server transport override is rejected
- **WHEN** persistent Codex args try to replace stdio transport or select another execution host
- **THEN** validation MUST fail before spawn with an actionable value-free diagnostic

#### Scenario: Existing model and reasoning settings are preserved
- **WHEN** a fresh or resumed daemon wake uses supported per-agent model or reasoning configuration
- **THEN** its App Server configuration MUST apply equivalent settings with literal values and existing precedence

#### Scenario: Unsupported old option is explicit
- **WHEN** a configured exec-only option has no supported App Server equivalent
- **THEN** the wake MUST fail with a remediation hint instead of silently ignoring it or returning to exec

#### Scenario: Foreground option insertion remains compatible
- **WHEN** chorus agents run launches an existing supported foreground Codex command
- **THEN** its recognized-subcommand insertion and explicit-argument precedence MUST retain existing behavior

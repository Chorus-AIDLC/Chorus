# agent-cli-config Specification

## Purpose
Define per-agent literal CLI arguments and environment overrides shared by daemon wakes and foreground launches, preserving profile isolation, managed runtime controls, explicit-option precedence, and safe diagnostics.
## Requirements
### Requirement: Per-agent literal configuration
The system SHALL accept optional args (string array) and env (string-to-string object) on each agents[] entry. Multi-agent args/env SHALL NOT inherit top-level defaults. Flat daemon mode SHALL apply top-level args/env to its sole agent. Foreground shared configuration SHALL use the existing agents[] profile selection.

#### Scenario: Independent profiles
- **WHEN** two agents have distinct args/env
- **THEN** each spawned child receives only its selected profile's customization without modifying siblings or process.env.

#### Scenario: Invalid or misplaced fields
- **WHEN** a field has the wrong type, contains NUL, has an invalid environment name, or is placed at the top level alongside nonempty agents[]
- **THEN** launch fails before spawning with a profile/field diagnostic that excludes values.

#### Scenario: Flat profile migration
- **WHEN** appendAgentConfig adds a new profile to a legacy flat file with a credential key and args/env
- **THEN** the original entry receives args/env by property presence, including malformed values, and the top-level keys are removed in the same atomic write; later reads retain values or attribute malformed fields to agents[0].

#### Scenario: Migration refusal and absent customization
- **WHEN** the file already has shared top-level args/env alongside nonempty agents[], or cannot fold customization because the flat credential key is missing
- **THEN** appendAgentConfig rejects without changing the file; absent customization introduces no args/env keys and duplicate-key refusal does not partially migrate a flat file.

#### Scenario: Early flat validation
- **WHEN** a flat daemon run (including detach) has malformed or protected persistent configuration
- **THEN** it fails before credential resolution, prompting, validation/network preflight, or child spawn.

#### Scenario: Literal values
- **WHEN** valid tokens contain spaces or shell syntax and env values contain interpolation-looking text
- **THEN** supported spawn paths pass them as literal data without interpolation or shell evaluation; a platform shim unable to preserve safe literal semantics SHALL fail explicitly rather than execute syntax.

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

### Requirement: Deliver through all existing launch paths
All wakeable backends (Claude Code, Codex, Kiro, Pi, dsh) SHALL receive the selected config for fresh and resumed daemon wakes. All supported foreground types SHALL receive it under their effective selected type. Offline SHALL remain non-wakeable. Configured options SHALL be inserted without displacing positional or protocol sentinels.

#### Scenario: Daemon construction parity
- **WHEN** a flat or multi-agent daemon creates a normal or dynamic runtime connection
- **THEN** its spawner receives that agent's args/env and uses them in the actual child invocation.

#### Scenario: Foreground type override
- **WHEN** an agent is launched with an explicit --type
- **THEN** validation and argv construction use that effective type, and executable lookup uses the effective child environment.

#### Scenario: Known foreground subcommands
- **WHEN** explicit agent argv selects Codex exec, exec resume or resume; Kiro chat; or OpenClaw agent
- **THEN** retained configured args are inserted after the deepest recognized command and before its explicit options and positionals, without reordering any explicit token.

#### Scenario: Root options and command-looking values
- **WHEN** known value-taking root or parent options precede a supported command
- **THEN** command discovery skips their complete value spans (including option-looking values), recognizes only command-position names, and stops at the first prompt/unknown command or ambiguous option rather than searching later tokens.

#### Scenario: Unknown subcommand limits
- **WHEN** no supported command path is recognized
- **THEN** configuration keeps prefix insertion and all explicit tokens remain unchanged; documentation SHALL NOT promise arbitrary subcommand grammar or flag compatibility, and unknown ordinary standalone or inline extension flags remain allowed.

#### Scenario: Windows retained-token safety
- **WHEN** foreground insertion follows a subcommand and the executable is a Windows command shim
- **THEN** safety checks inspect every retained configured token independently of its argv position, rejecting unsafe retained tokens before spawn but not rejecting unsafe configured options that explicit precedence removed.

#### Scenario: Existing configuration
- **WHEN** args/env are absent or empty
- **THEN** launch arguments and environment semantics remain compatible with existing behavior.

### Requirement: Prefer explicit recognizable foreground options
For documented recognizable singleton options, explicit foreground tokens in the selected command scope SHALL take precedence over persistent args by suppressing conflicting configured tokens and their values. Explicit tokens SHALL remain unchanged. Unknown/repeatable options SHALL retain configured-then-explicit ordering within the selected scope without a generic override guarantee.

#### Scenario: Model and reasoning override
- **WHEN** configured model/reasoning flags conflict with explicit supported equivalents, including equals or recognized attached short forms
- **THEN** the configured occurrence is removed and the explicit selection is delivered, preserving unrelated tokens and unrelated Codex -c keys.

#### Scenario: Parent versus selected command options
- **WHEN** explicit local model options occur before a recognized child command
- **THEN** they remain unchanged but do not suppress configured child-command options; recognized Codex config keys supplied through global -c/--config participate in precedence across scopes.

#### Scenario: Values are not override switches
- **WHEN** explicit Pi args are `--append-system-prompt --model` or `-e --model`
- **THEN** the configured model remains and all explicit tokens are unchanged; true model switches outside value spans still suppress configured equivalents.

#### Scenario: Terminators and unknown option ambiguity
- **WHEN** the explicit scan reaches the first bare `--` anywhere in the agent argv or an unknown option whose arity cannot be determined
- **THEN** it stops inferring command scopes and singleton overrides from subsequent tokens while preserving the entire explicit tail, even if a backend might consume that bare sentinel as a required option value.

#### Scenario: Explicit interactive session options
- **WHEN** the user explicitly passes interactive resume flags after --
- **THEN** the launcher preserves those tokens; persistent configured resume controls remain forbidden.

### Requirement: Restart semantics and documentation
The system SHALL read customization at daemon startup and on each foreground invocation, without hot-reloading running children. Documentation SHALL describe schema, per-agent isolation, protected controls, exact override support, literal values, flat-to-agents[] usage, restart requirements and secret-handling limitations. Values SHALL NOT be proactively emitted in diagnostics.

#### Scenario: Safe actionable launch diagnostics
- **WHEN** a launcher or daemon backend encounters a thrown or emitted spawn error
- **THEN** diagnostics report only allowlisted OS error classifications with fixed troubleshooting guidance, or a generic hint for unknown codes; raw code/syscall, message, path and argv fields are not echoed.

#### Scenario: Managed dsh preparation diagnostics
- **WHEN** managed dsh preparation fails
- **THEN** the failure retains a meaningful sanitized cause and applicable profile/provider hints, redacting configured argv/env values and credentials, including ordinary variable values and inline option payloads.

#### Scenario: Existing dsh profile
- **WHEN** the effective environment selects an existing DSH_HOME or CHORUS_DSH_HOME
- **THEN** managed preparation is skipped with a value-free informational notice and the selected profile is preserved.

#### Scenario: Configuration changes
- **WHEN** daemon.json is edited while a daemon or child is running
- **THEN** existing configuration remains in use until daemon restart, while the next foreground launch reads the updated profile.


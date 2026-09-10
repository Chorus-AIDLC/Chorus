## ADDED Requirements

### Requirement: Apply the agent's model and thinking on launch

`chorus agents run` SHALL apply the selected agent's resolved `model` and `thinking` (from its `agents[]` entry, or — when the entry omits the field — the file's top-level default) to the launched process, using the same per-backend mapping as the daemon wake path: `--model` / `--effort` for `claude-code`, `--model` / `--thinking` for `pi`, `-m` / `-c model_reasoning_effort=<value>` for `codex`. The mapped flags SHALL be placed before the verbatim `--` passthrough, and SHALL NOT be injected for a knob the passthrough already sets, so an explicit user argument always wins over the configured value. The launcher SHALL print the resolved `model` and `thinking` in its launch diagnostics when they are set, so the operator can see which value is in effect before the agent starts. For a backend without a verified parameter, the launcher SHALL inject nothing for these fields and SHALL name the omission in its diagnostics rather than failing.

#### Scenario: Launching a configured agent applies its model and thinking

- **WHEN** the selected agent's entry sets `model: "opus"` and `thinking: "high"` with `agentType: "claude-code"` and the user runs `chorus agents run --name dev`
- **THEN** the launched `claude` process receives `--model opus --effort high` in addition to any passthrough arguments

#### Scenario: An explicit passthrough argument wins

- **WHEN** the same agent is launched with `chorus agents run --name dev -- --model sonnet`
- **THEN** the launched process receives the user's `--model sonnet` and the launcher does not also inject the configured `--model opus`

#### Scenario: The launch diagnostics name the resolved values

- **WHEN** the selected agent resolves a `model` and/or `thinking`
- **THEN** the launcher's diagnostic line includes those resolved values (the agent is still identified by name/UUID only, and the API key is never printed)

#### Scenario: Unconfigured fields and unsupported backends add nothing

- **WHEN** the selected agent sets no `model`/`thinking`, or its backend is one without a verified parameter (for example `dsh` or `opencode`)
- **THEN** the launched process receives no model/thinking flag from the launcher, and the diagnostics report the omission instead of failing the launch

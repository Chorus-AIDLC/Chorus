## MODIFIED Requirements

### Requirement: Multiple independent agent configurations in daemon.json

The daemon SHALL accept an optional `agents` array in `~/.chorus/daemon.json`, where each element is a complete, independent agent configuration containing at minimum an `apiKey` and optionally `url`, `agentType`, `cwds`, `permissionMode`, `maxConcurrency`, `sigintTimeoutMs`, `browseRoots`, `model`, and `thinking`. Every existing top-level field SHALL act as a **default**, and any field present on an individual agent SHALL override that default for that agent only. The daemon SHALL validate that each agent has a non-empty `apiKey` and a resolvable `url`, and that each `agentType` is a known backend; on a violation it SHALL exit non-zero naming the offending agent and SHALL NOT silently drop or fall back. A `model` or `thinking` value that is present but not a non-empty string SHALL likewise cause a non-zero exit naming the offending agent and the offending field, so that an unusable value is never silently ignored. The **values** of `model` and `thinking` SHALL NOT be validated against any backend-specific list: they are forwarded verbatim to the backend, which owns acceptance or rejection.

#### Scenario: Each agent merges its fields over top-level defaults

- **WHEN** `daemon.json` has a top-level `url` and `sigintTimeoutMs` and an `agents[]` where one agent omits `url` but sets its own `cwds` and `maxConcurrency`
- **THEN** that agent resolves with the top-level `url` and `sigintTimeoutMs` as defaults and its own `cwds` and `maxConcurrency` as overrides

#### Scenario: Invalid agent entry fails visibly

- **WHEN** an `agents[]` entry has no `apiKey`, or an unresolvable `url`, or an unknown `agentType`
- **THEN** the daemon exits non-zero with an error naming the offending agent and does not start, rather than silently skipping it

#### Scenario: Model and thinking inherit from the top-level default

- **WHEN** `daemon.json` sets top-level `model` and `thinking` and an `agents[]` entry sets only its own `model`
- **THEN** that agent resolves with its own `model` and the top-level `thinking`, and a second agent entry that sets neither resolves with both top-level values

#### Scenario: A present but unusable model or thinking fails visibly

- **WHEN** an `agents[]` entry sets `model` (or `thinking`) to an empty string, a number, or an object
- **THEN** the daemon exits non-zero with an error naming that agent and that field, instead of starting with the field silently ignored

#### Scenario: An unknown model or thinking value is not rejected by the daemon

- **WHEN** an `agents[]` entry sets `model` to a string the resolved backend does not recognize
- **THEN** the daemon starts and forwards the string verbatim, and the failure (if any) is reported by the backend harness rather than by the daemon

## ADDED Requirements

### Requirement: Per-agent model and thinking delivery to backends

For the backends with a verified model and thinking parameter — `claude-code`, `pi`, and `codex` — the daemon SHALL deliver each agent's resolved `model` and `thinking` to that agent's spawned process as the backend's own command-line arguments, so that a single daemon process can wake different agents on different models and different thinking/reasoning levels at the same time. The mapping SHALL be: `--model <value>` and `--effort <value>` for `claude-code`; `--model <value>` and `--thinking <value>` for `pi` (inserted before pi's trailing `-p`, which MUST remain the final argument because pi's parser treats a bare token after `-p` as the message); `-m <value>` and `-c model_reasoning_effort=<value>` for `codex` (in both the new-session and resume invocation shapes). Delivery SHALL apply to both daemon shapes: a daemon configured with an `agents` array delivers each agent's resolved values, and a daemon without one (the flat single-agent shape) delivers the file's top-level values. Delivery SHALL be per agent: an agent without these fields SHALL spawn with exactly the arguments it spawned with before this capability existed. The daemon SHALL NOT translate one backend's vocabulary into another's, and SHALL NOT validate a value against a backend-specific list.

#### Scenario: A claude-code agent wakes with its own model and effort

- **WHEN** an `agents[]` entry with `agentType: "claude-code"`, `model: "opus"`, and `thinking: "high"` is woken
- **THEN** the spawned `claude` process receives `--model opus` and `--effort high` in addition to the daemon's existing arguments

#### Scenario: A pi agent wakes with its own model and thinking level

- **WHEN** an `agents[]` entry with `agentType: "pi"`, `model: "anthropic/claude-haiku-4-5"`, and `thinking: "low"` is woken
- **THEN** the spawned `pi` process receives `--model anthropic/claude-haiku-4-5` and `--thinking low`

#### Scenario: A codex agent wakes with its own model and reasoning effort

- **WHEN** an `agents[]` entry with `agentType: "codex"`, `model: "gpt-5-codex"`, and `thinking: "high"` is woken, in either a new-session or a resume invocation
- **THEN** the spawned `codex` process receives `-m gpt-5-codex` and `-c model_reasoning_effort=high` in that invocation

#### Scenario: Sibling agents keep independent models

- **WHEN** one daemon serves two agents whose entries set different `model` / `thinking` values
- **THEN** each agent's spawned process receives only its own values, and neither agent's values appear in the other's arguments

#### Scenario: A flat single-agent daemon delivers its top-level values

- **WHEN** `daemon.json` has no `agents` array and sets top-level `model` and `thinking`
- **THEN** the single agent's spawned process receives those values as its backend's mapped arguments, and the startup output shows them — a flat install does not silently ignore them

#### Scenario: An invalid top-level value fails the flat daemon visibly

- **WHEN** a flat `daemon.json` sets `model` (or `thinking`) to an empty string or a non-string
- **THEN** the daemon exits non-zero with an error naming the field, exactly as in `agents[]` mode

#### Scenario: Agents without the fields are unaffected

- **WHEN** `agents[]` entries set no `model` and no `thinking` (and no top-level defaults exist)
- **THEN** every spawned process receives exactly the arguments it received before this capability existed — no empty flag, no placeholder value

#### Scenario: An unsupported backend reports the gap instead of silently dropping it

- **WHEN** an agent whose `agentType` is not one of `claude-code`, `pi`, or `codex` (for example `dsh`, `kiro`, or `offline`) has `model` or `thinking` set
- **THEN** the daemon does not pass either value to that backend, starts normally, and logs one visible warning line naming the agent, the field, and the backend, so the configuration gap cannot be mistaken for an applied setting

#### Scenario: The per-agent startup output shows the resolved values

- **WHEN** the daemon starts with an agent that has `model` and/or `thinking` resolved
- **THEN** that agent's startup line includes the resolved `model` and `thinking` values alongside its backend, permission mode, served paths, and concurrency

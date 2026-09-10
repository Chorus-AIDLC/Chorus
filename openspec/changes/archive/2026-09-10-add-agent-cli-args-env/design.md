## Context

The user completed two elaboration rounds and authorized YOLO plus a PR targeting develop, not merge. Existing daemon-config resolves a whitelist; daemon.mjs has separate multi-agent and flat startup paths. credentials.mjs separately resolves foreground profiles. selectSpawner constructs five distinct backends, each with its own argv/env setup. Foreground currently forwards explicit tokens untouched. None of PR #550's model/thinking implementation was merged.

## Goals / Non-Goals

Goals: consistent per-agent literal argv/env delivery, no cross-agent mutation, early structural validation and protected-control errors, predictable explicit overrides, backwards-compatible unconfigured paths.

Non-goals: global defaults for args/env, hot reload, interpolation, dotenv loading, secret vaults, model/thinking-specific config fields, new CLI type support, web UI, releasing or merging.

## Decisions

### Schema and shared pure helpers

Introduce a small pure ESM helper (suggested `cli/agent-cli-config.mjs`) for validation, environment overlay and recognizable option precedence. `args` defaults to an empty array; `env` defaults to an empty object. Present values must have the declared type: null is invalid, every argv token and env value must be a string without NUL, env names must be portable identifiers. Empty string values remain valid. Validation errors name the profile and field/index, never values. Clone data and never mutate process.env or input arrays/objects.

Multi-agent entries own args/env without inheriting top-level keys; reject misplaced top-level args/env in multi-agent mode with a clear migration hint rather than silently ignore them. Flat daemon config may use top-level args/env for its one agent. Foreground selection remains agents[]-based (as before). The existing `appendAgentConfig` flat-to-agents[] fold moves args/env by own-property presence (including malformed values for later field-level validation) into the original entry and removes the top-level fields in the same atomic temp-file rename. Only an actual flat fold removes fields. Already-shared invalid config is rejected before any write; a flat partial config without a key cannot be folded and must not be converted into invalid shared config. Missing customization introduces no keys, and duplicate-key refusal leaves the file untouched. No new selection/migration subsystem is added.

### Protected controls

Validate configured args against a backend-aware deny set for transport, output protocol, prompt/session/resume, cwd and managed MCP identity/configuration controls. Cover separated and equals long options, known short aliases and attached-value spellings. Bare `--` in configured args is rejected because it can change interpretation of managed flags/prompt. Audit each existing builder for its actual controls. Permission posture flags managed by Chorus must not be overridden by persistent config. Unknown ordinary options remain pass-through, not an allowlist of all third-party flags. Keep separate backend arity metadata for known zero-value, required-value, optional-value and variadic options (including aliases). Validation must skip literal values, reject positional tokens after booleans, and reject missing required values before they swallow managed argv. Unknown separated values are ambiguous and fail closed in persistent config; unknown standalone flags and inline `--option=value` remain allowed, with spelling support delegated to the backend. Explicit passthrough remains the full native CLI surface. This protects known controls, not a sandbox against a user who controls their executable/configuration.

Configured env rejects `CHORUS_*` case-insensitively, preserving runtime identity, credentials, session and daemon state. Overlay allowed env onto a fresh inherited environment, then apply existing backend-managed fields and existing sanitation (interactive headless clearing, Claude nested-session clearing). For Windows, override names case-insensitively so Path/PATH cannot coexist with ambiguous precedence. Support ordinary harness env like provider credentials or config homes without logging values. Where harness home/env affects preflight or managed setup, resolve it consistently from the effective per-agent env.

### Spawn integration

Pass validated configuration through config resolution, daemon runtime construction and selectSpawner to every backend; cover BOTH flat and multi-agent startup and newly created dynamic connections. Each wake appends/inserts configured argv at its backend's safe option position: before Pi's trailing -p, before Codex prompt stdin marker for fresh AND resume shapes, preserving all fixed dsh/Kiro protocol requirements. Environment is local to the child. dsh uses its effective environment for managed-home/provider/model preparation too. Offline still never spawns regardless of args/env.

Foreground uses the same validation against the effective `--type` selection and effective env for binary discovery. Explicit passthrough tokens remain untouched, including interactive resume choices; persistent configured controls remain protected. Configuration validation happens before any spawn. Flat daemon run validates before credential/network preflight (including detach), not after it. This does not change the daemon's own network environment or the baseline Pi startup diagnostic resolver.

Foreground inserts retained configured args after the deepest recognized command in Codex `exec`, `exec resume`, `resume`; Kiro `chat`; OpenClaw `agent`. Walk known option arities to locate commands even after explicit root options, skipping option-looking values without interpreting them as switches or commands. Stop command discovery at the first positional prompt/unknown command, ambiguous option, or first bare `--`. Never search arbitrary tokens for command names. If no supported command is recognized, retain the legacy prefix insertion; unknown command grammars (including other nested commands) are not inferred or promised to accept configured flags. Operators must use native explicit passthrough and omit incompatible persistent args for such commands. All explicit tokens keep their exact order; configured options precede the recognized command's options/positionals. `planAgentArgs` returns the full argv and the retained configured tokens separately so Windows shim safety checks do not assume configuration is an argv prefix.

### Explicit option precedence

Use a small backend-specific registry for recognizable singleton options: at least model on every backend that supports a model flag and Claude effort/Pi thinking/Codex model_reasoning_effort. When explicit tokens supply a registered option in the selected command scope (separated, equals or recognized attached short form), remove its configured occurrence including its value. Local root/parent model options do not suppress configured child-command options. Codex `-c`/`--config` applies across scopes and is repeatable by key: override only matching recognized keys, not unrelated configuration. Unknown or repeatable options retain configured-then-explicit order within the selected scope, with semantics delegated to that CLI. Document the exact supported registry, not a blanket last-wins promise. Scan option boundaries on BOTH configured and explicit sides: a literal `--model` value of Pi `--append-system-prompt` or `-e` must never suppress a configured model. Chorus analysis stops unconditionally at the first bare `--` in the explicit agent argv, even where the backend might consume it as a required value; persistent sentinels remain forbidden. After an unknown explicit option without an inline value, stop inferring overrides instead of guessing its arity; forward every explicit token unchanged. Put known overrides before such ambiguity or use backend-supported inline unknown values when precedence matters. Do not insert absent defaults or compatibility model/thinking fields.

### Validation and test strategy

Use existing injectable spawner/test seams with fake processes, no live provider or sensitive credentials. Add actual temporary-file migration/readback and a harmless real Node child to record argv/env after migrated foreground selection and subsequent on-disk edits. Cover atomic rename, malformed-field attribution, unchanged rejected files, root and nested command scopes, required values that resemble switches/commands, absolute terminator boundaries, and unsafe/suppressed/safe configured Windows shim tokens after command insertion. Test schema errors, literal whitespace/metacharacters, Windows case behavior, malformed config redaction, protected aliases, sibling isolation, absent/empty behavior, effective --type, foreground headless sanitation and precedence. Assert actual spawn argv/env for all five daemon backends, fresh and resumed where applicable, and foreground types including opencode/openclaw. Test daemon plumbing in flat/multi-agent paths, not only helpers. Run full CLI tests and typecheck/lint as practical; report unrelated baseline failures transparently.

## Risks / Trade-offs

- CLI flags evolve: keep deny/override registries small, explicit and tested. Unknown options aren't guaranteed singleton overrides.
- Windows cmd/bat shims route through cmd.exe despite shell:false: retain supported platform behavior but ensure configured tokens cannot introduce shell evaluation; test shim metacharacter handling and either safe encoding or explicit safe failure for unsupported strings.
- Env may hold plaintext credentials: user explicitly defers secret mechanisms; avoid values in diagnostics, advise local file permissions.
- Flat profile foreground selection isn't supported today: document the agents[] path rather than silently claiming newly supported flat foreground parity.

## Migration Plan

Existing config needs no edits. Add args/env to individual agents[] entries, restart daemon, or run agents run again. Remove fields to roll back. No schema migration or special treatment of closed PR #550.

## Open Questions

None requiring human input. Implementation may refine backend registries based on current builders, with tests and documentation matching the final supported forms.

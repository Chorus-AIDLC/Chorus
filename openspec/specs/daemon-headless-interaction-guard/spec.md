# daemon-headless-interaction-guard Specification

## Purpose
TBD - created by archiving change add-daemon-headless-interaction-guard. Update Purpose after archive.
## Requirements
### Requirement: Wake prompts SHALL declare the headless, no-human-at-terminal context

Every wake prompt the daemon sends to a spawned headless Claude session (`cli/prompts.mjs#buildPrompt`) SHALL be prefixed with a shared headless preamble. The preamble SHALL state that the session is a headless `claude -p` run woken by the Chorus daemon, that there is no human at the terminal, and that `CHORUS_DAEMON_HEADLESS=1` is set. The preamble SHALL be prepended to the prompt body for **every** wake action that produces a prompt, regardless of action type and regardless of whether the spawn is a new session or a `--resume` continuation.

#### Scenario: Every wake action carries the headless preamble

- **WHEN** `buildPrompt` is called for any action in `WAKE_ACTIONS` (e.g. `task_assigned`, `mentioned`, `elaboration_verified`, `human_instruction` with body, …)
- **THEN** the returned prompt contains the shared headless preamble text declaring "headless", "no human at the terminal", and `CHORUS_DAEMON_HEADLESS=1`
- **AND** the original per-action body (the `[Chorus] …` text and any `@mention` guidance) is still present after the preamble

#### Scenario: The preamble rides every turn including resumes

- **WHEN** the daemon resumes an existing session and builds a fresh wake prompt for the new turn
- **THEN** that prompt also carries the headless preamble
- **AND** the spawn argv does NOT use `--append-system-prompt` to inject the rule

### Requirement: Wake prompts SHALL prohibit AskUserQuestion and route human interaction through Chorus

The headless preamble SHALL instruct the woken agent not to call `AskUserQuestion` or any interactive/blocking terminal prompt, and SHALL direct it to route every point that needs human input or confirmation through Chorus async channels — posting a comment with an `@mention` and/or opening an elaboration round the human answers in the UI. The preamble SHALL include a small number of illustrative skill-instruction → Chorus-channel mappings (general rule plus examples, not an exhaustive table). The preamble SHALL instruct the agent that, after posting a question to Chorus, it ends the turn and leaves the work pending rather than blocking on a synchronous reply.

#### Scenario: The prohibition and re-routing rule are present

- **WHEN** any wake prompt is built
- **THEN** it contains an explicit instruction not to use `AskUserQuestion` / blocking terminal prompts
- **AND** it contains the general rule to route human-decision points through Chorus — posting a comment with `chorus_add_comment` (`@mention`) and/or opening an elaboration round the human answers in the UI
- **AND** it contains the async hand-off instruction: post to Chorus, then end the turn and leave the work pending (do not poll/wait)
- **AND** the preamble does NOT embed the literal answer-questions tool names `chorus_pm_start_elaboration` / `chorus_pm_validate_elaboration` (it rides every wake, including the `elaboration_verified` write-the-proposal wake whose contract forbids them)

#### Scenario: Guidance is soft, not a tool-layer block

- **WHEN** this change is applied
- **THEN** no tool-layer deny, strip, or runtime interception of `AskUserQuestion` is added
- **AND** the spawn allowed-tools / permission-mode behavior is unchanged from before this change

### Requirement: Null wake bodies SHALL remain null after the preamble is applied

Prepending the headless preamble SHALL NOT turn a non-wake notification into a wake. Actions for which `buildPrompt` returns `null` (an unknown action, or a `human_instruction` whose instruction body is empty) SHALL still return `null`, so the router continues to skip them and no contentless subprocess is spawned.

#### Scenario: Unknown action stays null

- **WHEN** `buildPrompt` is called with an action not in `WAKE_ACTIONS`
- **THEN** it returns `null`
- **AND** no preamble-only prompt is produced

#### Scenario: Empty human_instruction stays null

- **WHEN** `buildPrompt` is called for a `human_instruction` action whose `instructionText` is missing or blank
- **THEN** it returns `null`

### Requirement: The spawner SHALL mark headless daemon sessions with an environment signal

`ClaudeSpawner.wake()` SHALL spawn the headless Claude subprocess with `CHORUS_DAEMON_HEADLESS` set to `"1"` in the child process environment. The variable SHALL be added on top of the inherited environment so all other inherited variables (PATH, credential/Bedrock vars, `CLAUDE_CONFIG_DIR`, etc.) are preserved. This change in this proposal SHALL NOT add any code that reads the variable back — it is a forward-looking, machine-checkable signal.

#### Scenario: Spawned child environment carries the signal

- **WHEN** the daemon spawns a headless wake via `ClaudeSpawner.wake()`
- **THEN** the child process environment contains `CHORUS_DAEMON_HEADLESS=1`
- **AND** environment variables inherited from the daemon process are still present in the child environment

#### Scenario: The signal is independent of permission mode

- **WHEN** the spawner runs in either `chorus` (allowed-tools) or `yolo` (`--dangerously-skip-permissions`) permission mode
- **THEN** the child environment carries `CHORUS_DAEMON_HEADLESS=1` in both cases

### Requirement: The interaction guard SHALL NOT modify skill bodies or the spawn argv contract

The headless interaction guard SHALL be implemented entirely on the daemon path — the wake-prompt builder and the spawner. It SHALL NOT add a conditional `AskUserQuestion`/headless branch to any skill body (`idea`, `brainstorm`, `develop`, `proposal`, `yolo`) on any of the four skill surfaces, and SHALL NOT change `buildArgs()` to add `--append-system-prompt`. Interactive (human-at-terminal) Claude Code sessions, which never traverse the daemon wake path, SHALL be unaffected.

#### Scenario: Skill bodies are untouched and stay in sync

- **WHEN** the change is applied
- **THEN** no skill markdown file is modified to add a headless conditional
- **AND** the four skill surfaces (Claude Code plugin, Codex plugin, standalone `public/skill/`, OpenClaw) remain consistent with each other (unchanged)

#### Scenario: Interactive sessions are unaffected

- **WHEN** a human runs Claude Code interactively (not via the daemon)
- **THEN** the headless preamble and `CHORUS_DAEMON_HEADLESS` env var are absent
- **AND** `AskUserQuestion` continues to work as before


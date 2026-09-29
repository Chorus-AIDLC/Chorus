## MODIFIED Requirements

### Requirement: Wake prompts SHALL prohibit AskUserQuestion and route human interaction through Chorus

The headless preamble SHALL instruct the woken agent not to call `AskUserQuestion` or any interactive/blocking terminal prompt, and SHALL direct it to route every point that needs human input or confirmation through Chorus async channels — posting a comment with an `@mention` and/or opening an elaboration round the human answers in the UI. The preamble SHALL include a small number of illustrative skill-instruction → Chorus-channel mappings (general rule plus examples, not an exhaustive table). The preamble SHALL instruct the agent that, after posting a question to Chorus, it ends the turn and leaves the work pending rather than blocking on a synchronous reply. In addition, the Claude Code daemon spawn SHALL deny `AskUserQuestion` at the tool layer via `--disallowedTools AskUserQuestion` in every permission mode; this tool-layer deny SHALL apply only to daemon-spawned Claude Code processes and SHALL NOT alter skill bodies or interactive sessions.

#### Scenario: The prohibition and re-routing rule are present

- **WHEN** any wake prompt is built
- **THEN** it contains an explicit instruction not to use `AskUserQuestion` / blocking terminal prompts
- **AND** it contains the general rule to route human-decision points through Chorus — posting a comment with `chorus_add_comment` (`@mention`) and/or opening an elaboration round the human answers in the UI
- **AND** it contains the async hand-off instruction: post to Chorus, then end the turn and leave the work pending (do not poll/wait)
- **AND** the preamble does NOT embed the literal answer-questions tool names `chorus_pm_start_elaboration` / `chorus_pm_validate_elaboration` (it rides every wake, including the `elaboration_verified` write-the-proposal wake whose contract forbids them)

#### Scenario: Claude daemon spawn denies AskUserQuestion at the tool layer

- **WHEN** the daemon spawns Claude Code in either `--chorus-only` or yolo permission mode
- **THEN** the argv contains `--disallowedTools AskUserQuestion`
- **AND** the permission-mode allowlist / skip-permissions behavior is otherwise unchanged

#### Scenario: Interactive sessions keep AskUserQuestion

- **WHEN** a human runs Claude Code interactively (not via the daemon)
- **THEN** no tool-layer deny of `AskUserQuestion` is applied

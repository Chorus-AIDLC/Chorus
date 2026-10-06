# daemon-claude-background-agents Specification

## Purpose
Protect daemon-woken Claude background agents with an overridable finite post-turn wait ceiling, without adding global foreground-wait rules, and make ceiling termination observable rather than successful.

## Requirements

### Requirement: Claude background wait SHALL have an overridable finite default
Daemon Claude wakes SHALL default `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` to `3600000`. An explicitly supplied native variable SHALL take precedence over `CHORUS_CLAUDE_BG_WAIT_CEILING_MS`; a valid non-negative decimal safe integer Chorus override SHALL take precedence over the default. Invalid Chorus overrides SHALL fall back safely. Other backends and the parent environment SHALL remain unchanged.

#### Scenario: No override
- **WHEN** a Claude daemon wake has neither override
- **THEN** its child receives a 3600000ms background wait ceiling without a whole-wake watchdog

#### Scenario: Explicit operator choice
- **WHEN** the native override is present, including zero, alongside a Chorus override
- **THEN** the native value is preserved without replacement

#### Scenario: Chorus override validation
- **WHEN** only the Chorus override is provided
- **THEN** a valid non-negative decimal safe integer is used, including zero, and invalid or blank values fall back to 3600000

### Requirement: Background termination SHALL not be reported as success
The Claude spawner SHALL recognize the observed complete background-termination diagnostic across stderr chunks, latch detection, report an execution failure and preserve raw exit metadata. Waker SHALL use existing abnormal completion reporting and SHALL NOT log success for that wake.

#### Scenario: Split diagnostic with raw zero exit
- **WHEN** stderr contains `Background tasks still running after 600s; terminating.` split across chunks and the process exits zero
- **THEN** the effective wake fails and its diagnostic retains raw exit code zero

#### Scenario: Unrelated output
- **WHEN** normal output or unrelated stderr contains no complete termination diagnostic
- **THEN** existing completion classification is unchanged

### Requirement: Background termination SHALL be visible on the triggering work item
The daemon SHALL attempt one bounded, credential-free explanatory comment per affected wake on its triggering Idea or Task. Comment failures SHALL warn without preventing failure reporting or cleanup. Unsupported entity kinds SHALL retain diagnostic visibility without an invalid comment request. User interruption and shutdown SHALL retain existing reason precedence. The feature SHALL NOT retry the work or change task status automatically.

#### Scenario: Repeated diagnostic
- **WHEN** an affected task wake emits the diagnostic repeatedly
- **THEN** only one explanatory comment is attempted on that task, not the session's root Idea

#### Scenario: Comment transport failure
- **WHEN** the comment request rejects
- **THEN** the wake remains abnormal, cleanup completes and the comment failure is logged

### Requirement: Background protection SHALL rely on daemon configuration without a global foreground wait mandate
Claude background-agent lifetime protection SHALL use the daemon-injected wait ceiling and explicit termination reporting. This feature SHALL NOT introduce a global requirement for the main agent to stay in the foreground until every background child finishes, SHALL NOT change interactive workflow skills, and SHALL NOT modify standalone public skills. Existing workflow-specific review gates and human handoff behavior SHALL remain unchanged.

#### Scenario: Main turn ends after background Agent dispatch
- **WHEN** a daemon-woken Claude main turn ends with a background Agent still running
- **THEN** Claude's configured post-turn wait ceiling governs waiting and any ceiling termination is reported by the existing failure-detection path
- **AND** no added prompt or skill mandate requires the main agent to stay active solely to preserve the child's lifetime

#### Scenario: Interactive and standalone workflows retain their original guidance
- **WHEN** this feature is applied
- **THEN** Claude plugin skills, standalone public skills and their version metadata have no change from this feature
- **AND** existing review verdict requirements, cancellation and asynchronous human handoff rules are preserved

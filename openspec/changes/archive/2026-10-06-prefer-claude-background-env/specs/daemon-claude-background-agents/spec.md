## REMOVED Requirements

### Requirement: Claude workflow guidance SHALL retain ownership of background agents
**Reason**: The owner superseded the global waiting mandate with daemon environment-first protection to avoid changing interactive behavior or spending main-agent tokens on lifecycle waiting.
**Migration**: Remove only this feature's added prompt and skill guidance, standalone skill edits, associated tests and plugin version bumps. Keep pre-existing workflow review gates and asynchronous human handoff rules.

## ADDED Requirements

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

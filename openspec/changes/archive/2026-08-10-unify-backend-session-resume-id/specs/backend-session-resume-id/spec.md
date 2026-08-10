## ADDED Requirements

### Requirement: Claude Code sessions report a usable resume identifier
The Claude Code daemon backend MUST report, through the existing authenticated turn
lifecycle channel, the resume identifier that its own `--resume` command accepts,
so that the conversation UI's session-id copy control appears for Claude Code
conversations exactly as it does for Codex. The reported identifier MUST be the
session's Claude `--resume` anchor.

#### Scenario: Claude Code session reports its resume anchor
- **WHEN** a Claude Code daemon session completes a turn
- **THEN** the daemon reports the session's Claude `--resume` anchor as the backend resume identifier, and the server stores it as the session's backend resume identifier

#### Scenario: Copy control appears for a Claude Code session with a stored identifier
- **WHEN** a user views a Claude Code conversation whose stored backend resume identifier is non-null
- **THEN** the existing session-id copy control is shown and copies that identifier verbatim

### Requirement: Copied Claude identifier resumes the same conversation
For a Claude Code-backed conversation, the persisted backend resume identifier MUST
be accepted by the installed Claude Code CLI's `--resume` option in the session's
working directory and identify the same conversation the Chorus session tracks.

#### Scenario: User resumes a Claude conversation from the copied id
- **WHEN** the user runs `claude --resume <copied-id>` in the session's working directory
- **THEN** Claude Code resumes the same conversation represented by the Chorus session

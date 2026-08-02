## Why

Project-level Agent cwd preferences exist, but each assignment, stage-advance, and wake
surface still decides independently whether to show an instance picker or how to resolve a
runtime cwd. This duplication lets a saved fixed cwd be bypassed and risks starting work in
the wrong repository.

## What Changes

- Add one shared project-Agent cwd target resolver with an explicit resolution source,
  liveness state, and immutable host/cwd result.
- Make new Idea and Task assignment flows consume a valid fixed cwd directly and suppress
  instance/cwd pickers while the fixed preference exists.
- Anchor a root Idea once, then let same-Agent proposal, task, stage-advance, and wake flows
  inherit that target through the existing hard-pin chain.
- Preserve active session cwd and origin-host stickiness when a project preference is later
  replaced or cleared.
- Apply the existing hard-pin offline policy to fixed targets: recoverable wakes remain
  notify-only, require-online actions fail distinctly, and no flow silently reroutes.
- Restore existing instance auto-selection, picker, and temporary discovered-cwd behavior
  only after the preference is explicitly cleared.

## Capabilities

### New Capabilities

- `project-cwd-anchoring`: Authoritative project-Agent cwd resolution, root-Idea anchoring,
  picker suppression, hard-pin failures, Agent isolation, and session continuity.

### Modified Capabilities

None.

## Impact

The change affects project cwd preference services, Idea and Task assignment actions and
modals, wake preview, stage-advance services, notification target resolution, shared picker
orchestration, and focused unit/integration/browser coverage. It reuses the existing
`ProjectAgentCwdPreference`, `AgentInstance`, directed `runtimeCwd`, and daemon session
models without a data migration.

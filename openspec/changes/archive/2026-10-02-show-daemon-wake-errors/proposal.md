# Daemon wake errors in conversation history

## Why

When a daemon-woken agent fails, the conversation currently exposes interrupted/crash state but not a consistent explanation from its launch error, terminal protocol event, or stderr. Users need the reason on the failed turn, including failures that produced no assistant reply. The existing collection and reporting gaps were verified against the repository during Idea initialization. [1](ref:5bc11d01-b10c-451a-9a79-317ce00f7103)

The human selected all supported daemon backends, both startup and execution failures, and a persisted summary with expandable details. The subsequent YOLO request authorizes completing the lifecycle using those answers.

## What Changes

- Add an optional bounded `wakeError` diagnostic to backend wake results and terminal turn reports.
- Capture actionable startup, structured protocol, and process failure information for Claude, Codex, Pi, Kiro, DSH, and OpenClaw's daemon client.
- Persist the diagnostic on the exact failed turn, separate from transcript-relay failures; return it through existing session reads and live refresh.
- Render a localized error summary and expandable plain-text details on the failed turn, including turns without messages.
- Give historical crash/invalid-path turns without diagnostics an honest generic error fallback.
- Preserve ordinary successful wakes, warning-only stderr, user interrupts, shutdown, existing session identity, and recovery controls.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `daemon-spawner-interface`: optional structured diagnostics for failed backend wakes.
- `daemon-session-conversation`: durable, correlated failure diagnostics on terminal turns.
- `daemon-session-transcript-read`: error summaries and expandable details in the conversation.

## Impact

Changes touch CLI spawners and Waker, the OpenClaw daemon client, the turn-advance REST boundary and session service, Prisma's turn model and an additive migration, and the chat turn component with English/Chinese/Japanese/Korean translations. There are no new runtime dependencies, new permission grants, or total wake-duration timeouts. Existing clients may omit the new field and historical turns remain readable.

Node distinguishes process failure from exit/close and trailing IO; existing bounded settlement remains the collection boundary. [2](ref:0ccba00a-261b-4566-b01c-f1bb3b277ec8)

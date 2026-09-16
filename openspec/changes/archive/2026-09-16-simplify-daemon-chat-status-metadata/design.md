## Context

`TranscriptView` currently renders a secondary badge for both session lifecycle states: “Active” for a normal conversation and “Ended” for a terminal one. A running turn is already represented independently by a pulse and live elapsed timer, so “Active” contributes little information. The same component’s collapsible connection card renders identity, uptime, host, and a relative process start time derived from `DaemonConnection.startedAt`.

The requested change applies to every Agent Daemon conversation, including idea-anchored and ad-hoc sessions and both active and historical views. Other connection and execution surfaces are outside scope.

## Goals / Non-Goals

**Goals:**

- Omit the redundant “Active” lifecycle badge from active transcript headers.
- Preserve the “Ended” badge because it communicates a distinct terminal state.
- Omit only the relative process-start row from the transcript connection disclosure.
- Preserve all useful live-running, token, identity, uptime, host, control, and transcript behavior.
- Add focused regression coverage for active, ended, and connection-disclosure states.
- Keep the canonical Agent Daemon chat representation in `docs/design.pen` synchronized with the shipped interface.

**Non-Goals:**

- Removing `startedAt` from the API, persistence model, or other connection views.
- Removing or renaming localization keys that may remain useful to other surfaces.
- Changing the running pulse, elapsed runtime, session status semantics, or connection-details layout beyond natural grid reflow.
- Redesigning the Agent Daemon chat.

## Decisions

### Render the lifecycle badge only for ended sessions

`TranscriptView` will keep the existing `sessionEnded` derivation but conditionally mount the badge only when it is true. This directly removes “Active” without conflating session lifecycle with the current turn’s execution status. The existing running indicator remains the authoritative live-work signal.

An alternative was to remove the lifecycle badge for both active and ended sessions. That would discard useful historical context and conflict with the requirement that other status behavior remain unchanged.

### Remove the start-time field at the transcript presentation boundary

The `DetailField` for `displayConnection.startedAt` and the now-unused relative-time formatter will be removed from `TranscriptView`. The underlying connection projection retains `startedAt`, allowing other observability surfaces to continue using it. The existing two-column grid naturally reflows the retained uptime and host fields, so no placeholder or replacement spacing is needed.

An alternative was to hide the text while preserving its row. That would leave unexplained whitespace and would not satisfy the requested compact layout.

### Exercise the real transcript component in focused tests

Regression tests will render `TranscriptView` with real English translations and representative active, ended, and connected session fixtures. Assertions will prove that “Active” and “Started” are absent while “Ended”, uptime, host, and the connection-details trigger remain available.

### Update the encrypted design source through Pencil

The Agent Daemon chat screen in `docs/design.pen` will be located, edited, and visually verified through the Pencil MCP tools. The update will remove the active badge and the relative start-time row while preserving the existing visual system and the remaining connection details. The encrypted file will not be read or written through filesystem tools.

## Risks / Trade-offs

- **Risk: “Active” may be confused with the running indicator during implementation.** → Assert that only the lifecycle badge disappears and leave the running pulse/timer path unchanged.
- **Risk: a broad cleanup could remove start-time data from other connection surfaces.** → Limit code changes to `TranscriptView`; retain service types and translation keys.
- **Risk: the canonical design source could drift from the implementation.** → Update and screenshot-verify the matching `docs/design.pen` screen in the same task.
- **Trade-off: an active-but-idle conversation has no lifecycle badge.** → This is intentional; its presence in the selected conversation view already establishes that it is available, while ended conversations retain an explicit terminal marker.

## Migration Plan

No data migration or rollout sequencing is required. Deploy as a frontend-only change. Rollback restores the active badge branch and the connection disclosure’s start-time `DetailField`.

## Open Questions

None.

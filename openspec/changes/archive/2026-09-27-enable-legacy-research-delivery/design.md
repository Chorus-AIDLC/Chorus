## Context

The prior researchProtocol=1 read gate prevents legacy acknowledgement problems by withholding work entirely. The owner explicitly replaces that policy with normal legacy execution and optional enhanced serialization (Idea comment f88729f1-13ad-45a3-975c-fef214b42480).

## Decisions

Both client generations receive the same human_instruction records and bounded Research prompt. The current CLI declares researchProtocol=1 on pending reads and turn-advance requests. It continues identifying the Research prefix locally, isolating queue items and reporting exact turn UUIDs.

The HTTP turn-advance boundary explicitly selects isolated mode only for researchProtocol=1; missing, zero or unknown values select legacy mode. Isolated mode excludes Research from ordinary FIFO and merged settlement. Legacy mode permits the origin client to include Research in ordinary FIFO and coalesced settlement, so completion removes it from reconnect backfill. Internal service calls retain their existing isolated default unless explicitly selecting legacy mode.

Company and agent scope remain authoritative. Legacy FIFO and merged settlement include Research only for the session origin; exact Research reports still require the origin. Dispatch and pending-read stage checks remain; the agent prompt also checks development boundaries.

## Tradeoffs

Only the upgraded CLI can guarantee isolated Research batches and server admission before spawning. Legacy clients may merge queued instructions under their existing behavior and may start their subprocess before reporting running. The server cannot add a pre-launch guarantee to an already-running old binary. No protocol filter holds their work pending merely because of client age.

## Validation

Use existing daemon HTTP/client/service suites, including a real-database read → run → merge/end → reconnect sequence for legacy mode and exact per-turn completion for researchProtocol=1. No new CI job, step, or separate test infrastructure.

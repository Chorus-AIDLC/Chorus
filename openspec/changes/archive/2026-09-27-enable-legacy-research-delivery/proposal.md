## Why

Legacy CLI clients currently cannot receive Tracker Research turns, leaving requests pending until an upgrade. The owner requested progressive enhancement: clients declaring `researchProtocol=1` execute isolated Research rounds while older clients retain their ordinary instruction behavior.

## What Changes

- Return eligible pending Research instructions to every client generation.
- Negotiate isolated versus legacy turn acknowledgement through `researchProtocol=1` on the turn-advance request.
- Keep the new CLI's same-session serial queue and exact-turn admission; restore legacy FIFO/coalesced settlement.
- Reuse existing CI suites without additional Research-specific jobs or steps.

## Capabilities

### Modified Capabilities
- `lightweight-research`: delivery and turn acknowledgement support both client generations.

## Impact

Daemon REST client, pending-turns and turn-advance endpoints, existing turn service, regression tests and specification. No database migration or new lifecycle entity.

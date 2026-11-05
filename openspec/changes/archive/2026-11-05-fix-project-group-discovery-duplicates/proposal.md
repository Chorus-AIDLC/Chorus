# Project group discovery and duplicate prevention

## Why

An agent interpreted the first 20 of 24 groups as the complete inventory and created a duplicate public group. The historical permission failure is unproven; current code already inherits owner access, but creation has no duplicate guard and list ordering lacks a unique tie-breaker.

## What Changes

- Preserve all existing owner-scoped discovery and private-group boundaries.
- Order group discovery by createdAt then uuid and explain full-page traversal before creation.
- Reject creation with CONFLICT/409 when an exactly matching name exists among groups visible to the caller, even outside the first page.
- Check access and duplicates inside the creation transaction, using Serializable isolation and bounded serialization-conflict retries.
- Add service/database, MCP pagination and error-path regressions; document the contract.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `project-group-access`: add safe group creation and deterministic paginated discovery requirements.

## Impact

Group service/access helpers, their tests, MCP tool descriptions/tests, and API/MCP documentation. No schema migration or new dependency. Existing successful create response and collection envelopes remain unchanged; visible exact duplicate creates now fail. No changes to renaming, name normalization, historical duplicate cleanup, visibility administration, or project:admin permissions.

Research sources and historical uncertainty are recorded on Idea 1a41908c-6afe-4c49-aaf9-46aad45686e1. The chosen scope follows human round 1 and YOLO round 2; this is not a claim to have reproduced the October deployment.

## Why

Users need reusable, personal agent responsibility templates before applying teams to projects. Existing permission presets describe authority, not team responsibilities, and cannot safely express multiple agents per fixed role or explain role eligibility.

## What Changes

- Add Settings → Teams with private, creator-owned template CRUD and own-agent selection. This follows the human's correction from company templates to personal configuration; company isolation remains mandatory.
- Define four fixed responsibilities: product, development, review, and project lead. Each accepts zero or more agents; agents can fill several roles.
- Validate new bindings against effective permissions without granting authority. Show missing permission bits. Retain existing bindings after permission loss and flag them as ineligible on reads.
- Permit empty/partial templates. Provide English/Chinese text, light/dark styling, accessible loading/error/empty states, and matching `docs/design.pen` frames.
- Add data models, migration, service, user-only REST APIs, regression tests and real-browser acceptance.

## Capabilities

### New Capabilities
- `agent-team-templates`: Personal templates, ownership boundaries, fixed-role eligibility and Settings management.

### Modified Capabilities
None. Agent permission presets, project access, assignment, routing, review wakes and project application remain unchanged.

## Impact

Prisma models/migration, `src/services/agent-team.service.ts`, shared role/DTO definitions, `/api/agent-teams`, Settings navigation and page, locale messages, tests and `docs/design.pen`. No new dependencies or MCP tools. Existing templates do not exist, so migration is additive. Future Idea ② must recheck eligibility and project access when applying a personal template.

## Acceptance

The creator can persist/reload/edit/delete templates, configure multiple own agents per role, remove members, and save empty roles. Invalid new bindings fail atomically with missing permission details; downgraded members remain visible as ineligible. Other users (including Workspace Admin), other tenants and agent API keys cannot access the templates. No permissions, assignments or project settings are changed.

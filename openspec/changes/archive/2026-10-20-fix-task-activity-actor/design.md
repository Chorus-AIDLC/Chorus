## Context

`updateTask(uuid, data, actorContext?)` records execution history using actor context and only processes description mention diffs when context is present. PR #633 fixed MCP and board callers plus detail status updates. On baseline `f3bd92a2`, three callers remain: `verifyTaskAction`, `updateTaskFieldsAction`, and REST PATCH.

## Goals / Non-Goals

Make authorized mutations retain their acting identity and enable existing mention processing. Display super admins consistently without account lookups. No history rewrite, permission widening, state-machine change, schema migration, new lint rule, or unrelated code cleanup.

## Decisions

1. Pass `{ actorType: auth.type, actorUuid: auth.actorUuid }` as the third argument at each remaining caller. Do not derive identity from request data or task assignee. Supply context for REST field-only edits as well as status changes.
2. Keep verification human-only and keep acceptance, project-access, dependency, assignee, and transition gates untouched. Continue to use `updateTask` for execution history and mention side effects, rather than duplicating either at callers.
3. Keep `actorContext` optional for compatibility. Audit all production callers after the patch, including indirect `updateData` calls; all existing authenticated callers must pass context. No automated static enforcement is introduced.
4. Add a fixed `Admin` identity for `super_admin` in `getActorName` and `batchResolveActorIdentities`. Audit `batchGetActorNames` and downstream formatters to ensure both scoped and unscoped display paths inherit it. Preserve the supplied type and UUID; do not fetch or disclose any super-admin profile. Preserve user/agent/agent_instance and unknown-type behavior.
5. Proposal review identified that task mention diffing detected new recipients but handed the full description to delivery, which re-notified old recipients in mixed edits. Pass the old parsed recipient identities as an optional exclusion list to `createMentions`; filter them before validation/delivery while retaining full content for notification snippets. Other callers omit the option and keep existing behavior. Cover old-A to old-A-plus-new-B at both task and delivery service boundaries.
6. Aggregate review B1 found the project Activity page bypassed the shared resolver. Resolve its super-admin entries via the shared scoped batch path, retaining original UUIDs, while leaving user/agent lookup and fallback behavior untouched. Only user actors receive user avatars; admins retain the generic settings icon and cannot hydrate a colliding current-user profile. Cover the actual server component with mixed actor and admin-only regressions.

## Verification

- Real detail actions with mocked business services: verification and field edits pass caller identity; unauthenticated, non-human verify, project-denied, wrong-status, and failed-acceptance paths do not mutate.
- Real REST PATCH with mocked services: user, agent, super-admin contexts survive allowed status/description updates; permission, assignee, dependency and validation gates remain effective.
- Real task service with mocked persistence/mention delivery: execution activity uses the supplied actor, and only newly added mentions are forwarded with that actor; unchanged mentions are not re-notified.
- Real UUID resolver tests: single and batch Admin names, original identity preservation, no admin-profile queries, mixed existing identity types unaffected.
- Run focused tests, broader tests, targeted lint/type checks, and `git diff --check`; report pre-existing failures separately.

## Risks

Shared identity resolution affects more than task activity. Keep special handling specific to `super_admin` and verify downstream activity serialization and mixed batches. Existing unrelated work in `src/lib/__tests__/install-local.test.ts` must remain intact. Development uses local fast-forwarded `f3bd92a2`, avoiding duplication of #633.

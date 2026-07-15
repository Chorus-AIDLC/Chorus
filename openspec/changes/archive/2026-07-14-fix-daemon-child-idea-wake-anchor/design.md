# Design — Fix daemon child-idea wake anchoring + approve-note delivery

## Context

The daemon's **two-ID contract** (documented in `cli/waker.mjs` and `cli/lineage.mjs`): every inbound notification is resolved by one server round-trip to `GET /api/entities/{type}/{uuid}/root-idea`, which returns BOTH:

- `directIdeaUuid` — the entity's directly-attached idea (the first idea node on the lineage; for a task → its proposal's `inputUuids[0]` idea). The daemon anchors the Claude `--session-id` here so a human can `claude --resume <directIdeaUuid>` and same-idea wakes continue one session.
- `rootIdeaUuid` — the topmost ancestor reached by walking `parentUuid`. Reported in the execution snapshot for observability.

For a **top-level** idea `direct == root`. For a **child** idea (`child.parentUuid = parent`), a task/proposal wake resolves `direct = child`, `root = parent`.

The chat UI (`src/components/agent-presence/chat/`) renders one conversation per DIRECT idea (`session.directIdeaUuid`) and shows a per-conversation running/interruptible indicator. `executionMatchesSession` decides which conversation an execution row belongs to.

## The bug (Problem 1)

`executionMatchesSession` (`session-execution.ts:35-42`) matches an idea-anchored conversation to an execution via:

```ts
(exec.entityType === "idea" && exec.entityUuid === session.directIdeaUuid) ||
exec.rootIdeaUuid === session.directIdeaUuid   // ← only true when direct == root
```

The second clause was intended to catch a child-resource wake (a `task:<uuid>` execution whose idea is this conversation). But the daemon reports `exec.rootIdeaUuid`, so for a child idea the row carries `rootIdeaUuid = parent`. The clause then matches the row to the **parent's** conversation (whose `directIdeaUuid = parent`), lighting up the parent and leaving the child — which actually owns the woken `--session-id <child>` session — idle. Proposal `approve`/`reject` wakes hit the same path (both collapse to the `task_assigned` turn trigger, anchored on the proposal's direct idea).

The `directIdeaUuid` that would fix this is **already resolved** by `cli/lineage.mjs` and lives in `attribution` inside `waker.mjs` — it is just never stored on the execution registry entry, so it never reaches the snapshot, the DB, or the UI.

### Fix 1 — thread `directIdeaUuid` end-to-end, match on it

Add `directIdeaUuid` to every hop the snapshot passes through, then change the UI predicate to key on it.

| Hop | File | Change |
|---|---|---|
| Registry entry | `cli/waker.mjs` (map type ~124; `markQueued` set ~267; `wake` running set ~345) | carry `directIdeaUuid` (from `attribution.directIdeaUuid`) on each entry |
| Snapshot serializer | `cli/waker.mjs` `buildExecutionSnapshot` ~236 | add `directIdeaUuid` to the mapped object + JSDoc |
| OpenClaw mirror | `packages/openclaw-plugin/src/daemon-client.ts` (`ExecutionEntry` ~94; sets ~387,~493; `buildExecutionSnapshot` ~507) + `daemon-rest-client.ts` `DaemonExecutionRow` ~59 | mirror the field (host already resolves `directIdeaUuid` in `WakeRequest`) |
| Ingest zod | `src/app/api/daemon/execution-state/route.ts` `snapshotEntrySchema` ~46 | `directIdeaUuid: z.string().min(1).nullish()` |
| Service type | `daemon-execution.service.ts` `SnapshotExecution` ~88, `DaemonExecutionRow` ~147 | add `directIdeaUuid?: string | null` / `directIdeaUuid: string | null` |
| Persistence | `daemon-execution.service.ts` `reconcileSnapshot` upsert create+update ~435/~445 | write `directIdeaUuid: exec.directIdeaUuid ?? null` |
| Prisma model | `prisma/schema.prisma` `DaemonExecution` ~533 | `directIdeaUuid String?` (nullable); CLI-generated DDL-only migration |
| Read projection | `daemon-execution.service.ts` `ExecutionView` ~101 + `toExecutionView` ~182 | add `directIdeaUuid: row.directIdeaUuid` |
| UI predicate | `src/components/agent-presence/chat/session-execution.ts` ~31-42 | see below |

The UI predicate becomes:

```ts
if (session.directIdeaUuid) {
  return (
    (exec.entityType === "idea" && exec.entityUuid === session.directIdeaUuid) ||
    exec.directIdeaUuid === session.directIdeaUuid   // ← was exec.rootIdeaUuid
  );
}
return exec.entityType === "daemon_session" && exec.entityUuid === session.sessionId;
```

The `Pick<ExecutionView, ...>` in the function signature adds `"directIdeaUuid"` (and may drop `"rootIdeaUuid"` if no longer read there).

**Why match on `directIdeaUuid` and keep the first clause:** the first clause handles a direct wake ON the idea (`entityType === "idea"`, e.g. `elaboration_verified`), where the execution's `entityUuid` IS the idea. The second handles a child-resource wake (task/proposal/document), where the execution keys on the resource but its `directIdeaUuid` is the conversation's idea. Together they cover every wake a conversation owns, and — critically — a child idea's row now carries `directIdeaUuid = child`, matching the child conversation, never the parent.

**Backward compatibility / rollout.** The column is nullable and the zod field is `nullish`. An older daemon that does not yet send `directIdeaUuid` produces rows with `directIdeaUuid = null`; the new predicate's second clause is then `null === session.directIdeaUuid` → false, but the first clause (`entityType === "idea"` direct wake) still matches, so a top-level idea's own-idea wakes still show correctly — the only regression window is a child-resource wake from a not-yet-updated daemon, which is exactly today's (already-buggy) behavior. Once the daemon ships the field, child and top-level both resolve correctly. No backfill of historical rows is needed (they are `ended` history, excluded from the active read).

## The bug (Problem 2) + Fix 2

`buildMessage` in `src/services/notification-listener.ts` already bakes the approver's note into the notification `message` for `proposal_approved` (`… approved. Note: <note>`) — symmetric with `proposal_rejected`. The daemon reads `message` as `n.message`. But `cli/prompts.mjs` `proposal_rejected` surfaces `n.message` (`Review note: "${n.message}"`) while `proposal_approved` never references it. So the note is delivered to the daemon and then discarded at the prompt.

**Fix 2 is a single `cli/prompts.mjs` edit:** the `proposal_approved` body includes the decision context from `n.message` inline, mirroring `proposal_rejected`, so the woken daemon knows the reviewer's opinion without a `chorus_get_proposal` round-trip. No server change (the note already rides `message`); applies to every approve wake regardless of lineage.

## Risks / trade-offs

- **Two daemon hosts, one wire contract.** The CLI daemon and the OpenClaw plugin both POST to `/api/daemon/execution-state`. The zod field is `nullish`, so the OpenClaw host that hasn't added the field still validates; but to avoid the OpenClaw-hosted child-idea bug we mirror the field there too, in the same change.
- **Migration.** A single additive nullable column — safe, DDL-only, generated via the Prisma CLI (no hand-written SQL, no DML backfill).
- **`rootIdeaUuid` stays.** It is still reported and persisted (used for the session-label `rootIdeaTitle` enrichment and observability grouping). This change adds `directIdeaUuid` beside it; it does not remove `rootIdeaUuid`.

## Migration / rollout order

Ship server (nullable column + zod accept + projection) and daemon (emit field) together in one PR; the nullable column tolerates either arriving first. The UI predicate change is safe once `ExecutionView.directIdeaUuid` exists (null for old rows → falls through to the direct-idea clause).

# Tech Design: AgentInstance addressing

## Context

Five elaboration rounds (idea `866dc661`) ratified the model below. This doc turns those
decisions into concrete data shapes, module contracts, a migration plan, and a test plan.
It is written against verified current code (line anchors inline).

Decisions carried in (round → choice):

- R1: durable identity = **first-class `AgentInstance`** (not inline columns, not a
  DaemonConnection key); unique `(company, agent, host, cwd)`, **upsert on first daemon
  report**; assignee gains polymorphic **`agent_instance`** type; **drop**
  `Task.targetHost/targetCwd`; idea is the authoritative root, task/mention may override.
- R2: a pinned instance going **unreachable → graceful degrade to plain `agent`** (un-pin),
  not hang/error; un-pinned `agent` stays a legal "overall" target (online-first).
- R3: collapse every `assigneeType==="agent"` site through **two shared helpers**; fix the
  two same-root bugs in passing.
- R4: `AgentInstance` ↔ `DaemonConnection` = **two tables + FK**, liveness stays on the
  connection; mention keeps the `?cwd=&host=` wire codec; wake lineage =
  `task override ?? root idea instance ?? online-first`; InstancePicker lists **online
  instances only**.
- R5: same-agent inheritance guard; **no new Idea/Task columns** (reuse
  `assigneeType`/`assigneeUuid`); **no GC**; `AgentInstance` fields = identity triple +
  `companyUuid` + timestamps only.

## Goals / Non-Goals

**Goals.** One durable instance abstraction reused by assignment + mention; idea-rooted
pin-once-inherit; close the elaboration-resolve wake gap; no silent drop of instance-pinned
work anywhere; comprehensive regression coverage.

**Non-Goals.** Soft-delete/GC of instances; declaring not-yet-connected instances; changing
mention wire format; re-pinning UX beyond the secondary instance menu; touching #358 badge
rendering.

## Data model

### New: `AgentInstance`

```prisma
model AgentInstance {
  id          Int      @id @default(autoincrement())
  uuid        String   @unique @default(uuid())
  companyUuid String
  company     Company  @relation(fields: [companyUuid], references: [uuid])
  agentUuid   String
  agent       Agent    @relation(fields: [agentUuid], references: [uuid], onDelete: Cascade)
  host        String   @default("") // "" = unknown-host (matches DaemonConnection.host sentinel)
  cwd         String?               // null = unknown-path (matches DaemonConnection.cwd sentinel)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  connections DaemonConnection[]    // connections that have served this instance

  @@unique([companyUuid, agentUuid, host, cwd])
  @@index([companyUuid])
  @@index([agentUuid])
}
```

Rationale for the sentinels: they mirror `DaemonConnection` exactly (`schema.prisma:421`
`host @default("")`, `:438` `cwd String?`), so the upsert key derived from a connection maps
1:1 to an `AgentInstance` key. **No** `firstSeen/lastSeen/status` — those are connection
properties (R5); online/last-seen is read through the FK'd `DaemonConnection`.

> ⚠ Postgres treats `NULL` as distinct in a UNIQUE index, so `(…, host, cwd=NULL)` rows do
> **not** dedup — the exact caveat already documented on `DaemonConnection.cwd`
> (`schema.prisma:426-438`). We reuse the established pattern: the upsert for a `null` cwd
> goes through a `findFirst`+`create/update` path (mirroring
> `registerConnection()`'s null-cwd branch at `daemon-connection.service.ts:326-344`), not a
> compound-key `upsert`.

### Modified: `DaemonConnection`

Add a nullable FK to the instance it currently serves:

```prisma
  agentInstanceUuid String?
  agentInstance     AgentInstance? @relation(fields: [agentInstanceUuid], references: [uuid], onDelete: SetNull)
```

Nullable because rows existing at migration time have no instance yet; they get linked on
the next handshake (same "rebuild on reconnect" story as the dropped Task columns). Existing
`@@unique([agentUuid, clientType, host, cwd])` is unchanged. Liveness is unchanged:
`effectiveStatus = status==="online" && (now - lastSeenAt) <= STALE_THRESHOLD_MS (90s)`
(`daemon-connection.service.ts:154-156`).

### Modified: `Idea` / `Task` — columns dropped, none added

- **Drop** `Task.targetHost`, `Task.targetCwd` (`schema.prisma:226-227`).
- **No** new columns. A pinned assignment is expressed purely through the existing
  polymorphic pair: `assigneeType="agent_instance"`, `assigneeUuid=<AgentInstance.uuid>`.
  Inheritance = the child simply has `assigneeType="agent"` (or no assignee) and resolves
  through its root idea.

## Polymorphic assignee: the third type

`assigneeType ∈ {"user","agent","agent_instance"}`:

| State | assigneeType | assigneeUuid | "belongs to agent" resolves via |
|---|---|---|---|
| user | `user` | User.uuid | n/a |
| agent, un-pinned | `agent` | Agent.uuid | itself |
| agent, pinned to instance | `agent_instance` | AgentInstance.uuid | `AgentInstance.agentUuid` |

The critical hazard: an `agent_instance` row's `assigneeUuid` is an **instance** uuid, not an
agent uuid — so any "assigned to agent A" query written as a flat
`{assigneeType:"agent", assigneeUuid:A}` equality **cannot match it**. This is why a shared
query/resolution helper is mandatory, not stylistic.

## Module contracts

### `src/lib/uuid-resolver.ts` (new helpers)

```ts
export type ActorType = "user" | "agent" | "agent_instance";

// Canonical agent uuid behind an assignment, for ownership checks & wake recipients.
//   agent          → assigneeUuid (as-is)
//   agent_instance → AgentInstance(assigneeUuid).agentUuid   (DB lookup)
//   user           → null
export async function resolveAssigneeAgentUuid(
  companyUuid: string,
  assigneeType: string | null,
  assigneeUuid: string | null,
): Promise<string | null>;

// Prisma OR-clause that matches every assignment belonging to `auth` —
// user rows, agent rows (assigneeUuid=actor), AND agent_instance rows whose
// instance.agentUuid=actor (expressed as a relation/subquery, NOT flat equality).
export function buildAssigneeMatch(auth: AuthContext): Prisma.<Idea|Task>WhereInput["OR"];
```

`buildAssigneeMatch` replaces `getAssigneeConditions()` (`idea-tracker.service.ts:66-79`).
The `agent_instance` arm cannot be a flat `{assigneeType,assigneeUuid}` literal; it is a
filter like `{ assigneeType: "agent_instance", assigneeUuid: { in: <my instance uuids> } }`
(resolved from `AgentInstance where agentUuid=actor`) or an equivalent relation filter. The
agent's owner-as-assignee `user` arm is preserved.

### `src/services/daemon-connection.service.ts`

`registerConnection()` (`:278-369`) additionally **upserts the AgentInstance** for
`(companyUuid, agentUuid, host, cwd)` and sets `agentInstanceUuid` on the connection row in
the same transaction. The null-cwd path reuses the existing findFirst+update branch. New:
`resolveInstanceForConnection()` / instance lookup by `(company, agent, host, cwd)` for the
wake path. `ConnectionView` may surface `agentInstanceUuid` (additive).

### `src/services/notification-turn.ts`

> **Soft vs hard pins (resolves review BLOCKER).** The shipped code (verified at
> `notification-turn.ts:278-304` + header `:30-35`) treats an offline pin as `offline_pin` =
> **notify-only, NO wake** — a *deliberate reversal of #354* so a mention pin is never
> silently re-routed to a cwd the author did not choose. The ratified R2 decision, however,
> says an **assignment** pin to an unreachable instance **degrades to a plain agent**
> (online-first). These are not in conflict once we separate the two pin *sources*:
>
> - **Hard pin = mention** (`trigger==="mentioned"`): a human typed an exact place in markup.
>   Offline → **notify-only, no wake** (unchanged; preserves the #354 reversal, ratified
>   again in R4/q12 "mention wire format unchanged").
> - **Soft pin = assignment** (task `agent_instance` override, or inherited idea instance):
>   the pin is the *assignee identity*, which R2 says **becomes a plain agent** when its
>   instance is unreachable. Offline → **degrade to agent-overall online-first**.
>
> `PinnedTarget` therefore carries its origin: `{ host, cwd, soft: boolean }`. The hard path
> sets `soft:false`; the assignment/inheritance paths set `soft:true`.

`resolvePinnedTarget()` (`:200-234`) generalizes from "(host,cwd) from task columns / mention
suffix" to instance-based lineage:

```
resolve(ctx, trigger):
  1. mention pin (trigger==="mentioned"): ctx.pinnedHost/pinnedCwd → AgentInstance
        → PinnedTarget{host,cwd, soft:false}            // HARD
  2. task override: the wake's task row has assigneeType==="agent_instance"
        → its AgentInstance → PinnedTarget{..., soft:true}    // SOFT
  3. root-idea inheritance: resolve the wake's root idea; if its assignee is agent_instance
        AND that instance.agentUuid === the wake's target agent  (SAME-AGENT GUARD)
        → idea's AgentInstance → PinnedTarget{..., soft:true}  // SOFT
  4. else null → caller falls to agent-overall online-first
```

`selectOriginConnection()` (`:278-304`) gains one branch: when a pin matches no online
connection, a **hard** pin returns `offline_pin` (notify-only, `suppressWake:true`, exactly
as today), while a **soft** pin falls through to the existing online-first selection (the R2
graceful un-pin) — no new hang/pending state, and `suppressWake` stays `false` so the
agent's online-first connection wakes. The un-pinned and `none` paths are byte-identical to
today.

**Elaboration / idea wakes (corrects the proposal's overstated "gap").** `elaboration_verified`
already upgrades an un-pinned selection to the idea's existing **session origin** when online
(`:458-472` via `resolveElaborationVerifiedTarget`). This change inserts the idea's
**assignee-instance** as a *higher-priority* soft source (step 3 above): if the idea is pinned
to an instance, the wake targets that instance; only when there is no assignee-instance does
it fall to the existing session-origin upgrade, then online-first. `idea_claimed` genuinely
gains pin-reading (it had none). Net: the idea's explicit instance pin now leads, the
session-origin heuristic remains as the un-pinned fallback.

### `src/services/idea.service.ts` / `task.service.ts`

- `claimIdea`/`assignIdea`/`claimTask`/`assignTask` accept an optional instance reference and
  persist `assigneeType="agent_instance"` + `assigneeUuid=<instance uuid>` when pinned, else
  `agent`. `task.service` **stops** reading/writing `targetHost/targetCwd` (columns gone).
- Re-assignment: an idea may move agent→agent, instance→instance, or back to plain agent.

### `src/services/mention.service.ts` / `src/lib/mention-format.ts`

Wire format unchanged. `parseMentions` still uses `decodePinSuffix(match[4])`; the
`(pinnedHost, pinnedCwd)` it yields are now interpreted as "find the `AgentInstance` for
this agent at `(host,cwd)`" when threading the wake. No regex/codec change.

### Ownership gates & recipients

`proposal.service.ts:464`, `elaboration.service.ts:44/291/432`, the MCP release/report gates
(`pm.ts`, `developer.ts`, `public.ts`), and `notification-listener.ts` recipient resolution
all route through `resolveAssigneeAgentUuid()` so an `agent_instance` assignment is treated
as belonging to its agent. A wake recipient is always `{type:"agent", uuid:<resolved agentUuid>}`
— never an instance uuid.

### UI

- `assign-idea-modal.tsx`: add InstancePicker (online instances only) + re-assignment
  (agent / different agent / instance via secondary menu / back to plain agent).
- `assign-task-modal.tsx`: optional override instance; default = inherit root idea.
- `task-detail-panel.tsx:292` `isAssignedToMe`: compare **type AND uuid** (bug fix), and treat
  `agent_instance` as the current agent when the instance's agent is me.
- Dedup `InstanceCandidate` (`instance-picker.tsx`) and `AgentInstanceCandidate`
  (`tasks/[taskUuid]/actions.ts`) into one shared shape.
- Assignee rendering shows the instance `(host,cwd)` via existing
  `daemon-instance-format` helpers.

## Migration plan (DDL-only, no DML)

Two Prisma migrations (authored via CLI per repo policy — `schema.prisma` edited first, then
`prisma migrate dev`), split to keep every wave's `tsc` green (resolves review NOTE 1: the
last reader of `targetHost/targetCwd` is removed only in T5/T6, so dropping the columns in
the very first task would break compilation mid-DAG):

- **Migration A (T1, additive — runs first, breaks nothing):**
  1. `CREATE TABLE AgentInstance` (+ unique + indexes).
  2. `ALTER TABLE DaemonConnection ADD COLUMN agentInstanceUuid` (nullable).
  Task pin columns remain so existing readers still compile.
- **Migration B (T11, destructive — runs last, after all readers removed):**
  3. `ALTER TABLE Task DROP COLUMN targetHost, DROP COLUMN targetCwd`.

No `UPDATE`/`INSERT` backfill (repo rule: migrations are DDL-only). Existing dev pins on the
dropped columns are intentionally discarded; daemons rebuild `AgentInstance` rows + the
connection FK on next handshake. `relationMode="prisma"` → relations enforced in app code,
matching the codebase. After each migration run `prisma generate` + restart dev server
(pitfall #1).

## Test plan (regression-first — explicit user mandate)

Coverage thresholds enforced by `vitest.config.ts`: **95% lines/statements, 85% branches,
93% functions**. Unit tests mock Prisma via `vi.hoisted()` factories (pattern in
`src/services/__tests__/daemon-execution.service.test.ts`); integration tests use the
in-memory fixture-Prisma pattern (`src/__tests__/integration/cascade-move.integration.test.ts`).

**Unit:**
- `uuid-resolver`: `resolveAssigneeAgentUuid` for all three types (incl. instance→agentUuid
  lookup, user→null, unknown→null); `buildAssigneeMatch` shape for agent vs user auth,
  asserting the `agent_instance` arm targets instance uuids (not actor uuid).
- `daemon-connection.service`: AgentInstance upsert on register (new + existing identity),
  null-cwd path, connection FK set, instance resolution by tuple.
- `notification-turn.resolvePinnedTarget`: each lineage branch — mention pin, task override,
  root-idea inheritance **with** same-agent match, root-idea **cross-agent → no inherit**,
  resolved-but-offline → null (degrade), un-pinned → null. Explicitly covers the
  elaboration-resolve / Verify-Elaborate trigger reading the idea instance.
- `idea-tracker`: `ideaTracker`/`taskTracker` now include `agent_instance`-assigned rows
  (the original bug) and still include owner-as-assignee `user` rows.
- ownership gates + recipient resolution: `agent_instance` treated as its agent.

**Integration (pseudo-e2e lifecycle):** seed agent + two instances; assign idea to instance
A → derive proposal+task (inherit A) → wake resolves to A → take A offline → wake degrades to
online-first → re-pin to B via re-assign → wake resolves to B. Assert no instance-pinned
entity is ever dropped from "my assignments" across the lifecycle. A cross-agent task in the
same idea must resolve to its own agent, not inherit A.

**Negative/regression guards:** a flat `{assigneeType:"agent"}` query must be proven (by
test) to miss instance rows, locking in *why* the helper exists; mention wire format
byte-stability (reuse #358's codec tests).

# Daemon uses the direct idea UUID as `--session-id`

## Why

When the `chorus daemon` spawns a headless `claude -p` subprocess, the session id today is a **client-generated random UUID** stored in a side map (`~/.chorus/sessions.json`, keyed by root idea). That makes a human takeover painful: to `claude --resume` the session a human must first dig through `~/.claude/projects/<cwd-escaped>/*.jsonl` and guess which transcript belongs to the work they care about, because headless (`-p`) sessions never appear in the interactive `--resume` picker — they are resumable only by exact id.

This change makes the session id **deterministic and human-knowable**: the daemon spawns with `--session-id = the dispatched entity's direct idea UUID`. Then takeover needs no lookup table — **the idea UUID *is* the session id**:

```
claude --resume <idea-uuid>
```

It also lets the daemon drop the persisted random-id map entirely: with a deterministic id, the map degenerates to an identity function.

### Anchor correction: direct idea, not root idea

The original daemon (capability `cli-daemon`) anchored the session on the **root idea** of the lineage — walking `task → proposal → idea → parentUuid … → topmost ancestor`. Elaboration of this change **corrected that decision to the *direct* idea**: the idea the dispatched entity attaches to directly (`task → proposal.inputUuids[0] → that idea`), with **no `parentUuid` upward walk** for the purpose of session anchoring.

Consequence (confirmed intended): parent and child ideas get **separate** Claude sessions — cross-idea context no longer accumulates; multiple tasks under the **same** direct idea still share one session. "One idea, one session." This is simpler than the root anchor and matches the intuition that an idea is the unit of a conversation.

The true root idea is still resolved and still reported in the daemon's execution snapshot (it powers the connection-observability UI, capability `daemon-execution-state`) — only the **session-anchor key** changes from root to direct idea.

## What Changes

- **`root-idea-resolution` (MODIFIED, additive):** the `GET /api/entities/{type}/{uuid}/root-idea` response gains a `directIdeaUuid` field — the first idea node on the resolved `lineage[]` (child→root). `rootIdeaUuid`, `lineage`, `resolvedVia`, `ambiguous`, `candidates` are unchanged. Purely additive; no existing consumer breaks.
- **`cli-daemon` (MODIFIED):** the "Lineage-anchored session continuity" requirement is re-anchored from root idea to **direct idea**; the session id passed to `claude` is the direct idea UUID itself (not a random UUID); the build-vs-resume decision is made by **probing the on-disk transcript** for `<idea-uuid>.jsonl` rather than consulting a persisted map; the persisted random-id session map is **removed**; the session id is **pre-validated as a lowercase UUID** before spawn, and any spawn failure is logged visibly (no silent error). The "Per-root-idea wake serialization" requirement is re-keyed to **per-direct-idea**.

### Capabilities touched

| Capability | Change |
|---|---|
| `root-idea-resolution` | Add `directIdeaUuid` to the endpoint response (additive) |
| `cli-daemon` | Re-anchor session continuity + serialization to direct idea; deterministic session id; disk-probe build/resume; remove session map; pre-validate id |

## Impact

- **Affected code (server):** `src/services/lineage.service.ts` (derive + return `directIdeaUuid`), `src/app/api/entities/[type]/[uuid]/root-idea/route.ts` (passes the result through unchanged — field flows automatically), tests under `src/services/__tests__/lineage.service.test.ts` and the route test.
- **Affected code (daemon, `cli/`):** `cli/lineage.mjs` (consume `directIdeaUuid`), `cli/waker.mjs` (`keyFor` → direct idea; pass deterministic session id), `cli/claude-spawner.mjs` / new `session id` resolution (disk-probe new-vs-resume; UUID pre-validation), removal of `cli/session-map.mjs` and its wiring in `cli/daemon.mjs`, tests under `cli/__tests__/`.
- **Behavior change:** sibling ideas (and parent/child ideas) that previously shared one session now get isolated sessions. This is the intended new behavior, not a regression. Documented in the spec.
- **Coordination:** the parallel/serial dispatch model idea (`6fab91cd`) must use **direct idea UUID** as the serialization key — a coordination note has been posted there.
- **No migration:** the daemon code is unreleased; the removed session map has no production install base to migrate.
- **Out of scope:** how the daemon chooses/maintains its working directory (cwd) across ideas and repos, and how the takeover command/cwd is surfaced to humans — split into a separate idea ("Daemon agent run-directory management"). This change only guarantees a deterministic session id and visible spawn failures; it does not print a takeover hint at runtime.

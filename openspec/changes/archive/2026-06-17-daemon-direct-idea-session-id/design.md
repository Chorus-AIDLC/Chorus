# Technical Design: Daemon direct-idea session id

## Overview

Two coordinated changes:

1. **Server (additive):** the root-idea-resolution endpoint already computes the full `lineage[]` (child → root). The *direct idea* is just the **first `type: "idea"` node** on that path. Expose it as a new `directIdeaUuid` field. No new traversal, no new query — derived from data already in hand.
2. **Daemon (`cli/`):** switch the session anchor from root idea to direct idea; make the session id deterministic (= direct idea UUID); decide new-vs-resume by probing the transcript file on disk; delete the persisted random-id session map; pre-validate the id before spawn.

```
notification ──► LineageResolver (REST) ──► { rootIdeaUuid, directIdeaUuid, lineage, ... }
                                                   │              │
                          serialization key ◄──────┘ (direct)     │ (direct)
                          execution snapshot rootIdeaUuid ◄───────┘ ... wait, see below
```

> Clarification on the two fields' roles in the daemon:
> - **`directIdeaUuid`** → the **session anchor**: the `--session-id` / `--resume` value AND the `WakeQueue` serialization key.
> - **`rootIdeaUuid`** → unchanged role: reported in the execution snapshot for the observability UI (`daemon-execution-state`). Still resolved, never used for anchoring anymore.

## Server: deriving `directIdeaUuid`

`resolveRootIdea` returns `lineage: LineageNode[]` ordered input-entity → root. The direct idea is the first node with `type === "idea"`:

```ts
const directIdeaUuid = result.lineage.find((n) => n.type === "idea")?.uuid ?? null;
```

- For `type: "idea"` input: lineage[0] is the idea itself → directIdeaUuid === that idea (NOT its root, when it has a parent). Correct: the entity's *own* idea is the direct idea.
- For `task`/`document` → proposal → idea: the first idea node is `inputUuids[0]`'s idea (the proposal's primary input idea) — exactly the "direct idea" of the dispatched entity.
- No idea ancestor (quick task, standalone doc, non-idea proposal): no idea node on the lineage → `directIdeaUuid: null` (same null cases as `rootIdeaUuid`).

This is computed in `lineage.service.ts` and added to `ResolveRootIdeaResult`; the route passes the whole result through `success(result)` unchanged, so the field appears automatically. **`rootIdeaUuid` semantics are untouched** — multi-idea `ambiguous`/`candidates` still describe roots.

### Module contract (server)

`ResolveRootIdeaResult` gains:
```ts
/** The direct idea the entity attaches to — first idea node on `lineage` (child→root). null when no idea ancestor. */
directIdeaUuid: string | null;
```
Invariant: when `lineage` contains ≥1 idea node, `directIdeaUuid` is the **first** such node's uuid and `rootIdeaUuid` is the **last**; when the entity's direct idea has no parent the two are equal.

## Daemon: anchor on direct idea

### `cli/lineage.mjs`
`rootIdeaFor(event)` becomes (or is joined by) a resolver returning `{ rootIdeaUuid, directIdeaUuid }`. The same single REST call now yields both — parse `data.directIdeaUuid` alongside `data.rootIdeaUuid`. On any failure both are null (unchanged degradation path).

### `cli/waker.mjs` — `keyFor()` and the two-id contract
```
key = directIdeaUuid ? `idea:${directIdeaUuid}` : `entity:${type}:${uuid}`
```
The serialization key and the session anchor are the same value (the direct idea).

> **⚠️ Load-bearing correctness contract — do not slice root out of the key.**
> Today the waker derives the execution snapshot's `rootIdeaUuid` by string-slicing
> the serialization key: `key.startsWith("idea:") ? key.slice("idea:".length) : null`
> (`cli/waker.mjs:110` in `markQueued`, `:169` in `wake`). That worked only because the
> key WAS the root idea. After this change the key carries the **direct** idea, so the
> sliced value is the direct idea — slicing would silently mis-report the snapshot's
> `rootIdeaUuid` as the direct idea and break root attribution for the
> `daemon-execution-state` observability UI (sibling `f2fe9a7f`).
>
> Therefore the resolver MUST surface **both** ids and the waker MUST thread them
> **separately**: `directIdeaUuid` → the key/anchor; the **resolved `rootIdeaUuid`** →
> the execution registry entry and the uploaded snapshot. Remove the slice-from-key
> derivation of root entirely. `keyFor` either returns both (e.g. `{ key, rootIdeaUuid }`)
> or the router/waker carries the resolved `rootIdeaUuid` alongside the key down to
> `markQueued`/`wake`. The snapshot's `rootIdeaUuid` is the server-resolved root,
> never re-derived from the (now direct-idea) key.

Invariant: when a notification resolves with `directIdeaUuid !== rootIdeaUuid`, the
serialization key / session id is the **direct** idea and the snapshot's `rootIdeaUuid`
is the **root** idea — the two are not interchangeable and neither is derived from the other's wire form.

### `cli/waker.mjs` → spawner: thread `cwd`
The disk-probe (below) needs the spawn `cwd` to compute the transcript path, and the
spawner already accepts a `cwd` param (`ClaudeSpawner.wake({ ..., cwd })`) but the waker
does not pass one today (`cli/waker.mjs:189-200`), so it defaults to `process.cwd()`.
The waker MUST pass the daemon's spawn working directory explicitly, and the **same**
`cwd` value MUST be used both for the disk-probe and for the spawn — otherwise the probe
checks a different directory than the session is created in and new-vs-resume is decided
against the wrong transcript.

### Session id: deterministic, no map
`SessionMap` and `~/.chorus/sessions.json` are removed. The session id is the direct idea UUID directly. New-vs-resume is decided by **probing the transcript file**:

```
sessionId = directIdeaUuid (lowercased, validated)
transcriptPath = join(configDir, "projects", escapeCwd(cwd), `${sessionId}.jsonl`)
isNew = !existsSync(transcriptPath)
→ isNew ? --session-id sessionId : --resume sessionId
```

- `configDir` = `process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")`. **Honor `CLAUDE_CONFIG_DIR`** — do not hardcode `~/.claude`.
- `cwd` is the daemon's spawn cwd (the same `cwd` already passed to `ClaudeSpawner.wake`).

#### `escapeCwd` — verified on disk
Claude Code names the per-project transcript dir by replacing **both `/` and `.`** in the absolute cwd with `-`. Verified against the live machine:

| cwd | dir name |
|---|---|
| `/home/ubuntu/dev/ai-pm` | `-home-ubuntu-dev-ai-pm` |
| `/home/ubuntu/.claude-mem/observer-sessions` | `-home-ubuntu--claude-mem-observer-sessions` |

So: `cwd.replace(/[/.]/g, "-")` on POSIX. **Windows differs** (drive letters, backslashes) and is the load-bearing cross-platform risk — see Risks. The probe is **Claude Code-specific**: other agent CLIs (codex/opencode) do not write `~/.claude/projects/<cwd>/<id>.jsonl`, so this disk-probe path must be gated to the Claude Code spawner and not assumed for a future agent-agnostic spawner.

> **Why disk-probe over the old map or an error-string fallback:** the disk is the source of truth `claude --resume` itself consults; a probe is stateless, survives daemon restarts, and never drifts from reality (a manually-deleted transcript correctly reads as "new"). A persisted seen-set drifts (delete/reinstall/cross-machine); a "try --resume, parse the `No conversation found` error" approach is brittle and violates the no-silent-errors / don't-branch-on-error-text posture.

### `cli/claude-spawner.mjs` — pre-validate the id
Before building argv, validate the session id is a well-formed UUID and lowercase it:

```
const id = String(directIdeaUuid).toLowerCase();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
  logger.error(`[Chorus] refusing to spawn: session id is not a valid UUID: ${directIdeaUuid}`);
  return { sessionId: id, exitCode: null, isNew };   // visible, no throw, no spawn
}
```
Chorus idea UUIDs are already lowercase v4 — this is a cheap guardrail, not a reformat. Any spawn failure (bad id, non-zero exit, ENOENT) continues to log visibly and resolve with a failure result; the daemon never crashes on one bad wake.

## Build / resume decision table

| transcript `<id>.jsonl` on disk | flag | meaning |
|---|---|---|
| absent | `--session-id <idea-uuid>` | first wake for this idea → create the session under the deterministic id |
| present | `--resume <idea-uuid>` | continue the same session (later task / @-mention / rejection on the same idea) |

A `--session-id` collision (id already exists) cannot arise on the happy path because we probe first; if the disk state changes between probe and spawn the existing non-zero-exit logging covers it (no silent failure).

## Risks & Mitigations

- **Windows transcript path divergence.** The `escapeCwd` rule and `CLAUDE_CONFIG_DIR` resolution must match Claude Code's Windows behavior (drive letter, backslash → dash). *Mitigation:* implement `escapeCwd` platform-aware and unit-test POSIX + Windows cwd inputs; if the Windows escaping can't be confirmed, the probe degrading to "treat as new" only costs a `--session-id` collision which surfaces as a visible non-zero exit (not silent). Verify the actual rule against a Windows Claude Code install before claiming Windows support.
- **Probe/spawn TOCTOU.** Negligible: the daemon serializes wakes per idea key, so no concurrent wake races the same transcript; cross-process races (a human resuming the same id concurrently) surface as a visible claude error.
- **Losing root context.** Intended: parent/child ideas are now isolated sessions. Documented in the spec so it isn't mistaken for a regression.
- **Sibling coordination (`6fab91cd`).** The parallel/serial model must key on direct idea; coordination comment posted. If that idea ships a different key, the two must reconcile before either merges.
- **Hallucination guard.** `claude` CLI flag names (`--session-id`, `--resume`, `--output-format stream-json`), the transcript path layout, and `CLAUDE_CONFIG_DIR` were verified against Claude Code 2.1.177 and the live filesystem; re-verify against the installed CLI version at implementation time rather than trusting memory.

## Implementation order

1. Server: derive + return `directIdeaUuid` (+ tests). Additive, independently shippable.
2. Daemon: consume `directIdeaUuid` in `lineage.mjs`; re-key `keyFor`; add disk-probe + UUID pre-validation in the spawn path; remove `session-map.mjs` and its wiring (+ tests).
3. Integration checkpoint: end-to-end — a real notification resolves to a direct idea, the daemon spawns with `--session-id <idea-uuid>`, the transcript lands at `<cwd-escaped>/<idea-uuid>.jsonl`, and a second wake for the same idea resumes it.

# Converge phantom `running` turns

## Why

A daemon-woken agent subprocess ends, but the Chorus UI keeps showing the conversation as
running and offers no way to stop it. The turn stays `running` forever.

Evidence gathered on the reporting host (Chorus 0.18.x, `ip-172-31-44-248`):

1. **A dropped terminal report orphans the turn permanently.** `cli/waker.mjs` advances the
   turn `running → ended | interrupted` after the subprocess exits. The report travels
   through `cli/turn-reporter.mjs` → `cli/daemon-rest-client.mjs`, which has **no retry of
   any kind**. One transport failure loses the terminal edge for good. Observed
   2026-09-15 21:03:08 (pi, session `4e0683ee-…`):

   ```
   [Chorus] pi exited with code 143
   [Chorus] wake for idea:4e0683ee… exited non-zero (143)
   [Chorus] turn-advance request failed: TypeError: fetch failed
   [Chorus] ✓ wake done: idea:4e0683ee… (exit=143, 40986813ms)
   ```

   These failures cluster: the minutes before that line are a solid run of
   `connection-heartbeat request failed` / `SSE connection failed`. The moment the terminal
   report matters most is exactly the moment it is most likely to fail.

2. **The server-side backstop cannot reach this case.** `reconcileOrphanTurns`
   (`src/services/daemon-session.service.ts`) finalizes a connection's `running` turns as
   `interrupted(offline)` only when the origin connection's `lastSeenAt` is older than
   `STALE_THRESHOLD_MS` (90s). A daemon that is alive and heart-beating is never
   orphan-eligible, so a turn orphaned by a single lost report is never collected.

3. **The interrupt control is not even rendered for a phantom turn.**
   `src/components/agent-presence/send-instruction-box.tsx` derives the control from an
   *execution row*, not from the turn:

   ```tsx
   const exec = controllableExecution ?? null;
   const execControl = exec ? (exec.status === "running" ? <InterruptButton exec={exec} /> : …) : null;
   ```

   A phantom turn is precisely "turn still `running`, execution row already gone", so
   `exec === null` and nothing renders. The UI shows "running" with no control at all.

4. **A no-child interrupt is a silent local no-op.** When a command does arrive,
   `cli/control-handler.mjs` returns without telling the server anything:

   ```js
   if (!entry || entry.status !== "running" || !entry.child) {
     logger.info(`[Chorus] control: no running subprocess for ${key} on this daemon; ignoring interrupt`);
     return;
   }
   ```

   The natural moment to converge the turn — a human explicitly asking for it — is thrown
   away.

5. **Spawners wait on `close`, which a detached descendant can hold open forever.** All five
   spawners (`pi`, `claude`, `codex`, `kiro`, `dsh`) resolve their wake on `child.on("close")`.
   `close` fires only after every stdio handle is closed, so a backgrounded grandchild that
   inherited the pipes keeps the wake "running" after the agent process itself has exited.
   Upstream pi solved the same problem in its own bash tool — `dist/core/tools/bash.js`
   comments "wait for the process to terminate without hanging on inherited stdio handles
   held by detached descendants" and awaits **exit**, not close.

## What Changes

Four changes, all narrow, no new infrastructure and no new dependency:

1. **Bounded retry on the terminal turn-advance edge** (`cli/daemon-rest-client.mjs`). Only
   the `ended` / `interrupted` edge retries, only on retryable failures (network error,
   429, 5xx). A 4xx is a verdict, not a blip — never retried.
2. **A no-child interrupt reports the truth** (`cli/control-handler.mjs`). Instead of the
   silent `return`, the daemon advances the session's turn to `interrupted(user)` so the UI
   converges immediately.
3. **A `running` turn always offers an interrupt control** (`send-instruction-box.tsx`,
   `execution-row.tsx`, `transcript-view.tsx`, `POST /api/daemon/control`). The control is
   driven by the turn, not by the presence of an execution row; when the server's own state
   shows no live run that could act on the command — the connection is offline, **or** it
   reports no `running` execution for the entity (the zombie-SSE case) — the server settles
   the turn itself, so a human can always clear a zombie.
4. **Spawners become exit-authoritative** (new `cli/child-exit.mjs`, applied to all five
   spawners). Resolve on `exit` with a short grace for stdio flush; `close` still resolves
   immediately when it arrives first.

## Capabilities

| Capability | Delta |
|---|---|
| `daemon-rest-client` | ADDED: bounded retry of the terminal turn-advance edge |
| `daemon-interrupt-resume` | ADDED: no-child interrupt reports terminal turn; turn-driven interrupt control; server-side settle when no live run can act on the interrupt |
| `daemon-spawner-interface` | ADDED: exit-authoritative wake settlement across all spawners |

## Impact

- `cli/daemon-rest-client.mjs`, `cli/turn-reporter.mjs` (pass-through only)
- `cli/control-handler.mjs`, `cli/daemon.mjs` (inject the turn reporter into the control handler)
- `cli/child-exit.mjs` (new), `cli/pi-spawner.mjs`, `cli/claude-spawner.mjs`,
  `cli/codex-spawner.mjs`, `cli/kiro-spawner.mjs`, `cli/dsh-spawner.mjs`
- `src/app/api/daemon/control/route.ts`, `src/services/daemon-session.service.ts`,
  `src/services/daemon-execution.service.ts` (reuse `isConnectionLive`; add
  `hasRunningExecution`)
- `src/components/agent-presence/execution-row.tsx`,
  `src/components/agent-presence/send-instruction-box.tsx`,
  `src/components/agent-presence/chat/transcript-view.tsx`
- `messages/{en,zh,ja,ko}.json` (zombie-clear copy)
- No Prisma schema change. No new `interruptedReason` value (`user` is reused).

## Explicitly out of scope

Decided by the requester during elaboration:

- **No timeouts of any kind** — no wake-duration watchdog, no default bash timeout in the
  pi extension. Rationale (requester, verbatim): 「先不管超时吧，不安全，我无法判断一个 turn
  到底要多久结束」. A guessed limit can kill a turn that is legitimately slow.
- **No idle-duration indicator** ("this turn has had no new message for N minutes").
- **No SSE control-command redelivery on reconnect.** The requester's replacement is
  「ui上一直显示打断按钮，允许手动清理僵尸」, which change 3 above implements.
- The upstream fact that pi's bash tool has **no default timeout**
  (`dist/core/tools/bash.js`: `"Timeout in seconds (optional, no default timeout)"`) is
  recorded as background only and drives no change here.

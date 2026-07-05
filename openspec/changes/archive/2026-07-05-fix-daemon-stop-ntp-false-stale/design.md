# Design: argsHint-wins identity verification

## Context

`processAlive(record, io)` in `cli/daemon-lifecycle.mjs` is the single shared
liveness verdict used by `start -d`, `status`, `stop`, and `restart`. For an
identity-carrying pid record (`{pid, startedAt?, argsHint?}`) it currently
requires **both** factors to pass:

```js
if (hint && !liveCmd.includes(hint)) return false;
if (rec.startedAt && identity.startedAt !== null && identity.startedAt !== rec.startedAt) return false;
return true;
```

The second line is the bug: `ps -o lstart=` on Linux derives its output from
`btime + starttime_ticks/HZ` at query time. A clock step between the moment
`startBackground` recorded `startedAt` and a later probe shifts the live
value, and the string-equality check misreads the same process as a
different one. The probe then reports stale and `stopDaemon` unlinks the
pidfile of a running daemon — the failure mode the code's own comments call
"the dangerous direction".

## Decision (owner-picked A over B/C)

Trust `argsHint` as the primary identity factor; demote `startedAt` to a
fallback used only when no `argsHint` was recorded:

```js
if (hint) return liveCmd.includes(hint);        // argsHint decides, alone
if (rec.startedAt && identity.startedAt !== null &&
    identity.startedAt !== rec.startedAt) return false;
return true;
```

Rationale:

- The argsHint is the full spawned command line minus the node binary — e.g.
  `/home/ubuntu/dev/ai-pm/chorus.mjs daemon --cwd /home/ubuntu/dev/ai-pm
  --cwd /home/ubuntu/dev/strands-ai-sdk`. A recycled pid landing on a
  process whose cmdline **contains that exact string** is not a realistic
  collision; the startedAt second factor adds nothing but a clock-sensitive
  false-stale channel.
- Option B (tolerance-window time compare) requires parsing lstart's 5-field
  locale-sensitive format on POSIX and CIM CreationDate on Windows — new
  parse-failure surface on every platform to defend a collision argsHint
  already rules out.
- Option C (/proc starttime ticks) is clock-free but Linux-only and needs a
  pidfile format extension; macOS/Windows would still need A's rule anyway.

`startedAt` keeps its current string-equality semantics for records that
have **no** argsHint (a startBackground write where `spec.args` was empty —
theoretical, but the record shape allows it). Legacy bare-number records are
untouched.

## Behavior table (after)

| record | probe result | verdict |
|---|---|---|
| argsHint recorded, live cmdline contains it | — | **running** (startedAt ignored) |
| argsHint recorded, live cmdline lacks it | — | stale |
| no argsHint, startedAt recorded, equal | — | running |
| no argsHint, startedAt recorded, differs | — | stale |
| identity-carrying record, identity query fails | — | running (conservative, unchanged) |
| legacy record paths | — | unchanged |

## Testing

Unit (`cli/__tests__/daemon-lifecycle.test.mjs`, injected IO — no real
processes):

1. Clock-step regression: record `{pid, argsHint, startedAt: T}`, live
   identity `{cmdline containing hint, startedAt: T+2s}` → `processAlive`
   true; `stopDaemon` signals the pid instead of clearing the pidfile.
2. Inverse guard: argsHint mismatch with **equal** startedAt → stale (the
   old code also returned stale here, but now for the right reason — prove
   startedAt cannot rescue a wrong cmdline).
3. No-argsHint fallback: startedAt mismatch alone still → stale; startedAt
   equal → running.
4. Existing suite green (EPERM, legacy, busybox, query-failure branches are
   already covered and must not regress).

Live verification (owner-required, r2q3=a, read-only): with the rebuilt
pidfile for the systemd-managed daemon (pid 1188) on this host,
`node chorus.mjs daemon status` must report `daemon is running (pid 1188)`.
Note the current pidfile was rebuilt with the post-step lstart so status
passes even before the fix; the unit clock-step test is what proves the fix
itself. Never signal or kill pid 1188 — the verifying agent runs inside it.

## Risks

- argsHint-only matching slightly widens the "running" verdict: a recycled
  pid whose occupant's cmdline genuinely contains the recorded hint would be
  misread as our daemon. Given the hint includes absolute script path plus
  full flag set, accepted as negligible; `stop --force` remains the escape
  hatch.

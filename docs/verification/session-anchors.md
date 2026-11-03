# Purpose-scoped daemon sessions: live verification

## Scope

This checks the server-to-CLI-daemon boundary for OpenSpec change
`split-daemon-session-anchors-by-purpose`. It uses the checkout's real
`buildDaemon` assembly, live HTTP/MCP/SSE, PostgreSQL and native Claude Code
subprocesses. There is no mocked Waker, spawner, model response or notification
transport. The model tasks are intentionally read-only routing probes, not real
development or quality-gate reviews.

The test creates a new project, one approved proposal of one Idea, two independent
tasks and two agents in an isolated database. The controller assigns both tasks
to the worker. After both complete, it mentions that same worker in a task review
request twice. Assertions require overlapping running task turns, distinct native
IDs for task/task and task/review, the same native ID on re-review, clean completion
and no reported wake errors. This reproduces the B3 same-developer/reviewer routing
case without authorizing self-approval.

## Reproduce

Prerequisites: dependencies installed, Docker with `postgres:17-alpine`, and a
working Claude Code binary. This host's model-provider configuration uses
`ANTHROPIC_*` entries in `~/.claude/settings.json`. The harness copies only those
provider entries into a private temporary Claude config, not user plugins, hooks
or production Chorus credentials. It removes the temporary settings file on normal
cleanup. OAuth-only Claude configurations need equivalent isolated authentication
setup before using this host-specific harness.

Use an independent checkout/worktree. Ports **8637 and 5433 must be free**. Never
point these commands at the installed `:18637` server or its database. The harness
hardcodes `http://127.0.0.1:8637` and rejects database URLs not on `127.0.0.1:5433`;
the operator must still ensure those listeners belong to this isolated run.

```bash
docker run --detach --rm --name chorus-anchor-e2e \
  -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5433:5432 postgres:17-alpine
until docker exec chorus-anchor-e2e pg_isready -U postgres; do sleep 1; done
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5433/postgres?sslmode=disable'
pnpm db:generate
pnpm db:push
export ANCHOR_E2E_EMAIL=anchors@isolated.local
export ANCHOR_E2E_PASSWORD="$(openssl rand -hex 24)"
CHORUS_USE_PGLITE=0 REDIS_URL='' NEXTAUTH_SECRET="$(openssl rand -hex 32)" \
  DEFAULT_USER="$ANCHOR_E2E_EMAIL" DEFAULT_PASSWORD="$ANCHOR_E2E_PASSWORD" \
  pnpm exec next dev --port 8637 > /tmp/chorus-anchor-server.log 2>&1 &
server_pid=$!
until curl --fail --silent http://127.0.0.1:8637/login >/dev/null; do sleep 1; done
node scripts/verification/session-anchors.mjs
```

The harness prints `PASS` plus the path to its secret-free `evidence.json`. Set
`ANCHOR_E2E_OUTPUT` to choose a directory; otherwise it creates one under the OS
temporary directory. It stops its own daemon after the probe. Keep evidence as
needed, then stop the Next process/process tree started above and remove only this
test database container (`docker stop chorus-anchor-e2e`). The installed runtime,
database and daemon settings must remain untouched.

Fixture setup uses authenticated local REST to provision the agents/keys and SQL
to seed the Idea/proposal/tasks; assignment and review comments use real MCP. The
daemon uses the actual `ClaudeSpawner`, its normal restricted permission mode and
`maxConcurrency: 2`, with an empty shared probe cwd allowed as a browse root. The
three-turn native limit bounds accidental model follow-ups. This is an opt-in live
check with model usage, not part of the default unit suite.

## Recorded result — 2026-11-03

**PASS**, completed at `2026-11-03T01:36:05.169Z`. Checkout branch
`feat/agent-team-5-docs`, based on integration commit `a472bb35`; Next.js 15.5.28
on **:8637**, isolated PostgreSQL 17 on **127.0.0.1:5433**, Node 24.21.0 and
Claude Code **2.1.289**. No verification traffic used the installed **:18637** runtime.

- Worker: `059ea321-5ebf-40b4-82d2-41140c5aadba` (the developer and reviewer).
- Idea: `6813167e-f13a-4f18-b85d-41c82785e251`.
- Task A: `904a95e7-4be8-46e3-8f37-53c95cefbc11`.
- Task B: `82020dc8-ace3-4596-979b-1c21d434801a`.

| Session | Reported native backend ID | Running interval (UTC, 2026-11-03) |
| --- | --- | --- |
| `task:<Task A>` | `ce7f1b8b-1fd4-5f5b-8fda-90ba553cc191` | 01:35:31.003–01:35:40.859 |
| `task:<Task B>` | `f109d988-cd27-5b8e-a9b5-c640c8c3d144` | 01:35:31.131–01:35:40.568 |
| `review:task:<Task A>`, round 1 | `bd2670fe-c0d2-5e45-b759-50240ceb2c14` | 01:35:41.399–01:35:52.258 |
| `review:task:<Task A>`, round 2 | `bd2670fe-c0d2-5e45-b759-50240ceb2c14` | 01:35:53.055–01:36:05.112 |

Both tasks occupied running turns together for **9.437 seconds**. All four turns
ended cleanly with `wakeError: null`; all native subprocesses exited 0. The daemon
reported two active executions concurrently. Its re-review log explicitly said
`resuming session bd2670fe-c0d2-5e45-b759-50240ceb2c14`, rather than spawning the
development session again. Native transcripts confirmed that the probe tasks were
read and no task lifecycle changes or review verdicts were made.

The raw, secret-free turn evidence is retained in
[`session-anchors.evidence.json`](./session-anchors.evidence.json).

Regression checks: five documentation suites, **221 tests passed**; four targeted
session-anchor/backend isolation suites, **70 tests passed**; three daemon
integration/scoped-resume/turn-lifecycle suites, **73 tests passed**. ESLint for the harness
and new tests (`--no-ignore`) passed. The skill sweep also passed the Hermes skill
suite (**31 tests**) and helper shell syntax checks.

## Limitations

- This verifies CLI Claude session routing, not native OpenClaw/Hermes/dsh behavior.
- It does not require the parallel UI task or claim browser acceptance.
- Review comments exercise the server's review-envelope routing; they are explicitly
  marked probes and do not ask the model to emit a quality verdict.
- PostgreSQL `timestamp without time zone` values written by Prisma are interpreted
  as UTC by the harness, avoiding the host timezone changing reported timestamps.
- An initial PGlite socket attempt hit connection termination errors. The recorded
  successful run uses a fresh isolated PostgreSQL container instead.

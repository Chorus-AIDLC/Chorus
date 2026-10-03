# Daemon wake error acceptance

Idea: `edec3036-1133-4c2f-abc4-a231779c587b`

Approved proposal: `6438a0d2-8163-4008-87eb-80792bde2395`

OpenSpec change: `show-daemon-wake-errors`

## Converged repository checks

After all implementation modules converged:

| Command | Result |
| --- | --- |
| `pnpm test` | 436 files / 9717 tests passed; 10 files / 237 environment-gated tests skipped |
| `pnpm exec tsc --noEmit --incremental false` | Passed without diagnostics |
| `pnpm lint` | Passed with zero errors and the same 152 warnings as the earlier full run |
| `pnpm build:local` | Production build passed, including lint, type validation and page generation |
| `pnpm db:generate` | Prisma client generated successfully |
| `DATABASE_URL='<isolated local PostgreSQL URL>' pnpm exec prisma validate` | Schema valid; existing relation-mode warning only |

The full root suite includes every CLI/server/frontend feature regression and
the en/zh/ja/ko key/ICU parity suite. OpenClaw is checked separately below.
The server, collector, reporting and UI tasks also passed independent reviews
with 283, 476, 341 CLI + 221 package, and 121 focused tests respectively; these
focused counts overlap the full runs and are not additional totals.

Repository logs remain in `/tmp/chorus-wake-{full-tests,final-tsc,build,prisma-generate,prisma-validate}.log`.

All five Chorus tasks reached `done` with every required criterion accepted.
The final aggregate code review passed on round 1, Idea comment
`1ad8445d-3970-4f9c-b80a-4dd2c7984a57`. The independent reviewer reran the full
root/package suites, production build, both typechecks and full lint, then
verified 72 collector/transport/schema/migration/projection/live-reducer paths
and 144 nonfailure diagnostic suppressions.

The completed change was archived as
`openspec/changes/archive/2026-10-02-show-daemon-wake-errors/`. All three emitted
cumulative capability specs were mirrored to their Chorus Documents at version
3 and passed the plugin's byte-exact document roundtrip verifier. The inherited
Purpose placeholders were replaced with concise capability descriptions; each
updated cumulative spec then passed strict validation.

## PR review follow-up (2026-10-03)

The human requested fixes for the two reproduced findings in Idea comment
`5c9cfae0-9d55-4082-afe4-64634b6860dc`. Follow-up task
`0bf744d5-ffd7-4524-8da8-908be84ec971` is attached to the original approved proposal.

Credential inference now excludes plural token-count settings and short,
numeric or boolean values inferred from broad TOKEN/SECRET environment names.
Explicit credentials and password/API-key environment values remain protected,
including short values. The separately published OpenClaw helper uses the same
policy. Literal, JSON/URL encoding and truncation regressions still pass.

Claude, Kiro, DSH and Pi retain stdin delivery errors as fallback diagnostics.
Authoritative backend errors take precedence, followed by drained stderr and
then the delivery fallback. The fallback remains in the details. Missing backend
text still produces a failed turn, including a raw zero exit after an undelivered
prompt. DSH's generic premature-exit message is also a fallback; Pi retains a
prompt rejection when a later pipe error arrives.

Before the implementation fix, the selected CLI regression cases had nine
failures and the matching OpenClaw configuration case failed. After the first patch:

| Command | Result |
| --- | --- |
| `pnpm test` | 436 files / 9744 tests passed; 10 files / 237 environment-gated tests skipped |
| OpenClaw package Vitest suite | 14 files / 223 tests passed; 1 file / 3 live-gated tests skipped |
| Root and OpenClaw TypeScript checks | Passed |
| ESLint on changed runtime/test files | Passed |

The regression suite includes eight real Node child-process exits across
Claude/Kiro/DSH/Pi with short and 200KB prompts, deterministic stderr-first and
stdin-first event orders, no-stderr fallbacks, and authoritative terminal errors.
These use isolated failing processes, without model-service calls. Existing
user/shutdown, session-conflict and credential-boundary tests remain passing.

Logs: `/tmp/wake-error-review-{baseline-cli,baseline-openclaw,full-tests,focused-openclaw,tsc,package-tsc,lint}.log`.

The first independent follow-up review found `B1-dsh-rpc-reason-lost`:
an RPC rejection could arrive before EPIPE, while the catch resumed after it.
DSH now records the structured rejection before rejecting its RPC waiter.
Request correlation is retained while stdout drains, so a rejection received
after EPIPE also remains attributable to the pending RPC. Three added regressions
cover initialize, prompt and shutdown, each without EPIPE and with same-callback
EPIPE both before and after the rejection. The missing precedence in each event
order was independently reproduced before its correction.
The collector/spawner/DSH correction run passed 128 tests across three files;
changed-file ESLint and `git diff --check` also passed.

## Real browser acceptance

On 2026-10-02, Chromium exercised a running Next development server on port
8637 and an isolated PGlite database on port 5433. The fixtures belonged to a
local test user, agent and daemon connection. No external model invocation was
needed. Fixture setup, authentication storage and runner scripts remained
outside the repository under `/tmp/chorus-wake-browser`; credentials were not
included in this report.

The real authenticated `POST /api/daemon/turn-advance` route accepted a
message-less Codex startup failure and a Claude execution failure with a partial
assistant reply. The owner-scoped conversation GET preserved both diagnostics
and the partial reply. The server redacted the synthetic Bearer credential.

Eight browser scenarios passed: en, zh, ja and ko, each in light and dark mode.
English used a 1440 × 1000 viewport; the other locales used 390 × 844. Each
scenario verified the failure summary, keyboard expansion and collapse, localized
exit-code text, plain-text HTML-like diagnostics, credential redaction, historical
fallback and bounded diagnostic wrapping without horizontal overflow. Reopening
the English conversation verified persistence. Screenshot inspection covered
English in both themes and Chinese in the narrow dark layout.

An additional pending turn was opened in the chat before its running and failed
states were reported through the real HTTP route. The session-scoped SSE
subscription displayed its new error without navigation or reload, and its
details expanded successfully.

The compiled OpenClaw daemon client and its real REST client also reported an
authoritative `meta.error` result through the same running Next server. The
database stored an interrupted crash on the requested turn with source
`openclaw`, preserving the specific terminal error rather than its generic error
reply payload.

The real Waker, turn-reporter wrapper and CLI REST client reported a failed
startup with no child process through the same HTTP/database path. Exactly two
reports admitted and interrupted the selected turn; its coalesced sibling became
merged. The terminal report preserved that admitted UUID and the startup
diagnostic.

Local evidence:

- `/tmp/chorus-wake-browser/acceptance.json`: eight passed locale/theme scenarios.
- `/tmp/chorus-wake-browser/live-acceptance.json`: live SSE acceptance.
- `/tmp/chorus-wake-browser/openclaw-integration.json`: real OpenClaw REST/database acceptance.
- `/tmp/chorus-wake-browser/waker-integration.json`: complete no-child Waker reporting acceptance.
- `.playwright-mcp/wake-errors-{en,zh,ja,ko}-{light,dark}.png`: screenshots.
- `.playwright-mcp/wake-errors-live.png`: live failure screenshot.

These screenshots are local, gitignored artifacts.

## Migration and package checks

The exact additive SQL migration was executed against a table containing a
historical interrupted turn, inside an isolated schema and transaction in the
local database. The existing row survived with a null diagnostic; a JSON
diagnostic could then be written and read. The transaction was rolled back.
Evidence: `/tmp/chorus-wake-browser/migration-check.json`.

OpenClaw checks:

```sh
# Run from packages/openclaw-plugin; the root suite excludes this package.
/home/ubuntu/dev/Chorus/node_modules/.bin/vitest run --config vitest.config.ts

# Run from the repository root.
pnpm exec tsc -p packages/openclaw-plugin/tsconfig.json \
  --outDir /tmp/chorus-wake-openclaw-build
pnpm exec eslint packages/openclaw-plugin/src/daemon-client.ts \
  packages/openclaw-plugin/src/daemon-rest-client.ts \
  packages/openclaw-plugin/src/wake-error.ts \
  packages/openclaw-plugin/src/openclaw-sdk.d.ts
```

Results: 14 test files / 221 tests passed; the existing live-server-gated file
and its three tests were skipped. Compilation passed. Lint had zero errors and
two existing `_rawData` unused-variable warnings.

The optional existing live control suite was also enabled against the isolated
server. Its ordinary wake/transcript test passed, but its interrupt test timed
out after 60000 ms and its lost-ping backfill test did not recover a turn. To
isolate the change, the exact baseline plugin at
`87454319761c5a10a5e380a444762238bc3cc05a` was extracted into
`/tmp/chorus-openclaw-baseline` and the same three tests were run against the
same server with independent fixtures. It produced the same two failures:
interrupt timeout at `daemon-loop.e2e.test.ts:435` and null recovery at line 532.
Both runs had one passing and two failing tests, in approximately 78 seconds.
This establishes that the plugin changes did not introduce these failures; the
underlying control-test/environment problem was not repaired in this feature.
Neither live control suite is claimed as passing.

Evidence logs:

- `/tmp/chorus-wake-openclaw-live-tests.log`: changed plugin.
- `/tmp/chorus-wake-openclaw-baseline-live-tests.log`: original plugin.

## Environment limitations

Pencil MCP was unavailable. The encrypted `docs/design.pen` was not accessed or
edited, and no design-file update is claimed. The approved design and task record
this limitation. Playwright MCP was also unavailable; a temporary Playwright
installation with real Chromium provided the browser acceptance above.

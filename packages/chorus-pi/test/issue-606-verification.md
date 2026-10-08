# Issue #606 verification

Verified 2026-10-08 UTC / 2026-10-09 Asia/Shanghai. No production test entities,
global Pi configuration changes, commits, pushes or releases were made.

## Runtime and artifact

- Node v24.21.0; isolated Pi 1.1.0; nicobailon `pi-subagents` 0.76.1;
  `pi-mcp-adapter` 5.1.0 with script mode unset.
- Installed the local `packages/chorus-pi` source with `pi install` into separate
  native, adapter and bundled-dispatcher agent directories. Global Pi 1.0.2 was
  preserved. Main native MCP exposure was codemode; adapter exposure was direct.
- Real model: `codex-custom/global.anthropic.claude-sonnet-5-5`, thinking low.
  An initial environment-only probe found that this gateway rejects thinking
  off; no credentials or auth files are included in this evidence.
- Local Chorus: `http://127.0.0.1:8637`, fresh isolated PGlite database,
  private project `01f9a398-01d5-4677-8316-79e956ea89ec`.
- Final tested package: `chorus-aidlc-chorus-pi-0.22.0.tgz`;
  SHA-256 `064189cda8bf554c0aa214ab464252f5076a4724d6197a9bf2cf731d9448fad4`.
  This replaces the earlier `a5ed6eeb…` artifact after the aggregate review's
  adapter-file-only configuration discovery fix.

## Automated regression results

| Check | Result |
| --- | --- |
| `bash packages/chorus-pi/test/all.sh` | 286 passed, 1 skipped; static 46 passed |
| Role/MCP client tests | 39 passed |
| Agent/parser/launcher tests | 17 passed |
| Lifecycle event tests | 78 passed |
| Package validation and `check:pack` | Passed |
| Targeted ESLint | Exit 0, no errors; existing runtime and fixture logging/default-export warnings remain |
| `git diff --check` | Passed |
| `pi1-native-mcp.mjs`, Pi 1.0.2 | 16/16 passed, including actual model-visible legacy codemode access and denied mutations |
| `compat-matrix.mjs`, final artifact | 36/36 passed on 0.84.4, 0.87.1, 0.99.0, 1.0.2 |
| `config-discovery-matrix.mjs`, same artifact | 16/16 passed, generated fresh/retained configs and default/custom agent directories |
| `child-role-runtime.mjs`, local source and final artifact | Each 48/48 actual child runs passed across 12 cells |

The runtime matrix runs all three reviewers plus the worker in each host/dispatcher
cell, repeated for env, file-only and file-with-stale-inactive-backend configuration:

| Host | Dispatcher | Child exits |
| --- | --- | --- |
| Native | nicobailon | 12 × 0 |
| Native | bundled | 12 × 0 |
| Adapter 5.1.0, default script mode | nicobailon | 12 × 0 |
| Adapter 5.1.0, default script mode | bundled | 12 × 0 |

These are real installed Pi child sessions. Only the model and loopback MCP
service are deterministic fixtures. Assertions cover actual registries,
paginated discovery, successful permitted calls, backend failures, forbidden
operations producing **zero HTTP requests**, asynchronous completion, and exit
status. All 12 parent checkins and worker session create/close pairs passed;
24 config snapshots remained byte-identical after shutdown. Env cases also
override conflicting file credentials. The old artifact reproduced the adapter
file-only failure; the final artifact passed the expanded matrix. This matrix
alone is not claimed as real-model AI-DLC evidence.

Reproduction (paths name isolated installations, not repository dependencies):

```bash
ARTIFACT=/tmp/chorus-606-fix-artifact/chorus-aidlc-chorus-pi-0.22.0.tgz
node packages/chorus-pi/test/child-role-runtime.mjs --sdk-root /tmp/chorus-606-e2e.5iNxBG/sdk --artifact "$ARTIFACT"
node packages/chorus-pi/test/compat-matrix.mjs --roots /tmp/chorus-606-compat- --artifact "$ARTIFACT"
node packages/chorus-pi/test/config-discovery-matrix.mjs --roots /tmp/chorus-606-compat- --artifact "$ARTIFACT"
PI_SDK_DIR=/tmp/chorus-606-compat-1.0.2/node_modules/@earendil-works/pi-coding-agent node packages/chorus-pi/test/pi1-native-mcp.mjs
bash packages/chorus-pi/test/all.sh
pnpm --dir packages/chorus-pi run check:pack
```

SDK dependency versions are recorded in the matrix JSON, rather than assuming
all transitive Pi packages match the host's version. See `test/README.md` for
fresh installation commands; temporary paths are not durable CI prerequisites.

## Real model-driven AI-DLC

Each Pi parent created and elaborated an Idea, authored a local spec and
Proposal, dispatched a real proposal reviewer, approved the Proposal, dispatched
the worker, collected its actual implementation and submission, dispatched a
task reviewer, verified all criteria, dispatched the aggregate reviewer, and
created the required completion report. Neither the coding orchestrator nor the
fixture provider substituted for these workers/reviewers.

The deliverable was `normalize-label.mjs` plus Node tests in each isolated
workspace: reject non-strings, trim/collapse whitespace, lowercase, and handle
empty input without external dependencies. Independent reruns gave native 5/5
and adapter 4/4 passing tests. Authoritative local Chorus reads confirmed both
tasks `done`, all four dev/admin criteria `passed`, and reports attached to the
resolved Ideas.

| Entity | Native host | Adapter host |
| --- | --- | --- |
| Idea | `0044c6fa-c399-4917-b10a-4fa8ec2bef3d` | `fc00db76-04d8-4ef6-93f1-361cba73d750` |
| Proposal | `70f4a074-5618-4dc0-8ef7-32a770c580b2` | `7cc142e1-5f7b-4309-bbf2-7f9ebdabd293` |
| Task | `7db07e2d-6ca8-4194-aaea-e07a59f09ca2` | `dec62e0e-4c35-4734-92b2-c58940dca282` |
| Completion report | `44fa6909-c513-4db6-b160-56b3635affb1` | `20bbba4f-fbdc-4596-925b-fa79506ad352` |

| Host / child | Run ID | Result |
| --- | --- | --- |
| Native proposal reviewer | `f63ee538-6583-46bc-ac89-7c7bba10d58d` | PASS WITH NOTES, exit 0 |
| Native worker | `f3fb372f-ff37-449a-8851-9cc465e7a282` | Implemented/submitted, exit 0 |
| Native task reviewer | `140d5d2b-d906-420e-9fcd-d7b9d5953ea9` | PASS, exit 0 |
| Native code reviewer | `92a78b46-0224-4706-8834-17138776cb45` | PASS, exit 0 |
| Adapter proposal reviewer | `9f109adc-14c5-4d17-a013-00e2da9d4a87` | PASS WITH NOTES, exit 0 |
| Adapter worker | `65638afe-0c14-44f3-81e2-b7c896558bde` | Implemented/submitted, exit 0 |
| Adapter task reviewer | `5ba3aedf-5860-45ef-95af-c9c6996ea5b3` | PASS, exit 0 |
| Adapter code reviewer | `d3d5822a-1bf3-444d-8320-d33884609a9b` | PASS, exit 0 |

Exit codes were independently read from all eight actual child `_meta.json`
files, not inferred from verdict text. Final active Chorus sessions were empty.

## Final review and cleanup

- All three production implementation/verification/fix tasks are done.
- Independent fix-task review `c526b1b1-a4d2-4ee3-997f-7dc652412335`
  reran the full expanded matrix and broader regression suites: PASS.
- Aggregate code-review round 2 `390d8744-dcb7-4d77-a31a-2f79b128cc5f`
  independently reran all 48 children, closed `B1-adapter-config-discovery`,
  and returned PASS with no notes or blockers.
- Final local deliverable tests: 9/9 passed; active Chorus sessions: none.
  Owned local application/database processes were stopped after reviews;
  private isolated data and audit artifacts were retained for reproducibility.

## Observations and limits

- The native parent paused after proposal review despite initial YOLO wording.
  An automated continuation resumed the **same** Pi session and entities to
  completion; this was not an uninterrupted one-prompt run.
- The adapter code reviewer initially attempted bare `chorus_add_comment`,
  received tool-not-found, then correctly used `chorus_review` and posted PASS.
  This was a corrected model call, not an unavailable frontmatter requirement:
  its child metadata exit code is 0. We do not claim zero model tool-call errors.
- The adapter parent initially mistook another concurrent run's active Chorus
  session for its own leak. The native worker transcript contains
  `Session UUID: 16e75d07-65e0-424c-92ff-f4e777b14467`; an authoritative get later
  confirmed it `closed` with no checkins. The adapter's automated final audit
  rechecked its existing entities and reported E2E_COMPLETE. No sessions were
  manually closed to conceal an owned-child leak.
- The real-model runs exercised the live local plugin source with environment
  credentials. They do not establish file-only configuration coverage. Aggregate
  review round 1 caught that the original 16-child matrix also always exported
  credentials and missed modern adapter-only files. The correction selects the
  active backend for parent bookkeeping and child providers; the expanded matrix
  removes both connection environment variables in file/file-stale modes.
- Subsequent legacy-override and active-backend discovery fixes were regression
  tested independently; the real-model lifecycles were not rerun after them.
- Broad query permissions and notification-read side effects are intentional.
  Bash/inherited credentials and comment target scope are not sandboxed. These
  tests do not establish credential, network, filesystem or UUID-level security
  isolation, nor guarantee every future model response/version combination.
- Runtime root `/tmp/chorus-606-e2e.5iNxBG` contains private logs/auth state.
  Keep it local; never attach its raw files. Its safe `run.mjs` wrapper can query
  the local persisted entities without printing keys while the local service is
  running. Final sanitized matrix logs are `/tmp/chorus-606-fix-{matrix,config-matrix,native}.log`
  and `/tmp/chorus-606-fix-artifact/child-role-runtime.log`.

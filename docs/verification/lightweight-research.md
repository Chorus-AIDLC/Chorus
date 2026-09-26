# Lightweight Research verification

Idea: `fa4fb713-e37c-43a7-ae5d-825842a5cb02`. Branch: `feat/lightweight-research`.

## Completed foundations

- Server task `bae5871d-13c0-4b83-8ae7-64bec9286fbd`: independent Round 1 PASS, comment `f95289fc-63ee-4466-9694-d9b4c16f9b3d`; 112 tests, TypeScript and source ESLint passed. Local commit `cb3da4e2`.
- Shared skill task `2edee409-b153-4034-ad74-68ee3069b050`: independent Round 1 PASS, comment `1ae927e6-e57d-485e-bee0-f386cf7d4294`. Seven distributions and actual package/install checks passed. Local commit `ccdcfea7`. See `plugins/chorus/tests/research-verification.md` for commands and instruction-level walkthroughs.

## Creation dialog

`new-idea-dialog.test.tsx` and `conversational-entry.test.tsx`: 28 tests passed. Source ESLint and TypeScript passed. All four locale files contain the label and explanatory hint.

Real Chromium verification ran against `http://localhost:8637` with an isolated PGlite database on port **5435**, project `6f3ceab9-f567-4df0-9448-282c25464b1a`. The fixture connection has a simulated heartbeat; it does not run an LLM subprocess. Successful requests used the actual route/service/database. Only the first retry attempt was intercepted with a synthetic HTTP 409.

Both `chorus-theme=light` and `chorus-theme=dark` were checked, asserting the corresponding root class. At 1280×1000 and 390×844:

- The static form hides Research; the conversational pane starts unchecked and explains automatic judgment.
- Space toggles the focused checkbox. Research and decomposition can be selected together.
- A failed send retains both selections; Retry succeeds through the actual endpoint.
- Narrow layouts fit the viewport; labels and hints wrap, and the retry action remains visible.
- Successful sends close the creation dialog and hand off the returned Idea-root session.
- Response request bodies carry `researchFirst: false` or `true` as selected; persisted prompts contain automatic or explicit research intent. Decomposition remains independently enabled.

Successful persisted fixtures:

| Theme | Scenario | Idea | Turn |
| --- | --- | --- | --- |
| Light | Default | `cd8d01ce-34ec-454e-9b80-9212bd11d7f6` | `4bec8b12-244f-4b56-a498-c895d4063f9e` |
| Light | Research + decomposition + retry | `434fcc21-073e-4950-8e76-0b6403adc24d` | `bcb8b78c-b35f-40cd-812c-29119f0531af` |
| Dark | Default | `409cd676-27f6-449e-8b94-14fd778905fa` | `aa3d1bde-214c-4c01-87ca-e97d4d960422` |
| Dark | Research + decomposition + retry | `62a9ddb7-bb04-4bdf-8cb0-250c01894653` | `50c751eb-b4ea-4063-a4fc-f401dc6012b7` |

The fixture also attached the existing GSD research source through `/api/references`, obtained real local reference UUID `3ff2039b-af2c-4796-9122-a546ed38e283`, merged a clearly labeled verification paragraph into the latest Idea body and read it back. Status and elaboration status were unchanged. The real browser rendered `[1]` as the source link. This verifies persistence/rendering; the research procedure itself was evaluated by instruction walkthroughs, not by a live researcher.

Local browser artifacts (ignored, available in the verification workspace):

- `.playwright-cli/research-create-check.cjs`
- `.playwright-cli/research-evidence-check.cjs`
- `.playwright-cli/research-create-{light,dark}-{default,retry,mobile}.png`

## Tracker browser integration

Used the same isolated database and real server actions. Fixtures are deliberately synthetic and do not run an LLM.

| Scenario | Result |
| --- | --- |
| Open Idea | Research creates its anchored session and one pending instruction; status remains open. |
| Pending answers with an existing round/question | Research dispatches; round remains `pending_answers`, selected option remains null. |
| Proposal pending review | Research dispatches without changing approval or elaboration status. |
| Approved proposal, all tasks open, displayed as Building | Research dispatches; task remains open. |
| Older proposal has execution history; newer proposal has only open tasks | Research is unavailable. |
| Theme has an executing descendant | Research is unavailable. |
| Approved proposal has only closed tasks, with no execution history | Research is unavailable with a distinct completed-Idea explanation. |
| Existing pending Research | Disabled in desktop and mobile menus; no duplicate request. |
| Prior fixture turn marked ended | A new explicit request succeeds; this terminal state was simulated in the fixture, not an actual research completion. |
| Existing initialized root | Research appends a second turn to the same root and opens its conversation; no new Idea. |
| No agent assigned | The Research picker selects an agent and explicit instance, assigns and dispatches atomically; status remains open. No `assigned` activity or initialization wake is emitted. |
| Bare-agent assignment, no root, two online working directories | Existing cwd picker requests an explicit choice. Selected `/tmp/research-second` becomes the exact root origin and runtime cwd; status remains open. |

The four stage fixtures used Ideas `a8163fc5-e615-4cbb-a2cd-f46b9a9cc4b9`, `0e87ab9f-85e0-4205-b7b8-52ad69ae4c3d`, `3b5c7a14-7f27-4631-95b1-b458c2c844f0`, and `bf758cff-e499-4d8a-b885-3c919fcdba17`. Database readback confirmed `sessionId === directIdeaUuid` for every root and zero `start_development` activities on these Ideas. The unanswered round `cacdd350-aa2b-4d68-9843-edb8da34ab66` and open task `b6ad1f60-ff16-47ba-bd21-bf8f07625ba0` were preserved.

Dark mobile dispatch appended turn `6e222e67-b360-4cf9-84f2-db9e03728bc9` to the existing initialized root. The agentless flow created turn `5a758551-9fbf-4317-8571-415085288563` for Idea `d07e3bb8-2c99-4751-a659-5df0798386d8`; this Idea had no activity records afterward. The light picker also dispatched successfully for `3bf2ced4-ec76-4c20-8f77-71198b762607`.

Explicit cwd selection for Idea `b9f57d0b-df87-484b-b774-bc6d1b160d6e` produced instance `7a15019d-a1f0-4816-9a19-9c7ba9e3565b`, connection `595341b3-7a04-4644-914e-08a1059f4e92`, and runtime cwd `/tmp/research-second`, verified from the database.

Desktop light and mobile dark menus were visually inspected, including enabled Research, pending-request explanations, historical execution, completed Ideas and theme descendants. Both themes' agent pickers were clicked through. A detected mobile truncation inherited from Button's `whitespace-nowrap` was corrected: the final reason has `white-space: normal`, width and scroll width both 322px, and a two-line height of 32px.

Additional local artifacts:

- `.playwright-cli/research-tracker-{fixtures,check,states}.cjs`
- `.playwright-cli/research-{agentless,picker-light,cwd,mobile-wrap}-check.cjs`
- `.playwright-cli/research-tracker-*.png`
- `.playwright-cli/research-final-db-audit.json`

## Automated execution-boundary verification

The final pre-spawn change passed 61 focused CLI tests and 40 real-database integration tests. Research retains its exact turn UUID, stays isolated within the root session's serial queue, and awaits the server's atomic pending-to-running admission before any subprocess launch. Tests cover delayed admission, denial/offline/missing/mismatched responses (no spawn), duplicate claims, wrong origin connection, development accepted after dispatch, FIFO/merge exclusions, pending launch abort and exact-turn cleanup if cwd/setup/spawn fails. Lost responses and prolonged outages recover via deferred exact cleanup without requiring the old request to pass dedup again. Shutdown during admission and nonthrowing no-child spawn failures are also covered.

The final expanded CLI/service/UI run passed **2,534 tests across 99 files**, with `CHORUS_AGENT_PROFILE` removed from the test subprocess environment. An earlier run exposed three spawner fixture failures caused by that inherited headless variable; the affected suites also passed individually after removing it. No spawner implementation changes were made. The separate real-database suite passed **40 tests**, and earlier targeted server/UI regression passed 623 tests. TypeScript, source ESLint, strict OpenSpec validation and diff whitespace checks passed. These checks exercise stubbed process launch and real isolated database admission, not a live LLM research run.

The pre-spawn guarantee requires the updated CLI alongside the server. Existing daemons must be updated for that guarantee; delivery-time checks and skill instructions alone cannot enforce it before an old daemon spawns.

## User-authorized design waiver

Pencil `get_app_state` failed four times with `transport not connected to app: visual_studio_code` (each call retried three times), including a final check after code verification. No encrypted `.pen` file was read or modified with filesystem tools. The user explicitly waived `docs/design.pen` updates in Idea comment `25a4d74c-3e9f-4aaf-a019-75344cc77a50` on 2026-09-26. These updates were not performed; browser verification remains completed.

Tracker implementation and its automated verification are tracked by task `2b4ea9e5-96ec-453e-babb-425ad904388b`. Formal task and aggregate review results are recorded in Chorus; this verification record alone does not declare completion.

The test browser, temporary auth-state file and fixture heartbeat were cleaned up. Screenshots and the isolated port-5435 database directory remain available for resumed review.


## Final review fixes and full coverage

Task 4 Round 1 identified two blockers: deletion could lose the Idea's execution boundary, and a user interrupt during admission could be ignored. Execution now records an Idea-anchored Activity; deletion preserves older task history under the same project lock. The existing interrupt handler retains the exact Research turn and local cancellation, preventing launch after delayed admission and terminating a child that appears after cancellation during backend preparation.

The final full coverage run used the isolated port-5435 database:

```sh
env -u CHORUS_AGENT_PROFILE RESEARCH_DATABASE_URL='postgresql://postgres:postgres@localhost:5435/postgres?sslmode=disable' pnpm exec vitest run --coverage
```

Result: **7,551 passed, 16 skipped, 376 passing files**; statements **95.93%**, branches **89.07%**, functions **97.68%**, lines **97.16%**. This includes **57 real-database tests**, including actual Waker/control-handler/production-admission cancellation with zero subprocesses. TypeScript and changed production source ESLint pass. CI now provisions an isolated PostgreSQL 17 service on port 5435 and initializes its empty schema so these tests participate in required coverage. Without the opt-in test database the new persistence suite is skipped and the global coverage threshold is not met.

Existing in-memory integration fixtures now model SQL `NOT`/`startsWith`/null predicates, and the Tracker menu assertion includes the Research item. These changes fix test fidelity and retain the production exclusion of Research from generic FIFO resolution.


## Final task review and production-image smoke

Creation task passed independent Round 1 review (`2d94da2f-3d5a-4d36-acc9-a249fde4cc63`, nonblocking test act warnings). Tracker task passed independent Round 2 review (`f3dc3cf5-3698-4238-8595-a53e5e3717da`), with both blockers independently verified fixed. All four tasks are admin-verified.

A production Docker image was built successfully from a clean detached checkout of `2033562d`. Running that image against the isolated database with the server entrypoint returned HTTP 200 and `database: connected` from `/api/health`. The Claude/Codex static plugin path, standalone skill path and Kiro skill path all returned the Research skill with HTTP 200. The smoke container was stopped afterward. This check intentionally bypassed database migration startup; the actual deployment script performs the normal production deployment.

The coordinated release-contract command and all six plugin shell checks from CI passed.

Aggregate code review Round 1 PASS: Idea comment `e10a081d-1810-4654-b12b-8a3eb07cb935`; reviewer independently repeated all 7,551 tests. OpenSpec archived as `2026-09-26-add-lightweight-research-skill`; both cumulative specs passed the supported document round-trip verifier. Chorus completion report: `58e07155-40f4-4175-8064-02b79b39a288`.

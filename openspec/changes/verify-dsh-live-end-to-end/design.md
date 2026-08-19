## Context

The dsh integration now has four implemented layers: server/client-type registration, the external JSON-RPC daemon backend, transcript and per-wake usage consumption, and installer-delivered MCP/skill/lifecycle support. Deterministic tests prove their individual and composed contracts, but those tests intentionally replace the provider and external runtime.

The production backend launches one detached `dsh-jsonrpc-agent` process and one random dsh session per wake. It sends the prompt over JSON-RPC, forwards committed root conversation messages, aggregates one terminal `dsh.turn.completed` usage frame, and exposes the child to the daemon's process-group interrupt path. It deliberately does not persist or resume native dsh sessions. Durable work state instead lives in Chorus Ideas, Proposals, Tasks, Documents, comments, and wake prompts.

Live acceptance needs real provider credentials, an external Cordis composition, UI/API observation, and a controllable daemon process. A headless worker cannot safely bootstrap that daemon from its own wake, so the owner-start prerequisite is an explicit execution gate.

## Goals / Non-Goals

**Goals:**

- Prove a real dsh worker appears as client type `dsh`, receives a wake, loads Chorus MCP tools and skills, and advances an isolated workflow.
- Prove committed transcript and one terminal usage delta are visible and attributed to the correct Idea/session for a completed wake.
- Prove daemon restart continuity through persisted Chorus resources while each wake still uses a new native dsh session.
- Prove an explicit interrupt terminates the live runtime process group and closes the turn without later transcript or usage contamination.
- Preserve enough redacted evidence for another reviewer to audit every conclusion.

**Non-Goals:**

- Add native dsh session persistence, a session map, or JSON-RPC resume support.
- Change the dsh event dialect, usage normalization, server schema, interrupt protocol, installer, or skill behavior.
- Turn the provider-backed run into a deterministic CI gate.
- Record or print provider keys, Chorus API keys, raw authorization headers, or secret-bearing environment files.
- Use a real product backlog item as the test fixture.

## Decisions

### Use a dedicated, non-destructive Chorus workflow fixture

Create an acceptance-only Idea linked from the acceptance report and give it a minimal Proposal and Task whose work is safe to repeat, such as running focused read-only diagnostics and posting a bounded result. The fixture must not edit product code or depend on an unrelated product backlog item.

The first wake advances the fixture through elaboration/proposal submission. Human approval remains a real gate. A later wake executes or continues the materialized task. This exercises the workflow and installed skills without letting a failed provider run strand a real product change.

Self-hosting on the parent acceptance Idea was rejected because the current Codex coordinator and the dsh worker would compete for the same resource. Reusing a low-risk product Idea was rejected because a partial live run would leave ambiguous product state.

### Treat restart continuity as Chorus-resource continuity

Record the first wake's Chorus Idea/session identifiers and dsh backend session identifier, stop the daemon cleanly, and have the owner restart `chorus daemon --agent dsh` with the same non-secret configuration categories. Trigger a later wake for the same fixture workflow.

The later worker must recover the current workflow state from its wake prompt and Chorus MCP resources and continue from the correct pending gate or task. Evidence must also show that its dsh backend session identifier differs from the prior wake. A changed native identifier is expected and proves the acceptance did not silently redefine v1 as native session resume.

Calling this native "resume" was rejected because the approved backend explicitly creates a fresh process and session per wake. Dropping restart coverage was rejected because Chorus-backed work continuity remains valuable and testable.

### Use a side-effect-free long turn for interrupt acceptance

Trigger a dedicated wake whose instruction includes a controlled long-running, non-mutating operation. Capture the runtime PID/process-group identity from daemon diagnostics or an equivalent operating-system observation, then issue interrupt through the Chorus control surface while the execution is running.

Acceptance requires all three boundaries:

1. Chorus records the turn as interrupted by the user rather than ended or crashed.
2. The observed dsh runtime process group and descendants exit within the configured graceful/forceful escalation bound.
3. After the terminal interrupt record, a bounded observation window shows no additional transcript batch or usage settlement for that interrupted wake.

UI-only evidence was rejected because it cannot detect a surviving runtime process. Log-only evidence was rejected because it cannot prove the user-visible turn state or absence of late persisted data.

### Keep credentials in the owner-started daemon environment

The owner starts the daemon from a terminal or service environment that already provides `CHORUS_DSH_PATH` or PATH discovery, `CHORUS_DSH_CONFIG` or `DSH_CORDIS_CONFIG`, Chorus connection values, and the DeepSeek provider credential. The acceptance procedure may record only whether each category was present and which non-secret executable/config basename was selected.

No command transcript, report, screenshot, process listing, or committed helper may include secret values. Before publication, scan the report and any attached text artifacts for known secret prefixes and authorization headers.

Passing credentials in argv was rejected because process listings expose them. Having the headless worker start a second daemon was rejected because it creates ownership and connection ambiguity.

### Make the redacted report the evidence index

Write `docs/acceptance/dsh-live-e2e.md` with:

- date, host/platform class, git revision, Chorus URL class, and dsh version/revision;
- environment prerequisite categories and redaction statement;
- fixture Idea, Proposal, Task, connection, session, turn, and backend-session identifiers;
- commands with secret values removed;
- per-path expected and observed results for wake, restart continuity, and interrupt;
- transcript and normalized usage excerpts limited to non-sensitive fields;
- process-group observations and the no-late-data observation window;
- links or stable identifiers for Chorus records and redacted screenshots/API captures;
- final pass/fail table, deviations, and follow-up Issues/Ideas.

A reusable helper may collect non-secret metadata, but it must not replace human verification of the live UI/control and operating-system process boundaries.

## Risks / Trade-offs

- [The provider or network is temporarily unavailable] -> Record the failure as an environmental blocker, preserve redacted diagnostics, and rerun only after the owner restores the prerequisite; do not reinterpret it as product acceptance.
- [The acceptance fixture leaves workflow records behind] -> Prefix and describe it as an acceptance fixture, link it from the report, and retain it as evidence rather than deleting or mixing it with product work.
- [An interrupt occurs before the child PID is observable] -> Wait for the running execution and child-process evidence before issuing the control command; otherwise mark that attempt invalid and repeat with a new wake.
- [Late transcript batching makes the no-contamination check ambiguous] -> Capture the terminal boundary, flush/observe for a bounded interval longer than the configured transcript batch delay, and compare message and usage counts before and after.
- [The report accidentally contains a secret] -> Use placeholders during capture, inspect screenshots, and run explicit secret-pattern scans before committing or attaching evidence.
- [Live evidence is not deterministic enough for CI] -> Keep existing deterministic dsh suites as the regression gate and treat this run as milestone acceptance evidence.

## Migration Plan

1. Confirm all prerequisite dsh changes and focused deterministic suites are present in the shared worktree.
2. Have the owner start `chorus daemon --agent dsh` from the prepared environment.
3. Create and advance the isolated fixture through the normal wake and human proposal gate.
4. Restart the daemon and verify Chorus-resource workflow continuity on a new dsh backend session.
5. Run the controlled interrupt attempt and collect UI/API, daemon, and process evidence.
6. Redact and publish the acceptance report, run focused regression suites, and submit the task for verification.
7. If any required boundary fails, mark the report failed, open a focused follow-up Idea, and do not claim the parent integration accepted.

Rollback consists only of stopping the acceptance daemon and abandoning further fixture wakes. No production migration or schema rollback is required.

## Open Questions

None. The owner-start prerequisite is intentionally deferred to the approved task's execution phase.

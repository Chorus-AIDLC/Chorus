# Design: daemon wake failure diagnostics

## Context

`DaemonSessionTurn` already persists status, interruption reason, transcript-relay failure and token usage. `advanceTurnForWake` resolves authenticated agent/company/session ownership, exact turn correlation, operation admission and idempotent terminal retries. `Waker` already separates user interruption, shutdown and crash. The conversation patches its turn projection on the session-scoped `turn_status_changed` event. Extend those paths rather than manufacturing assistant messages or parsing daemon logs. [1](ref:5bc11d01-b10c-451a-9a79-317ce00f7103)

## Goals

Cover startup and execution failure for every current backend; preserve an actionable bounded reason on its own turn; show a summary and optional details on refresh and live updates. Keep existing execution recovery and operation admission semantics.

Automatic retry changes, full log streaming and migrating old daemon log files are outside this change.

## Module contracts

The same optional field is called `wakeError` in spawner results, CLI/OpenClaw REST reports, Prisma, and `TurnView`.

```ts
type WakeError = {
  kind: "startup" | "execution" | "protocol";
  source: "claude" | "codex" | "pi" | "kiro" | "dsh" | "openclaw";
  message: string;        // nonblank summary, at most 500 characters
  details: string | null; // at most 8000 characters
  exitCode: number | null;
  signal: string | null;  // at most 50 characters
};
```

`details`, `exitCode` and `signal` may be omitted at the HTTP input boundary and normalize to null. Reject unknown diagnostic keys, invalid enums, noninteger exit codes, empty summaries and oversized input with the existing validation error response. Absent/null `wakeError` remains valid. Read projection treats missing or malformed stored JSON as null; `TurnView.wakeError` is optional for compatibility with old fixtures/responses.

Server and CLI implement equivalent small validation/sanitization helpers in their respective runtimes; no application TypeScript is imported by the published CLI. Remove ANSI/control output and redact known Chorus credentials and authorization-token patterns before persisting. The backend collector bounds stderr as it arrives, and bounds summary/details before reporting. UI renders diagnostics as escaped plain text, never Markdown or raw HTML.

The independent task ownership is:

1. Server: `prisma/`, `src/lib/daemon-wake-error.ts`, session service, turn-advance route and server tests.
2. Backend collectors: `cli/wake-error.mjs`, five CLI spawners and their tests; a protocol adapter may change when required to expose a terminal reason.
3. Wake reporting: `cli/waker.mjs`, CLI turn-reporter/REST client, `packages/openclaw-plugin/` daemon reporting and related tests.
4. Chat: `turn-band.tsx` (or a small adjacent diagnostic component), all registered locale files (en/zh/ja/ko) and component tests.
5. Integration: cross-module checks and acceptance evidence after the preceding modules converge.

## Collection and outcome classification

Each CLI spawner adds `wakeError` only to a failed classified wake result. Missing binaries, failed spawn, rejected setup/config and prompt-delivery failures receive startup/protocol information. A backend-declared failed turn remains a failure even if its host process exits zero; normal result payloads or nonterminal tool errors must not become wake failures. Claude uses its final `result` failure fields; Codex uses its authoritative matching terminal outcome and existing protocol faults; Pi uses terminal assistant errors or rejected prompt; Kiro uses process exit and stderr; DSH uses its existing runtime/RPC failure path. Do not change flags, session identity decisions, permission mode or cleanup behavior.

Prefer an available structured failure reason over stderr; retain a bounded stderr tail as complementary details. Fallback summarizes the process exit code, termination signal or unavailable launch result when there is no useful text. A successful wake with stderr warnings returns no diagnostic.

Use existing `awaitChildSettled`/backend cleanup boundaries; neither waiting for `close` forever nor adding an agent-running timeout is acceptable. [2](ref:0ccba00a-261b-4566-b01c-f1bb3b277ec8)

OpenClaw does not use CLI child processes. Its daemon client derives a diagnostic from its rejected wake/agent result, classifies the terminal turn as a crash when appropriate, and sends the same optional REST field; user-aborted wakes remain user interruptions. The published OpenClaw 2026.9.7 SDK declaration was checked locally: `meta.error` exposes a terminal kind/message, final reply payloads expose `isError`, and `meta.aborted` takes precedence. Read only these documented terminal fields, giving `meta.error` precedence over a generic error payload. [3](ref:28fdc780-7f44-404f-903f-c0f7a2a30fc6)

## Reporting and startup failure

The `createTurnReporter` wrapper must forward `wakeError` unchanged into the REST client; its explicit field list currently drops unknown additions. Waker treats a nonnull structured diagnostic as failure even when an adapter supplied exit code zero. Existing user-interrupt/shutdown flags take precedence, and suppress the failure diagnostic. A successful deterministic Claude session-conflict fallback suppresses the first attempt's error; only the final failed result is reported.

Flush transcript and usage as today, then send `wakeError` on the terminal interrupted crash/invalid-path report, alongside any independent transcript-relay annotation. Bind it to the UUID returned by the running edge and retain coalescing attribution so errors never land on the next queued wake or another conversation.

Ordinary startup failures that never invoke `onChild` must no longer leave their selected wake silently pending. Record their failed execution attempt using the existing pending-to-running report (awaiting the returned UUID), then interrupt that exact turn with the diagnostic. This preserves the ordinary state machine: there is no general pending-to-interrupted shortcut. If admission fails or returns no UUID, log the reporting failure rather than using a terminal FIFO report that might target a different running turn. Setup/invalid-path exceptions use the same path.

Dedicated operations keep their current exact-turn admission and privileged launch-abort path, including research eligibility and origin fencing. Add the diagnostic to those existing abort reports without admitting a rejected operation or introducing ordinary access to the pending-abort exception. Coalesced sibling turns remain merged, not independently failed.

## Persistence and reads

Add nullable JSON `DaemonSessionTurn.wakeError` in an additive SQL migration. No backfill is needed. Generate Prisma client after schema changes.

The HTTP boundary validates the shape; service normalization defensively validates internal/stored values. Persist only on interrupted `crash`/`invalid_path` terminal edges, ignore on running/ended/user/shutdown/offline. The error is independent of `relayError`. Include the field in all turn projections (ordinary and message-paginated read paths).

Write it in the existing guarded state-claim transaction. Duplicate terminal retries return the existing projection and do not overwrite a diagnostic, increment usage twice, or emit a second status event. Existing company/agent/connection fences apply unchanged. Historical callers omitting it preserve previous behavior.

## Chat presentation

Place an error block in the failed turn band before the message-body ladder, so it is visible with partial replies or no messages. Show a localized failure heading plus the supplied summary, and a shadcn Button that expands/collapses bounded diagnostic details and any available exit code/signal. Use `aria-expanded`, keyboard-accessible control, semantic theme tokens, wrapped text and a bounded scrolling detail area. No new composer actions.

For a crash/invalid-path turn without a valid diagnostic, show a localized generic reason and do not offer an empty details control. User/shutdown/offline interruptions retain their existing display. Keep transcript-upload failure messaging distinct. Verify English, Chinese, Japanese and Korean locale key/ICU parity, light and dark, desktop and narrow layout.

## Validation

Server: migration/schema generation, normalization and route bounds, failure-only persistence, read projection, owner fences, exact correlation, duplicate reports and existing operation admission regression tests.

Backend/reporting: targeted mocked-child/RPC tests for all five spawners, startup failure with no child, error final frame with process exit zero, successful warning stderr, signal/no-text fallback, known credential redaction, failed and successful Claude conflict fallback, operation launch abort, coalesced queues and OpenClaw crash/user interrupt.

UI/integration: render diagnostics with/without messages; collapse/expand; exit-code zero/null; historical fallback; refresh/live event updates; localization and both themes. Run focused suites, type checking and lint, plus a real local browser when available.

## Risks and environment limits

Bound stderr incrementally to prevent noisy processes allocating unbounded memory. Error text can include local paths and runtime context: publish only bounded sanitized diagnostics. Do not broaden existing wake retry, control or access semantics.

Pencil MCP tools are not exposed in this session, so `docs/design.pen` cannot be updated using its mandated tool. Record that limitation explicitly in acceptance evidence and provide the implemented component/browser evidence; do not edit the encrypted file with text tools. Actual external-provider outages need not be triggered in production; use deterministic local test fixtures.

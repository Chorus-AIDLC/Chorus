## Context

`DaemonChat` starts a session-list fetch when the dialog content mounts. When the dialog is
opened with a seeded conversation, `handleSessionStarted` also requests an authoritative
list refresh. Those calls can overlap, causing duplicate HTTP and database work on the
critical path. React development remount behavior can expose the same race locally.

After a conversation is selected, `getSessionDetail` returns a page containing at most 20
message-stream entries. Nevertheless, it currently loads every candidate turn at or before
the cursor and every retained message attached to those turns before slicing the page in
memory. Transcript messages are retained at a bounded count, but turn rows are not trimmed,
so the first-detail cost grows with the lifetime of the conversation.

Every turn contributes at least one stream position (`msgSeq = 0`), whether that position
renders a synthetic human prompt or an empty placeholder. This invariant allows the
candidate-turn query to be safely bounded before loading messages.

## Goals / Non-Goals

**Goals:**

- Ensure concurrent callers within one mounted chat share one session-list request.
- Make the first transcript page query cost independent of total historical turn count.
- Preserve the existing transcript page and cursor contract byte-for-byte at the API
  boundary.
- Prove the request and query bounds with automated tests.
- Demonstrate a user-facing time-to-interactive improvement in development and
  production-build browser runs.

**Non-Goals:**

- Changing the 15-second background refresh cadence.
- Adding a client cache shared across browser tabs or unrelated component mounts.
- Changing transcript retention, pagination size, schema, SSE behavior, or visual design.
- Introducing a new performance telemetry platform.

## Decisions

### 1. Coalesce list requests with a mounted-instance promise

`fetchSessions` will keep a ref to the current request promise. A caller arriving while that
promise is pending receives the same promise instead of starting another `authFetch`.
The ref is cleared in `finally`, so an explicit refresh after settlement and the existing
15-second poll still make fresh requests.

This is preferred over a time-based debounce because it removes only overlapping duplicate
work and does not delay legitimate refreshes. A module-global cache was rejected because it
would mix authentication lifetimes and complicate invalidation.

### 2. Read at most `limit + 2` candidate turns

The descending candidate-turn query will use `take: limit + 2`. A page needs at most
`limit + 1` stream entries: `limit` returned entries plus one sentinel for `hasMore`.
Every turn contributes a `msgSeq = 0` slot, so `limit + 1` turns are enough without a
cursor. With a composite cursor at `msgSeq = 0`, the equal-sequence turn contributes no
eligible entry; one additional turn covers that edge, hence `limit + 2`.

Messages are then loaded only for that bounded turn set and the existing stream folding,
cursor filtering, slicing, and grouping code remains authoritative. This is preferred over
rewriting pagination as a database union because the current semantics combine persisted
messages with synthetic and placeholder slots; preserving that logic minimizes behavioral
risk while changing the asymptotic query cost.

### 3. Verify behavior and performance bounds separately

Frontend tests will hold a list request pending, trigger the focus refresh path, and assert
only one list GET is in flight. Service tests will assert the candidate-turn query receives
`take: DEFAULT_TRANSCRIPT_MESSAGE_PAGE + 2` by default and `take: requestedLimit + 2` for a
custom page size, while existing pagination tests continue to verify returned content and
cursors.

### 4. Measure transcript time to interactive at the browser boundary

The acceptance timing starts immediately before the action that opens the daemon chat on a
seeded Idea conversation. It ends when that conversation's title and latest transcript page
are visible and the reply composer is enabled. A fixture with at least 500 historical turns
and retained transcript messages exercises the formerly unbounded detail path.

Capture five cold-open runs before and after the change, discarding no samples and comparing
medians. Run the same protocol against the local development server and against a locally
started production build (`next build` + `next start`), which exercises the deployed runtime
mode without requiring this implementation task to deploy unreviewed code. The production
post-change median must be at least 30% lower than baseline. Development mode must not
regress; its code-attributable improvement is verified by the one-request coalescing
waterfall, the bounded candidate query, and database timings because Turbopack/middleware
adds a fixed per-request floor that can dominate the short optimized query.

The median and relative threshold are preferred over a fixed millisecond budget because
developer hosts and CI runners differ materially, while the before/after fixture and runtime
mode remain identical. During implementation, the development control endpoint measured a
~294 ms median while the optimized detail SQL completed in ~1–3 ms; requiring the total
development wall clock to fall 30% would therefore measure framework instrumentation rather
than this change.

## Risks / Trade-offs

- **A cursor edge could under-fetch candidate entries** → The extra cursor turn and the
  one-slot-per-turn invariant guarantee enough entries; cursor boundary tests cover the
  `msgSeq = 0` case.
- **A refresh requested during an in-flight list request will not immediately issue a
  second request** → The first response is already authoritative for the same endpoint;
  periodic refresh and mutation-triggered post-settlement calls remain unchanged.
- **The optimization does not remove every startup request** → The list and selected
  transcript are distinct necessary payloads and remain parallel; only duplicate work and
  unbounded backend scanning are removed.
- **Wall-clock measurements are host-sensitive** → Compare five-run medians on the same
  host, fixture, browser, and runtime mode; retain raw samples in the task report.

## Migration Plan

No data migration is required. Deploy the frontend and service changes together. Rollback is
a code-only revert because API shapes and persisted data do not change.

## Open Questions

None.

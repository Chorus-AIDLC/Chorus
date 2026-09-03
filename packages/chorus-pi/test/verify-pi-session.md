# In-session verification (paste to a fresh Pi agent)

> Run `bash packages/chorus-pi/test/precheck.sh` in a shell **first**, then launch a
> **fresh** Pi session (do not `--resume` — the extension loads at session start)
> and paste the block below to the agent. It self-checks each step and reports
> PASS/FAIL per phase. Stop if any phase fails and report which.

You are verifying the `chorus-pi` package installed in this repo. Work through
the phases in order. For each, run the check, then report exactly one line:
`✓ <phase>` or `✗ <phase>: <what failed>`. Do NOT mark a phase passed unless its
assertion actually held.

## Phase C — discovery + connection

C1. Skill discovery: load the core skill and confirm it rendered.
    - Run: `/skill:chorus` (or read `packages/chorus-pi/skills/chorus/SKILL.md`)
    - Assert: the skill content loads (you can see "AI-DLC Workflow" and "Skill Routing").

C2. Agent discovery (package-relative, zero copy).
    The 3 reviewer agents are discovered directly from the package's own `agents/`
    dir by the bundled `extensions/subagent/agents.ts` — NO copy into
    `~/.pi/agent/agents/`. Confirm by dispatching one with a trivial probe task:
    - Run: `subagent({ agent: "chorus-task-reviewer", task: "Reply with the single word READY and stop." })`
    - Assert: the dispatch resolves the agent (it runs / returns) rather than
      erroring with "Unknown agent". That proves package-relative discovery worked.
    - (An `Unknown agent` error naming the available agents means discovery failed —
      check the package installed and `extensions/subagent/` shipped.)

C3. MCP connection + tool-name prefix (critical).
    The skill docs call chorus tools by their backend native name, e.g.
    `chorus_checkin`. Pi's mcp-adapter may prefix them with the server name
    (`chorus`), exposing them as `chorus_chorus_checkin`. Determine which works
    in THIS session by probing both:
    - Try: `mcp({ tool: "chorus_checkin" })`
    - If that errors with "unknown tool", try: `mcp({ tool: "chorus_chorus_checkin" })`
    - Report which name worked as: `C3 prefix: <single|double>`.
    - Assert: one of them returns the checkin JSON (agent identity + ideaTracker).
    If BOTH fail, the chorus MCP server isn't connected — check `.mcp.json` /
    `~/.pi/agent/mcp.json` has a `chorus` server, and restart the session.

C4. Extension loaded (session_start → checkin + context injection).
    - The extension's `session_start` handler calls checkin and the
      `before_agent_start` handler injects it once. By now (you've been
      prompted), that injection should have happened.
    - Check the conversation: is there a system/context message starting with
      `# Chorus Plugin — Active`? (It may be a `chorus`-typed custom message.)
    - If you can't see prior messages, call `chorus_checkin` (with whichever
      prefix worked in C3) and assert it returns your agent identity. The
      injection itself is best confirmed by starting a brand-new session and
      looking at the very first turn — note that for the next run.
    - Assert: checkin succeeds (C3 already proves this); mark C4 ✓ if the
      injected context is visible OR if checkin worked and you note "injection
      visibility requires a session started after install".

## Phase D — session injection + reviewer nudge (core runtime behavior)

D1. tool_call session injection (the key capability).
    The extension's `tool_call` handler (pre-execution, mutable input) should
    create a Chorus session and append its UUID + workflow into the dispatched
    worker's task. Verify by dispatching a worker that echoes the injection:
    - Run:
      ```
      subagent({ agent: "worker", task: "If your task text contains a line starting with 'Session UUID:', print exactly that line and stop. Otherwise print 'NO SESSION INJECTED' and stop." })
      ```
    - Wait for the worker's completion message.
    - Assert: the worker printed `Session UUID: <uuid>`, NOT `NO SESSION INJECTED`.
    - Record that `<uuid>` for D2.
    - On PASS, this proves: tool_call fired → chorus_create_session was called →
      the UUID was injected into the worker task → the ephemeral child received it.

D2. session auto-closes when the subagent call returns.
    The official subagent children are ephemeral — the extension closes the
    session automatically on the `subagent` tool's `tool_result` (no separate
    close tool). By the time D1's call returned, the session should already be
    closed.
    - Verify on the backend: `mcp({ tool: "chorus_list_sessions", args: { status: "active" } })`
      (use the prefix that worked in C3).
    - Assert: the session UUID from D1 is NOT in the active list.
    - (Alternatively check `chorus_get_session` with the UUID — it should be `closed`.)

D3. Reviewer nudge fires after submit_for_verify.
    This needs a real task in `to_verify` state. If you have a project + task
    set up:
    - Pick a task that's ready, claim it, move to in_progress, then
      `chorus_submit_for_verify({ taskUuid, summary: "verification test" })`
      (with the working prefix).
    - Watch for a steer user-message from the extension prompting you to spawn
      `chorus-task-reviewer`.
    - Assert: the nudge message appears (unless `CHORUS_ENABLE_TASK_REVIEWER`
      is `false`).
    If you have no task handy, skip D3 and note "skipped — no task in to_verify".

D4. Reviewer agent runs end to end.
    - Run:
      ```
      subagent({ agent: "chorus-task-reviewer", task: "Review task <some-task-uuid>. Post a VERDICT comment." })
      ```
      (blocking subagent tool — it waits for the result.)
    - Assert: the reviewer returns and a comment was posted (check
      `chorus_get_comments({ targetType: "task", targetUuid })`); the comment
      ends with `VERDICT: PASS` / `PASS WITH NOTES` / `FAIL`.
    If no real task exists, skip and note it.

## Phase E — end-to-end (optional, only if time + an admin key)

E1. Full-auto pipeline.
    - Run: `/skill:yolo` then a one-line feature request, e.g.
      "Add a GET /hello endpoint returning {\"message\":\"hello\"}."
    - Assert: Idea → Proposal (with reviewer VERDICT) → Tasks → code → verify
      (with reviewer VERDICTs) → Idea closed, all within the yolo skill flow.
    - This exercises every extension event and every skill.

## Report

When done, print a summary table:
```
Phase | Result
C1    | ✓/✗
C2    | ✓/✗
C3    | prefix=<single|double> ✓/✗
C4    | ✓/✗ (note injection visibility)
D1    | ✓/✗ (sessionUuid=<…>)
D2    | ✓/✗
D3    | ✓/✗/skipped
D4    | ✓/✗/skipped
E1    | ✓/✗/skipped
```
Stop at the first ✗ and explain what failed. Do not proceed to later phases
after a failure in C (discovery/connection) — they all depend on it.

# Technical Design: Exclude synthetic content from daemon transcript sync

## Overview

The fix lives entirely in the daemon's transcript extractor
(`cli/upload-hooks.mjs` → `extractTranscriptText`), the single chokepoint every
stream-json object passes through on its way to `POST /api/daemon/transcript`. We add a
structural guard that drops harness-injected synthetic messages, keyed on Claude Code's
own `isSynthetic` stream marker. No server, schema, or API change.

## Evidence — what the daemon actually reads

The daemon spawns `claude -p --output-format stream-json --verbose`
(`cli/claude-spawner.mjs:172`) and hands every parsed NDJSON object to
`onTranscriptMessage`, which calls `extractTranscriptText`. The relevant shapes were
captured from real stdout (Claude Code CLI, this machine):

| Logical content | Stream-json envelope | Current filter outcome |
|---|---|---|
| Loaded skill body | `type:"user"`, `isSynthetic:true`, `content:[{type:"text", text:"Base directory for this skill: …"}]` | **KEPT → leaks** |
| Skill tool result | `type:"user"`, `content:[{type:"tool_result", …"Launching skill: …"}]` | dropped (not a `text` block) |
| Human wake instruction | `type:"user"`, `isSynthetic` absent, `content:[{type:"text", …"[Chorus] …"}]` | kept (correct) |
| Agent reply | `type:"assistant"`, `isSynthetic` absent, `text` block | kept (correct) |
| `CLAUDE.md` / MCP-server instructions / deferred-tool listing | folded into `type:"system"` `subtype:"init"` | dropped (system envelope) |
| Mid-turn `<system-reminder>` | rides inside a `tool_result` block | dropped (not a `text` block) |

Key facts established by capture:

1. **`isSynthetic`, not `isMeta`.** The on-disk JSONL marks the skill body with
   `isMeta:true`; the live stream marks it with `isSynthetic:true`. The daemon reads the
   stream, so the guard MUST key on `isSynthetic`. (`isMeta` does not appear anywhere in
   stream-json top-level keys.)
2. **The skill body is the only large injected blob that reaches the conversation
   filter** in the headless stream. System/init-folded context (MCP instructions,
   `CLAUDE.md`, tool listings) and `tool_result`-wrapped system-reminders are already
   dropped by the existing `text`-only block filter.
3. **A content heuristic would be unsafe.** The agent's own genuine replies sometimes
   quote skill strings (e.g. "Base directory for this skill") while discussing the work;
   those carry no `isSynthetic` flag. Only the structural flag separates injected text
   from authored text — which is why the chosen mechanism is structural-match-only.

## Architecture / the change

In `extractTranscriptText`, Claude Code branch, **before** extracting text from a
`type:"user"` envelope:

```js
// Drop harness-injected synthetic content (e.g. loaded skill bodies). Claude Code's
// stream-json marks these user envelopes with isSynthetic:true; genuine human
// instructions and the agent's own messages never carry it. Structural match only —
// no size/content heuristic, so real replies/tool summaries/errors are never dropped.
if (obj.type === "user" && obj.isSynthetic === true) return null;
```

Placement: after the `item.completed` (codex) branch and the
`CONVERSATION_TYPES` check, but before/at the point where the `user` message's content
is read. It is gated on `obj.type === "user"` so it cannot affect assistant messages.

### Defense-in-depth: strip wrapped system-reminders

For any retained `text` block, strip `<system-reminder>…</system-reminder>` spans (and
drop the message if nothing but a reminder remains). This is a structural tag match, not
a size heuristic, and covers the case where a reminder is concatenated into an otherwise
kept text block. Implemented as a small helper applied to the joined text before the
final `text.trim()` emptiness check.

```js
function stripSystemReminders(s) {
  // Remove <system-reminder>…</system-reminder> spans (non-greedy, dotall).
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
}
```

## Module Contracts

- `extractTranscriptText(obj)` keeps its contract: returns `{ role, text }` or `null`;
  never throws. The two additions only ever turn a would-be-kept message into `null`
  (synthetic user) or shrink its `text` (reminder strip). No new return shape.
- The codex (`item.completed`) branch is untouched — scope is Claude Code only.
- The server ingest endpoint and its existing requirement are unchanged; this strictly
  reduces what the daemon sends.

## Implementation Plan

1. Add the `isSynthetic` drop and `stripSystemReminders` helper to
   `cli/upload-hooks.mjs`; update the dialect doc-comment to record the `isSynthetic`
   vs `isMeta` distinction so the next reader doesn't regress to the on-disk field.
2. Unit tests in `cli/__tests__/` for `extractTranscriptText`:
   - `type:"user"` + `isSynthetic:true` + text block → `null` (skill body dropped).
   - `type:"user"` + no `isSynthetic` + `[Chorus]` text → kept (human instruction).
   - `type:"assistant"` + text that *contains* "Base directory for this skill" → kept
     (genuine reply not dropped — guards against content-sniffing regression).
   - `text` block wrapping `<system-reminder>…</system-reminder>` → reminder stripped;
     reminder-only message → dropped.
   - codex `item.completed` `agent_message` → unchanged.
3. Local e2e verification (the acceptance gate the requester asked for): run a local
   Chorus server + daemon, wake a session that loads a skill, and assert the stored
   transcript contains the agent's reply but not the skill body, and that a human
   instruction and an error message both still sync. Because the elaboration scope is
   "skill + injected context" (q2), the e2e ALSO verifies — not merely assumes — that the
   other named injected categories (MCP-server instructions, `CLAUDE.md` context, the
   deferred-tool/agent listing) are absent from the stored transcript. The evidence
   above predicts they never reach the conversation filter (folded into the dropped
   `type:"system"` init envelope); if the live run shows any of them leaking, that is a
   finding and the filter must extend beyond the `isSynthetic` drop to cover it.

## Risks & Mitigations

- **`isSynthetic` semantics drift across CLI versions.** Mitigation: the guard is
  additive and fail-safe — if the flag stops appearing, behavior reverts to today's
  (over-sync), not data loss; the e2e test pins the current behavior and will flag a
  regression. The doc-comment records the captured CLI version.
- **Future legitimate synthetic content we *do* want.** None today; the decision is
  drop-completely. If that changes, the guard is a single line to relax.
- **Over-stripping reminders.** The regex is anchored to the literal
  `<system-reminder>` tag pair; non-reminder text is untouched. Covered by a kept-text
  test case.

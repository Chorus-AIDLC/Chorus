# Proposal: Exclude harness-injected synthetic content from daemon transcript sync

## Why

When the Chorus daemon wakes a headless `claude -p` session, it streams the session
transcript back to Chorus. Loading a skill in that session injects the **full skill
markdown body** (often 4k–20k characters) into the conversation. Today that body is
synced to Chorus verbatim, so the daemon session stream fills with low-value,
repetitive, internal-implementation text that drowns out the things a human actually
wants to read: agent progress, questions, results, and errors.

This is observable right now: a single idea-elaboration turn that loads `chorus:idea`,
`chorus:proposal`, and `chorus:openspec-aware` injects three 13k–20k-character skill
bodies into the Chorus transcript.

The root cause is structural, and it was pinned by capturing the real
`claude -p --output-format stream-json --verbose` stdout the daemon consumes:

- A loaded skill body arrives as a `type:"user"` envelope carrying a `text` block,
  marked **`isSynthetic: true`** — Claude Code's own flag for harness-injected,
  non-human content.
- The daemon's transcript filter (`cli/upload-hooks.mjs` → `extractTranscriptText`)
  keeps **all** `text` blocks from `user`/`assistant` messages and has **no synthetic
  check**, so the injected skill body passes straight through to
  `POST /api/daemon/transcript`.
- Genuine content — the human's wake instruction, the agent's own replies, tool-result
  summaries the agent writes — never carries `isSynthetic`, so it is distinguishable by
  structure alone.

> **Field-name caveat (verified):** the on-disk transcript JSONL
> (`~/.claude/projects/.../*.jsonl`) marks the same message with `isMeta: true`, but the
> daemon does **not** read that file — it reads the live stream-json stdout, where the
> field is `isSynthetic`. A fix keyed on `isMeta` would be a silent no-op in production.
> This change keys on `isSynthetic`.

## What Changes

- The daemon's `extractTranscriptText` (Claude Code stream-json dialect) **drops any
  `type:"user"` envelope whose `isSynthetic === true`** before extracting text. This is
  a pure structural match — no size threshold, no content sniffing — so it can never
  accidentally drop a real agent reply, tool-result summary, human instruction, or error
  message.
- Defense-in-depth: where any retained `text` block still wraps a
  `<system-reminder>…</system-reminder>` injection, that wrapped block is stripped from
  the stored text. (In the headless stream, MCP-server instructions, `CLAUDE.md`
  context, and the deferred-tool listing are folded into the already-dropped
  `type:"system"` init envelope and never reach the conversation filter, so no extra
  handling is needed for them.)
- Behavior is **always on** with no configuration knob.
- Scope is the **Claude Code daemon backend only**. The Codex backend
  (`codex exec --json`, `item.completed` dialect) is unchanged by this change and will be
  addressed separately if needed.
- Verification is a **local end-to-end test**: run a real local Chorus server + daemon,
  wake a session that loads a skill, and assert that (a) the skill body never appears in
  the session's stored transcript, while (b) the agent's replies, tool-result summaries,
  human instructions, and key errors still sync.

## Capabilities

- `daemon-session-conversation` (MODIFIED) — the transcript-ingest requirement is
  extended so the daemon-side filter excludes harness-injected synthetic content, stated
  as a backend-agnostic guarantee about what reaches the ingest endpoint.

## Impact

- **Code:** `cli/upload-hooks.mjs` (`extractTranscriptText`, Claude Code branch) — add
  the `isSynthetic` drop and the `<system-reminder>` strip. Tests in
  `cli/__tests__/` for the new filter cases.
- **No schema change**, no new permission bit, no API contract change. The server ingest
  already stores only `user`/`assistant` text and is the second line of defense; this
  change reduces what the daemon sends rather than changing what the server accepts.
- **No migration.** Existing already-synced skill text is not retro-cleaned by this
  change (out of scope; the rolling-window cap will age it out).
- **Boundary:** the sibling idea "修复 Codex daemon UI 指令处理中间消息重复同步到 Chorus"
  owns the duplicate-intermediate-message problem. This change owns only the skill-body /
  verbose-injection leak.

## Non-goals

- Showing a short "loaded skill X" marker in the stream. The decision was to drop
  synthetic content **completely**, with no replacement event.
- Retro-cleaning skill text already persisted in existing sessions.
- Any change to the Codex backend.
- A configuration flag or verbose/debug mode to re-enable full sync.
- UI-side collapsing of skill content (rejected in favor of never sending it).

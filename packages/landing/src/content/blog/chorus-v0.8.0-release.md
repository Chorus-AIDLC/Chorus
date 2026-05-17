---
title: "Chorus v0.8.0: Chorus ❤ OpenSpec"
description: "Writing specs as local files is great. So how does the collaboration platform keep up? This release wires OpenSpec's local file flow into Chorus's AI-DLC."
date: 2026-05-17
lang: en
postSlug: chorus-v0.8.0-release
---

# Chorus v0.8.0: Chorus ❤ OpenSpec

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.8.0 is out. The whole release is about one thing: hooking the community's [OpenSpec](https://github.com/Fission-AI/OpenSpec) tool into Chorus's AI-DLC, so spec docs can live as local files where agents, humans, and git all play nicely together — and still mirror into Chorus so reviewers can read, comment, and approve them.

---

## Collaboration platform vs. local files — can we have both?

Chorus's AI-DLC is a pipeline: Idea → Proposal → Tasks → Verify, all glued together by a database. A proposal is a row in the DB. So is a document draft. Reviewers open the web UI, leave comments, approve. Audit trail and approvals are clean.

The awkward part is writing the docs. An agent finishes a chunk of PRD and stuffs it into the `content` field of `chorus_pm_add_document_draft`. A human who wants to fix two lines has to open the Chorus web editor. The local repo doesn't see any of this. `git diff` shows nothing.

It gets worse for tokens. Markdown goes through the MCP call, which means the LLM has to print it out once, then re-type it into the `content` field. Mirroring a three-doc proposal eats 20K+ content tokens easy. And re-typing long markdown isn't reliable — table alignment drifts, code fences occasionally get "fixed", long URLs wrap.

The local-file flow has none of these problems. Agents use editors, humans use IDEs, `git diff` shows what changed. Every developer does this all day. The catch is that the collaboration platform can't reach into the local repo.

This release is about wiring the two together.

---

## A quick tour of OpenSpec

[OpenSpec](https://github.com/Fission-AI/OpenSpec) is an open-source spec-driven development CLI from [Fission AI](https://github.com/Fission-AI). The idea is simple: every spec lives in the repo as a file, organized under a fixed folder layout.

```
openspec/
├── changes/
│   └── <slug>/
│       ├── proposal.md       # Why + What changes + Impact
│       ├── design.md         # Architecture, contracts, risks
│       ├── specs/
│       │   └── <capability>/
│       │       └── spec.md   # Delta spec
│       └── tasks.md
└── specs/
    └── <capability>/
        └── spec.md           # Long-term, post-archive spec
```

A change is just `openspec/changes/<slug>/`, with proposal, design, and specs as separate markdown files. Spec files don't write the full state — they write a delta:

```markdown
## ADDED Requirements

### Requirement: Export to CSV
The system SHALL allow users to export task lists to CSV.

#### Scenario: Empty list
- **WHEN** the user clicks Export with zero tasks
- **THEN** an empty CSV with headers is downloaded
```

The `## ADDED Requirements` / `## MODIFIED Requirements` / `## REMOVED Requirements` / `## RENAMED Requirements` blocks are exactly what this change touches. After the change ships, you run `openspec archive <slug>` once and the CLI merges the delta into the long-term `openspec/specs/<capability>/spec.md`.

Developers tend to like this shape. Specs are files, so git tracks them. The structure — `### Requirement: ` plus `#### Scenario: WHEN ... THEN ...` — is fast for an agent to scan and easy for a human to read. Delta blocks force you to spell out what changed, instead of hiding it inside a big rewrite.

But OpenSpec stops at the local repo. Anything beyond local files — reviewers, approvals, multi-agent coordination — isn't its job. Plugging it into something like Chorus needs a bridge.

---

## The bridge: the plugin wrapper streams bytes

The naive approach: agent writes the OpenSpec files locally, then calls `chorus_pm_add_document_draft` to push the markdown into Chorus. Sounds fine, three traps in practice:

1. **Token blowup.** File content has to be printed by the LLM, then re-typed by the LLM.
2. **Content drifts.** Long markdown round-tripped through an LLM isn't byte-stable.
3. **Source-of-truth split.** The local file and the Chorus draft both claim to be authoritative, and a diff can't tell you which one is right.

v0.8.0 routes around the LLM. The Chorus plugin ships a wrapper script `chorus-api.sh mcp-tool`. The PM skill hands a local file path to a `json_encode_file` helper:

```bash
json_encode_file() {
  jq -Rs '.' < "$1"   # stream the whole file as a JSON string
}
```

`jq -Rs '.'` is byte-level encoding. Backslashes, quotes, newlines, code fences, zero-width characters all survive intact. The resulting JSON string drops straight into the `content` field of the MCP payload, and the wrapper sends it to the Chorus backend. The LLM never sees the file body — it only sees something like "I'm about to mirror this file."

What you get out of this:

- **Content tokens go to roughly zero.** Mirroring a three-doc proposal used to burn 20K+ tokens. That number is gone.
- **Byte-equal mirror.** The local file and the Chorus draft are byte-identical (modulo a single trailing newline the server appends). The local file is the single source of truth. Chorus is a mirror.
- **Humans and agents share one file.** A human edits and saves in the IDE; the agent runs mirror on the next pass and Chorus updates. The other direction works too — a reviewer leaves a comment in Chorus pointing at a requirement; the agent edits the local file and re-mirrors.

So a fresh shell can find the change folder, the proposal description carries one mandatory line: `OpenSpec change slug: <slug>`. The archive step later finds the slug by grepping that line.

---

## Woven into AI-DLC, no separate command to learn

Building the bridge was step one. Step two is hiding it inside the existing AI-DLC flow, so users don't need to learn OpenSpec's commands or remember which path to take when.

**SessionStart auto-detection.** When a session opens, the Claude Code plugin's hook quietly checks two things:

1. Does the repo root have an `openspec/` directory? (Signal that this project wants OpenSpec.)
2. Is the `openspec` CLI on `PATH`? (Signal that the environment can actually run it.)

Both true, the session enters OpenSpec mode — the connect toast becomes `(OpenSpec Enabled)` and the SessionStart context picks up a `CHORUS_OPENSPEC_ACTIVE=1` line. Miss either, the hook explains why. The folder is there but the CLI isn't? The toast tacks on `OpenSpec repo detected — install with: npm i -g @fission-ai/openspec`. Neither is present? Old projects keep the original free-form markdown path, behavior unchanged.

**Stage skills auto-switch.** The proposal, develop, and yolo skills read `CHORUS_OPENSPEC_ACTIVE` at the spec-writing step. If it's 1, they branch into the OpenSpec sub-flow: scaffold the change folder, write specs in the delta format, mirror through the wrapper. If it's 0, they stay on the free-form markdown path. Skills don't re-detect, so the path doesn't flip-flop mid-session.

**All tasks verified, archive reminder shows up automatically.** OpenSpec wants you to run `openspec archive <slug>` after a change lands, otherwise the next change won't line up with the previous one's spec. v0.8.0 adds a PostToolUse hook: every time a task gets verified, the hook greps the slug from the proposal description, then checks whether every task on that idea is `done`. If they are, the agent's final reply automatically gets a reminder appended — go run `openspec archive <slug> -y` and mirror the resulting `openspec/specs/<capability>/spec.md` back to the matching Chorus Document (same wrapper, same byte-equal path).

User-side cost: run `openspec init` once in the repo, install `@fission-ai/openspec` once globally. Claude Code handles the rest. Want it off? Flip `CHORUS_OPENSPEC_MODE=off` in the env, or toggle `enableOpenSpec` from the plugin UI.

---

## Other things in this release

**Windows actually runs now.** Until this release, `npx @chorus-aidlc/chorus` on Windows pulled a tarball that wouldn't start, because PGlite's bundled binaries and the npm packaging path assumptions didn't line up on Windows. v0.8.0 reworks the `chorus.mjs` entry and the prepack script, so the published npm package starts up directly via `npx` on macOS, Linux, and Windows.

**PGlite race in dev.** Multiple concurrent Next.js route handlers occasionally collided on the same PGlite connection, because PGlite is a single-writer engine. This release pins `pg.Pool`'s `max` to 1 — trading some concurrency for reliability. Multi-agent dev sessions don't blow up anymore.

**`chorus_get_my_assignments` matches `chorus_checkin`.** The two tools used to compute the idea tracker independently, so agents got two slightly different views of the world. v0.8.0 extracts a shared `idea-tracker.service` so both return the same project-grouped data.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code plugin:

```bash
/plugin marketplace update chorus-plugins
```

OpenSpec CLI:

```bash
npm install -g @fission-ai/openspec
openspec init   # run once in any repo where you want OpenSpec
```

OpenSpec mode is Claude Code-only this release. Codex catches up next.

v0.8.0 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.8.0) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.8.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.8.0) | **OpenSpec**: [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)

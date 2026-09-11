# Render leading YAML frontmatter as a metadata card

## Why

Chorus renders every Markdown surface through `MarkdownContent` →
`Streamdown`. That pipeline has **no frontmatter support**, so a leading
YAML block is rendered as body prose: the opening `---` becomes a
horizontal rule, each `key: value` line becomes a paragraph, and the
closing `---` becomes a second horizontal rule. The document's metadata
header reads as visual noise and loses its structure.

The concrete trigger is the spec-lite dated change-doc convention
shipped in 0.18.0, where every change doc opens with:

```yaml
---
date: 2026-09-08
change: chorus-native-and-model-b
spec: ..                 # the durable spec-lite folder this change establishes
status: in-progress      # proposed | in-progress | done
proposalUuid:
---
```

Reading such a doc in the Chorus UI today, `date`, `change`, `spec`,
`status` and `proposalUuid` are indistinguishable from body text sitting
between two stray rules.

## What Changes

- **Detect** a YAML frontmatter block at the very start of Markdown
  content (opening `---` fence on the first line, closing `---` / `...`
  fence on its own line).
- **Render** its key/value pairs as a lightweight metadata **card**
  above the body, visually separated from the prose — the treatment the
  requester chose during elaboration.
- **Strip** the frontmatter from the string handed to `Streamdown`, so
  the body no longer shows the stray rules and metadata paragraphs.
- **Fall back safely**: content whose leading `---` block does not parse
  as a flat YAML mapping is left completely untouched and renders
  exactly as it does today. This protects thematic-break usage and
  ordinary comments/chat messages that happen to begin with `---`.
- Apply uniformly to **every** Markdown surface, because the change
  lands in the single centralized `MarkdownContent` renderer: Documents,
  Idea / Proposal / Task detail panels, dashboard panels, agent chat,
  and comments.

Explicitly **out of scope** (decided during elaboration):

- **No schema awareness.** All keys are displayed generically as
  key/value pairs; no per-key colouring, no `status` badge palette, no
  knowledge of the spec-lite key set.
- **No linkification.** `proposalUuid`, `spec` and every other value
  render as plain text; nothing is clickable.
- **No export changes.** The PDF / DOCX / Markdown export pipelines
  (`src/lib/export/`) keep their current behavior.

## Capabilities

- `document-markdown-rendering` — extends the existing Markdown
  rendering capability with frontmatter detection, card presentation,
  and the safe-fallback rule.

## Impact

| Area | Change |
|---|---|
| `src/lib/frontmatter.ts` | **new** — pure `splitFrontmatter()` parser (no dependency added) |
| `src/components/frontmatter-card.tsx` | **new** — presentational metadata card, light + dark |
| `src/components/markdown-content.tsx` | split content, render card above `Streamdown` |
| `messages/{en,zh}.json` | one new key for the card's accessible label |
| `docs/design.pen` | metadata-card treatment recorded |

No database, API, MCP-tool, or dependency changes. No new npm package —
the parser is a ~40-line pure-TS function, avoiding a client-bundle YAML
dependency for what is a flat key/value read.
